import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { openCookMateStore } from '../../data/nativeStore';
import { runtimeClock } from '../workspace/runtimeClock';
import { appPreferencesStore } from '../app-preferences/preferenceStorage';
import { decodeAppPreferences } from '../app-preferences/preferences';
import {
  createLocalAccountSettings,
  localAccountSettingsKey,
  type LocalAccountSettingsController,
} from './localAccountSettings';
import { localAccountStorage } from './localAccountStorage';
import { createWorkspaceSelection, WORKSPACE_MANIFEST_STORAGE_KEY } from './workspaceSelection';
import { createWorkspaceDatabaseAdapter, verifyAccountWorkspace } from './workspaceDatabases';
import { readAccountAuthConfig } from './authConfig';
import { createSupabaseAccountAccess } from './supabaseAccess';
import { createAccountRuntime, type AccountRuntime } from './accountRuntime';
import { nativeAuthAvailability } from './nativeAuth';
import { accountCredentialStorage } from './credentialStorage';
import { createFirstRunWelcome, WELCOME_DECISION_KEY } from './firstRunWelcome';
import { createDeletionRecoveryJournal, createDeletionRecoveryTransport } from './deletionRecovery';
import {
  bundledPlanningPreferenceKey,
  createPlanningPreferenceOwners,
} from '../planning-preferences/planningPreferenceOwners';
import {
  bundledRecentlyViewedKey,
  createRecentlyViewedOwners,
} from '../recently-viewed/recentlyViewedOwners';

