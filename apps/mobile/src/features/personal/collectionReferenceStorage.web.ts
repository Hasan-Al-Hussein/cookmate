import { createPersonalReferenceStore } from './personalReferences';
/** Opaque operation IDs only; this namespace cannot consume note/manual references. */
export const collectionReferenceStore = createPersonalReferenceStore({
  read: async (key) => localStorage.getItem(`content-collections:${key}`),
  write: async (key, value) => localStorage.setItem(`content-collections:${key}`, value),
});
