import { act, cleanupAsync, renderHook, waitFor } from '@testing-library/react-native';
import type { RepositoryResult } from '@cookmate/domain';
import type {
  ContentPlanSnapshot,
  ContentFavouriteEntry,
} from '../../data/contentWorkspaceQueries';
import { DirectActionController } from '../workspace/directActionController';
import { DirectRecoveryController } from '../workspace/directRecoveryController';
import type { OrdinaryContentWorkspaceState } from './ordinaryContentWorkspace';
import {
  useOrdinaryFavouritesQuery,
  useOrdinaryPlanQuery,
  useOrdinaryWorkspaceActions,
} from './useOrdinaryWorkspace';

let mockContent: OrdinaryContentWorkspaceState | null = null;
const mockLegacyQuery = jest.fn(
  (_key: unknown, _collections: unknown, _read: unknown, _enabled: unknown) => ({
    state: { kind: 'loading' },
    retry: jest.fn(),
  }),
);
const mockLegacy = { workspaceKey: 'guest', actions: null };
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => mockLegacy,
  useWorkspaceQuery: (key: unknown, collections: unknown, read: unknown, enabled: unknown) =>
    mockLegacyQuery(key, collections, read, enabled),
}));
jest.mock('./OrdinaryContentWorkspaceProvider', () => ({
  useOptionalOrdinaryContentWorkspace: () => mockContent,
  useContentWorkspaceFocus: () => ({
    registerFocusFallback: jest.fn(),
    restoreScreenFocus: jest.fn(),
  }),
}));
const failed = {
  kind: 'failed',
  error: { code: 'storage_failure', messageKey: 'test', retry: 'never' },
} as const;
const snapshot: ContentPlanSnapshot = {
  startDate: '2026-10-01',
  endDate: '2026-10-01',
  occurrences: [],
  shoppingScope: { scopeId: 'scope', revision: 1, occurrenceIds: [] },
};
function ready(
  scopeKey: string,
  read: () => Promise<RepositoryResult<ContentPlanSnapshot>>,
): Extract<OrdinaryContentWorkspaceState, { kind: 'ready' }> {
  const ports = {
    commands: {
      reviewDirect: async () => failed,
      prepareDirect: async () => failed,
      execute: async (command: { operationId: string }) => ({
        ...failed,
        operationId: command.operationId,
      }),
      acknowledgeDirectRecovery: async () => ({ kind: 'ready', value: null, revision: 0 }) as const,
    },
    queries: {
      readReceipt: async () => ({ kind: 'ready', value: null, revision: 0 }) as const,
      readDirectRecovery: async () =>
        ({ kind: 'ready', value: { entries: [], nextAfterSequence: null }, revision: 0 }) as const,
    },
  };
  const actions = new DirectActionController(ports, () => undefined);
  return {
    kind: 'ready',
    scopeKey,
    actions,
    recovery: new DirectRecoveryController(ports, actions),
    actionState: { kind: 'idle' },
    recoveryState: { kind: 'ready', page: { entries: [], nextAfterSequence: null } },
    refreshVersion: 0,
    queries: {
      readPlan: read,
      readShopping: async () => failed,
      readFavourites: async () => failed,
    },
  };
}
afterEach(async () => {
  await cleanupAsync();
  jest.clearAllMocks();
  mockContent = null;
});
test('owner replacement hides old data and suppresses a late read without guest query fallback', async () => {
  let resolve!: (value: RepositoryResult<ContentPlanSnapshot>) => void;
  const pending = new Promise<RepositoryResult<ContentPlanSnapshot>>((done) => {
    resolve = done;
  });
  mockContent = ready('owner-a', () => pending);
  const view = renderHook(() => useOrdinaryPlanQuery('same-key', '2026-10-01', '2026-10-01'));
  const replacement = {
    ...snapshot,
    shoppingScope: { ...snapshot.shoppingScope, scopeId: 'owner-b' },
  };
  mockContent = ready('owner-b', async () => ({ kind: 'ready', value: replacement, revision: 2 }));
  view.rerender({});
  await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
  await act(async () => resolve({ kind: 'ready', value: snapshot, revision: 1 }));
  const result = view.result.current.state;
  expect(result.kind === 'ready' && result.value.shoppingScope.scopeId).toBe('owner-b');
  expect(mockLegacyQuery.mock.calls.every((call) => call[3] === false)).toBe(true);
  mockContent = { kind: 'unavailable', status: 'revoked' };
  view.rerender({});
  expect(view.result.current.state).toEqual(expect.objectContaining({ kind: 'failed' }));
  expect('previous' in view.result.current.state).toBe(false);
});

test('content Favourites read uses issued query and drops a delayed previous owner result', async () => {
  let resolve!: (value: RepositoryResult<readonly ContentFavouriteEntry[]>) => void;
  const pending = new Promise<RepositoryResult<readonly ContentFavouriteEntry[]>>((done) => {
    resolve = done;
  });
  const owner = ready('favourites-a', async () => failed);
  mockContent = { ...owner, queries: { ...owner.queries, readFavourites: () => pending } };
  const view = renderHook(() => useOrdinaryFavouritesQuery());
  const replacement = ready('favourites-b', async () => failed);
  mockContent = {
    ...replacement,
    queries: {
      ...replacement.queries,
      readFavourites: async () => ({ kind: 'ready', value: [], revision: 2 }),
    },
  };
  view.rerender({});
  await waitFor(() => expect(view.result.current.state.kind).toBe('ready'));
  await act(async () =>
    resolve({
      kind: 'ready',
      revision: 1,
      value: [
        {
          favourite: { recipeId: '99001', revision: 1, savedAt: '2026-10-01T00:00:00Z' },
          content: { kind: 'unavailable', reason: 'withdrawn' },
        },
      ],
    }),
  );
  expect(view.result.current.state).toEqual({ kind: 'ready', value: [], revision: 2 });
  expect(mockLegacyQuery.mock.calls.every((call) => call[3] === false)).toBe(true);
});
test('refresh retains last display but disables fresh-read readiness; unavailable never borrows guest actions', async () => {
  let resolve!: (value: RepositoryResult<ContentPlanSnapshot>) => void;
  const next = new Promise<RepositoryResult<ContentPlanSnapshot>>((done) => {
    resolve = done;
  });
  const read = jest.fn<Promise<RepositoryResult<ContentPlanSnapshot>>, []>(async () => ({
    kind: 'ready',
    value: snapshot,
    revision: 1,
  }));
  const owner = ready('a', read);
  mockContent = owner;
  const view = renderHook(() => ({
    query: useOrdinaryPlanQuery('key', '2026-10-01', '2026-10-01'),
    actions: useOrdinaryWorkspaceActions(),
  }));
  await waitFor(() => expect(view.result.current.query.state.kind).toBe('ready'));
  read.mockImplementation(() => next);
  mockContent = { ...owner, refreshVersion: 1 };
  view.rerender({});
  expect(view.result.current.query.state).toEqual({ kind: 'loading', previous: snapshot });
  mockContent = { ...owner, refreshVersion: 2 };
  view.rerender({});
  expect(view.result.current.query.state).toEqual({ kind: 'loading', previous: snapshot });
  mockContent = { kind: 'unavailable', status: 'updating' };
  view.rerender({});
  expect(view.result.current.query.state).toEqual({ kind: 'loading' });
  expect(view.result.current.actions.actions).toBeNull();
  await act(async () => resolve({ kind: 'ready', value: snapshot, revision: 2 }));
  expect(view.result.current.query.state).toEqual({ kind: 'loading' });
});
