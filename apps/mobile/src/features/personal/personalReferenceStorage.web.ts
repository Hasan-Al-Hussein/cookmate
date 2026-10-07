import { createPersonalReferenceStore } from './personalReferences';
export const personalReferenceStore = createPersonalReferenceStore({
  read: async (key) => globalThis.localStorage.getItem(key),
  write: async (key, value) => {
    globalThis.localStorage.setItem(key, value);
  },
});
