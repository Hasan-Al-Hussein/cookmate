import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentPrivateState, type ContentPrivateState } from './contentPrivateState';
import { encodeAppPreferences } from '../app-preferences/preferences';
import type { ContentCookingReference } from '../cooking/contentCookingReferences';

const installationId = '670a0000-0000-4000-8000-000000000001';
const anotherInstallation = '670a0000-0000-4000-8000-000000000002';
const ownerId = '670b0000-0000-4000-8000-000000000001';
const anotherOwner = '670b0000-0000-4000-8000-000000000002';
const operationId = '670c0000-0000-4000-8000-000000000001';
const timestamp = '2026-10-02T00:00:00.000Z';
const cooking: ContentCookingReference = {
  kind: 'cooked',
  createdAt: timestamp,
  reference: {
    formatVersion: 1,
    eventId: operationId,
    requestFingerprint: 'a'.repeat(64),
    contentRef: {
      recipeId: '52819',
      revisionId: 'retained-one',
      contentFingerprint: 'b'.repeat(64),
    },
    expectedHistoryEpoch: 0,
    session: null,
  },
};
const preferenceText = encodeAppPreferences({ theme: 'dark', motion: 'reduced', locale: 'ar' });
const personalText = JSON.stringify({
  schemaVersion: 1,
  installationId,
  operations: [{ operationId, createdAt: timestamp }],
});
const guestRows = () =>
  new Map<string, string>([
    [`cookmate.presentation-preferences.content.${installationId}`, preferenceText],
    ...['notes', 'manual', 'collections'].map((family): [string, string] => [
      `content-${family}:cookmate.personal-recovery.${installationId}`,
      personalText,
    ]),
    [
      `cookmate.content-cooking-recovery.${installationId}`,
      JSON.stringify({ formatVersion: 1, installationId, records: [cooking] }),
    ],
    [
      `cookmate.cooking-recovery.${installationId}`,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        operations: [{ operationId, kind: 'clear_history', recipeId: null, createdAt: timestamp }],
      }),
    ],
    [
      `cookmate.content-restore-references.${installationId}`,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        operations: [{ operationId, preparedAt: timestamp }],
      }),
    ],
  ]);
function fixture(values = new Map<string, string>()) {
  const reads: string[] = [],
    writes: string[] = [];
  const storage = {
    async read(key: string) {
      reads.push(key);
      return values.get(key) ?? null;
    },
    async write(key: string, value: string) {
      writes.push(key);
      values.set(key, value);
    },
  };
  return { values, reads, writes, storage };
}
async function counts(bundle: ContentPrivateState, id = installationId) {
  return Promise.all(
    Object.values(bundle.references).map(async (store) => (await store.load(id)).length),
  );
}
async function populate(bundle: ContentPrivateState) {
  for (const family of ['notes', 'manual', 'collections'] as const)
    await bundle.references[family].remember(installationId, operationId);
  await bundle.references.cooking.remember(installationId, cooking);
  await bundle.references.history.remember(installationId, {
    operationId,
    kind: 'clear_history',
    recipeId: null,
    createdAt: timestamp,
  });
  await bundle.references.restore.remember(installationId, { operationId, preparedAt: timestamp });
}

