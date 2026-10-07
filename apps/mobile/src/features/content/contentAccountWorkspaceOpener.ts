import type { AccountReplicationScope, AccountSnapshotOptions } from '@cookmate/account-sync';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { exact, revision, uuid } from '../../data/accountReplicationRecords';
import type { AccountRuntimeOptions } from '../account/accountRuntime';
import type { LocalWorkspace } from '../account/workspaceSelection';
import type { createContentAccountSelection } from './contentAccountSelection';
import type { ContentUpdateJournal } from './contentWorkspaceHost';
import {
  openContentAccountBootstrap,
  type ContentAccountBootstrapHandle,
} from './openContentAccountBootstrap';
import { ownPrivateContentConfiguration } from './privateContentConfig';
import type {
  PrivateContentLifecycleController,
  PrivateContentOpeningLease,
} from './privateContentController';
import {
  openPrivateContentRuntime,
  PrivateContentCleanupError,
  type PrivateContentRuntime,
  type PrivateContentRuntimeOptions,
} from './privateContentRuntime';

export type ContentAccountWorkspaceHandle =
  | ContentAccountBootstrapHandle
  | {
      readonly kind: 'content_workspace';
      readonly access: 'guest' | 'authenticated' | 'local';
      readonly runtime: PrivateContentRuntime;
      close(): Promise<void>;
    };

export interface ContentAccountWorkspaceOpenerOptions extends Omit<
  PrivateContentRuntimeOptions,
  'account' | 'localAccount' | 'journal'
> {
  controller: PrivateContentLifecycleController;
  selection: Pick<
    ReturnType<typeof createContentAccountSelection>,
    'verify' | 'verifyDuringOpening'
  >;
  catalogue: Readonly<CatalogueIdentity>;
  /** A local selection generation, never an invented replication auth generation. */
  selectionAccess(): Readonly<{ workspace: LocalWorkspace; workspaceGeneration: number }>;
  subscribeAccess(listener: () => void): () => void;
  verifyPreparedInClosedLease(
    ownerId: string,
    assertClosed: () => void,
  ): Promise<{ binding: string | null }>;
  journal(ownerId: string | null): ContentUpdateJournal;
  getLocalSettings(ownerId: string): AccountSnapshotOptions;
}

function ownWorkspace(value: unknown): LocalWorkspace {
  if (exact(value, ['kind']) && value.kind === 'guest') return Object.freeze({ kind: 'guest' });
  if (exact(value, ['kind', 'ownerId']) && value.kind === 'account' && uuid(value.ownerId))
    return Object.freeze({ kind: 'account', ownerId: value.ownerId });
  throw new Error('Invalid configured workspace selection.');
}
function ownScope(value: unknown): Readonly<AccountReplicationScope> | null {
  if (value === null) return null;
  if (
    exact(value, ['ownerId', 'authGeneration']) &&
    uuid(value.ownerId) &&
    revision(value.authGeneration)
  )
    return Object.freeze({ ownerId: value.ownerId, authGeneration: value.authGeneration });
  throw new Error('Invalid configured account access.');
}
function sameWorkspace(left: LocalWorkspace, right: LocalWorkspace) {
  return (
    left.kind === right.kind &&
    (left.kind === 'guest' || (right.kind === 'account' && left.ownerId === right.ownerId))
  );
}

/** Compose the existing lifecycle's one controller; construction performs no I/O.
 * Wire that controller's open callback to this object's openDuringLease before opening.
 * The supplied marker verifier must join the given closed lease, not reacquire it.
 */
