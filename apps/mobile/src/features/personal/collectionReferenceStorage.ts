import { createPersonalReferenceStore } from './personalReferences';
const storage = () => import('expo-sqlite/kv-store').then((module) => module.default);
/** Opaque operation IDs only; this namespace cannot consume note/manual references. */
export const collectionReferenceStore = createPersonalReferenceStore({
  read: async (key) => (await storage()).getItemAsync(`content-collections:${key}`),
  write: async (key, value) => (await storage()).setItemAsync(`content-collections:${key}`, value),
});
