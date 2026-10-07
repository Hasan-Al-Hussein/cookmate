import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  createBundledRecipeRevision,
  createRecipeContentRevision,
} from '@cookmate/catalogue/content';
import type { AccountCookingHistoryEntry } from '@cookmate/account-sync';
import { cookingContentIdentity, type CookingHistoryEntry, type RepositoryResult } from '../src';
import { createContentCookingHistoryReader } from '../../../apps/mobile/src/data/contentCookingHistoryRead';
import { createPortableContentBackupReader } from '../../../apps/mobile/src/data/portableContentBackup';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import type {
  ContentCookedReceipt,
  ContentCookingHistoryEntry,
} from '../../../apps/mobile/src/data/contentCookingHistoryRecords';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { retainCookingRevisionInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import {
  historyCount,
  historyRows,
  readAccountCookingScope,
  readHistoryWithdrawalIds,
} from '../../../apps/mobile/src/data/cookingHistoryRows';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Controlled persistence fixtures exercise only the private read boundary; no runtime or hosted
// account integration, signed publication, recipe-body permission or cooked-action authority.
const at = '2026-10-01T12:00:00.000Z';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fingerprint = 'a'.repeat(64);
function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(
  result: { kind: string; error?: { code: string; messageKey: string } },
  key?: string,
) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  assert.equal(Object.hasOwn(result, 'value'), false);
  if (key) assert.equal(result.error?.messageKey, `content.history_${key}`);
}
const wire = (value: CookingHistoryEntry): AccountCookingHistoryEntry => {
  const { revision: _revision, historyEpoch: _epoch, ...entry } = value;
  return entry;
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-history-read-'));
  const path = join(directory, 'cooking.db');
  const write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  const installationId = randomUUID();
  t.after(async () => {
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    {
      installationId,
      shoppingScopeId: randomUUID(),
      conversationId: randomUUID(),
    },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  const db = write.database;
  db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
    ACCOUNT_BINDING_KEY,
    JSON.stringify({ schemaVersion: 1, ownerId }),
  );
  const recipe = catalogue.recipes[0]!;
  const identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  const legacy = (cookedOn: string): CookingHistoryEntry => ({
    ...identity,
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn,
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'Original private note\n🍲  ',
    historyEpoch: 0,
    revision: 1,
  });
  const local = legacy('2026-10-01'),
    backup = { ...legacy('2026-09-30'), origin: 'backup' as const },
    account = wire(legacy('2026-09-29')),
    unresolved = { ...legacy('2026-09-28'), contentFingerprint: 'f'.repeat(64) };
  for (const event of [local, unresolved])
    db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
      event.eventId,
      event.cookedOn,
      at,
      fingerprint,
      JSON.stringify({ kind: 'saved', event, closedSession: null }),
    );
  const restoreId = randomUUID();
  db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
    restoreId,
    fingerprint,
    '{}',
    '{}',
    '{}',
  );
  db.prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)').run(
    backup.eventId,
    randomUUID(),
    restoreId,
    backup.cookedOn,
    at,
    JSON.stringify(backup),
  );
  for (const event of [wire(local), wire(backup), account])
    db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
      ownerId,
      event.eventId,
      JSON.stringify(event),
    );
  db.exec('UPDATE cooking_state SET history_revision=7');
  await migrateCookingContentDatabase(writer, { sha256 });
  const revision = await createRecipeContentRevision(
    authoredFixture(),
    'fixture-history-reader',
    sha256,
  );
  await writer.transaction((session) => retainCookingRevisionInSnapshot(session, revision, sha256));
  const exact: ContentCookingHistoryEntry = {
    readerVersion: 2,
    recipeId: revision.ref.recipeId,
    contentRef: { ...revision.ref },
    eventId: randomUUID(),
    recipeTitle: revision.document.recipe.title,
    photoAssetId: revision.document.media[0]!.assetId,
    cookedOn: '2026-10-02',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'Exact authored history\n量  ',
    historyEpoch: 0,
    revision: 7,
  };
  const receipt: ContentCookedReceipt = { kind: 'saved', event: exact, closedSession: null };
  db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
    exact.eventId,
    exact.cookedOn,
    at,
    fingerprint,
    JSON.stringify(receipt),
  );
  db.prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)').run(
    exact.eventId,
    exact.recipeId,
    revision.ref.revisionId,
    revision.ref.contentFingerprint,
  );
  let access: ContentAdoptionAccess | null = { ownerId, authGeneration: 1 };
  let onHash: ((text: string) => Promise<void>) | undefined;
  const options = {
    reader,
    installationId,
    sha256: async (text: string) => {
      await onHash?.(text);
      return sha256(text);
    },
    getAccess: () => access,
    assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
      assert.deepEqual(scope, access);
      return undefined;
    },
  };
  const history = createContentCookingHistoryReader(options);
  t.after(() => history.close());
  return {
    db,
    read,
    reader,
    writer,
    history,
    local,
    backup,
    account,
    unresolved,
    exact,
    revision,
    receipt,
    installationId,
    recreate(overrideInstallationId = installationId) {
      return createContentCookingHistoryReader({
        ...options,
        installationId: overrideInstallationId,
      });
    },
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    onHash(value: ((text: string) => Promise<void>) | undefined) {
      onHash = value;
    },
  };
}