export async function createNativeAccountRuntime() {
  const config = readAccountAuthConfig();
  // Versioned rollout, not consent. Approval is still required before expanded capture/upload.
  // Keep off until the configured private service supports snapshot2 and its acceptance run.
  const enableExpandedScope = process.env.EXPO_PUBLIC_COOKMATE_PERSONAL_SYNC === '1';
  const welcome = await createFirstRunWelcome({
    async hasPriorEvidence() {
      const [decision, manifest, preferences] = await Promise.all([
        localAccountStorage.read(WELCOME_DECISION_KEY),
        localAccountStorage.read(WORKSPACE_MANIFEST_STORAGE_KEY),
        appPreferencesStore.read(),
      ]);
      return decision !== null || manifest !== null || preferences !== null;
    },
    saveDecision: () => localAccountStorage.write(WELCOME_DECISION_KEY, '1'),
  });
  let runtime!: AccountRuntime;
  let localStateClosed = false;
  const removingPrivateOwners = new Set<string>();
  const isLocalStateCurrent = (ownerId: string | null) => {
    const workspace = runtime.getSnapshot().workspace;
    return (
      !localStateClosed &&
      (ownerId === null || !removingPrivateOwners.has(ownerId)) &&
      (workspace.kind === 'guest' ? ownerId === null : workspace.ownerId === ownerId)
    );
  };
  const planning = createPlanningPreferenceOwners((ownerId) => {
    const key = bundledPlanningPreferenceKey(ownerId);
    return {
      read: () => localAccountStorage.read(key),
      write: (text) => localAccountStorage.write(key, text),
    };
  }, isLocalStateCurrent);
  const recentlyViewed = createRecentlyViewedOwners((ownerId) => {
    const key = bundledRecentlyViewedKey(ownerId);
    return {
      read: () => localAccountStorage.read(key),
      write: (text) => localAccountStorage.write(key, text),
    };
  }, isLocalStateCurrent);
  const settings = new Map<string, LocalAccountSettingsController>();
  const accountSettings = (ownerId: string) => {
    let controller = settings.get(ownerId);
    if (!controller) {
      controller = createLocalAccountSettings({
        ownerId,
        store: localAccountStorage,
        isCurrent: () => runtime.isWorkspaceCurrent(ownerId),
      });
      const subscribe = controller.subscribe;
      controller = { ...controller, preferenceStore: { ...controller.preferenceStore, subscribe } };
      controller.subscribe(() => runtime.localSettingsChanged());
      settings.set(ownerId, controller);
    }
    return controller;
  };
  const databases = createWorkspaceDatabaseAdapter({
    assertClosed() {
      if (!runtime.closed) throw new Error('Cooking workspace is still open');
    },
    async copyGuestPrivateState(ownerId) {
      const saved = decodeAppPreferences(await appPreferencesStore.read());
      if (!saved.ok) throw new Error('Original guest settings need recovery');
      const target = accountSettings(ownerId);
      await target.hydrate();
      const before = target.getSnapshot();
      if (before.kind !== 'ready') throw new Error('Account settings need recovery');
      if (
        !(await target.replaceOptions(
          { appPreferences: saved.preferences, profile: before.options.profile },
          before.options,
          () => runtime.isWorkspaceCurrent(ownerId),
        ))
      )
        throw new Error('Guest display settings could not be copied');
      if (Platform.OS === 'web') {
        const source = 'cookmate.preview.assistant-draft.v1';
        const dest = `${source}.${encodeURIComponent(`account:${ownerId}`)}`;
        const draft = window.sessionStorage.getItem(source);
        if (draft !== null && window.sessionStorage.getItem(dest) === null)
          window.sessionStorage.setItem(dest, draft);
      }
    },
    async removePrivateState(ownerId) {
      if (removingPrivateOwners.has(ownerId))
        throw new Error('Local account state is being removed');
      removingPrivateOwners.add(ownerId);
      try {
        await planning.remove(ownerId, () =>
          recentlyViewed.remove(ownerId, async () => {
            await settings.get(ownerId)?.drain();
            await localAccountStorage.remove(localAccountSettingsKey(ownerId));
            for (const key of [
              bundledPlanningPreferenceKey(ownerId),
              bundledRecentlyViewedKey(ownerId),
            ]) {
              try {
                await localAccountStorage.remove(key);
              } catch {
                /* Check an interrupted removal below. */
              }
              if ((await localAccountStorage.read(key)) !== null)
                throw new Error('Local preference removal was not confirmed');
            }
            if (Platform.OS === 'web') {
              window.sessionStorage.removeItem(
                `cookmate.preview.assistant-draft.v1.${encodeURIComponent(`account:${ownerId}`)}`,
              );
            } else {
              const suffix = `account.${ownerId}`;
              await SecureStore.deleteItemAsync(`cookmate.ai-sharing-consent.v1.${suffix}`);
              await SecureStore.deleteItemAsync(`cookmate.gateway.pairing.v1.${suffix}`);
            }
            settings.delete(ownerId);
          }),
        );
      } finally {
        removingPrivateOwners.delete(ownerId);
      }
    },
  });
  const selection = createWorkspaceSelection({
    storage: {
      read: () => localAccountStorage.read(WORKSPACE_MANIFEST_STORAGE_KEY),
      write: (value) => localAccountStorage.write(WORKSPACE_MANIFEST_STORAGE_KEY, value),
    },
    databases,
    assertClosed() {
      if (!runtime.closed) throw new Error('Cooking workspace is still open');
    },
  });
  const auth = config ? createSupabaseAccountAccess(config) : null;
  const deletionJournal = createDeletionRecoveryJournal(accountCredentialStorage, {
    now: runtimeClock.now,
  });
  const deletionTransport = config
    ? createDeletionRecoveryTransport({
        endpoint: `${config.url}/functions/v1/cookmate-account-deletion-status`,
        publishableKey: config.publishableKey,
        fetch: (input, init) =>
          expoFetch(typeof input === 'string' || input instanceof URL ? input : input.url, init),
      })
    : null;
  runtime = createAccountRuntime({
    enableExpandedScope,
    selection,
    auth,
    config,
    newId: Crypto.randomUUID,
    metadata: localAccountStorage,
    deletion: {
      journal: deletionJournal,
      async newToken() {
        const bytes = await Crypto.getRandomBytesAsync(32);
        return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      },
      readStatus: (input) => {
        if (!deletionTransport) throw new Error('Account service is not configured');
        return deletionTransport.readStatus(input);
      },
    },
    fetch: (input, init) =>
      expoFetch(typeof input === 'string' || input instanceof URL ? input : input.url, init),
    guestPreferences: appPreferencesStore,
    settings: accountSettings,
    drainSettings: async () => {
      await Promise.all([
        planning.drain(),
        recentlyViewed.drain(),
        ...[...settings.values()].map((value) => value.drain()),
      ]);
    },
    open: async (workspace, currentScope) => {
      if (workspace.kind === 'guest') {
        const opened = await openCookMateStore({
          ...runtimeClock,
          enableAccountHistory: enableExpandedScope,
        });
        if (opened.kind === 'ready') welcome.observeGuestStore(opened.initialization);
        return opened;
      }
      await verifyAccountWorkspace(workspace.ownerId);
      const settings = accountSettings(workspace.ownerId);
      return openCookMateStore({
        ...runtimeClock,
        enableAccountHistory: enableExpandedScope,
        databaseName: `cookmate-account-${workspace.ownerId}.db`,
        accountReplication: {
          enableExpandedScope,
          currentScope,
          getLocalSettings() {
            const current = settings.getSnapshot();
            if (current.kind !== 'ready') throw new Error('Account settings unavailable');
            return current.options;
          },
        },
      });
    },
  });
  let privateWorkspace = runtime.getSnapshot().workspaceKey;
  let privateIdentity = runtime.getSnapshot().identity?.ownerId ?? null;
  const stopPrivateState = runtime.subscribe(() => {
    const next = runtime.getSnapshot();
    const nextIdentity = next.identity?.ownerId ?? null;
    if (next.workspaceKey !== privateWorkspace || nextIdentity !== privateIdentity) {
      planning.retire();
      recentlyViewed.retire();
      privateWorkspace = next.workspaceKey;
      privateIdentity = nextIdentity;
    }
  });
  const availability = config
    ? Platform.OS === 'web'
      ? {
          apple: config.apple && window.isSecureContext,
          google: config.google && window.isSecureContext,
        }
      : await nativeAuthAvailability(config)
    : { apple: false, google: false };
  let closing: Promise<void> | undefined;
  const ownedRuntime: AccountRuntime = {
    ...runtime,
    get closed() {
      return runtime.closed;
    },
    dispose() {
      if (closing) return closing;
      localStateClosed = true;
      stopPrivateState();
      planning.retire();
      recentlyViewed.retire();
      // Publish the close promise before invoking a potentially reentrant platform close.
      closing = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        try {
          await runtime.dispose();
        } catch (error) {
          failures.push(error);
        }
        // Each private store must drain even if another store or database close fails.
        for (const owner of [planning, recentlyViewed]) {
          try {
            await owner.drain();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Account runtime cleanup failed.');
      });
      return closing;
    },
  };
  return {
    runtime: ownedRuntime,
    availability,
    configured: !!config,
    welcome,
    planningPreferences() {
      const workspace = runtime.getSnapshot().workspace;
      return planning.current(workspace.kind === 'guest' ? null : workspace.ownerId);
    },
    recentlyViewed() {
      const workspace = runtime.getSnapshot().workspace;
      return recentlyViewed.current(workspace.kind === 'guest' ? null : workspace.ownerId);
    },
  };
}
