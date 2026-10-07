import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createRecipeContentRevision } from '@cookmate/catalogue/content';
import {
  cookingContentIdentity,
  type CookingHistoryEntry,
  type CookingSession,
  type RepositoryResult,
} from '../src';
import {
  validatePortableContentBackup,
  type PortableContentHistoryRecord,
} from '../src/portableBackupContent';
import { createContentCookingHistory } from '../../../apps/mobile/src/data/contentCookingHistory';
import { createContentCookingHistoryClear } from '../../../apps/mobile/src/data/contentCookingHistoryClear';
import { createContentCookingHistoryReader } from '../../../apps/mobile/src/data/contentCookingHistoryRead';
import {
  validateContentCookedReceipt,
  validateContentCookingHistoryEntry,
  validateImportedContentCookingHistoryEntry,
  type ImportedContentCookingHistoryEntry,
} from '../../../apps/mobile/src/data/contentCookingHistoryRecords';
import {
  readHistoryContentPins,
  readStoredLocalCookingEvent,
  retainCookingRevisionInSnapshot,
  verifyHistoryContentBindings,
} from '../../../apps/mobile/src/data/cookingContentRepository';
import {
  historyCount,
  historyRows,
  parseImportedHistory,
  type HistoryRow,
} from '../../../apps/mobile/src/data/cookingHistoryRows';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { createPortableContentBackupReader } from '../../../apps/mobile/src/data/portableContentBackup';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Real disposable SQLite and local integrity evidence. Seeded imports are data-only fixtures,
// not proof of a signed publication, completed restore, action receipt or mounted application.
const at = '2026-10-01T12:00:00.000Z';
const privateNote = '  Imported private note\nكمية 🍲\u0000\\  ';
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: { kind: string }) {
  assert.equal(result.kind, 'failed');
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-imported-content-history-'));
  const filename = join(directory, 'cooking.db');
  async function open() {
    const write = desktopConnection(filename),
      read = desktopConnection(filename);
    await configureConnection(write.connection);
    await configureConnection(read.connection);
    const queue = new SqlTransactionQueue();
    return {
      write,
      read,
      writer: new SerializedWriter(write.connection, queue),
      reader: new SerializedReader(read.connection, queue),
    };
  }
  let current = await open();
  const connections = [current],
    hosts: { close(): void }[] = [];
  t.after(async () => {
    for (const host of hosts) host.close();
    for (const connection of connections) {
      await connection.reader.close();
      await connection.writer.close();
    }
    await removeFixtureDirectory(directory);
  });
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(
    current.writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    ids,
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  const db = current.write.database,
    recipe = catalogue.recipes[0]!;
  const identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  const legacy: CookingHistoryEntry = {
    ...identity,
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-09-29',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'Legacy bytes preserved  ',
    historyEpoch: 0,
    revision: 1,
  };
  const legacyReceipt = JSON.stringify(
    { kind: 'saved', event: legacy, closedSession: null },
    null,
    2,
  );
  db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
    legacy.eventId,
    legacy.cookedOn,
    at,
    'a'.repeat(64),
    legacyReceipt,
  );
  const restoreId = randomUUID(),
    legacySourceId = randomUUID();
  db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
    restoreId,
    'a'.repeat(64),
    '{}',
    '{}',
    '{}',
  );
  const legacyBackup = { ...legacy, eventId: randomUUID(), origin: 'backup' as const };
  const legacyBackupJson = JSON.stringify(legacyBackup, null, 2);
  db.prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)').run(
    legacyBackup.eventId,
    legacySourceId,
    restoreId,
    legacyBackup.cookedOn,
    at,
    legacyBackupJson,
  );
  const session: CookingSession = {
    ...identity,
    sessionId: randomUUID(),
    revision: 1,
    passageSequence: recipe.instructions[0]!.sequence,
    state: 'active',
    updatedAt: at,
    lastOperationId: randomUUID(),
  };
  db.prepare('INSERT INTO cooking_session VALUES (?,?,?,?,?,?,?,?)').run(
    recipe.recipeId,
    session.sessionId,
    1,
    session.state,
    at,
    session.lastOperationId,
    'a'.repeat(64),
    JSON.stringify(session, null, 2),
  );
  const occurrenceId = randomUUID();
  db.prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)').run(
    occurrenceId,
    recipe.recipeId,
    '2026-10-01',
    'dinner',
    at,
    at,
  );
  db.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(recipe.recipeId, at, at);
  db.prepare("INSERT INTO manual_shopping_item VALUES (?,?,NULL,NULL,'pantry',0,0,1,?,?)").run(
    randomUUID(),
    JSON.stringify('Keep personal item'),
    at,
    at,
  );
  db.exec(
    "UPDATE cooking_state SET history_revision=3,session_revision=1; UPDATE state_revision SET revision=3 WHERE collection='store'",
  );
  await migrateCookingContentDatabase(current.writer, { sha256 });
  const document = authoredFixture('90001');
  document.recipe.title = 'Original authored imported recipe';
  const first = await createRecipeContentRevision(document, 'imported-first', sha256);
  const next = clone(document);
  next.recipe.title = 'Later authored imported recipe';
  const second = await createRecipeContentRevision(next, 'imported-second', sha256);
  const exact: ImportedContentCookingHistoryEntry[] = [],
    sourceIds: string[] = [];
  for (const [index, revision] of [first, second].entries()) {
    await current.writer.transaction((sql) =>
      retainCookingRevisionInSnapshot(sql, revision, sha256),
    );
    const entry: ImportedContentCookingHistoryEntry = {
      readerVersion: 2,
      recipeId: revision.ref.recipeId,
      contentRef: { ...revision.ref },
      eventId: randomUUID(),
      recipeTitle: revision.document.recipe.title,
      photoAssetId: index ? null : revision.document.media[0]!.assetId,
      cookedOn: `2026-09-${30 - index}`,
      timeZone: 'Asia/Dubai',
      recordedAt: at,
      note: privateNote,
      historyEpoch: 0,
      revision: 3,
      origin: 'backup',
    };
    const sourceId = randomUUID();
    db.prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)').run(
      entry.eventId,
      sourceId,
      restoreId,
      entry.cookedOn,
      at,
      JSON.stringify(entry, null, 2),
    );
    db.prepare('INSERT INTO imported_history_content_pin VALUES (?,?,?,?,NULL)').run(
      entry.eventId,
      entry.recipeId,
      entry.contentRef.revisionId,
      entry.contentRef.contentFingerprint,
    );
    exact.push(entry);
    sourceIds.push(sourceId);
  }
  const access: ContentAdoptionAccess = { ownerId: null, authGeneration: 0 };
  function options() {
    return {
      reader: current.reader,
      writer: current.writer,
      installationId: ids.installationId,
      sha256,
      getAccess: () => access,
      assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
        assert.deepEqual(scope, access);
        return undefined;
      },
      now: () => at,
      onCommitted() {},
    };
  }
  function history() {
    const host = createContentCookingHistoryReader(options());
    hosts.push(host);
    return host;
  }
  function capture() {
    const host = createPortableContentBackupReader({ ...options(), catalogue: catalogue.identity });
    hosts.push(host);
    return host;
  }
  function clear() {
    const host = createContentCookingHistoryClear({ ...options(), newId: randomUUID });
    hosts.push(host);
    return host;
  }
  function snapshot(tables?: readonly string[]) {
    const selected =
      tables ??
      (
        current.write.database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
    return selected.map((table) => ({
      table,
      rows: current.write.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    }));
  }
  return {
    ids,
    legacy,
    legacyReceipt,
    legacyBackup,
    legacyBackupJson,
    legacySourceId,
    restoreId,
    exact,
    sourceIds,
    first,
    second,
    options,
    history,
    capture,
    clear,
    snapshot,
    get db() {
      return current.write.database;
    },
    get read() {
      return current.read;
    },
    get reader() {
      return current.reader;
    },
    get writer() {
      return current.writer;
    },
    async reopen() {
      await current.reader.close();
      await current.writer.close();
      current = await open();
      connections.push(current);
      assert.equal(await migrateCookingContentDatabase(current.writer, { sha256 }), 'existing');
    },
    async verify() {
      await current.reader.transaction((sql) => verifyHistoryContentBindings(sql, sha256), {
        kind: 'read_only',
      });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rejectsUnchanged(f: Fixture) {
  const before = f.snapshot();
  await assert.rejects(f.verify());
  failed(await f.history().readHistory());
  failed(await f.capture().capture({ includeCookingHistory: true }));
  failed(await f.clear().reviewClearHistory());
  assert.deepEqual(f.snapshot(), before);
}

test('imported exact data admits only the backup marker while local entry and receipt validators remain strict', async (t) => {
  const f = await fixture(t),
    entry = f.exact[0]!;
  assert.equal(validateImportedContentCookingHistoryEntry(entry), true);
  assert.equal(validateContentCookingHistoryEntry(entry), false);
  assert.equal(
    validateContentCookedReceipt({ kind: 'saved', event: entry, closedSession: null }),
    false,
  );
  const { origin: _origin, ...local } = entry;
  assert.equal(validateContentCookingHistoryEntry(local), true);
  let invoked = 0;
  const accessor = { ...entry };
  Object.defineProperty(accessor, 'origin', {
    enumerable: true,
    get() {
      invoked++;
      throw new Error('getter executed');
    },
  });
  for (const invalid of [
    local,
    { ...entry, origin: 'local' },
    { ...entry, closedSession: null },
    { ...entry, receipt: {} },
    { ...entry, requestFingerprint: 'a'.repeat(64) },
    { ...entry, note: 'x'.repeat(32769) },
    accessor,
  ])
    assert.equal(validateImportedContentCookingHistoryEntry(invalid), false);
  assert.equal(invoked, 0);
});

test('schema seven reads, captures and reopens both imported exact revisions without altering v1 bytes or adding local authority', async (t) => {
  const f = await fixture(t),
    before = f.snapshot();
  await f.verify();
  const page = ready(await f.history().readHistory());
  assert.equal(page.items.length, 4);
  for (const expected of f.exact) {
    const item = page.items.find((row) => row.entry.eventId === expected.eventId)!;
    assert.equal(item.source, 'backup');
    assert.deepEqual(item.entry, expected);
    assert.deepEqual(item.pin, { kind: 'exact', ref: expected.contentRef });
    assert.ok(Object.isFrozen(item.entry));
  }
  const pins = await f.reader.transaction((sql) =>
    readHistoryContentPins(sql, { source: 'backup', sha256 }),
  );
  assert.equal(pins.items.length, 3);
  const exported = ready(await f.capture().capture({ includeCookingHistory: true }));
  assert.equal(exported.data.cookingHistory?.entries.length, 4);
  for (const expected of f.exact) {
    const record: Readonly<PortableContentHistoryRecord> =
      exported.data.cookingHistory!.entries.find((row) => row.entry.eventId === expected.eventId)!;
    assert.equal(record.kind, 'exact');
    const { origin: _origin, ...wire } = expected;
    assert.deepEqual(record.entry, wire);
    assert.equal(Object.hasOwn(record.entry, 'origin'), false);
  }
  assert.equal(
    (await validatePortableContentBackup(JSON.stringify(exported), { sha256 })).kind,
    'ready',
  );
  assert.equal(
    f.db.prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?').get(f.legacy.eventId)!
      .receipt_json,
    f.legacyReceipt,
  );
  assert.equal(
    f.db
      .prepare('SELECT entry_json FROM imported_cooking_history WHERE event_id=?')
      .get(f.legacyBackup.eventId)!.entry_json,
    f.legacyBackupJson,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM content_cooking_event_authority').get()!.n, 0);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM recipe WHERE recipe_id=?').get(f.first.ref.recipeId)!.n,
    0,
  );
  assert.deepEqual(f.snapshot(), before);
  await f.reopen();
  assert.deepEqual(ready(await f.history().readHistory()), page);
  assert.deepEqual(f.snapshot(), before);
});

test('imported exact entries cannot recover, resolve or mint local cooked receipts', async (t) => {
  const f = await fixture(t),
    before = f.snapshot();
  let bodyReads = 0;
  const host = createContentCookingHistory({
    ...f.options(),
    contentStore: {
      async withVerifiedReading() {
        bodyReads++;
        throw new Error('No content access in receipt recovery');
      },
    },
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
  });
  t.after(() => host.close());
  for (const eventId of [f.exact[0]!.eventId, f.sourceIds[0]!]) {
    const input = {
      eventId,
      contentRef: f.exact[0]!.contentRef,
      expectedHistoryEpoch: 0,
      cookedOn: f.exact[0]!.cookedOn,
      timeZone: f.exact[0]!.timeZone,
      note: privateNote,
    };
    assert.equal(ready(await host.recover(input)), null);
    failed(await host.resolveCookedOperation(input));
    assert.equal(
      await f.reader.transaction((sql) => readStoredLocalCookingEvent(sql, eventId, { sha256 })),
      null,
    );
  }
  assert.equal(bodyReads, 0);
  assert.deepEqual(f.snapshot(), before);
});

test('imported entry payloads cannot smuggle receipts, mismatch parent columns, or substitute retained title/media evidence', async (t) => {
  const f = await fixture(t),
    original = f.exact[0]!;
  const rewrite = (value: unknown) =>
    f.db
      .prepare('UPDATE imported_cooking_history SET entry_json=? WHERE event_id=?')
      .run(JSON.stringify(value, null, 2), original.eventId);
  for (const bad of [
    { ...original, origin: undefined },
    { ...original, origin: 'local' },
    { ...original, closedSession: null },
    { ...original, eventId: randomUUID() },
    { ...original, historyEpoch: 1 },
    { ...original, cookedOn: '2026-09-28' },
    { ...original, recordedAt: '2026-10-01T13:00:00.000Z' },
    { ...original, recipeId: f.legacy.recipeId },
    { ...original, recipeTitle: 'Incorrect retained title' },
    { ...original, photoAssetId: `sha256:${'b'.repeat(64)}` },
  ]) {
    rewrite(bad);
    await rejectsUnchanged(f);
  }
  rewrite(original);
  await f.verify();
});

test('exact imported pins reject same-recipe revision substitution, unresolved pins and missing parents without repair', async (t) => {
  const f = await fixture(t),
    entry = f.exact[0]!,
    ref = entry.contentRef;
  const restore = () => {
    f.db.prepare('DELETE FROM imported_history_content_pin WHERE event_id=?').run(entry.eventId);
    f.db
      .prepare('INSERT INTO imported_history_content_pin VALUES (?,?,?,?,NULL)')
      .run(entry.eventId, entry.recipeId, ref.revisionId, ref.contentFingerprint);
  };
  f.db
    .prepare(
      'UPDATE imported_history_content_pin SET revision_id=?,content_fingerprint=? WHERE event_id=?',
    )
    .run(f.second.ref.revisionId, f.second.ref.contentFingerprint, entry.eventId);
  await rejectsUnchanged(f);
  restore();
  f.db
    .prepare(
      "UPDATE imported_history_content_pin SET revision_id=NULL,content_fingerprint=NULL,unresolved_reason='content_mismatch' WHERE event_id=?",
    )
    .run(entry.eventId);
  await rejectsUnchanged(f);
  restore();
  f.db.prepare('DELETE FROM imported_history_content_pin WHERE event_id=?').run(entry.eventId);
  await rejectsUnchanged(f);
  restore();
  f.db.exec('PRAGMA foreign_keys=OFF');
  const orphanId = randomUUID();
  f.db
    .prepare('INSERT INTO imported_history_content_pin VALUES (?,?,?,?,NULL)')
    .run(orphanId, ref.recipeId, ref.revisionId, ref.contentFingerprint);
  f.db.exec('PRAGMA foreign_keys=ON');
  await rejectsUnchanged(f);
  f.db.prepare('DELETE FROM imported_history_content_pin WHERE event_id=?').run(orphanId);
  await f.verify();
});

test('backup lineage UUIDs and restore-ledger existence are required even after FK-disabled corruption', async (t) => {
  const f = await fixture(t),
    eventId = f.exact[0]!.eventId;
  f.db
    .prepare('UPDATE imported_cooking_history SET source_event_id=? WHERE event_id=?')
    .run('not-a-uuid', eventId);
  await rejectsUnchanged(f);
  f.db
    .prepare('UPDATE imported_cooking_history SET source_event_id=? WHERE event_id=?')
    .run(f.sourceIds[0]!, eventId);
  for (const restoreId of ['not-a-uuid', randomUUID()]) {
    f.db.exec('PRAGMA foreign_keys=OFF');
    f.db
      .prepare('UPDATE imported_cooking_history SET restore_operation_id=? WHERE event_id=?')
      .run(restoreId, eventId);
    f.db.exec('PRAGMA foreign_keys=ON');
    await rejectsUnchanged(f);
  }
  f.db
    .prepare('UPDATE imported_cooking_history SET restore_operation_id=? WHERE event_id=?')
    .run(f.restoreId, eventId);
  await f.verify();
});

test('oversized imported payloads and NUL-suffixed lineage fail before raw materialization', async (t) => {
  const f = await fixture(t),
    entry = f.exact[0]!,
    originalAll = f.read.connection.all;
  let largest = 0;
  f.read.connection.all = async <Row extends object>(
    sql: string,
    values: readonly SqlValue[] = [],
  ) => {
    const rows = await originalAll<Row>(sql, values);
    for (const row of rows)
      for (const value of Object.values(row))
        if (typeof value === 'string') largest = Math.max(largest, Buffer.byteLength(value));
    return rows;
  };
  for (const column of ['entry_json', 'source_event_id', 'restore_operation_id'] as const) {
    const original = f.db
      .prepare(`SELECT ${column} value FROM imported_cooking_history WHERE event_id=?`)
      .get(entry.eventId)!.value!;
    const large =
      column === 'entry_json'
        ? JSON.stringify({ oversized: 'x'.repeat(70_000) })
        : `${original}\u0000${'x'.repeat(70_000)}`;
    f.db.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
    f.db
      .prepare(`UPDATE imported_cooking_history SET ${column}=? WHERE event_id=?`)
      .run(large, entry.eventId);
    f.db.exec('PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON');
    largest = 0;
    await rejectsUnchanged(f);
    assert.ok(largest < 70_000, `${column} escaped scalar admission`);
    f.db
      .prepare(`UPDATE imported_cooking_history SET ${column}=? WHERE event_id=?`)
      .run(original, entry.eventId);
  }
  f.read.connection.all = originalAll;
  await f.verify();
});

test('legacy readers and v2 duplicate-ID rejection remain closed while schema-seven metadata count supports unique imports', async (t) => {
  const f = await fixture(t),
    entry = f.exact[0]!;
  await assert.rejects(f.reader.transaction((sql) => historyCount(sql, 0)));
  await assert.rejects(f.reader.transaction((sql) => historyRows(sql, 0, 20)));
  assert.equal(
    await f.reader.transaction((sql) => historyCount(sql, 0, { contentSchema: true })),
    4,
  );
  const row: HistoryRow = {
    eventId: entry.eventId,
    historyEpoch: 0,
    state: 'saved',
    cookedOn: entry.cookedOn,
    recordedAt: at,
    requestFingerprint: null,
    receiptJson: null,
    entryJson: JSON.stringify(entry),
    sourceEventId: f.sourceIds[0]!,
    restoreOperationId: f.restoreId,
    source: 'backup',
  };
  assert.throws(() => parseImportedHistory(row));
  const { origin: _origin, ...local } = entry;
  f.db
    .prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)")
    .run(
      entry.eventId,
      entry.cookedOn,
      at,
      'a'.repeat(64),
      JSON.stringify({ kind: 'saved', event: local, closedSession: null }),
    );
  f.db
    .prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)')
    .run(
      entry.eventId,
      entry.recipeId,
      entry.contentRef.revisionId,
      entry.contentRef.contentFingerprint,
    );
  await assert.rejects(
    f.reader.transaction((sql) => historyCount(sql, 0, { contentSchema: true })),
  );
  failed(await f.history().readHistory());
  failed(await f.capture().capture({ includeCookingHistory: true }));
  failed(await f.clear().reviewClearHistory());
});

