import { useEffect, useRef, useState } from 'react';
import type { ContractError } from '@cookmate/contracts';
import type { RepositoryResult } from '@cookmate/domain';
import { useWorkspace, useWorkspaceQuery, type QueryState } from '../workspace/WorkspaceProvider';
import { runtimeClock } from '../workspace/runtimeClock';
import type { RecoveryState } from '../workspace/directRecoveryController';
import {
  useContentWorkspaceFocus,
  useOptionalOrdinaryContentWorkspace,
} from './OrdinaryContentWorkspaceProvider';
import type { OrdinaryContentWorkspaceState } from './ordinaryContentWorkspace';
import type {
  ContentPlanSnapshot,
  ContentShoppingSnapshot,
  ContentFavouriteEntry,
} from '../../data/contentWorkspaceQueries';

const readError: ContractError = {
  code: 'storage_failure',
  messageKey: 'content.read_unavailable',
  retry: 'after_correction',
};
const idle = { kind: 'idle' } as const;
const recovering: Extract<RecoveryState, { kind: 'loading' }> = { kind: 'loading' };
const retained = <T>(state: QueryState<T>) => {
  const value = state.kind === 'ready' ? state.value : state.previous;
  return value === undefined ? {} : { previous: value };
};

/** Selects issued ports, never substitutes the guest store for an unavailable content owner. */
export function useOrdinaryWorkspaceActions() {
  const legacy = useWorkspace();
  const content = useOptionalOrdinaryContentWorkspace();
  const focus = useContentWorkspaceFocus();
  if (!content) return { mode: 'bundled' as const, scopeKey: legacy.workspaceKey, ...legacy };
  return {
    mode: 'content' as const,
    scopeKey: content.kind === 'ready' ? content.scopeKey : `content:${content.status}`,
    clock: runtimeClock,
    actions: content.kind === 'ready' ? content.actions : null,
    actionState: content.kind === 'ready' ? content.actionState : idle,
    recovery: content.kind === 'ready' ? content.recovery : null,
    recoveryState: content.kind === 'ready' ? content.recoveryState : recovering,
    ...focus,
  };
}

function useContentQuery<T>(
  key: string,
  read: (
    queries: Extract<OrdinaryContentWorkspaceState, { kind: 'ready' }>,
  ) => Promise<RepositoryResult<T>>,
) {
  const content = useOptionalOrdinaryContentWorkspace();
  const owner = content?.kind === 'ready' ? content.queries : null;
  const refresh = content?.kind === 'ready' ? content.refreshVersion : 0;
  const readRef = useRef(read);
  readRef.current = read;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    owner: typeof owner;
    key: string;
    refresh: number;
    state: QueryState<T>;
  }>({ owner: null, key, refresh: 0, state: { kind: 'loading' } });
  const current = useRef({ owner, key, refresh });
  current.current = { owner, key, refresh };
  useEffect(() => {
    if (content?.kind !== 'ready' || !owner) return;
    let active = true;
    setResult((previous) => ({
      owner,
      key,
      refresh,
      state: {
        kind: 'loading',
        ...(previous.owner === owner && previous.key === key ? retained(previous.state) : {}),
      },
    }));
    void readRef
      .current(content)
      .then((state) => {
        if (
          active &&
          current.current.owner === owner &&
          current.current.key === key &&
          current.current.refresh === refresh
        )
          setResult({ owner, key, refresh, state });
      })
      .catch(() => {
        if (
          active &&
          current.current.owner === owner &&
          current.current.key === key &&
          current.current.refresh === refresh
        )
          setResult({ owner, key, refresh, state: { kind: 'failed', error: readError } });
      });
    return () => {
      active = false;
    };
  }, [owner, key, refresh, attempt]);
  let state: QueryState<T> = { kind: 'loading' };
  if (content?.kind === 'unavailable' && ['failed', 'revoked', 'closed'].includes(content.status))
    state = { kind: 'failed', error: readError };
  else if (owner && result.owner === owner && result.key === key) {
    state =
      result.refresh === refresh
        ? result.state
        : {
            kind: 'loading',
            ...retained(result.state),
          };
  }
  return { state, retry: () => setAttempt((value) => value + 1) };
}

export function useOrdinaryPlanQuery(key: string, startDate: string, endDate: string) {
  const content = useOptionalOrdinaryContentWorkspace();
  const bundled = useWorkspaceQuery(
    key,
    ['plan', 'shopping'],
    (services) => services.queries.readPlan(startDate, endDate),
    !content,
  );
  const adopted = useContentQuery<ContentPlanSnapshot>(key, (owner) =>
    owner.queries.readPlan(startDate, endDate),
  );
  return content
    ? { mode: 'content' as const, ...adopted }
    : { mode: 'bundled' as const, ...bundled };
}

export function useOrdinaryShoppingQuery(key = 'shopping') {
  const content = useOptionalOrdinaryContentWorkspace();
  const bundled = useWorkspaceQuery(
    key,
    ['plan', 'shopping'],
    (services) => services.queries.readShopping(),
    !content,
  );
  const adopted = useContentQuery<ContentShoppingSnapshot>(key, (owner) =>
    owner.queries.readShopping(),
  );
  return content
    ? { mode: 'content' as const, ...adopted }
    : { mode: 'bundled' as const, ...bundled };
}

export function useOrdinaryFavouritesQuery() {
  const content = useOptionalOrdinaryContentWorkspace();
  const bundled = useWorkspaceQuery(
    'favourites',
    ['favourites'],
    (services) => services.queries.readFavourites(),
    !content,
  );
  const adopted = useContentQuery<readonly ContentFavouriteEntry[]>('favourites', (owner) =>
    owner.queries.readFavourites(),
  );
  return content
    ? { mode: 'content' as const, ...adopted }
    : { mode: 'bundled' as const, ...bundled };
}
