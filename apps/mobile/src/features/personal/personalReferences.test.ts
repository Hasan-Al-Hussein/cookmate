import { createPersonalReferenceStore } from './personalReferences';
const installation = 'a0000000-0000-4000-8000-000000000001';
const id = (number: number) => `b0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function fixture() {
  const values = new Map<string, string>();
  const write = jest.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  return {
    values,
    write,
    store: createPersonalReferenceStore({ read: async (key) => values.get(key) ?? null, write }),
  };
}
test('personal references serialize concurrent saves and contain no executable/private fields', async () => {
  const { store, values } = fixture();
  await Promise.all([store.remember(installation, id(1)), store.remember(installation, id(2))]);
  const refs = await store.load(installation);
  expect(refs.map((item) => item.operationId)).toEqual([id(1), id(2)]);
  expect(Object.keys(refs[0]!)).toEqual(['operationId', 'createdAt']);
  expect([...values.keys()]).toEqual([`cookmate.personal-recovery.${installation}`]);
});
test.each(['future', 'private-field', 'other-installation'])(
  'unsupported %s metadata is never overwritten',
  async (kind) => {
    const { store, values, write } = fixture();
    const payload = JSON.stringify({
      schemaVersion: kind === 'future' ? 2 : 1,
      installationId: kind === 'other-installation' ? id(1) : installation,
      operations: [
        {
          operationId: id(1),
          createdAt: '2026-09-30T10:00:00.000Z',
          ...(kind === 'private-field' ? { text: 'Private note' } : {}),
        },
      ],
    });
    values.set(`cookmate.personal-recovery.${installation}`, payload);
    await expect(store.remember(installation, id(2))).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(values.get(`cookmate.personal-recovery.${installation}`)).toBe(payload);
  },
);
test('definite failure cleanup never exhausts capacity; unresolved IDs remain bounded', async () => {
  const { store } = fixture();
  await store.remember(installation, id(1));
  for (let index = 2; index < 45; index++) {
    await store.remember(installation, id(index));
    await store.release(installation, id(index), 'definite_failure');
  }
  expect((await store.load(installation)).map((item) => item.operationId)).toEqual([id(1)]);
  for (let index = 2; index <= 20; index++) await store.remember(installation, id(index));
  await expect(store.remember(installation, id(21))).rejects.toThrow('Resolve earlier');
});
test('storage failure retains earlier references and does not claim a new saved marker', async () => {
  const { store, write } = fixture();
  await store.remember(installation, id(1));
  write.mockRejectedValueOnce(new Error('Disk full'));
  await expect(store.remember(installation, id(2))).rejects.toThrow('Disk full');
  expect((await store.load(installation)).map((item) => item.operationId)).toEqual([id(1)]);
});