test('reviewed clear withdraws exact import and source IDs, removes pins, and preserves unrelated records and receipt authority', async (t) => {
  const f = await fixture(t),
    host = f.clear();
  const tables = [
    'cooking_session',
    'cooking_session_content_pin',
    'content_cooking_session_operation',
    'plan_occurrence',
    'plan_content_pin',
    'shopping_scope',
    'shopping_selection',
    'shopping_group',
    'shopping_contribution',
    'purchase_state',
    'favourite',
    'manual_shopping_item',
    'portable_restore_operation',
    'content_cooking_event_authority',
  ];
  const before = f.snapshot(tables),
    review = ready(await host.reviewClearHistory());
  assert.equal(review.count, 4);
  const operationId = randomUUID(),
    receipt = ready(await host.clearHistory(review, operationId));
  assert.equal(receipt.clearedCount, 4);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM imported_cooking_history').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM imported_history_content_pin').get()!.n, 0);
  assert.deepEqual(
    f.db
      .prepare('SELECT state,receipt_json FROM cooking_event')
      .all()
      .map((row) => ({ ...row })),
    [{ state: 'cleared', receipt_json: null }],
  );
  const expected = [
    f.legacy.eventId,
    f.legacyBackup.eventId,
    f.legacySourceId,
    ...f.exact.map((entry) => entry.eventId),
    ...f.sourceIds,
  ].sort();
  assert.deepEqual(
    f.db
      .prepare('SELECT event_id FROM cooking_history_withdrawal ORDER BY event_id')
      .all()
      .map((row) => row.event_id),
    expected,
  );
  assert.deepEqual(f.snapshot(tables), before);
  assert.equal(
    JSON.stringify(f.db.prepare('SELECT * FROM cooking_history_clear').all()).includes(
      'Imported private note',
    ),
    false,
  );
  await f.reopen();
  assert.deepEqual(ready(await f.clear().readClearHistoryReceipt(operationId)), receipt);
  assert.equal(ready(await f.history().readHistory()).items.length, 0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});
