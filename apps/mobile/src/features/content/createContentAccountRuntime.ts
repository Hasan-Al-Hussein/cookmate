import type { AccountReplicationScope } from '@cookmate/account-sync';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { exact, revision, uuid } from '../../data/accountReplicationRecords';
import {
  createAccountRuntimeWithBackend,
  type AccountRuntimeOptions,
} from '../account/accountRuntime';
import type { AccountWorkspaceOpenResult } from '../account/accountRuntimeBackend';
import {
  createLocalAccountSettings,
  localAccountSettingsKey,
  type LocalAccountSettingsController,
} from '../account/localAccountSettings';
import type { LocalWorkspace, WorkspaceSelection } from '../account/workspaceSelection';
import { decodeAppPreferences } from '../app-preferences/preferences';
import { createContentAccountLifecycleBackend } from './contentAccountRuntimeBackend';
import {
  createContentAccountWorkspaceOpener,
  type ContentAccountWorkspaceHandle,
} from './contentAccountWorkspaceOpener';
import { createContentAccountSelection } from './contentAccountSelection';
import {
  contentAccountManifestKey,
  createContentAccountWorkspaceAdapter,
  type ContentAccountWorkspacePorts,
} from './contentAccountWorkspaces';
import type { ContentUpdateJournal } from './contentWorkspaceHost';
import { createPrivateContentController } from './privateContentController';
import { ownPrivateContentConfiguration } from './privateContentConfig';
import { preparePrivateContentWorkspace } from './preparePrivateContentWorkspace';
import type { PrivateContentRuntimeOptions } from './privateContentRuntime';
import { createPlanningPreferenceOwners } from '../planning-preferences/planningPreferenceOwners';
import type { PlanningPreferencesStore } from '../planning-preferences/planningPreferences';
import { createRecentlyViewedOwners } from '../recently-viewed/recentlyViewedOwners';
import type { RecentlyViewedStore } from '../recently-viewed/recentlyViewed';

type LifecycleOptions = AccountRuntimeOptions<ContentAccountWorkspaceHandle>;
type Deletion = NonNullable<LifecycleOptions['deletion']>;
export interface ContentAccountRuntimeOptions {
  workspace: Omit<PrivateContentRuntimeOptions, 'account' | 'localAccount' | 'journal'> & {
    catalogue: Readonly<CatalogueIdentity>;
    journal(ownerId: string | null): ContentUpdateJournal;
  };
  databases: Pick<
    ContentAccountWorkspacePorts,
    'assertGuestRecoverySettled' | 'cloneGuestWithMarker' | 'deleteDatabase'
  > & {
    /** Copies only the guest draft, never receipt/recovery references or authentication. */
    copyGuestDraft(ownerId: string): Promise<void>;
    removeOwnerPrivateState(ownerId: string): Promise<void>;
  };
  /** Already installation-partitioned metadata, shared with the supplied auth/deletion setup. */
  metadata: LifecycleOptions['metadata'];
  guestPreferences: LifecycleOptions['guestPreferences'];
  planningStore(ownerId: string | null): PlanningPreferencesStore;
  recentlyViewedStore(ownerId: string | null): RecentlyViewedStore;
  auth: LifecycleOptions['auth'];
  accountConfig: LifecycleOptions['config'];
  accountFetch: LifecycleOptions['fetch'];
  enableContentSync: boolean;
  /** Content-capable revision reader is explicit; never reuse the legacy snapshot parser. */
  deletion?: Deletion & Required<Pick<Deletion, 'readState'>>;
}

export interface ContentAccountViewSnapshot {
  readonly workspace: LocalWorkspace;
  /** Only selected workspace or identity-owner changes advance this local fence. */
  readonly workspaceGeneration: number;
  /** Also advances for same-owner auth renewal. Key the UI's wrapped handle by this value. */
  readonly viewGeneration: number;
}
function ownWorkspace(value: LocalWorkspace): LocalWorkspace {
  if (exact(value, ['kind']) && value.kind === 'guest') return Object.freeze({ kind: 'guest' });
  if (exact(value, ['kind', 'ownerId']) && value.kind === 'account' && uuid(value.ownerId))
    return Object.freeze({ kind: 'account', ownerId: value.ownerId });
  throw new Error('Invalid configured workspace.');
}
function scopeKey(value: AccountReplicationScope | null) {
  if (value === null) return 'local';
  if (
    !exact(value, ['ownerId', 'authGeneration']) ||
    !uuid(value.ownerId) ||
    !revision(value.authGeneration)
  )
    throw new Error('Invalid configured account access.');
  return `${value.ownerId}:${value.authGeneration}`;
}

