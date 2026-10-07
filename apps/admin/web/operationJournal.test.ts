import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationJournal, type PendingOperation } from './operationJournal';
const operation: PendingOperation = {
  operationId: 'e0000000-0000-4000-8000-000000000001',
  userId: 'operator',
  kind: 'save',
  draftId: 'draft',
  createdAt: '2026-09-30T12:00:00.000Z',
};
function fixture() {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    },
  };
}
test('recovery keeps only bounded operation metadata across remount and refuses replacement', () => {
  const f = fixture();
  const store = createOperationJournal(f.storage);
  store.remember(operation);
  assert.deepEqual(createOperationJournal(f.storage).read(), operation);
  assert.throws(() =>
    store.remember({ ...operation, operationId: 'e0000000-0000-4000-8000-000000000002' }),
  );
  assert.equal(f.map.size, 1);
  assert.deepEqual(Object.keys(JSON.parse([...f.map.values()][0]!).pending), [
    'operationId',
    'userId',
    'kind',
    'draftId',
    'createdAt',
  ]);
  store.forget(operation.operationId);
  assert.equal(store.read(), null);
});
test('unknown future or corrupt recovery data is never overwritten', () => {
  for (const raw of [
    '{bad json',
    JSON.stringify({ version: 2, pending: operation }),
    'x'.repeat(4097),
  ]) {
    const f = fixture();
    f.map.set('cookmate.admin.pending.v1', raw);
    const store = createOperationJournal(f.storage);
    assert.throws(() => store.read());
    assert.throws(() => store.remember(operation));
    assert.equal(f.map.get('cookmate.admin.pending.v1'), raw);
  }
});
test('failed persistence prevents a recoverable-operation claim', () => {
  const store = createOperationJournal({
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  assert.throws(() => store.remember(operation), /could not be retained/);
});

test('rights reviews persist only their operation identity, never permission evidence', () => {
  const f = fixture();
  const store = createOperationJournal(f.storage);
  store.remember({ ...operation, kind: 'rights' });
  assert.equal(createOperationJournal(f.storage).read()?.kind, 'rights');
  assert.deepEqual(Object.keys(JSON.parse([...f.map.values()][0]!).pending), [
    'operationId',
    'userId',
    'kind',
    'draftId',
    'createdAt',
  ]);
});

test('metadata review recovery retains its operation identity without values or evidence', () => {
  const f = fixture();
  const store = createOperationJournal(f.storage);
  const pending = { ...operation, kind: 'metadata' as const };
  store.remember(pending);
  assert.deepEqual(createOperationJournal(f.storage).read(), pending);
  assert.deepEqual(Object.keys(JSON.parse([...f.map.values()][0]!).pending), [
    'operationId',
    'userId',
    'kind',
    'draftId',
    'createdAt',
  ]);
});
