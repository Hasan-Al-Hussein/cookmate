import { createContentRestoreReferenceStore } from './contentRestoreReferences';

const storage = () => import('expo-sqlite/kv-store').then((module) => module.default);
export const contentRestoreReferenceStore = createContentRestoreReferenceStore({
  read: async (key) => (await storage()).getItemAsync(key),
  write: async (key, value) => (await storage()).setItemAsync(key, value),
});
