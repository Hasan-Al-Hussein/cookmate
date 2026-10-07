import { contentPreferenceScope, createScopedPreferenceStores } from './scopedPreferenceStorage';
import type { AppPreferencesStore } from './preferences';

export const appPreferencesStoreForScope = createScopedPreferenceStores({
  async read(key) {
    // Unavailable/blocked localStorage throws into the controller's non-destructive error state.
    return window.localStorage.getItem(key);
  },
  async write(key, value) {
    window.localStorage.setItem(key, value);
  },
});
export const appPreferencesStore = appPreferencesStoreForScope('guest');

export function appPreferencesStoreForContent(installationId: string): AppPreferencesStore {
  return appPreferencesStoreForScope(contentPreferenceScope(installationId));
}
