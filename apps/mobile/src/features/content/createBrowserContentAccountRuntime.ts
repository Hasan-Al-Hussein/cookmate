import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { catalogue } from '@cookmate/catalogue';
import { createAccountContentRemote } from '../../../../../packages/account-sync/src/contentRemote';
import { nativeCommandPlatform } from '../../domain/commandPlatform';
import { runtimeClock } from '../workspace/runtimeClock';
import { appPreferencesStoreForContent } from '../app-preferences/preferenceStorage';
import { localAccountStorage } from '../account/localAccountStorage';
import { accountCredentialStorage } from '../account/credentialStorage';
import { readAccountAuthConfig } from '../account/authConfig';
import { createSupabaseAccountAccess } from '../account/supabaseAccess';
import {
  createDeletionRecoveryJournal,
  createDeletionRecoveryTransport,
} from '../account/deletionRecovery';
import {
  ownPrivateContentConfiguration,
  type PrivateContentConfiguration,
} from './privateContentConfig';
import { createContentAccountRuntime } from './createContentAccountRuntime';
import { createContentAccountNativeStorage } from './contentAccountNativeStorage';
import { createContentAccountPrivateStorage } from './contentAccountPrivateStorage';
import { createContentPrivateState } from './contentPrivateState';
import { createContentVerificationPorts } from './contentVerification';
import { localContentUpdateJournal } from './localContentUpdateJournal';
import { assertContentGuestRecoverySettled } from './contentGuestRecovery';
import { removeContentAccountPrivateState } from './contentAccountPrivateCleanup';

/** One configured web root. The provider serializes its whole lifetime, including auth.
 * A missing rollout/configuration keeps the same guest workspace useful and local. */
export function createBrowserContentAccountRuntime(input: Readonly<PrivateContentConfiguration>) {
  const config = ownPrivateContentConfiguration(input);
  if (Platform.OS !== 'web' || globalThis.location?.origin !== config.origin)
    throw new Error('This configured workspace requires its original browser origin.');
  const enableContentSync = process.env.EXPO_PUBLIC_COOKMATE_CONTENT_SYNC === '1';
  const accountConfig = enableContentSync ? readAccountAuthConfig() : null;
  const partition = createContentAccountPrivateStorage(
    config.installationId,
    localAccountStorage,
    accountCredentialStorage,
  );
  const auth = accountConfig
    ? createSupabaseAccountAccess(accountConfig, {
        storage: partition.credentials,
        storageKey: partition.authStorageKey,
      })
    : null;
  const fetch = globalThis.fetch.bind(globalThis);
  const physical = createContentAccountNativeStorage({
    installationId: config.installationId,
    browser: true,
    sha256: nativeCommandPlatform.sha256,
    assertClosed() {
      throw new Error('An issued closed-workspace lease is required.');
    },
  });
  const guestState = createContentPrivateState(
    { installationId: config.installationId, ownerId: null },
    localAccountStorage,
  );
  const workspace = {
    config,
    catalogue: catalogue.identity,
    openConnection: physical.openConnection,
    verification: () => createContentVerificationPorts({ trustKeys: config.trustKeys }),
    journal: (ownerId: string | null) => localContentUpdateJournal(config.installationId, ownerId),
    platform: nativeCommandPlatform,
    ...runtimeClock,
    fetch,
  };
  const draftKey = (scopeKey: string) =>
    `cookmate.preview.assistant-draft.v1.${encodeURIComponent(scopeKey)}`;
  const deletionTransport = accountConfig
    ? createDeletionRecoveryTransport({
        endpoint: `${accountConfig.url}/functions/v1/cookmate-account-deletion-status`,
        publishableKey: accountConfig.publishableKey,
        fetch,
      })
    : null;
  const root = createContentAccountRuntime({
    workspace,
    auth,
    accountConfig,
    accountFetch: fetch,
    enableContentSync,
    metadata: partition.metadata,
    guestPreferences: appPreferencesStoreForContent(config.installationId),
    planningStore: (ownerId) =>
      createContentPrivateState(
        { installationId: config.installationId, ownerId },
        localAccountStorage,
      ).planningPreferences,
    recentlyViewedStore: (ownerId) =>
      createContentPrivateState(
        { installationId: config.installationId, ownerId },
        localAccountStorage,
      ).recentlyViewed,
    databases: {
      cloneGuestWithMarker: physical.cloneGuestWithMarker,
      deleteDatabase: physical.deleteDatabase,
      assertGuestRecoverySettled: (lease) =>
        assertContentGuestRecoverySettled(
          { ...workspace, journal: workspace.journal(null) },
          guestState.references,
          lease,
        ),
      async copyGuestDraft(ownerId) {
        const account = createContentPrivateState(
          { installationId: config.installationId, ownerId },
          localAccountStorage,
        );
        const source = draftKey(guestState.draftScopeKey),
          destination = draftKey(account.draftScopeKey);
        const draft = window.sessionStorage.getItem(source);
        if (draft !== null && window.sessionStorage.getItem(destination) === null)
          window.sessionStorage.setItem(destination, draft);
      },
      async removeOwnerPrivateState(ownerId) {
        await removeContentAccountPrivateState(
          { installationId: config.installationId, ownerId },
          {
            metadata: localAccountStorage,
            sessionDraft: {
              read: async (scopeKey) => window.sessionStorage.getItem(draftKey(scopeKey)),
              remove: async (scopeKey) => {
                window.sessionStorage.removeItem(draftKey(scopeKey));
              },
            },
          },
        );
      },
    },
    deletion: {
      journal: createDeletionRecoveryJournal(partition.credentials, { now: runtimeClock.now }),
      async newToken() {
        const bytes = await Crypto.getRandomBytesAsync(32);
        return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      },
      readStatus(input) {
        if (!deletionTransport) throw new Error('Account service is not configured');
        return deletionTransport.readStatus(input);
      },
      async readState(_scope, remote) {
        const current = await createAccountContentRemote(remote).read();
        return { revision: current.revision, deletionOperationId: current.deletionOperationId };
      },
    },
  });
  return Object.freeze({
    ...root,
    configured: accountConfig !== null,
    rollout: enableContentSync,
    availability: Object.freeze({
      apple: !!accountConfig?.apple && window.isSecureContext,
      google: !!accountConfig?.google && window.isSecureContext,
    }),
  });
}
