import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import type { ContentCookingReaderHost } from './contentCookingPorts';

/** A retained callback cannot outlive its page, host, or exact ready scope. */
export function useContentCookingScope(
  host: ContentCookingReaderHost,
  scopeKey: string,
  enabled = true,
  parentCurrent?: () => boolean,
) {
  const mounted = useRef(true),
    focused = useRef(true);
  const authority = useMemo(() => ({}), [host, scopeKey, enabled]);
  const latest = useRef({ host, scopeKey, enabled, parentCurrent, authority });
  latest.current = { host, scopeKey, enabled, parentCurrent, authority };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );
  return useCallback(() => {
    const state = host.getSnapshot();
    return (
      latest.current.authority === authority &&
      mounted.current &&
      focused.current &&
      latest.current.host === host &&
      latest.current.scopeKey === scopeKey &&
      latest.current.enabled &&
      state.status === 'ready' &&
      state.scopeKey === scopeKey &&
      (latest.current.parentCurrent?.() ?? true)
    );
  }, [host, scopeKey, authority]);
}
