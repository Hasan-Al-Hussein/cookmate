import type { Immutable } from '@cookmate/domain';
import {
  createAccountContentCoordinator,
  type ContentSyncRemovalChoices,
  type ContentSyncState,
} from '../../../../../packages/account-sync/src/contentCoordinator';
import { createAccountContentRemote } from '../../../../../packages/account-sync/src/contentRemote';
import type { AccountContentScopeApprovalReview } from '../../data/accountContentScopeApproval';
import type {
  AccountRuntimeBackend,
  AccountRuntimeConnection,
} from '../account/accountRuntimeBackend';
import type { PrivateContentRuntime } from './privateContentRuntime';
import type { ContentAccountWorkspaceHandle } from './contentAccountWorkspaceOpener';

type Services = NonNullable<PrivateContentRuntime['host']['account']>;
type PushReview = Awaited<ReturnType<Services['journal']['reviewPush']>>;
type ApplyReview = Awaited<ReturnType<Services['apply']['review']>>;
export type ContentAccountRuntimeSyncState = ContentSyncState<PushReview, ApplyReview>;
export type ContentAccountRuntimeAction =
  | { kind: 'select'; choice: 'merge' | 'account' }
  | { kind: 'resolve'; id: string; choice: 'local' | 'account' }
  | { kind: 'confirm'; removals?: ContentSyncRemovalChoices }
  | { kind: 'cancelReview' };
export type ContentAccountRuntimeBackend = AccountRuntimeBackend<
  PrivateContentRuntime,
  ContentAccountRuntimeSyncState,
  Immutable<AccountContentScopeApprovalReview>,
  ContentAccountRuntimeAction
>;

/** Already-bound content facade connected to the existing auth/removal/deletion lifetime.
 * First binding remains the separately reviewed bootstrap; no legacy service casts are used.
 */
export function createContentAccountRuntimeBackend(): ContentAccountRuntimeBackend {
  return Object.freeze<ContentAccountRuntimeBackend>({
    localState: () => ({ kind: 'local' }),
    canSync: (runtime) => runtime.host.account !== null,
    canApprove: (runtime) => runtime.host.account !== null,
    async connect(input) {
      if (!input.enableExpandedScope)
        throw new Error('Configured content account synchronization is not enabled.');
      const { handle, scope, isCurrent, settings } = input;
      const services = handle.host.account;
      if (!services) throw new Error('Account services are not available in this local workspace.');
      const approval = await services.approval.read(scope);
      if (!isCurrent()) throw new Error('Account workspace changed.');
      const coordinator = createAccountContentCoordinator({
        scope,
        services,
        isCurrent,
        newId: input.newId,
        remote: createAccountContentRemote(input.remote),
        async projectSettings(pending, current) {
          const saved = settings.getSnapshot();
          if (
            saved.kind === 'ready' &&
            JSON.stringify(saved.options) === JSON.stringify(pending.projection)
          )
            return current();
          return settings.replaceOptions(pending.projection, pending.previous, current);
        },
      });
      return Object.freeze<
        AccountRuntimeConnection<ContentAccountRuntimeSyncState, ContentAccountRuntimeAction>
      >({
        getSnapshot: coordinator.getSnapshot,
        subscribe: coordinator.subscribe,
        sync: coordinator.sync,
        invalidate: coordinator.invalidate,
        subscribeLocalChanges(listener) {
          // This is the same store change stream used by the ordinary workspace adapter.
          return handle.host.readerStore.subscribe((change) => {
            if (!isCurrent()) return;
            if (change.kind === 'store') {
              if (change.value.collections.some((value) => value !== 'conversation')) listener();
            } else if (change.kind === 'personal') {
              if (
                approval &&
                (change.value.notes || change.value.collections || change.value.manualShopping)
              )
                listener();
            } else if (change.kind === 'cooking') {
              if (approval?.record.historyIncluded && change.value.historyChanged) listener();
            } else listener();
          });
        },
        dispatch(action) {
          switch (action.kind) {
            case 'select':
              return coordinator.select(action.choice);
            case 'resolve':
              return coordinator.resolve(action.id, action.choice);
            case 'confirm':
              return coordinator.confirm(action.removals);
            case 'cancelReview':
              return coordinator.cancelReview();
          }
        },
      });
    },
    async reviewApproval(handle, scope) {
      if (!handle.host.account) throw new Error('Account approval is unavailable.');
      return handle.host.account.approval.review(scope);
    },
    async approveScope(handle, scope, review, historyIncluded) {
      if (!handle.host.account) throw new Error('Account approval is unavailable.');
      await handle.host.account.approval.approve(scope, review, { historyIncluded });
    },
  });
}

/** Same account lifetime, with a separately reviewed first binding and a bound reopen barrier. */
export type ContentAccountLifecycleBackend = AccountRuntimeBackend<
  ContentAccountWorkspaceHandle,
  ContentAccountRuntimeSyncState,
  Immutable<AccountContentScopeApprovalReview>,
  ContentAccountRuntimeAction
>;
export function createContentAccountLifecycleBackend(): ContentAccountLifecycleBackend {
  const bound = createContentAccountRuntimeBackend();
  const services = (handle: ContentAccountWorkspaceHandle) =>
    handle.kind === 'account_bootstrap' ? handle.services : handle.runtime.host.account;
  return Object.freeze<ContentAccountLifecycleBackend>({
    localState: bound.localState,
    canSync: (handle: ContentAccountWorkspaceHandle) => services(handle) !== null,
    canApprove: (handle: ContentAccountWorkspaceHandle) => services(handle) !== null,
    async connect(input) {
      const { handle } = input;
      if (handle.kind === 'content_workspace')
        return bound.connect({ ...input, handle: handle.runtime });
      if (!input.enableExpandedScope)
        throw new Error('Configured content account synchronization is not enabled.');
      const remote = createAccountContentRemote(input.remote);
      const coordinator = createAccountContentCoordinator<
        Awaited<ReturnType<Services['capture']>>,
        PushReview,
        ApplyReview
      >({
        mode: 'bootstrap',
        services: handle.services,
        scope: input.scope,
        isCurrent: input.isCurrent,
        newId: input.newId,
        remote: { ownerId: remote.ownerId, read: remote.read },
      });
      return Object.freeze<
        AccountRuntimeConnection<ContentAccountRuntimeSyncState, ContentAccountRuntimeAction>
      >({
        getSnapshot: coordinator.getSnapshot,
        subscribe: coordinator.subscribe,
        sync: coordinator.sync,
        invalidate: coordinator.invalidate,
        // The clone is closed to ordinary writes until the reviewed binding is staged.
        subscribeLocalChanges: () => () => undefined,
        dispatch(action) {
          switch (action.kind) {
            case 'select':
              return coordinator.select(action.choice);
            case 'resolve':
              return coordinator.resolve(action.id, action.choice);
            case 'confirm':
              return coordinator.confirm(action.removals);
            case 'cancelReview':
              return coordinator.cancelReview();
          }
        },
      });
    },
    async reviewApproval(handle, scope) {
      const account = services(handle);
      if (!account) throw new Error('Account approval is unavailable.');
      return account.approval.review(scope);
    },
    async approveScope(handle, scope, review, historyIncluded) {
      const account = services(handle);
      if (!account) throw new Error('Account approval is unavailable.');
      await account.approval.approve(scope, review, { historyIncluded });
    },
  });
}