function snapshot(store: Awaited<ReturnType<typeof fixture>>) {
  return [
    'cooking_event',
    'imported_cooking_history',
    'account_cooking_history',
    'account_cooking_history_removed',
    'cooking_history_withdrawal',
    'local_history_content_pin',
    'imported_history_content_pin',
    'account_history_content_pin',
    'cooking_state',
    'state_revision',
    'app_metadata',
  ].map((table) => ({
    table,
    rows: store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  }));
}

function seedExactAccount(
  store: Awaited<ReturnType<typeof fixture>>,
  entry: Omit<ContentCookingHistoryEntry, 'historyEpoch' | 'revision'>,
) {
  store.db
    .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
    .run(ownerId, entry.eventId, JSON.stringify(entry));
  store.db
    .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
    .run(
      ownerId,
      entry.eventId,
      entry.recipeId,
      entry.contentRef.revisionId,
      entry.contentRef.contentFingerprint,
    );
}

test('actual8 mixed history deduplicates equal exact local/account events, verifies one retained body and preserves data-only account entries', async (t) => {
  const store = await fixture(t);
  await migrateAccountContentHistoryDatabase(store.writer, { sha256 });
  const { historyEpoch: _epoch, revision: _revision, ...wireExact } = store.exact;
  seedExactAccount(store, wireExact);
  const separate = { ...wireExact, eventId: randomUUID(), cookedOn: '2026-10-03' };
  seedExactAccount(store, separate);
  let authoredHashes = 0;
  store.onHash(async (text) => {
    if (text.includes('"kind":"authored"')) authoredHashes++;
  });
  const before = snapshot(store),
    first = ready(await store.history.readHistory({ limit: 2 }));
  assert.deepEqual(
    first.items.map((item) => [item.entry.eventId, item.source]),
    [
      [separate.eventId, 'account'],
      [store.exact.eventId, 'local'],
    ],
  );
  assert.equal(authoredHashes, 1);
  assert.deepEqual(first.items[0]!.entry, { ...separate, historyEpoch: 0, revision: 7 });
  assert.deepEqual(first.items[0]!.pin, { kind: 'exact', ref: store.revision.ref });
  assert.ok(first.nextCursor);
  const rest = ready(await store.history.readHistory({ limit: 50, cursor: first.nextCursor }));
  const items = [...first.items, ...rest.items];
  assert.equal(items.length, 6);
  assert.equal(items.filter((item) => item.entry.eventId === store.exact.eventId).length, 1);
  assert.equal(
    store.db.prepare('SELECT 1 FROM cooking_event WHERE event_id=?').get(separate.eventId),
    undefined,
  );
  assert.deepEqual(snapshot(store), before);
  await assert.rejects(store.reader.transaction((session) => readAccountCookingScope(session)));
  await assert.rejects(store.reader.transaction((session) => historyRows(session, 0, 20)));
  store.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(separate.eventId);
  store.db.exec('UPDATE cooking_state SET history_revision=history_revision+1');
  failed(await store.history.readHistory({ cursor: first.nextCursor }), 'changed');
  const withdrawn = ready(await store.history.readHistory({ limit: 50 }));
  assert.equal(
    withdrawn.items.some((item) => item.entry.eventId === separate.eventId),
    false,
  );
});