/** Environment-neutral configured root. Construct only after the previous root has fully
 * closed: this owns the single controller, selection and settings authority for this lifetime.
 * It performs no I/O until prepare/initialize/open is explicitly requested.
 */
export function createContentAccountRuntime(options: ContentAccountRuntimeOptions) {
  const supplied = options.workspace;
  const config = ownPrivateContentConfiguration(supplied.config);
  const workspacePorts = Object.freeze({
    config,
    catalogue: Object.freeze({ ...supplied.catalogue }),
    platform: Object.freeze({ newId: supplied.platform.newId, sha256: supplied.platform.sha256 }),
    openConnection: supplied.openConnection,
    verification: supplied.verification,
    journal: supplied.journal,
    now: supplied.now,
    dateContext: supplied.dateContext,
    fetch: supplied.fetch,
  });
  const metadata = Object.freeze({
    read: options.metadata.read.bind(options.metadata),
    write: options.metadata.write.bind(options.metadata),
    remove: options.metadata.remove.bind(options.metadata),
  });
  const guestPreferences = Object.freeze({
    read: options.guestPreferences.read.bind(options.guestPreferences),
    write: options.guestPreferences.write.bind(options.guestPreferences),
    ...(options.guestPreferences.subscribe
      ? { subscribe: options.guestPreferences.subscribe.bind(options.guestPreferences) }
      : {}),
  });
  const databasePorts = Object.freeze({
    assertGuestRecoverySettled: options.databases.assertGuestRecoverySettled.bind(
      options.databases,
    ),
    cloneGuestWithMarker: options.databases.cloneGuestWithMarker.bind(options.databases),
    deleteDatabase: options.databases.deleteDatabase.bind(options.databases),
    copyGuestDraft: options.databases.copyGuestDraft.bind(options.databases),
    removeOwnerPrivateState: options.databases.removeOwnerPrivateState.bind(options.databases),
  });
  const suppliedAuth = options.auth;
  const closeAuth = suppliedAuth?.dispose.bind(suppliedAuth);
  let authClosing: Promise<void> | undefined;
  function disposeAuth() {
    if (authClosing) return authClosing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    authClosing = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    try {
      void Promise.resolve(closeAuth?.()).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return authClosing;
  }
  const auth = suppliedAuth
    ? Object.freeze({
        readSession: suppliedAuth.readSession.bind(suppliedAuth),
        subscribe: suppliedAuth.subscribe.bind(suppliedAuth),
        signInNative: suppliedAuth.signInNative.bind(suppliedAuth),
        prepareWebSignIn: suppliedAuth.prepareWebSignIn.bind(suppliedAuth),
        completeWebSignIn: suppliedAuth.completeWebSignIn.bind(suppliedAuth),
        signOut: suppliedAuth.signOut.bind(suppliedAuth),
        verifyNativeAccess: suppliedAuth.verifyNativeAccess.bind(suppliedAuth),
        startAutoRefresh: suppliedAuth.startAutoRefresh.bind(suppliedAuth),
        stopAutoRefresh: suppliedAuth.stopAutoRefresh.bind(suppliedAuth),
        dispose: disposeAuth,
      })
    : null;
  const accountConfig = options.accountConfig ? Object.freeze({ ...options.accountConfig }) : null;
  const accountFetch = options.accountFetch,
    enableContentSync = options.enableContentSync;
  const deletion = options.deletion
    ? Object.freeze({
        journal: Object.freeze({
          read: options.deletion.journal.read.bind(options.deletion.journal),
          list: options.deletion.journal.list.bind(options.deletion.journal),
          putPending: options.deletion.journal.putPending.bind(options.deletion.journal),
          rejectPending: options.deletion.journal.rejectPending.bind(options.deletion.journal),
          confirm: options.deletion.journal.confirm.bind(options.deletion.journal),
        }),
        newToken: options.deletion.newToken.bind(options.deletion),
        readStatus: options.deletion.readStatus.bind(options.deletion),
        readState: options.deletion.readState.bind(options.deletion),
      })
    : undefined;
  let retired = false;
  let workspaceGeneration = 1,
    viewGeneration = 1;
  let selectedKey = 'guest',
    identityOwner: string | null = null;
  let currentScope: (() => AccountReplicationScope | null) | null = null;
  let capturedScopeKey = 'local';
  let view: Readonly<ContentAccountViewSnapshot> = Object.freeze({
    workspace: Object.freeze({ kind: 'guest' }),
    workspaceGeneration,
    viewGeneration,
  });
  const accessListeners = new Set<() => void>(),
    viewListeners = new Set<() => void>();
  type Settings = { controller: LocalAccountSettingsController; stop(): void };
  const settingsByOwner = new Map<string, Settings>();
  const drainingSettings = new Set<Promise<void>>();
  let settingsFailure: unknown;
  let lifecycle!: ReturnType<typeof buildLifecycle>;
  let opener!: ReturnType<typeof createContentAccountWorkspaceOpener>;
  const removingPrivateOwners = new Set<string>();
  const isLocalStateCurrent = (ownerId: string | null) =>
    !retired &&
    (ownerId === null || !removingPrivateOwners.has(ownerId)) &&
    (view.workspace.kind === 'guest' ? ownerId === null : view.workspace.ownerId === ownerId);
  const planning = createPlanningPreferenceOwners(
    options.planningStore.bind(options),
    isLocalStateCurrent,
  );
  const recentlyViewed = createRecentlyViewedOwners(
    options.recentlyViewedStore.bind(options),
    isLocalStateCurrent,
  );
  function check() {
    if (retired) throw new Error('Configured account runtime is closed.');
  }
  function trackSettings(value: Settings) {
    value.stop();
    const work = value.controller.drain().catch((error: unknown) => {
      settingsFailure = error;
    });
    drainingSettings.add(work);
    void work.finally(() => drainingSettings.delete(work));
  }
  function retireSettings() {
    planning.retire();
    recentlyViewed.retire();
    for (const value of settingsByOwner.values()) trackSettings(value);
    settingsByOwner.clear();
  }
  function settings(ownerId: string): LocalAccountSettingsController {
    check();
    localAccountSettingsKey(ownerId);
    const existing = settingsByOwner.get(ownerId);
    if (existing) return existing.controller;
    const generation = workspaceGeneration;
    const original = createLocalAccountSettings({
      ownerId,
      store: metadata,
      isCurrent: () =>
        !retired && workspaceGeneration === generation && lifecycle.isWorkspaceCurrent(ownerId),
    });
    const controller = Object.freeze({
      ...original,
      preferenceStore: Object.freeze({
        ...original.preferenceStore,
        subscribe: original.subscribe,
      }),
    });
    const stop = controller.subscribe(() => {
      if (!retired && workspaceGeneration === generation) lifecycle.localSettingsChanged();
    });
    settingsByOwner.set(ownerId, { controller, stop });
    return controller;
  }
  async function drainSettings() {
    await Promise.all([
      planning.drain(),
      recentlyViewed.drain(),
      ...drainingSettings,
      ...[...settingsByOwner.values()].map((value) => value.controller.drain()),
    ]);
    if (settingsFailure) throw settingsFailure;
  }
  const controller = createPrivateContentController({
    prepare: () => preparePrivateContentWorkspace(workspacePorts),
    open: (lease) => opener.openDuringLease(lease),
  });
  const databases: Omit<ContentAccountWorkspacePorts, 'assertClosed'> = {
    ...workspacePorts,
    assertGuestRecoverySettled: databasePorts.assertGuestRecoverySettled,
    cloneGuestWithMarker: databasePorts.cloneGuestWithMarker,
    deleteDatabase: databasePorts.deleteDatabase,
    async copyGuestPrivateState(ownerId) {
      check();
      const generation = workspaceGeneration;
      const current = () =>
        !retired && generation === workspaceGeneration && lifecycle.isWorkspaceCurrent(ownerId);
      const saved = decodeAppPreferences(await guestPreferences.read());
      if (!current() || !saved.ok) throw new Error('Original guest settings need recovery.');
      const target = settings(ownerId);
      await target.hydrate();
      const before = target.getSnapshot();
      if (!current() || before.kind !== 'ready') throw new Error('Account settings need recovery.');
      if (
        !(await target.replaceOptions(
          { appPreferences: saved.preferences, profile: before.options.profile },
          before.options,
          current,
        ))
      )
        throw new Error('Guest display settings could not be copied.');
      if (!current()) throw new Error('Configured account changed.');
      await databasePorts.copyGuestDraft(ownerId);
      if (!current()) throw new Error('Configured account changed.');
    },
    async removePrivateState(ownerId) {
      check();
      if (removingPrivateOwners.has(ownerId))
        throw new Error('Local account state is being removed');
      removingPrivateOwners.add(ownerId);
      try {
        await planning.remove(ownerId, () =>
          recentlyViewed.remove(ownerId, async () => {
            const selected = settingsByOwner.get(ownerId);
            if (selected) {
              settingsByOwner.delete(ownerId);
              trackSettings(selected);
            }
            await drainSettings();
            check();
            await metadata.remove(localAccountSettingsKey(ownerId));
            check();
            await databasePorts.removeOwnerPrivateState(ownerId);
            check();
          }),
        );
      } finally {
        removingPrivateOwners.delete(ownerId);
      }
    },
  };
  const manifestKey = contentAccountManifestKey(config.installationId);
  const selection = createContentAccountSelection({
    controller,
    databases,
    storage: {
      read: () => metadata.read(manifestKey),
      write: (value) => metadata.write(manifestKey, value),
    },
  });
  const legacySelection: WorkspaceSelection = { ...selection, activate: selection.activateAccount };
  opener = createContentAccountWorkspaceOpener({
    ...workspacePorts,
    controller,
    selection,
    selectionAccess: () => {
      check();
      return { workspace: view.workspace, workspaceGeneration };
    },
    subscribeAccess(listener) {
      check();
      accessListeners.add(listener);
      return () => {
        accessListeners.delete(listener);
      };
    },
    verifyPreparedInClosedLease: (ownerId, assertClosed) =>
      createContentAccountWorkspaceAdapter({ ...databases, assertClosed }).verify(ownerId),
    getLocalSettings(ownerId) {
      const value = settings(ownerId).getSnapshot();
      if (value.kind !== 'ready') throw new Error('Account settings unavailable.');
      return value.options;
    },
  });
  function buildLifecycle() {
    return createAccountRuntimeWithBackend({
      selection: legacySelection,
      auth,
      config: accountConfig,
      enableExpandedScope: enableContentSync,
      newId: workspacePorts.platform.newId,
      fetch: accountFetch,
      metadata,
      guestPreferences,
      settings,
      drainSettings,
      ...(deletion ? { deletion } : {}),
      backend: createContentAccountLifecycleBackend(),
      open(workspace, scope) {
        check();
        currentScope = scope;
        capturedScopeKey = scopeKey(scope());
        return opener.open(workspace, scope);
      },
    });
  }
  lifecycle = buildLifecycle();
  function notifyAccess() {
    for (const listener of [...accessListeners]) {
      try {
        listener();
      } catch {
        /* An observer must not prevent the remaining owners retiring. */
      }
    }
  }
  function notifyView() {
    for (const listener of [...viewListeners]) {
      try {
        listener();
      } catch {
        /* The access fence is already changed. */
      }
    }
  }
  function updateView() {
    if (retired) return;
    const state = lifecycle.getSnapshot();
    const nextOwner = state.identity?.ownerId ?? null;
    const localChanged = state.workspaceKey !== selectedKey || nextOwner !== identityOwner;
    const nextScope = currentScope ? scopeKey(currentScope()) : 'local';
    const accessChanged = nextScope !== capturedScopeKey;
    if (localChanged) {
      workspaceGeneration++;
      selectedKey = state.workspaceKey;
      identityOwner = nextOwner;
      retireSettings();
    }
    capturedScopeKey = nextScope;
    if (localChanged || accessChanged) {
      viewGeneration++;
      view = Object.freeze({
        workspace: ownWorkspace(state.workspace),
        workspaceGeneration,
        viewGeneration,
      });
    }
    // Even an otherwise identical publication may represent a changed true auth generation.
    notifyAccess();
    if (localChanged || accessChanged) notifyView();
  }
  const stopLifecycle = lifecycle.subscribe(updateView);
  const handles = new Set<ContentAccountWorkspaceHandle>();
  const openings = new Set<Promise<AccountWorkspaceOpenResult<ContentAccountWorkspaceHandle>>>();
  const failedOpen = (): AccountWorkspaceOpenResult<ContentAccountWorkspaceHandle> => ({
    kind: 'failed',
    error: {
      code: 'storage_failure',
      messageKey: 'storage.open_failed',
      retry: 'after_correction',
    },
  });
  function ordinaryOpener(input: LocalWorkspace) {
    check();
    const workspace = ownWorkspace(input);
    const open = lifecycle.opener(workspace);
    return () => {
      check();
      const generation = viewGeneration;
      const work = open().then(async (result) => {
        if (result.kind !== 'ready') return result;
        const handle = result.services;
        if (retired || generation !== viewGeneration) {
          await handle.close();
          return failedOpen();
        }
        handles.add(handle);
        let closing: Promise<void> | undefined;
        const wrapped = Object.freeze({
          ...handle,
          close() {
            if (!closing)
              closing = handle.close().then(() => {
                handles.delete(handle);
              });
            return closing;
          },
        });
        return { ...result, services: wrapped };
      });
      openings.add(work);
      void work.then(
        () => openings.delete(work),
        () => openings.delete(work),
      );
      return work;
    };
  }
  let disposing: Promise<void> | undefined;
  function dispose() {
    if (disposing) return disposing;
    // Publish the one owned close promise before synchronous retirement observers can reenter.
    let resolve!: () => void, reject!: (error: unknown) => void;
    disposing = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    retired = true;
    planning.retire();
    recentlyViewed.retire();
    viewGeneration++;
    view = Object.freeze({ ...view, viewGeneration });
    notifyAccess();
    notifyView();
    stopLifecycle();
    void (async () => {
      const failures: unknown[] = [];
      for (const work of openings)
        try {
          await work;
        } catch (error) {
          failures.push(error);
        }
      for (const handle of handles)
        try {
          await handle.close();
          handles.delete(handle);
        } catch (error) {
          failures.push(error);
        }
      try {
        await lifecycle.dispose();
      } catch (error) {
        failures.push(error);
      }
      // A rejected SQLite close can stop generic disposal before it reaches Auth cleanup.
      // This is the same memoized port passed to that lifecycle, never a competing disposal.
      try {
        await disposeAuth();
      } catch (error) {
        failures.push(error);
      }
      retireSettings();
      try {
        await drainSettings();
      } catch (error) {
        failures.push(error);
      }
      accessListeners.clear();
      viewListeners.clear();
      if (failures.length)
        throw new AggregateError(failures, 'Configured account runtime cleanup failed.');
    })().then(resolve, reject);
    return disposing;
  }
  const runtime = Object.freeze({
    ...lifecycle,
    get closed() {
      return lifecycle.closed;
    },
    opener: ordinaryOpener,
    dispose,
  });
  return Object.freeze({
    runtime,
    settings,
    planningPreferences() {
      check();
      return planning.current(view.workspace.kind === 'guest' ? null : view.workspace.ownerId);
    },
    recentlyViewed() {
      check();
      return recentlyViewed.current(
        view.workspace.kind === 'guest' ? null : view.workspace.ownerId,
      );
    },
    opener: ordinaryOpener,
    prepare() {
      check();
      return controller.prepare();
    },
    selection: Object.freeze({ getSnapshot: selection.getSnapshot }),
    view: Object.freeze({
      getSnapshot: () => view,
      subscribe(listener: () => void) {
        check();
        viewListeners.add(listener);
        return () => {
          viewListeners.delete(listener);
        };
      },
    }),
  });
}

export type ContentAccountRuntime = ReturnType<typeof createContentAccountRuntime>;
