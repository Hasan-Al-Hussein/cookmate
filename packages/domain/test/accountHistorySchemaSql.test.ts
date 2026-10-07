import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import type { AccountCookingHistoryEntry } from '@cookmate/account-sync';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import type { InitializationOptions } from '../../../apps/mobile/src/data/initialize';
import { ACCOUNT_HISTORY_ENTRY_MAX_BYTES } from '../../../apps/mobile/src/data/schema';
import { verifySchemaCompatibility } from '../../../apps/mobile/src/data/schemaCompatibility';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const seed = {
  identity: catalogue.identity,
  recipes: catalogue.recipes,
  recipeSources: catalogueProvenance.recipeSources,
};
const identifiers = () => ({
  installationId: randomUUID(),
  shoppingScopeId: randomUUID(),
  conversationId: randomUUID(),
});
const optionsFor = (version: number): InitializationOptions => ({
  enablePortableRestore: version >= 3,
  enableCooking: version >= 4,
  enablePersonal: version >= 5,
  enableAccountHistory: version >= 6,
});
const at = '2026-10-01T12:00:00.000Z';
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const entry = (eventId = randomUUID()): AccountCookingHistoryEntry => ({
  eventId,
  recipeId: catalogue.recipes[0]!.recipeId,
  catalogue: { ...catalogue.identity },
  contentFingerprint: 'a'.repeat(64),
  readerVersion: 1,
  recipeTitle: catalogue.recipes[0]!.title,
  photoKey: catalogue.recipes[0]!.photoKey,
  cookedOn: '2026-10-01',
  timeZone: 'Asia/Dubai',
  recordedAt: at,
  note: null,
});
async function fixture(version = 0) {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
  const ids = identifiers();
  if (version) await initializeDatabase(writer, seed, ids, optionsFor(version));
  return { ...storage, writer, ids, close: () => writer.close() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function legacyState(f: Fixture) {
  const tables = f.database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'account_cooking_history%' AND name<>'cooking_history_withdrawal' ORDER BY name",
    )
    .all();
  return tables.map(({ name }) => [
    name,
    f.database.prepare(`SELECT * FROM ${name as string}`).all(),
  ]);
}
function seedRetainedRows(f: Fixture, version: number) {
  f.database
    .prepare('INSERT INTO favourite VALUES (?,1,1,?,?)')
    .run(catalogue.recipes[0]!.recipeId, at, at);
  f.database
    .prepare('INSERT INTO operation_receipt VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), randomUUID(), 'b'.repeat(64), 'no_op', at, 'unchanged', '[]');
  f.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run('scope-foundation-test', 'preserve exact original bytes');
  if (version >= 3) {
    f.database
      .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
      .run(
        randomUUID(),
        'c'.repeat(64),
        '{"retained":"import"}',
        '{"retained":"before"}',
        '{"retained":"receipt"}',
      );
  }
  if (version >= 4) {
    f.database
      .prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)")
      .run(
        randomUUID(),
        '2026-10-01',
        at,
        'd'.repeat(64),
        '{"retained":"local completion authority"}',
      );
  }
  if (version >= 5) {
    f.database
      .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)')
      .run(
        randomUUID(),
        catalogue.recipes[0]!.recipeId,
        JSON.stringify('private retained note'),
        at,
        at,
      );
    f.database
      .prepare('INSERT INTO personal_operation VALUES (?,NULL,?)')
      .run(randomUUID(), '{"retained":"personal receipt"}');
  }
}

test('schema six requires the complete explicit opt-in chain and leaves default versions unchanged', async () => {
  for (const version of [2, 3, 4, 5]) {
    const f = await fixture(version);
    try {
      assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, version);
      assert.equal(
        f.database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'account_cooking_history%'",
          )
          .get()!.count,
        0,
      );
    } finally {
      await f.close();
    }
  }
  const f = await fixture();
  try {
    for (const options of [
      { enableAccountHistory: true },
      { enableAccountHistory: true, enablePersonal: true },
      { enableAccountHistory: true, enablePersonal: true, enableCooking: true },
    ]) {
      await assert.rejects(initializeDatabase(f.writer, seed, f.ids, options), {
        code: 'incompatible_version',
      });
      assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 0);
      assert.equal(
        f.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get()!
          .count,
        0,
      );
    }
    assert.equal(await initializeDatabase(f.writer, seed, f.ids, optionsFor(6)), 'created');
    await f.writer.transaction((session) => verifySchemaCompatibility(session, 6));
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM account_cooking_history').get()!.count,
      0,
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM account_cooking_history_removed').get()!
        .count,
      0,
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM cooking_history_withdrawal').get()!.count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('versions two through five migrate atomically to six while original data and receipt bytes stay unchanged', async () => {
  for (const version of [2, 3, 4, 5]) {
    const f = await fixture(version);
    try {
      seedRetainedRows(f, version);
      const before = legacyState(f);
      assert.equal(
        await initializeDatabase(f.writer, seed, identifiers(), optionsFor(6)),
        'existing',
      );
      assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 6);
      const after = new Map(legacyState(f) as [string, unknown][]);
      for (const [name, rows] of before)
        assert.deepEqual(after.get(name as string), rows, name as string);
      assert.equal(
        f.database.prepare('SELECT COUNT(*) AS count FROM account_cooking_history').get()!.count,
        0,
      );
      assert.equal(
        f.database.prepare('SELECT COUNT(*) AS count FROM account_cooking_history_removed').get()!
          .count,
        0,
      );
      const changes = f.database.prepare('SELECT total_changes() AS count').get()!.count;
      assert.equal(
        await initializeDatabase(f.writer, seed, identifiers(), optionsFor(6)),
        'existing',
      );
      assert.equal(f.database.prepare('SELECT total_changes() AS count').get()!.count, changes);
    } finally {
      await f.close();
    }
  }
});