test('actual8 hidden equal backup mirror must keep its exact parent pin valid for history and portable capture', async (t) => {
  const store = await fixture(t);
  const alternate = await createRecipeContentRevision(
    store.revision.document,
    'hidden-backup-alternate',
    sha256,
  );
  await store.writer.transaction((session) =>
    retainCookingRevisionInSnapshot(session, alternate, sha256),
  );
  await migrateAccountContentHistoryDatabase(store.writer, { sha256 });
  const restoreId = store.db
    .prepare('SELECT operation_id FROM portable_restore_operation LIMIT 1')
    .get()!.operation_id;
  assert.equal(typeof restoreId, 'string');
  store.db
    .prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)')
    .run(
      store.exact.eventId,
      randomUUID(),
      restoreId!,
      store.exact.cookedOn,
      store.exact.recordedAt,
      JSON.stringify({ ...store.exact, origin: 'backup' }),
    );
  store.db
    .prepare('INSERT INTO imported_history_content_pin VALUES (?,?,?,?,NULL)')
    .run(
      store.exact.eventId,
      store.exact.recipeId,
      store.exact.contentRef.revisionId,
      store.exact.contentRef.contentFingerprint,
    );
  const capture = createPortableContentBackupReader({
    reader: store.reader,
    installationId: store.installationId,
    catalogue: catalogue.identity,
    sha256,
    now: () => at,
    getAccess: () => ({ ownerId, authGeneration: 1 }),
    assertAccess: (scope) => {
      assert.deepEqual(scope, { ownerId, authGeneration: 1 });
      return undefined;
    },
  });
  t.after(() => capture.close());
  const page = ready(await store.history.readHistory({ limit: 50 }));
  assert.deepEqual(
    page.items
      .filter((item) => item.entry.eventId === store.exact.eventId)
      .map((item) => item.source),
    ['local'],
  );
  assert.equal(
    ready(
      await capture.capture({ includeCookingHistory: true }),
    ).data.cookingHistory!.entries.filter((item) => item.entry.eventId === store.exact.eventId)
      .length,
    1,
  );
  store.db
    .prepare(
      'UPDATE imported_history_content_pin SET revision_id=?,content_fingerprint=? WHERE event_id=?',
    )
    .run(alternate.ref.revisionId, alternate.ref.contentFingerprint, store.exact.eventId);
  const before = snapshot(store);
  failed(await store.history.readHistory({ limit: 50 }), 'read_failed');
  assert.equal((await capture.capture({ includeCookingHistory: true })).kind, 'failed');
  assert.deepEqual(snapshot(store), before);
  // SQLite takes the first key while JSON.parse takes the last. A hidden mirror
  // must not pass SQL pin admission with A then deduplicate as the selected B.
  const duplicateRef = `{"contentRef":${JSON.stringify(alternate.ref)},${JSON.stringify({
    ...store.exact,
    origin: 'backup',
  }).slice(1)}`;
  store.db
    .prepare('UPDATE imported_cooking_history SET entry_json=? WHERE event_id=?')
    .run(duplicateRef, store.exact.eventId);
  assert.equal(
    store.db
      .prepare(
        "SELECT json_extract(entry_json,'$.contentRef.revisionId') revision FROM imported_cooking_history WHERE event_id=?",
      )
      .get(store.exact.eventId)!.revision,
    alternate.ref.revisionId,
  );
  assert.equal(JSON.parse(duplicateRef).contentRef.revisionId, store.exact.contentRef.revisionId);
  const conflictingBytes = snapshot(store);
  failed(await store.history.readHistory({ limit: 50 }), 'read_failed');
  assert.equal((await capture.capture({ includeCookingHistory: true })).kind, 'failed');
  assert.deepEqual(snapshot(store), conflictingBytes);
});

