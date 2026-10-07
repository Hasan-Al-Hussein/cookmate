import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountReplicationScope } from '@cookmate/account-sync';
import { createAccountRuntimeWithBackend, type AccountRuntimeOptions } from './accountRuntime';
import type { AccountRuntimeBackend, AccountRuntimeConnection } from './accountRuntimeBackend';
import { createWorkspaceSelection } from './workspaceSelection';
import { createLocalAccountSettings } from './localAccountSettings';
import { createDeletionRecoveryJournal } from './deletionRecovery';
import { parseAccountAuthConfig } from './authConfig';
import type { AccountIdentity } from './authTypes';
import type { SupabaseAccountAccess } from './supabaseAccess';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const identity = (ownerId: string): AccountIdentity => ({
  ownerId,
  provider: 'google',
  email: null,
  displayName: null,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface Handle {
  readonly label: string;
  close(): Promise<void>;
}
type State =
  | { kind: 'local'; format: 'controlled' }
  | { kind: 'working'; format: 'controlled' }
  | { kind: 'review'; exactRevision: string }
  | { kind: 'synced'; format: 'controlled' };
type Review = Readonly<{ reviewId: string; coverage: 'controlled-exact' }>;
type Action = { kind: 'choose'; exactRevision: string };
type Backend = AccountRuntimeBackend<Handle, State, Review, Action>;

/** Controlled backend ports exercise lifecycle authority; no content or cloud proof is claimed. */
function fixture() {
  const values = new Map<string, string>();
  const calls: string[] = [];
  const storage = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
  let session: AccountIdentity | null = identity(OWNER);
  let authListener: ((value: AccountIdentity | null) => void) | undefined;
  const auth: SupabaseAccountAccess = {
    readSession: async () =>
      session ? { identity: session, accessToken: 'controlled-token' } : null,
    subscribe(listener) {
      authListener = listener;
      return () => {
        authListener = undefined;
      };
    },
    signInNative: async () => {
      session = identity(OWNER);
      return session;
    },
    prepareWebSignIn: async () => 'https://accounts.example/auth',
    completeWebSignIn: async () => {
      session = identity(OWNER);
      return session;
    },
    signOut: async () => {
      session = null;
      calls.push('auth:sign-out');
    },
    verifyNativeAccess: async () => undefined,
    startAutoRefresh: async () => undefined,
    stopAutoRefresh: async () => undefined,
    dispose: async () => {
      calls.push('auth:dispose');
    },
  };
  let closed = () => true;
  const selection = createWorkspaceSelection({
    storage: {
      read: () => storage.read('selection'),
      write: (value) => storage.write('selection', value),
    },
    assertClosed: () => assert.equal(closed(), true),
    databases: {
      prepare: async (owner, copyGuest) => {
        calls.push(`prepare:${owner}:${copyGuest}`);
      },
      remove: async (owner) => {
        calls.push(`remove:${owner}`);
      },
    },
  });
  const settings = createLocalAccountSettings({
    ownerId: OWNER,
    store: storage,
    isCurrent: () => true,
  });
  let state: State = { kind: 'local', format: 'controlled' };
  const listeners = new Set<() => void>();
  let changed: (() => void) | undefined;
  let connectInput: Parameters<Backend['connect']>[0] | undefined;
  let connect: Backend['connect'] = async (input) => {
    connectInput = input;
    calls.push('connect');
    return connection;
  };
  let canSync = true;
  let invalidate = async () => {
    calls.push('invalidate');
  };
  const connection: AccountRuntimeConnection<State, Action> = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeLocalChanges(listener) {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
    sync: async () => {
      calls.push('sync');
    },
    dispatch: (action) => {
      calls.push(`choose:${action.exactRevision}`);
    },
    invalidate: () => invalidate(),
  };
  const review: Review = Object.freeze({ reviewId: OPERATION, coverage: 'controlled-exact' });
  let approved: Review | undefined;
  const backend: Backend = {
    localState: () => ({ kind: 'local', format: 'controlled' }),
    canSync: () => canSync,
    canApprove: () => true,
    connect: (input) => connect(input),
    reviewApproval: async () => review,
    approveScope: async (_handle, _scope, exact, historyIncluded) => {
      approved = exact;
      calls.push(`approval:${historyIncluded}`);
    },
  };
  const journal = createDeletionRecoveryJournal({
    getItem: storage.read,
    setItem: storage.write,
    removeItem: storage.remove,
  });
  let deletionState: () => Promise<{
    revision: number;
    deletionOperationId: string | null;
  }> = async () => ({ revision: 17, deletionOperationId: null });
  let observedScope: Readonly<AccountReplicationScope> | undefined;
  let close = async () => {
    calls.push('handle:close');
  };
  const options: AccountRuntimeOptions<Handle> & { backend: Backend } = {
    selection,
    auth,
    config: parseAccountAuthConfig({
      url: 'https://accounts.example',
      publishableKey: 'sb_publishable_controlled',
    }),
    enableExpandedScope: true,
    newId: () => OPERATION,
    metadata: storage,
    guestPreferences: { read: async () => null, write: async () => undefined },
    settings: () => settings,
    drainSettings: () => settings.drain(),
    backend,
    fetch: async (_url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(body && typeof body === 'object' && 'action' in body);
      assert.equal(
        body.action,
        'delete',
        'generic backend must not invoke the legacy snapshot reader',
      );
      calls.push('remote:delete');
      return Response.json({ ownerId: OWNER, operationId: OPERATION, deleted: true });
    },
    deletion: {
      journal,
      newToken: async () => 'a'.repeat(64),
      readStatus: async () => ({ status: 'pending', operationId: OPERATION }),
      readState: async (scope) => {
        observedScope = scope;
        return deletionState();
      },
    },
    open: async (workspace) => ({
      kind: 'ready',
      services: {
        label: workspace.kind === 'guest' ? 'guest' : workspace.ownerId,
        close: () => close(),
      },
    }),
  };
  const runtime = createAccountRuntimeWithBackend(options);
  closed = () => runtime.closed;
  return {
    runtime,
    calls,
    options,
    backend,
    connection,
    review,
    journal,
    values,
    get approved() {
      return approved;
    },
    get connectInput() {
      return connectInput;
    },
    get observedScope() {
      return observedScope;
    },
    setConnect(value: Backend['connect']) {
      connect = value;
    },
    setInvalidate(value: () => Promise<void>) {
      invalidate = value;
    },
    setClose(value: () => Promise<void>) {
      close = value;
    },
    setCanSync(value: boolean) {
      canSync = value;
    },
    setDeletionState(value: typeof deletionState) {
      deletionState = value;
    },
    publish(value: State) {
      state = value;
      for (const listener of [...listeners]) listener();
    },
    notifyChange() {
      changed?.();
    },
    emit(ownerId: string | null) {
      session = ownerId ? identity(ownerId) : null;
      authListener?.(session);
    },
    async open() {
      await runtime.initialize();
      const result = await runtime.opener(runtime.getSnapshot().workspace)();
      assert.equal(result.kind, 'ready');
      await flush();
      return result.services;
    },
  };
}

test('a minimal owned handle uses backend state/actions and keeps the selected owner after sign-out', async () => {
  const f = fixture();
  const handle = await f.open();
  assert.equal(handle.label, OWNER);
  assert.equal(f.runtime.closed, false);
  f.publish({ kind: 'review', exactRevision: 'retained-r2' });
  assert.deepEqual(f.runtime.getSnapshot().sync, { kind: 'review', exactRevision: 'retained-r2' });
  f.runtime.dispatch({ kind: 'choose', exactRevision: 'retained-r2' });
  assert.ok(f.calls.includes('choose:retained-r2'));
  await f.runtime.signOut(false);
  assert.deepEqual(f.runtime.getSnapshot().workspace, { kind: 'account', ownerId: OWNER });
  assert.equal(f.runtime.getSnapshot().identity, null);
  assert.equal(f.runtime.closed, false);
  const before = [...f.calls];
  f.runtime.dispatch({ kind: 'choose', exactRevision: 'stale' });
  f.publish({ kind: 'review', exactRevision: 'stale' });
  assert.deepEqual(f.calls, before);
  assert.deepEqual(f.runtime.getSnapshot().sync, { kind: 'local', format: 'controlled' });
  await handle.close();
  await f.runtime.dispose();
});

test('scope approval retains the exact backend review and rejects clones and retired tokens', async () => {
  const f = fixture();
  const handle = await f.open();
  await f.runtime.reviewSyncScope();
  const result = f.runtime.getSnapshot().scopeReview;
  assert.equal(result?.kind, 'review');
  assert.equal(result.review, f.review);
  await f.runtime.approveSyncScope({ ...f.review }, true);
  assert.equal(f.approved, undefined);
  await f.runtime.approveSyncScope(result.review, true);
  assert.equal(f.approved, f.review);
  await flush();
  await f.runtime.reviewSyncScope();
  f.emit(OTHER);
  const before = f.calls.filter((value) => value.startsWith('approval:')).length;
  await f.runtime.approveSyncScope(f.review, false);
  assert.equal(f.calls.filter((value) => value.startsWith('approval:')).length, before);
  await handle.close();
  await f.runtime.dispose();
});

test('close waits for a late backend connection and its invalidation before closing the handle', async () => {
  const f = fixture();
  const connected = gate<AccountRuntimeConnection<State, Action>>();
  const invalidated = gate<void>();
  f.setConnect(async () => connected.promise);
  f.setInvalidate(async () => {
    f.calls.push('late:invalidate');
    await invalidated.promise;
  });
  const handle = await f.open();
  let finished = false;
  const closing = handle.close().then(() => {
    finished = true;
  });
  await flush();
  assert.equal(finished, false);
  assert.equal(f.calls.includes('handle:close'), false);
  connected.resolve(f.connection);
  await flush();
  assert.ok(f.calls.includes('late:invalidate'));
  assert.equal(f.calls.includes('handle:close'), false);
  invalidated.resolve();
  await closing;
  assert.equal(f.runtime.closed, true);
  assert.equal(f.calls.includes('sync'), false);
  await f.runtime.dispose();
});

test('failed second subscription releases the first and drains before permitting a clean retry', async () => {
  const f = fixture();
  const invalidated = gate<void>();
  const subscribeState = f.connection.subscribe;
  const subscribeChanges = f.connection.subscribeLocalChanges;
  let stateReleases = 0;
  f.connection.subscribe = (listener) => {
    const release = subscribeState(listener);
    return () => {
      stateReleases++;
      release();
    };
  };
  f.connection.subscribeLocalChanges = () => {
    throw new Error('controlled subscription failure');
  };
  f.setInvalidate(async () => {
    f.calls.push('subscription:invalidate');
    await invalidated.promise;
  });
  const handle = await f.open();
  assert.equal(stateReleases, 1);
  assert.equal(f.calls.filter((value) => value === 'subscription:invalidate').length, 1);
  f.runtime.dispatch({ kind: 'choose', exactRevision: 'half-attached' });
  f.publish({ kind: 'review', exactRevision: 'half-attached' });
  f.runtime.syncNow();
  await flush();
  assert.equal(f.calls.filter((value) => value === 'connect').length, 1);
  assert.equal(f.calls.includes('choose:half-attached'), false);
  assert.deepEqual(f.runtime.getSnapshot().sync, { kind: 'local', format: 'controlled' });
  assert.equal(f.calls.includes('sync'), false);
  invalidated.resolve();
  await flush();
  f.connection.subscribeLocalChanges = subscribeChanges;
  f.runtime.syncNow();
  await flush();
  assert.equal(f.calls.filter((value) => value === 'connect').length, 2);
  f.runtime.dispatch({ kind: 'choose', exactRevision: 'fresh' });
  assert.ok(f.calls.includes('choose:fresh'));
  await handle.close();
  assert.equal(stateReleases, 2);
  await f.runtime.dispose();
});

test('authority loss during subscription acquisition retires both local subscriptions', async () => {
  const f = fixture();
  const subscribeState = f.connection.subscribe;
  let stateReleases = 0,
    changeReleases = 0;
  f.connection.subscribe = (listener) => {
    const release = subscribeState(listener);
    return () => {
      stateReleases++;
      release();
    };
  };
  f.connection.subscribeLocalChanges = () => {
    f.emit(OTHER);
    return () => {
      changeReleases++;
    };
  };
  const handle = await f.open();
  assert.equal(stateReleases, 1);
  assert.equal(changeReleases, 1);
  assert.equal(f.calls.filter((value) => value === 'invalidate').length, 1);
  assert.equal(f.calls.includes('sync'), false);
  f.runtime.dispatch({ kind: 'choose', exactRevision: 'retired' });
  assert.equal(f.calls.includes('choose:retired'), false);
  await handle.close();
  await f.runtime.dispose();
});

test('failed close prevents another opening instead of reporting a released handle', async () => {
  const f = fixture();
  const handle = await f.open();
  f.setClose(async () => {
    throw new Error('controlled close failure');
  });
  await assert.rejects(handle.close(), /controlled close failure/);
  assert.equal(f.runtime.closed, false);
  const next = await f.runtime.opener(f.runtime.getSnapshot().workspace)();
  assert.equal(next.kind, 'failed');
  await assert.rejects(f.runtime.dispose(), /controlled close failure/);
});

test('backend and deletion callbacks are captured before caller replacement', async () => {
  const f = fixture();
  f.backend.connect = async () => {
    throw new Error('replaced backend');
  };
  assert.ok(f.options.deletion);
  f.options.deletion.readState = async () => {
    throw new Error('replaced deletion port');
  };
  const handle = await f.open();
  assert.ok(f.calls.includes('connect'));
  await f.runtime.reviewDeletion();
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'review');
  assert.equal(f.observedScope?.ownerId, OWNER);
  assert.equal(Object.isFrozen(f.observedScope), true);
  await handle.close();
  await f.runtime.dispose();
});

test('deletion uses the supplied revision projection and existing durable secret/receipt protocol', async () => {
  const f = fixture();
  const handle = await f.open();
  await f.runtime.reviewDeletion();
  await f.runtime.confirmDeletion();
  assert.equal(f.calls.filter((value) => value === 'remote:delete').length, 1);
  const proof = await f.journal.read(OWNER);
  assert.equal(proof?.kind, 'confirmed');
  assert.equal(proof.operationId, OPERATION);
  assert.equal(f.runtime.getSnapshot().deletion?.kind, 'deleted');
  await handle.close();
  await f.runtime.dispose();
});

test('invalid deletion revision or operation identity never authorizes a deletion', async () => {
  for (const saved of [
    { revision: -1, deletionOperationId: null },
    { revision: Number.MAX_SAFE_INTEGER + 1, deletionOperationId: null },
    { revision: 1, deletionOperationId: `${OPERATION}\n` },
  ]) {
    const f = fixture();
    f.setDeletionState(async () => saved);
    const handle = await f.open();
    await f.runtime.reviewDeletion();
    assert.equal(f.runtime.getSnapshot().deletion?.kind, 'failed');
    await f.runtime.confirmDeletion();
    assert.equal(f.calls.includes('remote:delete'), false);
    assert.equal(await f.journal.read(OWNER), null);
    await handle.close();
    await f.runtime.dispose();
  }
});

test('owner loss during deletion revision lookup cannot publish an actionable stale review', async () => {
  const f = fixture();
  const result = gate<{ revision: number; deletionOperationId: string | null }>();
  const entered = gate<void>();
  f.setDeletionState(async () => {
    entered.resolve();
    return result.promise;
  });
  const handle = await f.open();
  const review = f.runtime.reviewDeletion();
  await entered.promise;
  // Auth events during a busy operation are reconciled by the runtime afterward; explicit
  // retirement is authoritative immediately and must suppress all later private publication.
  const disposed = f.runtime.dispose();
  result.resolve({ revision: 19, deletionOperationId: null });
  await review;
  await f.runtime.confirmDeletion();
  assert.equal(f.calls.includes('remote:delete'), false);
  await handle.close();
  await disposed;
});
