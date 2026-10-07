import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { createAccountSessionStorage } from './sessionStorage';

const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const accountCredentialStorage = createAccountSessionStorage(
  {
    get: (key) => SecureStore.getItemAsync(key, options),
    set: (key, value) => SecureStore.setItemAsync(key, value, options),
    remove: (key) => SecureStore.deleteItemAsync(key, options),
  },
  (key) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key),
);
