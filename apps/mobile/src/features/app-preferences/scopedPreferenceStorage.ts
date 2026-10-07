import { appPreferencesKey, type AppPreferencesStore } from './preferences';
import { isAppId } from '../../data/conversationRecords';

/** Matches the independently configured content installation; never resolves to guest. */
export function contentPreferenceScope(installationId: string): `content:${string}` {
  if (!isAppId(installationId)) throw new Error('Invalid content installation');
  return `content:${installationId}`;
}

export function preferenceStorageKey(scope: string): string {
  if (scope === 'guest') return appPreferencesKey;
  if (typeof scope !== 'string') throw new Error('Invalid cooking workspace');
  if (scope.startsWith('content:')) {
    const owned = contentPreferenceScope(scope.slice('content:'.length));
    return `${appPreferencesKey}.${owned.replace(':', '.')}`;
  }
  if (
    !/^account:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scope)
  )
    throw new Error('Invalid cooking workspace');
  return `${appPreferencesKey}.${scope.replace(':', '.')}`;
}

/** Stable store objects preserve the existing one-writer-per-storage controller lifetime. */
export function createScopedPreferenceStores(port: {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}) {
  const stores = new Map<string, AppPreferencesStore>();
  return (scope: string): AppPreferencesStore => {
    const key = preferenceStorageKey(scope);
    let store = stores.get(key);
    if (!store) {
      store = { read: () => port.read(key), write: (value) => port.write(key, value) };
      stores.set(key, store);
    }
    return store;
  };
}
