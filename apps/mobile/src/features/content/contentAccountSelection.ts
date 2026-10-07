import {
  createWorkspaceSelection,
  type WorkspaceSelectionStorage,
} from '../account/workspaceSelection';
import {
  contentAccountWorkspaceNaming,
  createContentAccountWorkspaceAdapter,
  type ContentAccountWorkspacePorts,
} from './contentAccountWorkspaces';
import type {
  PrivateContentLifecycleController,
  PrivateContentOpeningLease,
} from './privateContentController';

/** Connect the existing selection journal to the configured controller's one resource lease.
 * Auth and review remain the caller's responsibility. Selection alone does not bind an account,
 * upload data, open an unreviewed clone, or authorize account deletion.
 */
export function createContentAccountSelection(options: {
  controller: Pick<PrivateContentLifecycleController, 'whileClosed' | 'duringOpening'>;
  storage: WorkspaceSelectionStorage;
  databases: Omit<ContentAccountWorkspacePorts, 'assertClosed'>;
}) {
  const whileClosed = options.controller.whileClosed.bind(options.controller);
  const duringOpening = options.controller.duringOpening.bind(options.controller);
  let admission: (() => void) | null = null;
  function assertClosed() {
    if (!admission) throw new Error('Configured account selection requires the closed workspace.');
    admission();
  }
  const databases = createContentAccountWorkspaceAdapter({ ...options.databases, assertClosed });
  const selection = createWorkspaceSelection({
    naming: contentAccountWorkspaceNaming(options.databases.config.installationId),
    storage: options.storage,
    databases,
    assertClosed,
  });
  function closed<Value>(work: () => Promise<Value>): Promise<Value> {
    return whileClosed(async (check) => {
      admission = check;
      try {
        return await work();
      } finally {
        admission = null;
      }
    });
  }
  return Object.freeze({
    getSnapshot: selection.getSnapshot,
    initialize: () => closed(selection.initialize),
    recoverPending: () => closed(selection.recoverPending),
    activateAccount: (ownerId: string) => closed(() => selection.activate(ownerId)),
    activateGuest: () => closed(selection.activateGuest),
    keepLocalCopy: (ownerId: string) => closed(() => selection.keepLocalCopy(ownerId)),
    removeLocalCopy: (ownerId: string) => closed(() => selection.removeLocalCopy(ownerId)),
    /** Preflight before opening, while the same lifecycle excludes all runtime handles. */
    verify: (ownerId: string) => closed(() => databases.verify(ownerId)),
    verifyDuringOpening: (ownerId: string, lease: PrivateContentOpeningLease) =>
      duringOpening(lease, async (check) => {
        if (admission) throw new Error('Account selection verification is already in use.');
        admission = check;
        try {
          return await databases.verify(ownerId);
        } finally {
          admission = null;
        }
      }),
  });
}
