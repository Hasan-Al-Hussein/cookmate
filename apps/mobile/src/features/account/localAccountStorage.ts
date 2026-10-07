import Storage from 'expo-sqlite/kv-store';

/** Non-secret local workspace metadata, separate from the encrypted Auth session. */
export const localAccountStorage = {
  read: (key: string) => Storage.getItemAsync(key),
  write: (key: string, value: string) => Storage.setItemAsync(key, value),
  async remove(key: string) {
    await Storage.removeItemAsync(key);
  },
};
