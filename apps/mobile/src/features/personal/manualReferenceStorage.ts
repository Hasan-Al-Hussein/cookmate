import { createPersonalReferenceStore } from './personalReferences';
const storage = () => import('expo-sqlite/kv-store').then((module) => module.default);
/** Opaque operation IDs only; this namespace cannot consume note/collection references. */
export const manualReferenceStore = createPersonalReferenceStore({
  read: async (key) => (await storage()).getItemAsync(`content-manual:${key}`),
  write: async (key, value) => (await storage()).setItemAsync(`content-manual:${key}`, value),
});
