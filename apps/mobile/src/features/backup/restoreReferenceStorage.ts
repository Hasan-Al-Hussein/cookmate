import { createRestoreReferenceStore } from './restoreReferences';

const storage = () => import('expo-sqlite/kv-store').then((module) => module.default);
export const restoreReferenceStore = createRestoreReferenceStore({
  read: async (key) => (await storage()).getItemAsync(key),
  write: async (key, value) => (await storage()).setItemAsync(key, value),
});
