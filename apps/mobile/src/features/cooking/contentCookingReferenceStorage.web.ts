import { createContentCookingReferenceStore } from './contentCookingReferences';
export const contentCookingReferenceStore = createContentCookingReferenceStore({
  read: async (key) => globalThis.localStorage.getItem(key),
  write: async (key, value) => globalThis.localStorage.setItem(key, value),
});
