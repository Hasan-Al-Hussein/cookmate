import { useEffect, useRef, useState } from 'react';
import type { CookMateQueries } from '@cookmate/domain';
import { cookingReferenceStore } from './cookingReferenceStorage';
import type { CookingReference, CookingReferenceStore } from './cookingReferences';

export function useCookingReferences(
  readInstallationId: CookMateQueries['readInstallationId'],
  kind: CookingReference['kind'],
  recipeId: string | null,
  store: CookingReferenceStore = cookingReferenceStore,
) {
  const [installation, setInstallation] = useState<string | null>(null);
  const [records, setRecords] = useState<readonly CookingReference[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    setInstallation(null);
    setRecords([]);
    setError(null);
    let cancelled = false;
    void (async () => {
      try {
        const identity = await readInstallationId();
        if (identity.kind !== 'ready') throw new Error('Installation unavailable');
        const values = await store.load(identity.value);
        if (!cancelled) {
          setInstallation(identity.value);
          setRecords(values);
        }
      } catch {
        if (!cancelled)
          setError(
            'Cooking recovery references could not be loaded safely. New history changes are unavailable; existing records have not been cleared.',
          );
      }
    })();
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [readInstallationId, store]);
  async function remember(operationId: string) {
    if (!installation || error) return false;
    try {
      const next = await store.remember(installation, {
        operationId,
        kind,
        recipeId,
        createdAt: new Date().toISOString(),
      });
      if (mounted.current) setRecords(next);
      return true;
    } catch {
      if (mounted.current)
        setError(
          'The operation reference could not be retained. The history change was not started. Existing recovery records remain available.',
        );
      return false;
    }
  }
  async function release(
    operationId: string,
    proof: 'receipt' | 'definite_failure' | 'not_dispatched',
  ) {
    if (!installation) return false;
    try {
      const next = await store.release(installation, operationId, proof);
      if (mounted.current) setRecords(next);
      return true;
    } catch {
      if (mounted.current)
        setError(
          `Recovery cleanup could not be confirmed. Keep operation ID ${operationId} for receipt lookup before another history change.`,
        );
      return false;
    }
  }
  return {
    ready: !!installation && !error,
    error,
    allReferences: records,
    references: records.filter((record) => record.kind === kind && record.recipeId === recipeId),
    remember,
    release,
  };
}
