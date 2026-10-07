import { createAccountRuntime } from './accountRuntime';
import { AccountReplicationError } from '@cookmate/account-sync';
import type {
  AccountReplicationScope,
  AccountScopeApprovalEvidence,
  AccountSyncState,
} from '@cookmate/account-sync';
import type { WorkspaceSelection } from './workspaceSelection';
import type { SupabaseAccountAccess } from './supabaseAccess';
import type { AccountIdentity } from './authTypes';
import type { LocalAccountSettingsController } from './localAccountSettings';
import type { LocalCookMateServices } from '../../data/localServices';
import type { AccountScopeApprovalReview } from '../../data/accountScopeApproval';
import type { CookingChange, PersonalChange } from '@cookmate/domain';
import type { DeletionRecoveryJournal } from './deletionRecovery';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const identity = (owner: string): AccountIdentity => ({
  ownerId: owner,
  provider: 'google',
  email: null,
  displayName: null,
});
interface MockCoordinator {
  options: { enableExpandedScope?: boolean };
  state: AccountSyncState;
  listeners: Set<() => void>;
  sync: jest.Mock<Promise<void>, []>;
  drain: Promise<void>;
  invalidated: boolean;
}
const mockCoordinators: MockCoordinator[] = [];
jest.mock('@cookmate/account-sync', () => ({
  ...jest.requireActual('@cookmate/account-sync'),
  createAccountRemote: () => ({ read: async () => ({ revision: 0, deletionOperationId: null }) }),
  createAccountSyncCoordinator: (options: MockCoordinator['options']) => {
    const instance: MockCoordinator = {
      options,
      state: { kind: 'local' },
      listeners: new Set(),
      drain: Promise.resolve(),
      invalidated: false,
      sync: jest.fn(async () => {
        instance.state = { kind: 'working' };
        instance.listeners.forEach((listener) => listener());
      }),
    };
    mockCoordinators.push(instance);
    return {
      getSnapshot: () => instance.state,
      sync: instance.sync,
      invalidate: () => {
        instance.invalidated = true;
        return instance.drain;
      },
      subscribe: (listener: () => void) => {
        instance.listeners.add(listener);
        return () => instance.listeners.delete(listener);
      },
    };
  },
}));
const flush = async () => {
  for (let count = 0; count < 20; count++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function fixture(input: { enabled?: boolean; approved?: boolean; history?: boolean } = {}) {
  const core = new Set<(change: { collections: string[] }) => void>();
  const personal = new Set<(change: PersonalChange) => void>();
  const cooking = new Set<(change: CookingChange) => void>();
  let session: AccountIdentity | null = identity(ownerId);
  let authListener: ((value: AccountIdentity | null) => void) | undefined;
  let currentScope!: () => AccountReplicationScope | null;
  let approval: AccountScopeApprovalEvidence | null = input.approved
    ? evidence(input.history ?? false)
    : null;
  const issued = Object.freeze<AccountScopeApprovalReview>({
    reviewId: otherOwner,
    ownerId,
    counts: Object.freeze({
      notes: 2,
      collections: 1,
      memberships: 3,
      manualItems: 4,
      cookingHistory: 5,
    }),
    historyIncluded: approval?.record.historyIncluded ?? false,
    previousApprovalDigest: approval?.digest ?? null,
  });
  const review = jest.fn(async () => issued);
  const approve = jest.fn(
    async (
      scope: AccountReplicationScope,
      exact: AccountScopeApprovalReview,
      choice: { historyIncluded: boolean },
    ) => {
      expect(exact).toBe(issued);
      expect(scope).toEqual(currentScope());
      approval = evidence(choice.historyIncluded);
      return approval;
    },
  );
  const selected = { status: 'ready', manifest: { active: { kind: 'account', ownerId } } };
  const runtime = createAccountRuntime({
    ...(input.enabled === undefined ? {} : { enableExpandedScope: input.enabled }),
    selection: {
      initialize: async () => selected,
      recoverPending: async () => selected,
      getSnapshot: () => selected,
      activate: async () => selected,
    } as unknown as WorkspaceSelection,
    auth: {
      readSession: async () => session && { identity: session, accessToken: 'session.token' },
      verifyNativeAccess: async () => undefined,
      subscribe: (listener: typeof authListener) => {
        authListener = listener;
        return () => {
          authListener = undefined;
        };
      },
      dispose: async () => undefined,
    } as unknown as SupabaseAccountAccess,
    config: {
      url: 'https://account.example',
      serviceEndpoint: 'https://account.example/functions/v1/cookmate-account',
      publishableKey: 'sb_publishable_test',
      apple: false,
      google: true,
      googleWebClientId: null,
      googleIosClientId: null,
    },
    metadata: {
      read: async () => null,
      write: async () => undefined,
      remove: async () => undefined,
    },
    newId: () => ownerId,
    fetch: jest.fn(),
    guestPreferences: { read: async () => null, write: async () => undefined },
    settings: () =>
      ({
        hydrate: async () => undefined,
        getSnapshot: () => ({ kind: 'ready' }),
      }) as unknown as LocalAccountSettingsController,
    drainSettings: async () => undefined,
    deletion: {
      journal: {
        read: async () => null,
        list: async () => [],
      } as unknown as DeletionRecoveryJournal,
      newToken: async () => 'a'.repeat(64),
      readStatus: async () => {
        throw new Error('No deletion dispatched in this fixture');
      },
    },
    open: async (_workspace, scope) => {
      currentScope = scope;
      return {
        kind: 'ready',
        services: {
          accountReplication: {},
          accountScopeApproval: { read: async () => approval, review, approve },
          queries: {
            subscribe: (listener: (change: { collections: string[] }) => void) => {
              core.add(listener);
              return () => core.delete(listener);
            },
          },
          personal: {
            subscribe: (listener: (change: PersonalChange) => void) => {
              personal.add(listener);
              return () => personal.delete(listener);
            },
          },
          cooking: {
            subscribe: (listener: (change: CookingChange) => void) => {
              cooking.add(listener);
              return () => cooking.delete(listener);
            },
          },
          close: async () => undefined,
        } as unknown as LocalCookMateServices,
      };
    },
  });
  await runtime.initialize();
  const opened = await runtime.opener(runtime.getSnapshot().workspace)();
  if (opened.kind !== 'ready') throw new Error('Fixture did not open');
  let openedServices = opened.services;
  await flush();
  return {
    runtime,
    core,
    personal,
    cooking,
    issued,
    review,
    approve,
    switchOwner: () => {
      session = identity(otherOwner);
      authListener?.(session);
    },
    coordinator: () => mockCoordinators.at(-1)!,
    async reopen() {
      await openedServices.close();
      const next = await runtime.opener(runtime.getSnapshot().workspace)();
      if (next.kind !== 'ready') throw new Error('Fixture did not reopen');
      openedServices = next.services;
      await flush();
    },
    async close() {
      await openedServices.close();
      await runtime.dispose();
    },
    closeStore: () => openedServices.close(),
  };
}
function evidence(historyIncluded: boolean): AccountScopeApprovalEvidence {
  return {
    record: {
      schemaVersion: 1,
      ownerId,
      scopeVersion: 2,
      personalApproved: true,
      historyIncluded,
      decidedAt: '2026-10-01T12:00:00.000Z',
    },
    digest: 'a'.repeat(64),
  };
}
function settle(instance: MockCoordinator) {
  instance.state = { kind: 'local' };
  instance.listeners.forEach((listener) => listener());
}
beforeEach(() => {
  jest.useFakeTimers();
  mockCoordinators.length = 0;
});
afterEach(() => {
  jest.useRealTimers();
});

test('expanded runtime defaults off even when an approval service and saved approval exist', async () => {
  const f = await fixture({ approved: true, history: true });
  expect(f.runtime.getSnapshot().expandedScopeAvailable).toBe(false);
  expect(f.coordinator().options.enableExpandedScope).toBe(false);
  await f.runtime.reviewSyncScope();
  expect(f.review).not.toHaveBeenCalled();
  expect(f.personal.size).toBe(0);
  expect(f.cooking.size).toBe(0);
  await f.close();
});

test('scope review drains sync, suppresses scheduling and approves only its exact service-issued capability', async () => {
  const f = await fixture({ enabled: true });
  const instance = f.coordinator();
  const drained = deferred<void>();
  instance.drain = drained.promise;
  const reviewing = f.runtime.reviewSyncScope();
  await flush();
  expect(instance.invalidated).toBe(true);
  expect(f.review).not.toHaveBeenCalled();
  expect(f.core.size).toBe(0);
  f.runtime.syncNow();
  f.runtime.localSettingsChanged();
  await jest.advanceTimersByTimeAsync(3000);
  expect(mockCoordinators).toHaveLength(1);
  drained.resolve();
  await reviewing;
  expect(f.runtime.getSnapshot().scopeReview).toEqual({ kind: 'review', review: f.issued });
  await f.runtime.approveSyncScope(f.issued, false);
  await flush();
  expect(f.approve).toHaveBeenCalledTimes(1);
  expect(f.approve.mock.calls[0]![1]).toBe(f.issued);
  expect(f.runtime.getSnapshot().scopeReview).toBeNull();
  expect(f.coordinator().options.enableExpandedScope).toBe(true);
  await f.runtime.approveSyncScope(f.issued, true);
  expect(f.approve).toHaveBeenCalledTimes(1);
  await f.close();
});

test.each(['cancel', 'owner'] as const)(
  'a delayed scope review cannot publish after %s changes its fence',
  async (action) => {
    const f = await fixture({ enabled: true });
    const deferredReview = deferred<AccountScopeApprovalReview>();
    f.review.mockImplementationOnce(() => deferredReview.promise);
    const reviewing = f.runtime.reviewSyncScope();
    await flush();
    if (action === 'cancel') f.runtime.cancelSyncScopeReview();
    else f.switchOwner();
    deferredReview.resolve(f.issued);
    await reviewing;
    await f.runtime.approveSyncScope(f.issued, true);
    expect(f.runtime.getSnapshot().scopeReview).toBeNull();
    expect(f.approve).not.toHaveBeenCalled();
    if (action === 'owner') expect(f.runtime.getSnapshot().expandedScopeAvailable).toBe(false);
    await f.close();
  },
);

test('local changes consume the stale review and require a new review instead of retrying approval', async () => {
  const f = await fixture({ enabled: true });
  await f.runtime.reviewSyncScope();
  f.approve.mockRejectedValueOnce(new AccountReplicationError('local_changed'));
  await f.runtime.approveSyncScope(f.issued, true);
  expect(f.runtime.getSnapshot().scopeReview).toEqual({ kind: 'failed', reason: 'local_changed' });
  await f.runtime.approveSyncScope(f.issued, true);
  expect(f.approve).toHaveBeenCalledTimes(1);
  expect(mockCoordinators).toHaveLength(1);
  await f.close();
});

test.each(['cancel', 'owner'] as const)(
  'a retained approval callback cannot approve a replacement review after %s',
  async (action) => {
    const f = await fixture({ enabled: true });
    await f.runtime.reviewSyncScope();
    const retainedCallback = () => f.runtime.approveSyncScope(f.issued, true);
    if (action === 'cancel') f.runtime.cancelSyncScopeReview();
    else {
      f.switchOwner();
      await f.reopen();
    }
    const replacement = Object.freeze({
      ...f.issued,
      reviewId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      ownerId: action === 'owner' ? otherOwner : ownerId,
    });
    f.review.mockResolvedValueOnce(replacement);
    await f.runtime.reviewSyncScope();
    await retainedCallback();
    await f.runtime.approveSyncScope({ ...replacement }, true);
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.runtime.getSnapshot().scopeReview).toEqual({ kind: 'review', review: replacement });
    f.approve.mockImplementationOnce(async (scope, exact, choice) => {
      expect(scope.ownerId).toBe(replacement.ownerId);
      expect(exact).toBe(replacement);
      return evidence(choice.historyIncluded);
    });
    await f.runtime.approveSyncScope(replacement, false);
    expect(f.approve).toHaveBeenCalledTimes(1);
    await f.close();
  },
);

test.each(['operation_pending', 'settings_pending'] as const)(
  'scope review preserves %s recovery before a new approval',
  async (reason) => {
    const f = await fixture({ enabled: true });
    f.review.mockRejectedValueOnce(new AccountReplicationError(reason));
    await f.runtime.reviewSyncScope();
    await flush();
    expect(f.runtime.getSnapshot().scopeReview).toEqual({ kind: 'failed', reason });
    expect(f.approve).not.toHaveBeenCalled();
    expect(mockCoordinators).toHaveLength(2);
    await f.runtime.reviewSyncScope();
    expect(f.runtime.getSnapshot().scopeReview?.kind).toBe('review');
    await f.close();
  },
);

test.each([false, true])(
  'subscriptions include approved personal data and history only when included=%s',
  async (history) => {
    const f = await fixture({ enabled: true, approved: true, history });
    const instance = f.coordinator();
    expect(f.personal.size).toBe(1);
    expect(f.cooking.size).toBe(history ? 1 : 0);
    settle(instance);
    f.cooking.forEach((listener) =>
      listener({ recipeId: '52819', historyChanged: false, revision: 1 }),
    );
    f.core.forEach((listener) => listener({ collections: ['conversation'] }));
    await jest.advanceTimersByTimeAsync(3000);
    expect(instance.sync).toHaveBeenCalledTimes(1);
    f.personal.forEach((listener) =>
      listener({ notes: true, collections: false, manualShopping: false, revision: 1 }),
    );
    await jest.advanceTimersByTimeAsync(2000);
    expect(instance.sync).toHaveBeenCalledTimes(2);
    if (history) {
      settle(instance);
      f.cooking.forEach((listener) =>
        listener({ recipeId: null, historyChanged: true, revision: 2 }),
      );
      await jest.advanceTimersByTimeAsync(2000);
      expect(instance.sync).toHaveBeenCalledTimes(3);
    }
    const stalePersonal = [...f.personal];
    f.switchOwner();
    expect(f.personal.size).toBe(0);
    expect(f.cooking.size).toBe(0);
    expect(f.core.size).toBe(0);
    stalePersonal.forEach((listener) =>
      listener({ notes: true, collections: true, manualShopping: true, revision: 3 }),
    );
    await jest.advanceTimersByTimeAsync(3000);
    expect(mockCoordinators).toHaveLength(1);
    await f.close();
  },
);

test('owner switch during approval suppresses its late result and store close waits for it to settle', async () => {
  const f = await fixture({ enabled: true });
  await f.runtime.reviewSyncScope();
  const completed = deferred<AccountScopeApprovalEvidence>();
  f.approve.mockImplementationOnce(() => completed.promise);
  const approving = f.runtime.approveSyncScope(f.issued, true);
  f.runtime.cancelSyncScopeReview();
  expect(f.runtime.getSnapshot().scopeReview?.kind).toBe('loading');
  f.switchOwner();
  let closed = false;
  const close = f.closeStore().then(() => {
    closed = true;
  });
  await flush();
  expect(closed).toBe(false);
  completed.resolve(evidence(true));
  await approving;
  await close;
  expect(f.runtime.getSnapshot().scopeReview).toBeNull();
  expect(f.runtime.getSnapshot().workspaceKey).toBe('account:' + otherOwner);
  expect(mockCoordinators).toHaveLength(1);
  await f.runtime.dispose();
});

test('deletion review invalidates a delayed scope review before any scope approval is possible', async () => {
  const f = await fixture({ enabled: true });
  const delayed = deferred<AccountScopeApprovalReview>();
  f.review.mockImplementationOnce(() => delayed.promise);
  const reviewing = f.runtime.reviewSyncScope();
  await flush();
  const deletion = f.runtime.reviewDeletion();
  delayed.resolve(f.issued);
  await reviewing;
  await deletion;
  expect(f.runtime.getSnapshot().scopeReview).toBeNull();
  expect(f.runtime.getSnapshot().deletion?.kind).toBe('review');
  expect(f.runtime.getSnapshot().expandedScopeAvailable).toBe(false);
  await f.runtime.approveSyncScope(f.issued, true);
  expect(f.approve).not.toHaveBeenCalled();
  await f.close();
});
