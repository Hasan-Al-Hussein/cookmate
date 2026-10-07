import { createPersonalReferenceStore } from './personalReferences';
const storage = () => import('expo-sqlite/kv-store').then((module) => module.default);
/** Separate opaque operation metadata; never consumes legacy collection/manual recovery IDs. */
export const contentNoteReferenceStore = createPersonalReferenceStore({
  read: async (key) => (await storage()).getItemAsync(`content-notes:${key}`),
  write: async (key, value) => (await storage()).setItemAsync(`content-notes:${key}`, value),
});
