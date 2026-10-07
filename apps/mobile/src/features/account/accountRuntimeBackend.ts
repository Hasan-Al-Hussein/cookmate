import {
  createAccountRemote,
  createAccountSyncCoordinator,
  type AccountReplicationScope,
  type AccountSyncState,
} from '@cookmate/account-sync';
import type { Immutable, StoreInitializationResult } from '@cookmate/domain';
import type { AccountScopeApprovalReview } from '../../data/accountScopeApproval';
import type { LocalCookMateServices } from '../../data/localServices';
import type { LocalAccountSettingsController } from './localAccountSettings';

/** The account lifecycle owns a close barrier, not a particular cooking service facade. */
export interface AccountWorkspaceHandle {
  close(): Promise<void>;
}
export type AccountWorkspaceOpenResult<Handle extends AccountWorkspaceHandle> =
  | { kind: 'ready'; services: Handle; initialization?: 'created' | 'existing' }
  | Extract<StoreInitializationResult, { kind: 'failed' }>;

export interface AccountRuntimeSyncState {
  readonly kind: 'local' | 'working' | 'synced' | 'review' | 'failed';
}
export type AccountRuntimeRemoteOptions = Parameters<typeof createAccountRemote>[0];
export interface AccountRuntimeConnection<State extends AccountRuntimeSyncState, Action> {
  getSnapshot(): State;
  subscribe(listener: () => void): () => void;
  subscribeLocalChanges(listener: () => void): () => void;
  sync(): Promise<void>;
  dispatch(action: Action): void | Promise<void>;
  /** Retire callbacks synchronously; settle outstanding work before resolving. */
  invalidate(): Promise<void>;
}
export interface AccountRuntimeBackend<
  Handle extends AccountWorkspaceHandle,
  State extends AccountRuntimeSyncState,
  Review extends object,
  Action,
> {
  localState(): State;
  canSync(handle: Handle): boolean;
  canApprove(handle: Handle): boolean;
  connect(input: {
    handle: Handle;
    scope: Readonly<AccountReplicationScope>;
    isCurrent(): boolean;
    remote: AccountRuntimeRemoteOptions;
    settings: LocalAccountSettingsController;
    newId(): string;
    enableExpandedScope: boolean;
  }): Promise<AccountRuntimeConnection<State, Action>>;
  reviewApproval(handle: Handle, scope: AccountReplicationScope): Promise<Review>;
  approveScope(
    handle: Handle,
    scope: AccountReplicationScope,
    review: Review,
    historyIncluded: boolean,
  ): Promise<void>;
}

export type LegacyAccountRuntimeAction =
  | { kind: 'select'; choice: 'merge' | 'account' }
  | { kind: 'resolve'; id: string; choice: 'local' | 'account' }
  | { kind: 'confirm' }
  | { kind: 'cancelReview' };

/** Default adapter: retains the existing formats, subscriptions and approval protocol. */
export function createLegacyAccountRuntimeBackend(): AccountRuntimeBackend<
  LocalCookMateServices,
  AccountSyncState,
  Immutable<AccountScopeApprovalReview>,
  LegacyAccountRuntimeAction
> {
  return Object.freeze<
    AccountRuntimeBackend<
      LocalCookMateServices,
      AccountSyncState,
      Immutable<AccountScopeApprovalReview>,
      LegacyAccountRuntimeAction
    >
  >({
    localState: () => ({ kind: 'local' }),
    canSync: (handle) => !!handle.accountReplication,
    canApprove: (handle) => !!handle.accountReplication && !!handle.accountScopeApproval,
    async connect(input) {
      const { handle, scope, isCurrent, settings, enableExpandedScope } = input;
      const repository = handle.accountReplication;
      if (!repository) throw new Error('Account replication is unavailable');
      const approval =
        enableExpandedScope && handle.accountScopeApproval
          ? await handle.accountScopeApproval.read(scope)
          : null;
      if (!isCurrent()) throw new Error('Account workspace changed');
      const instance = createAccountSyncCoordinator({
        scope,
        isCurrent,
        repository,
        enableExpandedScope,
        remote: createAccountRemote(input.remote),
        newId: input.newId,
        projectSettings: async (pending, current) => {
          const saved = settings.getSnapshot();
          if (
            saved.kind === 'ready' &&
            JSON.stringify(saved.options) === JSON.stringify(pending.projection)
          )
            return current();
          return settings.replaceOptions(pending.projection, pending.previous, current);
        },
      });
      // A later subscription can throw before a combined disposer reaches the runtime.
      // Keep each acquired disposer owned by this connection until it is released.
      const changeStops = new Set<() => void>();
      function stopChanges(stops: Iterable<() => void>) {
        const failures: unknown[] = [];
        for (const stop of stops) {
          if (!changeStops.has(stop)) continue;
          try {
            stop();
            changeStops.delete(stop);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(failures, 'Account subscriptions cleanup failed');
      }
      return Object.freeze<AccountRuntimeConnection<AccountSyncState, LegacyAccountRuntimeAction>>({
        getSnapshot: instance.getSnapshot,
        subscribe: instance.subscribe,
        sync: instance.sync,
        async invalidate() {
          const failures: unknown[] = [];
          try {
            stopChanges(changeStops);
          } catch (error) {
            failures.push(error);
          }
          try {
            await instance.invalidate();
          } catch (error) {
            failures.push(error);
          }
          if (failures.length)
            throw new AggregateError(failures, 'Account connection cleanup failed');
        },
        subscribeLocalChanges(listener) {
          const stops: (() => void)[] = [];
          const retain = (stop: () => void) => {
            changeStops.add(stop);
            stops.push(stop);
          };
          retain(
            handle.queries.subscribe((change) => {
              if (change.collections.some((value) => value !== 'conversation')) listener();
            }),
          );
          if (approval) {
            if (handle.personal)
              retain(
                handle.personal.subscribe((change) => {
                  if (change.notes || change.collections || change.manualShopping) listener();
                }),
              );
            if (approval.record.historyIncluded && handle.cooking)
              retain(
                handle.cooking.subscribe((change) => {
                  if (change.historyChanged) listener();
                }),
              );
          }
          return () => stopChanges(stops);
        },
        dispatch(action) {
          switch (action.kind) {
            case 'select':
              return instance.select(action.choice);
            case 'resolve':
              return instance.resolve(action.id, action.choice);
            case 'confirm':
              return instance.confirm();
            case 'cancelReview':
              return instance.cancelReview();
          }
        },
      });
    },
    async reviewApproval(handle, scope) {
      if (!handle.accountScopeApproval) throw new Error('Account approval is unavailable');
      return handle.accountScopeApproval.review(scope);
    },
    async approveScope(handle, scope, review, historyIncluded) {
      if (!handle.accountScopeApproval) throw new Error('Account approval is unavailable');
      await handle.accountScopeApproval.approve(scope, review, { historyIncluded });
    },
  });
}
