import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { PersonalChange, PersonalService, RepositoryResult } from '@cookmate/domain';
const alwaysCurrent = () => true;

export function usePersonalQuery<T>(
  service: Pick<PersonalService, 'subscribe'>,
  read: (cursor?: string) => Promise<RepositoryResult<T>>,
  relevant: keyof Omit<PersonalChange, 'revision'> | 'recipe',
  append?: (previous: T, next: T) => T,
  isCurrent: () => boolean = alwaysCurrent,
) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const current = useRef<T | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const latest = useRef({ service, read, isCurrent });
  latest.current = { service, read, isCurrent };
  const load = useCallback(
    async (cursor?: string) => {
      const owns = () =>
        active.current &&
        latest.current.service === service &&
        latest.current.read === read &&
        latest.current.isCurrent === isCurrent &&
        isCurrent();
      if (!owns()) return;
      const own = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const result = await read(cursor);
        if (!owns() || generation.current !== own) return;
        if (result.kind === 'failed') {
          setError(
            'These records could not be read. Retry loading to use the current saved state.',
          );
          return;
        }
        const next =
          cursor && current.current && append
            ? append(current.current, result.value)
            : result.value;
        current.current = next;
        setValue(next);
        return next;
      } catch {
        if (owns() && generation.current === own)
          setError(
            'These records could not be loaded. Check any pending change before repeating it.',
          );
      } finally {
        if (owns() && generation.current === own) setLoading(false);
      }
    },
    [service, read, append, isCurrent],
  );
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      current.current = null;
      setValue(null);
      void load();
      const unsubscribe = service.subscribe((change) => {
        if (!active.current || !isCurrent()) return;
        if (!(relevant === 'recipe' ? change.notes || change.collections : change[relevant]))
          return;
        // Private note deletion removes readable text immediately. Lists keep their
        // positions while a guarded fresh read is in flight; controls show loading.
        if (relevant === 'notes' || relevant === 'recipe') {
          current.current = null;
          setValue(null);
        }
        void load();
      });
      return () => {
        active.current = false;
        generation.current++;
        unsubscribe();
        current.current = null;
        setValue(null);
      };
    }, [service, load, relevant, isCurrent]),
  );
  return {
    value,
    error,
    loading,
    reload: async () => {
      await load();
    },
    refresh: () => load(),
    loadMore: (cursor: string) => load(cursor),
  };
}
