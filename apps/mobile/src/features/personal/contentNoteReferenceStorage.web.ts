import { createPersonalReferenceStore } from './personalReferences';
/** Same metadata codec and isolated namespace on web; private note text is never retained here. */
export const contentNoteReferenceStore = createPersonalReferenceStore({
  read: async (key) => globalThis.localStorage.getItem(`content-notes:${key}`),
  write: async (key, value) => globalThis.localStorage.setItem(`content-notes:${key}`, value),
});