test('a file reopened at schema six requires explicit opt-in and retains the exact account projection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-history-schema-'));
  const filename = join(directory, 'store.db');
  let storage = desktopConnection(filename);
  await configureConnection(storage.connection);
  let writer = new SerializedWriter(storage.connection);
  const original = entry();
  const raw = JSON.stringify(original, null, 2);
  try {
    await initializeDatabase(writer, seed, identifiers(), optionsFor(6));
    storage.database
      .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
      .run(owner, original.eventId, raw);
    storage.database
      .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
      .run(owner, randomUUID());
    await writer.close();
    storage = desktopConnection(filename);
    await configureConnection(storage.connection);
    writer = new SerializedWriter(storage.connection);
    await assert.rejects(initializeDatabase(writer, seed, identifiers(), optionsFor(5)), {
      code: 'incompatible_version',
    });
    assert.equal(storage.database.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.equal(await initializeDatabase(writer, seed, identifiers(), optionsFor(6)), 'existing');
    assert.equal(
      storage.database.prepare('SELECT entry_json FROM account_cooking_history').get()!.entry_json,
      raw,
    );
    assert.equal(
      storage.database.prepare('SELECT COUNT(*) AS count FROM cooking_event').get()!.count,
      0,
    );
    assert.equal(
      storage.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()!.count,
      0,
    );
  } finally {
    await writer.close();
    await removeFixtureDirectory(directory);
  }
});

test('migration failure rolls back all intermediate tables and user_version for every starting version', async () => {
  for (const version of [0, 2, 3, 4, 5]) {
    const f = await fixture(version);
    try {
      if (version) seedRetainedRows(f, version);
      const before = legacyState(f);
      const layout = f.database
        .prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name')
        .all();
      const originalExec = f.connection.exec;
      f.connection.exec = async (sql) => {
        await originalExec(sql);
        if (sql.includes('CREATE TABLE account_cooking_history'))
          throw new Error('injected account history migration failure');
      };
      await assert.rejects(
        initializeDatabase(f.writer, seed, f.ids, optionsFor(6)),
        /injected account history migration failure/,
      );
      assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, version);
      assert.deepEqual(legacyState(f), before);
      assert.deepEqual(
        f.database.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all(),
        layout,
      );
    } finally {
      await f.close();
    }
  }
});

test('schema six exact-DDL verification rejects missing, changed and extra objects without data mutation', async () => {
  for (const change of [
    'DROP TABLE account_cooking_history_removed',
    'DROP TABLE cooking_history_withdrawal',
    'ALTER TABLE account_cooking_history RENAME COLUMN entry_json TO old_entry_json',
    'CREATE INDEX unexpected_account_history_index ON account_cooking_history(event_id)',
  ]) {
    const f = await fixture(6);
    try {
      seedRetainedRows(f, 5);
      const before = legacyState(f);
      f.database.exec(change);
      await assert.rejects(initializeDatabase(f.writer, seed, identifiers(), optionsFor(6)), {
        code: 'incompatible_version',
      });
      assert.deepEqual(legacyState(f), before);
      assert.equal(f.database.prepare('PRAGMA user_version').get()!.user_version, 6);
    } finally {
      await f.close();
    }
  }
});

