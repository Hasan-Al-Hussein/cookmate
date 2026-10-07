import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createBundledRecipeRevision } from '@cookmate/catalogue/content';
import { AccountReplicationError, type AccountCookingHistoryEntry } from '@cookmate/account-sync';
import {
  validateAccountExactCookingHistoryEntry,
  type AccountExactCookingHistoryEntry,
} from '../../account-sync/src/contentSnapshot';
import { cookingContentIdentity } from '../src';
import {
  admitAccountContentHistoryProjection,
  hasUniqueHistoryJsonKeys,
  parseAccountContentHistoryEntry,
  readAccountContentHistoryProjection,
  type AccountContentHistoryEntry,
} from '../../../apps/mobile/src/data/accountContentHistoryProjection';
import { SCHEMA_V8 } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import { readAccountHistoryProjection } from '../../../apps/mobile/src/data/accountHistoryProjection';
import { ACCOUNT_HISTORY_ENTRY_MAX_BYTES } from '../../../apps/mobile/src/data/schema';
import { configureConnection, SerializedReader } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

// Disposable physical8 fixtures. Retained rows are local metadata, not signed publication proof.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const hash = async (value: string) => createHash('sha256').update(value).digest('hex');
const rejected = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;

test('shared unique-key check is UTF8 bounded, handles malformed keys safely and grants no JSON shape proof', () => {
  assert.equal(
    hasUniqueHistoryJsonKeys('{"entry":{"contentRef":{"recipeId":"1"}},"other":{"recipeId":"2"}}'),
    true,
  );
  assert.equal(
    hasUniqueHistoryJsonKeys(
      JSON.stringify({
        note: 'Literal "recipeId": { [ punctuation',
        rows: [{ eventId: 'a' }, { eventId: 'b' }],
      }),
    ),
    true,
  );
  assert.equal(
    hasUniqueHistoryJsonKeys('{"contentRef":{"recipeId":"1"},"contentRef":{"recipeId":"2"}}'),
    false,
  );
  assert.equal(hasUniqueHistoryJsonKeys('{"recipeId":"1","recip\\u0065Id":"2"}'), false);
  assert.equal(hasUniqueHistoryJsonKeys('{"bad\\q":1}'), false);
  assert.equal(hasUniqueHistoryJsonKeys('x'.repeat(ACCOUNT_HISTORY_ENTRY_MAX_BYTES + 1)), false);
  assert.equal(
    hasUniqueHistoryJsonKeys('🍲'.repeat(ACCOUNT_HISTORY_ENTRY_MAX_BYTES / 4 + 1)),
    false,
  );
  assert.equal(hasUniqueHistoryJsonKeys(null as unknown as string), false);
  assert.equal(
    hasUniqueHistoryJsonKeys('not JSON'),
    true,
    'callers must still parse and validate JSON syntax and record shape',
  );
});

