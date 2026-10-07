import { createContext, useContext } from 'react';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { isAppId } from '../../data/conversationRecords';
import {
  contentPreferenceScope,
  createScopedPreferenceStores,
  preferenceStorageKey,
} from '../app-preferences/scopedPreferenceStorage';
import { createPersonalReferenceStore } from '../personal/personalReferences';
import { createContentCookingReferenceStore } from '../cooking/contentCookingReferences';
import { createCookingReferenceStore } from '../cooking/cookingReferences';
import { createContentRestoreReferenceStore } from '../backup/contentRestoreReferences';
import type { AppPreferencesStore } from '../app-preferences/preferences';

export interface ContentPrivateStateScope {
  readonly installationId: string;
  readonly ownerId: string | null;
}
export interface ContentPrivateStateStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/** Storage partition only. The current host still owns all operation/recovery authority.
 * Retain one bundle per selected owner, and never copy its recovery records to another owner.
 */
export function createContentPrivateState(
  input: ContentPrivateStateScope,
  storage: ContentPrivateStateStorage,
  options: { preferences?: AppPreferencesStore } = {},
) {
  const value: unknown = JSON.parse(canonicalContentJson(input, 1024));
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'installationId,ownerId' ||
    !('installationId' in value) ||
    !isAppId(value.installationId) ||
    value.installationId.length !== 36 ||
    !('ownerId' in value) ||
    (value.ownerId !== null && (!isAppId(value.ownerId) || value.ownerId.length !== 36))
  )
    throw new Error('Invalid content private-state scope');
  const scope: ContentPrivateStateScope = Object.freeze({
    installationId: value.installationId,
    ownerId: value.ownerId,
  });
  const read = storage.read.bind(storage),
    write = storage.write.bind(storage);
  const ownerPrefix =
    scope.ownerId === null
      ? ''
      : `cookmate.content-private.${scope.installationId}.${scope.ownerId}:`;
  const storageKeys = new Set<string>();
  function port(expectedKey: string, prefix = ''): ContentPrivateStateStorage {
    storageKeys.add(`${ownerPrefix}${prefix}${expectedKey}`);
    const key = (requested: string) => {
      if (requested !== expectedKey) throw new Error('Content private-state installation changed');
      return `${ownerPrefix}${prefix}${requested}`;
    };
    return Object.freeze({
      read: (requested: string) => read(key(requested)),
      write: (requested: string, text: string) => write(key(requested), text),
    });
  }
  const personalKey = `cookmate.personal-recovery.${scope.installationId}`;
  const preferenceScope = contentPreferenceScope(scope.installationId);
  const preferenceKey = preferenceStorageKey(preferenceScope);
  const planningKey = `cookmate.planning-preferences.content.${scope.installationId}`;
  const planningPort = port(planningKey);
  const recentKey = `cookmate.recently-viewed.content.${scope.installationId}`;
  const recentPort = port(recentKey);
  // An account lifecycle supplies its existing LocalAccountSettings preferenceStore,
  // so display changes and reviewed account settings keep a single persistence owner.
  const suppliedPreferences = options.preferences;
  const preferences: AppPreferencesStore = suppliedPreferences
    ? Object.freeze({
        read: suppliedPreferences.read.bind(suppliedPreferences),
        write: suppliedPreferences.write.bind(suppliedPreferences),
        ...(suppliedPreferences.subscribe
          ? { subscribe: suppliedPreferences.subscribe.bind(suppliedPreferences) }
          : {}),
      })
    : scope.ownerId === null
      ? Object.freeze(createScopedPreferenceStores(port(preferenceKey))(preferenceScope))
      : Object.freeze({
          async read(): Promise<string | null> {
            throw new Error('Account preference store required');
          },
          async write(_text: string): Promise<void> {
            throw new Error('Account preference store required');
          },
        });
  return Object.freeze({
    scope,
    preferences,
    planningPreferences: Object.freeze({
      read: () => planningPort.read(planningKey),
      write: (text: string) => planningPort.write(planningKey, text),
    }),
    recentlyViewed: Object.freeze({
      read: () => recentPort.read(recentKey),
      write: (text: string) => recentPort.write(recentKey, text),
    }),
    draftScopeKey:
      scope.ownerId === null ? preferenceScope : `${preferenceScope}:account:${scope.ownerId}`,
    references: Object.freeze({
      notes: Object.freeze(createPersonalReferenceStore(port(personalKey, 'content-notes:'))),
      manual: Object.freeze(createPersonalReferenceStore(port(personalKey, 'content-manual:'))),
      collections: Object.freeze(
        createPersonalReferenceStore(port(personalKey, 'content-collections:')),
      ),
      cooking: createContentCookingReferenceStore(
        port(`cookmate.content-cooking-recovery.${scope.installationId}`),
      ),
      history: Object.freeze(
        createCookingReferenceStore(port(`cookmate.cooking-recovery.${scope.installationId}`)),
      ),
      restore: Object.freeze(
        createContentRestoreReferenceStore(
          port(`cookmate.content-restore-references.${scope.installationId}`),
        ),
      ),
    }),
    /** Exact keys owned by this partition, for reviewed local-account removal only. */
    storageKeys: Object.freeze([...storageKeys]),
  });
}

export type ContentPrivateState = ReturnType<typeof createContentPrivateState>;
/** The configured root supplies one bundle matching its runtime.storageScope. */
export const ContentPrivateStateContext = createContext<ContentPrivateState | null>(null);
export const useOptionalContentPrivateState = () => useContext(ContentPrivateStateContext);
