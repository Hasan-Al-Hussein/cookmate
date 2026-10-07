import {
  createAccountRemote,
  AccountRemoteError,
  AccountReplicationError,
  type AccountReplicationScope,
  type AccountSyncState,
} from '@cookmate/account-sync';
import type { Immutable } from '@cookmate/domain';
import type { AccountScopeApprovalReview } from '../../data/accountScopeApproval';
import type { LocalCookMateServices } from '../../data/localServices';
import type { AppPreferencesStore } from '../app-preferences/preferences';
import { requiresWebStorageReload } from '../../data/webStorageFailure';
import { AccountAuthError, type AccountIdentity, type AccountProviderName } from './authTypes';
import type { AccountAuthConfig } from './authConfig';
import type { SupabaseAccountAccess } from './supabaseAccess';
import type { LocalAccountSettingsController } from './localAccountSettings';
import type { LocalWorkspace, WorkspaceSelection } from './workspaceSelection';
import type {
  DeletionRecoveryJournal,
  DeletionRecoveryStatus,
  PendingDeletionRecovery,
} from './deletionRecovery';
import { revision, uuid } from '../../data/accountReplicationRecords';
import {
  createLegacyAccountRuntimeBackend,
  type AccountRuntimeBackend,
  type AccountRuntimeConnection,
  type AccountRuntimeSyncState,
  type AccountRuntimeRemoteOptions,
  type AccountWorkspaceHandle,
  type AccountWorkspaceOpenResult,
} from './accountRuntimeBackend';

export interface EarlierDeletionState {
  ownerId: string;
  operationId: string;
  status: 'unconfirmed' | 'pending' | 'deleted';
}

export interface AccountRuntimeSnapshot<
  SyncState extends AccountRuntimeSyncState = AccountSyncState,
  Review extends object = Immutable<AccountScopeApprovalReview>,
> {
  startupSettled?: boolean;
  phase: 'starting' | 'ready' | 'failed';
  workspace: LocalWorkspace;
  workspaceKey: string;
  identity: AccountIdentity | null;
  checkingSession: boolean;
  busy: boolean;
  error: string | null;
  sync: SyncState;
  expandedScopeAvailable?: boolean;
  scopeReview?:
    | null
    | { kind: 'loading' }
    | { kind: 'review'; review: Review }
    | { kind: 'failed'; reason: string };
  earlierDeletions?: readonly EarlierDeletionState[];
  deletion: null | {
    kind: 'review' | 'working' | 'unconfirmed' | 'deleted' | 'failed';
    reason?: string;
  };
}
const keyFor = (workspace: LocalWorkspace) =>
  workspace.kind === 'guest' ? 'guest' : `account:${workspace.ownerId}`;
