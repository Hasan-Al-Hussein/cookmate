import { createContentRestoreReferenceStore } from './contentRestoreReferences';
import { createRestoreReferenceStore, type RestoreReferenceStorage } from './restoreReferences';
const installation = 'a0000000-0000-4000-8000-000000000001',
  other = 'a0000000-0000-4000-8000-000000000002';
const reference = {
  operationId: 'b0000000-0000-4000-8000-000000000001',
  preparedAt: '2026-10-02T08:00:00.000Z',
};
function fixture() {
  const values = new Map<string, string>();
  const storage: jest.Mocked<RestoreReferenceStorage> = {
    read: jest.fn(async (key) => values.get(key) ?? null),
    write: jest.fn(async (key, value) => {
      values.set(key, value);
    }),
  };
  return { values, storage, store: createContentRestoreReferenceStore(storage) };
}
test('content and legacy references never share keys and persist only ID/time metadata', async () => {
  const f = fixture(),
    legacy = createRestoreReferenceStore(f.storage);
  await legacy.remember(installation, reference);
  const original = f.values.get(`cookmate.restore-references.${installation}`);
  expect(await f.store.load(installation)).toEqual([]);
  await f.store.remember(installation, reference);
  expect(f.values.get(`cookmate.restore-references.${installation}`)).toBe(original);
  expect(JSON.parse(f.values.get(`cookmate.content-restore-references.${installation}`)!)).toEqual({
    schemaVersion: 1,
    installationId: installation,
    operations: [reference],
  });
  expect(await f.store.load(other)).toEqual([]);
  await f.store.forget(installation, reference.operationId, 'not_dispatched');
  expect(await legacy.load(installation)).toEqual([reference]);
});
test.each(['null', '{"schemaVersion":2}', 'x'.repeat(4097)])(
  'corrupt content metadata stays unchanged and cannot affect legacy references',
  async (text) => {
    const f = fixture();
    const key = `cookmate.content-restore-references.${installation}`;
    f.values.set(key, text);
    await expect(f.store.load(installation)).rejects.toThrow();
    await expect(f.store.remember(installation, reference)).rejects.toThrow();
    expect(f.values.get(key)).toBe(text);
    expect(f.storage.write).not.toHaveBeenCalled();
  },
);
test('invalid installation never reads storage and failed writes do not report persistence', async () => {
  const f = fixture();
  await expect(f.store.load('guest')).rejects.toThrow();
  expect(f.storage.read).not.toHaveBeenCalled();
  f.storage.write.mockRejectedValueOnce(new Error('unavailable'));
  await expect(f.store.remember(installation, reference)).rejects.toThrow();
  expect(await f.store.load(installation)).toEqual([]);
});
