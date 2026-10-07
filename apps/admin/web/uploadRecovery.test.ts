import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forgetUploadReference,
  readUploadReference,
  rememberUploadReference,
} from './uploadRecovery';
function storageFixture(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}
const reference = {
  operationId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'editor',
  draftId: 'draft-one',
  expectedRevision: 2,
};
test('upload recovery retains exact operation metadata without keeping file bytes or names', () => {
  const storage = storageFixture();
  rememberUploadReference(storage, reference);
  assert.deepEqual(readUploadReference(storage, reference.draftId), reference);
  assert.equal(storage.length, 1);
  assert.throws(() =>
    rememberUploadReference(storage, {
      ...reference,
      operationId: 'a0000000-0000-4000-8000-000000000002',
    }),
  );
  forgetUploadReference(storage, reference);
  assert.equal(readUploadReference(storage, reference.draftId), null);
});
test('future upload recovery formats remain intact and cannot be replaced by a new attempt', () => {
  const storage = storageFixture();
  const key = 'cookmate.admin.upload.v1:draft-one';
  const raw = JSON.stringify({ version: 2, reference });
  storage.setItem(key, raw);
  assert.throws(() => rememberUploadReference(storage, reference));
  assert.equal(storage.getItem(key), raw);
});