test('actual8 rejects immutable-ID conflicts and invalid exact account title, media or pin without rewriting stored evidence', async (t) => {
  for (const problem of ['note', 'date', 'ref', 'v1-v2', 'title', 'media', 'pin'] as const) {
    const store = await fixture(t);
    const other = await createRecipeContentRevision(
      store.revision.document,
      `reader-other-${problem}`,
      sha256,
    );
    await store.writer.transaction((session) =>
      retainCookingRevisionInSnapshot(session, other, sha256),
    );
    await migrateAccountContentHistoryDatabase(store.writer, { sha256 });
    const { historyEpoch: _epoch, revision: _revision, ...wireExact } = store.exact;
    if (problem === 'v1-v2') {
      const legacy = { ...wire(store.local), eventId: store.exact.eventId };
      store.db
        .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
        .run(ownerId, legacy.eventId, JSON.stringify(legacy));
      const ref = (await createBundledRecipeRevision(legacy.recipeId, sha256)).ref;
      store.db
        .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
        .run(ownerId, legacy.eventId, ref.recipeId, ref.revisionId, ref.contentFingerprint);
    } else {
      const entry = {
        ...wireExact,
        ...(['title', 'media', 'pin'].includes(problem) ? { eventId: randomUUID() } : {}),
        ...(problem === 'note' ? { note: 'Different immutable history note' } : {}),
        ...(problem === 'date' ? { cookedOn: '2026-10-03' } : {}),
        ...(problem === 'ref' ? { contentRef: other.ref } : {}),
        ...(problem === 'title' ? { recipeTitle: 'Not the retained recipe title' } : {}),
        ...(problem === 'media' ? { photoAssetId: `sha256:${'f'.repeat(64)}` } : {}),
      };
      seedExactAccount(store, entry);
      if (problem === 'pin')
        store.db
          .prepare(
            'UPDATE account_history_content_pin SET revision_id=?,content_fingerprint=? WHERE event_id=?',
          )
          .run(other.ref.revisionId, other.ref.contentFingerprint, entry.eventId);
    }
    const before = snapshot(store);
    failed(await store.history.readHistory({ limit: 50 }), 'read_failed');
    assert.deepEqual(snapshot(store), before, problem);
  }
});

test('private mixed history sorts and pages exact/local/backup/account records without duplicating strict v1 mirrors or mutating data', async (t) => {
  const store = await fixture(t),
    before = snapshot(store);
  const first = ready(await store.history.readHistory({ limit: 2 }));
  assert.ok(first.nextCursor);
  const second = ready(await store.history.readHistory({ limit: 2, cursor: first.nextCursor }));
  assert.ok(second.nextCursor);
  const third = ready(await store.history.readHistory({ limit: 2, cursor: second.nextCursor }));
  const items = [...first.items, ...second.items, ...third.items];
  assert.deepEqual(
    items.map((item) => item.entry.eventId),
    [store.exact, store.local, store.backup, store.account, store.unresolved].map(
      (event) => event.eventId,
    ),
  );
  assert.deepEqual(
    items.map((item) => item.source),
    ['local', 'local', 'backup', 'account', 'local'],
  );
  assert.deepEqual(items[0]!.entry, store.exact);
  assert.deepEqual(items[0]!.pin, { kind: 'exact', ref: store.revision.ref });
  assert.deepEqual(items[1]!.entry, store.local);
  assert.deepEqual(items[2]!.entry, store.backup);
  assert.deepEqual(items[3]!.entry, { ...store.account, historyEpoch: 0, revision: 7 });
  assert.deepEqual(items[4]!.pin, { kind: 'unresolved', reason: 'content_mismatch' });
  assert.deepEqual(items[1]!.pin, {
    kind: 'exact',
    ref: (await createBundledRecipeRevision(store.local.recipeId, sha256)).ref,
  });
  assert.equal(first.historyRevision, 7);
  assert.equal(first.historyEpoch, 0);
  assert.equal(third.nextCursor, null);
  assert.ok(Object.isFrozen(first.items));
  assert.ok(Object.isFrozen(first.items[0]!.entry));
  assert.deepEqual(snapshot(store), before);
});

