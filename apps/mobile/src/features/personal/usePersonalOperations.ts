import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import * as Crypto from 'expo-crypto';
import type {
  CookMateQueries,
  Immutable,
  PersonalMutationResult,
  PersonalReceipt,
  PersonalService,
} from '@cookmate/domain';
import { personalReferenceStore } from './personalReferenceStorage';
import type { PersonalReference, PersonalReferenceProof } from './personalReferences';
const alwaysCurrent = () => true;
const anyReceipt = (_receipt: Immutable<PersonalReceipt>) => true;
type ReferenceStore = typeof personalReferenceStore;

export function usePersonalOperations(
  service: Pick<PersonalService, 'readReceipt' | 'resolveOperation'>,
  readInstallationId: CookMateQueries['readInstallationId'],
  options: {
    isCurrent?: () => boolean;
    referenceStore?: ReferenceStore;
    acceptsReceipt?: (receipt: Immutable<PersonalReceipt>) => boolean;
  } = {},
) {
  const {
    isCurrent = alwaysCurrent,
    referenceStore = personalReferenceStore,
    acceptsReceipt = anyReceipt,
  } = options;
  const [installation, setInstallation] = useState<string | null>(null);
  const [references, setReferences] = useState<readonly PersonalReference[]>([]);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Immutable<PersonalReceipt> | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const focused = useRef(false);
  const running = useRef(false);
  const latest = useRef({
    service,
    readInstallationId,
    isCurrent,
    referenceStore,
    acceptsReceipt,
    references,
  });
  latest.current = {
    service,
    readInstallationId,
    isCurrent,
    referenceStore,
    acceptsReceipt,
    references,
  };
  const canAccess = () =>
    latest.current.service === service &&
    latest.current.readInstallationId === readInstallationId &&
    latest.current.referenceStore === referenceStore &&
    latest.current.isCurrent === isCurrent &&
    latest.current.acceptsReceipt === acceptsReceipt &&
    isCurrent();
  const canPresent = () => mounted.current && canAccess();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setReceipt(null);
      return () => {
        focused.current = false;
      };
    }, []),
  );
  useEffect(() => {
    let disposed = false;
    async function hydrate() {
      try {
        if (!canAccess()) return;
        const identity = await readInstallationId();
        if (!canAccess()) return;
        if (identity.kind !== 'ready') throw new Error('Identity unavailable');
        const rows = await referenceStore.load(identity.value);
        if (!disposed && canPresent()) {
          setInstallation(identity.value);
          setReferences(rows);
          setStorageError(null);
        }
      } catch {
        if (!disposed && canPresent())
          setStorageError(
            'Personal-change recovery is unavailable. Check any pending change before starting another.',
          );
      }
    }
    setInstallation(null);
    setReferences([]);
    void hydrate();
    const unsubscribe = referenceStore.subscribe(() => void hydrate());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [service, readInstallationId, referenceStore, isCurrent]);
  async function release(id: string, proof: PersonalReferenceProof) {
    if (!installation || !canAccess()) return false;
    try {
      const rows = await referenceStore.release(installation, id, proof);
      if (canPresent()) setReferences(rows);
      return true;
    } catch {
      if (canPresent())
        setStorageError(
          'Recovery cleanup could not be confirmed. Keep the operation reference and check its receipt before another change.',
        );
      return false;
    }
  }
  async function accept(value: Immutable<PersonalReceipt>, id: string) {
    if (!canPresent()) return false;
    if (value.operationId !== id || !acceptsReceipt(value)) {
      setError('The receipt does not match this operation. No success is claimed.');
      return false;
    }
    setReceipt(value);
    setError(null);
    await release(id, 'receipt');
    return canPresent() && (value.outcome === 'committed' || value.outcome === 'no_op');
  }
  async function perform(dispatch: (operationId: string) => Promise<PersonalMutationResult>) {
    if (
      !canPresent() ||
      running.current ||
      !focused.current ||
      !installation ||
      storageError ||
      latest.current.references.length
    )
      return false;
    const id = Crypto.randomUUID();
    running.current = true;
    setBusy(true);
    setError(null);
    setReceipt(null);
    let dispatched = false;
    try {
      const rows = await referenceStore.remember(installation, id);
      if (canPresent()) setReferences(rows);
      if (!canPresent() || !focused.current) {
        await release(id, 'not_dispatched');
        return false;
      }
      dispatched = true;
      const result = await dispatch(id);
      if (canAccess() && result.kind === 'failed') await release(id, 'definite_failure');
      if (!canPresent()) return false;
      if (result.kind === 'ready') return await accept(result.value, id);
      setError(
        result.kind === 'failed'
          ? 'The change was not saved. Refresh the current record before reviewing and trying again.'
          : 'The outcome is unconfirmed. Check or resolve its operation reference; do not repeat the change.',
      );
      return false;
    } catch {
      if (!dispatched) await release(id, 'not_dispatched');
      if (canPresent()) {
        if (dispatched)
          setError(
            'The result is unconfirmed. Its recovery reference is retained; no automatic retry will run.',
          );
        else
          setStorageError(
            'The recovery reference could not be saved. Your change was not dispatched.',
          );
      }
      return false;
    } finally {
      running.current = false;
      if (canPresent()) setBusy(false);
    }
  }
  async function recover(id: string, resolve: boolean) {
    if (
      !canPresent() ||
      !focused.current ||
      running.current ||
      !latest.current.references.some((reference) => reference.operationId === id)
    )
      return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = resolve ? await service.resolveOperation(id) : await service.readReceipt(id);
      if (!canPresent()) return;
      if (result.kind === 'ready' && result.value) await accept(result.value, id);
      else
        setError(
          'No terminal outcome was confirmed. The operation reference is retained and the change has not been replayed.',
        );
    } catch {
      if (canPresent())
        setError(
          'Recovery could not be confirmed. Keep this reference; no change has been replayed.',
        );
    } finally {
      running.current = false;
      if (canPresent()) setBusy(false);
    }
  }
  return {
    busy,
    error,
    storageError,
    receipt,
    references,
    ready: canPresent() && !!installation && !storageError && !references.length && !busy,
    perform,
    recover,
  };
}
