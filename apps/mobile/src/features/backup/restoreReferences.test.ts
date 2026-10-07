import { createRestoreReferenceStore, type RestoreReferenceStorage } from './restoreReferences';

const installation = 'a0000000-0000-4000-8000-000000000001';
const otherInstallation = 'a0000000-0000-4000-8000-000000000002';
const preparedAt = '2026-09-30T08:00:00.000Z';
const operation = (value: number) => `b0000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
function fixture() {
  const values = new Map<string, string>();
  const storage: jest.Mocked<RestoreReferenceStorage> = {
    read: jest.fn(async (key: string) => values.get(key) ?? null),
    write: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  return { values, storage, store: createRestoreReferenceStore(storage) };
}

test('serializes concurrent references and persists only workspace-bound IDs and timestamps', async () => {
  const { store, values, storage } = fixture();
  await Promise.all(
    [1, 2, 3].map((value) =>
      store.remember(installation, { operationId: operation(value), preparedAt }),
    ),
  );
  expect(await store.load(installation)).toEqual(
    [1, 2, 3].map((value) => ({ operationId: operation(value), preparedAt })),
  );
  const serialized = [...values.values()][0];
  if (!serialized) throw new Error('Expected a stored reference journal');
  expect(JSON.parse(serialized)).toEqual({
    schemaVersion: 1,
    installationId: installation,
    operations: [1, 2, 3].map((value) => ({ operationId: operation(value), preparedAt })),
  });
  expect(await store.load(otherInstallation)).toEqual([]);
  expect(storage.write).toHaveBeenCalledTimes(3);
  await store.remember(installation, {
    operationId: operation(2),
    preparedAt: '2026-10-01T08:00:00.000Z',
  });
  expect(storage.write).toHaveBeenCalledTimes(3);
});

test.each([
  '{broken',
  JSON.stringify({ schemaVersion: 2, installationId: installation, operations: [] }),
  JSON.stringify({ schemaVersion: 1, installationId: otherInstallation, operations: [] }),
  JSON.stringify({ schemaVersion: 1, installationId: installation, operations: [], extra: true }),
  JSON.stringify({
    schemaVersion: 1,
    installationId: installation,
    operations: [{ operationId: operation(1), preparedAt, payload: 'private' }],
  }),
  JSON.stringify({
    schemaVersion: 1,
    installationId: installation,
    operations: [
      { operationId: operation(1), preparedAt },
      { operationId: operation(1), preparedAt },
    ],
  }),
])(
  'does not overwrite corrupt, future, foreign or unexpected stored data: %s',
  async (serialized) => {
    const { store, values, storage } = fixture();
    const key = `cookmate.restore-references.${installation}`;
    values.set(key, serialized);
    await expect(store.load(installation)).rejects.toThrow();
    await expect(
      store.remember(installation, { operationId: operation(3), preparedAt }),
    ).rejects.toThrow();
    await expect(store.forget(installation, operation(1), 'not_dispatched')).rejects.toThrow();
    expect(storage.write).not.toHaveBeenCalled();
    expect(values.get(key)).toBe(serialized);
  },
);

test('a failed write is not reported as persisted and does not poison the queue', async () => {
  const { store, storage } = fixture();
  storage.write.mockRejectedValueOnce(new Error('Storage blocked'));
  await expect(
    store.remember(installation, { operationId: operation(1), preparedAt }),
  ).rejects.toThrow();
  expect(await store.load(installation)).toEqual([]);
  await store.remember(installation, { operationId: operation(2), preparedAt });
  expect(await store.load(installation)).toEqual([{ operationId: operation(2), preparedAt }]);
});

test('retains all twenty references without silently evicting the oldest', async () => {
  const { store, storage } = fixture();
  for (let index = 1; index <= 20; index++)
    await store.remember(installation, { operationId: operation(index), preparedAt });
  await expect(
    store.remember(installation, { operationId: operation(21), preparedAt }),
  ).rejects.toThrow('full');
  expect(storage.write).toHaveBeenCalledTimes(20);
  expect((await store.load(installation))[0]?.operationId).toBe(operation(1));
});

test('invalid identity or timestamp never reaches a write', async () => {
  const { store, storage } = fixture();
  await expect(
    store.remember('another-workspace', { operationId: operation(1), preparedAt }),
  ).rejects.toThrow();
  await expect(
    store.remember(installation, { operationId: operation(1), preparedAt: 'not a date' }),
  ).rejects.toThrow();
  expect(storage.write).not.toHaveBeenCalled();
});

test('many conclusively failed or undispatched attempts release capacity while unrelated references remain', async () => {
  const { store } = fixture();
  await store.remember(installation, { operationId: operation(1), preparedAt });
  for (let index = 2; index <= 45; index++) {
    await store.remember(installation, { operationId: operation(index), preparedAt });
    await store.forget(
      installation,
      operation(index),
      index % 2 ? 'definite_failure' : 'not_dispatched',
    );
  }
  expect(await store.load(installation)).toEqual([{ operationId: operation(1), preparedAt }]);
  await store.remember(installation, { operationId: operation(46), preparedAt });
  expect(await store.load(installation)).toHaveLength(2);
});

test('forget serializes with concurrent saves and a cleanup failure preserves the existing reference', async () => {
  const { store, storage } = fixture();
  await store.remember(installation, { operationId: operation(1), preparedAt });
  storage.write.mockRejectedValueOnce(new Error('Cleanup blocked'));
  await expect(store.forget(installation, operation(1), 'definite_failure')).rejects.toThrow();
  expect(await store.load(installation)).toEqual([{ operationId: operation(1), preparedAt }]);
  await Promise.all([
    store.forget(installation, operation(1), 'definite_failure'),
    store.remember(installation, { operationId: operation(2), preparedAt }),
  ]);
  expect(await store.load(installation)).toEqual([{ operationId: operation(2), preparedAt }]);
});
