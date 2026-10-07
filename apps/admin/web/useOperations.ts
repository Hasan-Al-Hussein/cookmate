import { useEffect, useRef, useState } from 'react';
import type { AdminMutation, AdminUser } from '../src/contracts';
import { AdminApi, ApiError, errorMessage } from './api';
import { createOperationJournal, type PendingOperation } from './operationJournal';
import { validateOperationResolution } from './operationResolution';

export function useOperations(
  api: AdminApi,
  user: AdminUser | null,
  onCommit: (result: AdminMutation) => void,
) {
  const [pending, setPendingState] = useState<PendingOperation | null>(null);
  const [storageError, setStorageErrorState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolutionNotice, setResolutionNotice] = useState<string | null>(null);
  const running = useRef(false);
  const live = useRef(false);
  const pendingReference = useRef<PendingOperation | null>(null);
  const storageFailure = useRef<string | null>(null);
  const authority = useRef({ api, userId: user?.userId, role: user?.role, epoch: 0 });
  if (
    authority.current.api !== api ||
    authority.current.userId !== user?.userId ||
    authority.current.role !== user?.role
  )
    authority.current = {
      api,
      userId: user?.userId,
      role: user?.role,
      epoch: authority.current.epoch + 1,
    };
  const ownerEpoch = authority.current.epoch;
  const sessionGeneration = api.sessionGeneration;
  const journal = useRef<ReturnType<typeof createOperationJournal> | null>(null);
  const retry = useRef<{
    api: AdminApi;
    userId: string;
    send(id: string): Promise<AdminMutation>;
  } | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  function current() {
    return (
      live.current &&
      !!user &&
      authority.current.epoch === ownerEpoch &&
      api.sessionGeneration === sessionGeneration
    );
  }
  function owns(reference: PendingOperation) {
    return current() && pendingReference.current === reference && reference.userId === user?.userId;
  }
  function setPending(value: PendingOperation | null) {
    pendingReference.current = value;
    setPendingState(value);
  }
  function setStorageError(value: string | null) {
    storageFailure.current = value;
    setStorageErrorState(value);
  }
  useEffect(() => {
    live.current = true;
    try {
      journal.current = createOperationJournal(sessionStorage);
      setPending(journal.current.read());
    } catch {
      setStorageError(
        'Operation recovery storage is unavailable or unreadable. Editing stays available; saves are blocked to avoid losing an unconfirmed operation.',
      );
    }
    return () => {
      live.current = false;
    };
  }, []);
  function finish(result: AdminMutation, reference: PendingOperation) {
    if (!owns(reference)) return;
    commit.current(result);
    try {
      journal.current!.forget(result.operationId);
      setPending(null);
      retry.current = null;
      setStorageError(null);
    } catch {
      setStorageError(
        'The change is confirmed, but its recovery reference could not be cleared. Check the receipt again before another change.',
      );
    }
  }
  async function dispatch(
    reference: PendingOperation,
    send: (id: string) => Promise<AdminMutation>,
    previouslyUncertain = false,
  ) {
    if (running.current || !owns(reference)) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setResolutionNotice(null);
    try {
      const result = await send(reference.operationId);
      if (!owns(reference)) return;
      if (result.operationId !== reference.operationId)
        throw new ApiError(
          0,
          'receipt_mismatch',
          'The returned operation did not match this change. Keep the recovery reference.',
        );
      finish(result, reference);
    } catch (failure) {
      if (!owns(reference)) return;
      setError(errorMessage(failure));
      setErrorCode(failure instanceof ApiError ? failure.code : null);
      // A rejected retry cannot disprove an earlier request whose acknowledgement was lost.
      if (!previouslyUncertain && failure instanceof ApiError && !failure.uncertain) {
        try {
          journal.current!.forget(reference.operationId);
          setPending(null);
          retry.current = null;
        } catch {
          setStorageError(
            'The failed operation reference could not be cleared. No new write will start.',
          );
        }
      }
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function run(
    kind: PendingOperation['kind'],
    draftId: string | null,
    send: (id: string) => Promise<AdminMutation>,
  ) {
    if (
      !current() ||
      !user ||
      pendingReference.current ||
      storageFailure.current ||
      running.current ||
      !journal.current
    )
      return;
    const reference: PendingOperation = {
      operationId: crypto.randomUUID(),
      userId: user.userId,
      kind,
      draftId,
      createdAt: new Date().toISOString(),
    };
    try {
      journal.current.remember(reference);
    } catch {
      setStorageError(
        'The recovery reference could not be saved. Nothing was sent. Existing drafts are unchanged.',
      );
      return;
    }
    setPending(reference);
    retry.current = { api, userId: user.userId, send };
    await dispatch(reference, send);
  }
  async function check() {
    if (!pending || !owns(pending) || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      const result = await api.operation(pending.operationId);
      if (!owns(pending)) return;
      if (result.operationId !== pending.operationId) throw new Error('Receipt mismatch');
      finish(result, pending);
    } catch (failure) {
      if (!owns(pending)) return;
      setErrorCode(failure instanceof ApiError ? failure.code : null);
      setError(
        failure instanceof ApiError && failure.status === 404
          ? 'No receipt was found yet. This does not prove the change failed. Keep this reference; do not create another operation.'
          : errorMessage(failure),
      );
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function resolve() {
    if (!pending || !owns(pending) || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setResolutionNotice(null);
    try {
      const response = await api.resolveOperation(pending.operationId);
      if (!owns(pending)) return;
      const result = validateOperationResolution(pending.operationId, response);
      if (result.status === 'committed') {
        finish(result.mutation, pending);
      } else {
        try {
          journal.current!.forget(result.operationId);
          setPending(null);
          retry.current = null;
          setStorageError(null);
          setResolutionNotice(
            'The server confirmed that this operation did not commit and cancelled its identifier. Your unsaved edits are retained. You can review them and save a new change.',
          );
        } catch {
          setStorageError(
            'The server cancelled this operation, but its local recovery reference could not be cleared. Resolve it again before another change.',
          );
        }
      }
    } catch (failure) {
      if (!owns(pending)) return;
      // Neither a failed cancellation nor an absent receipt authorizes forgetting this ID.
      setError(errorMessage(failure));
      setErrorCode(failure instanceof ApiError ? failure.code : null);
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  }
  return {
    pending,
    storageError,
    error,
    errorCode,
    busy,
    resolutionNotice,
    blocked: busy || !!pending || !!storageError,
    canRetry:
      !!retry.current &&
      retry.current.api === api &&
      retry.current.userId === user?.userId &&
      pending?.userId === user?.userId,
    run,
    check,
    resolve,
    retry: async () => {
      const retained = retry.current;
      if (pending && retained && retained.api === api && retained.userId === user?.userId)
        await dispatch(pending, retained.send, true);
    },
    clearError: () => {
      setError(null);
      setErrorCode(null);
    },
  };
}
