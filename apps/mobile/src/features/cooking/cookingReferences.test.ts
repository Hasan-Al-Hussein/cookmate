import { createCookingReferenceStore, type CookingReference } from './cookingReferences';
const installation = 'a0000000-0000-4000-8000-000000000001';
const entry: CookingReference = {
  operationId: 'b0000000-0000-4000-8000-000000000001',
  kind: 'cooked',
  recipeId: '52839',
  createdAt: '2026-09-30T08:00:00.000Z',
};
function fixture() {
  const values = new Map<string, string>();
  const write = jest.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  return {
    values,
    write,
    store: createCookingReferenceStore({ read: async (key) => values.get(key) ?? null, write }),
  };
}
test('persists only bounded installation-bound identifiers, never a note or execution input', async () => {
  const { store, values } = fixture();
  await store.remember(installation, entry);
  const text = values.get(`cookmate.cooking-recovery.${installation}`);
  if (!text) throw new Error('Expected cooking journal');
  expect(JSON.parse(text)).toEqual({
    schemaVersion: 1,
    installationId: installation,
    operations: [entry],
  });
  expect(await store.load('a0000000-0000-4000-8000-000000000002')).toEqual([]);
});
test.each([
  '{broken',
  JSON.stringify({ schemaVersion: 2, installationId: installation, operations: [] }),
  JSON.stringify({ schemaVersion: 1, installationId: 'foreign', operations: [entry] }),
])('corrupt/future/foreign recovery data is never overwritten: %s', async (text) => {
  const { values, write, store } = fixture();
  values.set(`cookmate.cooking-recovery.${installation}`, text);
  await expect(store.remember(installation, entry)).rejects.toThrow();
  await expect(store.release(installation, entry.operationId, 'receipt')).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});
test('failed and undispatched attempts release only their own slots while unresolved IDs remain', async () => {
  const { store } = fixture();
  await store.remember(installation, entry);
  for (let i = 2; i < 45; i++) {
    const operationId = `b0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    await store.remember(installation, { ...entry, operationId });
    await store.release(installation, operationId, i % 2 ? 'not_dispatched' : 'definite_failure');
  }
  expect(await store.load(installation)).toEqual([entry]);
});
test('concurrent updates serialize and cleanup failure retains the unresolved reference', async () => {
  const { store, write } = fixture();
  const clear: CookingReference = {
    ...entry,
    operationId: 'b0000000-0000-4000-8000-000000000002',
    kind: 'clear_history',
    recipeId: null,
  };
  await Promise.all([store.remember(installation, entry), store.remember(installation, clear)]);
  write.mockRejectedValueOnce(new Error('Blocked'));
  await expect(store.release(installation, clear.operationId, 'receipt')).rejects.toThrow();
  expect(await store.load(installation)).toEqual([entry, clear]);
});
