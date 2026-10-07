import { AccountCredentialStorageError } from '../account/sessionStorage';
import type { DeletionRecoveryStorage } from '../account/deletionRecovery';

interface MetadataStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Partition existing codecs and credentials by installation; never copy recovery or auth data. */
export function createContentAccountPrivateStorage(
  installationId: string,
  metadata: MetadataStorage,
  credentials: DeletionRecoveryStorage,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installationId))
    throw new Error('Invalid content account installation');
  const prefix = `cookmate.content-account.${installationId}:`;
  const authStorageKey = `cookmate.account.auth-content-${installationId}`;
  const read = metadata.read.bind(metadata),
    write = metadata.write.bind(metadata),
    remove = metadata.remove.bind(metadata);
  const getItem = credentials.getItem.bind(credentials),
    setItem = credentials.setItem.bind(credentials),
    removeItem = credentials.removeItem.bind(credentials);
  const metadataKey = (key: string) => {
    if (!/^cookmate\.[A-Za-z0-9._:-]{1,220}$/.test(key))
      throw new Error('Invalid account metadata key');
    return prefix + key;
  };
  const credentialKey = (key: string) => {
    if (
      key === authStorageKey ||
      (key.startsWith(authStorageKey + '-') &&
        /^[A-Za-z0-9_-]{1,100}$/.test(key.slice(authStorageKey.length + 1)))
    )
      return key;
    const match = /^cookmate\.account\.auth(-[A-Za-z0-9_-]{1,100})?$/.exec(key);
    if (!match) throw new AccountCredentialStorageError();
    // Still accepted by the existing browser/native credential adapter's bounded key grammar.
    return `${authStorageKey}${match[1] ?? ''}`;
  };
  return Object.freeze({
    authStorageKey,
    metadata: Object.freeze({
      read: (key: string) => read(metadataKey(key)),
      write: (key: string, value: string) => write(metadataKey(key), value),
      remove: (key: string) => remove(metadataKey(key)),
    }),
    credentials: Object.freeze({
      getItem: (key: string) => getItem(credentialKey(key)),
      setItem: (key: string, value: string) => setItem(credentialKey(key), value),
      removeItem: (key: string) => removeItem(credentialKey(key)),
    }),
  });
}
