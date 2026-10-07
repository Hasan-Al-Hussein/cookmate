import * as SecureStore from 'expo-secure-store';
import { aiConsentKey, type AiConsentStore } from './aiConsent';

const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export function aiConsentStoreForWorkspace(workspaceKey = 'guest'): AiConsentStore {
  const key =
    workspaceKey === 'guest' ? aiConsentKey : `${aiConsentKey}.${workspaceKey.replace(':', '.')}`;
  return {
    read: () => SecureStore.getItemAsync(key, options),
    write: (value) => SecureStore.setItemAsync(key, value, options),
  };
}
export const aiConsentStore = aiConsentStoreForWorkspace();