async function fixture(t: TestContext) {
  const f = desktopConnection();
  await configureConnection(f.connection);
  const reader = new SerializedReader(f.connection);
  t.after(() => reader.close());
  f.database.exec(SCHEMA_V8);
  f.database.exec('PRAGMA user_version=8');
  f.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId }));
  const recipe = catalogue.recipes[0]!,
    bundled = await createBundledRecipeRevision(recipe.recipeId, hash);
  f.database.prepare('INSERT INTO recipe_identity VALUES (?)').run(recipe.recipeId);
  f.database
    .prepare('INSERT INTO recipe_content_revision VALUES (?,?,?,?,?)')
    .run(
      recipe.recipeId,
      bundled.ref.revisionId,
      bundled.ref.contentFingerprint,
      'imported',
      JSON.stringify(bundled),
    );
  const secondRef = {
    ...bundled.ref,
    revisionId: 'fixture-retained-two',
    contentFingerprint: 'b'.repeat(64),
  };
  f.database
    .prepare('INSERT INTO recipe_content_revision VALUES (?,?,?,?,?)')
    .run(
      recipe.recipeId,
      secondRef.revisionId,
      secondRef.contentFingerprint,
      'imported',
      JSON.stringify({ ref: secondRef, document: { kind: 'imported' } }),
    );
  const identity = await cookingContentIdentity(recipe, catalogue.identity, hash);
  const legacy = (eventId: string = randomUUID()): AccountCookingHistoryEntry => ({
    ...identity,
    eventId,
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: ' Raw\n🍲\0\\ ',
    origin: 'backup',
  });
  const exact = (eventId: string = randomUUID()): AccountExactCookingHistoryEntry => ({
    readerVersion: 2,
    eventId,
    recipeId: recipe.recipeId,
    contentRef: { ...bundled.ref },
    recipeTitle: recipe.title,
    photoAssetId: bundled.document.media[0]!.assetId,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: ' Exact\n🍲\0\\ ',
  });
  function add<Value extends AccountContentHistoryEntry>(entry: Value, unresolved = false): Value {
    f.database
      .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
      .run(ownerId, entry.eventId, JSON.stringify(entry, null, 2) + '\n ');
    const ref = entry.readerVersion === 2 ? entry.contentRef : bundled.ref;
    f.database
      .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,?)')
      .run(
        ownerId,
        entry.eventId,
        entry.recipeId,
        unresolved ? null : ref.revisionId,
        unresolved ? null : ref.contentFingerprint,
        unresolved ? 'content_mismatch' : null,
      );
    return entry;
  }
  // Intentionally opaque unrelated local authority must neither be parsed nor returned here.
  f.database
    .prepare("INSERT INTO cooking_event VALUES (?,0,'saved','2026-10-01',?,?,?)")
    .run(randomUUID(), at, 'c'.repeat(64), '{ "private": "local receipt remains untouched" }');
  const statements: string[] = [],
    all = f.connection.all;
  f.connection.all = async <Row extends object>(
    sql: string,
    values?: Parameters<typeof all>[1],
  ) => {
    statements.push(sql);
    return all<Row>(sql, values);
  };
  const read = () =>
    reader.transaction((session) => readAccountContentHistoryProjection(session, ownerId));
  const admit = () =>
    reader.transaction((session) => admitAccountContentHistoryProjection(session, ownerId));
  const payloadReads = () => statements.filter((sql) => /SELECT event_id eventId[, ]/.test(sql));
  return {
    ...f,
    reader,
    read,
    admit,
    add,
    exact,
    legacy,
    bundled,
    secondRef,
    statements,
    payloadReads,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function corrupt(f: Fixture, change: () => void) {
  f.database.exec('PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON');
  try {
    change();
  } finally {
    f.database.exec('PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON');
  }
}
function allRows(f: Fixture) {
  return f.database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => [
      name,
      f.database.prepare(`SELECT * FROM ${String(name)} ORDER BY rowid`).all(),
    ]);
}

test('mixed legacy and exact history preserves distinct revisions, raw values, original bytes and local receipts', async (t) => {
  const f = await fixture(t);
  const entries = [
    f.add(f.legacy()),
    f.add(f.legacy(), true),
    f.add(f.exact()),
    f.add({ ...f.exact(), contentRef: f.secondRef, note: null }),
  ];
  const removedId = randomUUID();
  f.database
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(ownerId, removedId);
  const before = allRows(f),
    result = await f.read();
  assert.deepEqual(
    result.entries,
    [...entries].sort((a, b) => a.eventId.localeCompare(b.eventId)),
  );
  assert.deepEqual(result.removedEventIds, [removedId]);
  assert.deepEqual(allRows(f), before);
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.entries) &&
      Object.isFrozen(result.removedEventIds),
  );
  for (const entry of result.entries) {
    assert.ok(Object.isFrozen(entry));
    if (entry.readerVersion === 2) assert.ok(Object.isFrozen(entry.contentRef));
    assert.equal('receipt' in entry, false);
    assert.equal('revision' in entry, false);
    assert.equal('historyEpoch' in entry, false);
  }
  assert.throws(() => {
    (result.entries as unknown as unknown[]).push('mutation');
  }, TypeError);
  assert.ok(
    !f.statements.some((sql) => /revision_json|receipt_json/.test(sql)),
    'no body or action receipt materializes',
  );
});

test('admission reads only bounded metadata and reports actual counts and original UTF8 bytes', async (t) => {
  const f = await fixture(t),
    first = f.add(f.legacy()),
    second = f.add(f.exact());
  const expectedBytes = f.database
    .prepare('SELECT SUM(length(CAST(entry_json AS BLOB))) bytes FROM account_cooking_history')
    .get()!.bytes;
  f.database
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(ownerId, randomUUID());
  assert.deepEqual(await f.admit(), { entryCount: 2, removalCount: 1, entryBytes: expectedBytes });
  assert.equal(f.payloadReads().length, 0);
  assert.ok(first.eventId !== second.eventId);
});

test('schema8 and exact current owner binding are mandatory; legacy readers remain closed', async (t) => {
  const f = await fixture(t);
  f.add(f.exact());
  for (const version of [6, 7, 9]) {
    f.database.exec(`PRAGMA user_version=${version}`);
    await assert.rejects(f.read(), rejected('stored_data_invalid'));
  }
  f.database.exec('PRAGMA user_version=8');
  await assert.rejects(
    readAccountHistoryProjection(f.connection, ownerId, { contentSchema: true }),
    rejected('stored_data_invalid'),
  );
  await assert.rejects(
    admitAccountContentHistoryProjection(f.connection, 'not-an-owner'),
    rejected('invalid_input'),
  );
  await assert.rejects(
    admitAccountContentHistoryProjection(f.connection, otherOwnerId),
    rejected('different_data_owner'),
  );
  f.database.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
  await assert.rejects(f.read(), rejected('different_data_owner'));
  assert.equal(f.payloadReads().length, 0);
});

