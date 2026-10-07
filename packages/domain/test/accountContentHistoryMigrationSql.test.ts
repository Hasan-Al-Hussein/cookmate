import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createBundledRecipeRevision } from '@cookmate/catalogue/content';
import {
  AccountReplicationError,
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
  type AccountCookingHistoryEntry,
  type AccountSnapshot,
} from '@cookmate/account-sync';
import type { AccountExactCookingHistoryEntry } from '../../account-sync/src/contentSnapshot';
import { cookingContentIdentity } from '../src';
import {
  ACCOUNT_CONTENT_HISTORY_SCHEMA_VERSION,
  SCHEMA_V8,
  migrateAccountContentHistoryDatabase,
  verifyAccountContentHistorySchema,
} from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import {
  SCHEMA_V7,
  verifyCookingContentSchema,
} from '../../../apps/mobile/src/data/cookingContentSchema';
import { ACCOUNT_HISTORY_ENTRY_MAX_BYTES, SCHEMA_V6 } from '../../../apps/mobile/src/data/schema';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_SETTINGS_KEY,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { readAccountHistoryProjection } from '../../../apps/mobile/src/data/accountHistoryProjection';
import {
  configureConnection,
  SerializedWriter,
  StorageFault,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Physical migration fixtures only. No schema8 runtime is mounted and data-only rows confer
// neither publication trust nor permission to recover a local cooking action receipt.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const settings = {
  appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
  profile: { displayName: null },
} as const;
const rejected = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-account-content-migration-'));
  const filename = join(directory, 'history.db'),
    handles: SerializedWriter[] = [];
  async function open() {
    const storage = desktopConnection(filename);
    await configureConnection(storage.connection);
    const writer = new SerializedWriter(storage.connection);
    handles.push(writer);
    return { ...storage, writer };
  }
  const f = await open(),
    db = f.database,
    recipe = catalogue.recipes[0]!;
  t.after(async () => {
    for (const writer of handles) await writer.close();
    await removeFixtureDirectory(directory);
  });
  await initializeDatabase(
    f.writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId: randomUUID(), shoppingScopeId: randomUUID(), conversationId: randomUUID() },
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  const metadata = (key: string, value: unknown) =>
    db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId });
  const identity = await cookingContentIdentity(recipe, catalogue.identity, hash);
  const legacy: AccountCookingHistoryEntry = {
    ...identity,
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: ' Original\n🍲\u0000\\ note ',
  };
  const entries: AccountCookingHistoryEntry[] = [
    legacy,
    { ...legacy, eventId: randomUUID(), origin: 'backup', note: null },
    { ...legacy, eventId: randomUUID(), contentFingerprint: 'f'.repeat(64) },
  ];
  for (const entry of entries)
    db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
      ownerId,
      entry.eventId,
      JSON.stringify(entry, null, 2) + '\n ',
    );
  db.prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)').run(ownerId, randomUUID());
  const event = { ...legacy, eventId: randomUUID(), historyEpoch: 0, revision: 1 };
  db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
    event.eventId,
    event.cookedOn,
    at,
    'a'.repeat(64),
    JSON.stringify({ kind: 'saved', event, closedSession: null }, null, 2),
  );
  db.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(recipe.recipeId, at, at);
  db.prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)').run(
    randomUUID(),
    recipe.recipeId,
    JSON.stringify('Unrelated retained private note\u0000🍲'),
    at,
    at,
  );
  db.prepare('INSERT INTO personal_operation VALUES (?,NULL,?)').run(
    randomUUID(),
    '{ "privateReceipt": "unchanged" }',
  );
  db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
    randomUUID(),
    'b'.repeat(64),
    '{ "original": "import" }',
    '{"before":true}',
    '{ "receipt": true }',
  );
  db.exec(
    "UPDATE cooking_state SET history_revision=1; UPDATE state_revision SET revision=3 WHERE collection='store'",
  );
  metadata(journalKey(ownerId), {
    schemaVersion: 1,
    ownerId,
    revision: 1,
    base: null,
    observed: { revision: 0, snapshotDigest: null, updatedAt: null },
    pending: null,
    lastApply: null,
  });
  await migrateCookingContentDatabase(f.writer, { sha256: hash });
  const bundled = await createBundledRecipeRevision(recipe.recipeId, hash);
  const exact = (eventId: string = randomUUID()): AccountExactCookingHistoryEntry => ({
    readerVersion: 2,
    recipeId: recipe.recipeId,
    contentRef: bundled.ref,
    eventId,
    recipeTitle: bundled.document.recipe.title,
    photoAssetId: bundled.document.media[0]!.assetId,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: ' exact\n🍲\u0000\\ ',
  });
  function addExact(value = exact()) {
    db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
      ownerId,
      value.eventId,
      JSON.stringify(value),
    );
    db.prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)').run(
      ownerId,
      value.eventId,
      value.recipeId,
      value.contentRef.revisionId,
      value.contentRef.contentFingerprint,
    );
    return value;
  }
  return { ...f, open, metadata, exact, addExact, entries, legacy, bundled };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function rows(db: Fixture['database']) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM ${String(name)} ORDER BY rowid`).all()]);
}
function layout(db: Fixture['database']) {
  return db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}
function noTemporaryCopies(db: Fixture['database']) {
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'account_content_%'").all(),
    [],
  );
}
function mutateWithoutConstraints(f: Fixture, change: () => void) {
  f.database.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
  try {
    change();
  } finally {
    f.database.exec('PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON');
  }
}
async function legacyPending(version: 1 | 2) {
  const core = emptyAccountSnapshot(catalogue.identity, settings);
  const snapshot: AccountSnapshot =
    version === 1
      ? core
      : {
          ...core,
          schemaVersion: 2,
          personal: { notes: [], collections: [], memberships: [], manualItems: [] },
        };
  const scope = { version: 2 as const, approvalDigest: 'a'.repeat(64), historyIncluded: false },
    operationId = randomUUID();
  return {
    schemaVersion: version,
    ...(version === 2 ? { scope } : {}),
    ownerId,
    revision: 1,
    base: null,
    observed: { revision: 0, snapshotDigest: null, updatedAt: null },
    lastApply: null,
    pending: {
      operationId,
      mode: 'push',
      capturedLocal: { storeRevision: 0, snapshot, ...(version === 2 ? { scope } : {}) },
      remote: { ownerId, revision: 0, snapshot: null, updatedAt: null, deletionOperationId: null },
      proposed: snapshot,
      proposedDigest: await hash(canonicalAccountSnapshot(snapshot)),
      acknowledgement:
        version === 2 ? { ownerId, operationId, revision: 1, committedAt: at } : null,
    },
  };
}

test('schema7→8 preserves every original value including v1 JSON whitespace, nullable pins and all unrelated receipts', async (t) => {
  const f = await fixture(t),
    before = rows(f.database),
    oldLayout = layout(f.database);
  assert.equal(ACCOUNT_CONTENT_HISTORY_SCHEMA_VERSION, 8);
  assert.equal(await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }), 'migrated');
  assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 8);
  assert.equal(f.database.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  assert.deepEqual(rows(f.database), before);
  const after = layout(f.database);
  assert.deepEqual(
    after.filter((row) => row.name !== 'account_cooking_history'),
    oldLayout.filter((row) => row.name !== 'account_cooking_history'),
  );
  assert.notEqual(
    after.find((row) => row.name === 'account_cooking_history')!.sql,
    oldLayout.find((row) => row.name === 'account_cooking_history')!.sql,
  );
  await verifyAccountContentHistorySchema(f.connection);
  noTemporaryCopies(f.database);
});

test('flat exact v2 data with an exact pin survives reopen without legacy journal decoding or hash-based body proof', async (t) => {
  const f = await fixture(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash });
  const exact = f.addExact();
  f.metadata(journalKey(ownerId), {
    schemaVersion: 3,
    fixture: 'Future private format; physical verifier must not parse it',
  });
  const before = rows(f.database);
  await f.writer.close();
  const reopened = await f.open();
  assert.equal(
    await migrateAccountContentHistoryDatabase(reopened.writer, {
      sha256: async () => assert.fail('existing8 must not replay legacy journal or body hashes'),
    }),
    'existing',
  );
  assert.deepEqual(rows(reopened.database), before);
  assert.equal(
    reopened.database
      .prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?')
      .get(exact.eventId),
    undefined,
  );
  await verifyAccountContentHistorySchema(reopened.connection);
});

test('schema8 exact DDL rejects receipt/clocks/origin smuggling, malformed refs and missing or duplicate fields', async (t) => {
  const f = await fixture(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash });
  const valid = f.exact(),
    insert = f.database.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)');
  for (const patch of [
    { readerVersion: 1 },
    { readerVersion: 3 },
    { recipeId: 'bad' },
    { eventId: randomUUID() },
    { contentRef: { ...valid.contentRef, recipeId: '99999' } },
    { contentRef: { ...valid.contentRef, revisionId: '!invalid' } },
    { contentRef: { ...valid.contentRef, revisionId: 'x'.repeat(121) } },
    { contentRef: { ...valid.contentRef, contentFingerprint: 'a'.repeat(63) + '\0' } },
    { contentRef: { ...valid.contentRef, extra: true } },
    { recipeTitle: '' },
    { recipeTitle: 'x'.repeat(1001) },
    { photoAssetId: 'sha256:' + 'a'.repeat(63) + '\0' },
    { photoAssetId: 'photos/source.jpg' },
    { cookedOn: '2026-02-30' },
    { cookedOn: '0000-01-01' },
    { timeZone: '' },
    { timeZone: 'x'.repeat(101) },
    { recordedAt: '2026-10-01T24:00:00.000Z' },
    { recordedAt: '2026-02-29T12:00:00.000Z' },
    { note: '\0' + 'x'.repeat(2000) },
    { historyEpoch: 0 },
    { revision: 1 },
    { origin: 'backup' },
    { origin: null },
    { closedSession: null },
    { receipt: {} },
    { requestFingerprint: 'a'.repeat(64) },
    { catalogue: catalogue.identity },
    { photoKey: 'old.jpg' },
  ])
    assert.throws(
      () => insert.run(ownerId, valid.eventId, JSON.stringify({ ...valid, ...patch })),
      /CHECK|malformed JSON/,
      Object.keys(patch).join(','),
    );
  for (const key of Object.keys(valid)) {
    const missing: Record<string, unknown> = { ...valid };
    delete missing[key];
    assert.throws(
      () => insert.run(ownerId, valid.eventId, JSON.stringify(missing)),
      /CHECK|malformed JSON/,
      key,
    );
  }
  for (const json of [
    'null',
    '[]',
    'not-json',
    JSON.stringify(valid).replace('{', '{"readerVersion":2,'),
  ])
    assert.throws(() => insert.run(ownerId, valid.eventId, json), /CHECK|malformed JSON/);
  for (const note of [null, '\\u0000', '\0', '\\\0', '🍲'.repeat(2000)]) {
    const entry = { ...f.exact(), photoAssetId: null, note };
    f.addExact(entry);
  }
  await verifyAccountContentHistorySchema(f.connection);
  assert.equal(f.database.prepare('SELECT COUNT(*) count FROM cooking_event').get()!.count, 1);
});

test('old flat v1 branch is unchanged and same IDs cannot replace either version through INSERT', async (t) => {
  const f = await fixture(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash });
  const insert = f.database.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)'),
    valid = { ...f.legacy, eventId: randomUUID() };
  for (const patch of [
    { origin: null },
    { origin: 'account' },
    { revision: 1 },
    { historyEpoch: 0 },
    { receipt: {} },
    { note: 'x'.repeat(2001) },
  ])
    assert.throws(
      () => insert.run(ownerId, valid.eventId, JSON.stringify({ ...valid, ...patch })),
      /CHECK/,
    );
  for (const original of f.entries)
    assert.throws(() => insert.run(ownerId, original.eventId, JSON.stringify(original)), /UNIQUE/);
  const exact = f.addExact();
  assert.throws(
    () =>
      insert.run(ownerId, exact.eventId, JSON.stringify({ ...exact, note: 'replacement attempt' })),
    /UNIQUE/,
  );
  await verifyAccountContentHistorySchema(f.connection);
});

test('schema8 verifier requires one same-owner recipe pin and exact v2 fullref equality', async (t) => {
  const f = await fixture(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash });
  const exact = f.addExact();
  const update = (sql: string, ...values: (string | null)[]) =>
    f.database.prepare(sql).run(...values);
  update(
    "UPDATE account_history_content_pin SET revision_id=NULL,content_fingerprint=NULL,unresolved_reason='content_mismatch' WHERE event_id=?",
    exact.eventId,
  );
  await assert.rejects(verifyAccountContentHistorySchema(f.connection), StorageFault);
  update(
    'UPDATE account_history_content_pin SET revision_id=?,content_fingerprint=?,unresolved_reason=NULL WHERE event_id=?',
    exact.contentRef.revisionId,
    exact.contentRef.contentFingerprint,
    exact.eventId,
  );
  f.database.prepare('DELETE FROM account_history_content_pin WHERE event_id=?').run(exact.eventId);
  await assert.rejects(verifyAccountContentHistorySchema(f.connection), StorageFault);
  f.database
    .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
    .run(
      ownerId,
      exact.eventId,
      exact.recipeId,
      exact.contentRef.revisionId,
      exact.contentRef.contentFingerprint,
    );
  const other = await createBundledRecipeRevision(catalogue.recipes[1]!.recipeId, hash);
  update(
    'UPDATE account_history_content_pin SET recipe_id=?,revision_id=?,content_fingerprint=? WHERE event_id=?',
    other.ref.recipeId,
    other.ref.revisionId,
    other.ref.contentFingerprint,
    exact.eventId,
  );
  assert.deepEqual(
    f.database.prepare('PRAGMA foreign_key_check').all(),
    [],
    'different valid archived recipe still satisfies FK',
  );
  await assert.rejects(verifyAccountContentHistorySchema(f.connection), StorageFault);
});

test('v2 pin revision substitution and FK-disabled orphan corruption fail closed on reopen', async (t) => {
  const f = await fixture(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash });
  const exact = f.addExact();
  const original = f.database
    .prepare(
      'SELECT revision_json FROM recipe_content_revision WHERE recipe_id=? AND revision_id=?',
    )
    .get(exact.recipeId, exact.contentRef.revisionId)!.revision_json as string;
  const changed: { ref: { revisionId: string }; revisionFingerprint: string } =
    JSON.parse(original);
  changed.ref.revisionId = 'fixture-unverified-alternative';
  // A second structurally referenced row tests metadata equality only; schema8 makes no hash/trust claim.
  f.database
    .prepare('INSERT INTO recipe_content_revision VALUES (?,?,?,?,?)')
    .run(
      exact.recipeId,
      changed.ref.revisionId,
      exact.contentRef.contentFingerprint,
      'imported',
      JSON.stringify(changed),
    );
  f.database
    .prepare('UPDATE account_history_content_pin SET revision_id=? WHERE event_id=?')
    .run(changed.ref.revisionId, exact.eventId);
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    StorageFault,
  );
  f.database
    .prepare('UPDATE account_history_content_pin SET revision_id=? WHERE event_id=?')
    .run(exact.contentRef.revisionId, exact.eventId);
  mutateWithoutConstraints(f, () =>
    f.database.prepare('DELETE FROM account_cooking_history WHERE event_id=?').run(exact.eventId),
  );
  await assert.rejects(verifyAccountContentHistorySchema(f.connection), StorageFault);
});

test('migration failure after parent recreation rolls back every row, original DDL and user_version', async (t) => {
  const f = await fixture(t),
    before = rows(f.database),
    beforeLayout = layout(f.database);
  const exec = f.connection.exec;
  f.connection.exec = async (sql) => {
    if (sql.startsWith('INSERT INTO account_history_content_pin SELECT'))
      throw new Error('injected child restore failure');
    return exec(sql);
  };
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    /injected child restore failure/,
  );
  f.connection.exec = exec;
  assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 7);
  assert.deepEqual(rows(f.database), before);
  assert.deepEqual(layout(f.database), beforeLayout);
  noTemporaryCopies(f.database);
  assert.equal(await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }), 'migrated');
});

test('SQL copies compare original bytes in both directions before any table is discarded', async (t) => {
  const f = await fixture(t),
    before = rows(f.database),
    beforeLayout = layout(f.database),
    exec = f.connection.exec;
  f.connection.exec = async (sql) => {
    await exec(sql);
    if (sql.startsWith('CREATE TEMP TABLE account_content_history_copy'))
      f.database
        .prepare(
          "UPDATE account_content_history_copy SET entry_json=json_set(entry_json,'$.note','lost original whitespace') WHERE event_id=?",
        )
        .run(f.legacy.eventId);
  };
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    StorageFault,
  );
  f.connection.exec = exec;
  assert.deepEqual(rows(f.database), before);
  assert.deepEqual(layout(f.database), beforeLayout);
  noTemporaryCopies(f.database);
});

test('pending or acknowledged legacy operations and settings stop migration without rewriting exact retained bytes', async (t) => {
  const f = await fixture(t);
  for (const version of [1, 2] as const) {
    const serialized = JSON.stringify(await legacyPending(version), null, 2);
    f.database
      .prepare('UPDATE app_metadata SET value=? WHERE key=?')
      .run(serialized, journalKey(ownerId));
    const before = rows(f.database);
    await assert.rejects(
      migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
      rejected('operation_pending'),
    );
    assert.deepEqual(rows(f.database), before);
    assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 7);
  }
  f.database.prepare('DELETE FROM app_metadata WHERE key=?').run(journalKey(ownerId));
  f.metadata(ACCOUNT_SETTINGS_KEY, null);
  const before = rows(f.database);
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    rejected('settings_pending'),
  );
  assert.deepEqual(rows(f.database), before);
});

test('foreign parent/removal/pin owners and unbound account rows are rejected without payload transfer or copying', async (t) => {
  const f = await fixture(t),
    all = f.connection.all,
    exec = f.connection.exec;
  let payloadReads = 0,
    copies = 0;
  f.connection.all = async <Row extends object>(
    sql: string,
    values?: Parameters<typeof all>[1],
  ) => {
    const rows = await all<Row>(sql, values);
    for (const row of rows) if ('entry_json' in row || 'entryJson' in row) payloadReads++;
    return rows;
  };
  f.connection.exec = async (sql) => {
    if (sql.startsWith('CREATE TEMP')) copies++;
    await exec(sql);
  };
  for (const table of [
    'account_cooking_history',
    'account_history_content_pin',
    'account_cooking_history_removed',
  ]) {
    mutateWithoutConstraints(f, () =>
      f.database.prepare(`UPDATE ${table} SET owner_id=?`).run(otherOwnerId),
    );
    const before = rows(f.database);
    await assert.rejects(
      migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
      StorageFault,
    );
    assert.deepEqual(rows(f.database), before);
    mutateWithoutConstraints(f, () =>
      f.database.prepare(`UPDATE ${table} SET owner_id=?`).run(ownerId),
    );
  }
  f.database
    .prepare('DELETE FROM app_metadata WHERE key IN (?,?)')
    .run(ACCOUNT_BINDING_KEY, journalKey(ownerId));
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    StorageFault,
  );
  assert.equal(payloadReads, 0);
  assert.equal(copies, 0);
});

test('oversized aggregate or corrupted scalar input is rejected before raw rows or temporary copies materialize', async (t) => {
  const f = await fixture(t),
    all = f.connection.all,
    exec = f.connection.exec;
  let payloadReads = 0,
    copies = 0;
  f.connection.all = async <Row extends object>(
    sql: string,
    values?: Parameters<typeof all>[1],
  ) => {
    const rows = await all<Row>(sql, values);
    for (const row of rows) if ('entry_json' in row || 'entryJson' in row) payloadReads++;
    return rows;
  };
  f.connection.exec = async (sql) => {
    if (sql.startsWith('CREATE TEMP')) copies++;
    await exec(sql);
  };
  const raw = f.database
    .prepare('SELECT entry_json FROM account_cooking_history WHERE event_id=?')
    .get(f.legacy.eventId)!.entry_json as string;
  mutateWithoutConstraints(f, () =>
    f.database
      .prepare('UPDATE account_cooking_history SET entry_json=? WHERE event_id=?')
      .run(raw + ' '.repeat(ACCOUNT_HISTORY_ENTRY_MAX_BYTES), f.legacy.eventId),
  );
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    StorageFault,
  );
  f.database
    .prepare('UPDATE account_cooking_history SET entry_json=? WHERE event_id=?')
    .run(raw, f.legacy.eventId);
  const pin = f.database
    .prepare('SELECT * FROM account_history_content_pin WHERE event_id=?')
    .get(f.legacy.eventId)!;
  mutateWithoutConstraints(f, () =>
    f.database
      .prepare('UPDATE account_history_content_pin SET revision_id=? WHERE event_id=?')
      .run('x'.repeat(2 * 1024 * 1024), f.legacy.eventId),
  );
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    StorageFault,
  );
  f.database
    .prepare('UPDATE account_history_content_pin SET revision_id=? WHERE event_id=?')
    .run(pin.revision_id!, f.legacy.eventId);
  const insert = f.database.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)'),
    insertPin = f.database.prepare(
      'INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)',
    );
  f.database.exec('BEGIN');
  try {
    for (let index = 0; index < 400; index++) {
      const value = { ...f.legacy, eventId: randomUUID(), note: '🍲'.repeat(2000) };
      insert.run(ownerId, value.eventId, JSON.stringify(value));
      insertPin.run(
        ownerId,
        value.eventId,
        pin.recipe_id!,
        pin.revision_id!,
        pin.content_fingerprint!,
      );
    }
    f.database.exec('COMMIT');
  } catch (error) {
    f.database.exec('ROLLBACK');
    throw error;
  }
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    StorageFault,
  );
  assert.equal(payloadReads, 0);
  assert.equal(copies, 0);
  assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 7);
});

test('only explicit7→8 migrates; old schema layouts/readers stay strict and unexpected DDL is rejected', async (t) => {
  const f = await fixture(t);
  await verifyCookingContentSchema(f.connection);
  assert.equal(await migrateCookingContentDatabase(f.writer, { sha256: hash }), 'existing');
  assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 7);
  f.database.exec('CREATE INDEX unreviewed_extra ON account_cooking_history(event_id)');
  const before = rows(f.database);
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    StorageFault,
  );
  assert.deepEqual(rows(f.database), before);
  f.database.exec('DROP INDEX unreviewed_extra');
  f.database.exec('PRAGMA user_version=6');
  await assert.rejects(
    migrateAccountContentHistoryDatabase(f.writer, { sha256: hash }),
    StorageFault,
  );
  f.database.exec('PRAGMA user_version=7');
  await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash });
  await assert.rejects(verifyCookingContentSchema(f.connection), StorageFault);
  await assert.rejects(migrateCookingContentDatabase(f.writer, { sha256: hash }), StorageFault);
  await assert.rejects(
    readAccountHistoryProjection(f.connection, ownerId, { contentSchema: true }),
    rejected('stored_data_invalid'),
  );
  assert.ok(!SCHEMA_V6.includes("'$.photoAssetId'"));
  assert.ok(!SCHEMA_V7.includes("'$.photoAssetId'"));
  const fresh = desktopConnection();
  try {
    await configureConnection(fresh.connection);
    fresh.database.exec(SCHEMA_V8);
    fresh.database.exec('PRAGMA user_version=8');
    await verifyAccountContentHistorySchema(fresh.connection);
  } finally {
    await fresh.connection.close();
  }
});