test('guest bundle reads all existing exact keys without rewriting bytes or creating a new draft namespace', async () => {
  const f = fixture(guestRows()),
    before = [...f.values];
  const bundle = createContentPrivateState({ installationId, ownerId: null }, f.storage);
  assert.equal(bundle.draftScopeKey, `content:${installationId}`);
  assert.equal(await bundle.preferences.read(), preferenceText);
  assert.deepEqual(await counts(bundle), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(new Set(f.reads), new Set(f.values.keys()));
  assert.deepEqual([...f.values], before);
  assert.deepEqual(f.writes, []);
  assert.ok(
    Object.isFrozen(bundle) && Object.isFrozen(bundle.scope) && Object.isFrozen(bundle.references),
  );
});
test('owner bundles never inherit guest or another owner recovery and reopen their own exact records', async () => {
  const f = fixture(guestRows()),
    before = [...f.values];
  const a = createContentPrivateState({ installationId, ownerId }, f.storage);
  const b = createContentPrivateState({ installationId, ownerId: anotherOwner }, f.storage);
  assert.deepEqual(await counts(a), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(await counts(b), [0, 0, 0, 0, 0, 0]);
  await populate(a);
  assert.deepEqual(
    await counts(createContentPrivateState({ installationId, ownerId }, f.storage)),
    [1, 1, 1, 1, 1, 1],
  );
  assert.deepEqual(await counts(b), [0, 0, 0, 0, 0, 0]);
  for (const [key, value] of before) assert.equal(f.values.get(key), value);
  for (const key of f.writes) {
    assert.ok(key.startsWith(`cookmate.content-private.${installationId}.${ownerId}:`));
    const record: unknown = JSON.parse(f.values.get(key)!);
    assert.equal((record as { installationId: string }).installationId, installationId);
  }
  assert.notEqual(a.draftScopeKey, b.draftScopeKey);
  assert.notEqual(a.draftScopeKey, `content:${installationId}`);
});
test('the same owner in another installation is distinct and every codec rejects a foreign installation before I/O', async () => {
  const f = fixture();
  const a = createContentPrivateState({ installationId, ownerId }, f.storage);
  await populate(a);
  const other = createContentPrivateState(
    { installationId: anotherInstallation, ownerId },
    f.storage,
  );
  assert.deepEqual(await counts(other, anotherInstallation), [0, 0, 0, 0, 0, 0]);
  assert.notEqual(other.draftScopeKey, a.draftScopeKey);
  const reads = f.reads.length,
    writes = f.writes.length;
  for (const store of Object.values(a.references))
    await assert.rejects(async () => store.load(anotherInstallation), /installation changed/);
  assert.equal(f.reads.length, reads);
  assert.equal(f.writes.length, writes);
});
test('account display preferences require the existing settings owner and an override is captured exclusively', async () => {
  const f = fixture();
  const bare = createContentPrivateState({ installationId, ownerId }, f.storage);
  await assert.rejects(bare.preferences.read(), /Account preference store required/);
  await assert.rejects(bare.preferences.write(preferenceText), /Account preference store required/);
  let text = preferenceText,
    subscriptions = 0;
  const preferences = {
    async read() {
      return text;
    },
    async write(value: string) {
      text = value;
    },
    subscribe(_listener: () => void) {
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
  };
  const bundle = createContentPrivateState({ installationId, ownerId }, f.storage, { preferences });
  preferences.read = async () => {
    throw new Error('replaced port');
  };
  preferences.write = async () => {
    throw new Error('replaced port');
  };
  assert.equal(await bundle.preferences.read(), preferenceText);
  await bundle.preferences.write('owned controller input');
  assert.equal(text, 'owned controller input');
  const unsubscribe = bundle.preferences.subscribe!(() => undefined);
  assert.equal(subscriptions, 1);
  unsubscribe();
  assert.equal(subscriptions, 0);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});
test('scope and storage callbacks are owned before queued work', async () => {
  const f = fixture();
  const scope = { installationId, ownerId };
  const bundle = createContentPrivateState(scope, f.storage);
  scope.installationId = anotherInstallation;
  scope.ownerId = anotherOwner;
  f.storage.read = async () => {
    throw new Error('changed read');
  };
  f.storage.write = async () => {
    throw new Error('changed write');
  };
  await bundle.references.notes.remember(installationId, operationId);
  assert.deepEqual(bundle.scope, { installationId, ownerId });
  assert.deepEqual(f.writes, [
    `cookmate.content-private.${installationId}.${ownerId}:content-notes:cookmate.personal-recovery.${installationId}`,
  ]);
});
test('invalid or accessor-bearing scope cannot choose storage keys or execute a getter', () => {
  const f = fixture();
  for (const scope of [
    { installationId: installationId + '\n', ownerId },
    { installationId, ownerId: ownerId + '\n' },
    { installationId: '../guest', ownerId },
    { installationId, ownerId: 'guest' },
    { installationId, ownerId, extra: 'x' },
    { installationId, ownerId, extra: 'x'.repeat(2048) },
  ])
    assert.throws(() => createContentPrivateState(scope, f.storage));
  let getterCalls = 0;
  const hostile = {
    installationId,
    get ownerId() {
      getterCalls++;
      return ownerId;
    },
  };
  assert.throws(() => createContentPrivateState(hostile, f.storage));
  assert.equal(getterCalls, 0);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.writes, []);
});
test('corrupt owner metadata fails closed without consulting valid guest records or replacing the original', async () => {
  const f = fixture(guestRows());
  const key = `cookmate.content-private.${installationId}.${ownerId}:content-notes:cookmate.personal-recovery.${installationId}`;
  f.values.set(key, '{invalid');
  const bundle = createContentPrivateState({ installationId, ownerId }, f.storage);
  await assert.rejects(bundle.references.notes.load(installationId));
  await assert.rejects(bundle.references.notes.remember(installationId, operationId));
  assert.equal(f.values.get(key), '{invalid');
  assert.deepEqual(new Set(f.reads), new Set([key]));
  assert.deepEqual(f.writes, []);
});
