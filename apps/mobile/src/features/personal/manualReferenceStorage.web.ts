import { createPersonalReferenceStore } from './personalReferences';
/** Opaque operation IDs only; this namespace cannot consume note/collection references. */
export const manualReferenceStore = createPersonalReferenceStore({
  read: async (key) => localStorage.getItem(`content-manual:${key}`),
  write: async (key, value) => localStorage.setItem(`content-manual:${key}`, value),
});