test('account tables enforce UUID identity, exact data-only wire fields and valid bounded scalar shapes', async () => {
  const f = await fixture(6);
  try {
    const insert = f.database.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)');
    const removed = f.database.prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)');
    const localWithdrawal = f.database.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)');
    const valid = entry();
    for (const invalidId of [
      '',
      'not-a-uuid',
      owner.toUpperCase(),
      owner + '\0extra',
      owner.replace('-4aaa-', '-7aaa-'),
    ]) {
      assert.throws(() => insert.run(invalidId, valid.eventId, JSON.stringify(valid)), /CHECK/);
      assert.throws(() => removed.run(owner, invalidId), /CHECK/);
      assert.throws(() => removed.run(invalidId, valid.eventId), /CHECK/);
      assert.throws(() => localWithdrawal.run(invalidId), /CHECK/);
    }
    for (const patch of [
      { eventId: randomUUID() },
      { recipeId: 123 },
      { recipeId: '123\0hidden' },
      { catalogue: { ...valid.catalogue, extra: true } },
      { catalogue: { version: 'v1' } },
      { contentFingerprint: 'g'.repeat(64) },
      { contentFingerprint: 'a'.repeat(64) + '\0hidden' },
      { readerVersion: 2 },
      { recipeTitle: '' },
      { photoKey: 'x'.repeat(301) },
      { cookedOn: '2026-02-29' },
      { cookedOn: '0000-01-01' },
      { timeZone: '' },
      { recordedAt: '2026-10-01T24:00:00.000Z' },
      { recordedAt: '2026-02-29T12:00:00.000Z' },
      { note: 'x'.repeat(2001) },
      { note: '\0' + 'x'.repeat(2000) },
      { origin: 'account' },
      { origin: null },
      { historyEpoch: 1 },
      { revision: 1 },
      { request: {} },
      { receipt: {} },
    ])
      assert.throws(
        () => insert.run(owner, valid.eventId, JSON.stringify({ ...valid, ...patch })),
        /CHECK|malformed JSON/,
        `Invalid ${Object.keys(patch).join(',')}`,
      );
    for (const key of Object.keys(valid)) {
      const missing: Record<string, unknown> = { ...valid };
      delete missing[key];
      assert.throws(
        () => insert.run(owner, valid.eventId, JSON.stringify(missing)),
        /CHECK|malformed JSON/,
        key,
      );
    }
    for (const raw of [
      'not JSON',
      '[]',
      'null',
      '"text"',
      JSON.stringify(valid).replace('{', '{"readerVersion":1,'),
    ])
      assert.throws(() => insert.run(owner, valid.eventId, raw), /CHECK|malformed JSON/);
    insert.run(
      owner,
      valid.eventId,
      JSON.stringify({ ...valid, origin: 'backup', note: '🍲'.repeat(2000) }),
    );
    for (const note of ['\\u0000', '\0', '\\\0', '\0' + 'x'.repeat(1999)]) {
      const withNote = { ...entry(), note };
      insert.run(owner, withNote.eventId, JSON.stringify(withNote));
    }
    assert.throws(() => insert.run(owner, valid.eventId, JSON.stringify(valid)), /UNIQUE/);
    removed.run(owner, randomUUID());
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM cooking_event').get()!.count, 0);
  } finally {
    await f.close();
  }
});

test('entry byte bounds count UTF-8 and withdrawal-first transactions have no hidden deletes', async () => {
  const f = await fixture(6);
  try {
    const original = entry();
    const insert = f.database.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)');
    const raw = JSON.stringify(original);
    const padded = raw + ' '.repeat(ACCOUNT_HISTORY_ENTRY_MAX_BYTES - Buffer.byteLength(raw));
    assert.equal(Buffer.byteLength(padded), ACCOUNT_HISTORY_ENTRY_MAX_BYTES);
    insert.run(owner, original.eventId, padded);
    const another = entry();
    const unicode = JSON.stringify({ ...another, note: '🍲'.repeat(2000) });
    const oversize =
      unicode + ' '.repeat(ACCOUNT_HISTORY_ENTRY_MAX_BYTES - Buffer.byteLength(unicode) + 1);
    assert.ok(oversize.length < ACCOUNT_HISTORY_ENTRY_MAX_BYTES);
    assert.throws(() => insert.run(owner, another.eventId, oversize), /CHECK/);
    // Authorization, immutable same-ID comparison and removal suppression belong to the runtime helper.
    insert.run(otherOwner, original.eventId, raw);
    f.database.exec('BEGIN');
    f.database
      .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
      .run(owner, original.eventId);
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM account_cooking_history').get()!.count,
      2,
    );
    f.database
      .prepare('DELETE FROM account_cooking_history WHERE owner_id=? AND event_id=?')
      .run(owner, original.eventId);
    f.database.exec('COMMIT');
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM account_cooking_history_removed').get()!
        .count,
      1,
    );
    assert.equal(
      f.database.prepare('SELECT owner_id FROM account_cooking_history').get()!.owner_id,
      otherOwner,
    );
  } finally {
    await f.close();
  }
});