test('foreign parent, pin and withdrawal owners are denied before private payload projection', async (t) => {
  const f = await fixture(t);
  f.add(f.exact());
  f.database
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(ownerId, randomUUID());
  for (const table of [
    'account_cooking_history',
    'account_history_content_pin',
    'account_cooking_history_removed',
  ]) {
    corrupt(f, () => f.database.prepare(`UPDATE ${table} SET owner_id=?`).run(otherOwnerId));
    await assert.rejects(f.read(), rejected('different_data_owner'));
    corrupt(f, () => f.database.prepare(`UPDATE ${table} SET owner_id=?`).run(ownerId));
  }
  assert.equal(f.payloadReads().length, 0);
});

test('flat parser owns and freezes valid data, rejects authority, unknown fields, duplicates and foreign identity', async (t) => {
  const f = await fixture(t),
    exact = f.exact(),
    json = JSON.stringify(exact);
  assert.deepEqual(parseAccountContentHistoryEntry(exact.eventId, json), exact);
  const parsed = parseAccountContentHistoryEntry(exact.eventId, json);
  exact.note = 'caller mutation';
  assert.notEqual(parsed.note, exact.note);
  const valid = f.exact();
  assert.equal(validateAccountExactCookingHistoryEntry(valid), true);
  for (const patch of [
    { readerVersion: 1 },
    { readerVersion: 3 },
    { revision: 1 },
    { historyEpoch: 0 },
    { origin: 'backup' },
    { closedSession: null },
    { receipt: {} },
    { requestFingerprint: 'a'.repeat(64) },
    { note: 1 },
    { timeZone: 'Definitely/Not_A_Zone' },
    { contentRef: { ...valid.contentRef, recipeId: '99999' } },
  ]) {
    const value = { ...valid, ...patch };
    assert.equal(validateAccountExactCookingHistoryEntry(value), false);
    assert.throws(
      () => parseAccountContentHistoryEntry(valid.eventId, JSON.stringify(value)),
      rejected('stored_data_invalid'),
    );
  }
  for (const serialized of [
    'null',
    '[]',
    '{bad-json}',
    JSON.stringify(valid).replace('{', '{"recipeId":"99999",'),
    JSON.stringify(valid).replace('{', '{"recip\\u0065Id":"99999",'),
    JSON.stringify(valid).replace('"contentRef":{', '"contentRef":{"revisionId":"forged",'),
  ])
    assert.throws(
      () => parseAccountContentHistoryEntry(valid.eventId, serialized),
      rejected('stored_data_invalid'),
    );
  assert.throws(
    () => parseAccountContentHistoryEntry(randomUUID(), JSON.stringify(valid)),
    rejected('stored_data_invalid'),
  );
  assert.throws(
    () =>
      parseAccountContentHistoryEntry(
        valid.eventId,
        ' '.repeat(ACCOUNT_HISTORY_ENTRY_MAX_BYTES + 1),
      ),
    rejected('too_large'),
  );
  const descriptor = { ...valid };
  Object.defineProperty(descriptor, 'note', {
    enumerable: true,
    get: () => assert.fail('validator invoked hostile getter'),
  });
  assert.equal(validateAccountExactCookingHistoryEntry(descriptor), false);
});

test('stored malformed data and event mismatch reject before payload, while semantic and authority corruptions never return rows', async (t) => {
  const f = await fixture(t),
    entry = f.add(f.exact()),
    update = f.database.prepare('UPDATE account_cooking_history SET entry_json=? WHERE event_id=?');
  for (const serialized of ['not-json', JSON.stringify({ ...entry, eventId: randomUUID() })]) {
    corrupt(f, () => update.run(serialized, entry.eventId));
    await assert.rejects(f.read(), rejected('stored_data_invalid'));
  }
  assert.equal(f.payloadReads().length, 0);
  for (const value of [
    { ...entry, timeZone: 'Invalid/Zone' },
    { ...entry, closedSession: null },
    { ...entry, origin: 'backup' },
    { ...entry, contentRef: { ...entry.contentRef, extra: 'authority' } },
  ]) {
    corrupt(f, () => update.run(JSON.stringify(value), entry.eventId));
    await assert.rejects(f.read(), rejected('stored_data_invalid'));
  }
  const duplicated = JSON.stringify(entry).replace('{', `{"recipeId":"${entry.recipeId}",`);
  corrupt(f, () => update.run(duplicated, entry.eventId));
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
});

