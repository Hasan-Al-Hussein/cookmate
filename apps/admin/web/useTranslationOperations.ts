import { useEffect, useRef, useState } from 'react';
import type { AdminUser } from '../src/contracts';
import type { AdminTranslationMutation } from '../src/translations/contracts';
import { AdminApi, ApiError, errorMessage } from './api';
import {
  createTranslationJournal,
  prepareTranslationWrite,
  validateTranslationMutation,
  type PendingTranslation,
  type TranslationWrite,
} from './translationJournal';

export function useTranslationOperations(
  api: AdminApi,
  user: AdminUser | null,
  onCommit: (result: AdminTranslationMutation) => void,
) {
  const [pending, setPending] = useState<PendingTranslation | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<AdminTranslationMutation | null>(null);
  const live = useRef(false),
    running = useRef(false);
  const reference = useRef<PendingTranslation | null>(null);
  const journal = useRef<ReturnType<typeof createTranslationJournal> | null>(null);
  const storageFailure = useRef(false);
  const retry = useRef<{
    pending: PendingTranslation;
    api: AdminApi;
    userId: string;
    send(): Promise<AdminTranslationMutation>;
  } | null>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
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
  const epoch = authority.current.epoch,
    generation = api.sessionGeneration;
  const current = () =>
    live.current &&
    !!user &&
    authority.current.epoch === epoch &&
    api.sessionGeneration === generation;
  const owns = (value: PendingTranslation) =>
    current() && reference.current === value && value.userId === user?.userId;
  // A fresh same-owner session may deliberately retry on the same API; a replacement
  // API may only check or resolve the stored reference, never invoke a retired sender.
  const canRetry = (value: PendingTranslation) =>
    owns(value) &&
    retry.current?.pending === value &&
    retry.current.api === api &&
    retry.current.userId === user?.userId;
  function failureStorage(message: string) {
    storageFailure.current = true;
    setStorageError(message);
  }
  useEffect(() => {
    live.current = true;
    try {
      journal.current = createTranslationJournal(sessionStorage);
      reference.current = journal.current.read();
      setPending(reference.current);
    } catch {
      failureStorage(
        'Translation recovery storage is unavailable. No translation write will be sent. Existing references were retained.',
      );
    }
    setReady(true);
    return () => {
      live.current = false;
    };
  }, []);
  function forget(value: PendingTranslation) {
    journal.current!.forget(value);
    reference.current = null;
    setPending(null);
    retry.current = null;
    storageFailure.current = false;
    setStorageError(null);
  }
  function finish(input: AdminTranslationMutation, value: PendingTranslation) {
    if (!owns(value)) return;
    const result = validateTranslationMutation(value, input);
    commit.current(result);
    if (!owns(value)) return;
    setLastCommit(result);
    try {
      forget(value);
    } catch {
      failureStorage(
        'The translation is confirmed, but its recovery reference could not be cleared. Check its receipt before another change.',
      );
    }
  }
  function begin() {
    if (!current() || running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setNotice(null);
    return true;
  }
  function end() {
    running.current = false;
    if (live.current) setBusy(false);
  }
  function showError(cause: unknown) {
    setError(errorMessage(cause));
    setErrorCode(cause instanceof ApiError ? cause.code : null);
  }
  function send(write: TranslationWrite, operationId: string) {
    if (write.kind === 'create')
      return api.createTranslation(write.draftId, {
        operationId,
        sourceRevision: write.sourceRevision,
        originalLanguage: write.originalLanguage,
        targetLanguage: write.targetLanguage,
        input: write.input,
      });
    if (write.kind === 'save')
      return api.saveTranslation(write.id, operationId, write.expectedRevision, write.input);
    if (write.kind === 'rebase')
      return api.rebaseTranslation(
        write.id,
        operationId,
        write.expectedRevision,
        write.sourceRevision,
        write.input,
      );
    if (write.kind !== 'review')
      throw new ApiError(
        400,
        'invalid_translation_action',
        'Choose a supported translation action.',
      );
    return api.reviewTranslation(
      write.id,
      operationId,
      write.expectedRevision,
      write.decision,
      write.note,
      write.acknowledgeHumanReview,
    );
  }
  async function run(write: TranslationWrite) {
    if (!ready || !journal.current || reference.current || storageFailure.current || !begin())
      return;
    let own: PendingTranslation | null = null;
    try {
      const prepared = await prepareTranslationWrite(write, user!.userId, crypto.randomUUID());
      if (!current()) return;
      try {
        own = journal.current.remember(prepared.pending);
      } catch {
        failureStorage(
          'The exact translation recovery reference could not be saved. Nothing was sent.',
        );
        return;
      }
      reference.current = own;
      setPending(own);
      const request = () => send(prepared.write, own!.operationId);
      retry.current = { pending: own, api, userId: user!.userId, send: request };
      const result = await request();
      if (owns(own)) finish(result, own);
    } catch (cause) {
      if (!current()) return;
      showError(cause);
      if (own && owns(own) && cause instanceof ApiError && !cause.uncertain) {
        try {
          forget(own);
        } catch {
          failureStorage(
            'The rejected translation reference could not be cleared. Resolve it before another write.',
          );
        }
      }
    } finally {
      end();
    }
  }
  async function recover(mode: 'check' | 'resolve' | 'retry') {
    const own = reference.current;
    if (!own || !owns(own) || (mode === 'retry' && !canRetry(own)) || !begin()) return;
    try {
      if (mode === 'resolve') {
        const result = await api.resolveTranslationOperation(
          own.operationId,
          own.requestFingerprint,
        );
        if (!owns(own)) return;
        if (result.status === 'committed') finish(result.mutation, own);
        else if (
          result.status === 'cancelled' &&
          result.operationId === own.operationId &&
          result.requestFingerprint === own.requestFingerprint
        ) {
          try {
            forget(own);
            setNotice(
              'The server cancelled this exact translation operation. Review any edits still open in this tab before saving again. Recovery does not restore unsaved text.',
            );
          } catch {
            failureStorage(
              'Cancellation was confirmed, but recovery storage could not be cleared. Resolve the same reference again.',
            );
          }
        } else
          throw new ApiError(
            0,
            'translation_resolution_mismatch',
            'The server did not confirm this exact translation operation. Its reference is retained.',
          );
      } else {
        const result = await (mode === 'retry'
          ? retry.current!.send()
          : api.translationOperation(own.operationId, own.requestFingerprint));
        if (owns(own)) finish(result, own);
      }
    } catch (cause) {
      if (!owns(own)) return;
      showError(cause);
      if (cause instanceof ApiError && cause.status === 404)
        setError(
          'No translation receipt was found. This does not prove failure. Keep the reference or deliberately resolve its outcome.',
        );
    } finally {
      end();
    }
  }
  return {
    pending,
    busy,
    error,
    errorCode,
    storageError,
    notice,
    lastCommit,
    blocked: !ready || busy || !!pending || !!storageError,
    canRecover: !!pending && pending.userId === user?.userId,
    canRetry: !!pending && canRetry(pending),
    run,
    check: () => recover('check'),
    resolve: () => recover('resolve'),
    retry: () => recover('retry'),
  };
}
export type TranslationOperations = ReturnType<typeof useTranslationOperations>;