test('default page is twenty, maximum is fifty, and the maximum page verifies a bounded lookahead', async (t) => {
  const store = await fixture(t);
  store.db
    .prepare(
      `WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<55),
    ids AS (SELECT printf('99999999-9999-4999-8999-%012x',n) id FROM fixture)
    INSERT INTO cooking_event SELECT id,0,'saved',?,?,?,json_set(?,'$.event.eventId',id) FROM ids`,
    )
    .run(store.exact.cookedOn, at, fingerprint, JSON.stringify(store.receipt));
  store.db
    .prepare(
      `INSERT INTO local_history_content_pin SELECT event_id,?,?,?,NULL FROM cooking_event
    WHERE event_id LIKE '99999999-9999-4999-8999-%'`,
    )
    .run(
      store.exact.recipeId,
      store.revision.ref.revisionId,
      store.revision.ref.contentFingerprint,
    );
  assert.equal(ready(await store.history.readHistory()).items.length, 20);
  const first = ready(await store.history.readHistory({ limit: 50 }));
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const second = ready(await store.history.readHistory({ limit: 50, cursor: first.nextCursor }));
  assert.equal(second.items.length, 10);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((row) => row.entry.eventId)).size, 60);
});

test('account removals, local withdrawals and prior-epoch tombstones hide history without manufacturing receipts', async (t) => {
  const store = await fixture(t);
  // A removed projection is deleted first, while the independent original local receipt remains.
  store.db
    .prepare('DELETE FROM account_history_content_pin WHERE event_id=?')
    .run(store.local.eventId);
  store.db.prepare('DELETE FROM account_cooking_history WHERE event_id=?').run(store.local.eventId);
  store.db
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(ownerId, store.local.eventId);
  store.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(store.backup.eventId);
  store.db
    .prepare("INSERT INTO cooking_event VALUES (?,0,'cancelled',NULL,NULL,NULL,NULL)")
    .run(store.account.eventId);
  const before = snapshot(store),
    page = ready(await store.history.readHistory());
  assert.deepEqual(
    page.items.map((row) => row.entry.eventId),
    [store.exact.eventId, store.unresolved.eventId],
  );
  assert.deepEqual(snapshot(store), before);
});

test('strict cursors reject stale history revision, history epoch and restore epoch', async (t) => {
  const store = await fixture(t),
    first = ready(await store.history.readHistory({ limit: 1 }));
  assert.ok(first.nextCursor);
  store.db.exec('UPDATE cooking_state SET history_revision=8');
  failed(await store.history.readHistory({ cursor: first.nextCursor }), 'changed');
  store.db.exec('UPDATE cooking_state SET history_revision=7,history_epoch=1');
  failed(await store.history.readHistory({ cursor: first.nextCursor }), 'changed');
  store.db.exec('UPDATE cooking_state SET history_epoch=0');
  store.db
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run('account-replication:apply-epoch', '2');
  failed(await store.history.readHistory({ cursor: first.nextCursor }), 'changed');
});

test('malformed page/cursor requests fail before reading stored payloads', async (t) => {
  const store = await fixture(t),
    first = ready(await store.history.readHistory({ limit: 1 }));
  assert.ok(first.nextCursor);
  const cursor = JSON.parse(first.nextCursor) as Record<string, unknown>;
  for (const request of [
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { limit: null },
    { cursor: '{}' },
    { cursor: 'x'.repeat(1025) },
    { cursor: JSON.stringify({ ...cursor, extra: true }) },
    { cursor: JSON.stringify({ ...cursor, cookedOn: '2026-02-30' }) },
    { cursor: JSON.stringify({ ...cursor, historyRevision: -1 }) },
  ])
    failed(
      await store.history.readHistory(request as Parameters<typeof store.history.readHistory>[0]),
      'invalid_page',
    );
});

