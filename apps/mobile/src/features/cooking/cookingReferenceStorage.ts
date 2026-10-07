import { createCookingReferenceStore } from './cookingReferences';
const storage = () => import('expo-sqlite/kv-store').then((module) => module.default);
export const cookingReferenceStore = createCookingReferenceStore({
  read: async (key) => (await storage()).getItemAsync(key),
  write: async (key, value) => (await storage()).setItemAsync(key, value),
});