export function createContentAccountWorkspaceOpener(options: ContentAccountWorkspaceOpenerOptions) {
  const config = ownPrivateContentConfiguration(options.config);
  const catalogue = Object.freeze({ ...options.catalogue });
  const controller = Object.freeze({
    open: options.controller.open.bind(options.controller),
    duringOpening: options.controller.duringOpening.bind(options.controller),
    whileClosed: options.controller.whileClosed.bind(options.controller),
  });
  const verify = options.selection.verify.bind(options.selection);
  const verifyDuringOpening = options.selection.verifyDuringOpening.bind(options.selection);
  const {
    selectionAccess,
    subscribeAccess,
    verifyPreparedInClosedLease,
    journal,
    getLocalSettings,
  } = options;
  const runtimePorts = Object.freeze({
    config,
    openConnection: options.openConnection,
    verification: options.verification,
    platform: Object.freeze({ newId: options.platform.newId, sha256: options.platform.sha256 }),
    now: options.now,
    dateContext: options.dateContext,
    fetch: options.fetch,
  });
  interface Request {
    workspace: LocalWorkspace;
    workspaceGeneration: number;
    scope: Readonly<AccountReplicationScope> | null;
    currentScope(): AccountReplicationScope | null;
    retired: boolean;
    openingAllowed: boolean;
    openingClaimed: boolean;
    stop?: () => void;
    resource?: { close(): Promise<void> };
    closing?: Promise<void>;
  }
  let active: Request | null = null;
  let blocked: PrivateContentCleanupError | null = null;
  function check(request: Request) {
    if (blocked) throw blocked;
    if (active !== request || request.retired)
      throw new Error('Configured workspace access changed.');
    const selected = selectionAccess();
    if (
      !exact(selected, ['workspace', 'workspaceGeneration']) ||
      !revision(selected.workspaceGeneration) ||
      selected.workspaceGeneration !== request.workspaceGeneration ||
      !sameWorkspace(ownWorkspace(selected.workspace), request.workspace)
    )
      throw new Error('Configured workspace selection changed.');
    const current = ownScope(request.currentScope());
    if (
      request.scope === null
        ? current !== null
        : current?.ownerId !== request.scope.ownerId ||
          current.authGeneration !== request.scope.authGeneration
    )
      throw new Error('Configured account access changed.');
  }
  function isCurrent(request: Request) {
    try {
      check(request);
      return true;
    } catch {
      return false;
    }
  }
  function close(request: Request): Promise<void> {
    request.retired = true;
    if (request.closing) return request.closing;
    const failures: unknown[] = [];
    try {
      request.stop?.();
    } catch (error) {
      failures.push(error);
    }
    delete request.stop;
    // Invoke close synchronously so retained ports retire before any asynchronous drain.
    let draining: Promise<void>;
    try {
      draining = request.resource?.close() ?? Promise.resolve();
    } catch (error) {
      draining = Promise.reject(error);
    }
    request.closing = draining
      .catch((error: unknown) => {
        failures.push(error);
      })
      .then(() => {
        if (failures.length) {
          blocked = new PrivateContentCleanupError(failures);
          throw blocked;
        }
        if (active === request) active = null;
      });
    return request.closing;
  }
  function retire(request: Request) {
    if (isCurrent(request)) return;
    request.retired = true;
    if (request.resource) void close(request).catch(() => undefined);
  }
  const open: AccountRuntimeOptions<ContentAccountWorkspaceHandle>['open'] = async (
    input,
    currentScope,
  ) => {
    if (blocked) throw blocked;
    if (active) throw new Error('Close the configured workspace before opening another.');
    const workspace = ownWorkspace(input),
      scope = ownScope(currentScope());
    if (scope && (workspace.kind !== 'account' || scope.ownerId !== workspace.ownerId))
      throw new Error('Configured account does not match the selected workspace.');
    const selected = selectionAccess();
    if (
      !exact(selected, ['workspace', 'workspaceGeneration']) ||
      !revision(selected.workspaceGeneration)
    )
      throw new Error('Invalid configured workspace generation.');
    const request: Request = {
      workspace,
      workspaceGeneration: selected.workspaceGeneration,
      scope,
      currentScope,
      retired: false,
      openingAllowed: false,
      openingClaimed: false,
    };
    active = request;
    try {
      check(request);
      request.stop = subscribeAccess(() => retire(request));
      check(request);
      let handle: ContentAccountWorkspaceHandle;
      const prepared = workspace.kind === 'account' ? await verify(workspace.ownerId) : null;
      check(request);
      if (workspace.kind === 'account' && prepared?.binding === null) {
        if (!scope) throw new Error('Sign in before reviewing an unbound account workspace.');
        const bootstrap = await openContentAccountBootstrap({
          controller,
          installationId: config.installationId,
          catalogue,
          scope,
          currentScope: () => {
            check(request);
            return scope;
          },
          verifyPrepared: async (assertClosed) => {
            check(request);
            const found = await verifyPreparedInClosedLease(workspace.ownerId, assertClosed);
            check(request);
            return found;
          },
          openConnection: runtimePorts.openConnection,
          getLocalSettings: () => {
            check(request);
            return getLocalSettings(workspace.ownerId);
          },
          now: runtimePorts.now,
          newId: runtimePorts.platform.newId,
          sha256: runtimePorts.platform.sha256,
        });
        request.resource = bootstrap;
        check(request);
        handle = Object.freeze({
          kind: 'account_bootstrap',
          services: bootstrap.services,
          close: () => close(request),
        });
      } else {
        if (workspace.kind === 'account' && prepared?.binding !== workspace.ownerId)
          throw new Error('Prepared account workspace binding changed.');
        request.openingAllowed = true;
        const runtime = await controller.open();
        request.resource = runtime;
        check(request);
        handle = Object.freeze({
          kind: 'content_workspace',
          access: workspace.kind === 'guest' ? 'guest' : scope ? 'authenticated' : 'local',
          runtime,
          close: () => close(request),
        });
      }
      check(request);
      return Object.freeze({ kind: 'ready', services: handle });
    } catch (error) {
      try {
        await close(request);
      } catch (cleanup) {
        throw new PrivateContentCleanupError([error, cleanup]);
      }
      throw error;
    }
  };
  async function openDuringLease(
    lease: PrivateContentOpeningLease,
  ): Promise<PrivateContentRuntime> {
    const request = active;
    if (!request || !request.openingAllowed || request.openingClaimed)
      throw new Error('No issued configured workspace opening.');
    check(request);
    request.openingClaimed = true;
    await controller.duringOpening(lease, async (assertOpening) => {
      assertOpening();
      check(request);
    });
    check(request);
    const ownerId = request.workspace.kind === 'account' ? request.workspace.ownerId : null;
    const verifyPrepared = async () => {
      check(request);
      if (!ownerId || (await verifyDuringOpening(ownerId, lease)).binding !== ownerId)
        throw new Error('Prepared account workspace binding changed.');
      check(request);
    };
    const runtime = await openPrivateContentRuntime({
      ...runtimePorts,
      journal: journal(ownerId),
      ...(ownerId && request.scope
        ? {
            account: {
              scope: request.scope,
              currentScope: () => (isCurrent(request) ? request.scope : null),
              subscribeAccess,
              verifyPrepared,
              getLocalSettings: () => {
                check(request);
                return getLocalSettings(ownerId);
              },
            },
          }
        : ownerId
          ? {
              localAccount: {
                ownerId,
                workspaceGeneration: request.workspaceGeneration,
                isCurrent: () => isCurrent(request),
                subscribeAccess,
                verifyPrepared,
              },
            }
          : {}),
    });
    try {
      check(request);
      return runtime;
    } catch (error) {
      try {
        await runtime.close();
      } catch (cleanup) {
        throw new PrivateContentCleanupError([error, cleanup]);
      }
      throw error;
    }
  }
  return Object.freeze({ open, openDuringLease });
}
