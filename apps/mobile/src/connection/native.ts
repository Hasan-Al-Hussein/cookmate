import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { createSecureCredentialStore } from './credentials';
import { createGatewayConnection } from './transport';
import type { ConnectionOptions } from './transport';

/** Device-only Keychain accessibility; no web/localStorage fallback. */
export function createNativeCredentialStore(workspaceKey = 'guest') {
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  const scoped = (key: string) =>
    workspaceKey === 'guest' ? key : `${key}.${workspaceKey.replace(':', '.')}`;
  return createSecureCredentialStore({
    getItemAsync: (key) => SecureStore.getItemAsync(scoped(key), options),
    setItemAsync: (key, value) => SecureStore.setItemAsync(scoped(key), value, options),
    deleteItemAsync: (key) => SecureStore.deleteItemAsync(scoped(key), options),
  });
}

/** Expo's iOS URLSession delegate rejects redirects before following and streams bodies. */
export function createNativeGatewayConnection(
  options: Omit<ConnectionOptions, 'fetch' | 'credentials'> = {},
  workspaceKey = 'guest',
) {
  return createGatewayConnection({
    ...options,
    credentials: createNativeCredentialStore(workspaceKey),
    fetch: (input, init) =>
      expoFetch(typeof input === 'string' || input instanceof URL ? input : input.url, init),
  });
}
