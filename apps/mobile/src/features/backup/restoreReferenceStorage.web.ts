import { createRestoreReferenceStore } from './restoreReferences';

export const restoreReferenceStore = createRestoreReferenceStore({
  read: async (key) => globalThis.localStorage.getItem(key),
  write: async (key, value) => {
    globalThis.localStorage.setItem(key, value);
  },
});
