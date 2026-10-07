import { contentPreferenceScope, createScopedPreferenceStores } from './scopedPreferenceStorage';
import type { AppPreferencesStore } from './preferences';

// Import only when the native provider hydrates. Pure presentation consumers/tests need no DB.
const storage = () => import('expo-sqlite/kv-store').then((module) => module.default);

export const appPreferencesStoreForScope = createScopedPreferenceStores({
  read: async (key) => (await storage()).getItemAsync(key),
  write: async (key, value) => (await storage()).setItemAsync(key, value),
});
export const appPreferencesStore = appPreferencesStoreForScope('guest');

export function appPreferencesStoreForContent(installationId: string): AppPreferencesStore {
  return appPreferencesStoreForScope(contentPreferenceScope(installationId));
}
