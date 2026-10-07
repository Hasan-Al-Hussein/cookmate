import { createContentRestoreReferenceStore } from './contentRestoreReferences';

export const contentRestoreReferenceStore = createContentRestoreReferenceStore({
  read: async (key) => globalThis.localStorage.getItem(key),
  write: async (key, value) => {
    globalThis.localStorage.setItem(key, value);
  },
});