test('missing, unresolved v2, wrong recipe and substituted exact pins fail before payload materialization', async (t) => {
  const f = await fixture(t),
    entry = f.add(f.exact());
  const restore = () => {
    f.database
      .prepare('DELETE FROM account_history_content_pin WHERE event_id=?')
      .run(entry.eventId);
    f.database
      .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
      .run(
        ownerId,
        entry.eventId,
        entry.recipeId,
        entry.contentRef.revisionId,
        entry.contentRef.contentFingerprint,
      );
  };
  f.database.prepare('DELETE FROM account_history_content_pin WHERE event_id=?').run(entry.eventId);
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  restore();
  f.database
    .prepare(
      "UPDATE account_history_content_pin SET revision_id=NULL,content_fingerprint=NULL,unresolved_reason='recipe_unavailable'",
    )
    .run();
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  restore();
  f.database
    .prepare('UPDATE account_history_content_pin SET revision_id=?,content_fingerprint=?')
    .run(f.secondRef.revisionId, f.secondRef.contentFingerprint);
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  restore();
  corrupt(f, () =>
    f.database.prepare('UPDATE account_history_content_pin SET recipe_id=?').run('99999'),
  );
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  restore();
  corrupt(f, () =>
    f.database
      .prepare('DELETE FROM recipe_content_revision WHERE revision_id=?')
      .run(entry.contentRef.revisionId),
  );
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  assert.equal(f.payloadReads().length, 0);
});

test('legacy unresolved pins are valid but missing, orphaned, malformed or bodyless exact pins are rejected', async (t) => {
  const f = await fixture(t),
    legacy = f.add(f.legacy(), true);
  assert.equal((await f.read()).entries[0]!.readerVersion, 1);
  f.statements.length = 0;
  corrupt(f, () =>
    f.database
      .prepare('UPDATE account_history_content_pin SET unresolved_reason=?')
      .run('guessed_current'),
  );
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  f.database
    .prepare("UPDATE account_history_content_pin SET unresolved_reason='content_mismatch'")
    .run();
  corrupt(f, () =>
    f.database.prepare('UPDATE account_cooking_history SET event_id=?').run(randomUUID()),
  );
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  assert.equal(f.payloadReads().length, 0);
  assert.ok(legacy.eventId);
});

test('entry/removal overlap and invalid removal UUIDs are rejected without returning private IDs', async (t) => {
  const f = await fixture(t),
    entry = f.add(f.exact());
  f.database
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(ownerId, entry.eventId);
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  f.database.prepare('DELETE FROM account_cooking_history_removed').run();
  corrupt(f, () =>
    f.database
      .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
      .run(ownerId, randomUUID() + '\0' + 'x'.repeat(2048)),
  );
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  assert.equal(f.payloadReads().length, 0);
});

test('entry, pin scalar and aggregate byte limits reject before raw rows are allocated', async (t) => {
  const f = await fixture(t),
    entry = f.add(f.exact()),
    json = JSON.stringify(entry);
  corrupt(f, () =>
    f.database
      .prepare('UPDATE account_cooking_history SET entry_json=?')
      .run(json + ' '.repeat(ACCOUNT_HISTORY_ENTRY_MAX_BYTES)),
  );
  await assert.rejects(f.read(), rejected('too_large'));
  f.database.prepare('UPDATE account_cooking_history SET entry_json=?').run(json);
  corrupt(f, () =>
    f.database
      .prepare('UPDATE account_history_content_pin SET revision_id=?')
      .run('x\0' + 'x'.repeat(1024 * 1024)),
  );
  await assert.rejects(f.read(), rejected('stored_data_invalid'));
  f.database
    .prepare('UPDATE account_history_content_pin SET revision_id=?')
    .run(entry.contentRef.revisionId);
  f.database.exec('BEGIN');
  try {
    for (let index = 0; index < 280; index++) f.add({ ...f.exact(), note: '🍲'.repeat(2000) });
    f.database.exec('COMMIT');
  } catch (error) {
    f.database.exec('ROLLBACK');
    throw error;
  }
  await assert.rejects(f.read(), rejected('too_large'));
  assert.equal(f.payloadReads().length, 0);
});

test('row cardinality bounds are enforced before loading withdrawal IDs', async (t) => {
  const f = await fixture(t),
    insert = f.database.prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)');
  f.database.exec('BEGIN');
  try {
    for (let index = 0; index < 10001; index++) insert.run(ownerId, randomUUID());
    f.database.exec('COMMIT');
  } catch (error) {
    f.database.exec('ROLLBACK');
    throw error;
  }
  await assert.rejects(f.read(), rejected('too_large'));
  assert.equal(f.payloadReads().length, 0);
});