export interface AccountRuntimeOptions<Handle extends AccountWorkspaceHandle> {
  selection: WorkspaceSelection;
  auth: SupabaseAccountAccess | null;
  config: AccountAuthConfig | null;
  enableExpandedScope?: boolean;
  newId(): string;
  fetch: typeof fetch;
  guestPreferences: AppPreferencesStore;
  settings(ownerId: string): LocalAccountSettingsController;
  drainSettings(): Promise<void>;
  deletion?: {
    journal: DeletionRecoveryJournal;
    newToken(): Promise<string>;
    readStatus(input: {
      operationId: string;
      recoveryToken: string;
    }): Promise<DeletionRecoveryStatus>;
    /** Revision-only projection; format-specific snapshot parsing belongs to the supplied port. */
    readState?(
      scope: Readonly<AccountReplicationScope>,
      remote: AccountRuntimeRemoteOptions,
    ): Promise<{
      revision: number;
      deletionOperationId: string | null;
    }>;
  };
  metadata: {
    read(key: string): Promise<string | null>;
    write(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  open(
    workspace: LocalWorkspace,
    currentScope: () => AccountReplicationScope | null,
  ): Promise<AccountWorkspaceOpenResult<Handle>>;
}

/** One app lifetime; cloud identity and the retained local workspace are distinct. */
export function createAccountRuntimeWithBackend<
  Handle extends AccountWorkspaceHandle,
  SyncState extends AccountRuntimeSyncState,
  Review extends object,
  Action,
>(
  options: AccountRuntimeOptions<Handle> & {
    backend: AccountRuntimeBackend<Handle, SyncState, Review, Action>;
  },
) {
  const suppliedBackend = options.backend;
  const backend = Object.freeze({
    localState: suppliedBackend.localState.bind(suppliedBackend),
    canSync: suppliedBackend.canSync.bind(suppliedBackend),
    canApprove: suppliedBackend.canApprove.bind(suppliedBackend),
    connect: suppliedBackend.connect.bind(suppliedBackend),
    reviewApproval: suppliedBackend.reviewApproval.bind(suppliedBackend),
    approveScope: suppliedBackend.approveScope.bind(suppliedBackend),
  });
  const readDeletionState = options.deletion?.readState?.bind(options.deletion);
  type Snapshot = AccountRuntimeSnapshot<SyncState, Review>;
  let state: Snapshot = Object.freeze<Snapshot>({
    startupSettled: false,
    phase: 'starting',
    workspace: { kind: 'guest' },
    workspaceKey: 'guest',
    identity: null,
    checkingSession: !!options.auth,
    busy: false,
    error: null,
    sync: backend.localState(),
    expandedScopeAvailable: false,
    scopeReview: null,
    earlierDeletions: Object.freeze([]),
    deletion: null,
  });
  let retired = false;
  let generation = 0;
  let revokedOwner: string | null = null;
  let services: Handle | null = null;
  let opening: Promise<void> = Promise.resolve();
  let storeClosed: Promise<void> = Promise.resolve();
  let openedKey: string | null = null;
  let sync: AccountRuntimeConnection<SyncState, Action> | null = null;
  let attaching = false;
  let attachingDrain: Promise<void> = Promise.resolve();
  let attachSequence = 0;
  let syncDrain: Promise<void> = Promise.resolve();
  let refreshWork: Promise<void> = Promise.resolve();
  let unsubscribeSync: (() => void) | null = null;
  let unsubscribeChanges: (() => void) | null = null;
  let unsubscribeAuth: (() => void) | null = null;
  let removeOwner: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirtyDuringSync = false;
  let scopeSequence = 0;
  let scopeDrain: Promise<void> = Promise.resolve();
  let approvingScope = false;
  let scopeCapability: {
    scope: AccountReplicationScope;
    services: Handle;
    review: Review;
  } | null = null;
  let earlierRefreshSequence = 0;
  let earlierAuthNotification: { latest?: AccountIdentity | null } | null = null;
  const earlierResults = new Map<string, EarlierDeletionState>();
  let deletionReview: {
    ownerId: string;
    operationId: string;
    expectedRevision: number;
    generation: number;
    recoveryToken?: string;
  } | null = null;
  const listeners = new Set<() => void>();
  const removalKey = 'cookmate.account-removal.intent';
  async function saveRemoval(ownerId: string, phase: 'requested' | 'signed-out') {
    const previous = await readRemoval();
    if (
      previous &&
      (previous.ownerId !== ownerId || (previous.phase === 'signed-out' && phase === 'requested'))
    )
      throw new Error('Another removal must finish first');
    const raw = JSON.stringify({ schemaVersion: 1, ownerId, phase });
    try {
      await options.metadata.write(removalKey, raw);
    } catch {
      /* Exact readback resolves acknowledgement loss. */
    }
    if ((await options.metadata.read(removalKey)) !== raw)
      throw new Error('Removal intent could not be confirmed');
  }
  async function readRemoval() {
    const raw = await options.metadata.read(removalKey);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'ownerId,phase,schemaVersion' ||
      !('schemaVersion' in value) ||
      value.schemaVersion !== 1 ||
      !('ownerId' in value) ||
      typeof value.ownerId !== 'string' ||
      value.ownerId.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        value.ownerId,
      ) ||
      !('phase' in value) ||
      (value.phase !== 'requested' && value.phase !== 'signed-out')
    )
      throw new Error('Invalid removal intent');
    return { ownerId: value.ownerId, phase: value.phase };
  }
  async function cancelUnexecutedRemoval(ownerId: string) {
    const pending = await readRemoval();
    if (!pending) return;
    const selected = options.selection.getSnapshot();
    if (
      pending.ownerId !== ownerId ||
      pending.phase !== 'requested' ||
      selected.status !== 'ready' ||
      selected.manifest.active.kind !== 'account' ||
      selected.manifest.active.ownerId !== ownerId
    )
      throw new Error('Removal has already started');
    try {
      await options.metadata.remove(removalKey);
    } catch {
      /* Only confirmed absence accepts the newer Keep choice. */
    }
    if ((await options.metadata.read(removalKey)) !== null)
      throw new Error('Keep choice could not be confirmed');
  }
  async function finishRemoval(ownerId: string) {
    const selected = options.selection.getSnapshot();
    if (
      !(
        selected.status === 'ready' &&
        selected.manifest.active.kind === 'guest' &&
        !selected.manifest.accountOwners.includes(ownerId)
      )
    )
      await options.selection.removeLocalCopy(ownerId);
    await options.metadata.remove(removalKey);
    if ((await options.metadata.read(removalKey)) !== null)
      throw new Error('Removal acknowledgement unavailable');
  }
  function publish(next: Partial<Snapshot>) {
    if (retired) return;
    const updated = { ...state, ...next };
    if (next.deletion && state.scopeReview) {
      scopeSequence++;
      scopeCapability = null;
      approvingScope = false;
      updated.scopeReview = null;
    }
    state = Object.freeze({
      ...updated,
      expandedScopeAvailable: !!(
        options.enableExpandedScope &&
        options.auth &&
        options.config &&
        services &&
        backend.canApprove(services) &&
        openedKey === updated.workspaceKey &&
        updated.workspace.kind === 'account' &&
        updated.identity?.ownerId === updated.workspace.ownerId &&
        !updated.deletion
      ),
    });
    for (const listener of listeners) listener();
  }
  function failure(error: unknown) {
    return requiresWebStorageReload(error)
      ? 'web_restart_required'
      : error instanceof AccountAuthError
        ? error.reason
        : 'storage';
  }
  function stopSync() {
    attachSequence++;
    if (timer) clearTimeout(timer);
    timer = null;
    dirtyDuringSync = false;
    const stops = [unsubscribeSync, unsubscribeChanges];
    unsubscribeSync = null;
    unsubscribeChanges = null;
    const current = sync;
    sync = null;
    if (current) void retireConnection(current, stops).catch(() => undefined);
  }
  function retireConnection(
    instance: AccountRuntimeConnection<SyncState, Action>,
    stops: ReadonlyArray<(() => void) | null | undefined>,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const stop of stops) {
      try {
        stop?.();
      } catch (error) {
        failures.push(error);
      }
    }
    let invalidating: Promise<void>;
    try {
      invalidating = instance.invalidate();
    } catch (error) {
      invalidating = Promise.reject(error);
    }
    const completion = invalidating
      .catch((error: unknown) => {
        failures.push(error);
      })
      .then(() => {
        if (failures.length) throw new AggregateError(failures, 'Account sync cleanup failed');
      });
    syncDrain = Promise.all([syncDrain, completion]).then(() => undefined);
    void syncDrain.catch(() => undefined);
    return completion;
  }
  async function drainSync() {
    await attachingDrain;
    await syncDrain;
  }
  function clearScopeReview() {
    scopeSequence++;
    scopeCapability = null;
    approvingScope = false;
    publish({ scopeReview: null });
  }
  function scopeReviewOpen() {
    return state.scopeReview?.kind === 'loading' || state.scopeReview?.kind === 'review';
  }
  function scopeCurrent(expected: AccountReplicationScope, owned: Handle) {
    const current = scope();
    return (
      current?.ownerId === expected.ownerId &&
      current.authGeneration === expected.authGeneration &&
      services === owned &&
      openedKey === state.workspaceKey &&
      !state.deletion
    );
  }
  function scopeFailure(error: unknown) {
    return error instanceof AccountReplicationError ? error.reason : failure(error);
  }
  function trackScopeWork(task: () => Promise<void>) {
    const work = task();
    scopeDrain = Promise.all([scopeDrain, work]).then(() => undefined);
    return work;
  }
  function scope(): AccountReplicationScope | null {
    return !retired &&
      state.identity &&
      state.workspace.kind === 'account' &&
      state.identity.ownerId === state.workspace.ownerId
      ? { ownerId: state.identity.ownerId, authGeneration: generation }
      : null;
  }
  function setIdentity(identity: AccountIdentity | null) {
    if (retired) return;
    if (identity?.ownerId === revokedOwner) identity = null;
    const changed = identity?.ownerId !== state.identity?.ownerId;
    if (changed) {
      generation++;
      stopSync();
      clearScopeReview();
      deletionReview = null;
    }
    const workspace: LocalWorkspace = identity
      ? { kind: 'account', ownerId: identity.ownerId }
      : state.workspace;
    publish({
      identity,
      workspace,
      workspaceKey: keyFor(workspace),
      checkingSession: false,
      ...(changed ? { sync: backend.localState(), deletion: null } : {}),
    });
    // A lost Auth session must not hide a durably journaled deletion or its status action.
    if (changed) void restoreDeletionView().catch((error) => publish({ error: failure(error) }));
    if (openedKey === state.workspaceKey && services) attachSync();
  }
  async function reconcileSession(expectedGeneration: number) {
    if (!options.auth) return;
    try {
      const current = await options.auth.readSession();
      if (!retired && generation === expectedGeneration) setIdentity(current?.identity ?? null);
    } catch {
      if (!retired && generation === expectedGeneration) setIdentity(null);
    }
  }
  async function refreshEarlierDeletions() {
    if (!options.deletion || retired) return;
    const expectedGeneration = generation;
    const expectedKey = state.workspaceKey;
    const sequence = ++earlierRefreshSequence;
    const rows = await options.deletion.journal.list();
    if (
      retired ||
      generation !== expectedGeneration ||
      state.workspaceKey !== expectedKey ||
      sequence !== earlierRefreshSequence
    )
      return;
    const displayedOwner = state.deletion
      ? state.workspace.kind === 'account'
        ? state.workspace.ownerId
        : deletionReview?.ownerId
      : null;
    const entries: EarlierDeletionState[] = [];
    for (const row of rows) {
      if (row.ownerId === displayedOwner) continue;
      const remembered = earlierResults.get(row.ownerId);
      const result = remembered?.operationId === row.operationId ? remembered : undefined;
      if (row.kind === 'confirmed' && !result) continue;
      entries.push(
        Object.freeze({
          ownerId: row.ownerId,
          operationId: row.operationId,
          status: row.kind === 'confirmed' ? 'deleted' : (result?.status ?? 'unconfirmed'),
        }),
      );
    }
    publish({ earlierDeletions: Object.freeze(entries) });
  }
  async function restoreDeletionView() {
    if (!options.deletion) return;
    const expectedKey = state.workspaceKey;
    const expectedGeneration = generation;
    const row =
      state.workspace.kind === 'account'
        ? await options.deletion.journal.read(state.workspace.ownerId)
        : ((await options.deletion.journal.list()).find((value) => value.kind === 'pending') ??
          null);
    if (retired || state.workspaceKey !== expectedKey || generation !== expectedGeneration) return;
    if (row?.kind === 'confirmed') {
      revokedOwner = row.ownerId;
      if (state.identity?.ownerId === row.ownerId) setIdentity(null);
      publish({ deletion: { kind: 'deleted' } });
    } else if (row) {
      deletionReview = { ...row, generation };
      publish({ deletion: { kind: 'unconfirmed' } });
    }
    await refreshEarlierDeletions();
  }
  async function acknowledgeDeletion(ownerId: string) {
    if (retired) return;
    revokedOwner = ownerId;
    if (state.identity?.ownerId === ownerId) setIdentity(null);
    try {
      const current = await options.auth?.readSession();
      if (retired) return;
      if (current?.identity.ownerId === ownerId) await options.auth?.signOut(ownerId);
    } catch {
      /* Persisted proof keeps this owner fenced even if session cleanup fails. */
    }
    await reconcileSession(generation);
    if (!retired && (!state.identity || state.identity.ownerId === ownerId))
      publish({ deletion: { kind: 'deleted' } });
  }
  function remoteOptions(expected: AccountReplicationScope): AccountRuntimeRemoteOptions {
    if (!options.auth || !options.config) throw new AccountAuthError('not_configured');
    return {
      endpoint: options.config.serviceEndpoint,
      publishableKey: options.config.publishableKey,
      ownerId: expected.ownerId,
      fetch: options.fetch,
      session: async () => {
        const current = await options.auth!.readSession();
        return current
          ? {
              ownerId: current.identity.ownerId,
              accessToken: current.accessToken,
              generation: expected.authGeneration,
            }
          : null;
      },
      isCurrent: (value) =>
        value.ownerId === scope()?.ownerId && value.generation === scope()?.authGeneration,
    };
  }
  function remote(expected: AccountReplicationScope) {
    return createAccountRemote(remoteOptions(expected));
  }
  async function attachSync() {
    const currentScope = scope();
    if (
      attaching ||
      sync ||
      !currentScope ||
      !services ||
      !backend.canSync(services) ||
      openedKey !== state.workspaceKey ||
      state.busy ||
      state.deletion ||
      scopeReviewOpen()
    )
      return;
    attaching = true;
    let finishAttaching!: () => void;
    attachingDrain = new Promise<void>((resolve) => {
      finishAttaching = resolve;
    });
    const sequence = attachSequence;
    const owned = services;
    let instance: AccountRuntimeConnection<SyncState, Action> | undefined;
    let stopState: (() => void) | undefined;
    let stopChanges: (() => void) | undefined;
    let installed = false;
    try {
      await restoreDeletionView();
      if (state.deletion) return;
      const pendingDelete = await options.metadata.read(
        `cookmate.account-deletion.${currentScope.ownerId}`,
      );
      if (
        scope()?.ownerId !== currentScope.ownerId ||
        scope()?.authGeneration !== currentScope.authGeneration ||
        openedKey !== state.workspaceKey ||
        services !== owned ||
        sequence !== attachSequence ||
        state.busy ||
        state.deletion ||
        scopeReviewOpen()
      )
        return;
      if (pendingDelete !== null) {
        publish({ deletion: { kind: 'unconfirmed' } });
        return;
      }
      const settings = options.settings(currentScope.ownerId);
      const isCurrent = () =>
        scopeCurrent(currentScope, owned) &&
        sequence === attachSequence &&
        !state.busy &&
        !scopeReviewOpen();
      await syncDrain;
      if (!isCurrent()) return;
      instance = await backend.connect({
        handle: owned,
        scope: currentScope,
        isCurrent,
        settings,
        enableExpandedScope: options.enableExpandedScope ?? false,
        remote: remoteOptions(currentScope),
        newId: options.newId,
      });
      if (!isCurrent()) throw new AccountAuthError('account_changed');
      const connected = instance;
      stopState = connected.subscribe(() => {
        if (sync !== connected || !scopeCurrent(currentScope, owned)) return;
        const next = connected.getSnapshot();
        publish({ sync: next });
        if (dirtyDuringSync && (next.kind === 'local' || next.kind === 'synced')) scheduleSync();
      });
      if (!isCurrent()) throw new AccountAuthError('account_changed');
      stopChanges = connected.subscribeLocalChanges(() => {
        if (sync !== connected || !scopeCurrent(currentScope, owned)) return;
        scheduleSync();
      });
      if (!isCurrent()) throw new AccountAuthError('account_changed');
      sync = connected;
      unsubscribeSync = stopState;
      unsubscribeChanges = stopChanges;
      installed = true;
      stopState = undefined;
      stopChanges = undefined;
      void connected.sync();
    } catch (error) {
      if (instance && (!installed || sync === instance)) {
        if (sync === instance) {
          sync = null;
          stopState = unsubscribeSync ?? undefined;
          stopChanges = unsubscribeChanges ?? undefined;
          unsubscribeSync = null;
          unsubscribeChanges = null;
        }
        try {
          await retireConnection(instance, [stopState, stopChanges]);
        } catch (cleanup) {
          error = cleanup;
        }
      }
      if (sequence === attachSequence && scopeCurrent(currentScope, owned))
        publish({ error: failure(error) });
    } finally {
      attaching = false;
      finishAttaching();
      if (sequence !== attachSequence && !retired) void attachSync();
    }
  }
  function scheduleSync() {
    if (
      !sync ||
      state.busy ||
      state.scopeReview ||
      state.sync.kind === 'failed' ||
      state.sync.kind === 'review'
    )
      return;
    dirtyDuringSync = true;
    if (state.sync.kind === 'working') return;
    if (timer) clearTimeout(timer);
    publish({ sync: backend.localState() });
    timer = setTimeout(() => {
      timer = null;
      if (!retired && !state.scopeReview && sync && sync.getSnapshot().kind !== 'working') {
        dirtyDuringSync = false;
        void sync.sync();
      }
    }, 2000);
  }
  const runtime = {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isWorkspaceCurrent(ownerId: string) {
      return !retired && state.workspace.kind === 'account' && state.workspace.ownerId === ownerId;
    },
    get closed() {
      return services === null;
    },
    async initialize() {
      publish({ startupSettled: false });
      try {
        await options.selection.initialize();
        const removal = await readRemoval();
        if (removal) {
          if (removal.phase === 'requested') {
            if (!options.auth) throw new Error('Account configuration required to finish sign-out');
            const session = await options.auth.readSession();
            if (session?.identity.ownerId === removal.ownerId) await options.auth.signOut();
            await saveRemoval(removal.ownerId, 'signed-out');
          }
          await finishRemoval(removal.ownerId);
        }
        const pending = options.selection.getSnapshot();
        if (pending.status === 'pending' && pending.manifest.pending?.kind === 'activate') {
          const workspace: LocalWorkspace = {
            kind: 'account',
            ownerId: pending.manifest.pending.ownerId,
          };
          publish({ workspace, workspaceKey: keyFor(workspace) });
        }
        await options.selection.recoverPending();
        const selected = options.selection.getSnapshot();
        if (selected.status !== 'ready') throw new Error();
        publish({
          phase: 'ready',
          workspace: selected.manifest.active,
          workspaceKey: keyFor(selected.manifest.active),
        });
        await restoreDeletionView();
        if (options.auth) {
          await runtime.foreground();
          if (retired) return;
          publish({ checkingSession: false });
          unsubscribeAuth = options.auth.subscribe((identity) => {
            if (earlierAuthNotification) earlierAuthNotification.latest = identity;
            else if (!state.busy) setIdentity(identity);
          });
        }
        publish({ startupSettled: true });
      } catch (error) {
        publish({
          ...(state.phase === 'starting' ? { phase: 'failed' } : {}),
          checkingSession: false,
          error: failure(error),
        });
      }
    },
    preferencesStore(): AppPreferencesStore {
      return state.workspace.kind === 'guest'
        ? options.guestPreferences
        : options.settings(state.workspace.ownerId).preferenceStore;
    },
    /** Captured by WorkspaceProvider with this committed workspace key. */
    opener(workspace: LocalWorkspace) {
      const expectedKey = keyFor(workspace);
      return (): Promise<AccountWorkspaceOpenResult<Handle>> => {
        let finishOpening!: () => void;
        opening = new Promise<void>((resolve) => {
          finishOpening = resolve;
        });
        const run = async (): Promise<AccountWorkspaceOpenResult<Handle>> => {
          try {
            await drainSync();
            await options.drainSettings();
            if (retired || state.workspaceKey !== expectedKey || !runtime.closed)
              throw new AccountAuthError('account_changed');
            if (removeOwner) {
              await finishRemoval(removeOwner);
              removeOwner = null;
            } else if (workspace.kind === 'account')
              await options.selection.activate(workspace.ownerId);
            else await options.selection.activateGuest();
            if (workspace.kind === 'account') {
              const settings = options.settings(workspace.ownerId);
              await settings.hydrate();
              if (settings.getSnapshot().kind !== 'ready') throw new Error();
            }
            const opened = await options.open(workspace, scope);
            if (opened.kind !== 'ready') return opened;
            const owned = opened.services;
            services = owned;
            openedKey = expectedKey;
            publish({});
            let confirmClosed!: () => void;
            let failClose!: (error: unknown) => void;
            storeClosed = new Promise<void>((resolve, reject) => {
              confirmClosed = resolve;
              failClose = reject;
            });
            void storeClosed.catch(() => undefined);
            const close = owned.close.bind(owned);
            const wrapped = {
              ...owned,
              async close() {
                try {
                  if (services === owned) openedKey = null;
                  clearScopeReview();
                  stopSync();
                  await drainSync();
                  await scopeDrain;
                  await close();
                  if (services === owned) {
                    services = null;
                    openedKey = null;
                    publish({});
                  }
                  confirmClosed();
                } catch (error) {
                  failClose(error);
                  throw error;
                }
              },
            };
            if (!retired && state.workspaceKey === expectedKey) attachSync();
            return { kind: 'ready', services: wrapped };
          } catch (error) {
            publish({ error: failure(error) });
            return {
              kind: 'failed',
              error: {
                code: 'storage_failure',
                messageKey: requiresWebStorageReload(error)
                  ? 'storage.web_restart_required'
                  : 'storage.open_failed',
                retry: requiresWebStorageReload(error) ? 'never' : 'after_correction',
              },
            };
          }
        };
        return run().finally(finishOpening);
      };
    },
    async signIn(provider: AccountProviderName, web: boolean): Promise<string | null> {
      if (!options.auth || state.busy) {
        publish({ error: 'not_configured' });
        return null;
      }
      generation++;
      stopSync();
      clearScopeReview();
      publish({ busy: true, error: null });
      try {
        if (await readRemoval())
          throw new Error('Finish the pending sign-out before another sign-in');
        if (web) return await options.auth.prepareWebSignIn(provider);
        const identity = await options.auth.signInNative(provider);
        revokedOwner = null;
        setIdentity(identity);
        return null;
      } catch (error) {
        publish({ error: failure(error) });
        return null;
      } finally {
        await reconcileSession(generation);
        await restoreDeletionView().catch((error) => publish({ error: failure(error) }));
        publish({ busy: false });
        attachSync();
      }
    },
    async completeCallback(href: string) {
      if (!options.auth || state.busy) return;
      generation++;
      stopSync();
      clearScopeReview();
      publish({ busy: true, error: null });
      try {
        if (await readRemoval())
          throw new Error('Finish the pending sign-out before another sign-in');
        const identity = await options.auth.completeWebSignIn(href);
        revokedOwner = null;
        setIdentity(identity);
      } catch (error) {
        publish({ error: failure(error) });
      } finally {
        await reconcileSession(generation);
        await restoreDeletionView().catch((error) => publish({ error: failure(error) }));
        publish({ busy: false });
        attachSync();
      }
    },
    async signOut(remove: boolean) {
      if (!options.auth || !state.identity || state.busy || state.workspace.kind !== 'account')
        return;
      const owner = state.identity.ownerId;
      publish({ busy: true, error: null });
      generation++;
      stopSync();
      clearScopeReview();
      try {
        await drainSync();
        if (remove) await saveRemoval(owner, 'requested');
        else await cancelUnexecutedRemoval(owner);
        await options.auth.signOut();
        if (remove) await saveRemoval(owner, 'signed-out');
        setIdentity(null);
        if (remove) {
          removeOwner = owner;
          publish({ workspace: { kind: 'guest' }, workspaceKey: 'guest' });
        }
      } catch (error) {
        publish({ error: failure(error) });
      } finally {
        await reconcileSession(generation);
        await restoreDeletionView().catch((error) => publish({ error: failure(error) }));
        publish({ busy: false });
      }
    },
    reviewSyncScope() {
      const current = scope();
      const owned = services;
      if (
        !current ||
        !owned ||
        !backend.canApprove(owned) ||
        !state.expandedScopeAvailable ||
        state.busy ||
        approvingScope
      )
        return Promise.resolve();
      const sequence = ++scopeSequence;
      scopeCapability = null;
      publish({ scopeReview: { kind: 'loading' } });
      stopSync();
      const isCurrent = () => sequence === scopeSequence && scopeCurrent(current, owned);
      return trackScopeWork(async () => {
        try {
          await drainSync();
          if (!isCurrent()) return;
          const review = await backend.reviewApproval(owned, current);
          if (!isCurrent()) return;
          scopeCapability = { scope: current, services: owned, review };
          publish({ scopeReview: { kind: 'review', review }, sync: backend.localState() });
        } catch (error) {
          if (!isCurrent()) return;
          const reason = scopeFailure(error);
          publish({ scopeReview: { kind: 'failed', reason } });
          // Recovery retains the original operation bytes; approval is retried only once settled.
          if (reason === 'operation_pending' || reason === 'settings_pending') void attachSync();
        }
      });
    },
    approveSyncScope(review: Review, historyIncluded: boolean) {
      const capability = scopeCapability;
      if (
        !capability ||
        review !== capability.review ||
        typeof historyIncluded !== 'boolean' ||
        state.busy ||
        approvingScope ||
        state.scopeReview?.kind !== 'review' ||
        state.scopeReview.review !== capability.review ||
        !scopeCurrent(capability.scope, capability.services)
      )
        return Promise.resolve();
      const sequence = ++scopeSequence;
      scopeCapability = null;
      approvingScope = true;
      publish({ scopeReview: { kind: 'loading' } });
      const isCurrent = () =>
        sequence === scopeSequence && scopeCurrent(capability.scope, capability.services);
      return trackScopeWork(async () => {
        try {
          await backend.approveScope(
            capability.services,
            capability.scope,
            capability.review,
            historyIncluded,
          );
          if (!isCurrent()) return;
          publish({ scopeReview: null, sync: backend.localState() });
          // The coordinator still requires its separate initial merge review before staging v2.
          void attachSync();
        } catch (error) {
          if (isCurrent())
            publish({ scopeReview: { kind: 'failed', reason: scopeFailure(error) } });
        } finally {
          if (sequence === scopeSequence) approvingScope = false;
        }
      });
    },
    cancelSyncScopeReview() {
      if (approvingScope || retired) return;
      clearScopeReview();
      void attachSync();
    },
    syncNow() {
      if (state.deletion || scopeReviewOpen()) return;
      if (!sync) attachSync();
      else void sync.sync();
    },
    async reviewDeletion() {
      if (!scope() || state.busy || !options.deletion) return;
      generation++;
      const current = scope()!;
      clearScopeReview();
      publish({ busy: true, error: null });
      stopSync();
      try {
        await drainSync();
        await scopeDrain;
        const retained = await options.deletion.journal.read(current.ownerId);
        if (scope()?.authGeneration !== current.authGeneration)
          throw new AccountAuthError('account_changed');
        if (retained) {
          if (retained.kind === 'confirmed') await acknowledgeDeletion(retained.ownerId);
          else {
            deletionReview = { ...retained, generation: current.authGeneration };
            publish({ deletion: { kind: 'unconfirmed' } });
          }
          return;
        }
        const key = `cookmate.account-deletion.${current.ownerId}`;
        const raw = await options.metadata.read(key);
        const pending: unknown = raw ? JSON.parse(raw) : null;
        if (pending !== null) {
          if (
            !pending ||
            typeof pending !== 'object' ||
            Object.keys(pending).sort().join(',') !== 'expectedRevision,operationId,ownerId' ||
            !('ownerId' in pending) ||
            pending.ownerId !== current.ownerId ||
            !('operationId' in pending) ||
            typeof pending.operationId !== 'string' ||
            pending.operationId.length !== 36 ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
              pending.operationId,
            ) ||
            !('expectedRevision' in pending) ||
            typeof pending.expectedRevision !== 'number' ||
            !Number.isSafeInteger(pending.expectedRevision) ||
            pending.expectedRevision < 0
          )
            throw new Error();
          deletionReview = {
            ownerId: current.ownerId,
            operationId: pending.operationId,
            expectedRevision: pending.expectedRevision,
            generation: current.authGeneration,
          };
          publish({ deletion: { kind: 'unconfirmed' } });
          return;
        }
        const saved = readDeletionState
          ? await readDeletionState(Object.freeze({ ...current }), remoteOptions(current))
          : await remote(current).read();
        if (
          !revision(saved.revision) ||
          (saved.deletionOperationId !== null &&
            (typeof saved.deletionOperationId !== 'string' ||
              saved.deletionOperationId.length !== 36 ||
              !uuid(saved.deletionOperationId)))
        )
          throw new AccountAuthError('provider');
        if (scope()?.authGeneration !== current.authGeneration)
          throw new AccountAuthError('account_changed');
        deletionReview = {
          ownerId: current.ownerId,
          expectedRevision: saved.revision,
          operationId: saved.deletionOperationId ?? options.newId(),
          generation: current.authGeneration,
        };
        publish({ deletion: { kind: saved.deletionOperationId ? 'unconfirmed' : 'review' } });
      } catch (error) {
        publish({ deletion: { kind: 'failed', reason: failure(error) } });
      } finally {
        publish({ busy: false });
      }
    },
    cancelDeletion() {
      if (
        state.busy ||
        state.deletion?.kind === 'unconfirmed' ||
        state.deletion?.kind === 'working'
      )
        return;
      deletionReview = null;
      publish({ deletion: null });
      void refreshEarlierDeletions().catch((error) => publish({ error: failure(error) }));
      attachSync();
    },
    async confirmDeletion() {
      const review = deletionReview;
      const current = scope();
      if (
        !review ||
        !options.deletion ||
        !current ||
        state.busy ||
        review.ownerId !== current.ownerId ||
        review.generation !== current.authGeneration
      )
        return;
      publish({ busy: true, deletion: { kind: 'working' } });
      let dispatched = false;
      let pendingRow: PendingDeletionRecovery | null = null;
      try {
        const retained = await options.deletion.journal.read(review.ownerId);
        if (
          retained &&
          (retained.operationId !== review.operationId ||
            retained.expectedRevision !== review.expectedRevision)
        )
          throw new AccountAuthError('account_changed');
        if (retained?.kind === 'confirmed') {
          await acknowledgeDeletion(retained.ownerId);
          return;
        }
        const row = await options.deletion.journal.putPending({
          ownerId: review.ownerId,
          operationId: review.operationId,
          expectedRevision: review.expectedRevision,
          recoveryToken:
            retained?.recoveryToken ?? review.recoveryToken ?? (await options.deletion.newToken()),
        });
        if (row.kind === 'confirmed') {
          await acknowledgeDeletion(row.ownerId);
          return;
        }
        deletionReview = { ...row, generation: review.generation };
        pendingRow = row;
        dispatched = true;
        const receipt = await remote(current).delete({
          operationId: row.operationId,
          expectedRevision: row.expectedRevision,
          recoveryToken: row.recoveryToken,
          confirmation: 'DELETE_COOKMATE_ACCOUNT',
        });
        // Commit proof before removing its secret or attempting SDK session cleanup.
        await options.deletion.journal.confirm(row, receipt);
        await acknowledgeDeletion(row.ownerId);
      } catch (error) {
        if (pendingRow && error instanceof AccountRemoteError && error.reason === 'needs_review') {
          // Only this correlated server response proves the exact operation was never admitted.
          // Unknown outcomes and operation_changed retain the recovery secret.
          try {
            await options.deletion.journal.rejectPending(pendingRow);
            earlierResults.delete(pendingRow.ownerId);
            deletionReview = null;
            publish({ deletion: { kind: 'failed', reason: 'needs_review' } });
            return;
          } catch {
            /* Keep the pending recovery UI if durable removal cannot be confirmed. */
          }
        }
        const reason =
          error &&
          typeof error === 'object' &&
          'reason' in error &&
          typeof error.reason === 'string'
            ? error.reason
            : failure(error);
        publish({ deletion: { kind: dispatched ? 'unconfirmed' : 'failed', reason } });
      } finally {
        await refreshEarlierDeletions().catch((error) => publish({ error: failure(error) }));
        publish({ busy: false });
      }
    },
    async checkDeletion() {
      const review = deletionReview;
      if (!options.deletion || state.busy || retired) return;
      if (!review?.recoveryToken) {
        // Older saved requests need an explicit authenticated review before a recovery token exists.
        // This action must never send a new deletion request.
        if (scope()) await runtime.reviewDeletion();
        else publish({ deletion: { kind: 'unconfirmed', reason: 'sign_in_required' } });
        return;
      }
      const observedGeneration = generation;
      const expectedKey = state.workspaceKey;
      publish({ busy: true, deletion: { kind: 'working' } });
      try {
        const pending: PendingDeletionRecovery = {
          kind: 'pending',
          ownerId: review.ownerId,
          operationId: review.operationId,
          expectedRevision: review.expectedRevision,
          recoveryToken: review.recoveryToken,
        };
        const status = await options.deletion.readStatus({
          operationId: pending.operationId,
          recoveryToken: pending.recoveryToken,
        });
        if (status.status === 'deleted') {
          await options.deletion.journal.confirm(pending, status);
          if (!retired && generation === observedGeneration && state.workspaceKey === expectedKey)
            await acknowledgeDeletion(pending.ownerId);
        } else if (
          !retired &&
          generation === observedGeneration &&
          state.workspaceKey === expectedKey
        )
          publish({ deletion: { kind: 'unconfirmed', reason: 'deletion_pending' } });
      } catch {
        if (!retired && generation === observedGeneration && state.workspaceKey === expectedKey)
          publish({ deletion: { kind: 'unconfirmed', reason: 'deletion_not_confirmed' } });
      } finally {
        await refreshEarlierDeletions().catch((error) => publish({ error: failure(error) }));
        publish({ busy: false });
      }
    },
    async checkEarlierDeletion(ownerId: string) {
      if (!options.deletion || state.busy || retired) return;
      const selected = state.earlierDeletions?.find((row) => row.ownerId === ownerId);
      if (!selected) return;
      const expectedGeneration = generation;
      const expectedKey = state.workspaceKey;
      const isCurrent = () =>
        !retired && generation === expectedGeneration && state.workspaceKey === expectedKey;
      // Status recovery needs no Auth session, but must not swallow session changes while busy.
      const authNotification: { latest?: AccountIdentity | null } = {};
      earlierAuthNotification = authNotification;
      publish({ busy: true });
      try {
        const row = await options.deletion.journal.read(ownerId);
        if (!isCurrent()) return;
        if (!row || row.operationId !== selected.operationId)
          throw new Error('Recovery record changed');
        if (row.kind === 'confirmed') {
          earlierResults.set(ownerId, { ...selected, status: 'deleted' });
          return;
        }
        const result = await options.deletion.readStatus({
          operationId: row.operationId,
          recoveryToken: row.recoveryToken,
        });
        if (result.status === 'deleted') await options.deletion.journal.confirm(row, result);
        if (isCurrent())
          earlierResults.set(ownerId, {
            ownerId,
            operationId: row.operationId,
            status: result.status === 'deleted' ? 'deleted' : 'pending',
          });
      } catch {
        if (isCurrent()) earlierResults.set(ownerId, { ...selected, status: 'unconfirmed' });
      } finally {
        try {
          if (isCurrent())
            await refreshEarlierDeletions().catch((error) => {
              if (isCurrent()) publish({ error: failure(error) });
            });
        } finally {
          if (earlierAuthNotification === authNotification) earlierAuthNotification = null;
          if (isCurrent()) {
            if (authNotification.latest !== undefined) setIdentity(authNotification.latest);
            publish({ busy: false });
          }
        }
      }
    },
    dispatch(action: Action) {
      return sync?.dispatch(action);
    },
    localSettingsChanged() {
      scheduleSync();
    },
    setAppActive(active: boolean) {
      if (!options.auth || retired) return Promise.resolve();
      refreshWork = refreshWork
        .then(async () => {
          if (retired) return;
          if (active) await options.auth!.startAutoRefresh();
          else await options.auth!.stopAutoRefresh();
        })
        .catch((error) => {
          if (!retired) publish({ error: failure(error) });
        });
      return refreshWork;
    },
    async foreground() {
      if (!options.auth || retired || state.busy) return;
      const observedGeneration = generation;
      let checkedOwner: string | null = null;
      const stillCurrent = () => !retired && !state.busy && observedGeneration === generation;
      try {
        const current = await options.auth.readSession();
        if (!stillCurrent()) return;
        checkedOwner = current?.identity.ownerId ?? null;
        if (current) await options.auth.verifyNativeAccess(current.identity);
        if (!stillCurrent()) return;
        setIdentity(current?.identity ?? null);
        runtime.syncNow();
      } catch (error) {
        if (!stillCurrent()) return;
        generation++;
        stopSync();
        clearScopeReview();
        if (error instanceof AccountAuthError && error.reason === 'session_expired') {
          revokedOwner = checkedOwner ?? state.identity?.ownerId ?? null;
          setIdentity(null);
          publish({ busy: true, error: failure(error), sync: backend.localState() });
          try {
            await options.auth.signOut();
          } catch {
            /* The owner remains fenced until a fresh sign-in. */
          }
          publish({ busy: false });
          return;
        }
        publish({ error: failure(error), sync: backend.localState() });
      }
    },
    async dispose() {
      retired = true;
      generation++;
      clearScopeReview();
      unsubscribeAuth?.();
      stopSync();
      listeners.clear();
      await drainSync();
      await scopeDrain;
      await opening;
      await storeClosed;
      await options.drainSettings();
      await refreshWork;
      await options.auth?.dispose();
    },
  };
  return runtime;
}

/** Existing callers retain the legacy service, review and action contracts. */
export function createAccountRuntime(options: AccountRuntimeOptions<LocalCookMateServices>) {
  const owned = createAccountRuntimeWithBackend({
    ...options,
    backend: createLegacyAccountRuntimeBackend(),
  });
  const { dispatch, ...runtime } = owned;
  // Spreading a getter would capture its value instead of the live close barrier.
  return {
    ...runtime,
    get closed() {
      return owned.closed;
    },
    select(choice: 'merge' | 'account') {
      void dispatch({ kind: 'select', choice });
    },
    resolve(id: string, choice: 'local' | 'account') {
      void dispatch({ kind: 'resolve', id, choice });
    },
    confirm() {
      void dispatch({ kind: 'confirm' });
    },
    cancelReview() {
      void dispatch({ kind: 'cancelReview' });
    },
  };
}
export type AccountRuntime = ReturnType<typeof createAccountRuntime>;
