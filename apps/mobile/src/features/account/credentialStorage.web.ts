import { AccountCredentialStorageError } from './sessionStorage';

// Supabase SPA sessions stay in this browser origin. They are never part of cooking backups.
function storage() {
  if (typeof window === 'undefined' || !window.isSecureContext)
    throw new AccountCredentialStorageError();
  return window.localStorage;
}
function key(value: string) {
  if (!/^cookmate\.account\.auth(?:-[A-Za-z0-9_-]{1,160})?$/.test(value))
    throw new AccountCredentialStorageError();
  return value;
}
export const accountCredentialStorage = {
  async getItem(name: string) {
    const value = storage().getItem(key(name));
    if (value && new TextEncoder().encode(value).byteLength > 64 * 1024)
      throw new AccountCredentialStorageError();
    return value;
  },
  async setItem(name: string, value: string) {
    if (new TextEncoder().encode(value).byteLength > 64 * 1024)
      throw new AccountCredentialStorageError();
    storage().setItem(key(name), value);
  },
  async removeItem(name: string) {
    storage().removeItem(key(name));
  },
};
