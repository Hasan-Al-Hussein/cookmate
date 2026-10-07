import { DirectActionController, type ActionState } from '../workspace/directActionController';
import {
  DirectRecoveryController,
  type RecoveryState,
} from '../workspace/directRecoveryController';
import type { ContentWorkspaceHost, ContentWorkspaceState } from './contentWorkspaceHost';

export type OrdinaryContentHost = Pick<
  ContentWorkspaceHost,
  'commands' | 'queries' | 'getSnapshot' | 'subscribe' | 'readerStore'
>;
export type OrdinaryContentWorkspaceState =
  | { readonly kind: 'unavailable'; readonly status: ContentWorkspaceState['status'] | 'failed' }
  | {
      readonly kind: 'ready';
      readonly scopeKey: string;
      readonly actions: DirectActionController;
      readonly recovery: DirectRecoveryController;
      readonly actionState: ActionState;
      readonly recoveryState: RecoveryState;
      readonly refreshVersion: number;
      readonly queries: OrdinaryContentHost['queries'];
    };

/**
 * Ordinary UI action/read ports over the ONE content workspace owner. This is not
 * CookMateServices: it cannot open legacy storage or substitute packaged queries.
 */
export function createOrdinaryContentWorkspace(
  host: OrdinaryContentHost,
  options: { isCurrent?: () => boolean; getFocusScope?: () => (() => void) | null } = {},
) {
  const isCurrent = options.isCurrent ?? (() => true);
  const snapshot = host.getSnapshot.bind(host);
  const listeners = new Set<() => void>();
  let closed = false;
  let cleanupFailure: AggregateError | undefined;
  let state: OrdinaryContentWorkspaceState = Object.freeze({
    kind: 'unavailable',
    status: 'updating',
  });
  let scope:
    | {
        key: string;
        live: boolean;
        refreshVersion: number;
        actions: DirectActionController;
        recovery: DirectRecoveryController;
        queries: OrdinaryContentHost['queries'];
        detach: (() => void)[];
      }
    | undefined;
  let detachHost: (() => void) | undefined;
  let detachChanges: (() => void) | undefined;
  function notify() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* A subscriber cannot change saved state. */
      }
    }
  }
  function retire() {
    const prior = scope;
    scope = undefined;
    if (!prior) return;
    prior.live = false;
    const failures: unknown[] = [];
    for (const detach of [
      ...prior.detach,
      () => prior.actions.holdForAssistant(true),
      () => prior.actions.cancelReview(),
    ]) {
      try {
        detach();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Recipe UI retirement failed');
  }
  function change() {
    if (closed) return;
    const current = snapshot();
    if (!isCurrent() || current.status !== 'ready') {
      retire();
      state = Object.freeze({ kind: 'unavailable', status: current.status });
      notify();
      return;
    }
    if (scope?.key === current.scopeKey) return;
    retire();
    const key = current.scopeKey;
    const owns = () => {
      const latest = snapshot();
      return (
        !closed &&
        isCurrent() &&
        scope?.live === true &&
        scope.key === key &&
        latest.status === 'ready' &&
        latest.scopeKey === key
      );
    };
    function guarded<Args extends unknown[], Result>(
      operation: (...args: Args) => Promise<Result>,
      mutation = false,
    ) {
      return async (...args: Args): Promise<Result> => {
        if (!owns()) throw new Error('Recipe workspace changed');
        // Recovery may begin while a review or command preparation is awaited.
        // Recheck at each dispatch, not only when the UI started the action.
        if (mutation && scope?.actions.externallyHeld)
          throw new Error('Saved actions must be checked first');
        const result = await operation(...args);
        if (!owns()) throw new Error('Recipe workspace changed');
        return result;
      };
    }
    const commands = Object.freeze({
      reviewDirect: guarded(host.commands.reviewDirect.bind(host.commands)),
      prepareDirect: guarded(host.commands.prepareDirect.bind(host.commands), true),
      execute: guarded(host.commands.execute.bind(host.commands), true),
      acknowledgeDirectRecovery: guarded(
        host.commands.acknowledgeDirectRecovery.bind(host.commands),
      ),
    });
    const ports = Object.freeze({
      commands,
      queries: Object.freeze({
        readReceipt: guarded(host.commands.readReceipt.bind(host.commands)),
        readDirectRecovery: guarded(host.commands.readDirectRecovery.bind(host.commands)),
      }),
    });
    const publish = () => {
      if (!owns() || !scope) return;
      state = Object.freeze({
        kind: 'ready',
        scopeKey: key,
        actions: scope.actions,
        recovery: scope.recovery,
        actionState: scope.actions.state,
        recoveryState: scope.recovery.state,
        refreshVersion: scope.refreshVersion,
        queries: scope.queries,
      });
      notify();
    };
    const refresh = () => {
      if (owns() && scope) {
        scope.refreshVersion++;
        publish();
      }
    };
    const actions = new DirectActionController(
      ports,
      refresh,
      options.getFocusScope,
      undefined,
      undefined,
      () => {
        if (owns() && scope) void scope.recovery.check();
      },
    );
    const recovery = new DirectRecoveryController(ports, actions);
    scope = {
      key,
      live: true,
      refreshVersion: 0,
      actions,
      recovery,
      queries: Object.freeze({
        readPlan: guarded(host.queries.readPlan.bind(host.queries)),
        readShopping: guarded(host.queries.readShopping.bind(host.queries)),
        readFavourites: guarded(host.queries.readFavourites.bind(host.queries)),
      }),
      detach: [actions.subscribe(publish), recovery.subscribe(publish)],
    };
    publish();
    void recovery.check();
  }
  function close(status: 'closed' | 'failed' = 'closed', priorFailure?: unknown) {
    if (closed) {
      if (cleanupFailure) throw cleanupFailure;
      return;
    }
    closed = true;
    // No host.close(): the runtime, not this UI adapter, owns storage lifetime.
    const failures: unknown[] = priorFailure === undefined ? [] : [priorFailure];
    for (const detach of [detachHost, detachChanges, retire]) {
      try {
        detach?.();
      } catch (error) {
        failures.push(error);
      }
    }
    state = Object.freeze({ kind: 'unavailable', status });
    if (failures.length) cleanupFailure = new AggregateError(failures, 'Recipe UI cleanup failed');
    notify();
    listeners.clear();
    if (cleanupFailure) throw cleanupFailure;
  }
  try {
    detachHost = host.subscribe(() => {
      try {
        change();
      } catch (error) {
        try {
          close('failed', error);
        } catch {
          /* Failed retirement remains blocked in this adapter. */
        }
      }
    });
    if (!['closed', 'revoked'].includes(snapshot().status))
      detachChanges = host.readerStore.subscribe(() => {
        if (closed || !scope?.live || !isCurrent()) return;
        const current = snapshot();
        if (current.status !== 'ready' || current.scopeKey !== scope.key) return;
        scope.refreshVersion++;
        if (state.kind === 'ready') {
          state = Object.freeze({ ...state, refreshVersion: scope.refreshVersion });
          notify();
        }
      });
    change();
  } catch (error) {
    try {
      close();
    } catch (failure) {
      throw new AggregateError([error, failure], 'Recipe UI opening failed');
    }
    throw error;
  }
  return Object.freeze({
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => close(),
  });
}