test('a cursor cannot transfer to a recreated reader with different owner, generation or installation even at identical clocks', async (t) => {
  const store = await fixture(t),
    first = ready(await store.history.readHistory({ limit: 1 }));
  assert.ok(first.nextCursor);
  const before = snapshot(store),
    originalAll = store.read.connection.all;
  let queries = 0;
  store.read.connection.all = async <Row extends object>(
    sql: string,
    values: readonly SqlValue[] = [],
  ) => {
    queries++;
    return originalAll<Row>(sql, values);
  };
  try {
    for (const scope of [
      { ownerId: otherOwner, authGeneration: 1, installationId: store.installationId },
      { ownerId, authGeneration: 2, installationId: store.installationId },
      { ownerId, authGeneration: 1, installationId: randomUUID() },
    ]) {
      store.setAccess({ ownerId: scope.ownerId, authGeneration: scope.authGeneration });
      const recreated = store.recreate(scope.installationId);
      try {
        queries = 0;
        failed(await recreated.readHistory({ cursor: first.nextCursor }), 'access_changed');
        assert.equal(queries, 0, 'foreign cursor is denied before querying the database');
      } finally {
        recreated.close();
      }
    }
    assert.deepEqual(snapshot(store), before);
  } finally {
    store.read.connection.all = originalAll;
  }
});

test('legacy shared history APIs refuse schema seven without the explicit full-view read option', async (t) => {
  const store = await fixture(t),
    before = snapshot(store);
  for (const work of [
    () => store.reader.transaction((session) => historyRows(session, 0, 20)),
    () => store.reader.transaction((session) => historyCount(session, 0)),
    () => store.reader.transaction(readAccountCookingScope),
    () => store.reader.transaction(readHistoryWithdrawalIds),
  ])
    await assert.rejects(work());
  assert.equal(
    await store.reader.transaction((session) => historyCount(session, 0, { contentSchema: true })),
    5,
  );
  assert.deepEqual(snapshot(store), before);
});

test('a version-two local event colliding with version-one account data fails instead of discarding its exact ref', async (t) => {
  const store = await fixture(t);
  store.db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
    ownerId,
    store.exact.eventId,
    JSON.stringify({
      ...store.account,
      eventId: store.exact.eventId,
      cookedOn: store.exact.cookedOn,
    }),
  );
  const legacyRef = (await createBundledRecipeRevision(store.account.recipeId, sha256)).ref;
  store.db
    .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
    .run(
      ownerId,
      store.exact.eventId,
      legacyRef.recipeId,
      legacyRef.revisionId,
      legacyRef.contentFingerprint,
    );
  const before = snapshot(store);
  failed(await store.history.readHistory(), 'read_failed');
  assert.deepEqual(snapshot(store), before);
});

test('foreign account contamination and owner binding replacement yield no history payload', async (t) => {
  const store = await fixture(t);
  store.db
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(otherOwner, randomUUID());
  failed(await store.history.readHistory(), 'read_failed');
  store.db.prepare('DELETE FROM account_cooking_history_removed WHERE owner_id=?').run(otherOwner);
  store.db
    .prepare('UPDATE app_metadata SET value=? WHERE key=?')
    .run(JSON.stringify({ schemaVersion: 1, ownerId: otherOwner }), ACCOUNT_BINDING_KEY);
  failed(await store.history.readHistory(), 'access_changed');
});

