import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CookMateQueries, Immutable } from '@cookmate/domain';
import { contentCookingReferenceStore } from './contentCookingReferenceStorage';
import type {
  ContentCookingReference,
  ContentCookingReferenceStore,
} from './contentCookingReferences';
export function useContentCookingReferences(
  readInstallationId: CookMateQueries['readInstallationId'],
  isCurrent: () => boolean,
  store: ContentCookingReferenceStore = contentCookingReferenceStore,
) {
  const [installation, setInstallation] = useState<string | null>(null),
    [records, setRecords] = useState<readonly Immutable<ContentCookingReference>[]>([]),
    [error, setError] = useState<string | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const mounted = useRef(true),
    latest = useRef({ readInstallationId, isCurrent, store });
  latest.current = { readInstallationId, isCurrent, store };
  const current = () =>
    mounted.current &&
    latest.current.readInstallationId === readInstallationId &&
    latest.current.isCurrent === isCurrent &&
    latest.current.store === store &&
    isCurrent();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setInstallation(null);
    setRecords([]);
    setError(null);
    void (async () => {
      try {
        if (!current()) return;
        const identity = await readInstallationId();
        if (!live || !current()) return;
        if (identity.kind !== 'ready') throw new Error();
        const values = await store.load(identity.value);
        if (!live || !current()) return;
        setInstallation(identity.value);
        setRecords(values);
      } catch {
        if (live && current())
          setError(
            'Cooking recovery references could not be checked. New changes are unavailable until they can be read.',
          );
      }
    })();
    return () => {
      live = false;
    };
  }, [readInstallationId, isCurrent, store, reloadGeneration]);
  useEffect(() => {
    if (!installation) return;
    let live = true;
    const unsubscribe = store.subscribe(installation, (values) => {
      if (current()) setRecords(values);
    });
    void store.load(installation).then(
      (values) => {
        if (live && current()) setRecords(values);
      },
      () => {
        if (live && current()) setError('Cooking recovery references could not be rechecked.');
      },
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, [installation, store, isCurrent]);
  async function remember(reference: Immutable<ContentCookingReference>) {
    if (!current() || !installation || error) return false;
    try {
      const next = await store.remember(installation, reference);
      if (!current()) return false;
      setRecords(next);
      return true;
    } catch {
      if (current())
        setError(
          'The operation reference could not be confirmed. Check recovery before another cooking change.',
        );
      return false;
    }
  }
  async function release(reference: Immutable<ContentCookingReference>) {
    if (!current() || !installation) return false;
    try {
      const next = await store.release(installation, reference);
      if (!current()) return false;
      setRecords(next);
      return true;
    } catch {
      if (current())
        setError(
          'Recovery cleanup is unconfirmed. Keep the operation reference and check its receipt before another change.',
        );
      return false;
    }
  }
  return {
    ready: current() && !!installation && !error,
    error,
    records,
    remember,
    release,
    reload: () => {
      if (current()) setReloadGeneration((value) => value + 1);
    },
  };
}
