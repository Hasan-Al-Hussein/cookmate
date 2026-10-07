import {
  createRestoreReferenceStore,
  type RestoreReferenceStorage,
  type RestoreReferenceStore,
} from './restoreReferences';

const originalPrefix = 'cookmate.restore-references.';
const contentPrefix = 'cookmate.content-restore-references.';

/** Reuse the strict ID/timestamp codec, but never read or modify the legacy journal. */
export function createContentRestoreReferenceStore(
  storage: RestoreReferenceStorage,
): RestoreReferenceStore {
  const read = storage.read.bind(storage),
    write = storage.write.bind(storage);
  function contentKey(key: string) {
    if (!key.startsWith(originalPrefix)) throw new Error('Unexpected restore reference key');
    return contentPrefix + key.slice(originalPrefix.length);
  }
  return createRestoreReferenceStore({
    read: (key) => read(contentKey(key)),
    write: (key, value) => write(contentKey(key), value),
  });
}
