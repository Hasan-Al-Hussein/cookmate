import { createCookingReferenceStore } from './cookingReferences';
export const cookingReferenceStore = createCookingReferenceStore({
  read: async (key) => globalThis.localStorage.getItem(key),
  write: async (key, value) => {
    globalThis.localStorage.setItem(key, value);
  },
});
