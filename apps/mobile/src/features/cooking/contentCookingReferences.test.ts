import {
  createContentCookingReferenceStore,
  type ContentCookingReference,
} from './contentCookingReferences';
const installation = 'a0000000-0000-4000-8000-000000000001';
const record: ContentCookingReference = {
  kind: 'cooked',
  createdAt: '2026-10-01T00:00:00.000Z',
  reference: {
    formatVersion: 1,
    eventId: 'b0000000-0000-4000-8000-000000000001',
    requestFingerprint: 'a'.repeat(64),
    contentRef: { recipeId: '52819', revisionId: 'exact-one', contentFingerprint: 'b'.repeat(64) },
    expectedHistoryEpoch: 0,
    session: null,
  },
};
function fixture() {
  const values = new Map<string, string>();
  const write = jest.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const storage = { read: async (key: string) => values.get(key) ?? null, write };
  return { values, write, storage, store: createContentCookingReferenceStore(storage) };
}
test('reopens exact metadata without a private cooking draft and keeps installation namespaces separate', async () => {
  const { store, storage, values } = fixture();
  await store.remember(installation, record);
  const reopened = createContentCookingReferenceStore(storage);
  expect(await reopened.load(installation)).toEqual([record]);
  expect(await reopened.load('a0000000-0000-4000-8000-000000000002')).toEqual([]);
  const text = [...values.values()][0]!;
  expect(text).not.toMatch(/note|cookedOn|timeZone|recipeTitle/);
  expect(Object.isFrozen((await reopened.load(installation))[0])).toBe(true);
});
test('one unresolved session blocks a concurrent cooked save until exact cleanup', async () => {
  const { store } = fixture();
  const session: ContentCookingReference = {
    createdAt: record.createdAt,
    kind: 'session',
    request: {
      kind: 'dismiss',
      input: {
        operationId: 'c0000000-0000-4000-8000-000000000001',
        recipeId: '52819',
        sessionId: 'd0000000-0000-4000-8000-000000000001',
        expectedRevision: 1,
      },
    },
  };
  await store.remember(installation, session);
  await expect(store.remember(installation, record)).rejects.toThrow();
  await store.release(installation, session);
  await store.remember(installation, record);
  expect(await store.load(installation)).toEqual([record]);
});
test('rejects private extra fields, accessors and changed same-operation evidence before storage writes', async () => {
  const { store, write } = fixture();
  const extra = { ...record, note: 'Private draft' };
  expect(() => store.remember(installation, extra)).toThrow();
  const getter = jest.fn(() => record.createdAt);
  const hostile = { ...record };
  Object.defineProperty(hostile, 'createdAt', { get: getter });
  expect(() => store.remember(installation, hostile)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  await store.remember(installation, record);
  const changed = { ...record, createdAt: '2026-10-01T00:00:01.000Z' };
  await expect(store.remember(installation, changed)).rejects.toThrow();
  await expect(store.release(installation, changed)).rejects.toThrow();
  expect(await store.load(installation)).toEqual([record]);
});
test.each([
  '{broken',
  'x'.repeat(140000),
  JSON.stringify({ formatVersion: 1, installationId: 'foreign', records: [] }),
])('malformed stored metadata remains unchanged', async (text) => {
  const { store, values, write } = fixture();
  values.set(`cookmate.content-cooking-recovery.${installation}`, text);
  await expect(store.remember(installation, record)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});
test('a lost write acknowledgement keeps the durable original for a later reload', async () => {
  const { values } = fixture();
  const storage = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
      throw new Error('Lost acknowledgement');
    },
  };
  const store = createContentCookingReferenceStore(storage);
  await expect(store.remember(installation, record)).rejects.toThrow();
  expect(await store.load(installation)).toEqual([record]);
});