test('orphan local, backup and account pins cannot survive a successful history read', async (t) => {
  const store = await fixture(t);
  for (const table of [
    'local_history_content_pin',
    'imported_history_content_pin',
    'account_history_content_pin',
  ]) {
    const eventId = randomUUID();
    store.db.exec('PRAGMA foreign_keys=OFF');
    if (table === 'account_history_content_pin')
      store.db
        .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
        .run(
          ownerId,
          eventId,
          store.exact.recipeId,
          store.revision.ref.revisionId,
          store.revision.ref.contentFingerprint,
        );
    else
      store.db
        .prepare(`INSERT INTO ${table} VALUES (?,?,?,?,NULL)`)
        .run(
          eventId,
          store.exact.recipeId,
          store.revision.ref.revisionId,
          store.revision.ref.contentFingerprint,
        );
    store.db.exec('PRAGMA foreign_keys=ON');
    const before = snapshot(store);
    failed(await store.history.readHistory(), 'read_failed');
    assert.deepEqual(snapshot(store), before);
    store.db.prepare(`DELETE FROM ${table} WHERE event_id=?`).run(eventId);
  }
});

test('malformed or oversized parents are rejected without raw over-limit projection or storage rewrites', async (t) => {
  const store = await fixture(t),
    originalAll = store.read.connection.all;
  let largest = 0;
  store.read.connection.all = async <Row extends object>(
    sql: string,
    values: readonly SqlValue[] = [],
  ) => {
    const rows = await originalAll<Row>(sql, values);
    for (const row of rows)
      for (const value of Object.values(row))
        if (typeof value === 'string') largest = Math.max(largest, Buffer.byteLength(value));
    return rows;
  };
  try {
    for (const receipt of [
      'not-json',
      JSON.stringify({ extra: 'x'.repeat(32769) }),
      JSON.stringify({
        ...store.receipt,
        event: { ...store.exact, recipeTitle: 'Changed exact title' },
      }),
    ]) {
      store.db.exec('PRAGMA ignore_check_constraints=ON');
      store.db
        .prepare('UPDATE cooking_event SET receipt_json=? WHERE event_id=?')
        .run(receipt, store.exact.eventId);
      store.db.exec('PRAGMA ignore_check_constraints=OFF');
      const before = snapshot(store);
      largest = 0;
      failed(await store.history.readHistory(), 'read_failed');
      assert.ok(largest <= 32768);
      assert.deepEqual(snapshot(store), before);
    }
    // The first visible item is valid; malformed evidence in the one-row lookahead still denies
    // the page instead of emitting a cursor over unchecked history.
    store.db
      .prepare('UPDATE cooking_event SET receipt_json=? WHERE event_id=?')
      .run(JSON.stringify(store.receipt), store.exact.eventId);
    store.db
      .prepare('DELETE FROM account_history_content_pin WHERE event_id=?')
      .run(store.local.eventId);
    store.db
      .prepare('DELETE FROM account_cooking_history WHERE event_id=?')
      .run(store.local.eventId);
    store.db
      .prepare('UPDATE cooking_event SET receipt_json=? WHERE event_id=?')
      .run('{}', store.local.eventId);
    const before = snapshot(store);
    failed(await store.history.readHistory({ limit: 1 }), 'read_failed');
    assert.deepEqual(snapshot(store), before);
  } finally {
    store.read.connection.all = originalAll;
  }
});

test('owner revocation during an asynchronous content digest suppresses the completed page', async (t) => {
  const store = await fixture(t),
    before = snapshot(store);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  store.onHash(async (text) => {
    if (!paused && text.startsWith('["cookmate-recipe-content-v1",')) {
      paused = true;
      entered();
      await gate;
    }
  });
  const pending = store.history.readHistory({ limit: 1 });
  try {
    await reached;
    store.setAccess(null);
    release();
    failed(await pending, 'access_changed');
    assert.deepEqual(snapshot(store), before);
  } finally {
    release();
    store.onHash(undefined);
  }
});

test('closed readers and changed auth generations cannot return even an empty or previously readable page', async (t) => {
  const store = await fixture(t);
  store.setAccess({ ownerId, authGeneration: 2 });
  failed(await store.history.readHistory(), 'access_changed');
  store.setAccess({ ownerId, authGeneration: 1 });
  store.history.close();
  failed(await store.history.readHistory(), 'access_changed');
});
