import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createRecipeContentRevision } from '@cookmate/catalogue/content';
import { cookingContentIdentity, type CookingHistoryEntry, type RepositoryResult } from '../src';
import { validatePortableContentBackup } from '../src/portableBackupContent';
import { createPortableContentBackupReader } from '../../../apps/mobile/src/data/portableContentBackup';
import { createPortableBackupReader } from '../../../apps/mobile/src/data/portableBackup';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { retainCookingRevisionInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import type {
  ContentCookedReceipt,
  ContentCookingHistoryEntry,
} from '../../../apps/mobile/src/data/contentCookingHistoryRecords';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Disposable persistence fixtures only. Captured refs convey no signed-publication trust or restore authority.
const at = '2026-10-01T12:00:00.000Z',
  ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rawNote = '  Keep exact\nكمية 🍲\u0000\\ ',
  rawAmount = ' 1 ½ ',
  rawUnit = 'tsp. ';
function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function failed(result: { kind: string; error?: { messageKey: string } }, key?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  assert.equal(Object.hasOwn(result, 'value'), false);
  if (key) assert.equal(result.error?.messageKey, `backup.content_${key}`);
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-backup-'));
  const path = join(directory, 'backup.db'),
    write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  t.after(async () => {
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  const installationId = randomUUID();
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId, shoppingScopeId: randomUUID(), conversationId: randomUUID() },
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
  const recipe = catalogue.recipes[0]!,
    identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  const legacy: CookingHistoryEntry = {
    ...identity,
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: rawNote,
    historyEpoch: 0,
    revision: 1,
  };
  const unresolved = { ...legacy, eventId: randomUUID(), contentFingerprint: 'f'.repeat(64) };
  for (const event of [legacy, unresolved])
    db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
      event.eventId,
      event.cookedOn,
      at,
      'a'.repeat(64),
      JSON.stringify({ kind: 'saved', event, closedSession: null }),
    );
  const backup = { ...legacy, eventId: randomUUID(), origin: 'backup' as const },
    restoreId = randomUUID();
  db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
    restoreId,
    'a'.repeat(64),
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
  const {
    revision: _revision,
    historyEpoch: _epoch,
    ...account
  } = { ...legacy, eventId: randomUUID() };
  db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
    ownerId,
    account.eventId,
    JSON.stringify(account),
  );
  db.exec('UPDATE cooking_state SET history_revision=7');
  await migrateCookingContentDatabase(writer, { sha256 });
  const document = authoredFixture(recipe.recipeId);
  document.recipe.ingredients[0]!.rawMeasure = '100g';
  const first = await createRecipeContentRevision(document, 'backup-first', sha256);
  const next = clone(document);
  next.recipe.ingredients[0]!.rawMeasure = '200g';
  const second = await createRecipeContentRevision(next, 'backup-second', sha256);
  for (const value of [first, second])
    await writer.transaction((session) => retainCookingRevisionInSnapshot(session, value, sha256));
  const occurrences = [randomUUID(), randomUUID()];
  for (const [index, value] of [first, second].entries()) {
    db.prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)').run(
      occurrences[index]!,
      recipe.recipeId,
      '2026-10-01',
      index === 0 ? 'lunch' : 'dinner',
      at,
      at,
    );
    db.prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)').run(
      occurrences[index]!,
      recipe.recipeId,
      value.ref.revisionId,
      value.ref.contentFingerprint,
    );
  }
  const exact: ContentCookingHistoryEntry = {
    readerVersion: 2,
    recipeId: recipe.recipeId,
    contentRef: first.ref,
    eventId: randomUUID(),
    recipeTitle: first.document.recipe.title,
    photoAssetId: first.document.media[0]!.assetId,
    cookedOn: '2026-10-02',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: rawNote,
    historyEpoch: 0,
    revision: 7,
  };
  const receipt: ContentCookedReceipt = { kind: 'saved', event: exact, closedSession: null };
  db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
    exact.eventId,
    exact.cookedOn,
    at,
    'a'.repeat(64),
    JSON.stringify(receipt),
  );
  db.prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)').run(
    exact.eventId,
    recipe.recipeId,
    first.ref.revisionId,
    first.ref.contentFingerprint,
  );
  db.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(recipe.recipeId, at, at);
  const noteId = randomUUID(),
    collectionId = randomUUID(),
    itemId = randomUUID();
  db.prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)').run(
    noteId,
    recipe.recipeId,
    JSON.stringify(rawNote),
    at,
    at,
  );
  db.prepare('INSERT INTO personal_collection VALUES (?,?,0,1,?,?)').run(
    collectionId,
    JSON.stringify(' My dinners '),
    at,
    at,
  );
  db.prepare('INSERT INTO personal_collection_member VALUES (?,?,1,1,?)').run(
    collectionId,
    recipe.recipeId,
    at,
  );
  db.prepare("INSERT INTO manual_shopping_item VALUES (?,?,?,?, 'pantry',1,0,1,?,?)").run(
    itemId,
    JSON.stringify(' Lemons '),
    JSON.stringify(rawAmount),
    JSON.stringify(rawUnit),
    at,
    at,
  );
  db.prepare('UPDATE conversation SET composer_draft=?').run(
    JSON.stringify('PRIVATE DRAFT SENTINEL'),
  );
  db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
    'fixture-secret',
    'PRIVATE TOKEN SENTINEL',
  );
  db.prepare('INSERT INTO personal_operation VALUES (?,?,?)').run(
    randomUUID(),
    'a'.repeat(64),
    JSON.stringify({ private: 'PRIVATE RECEIPT SENTINEL' }),
  );
  db.exec("UPDATE state_revision SET revision=7 WHERE collection='store'");
  let access: ContentAdoptionAccess | null = { ownerId, authGeneration: 1 },
    onHash: ((text: string) => Promise<void>) | undefined;
  const options = {
    reader,
    installationId,
    catalogue: catalogue.identity,
    now: () => at,
    sha256: async (text: string) => {
      await onHash?.(text);
      return sha256(text);
    },
    getAccess: () => access,
    assertAccess: (scope: Readonly<ContentAdoptionAccess>): undefined => {
      assert.deepEqual(scope, access);
      return undefined;
    },
  };
  const capture = createPortableContentBackupReader(options);
  t.after(() => capture.close());
  return {
    db,
    read,
    writer,
    reader,
    capture,
    options,
    legacy,
    unresolved,
    backup,
    account,
    exact,
    receipt,
    first,
    second,
    occurrences,
    noteId,
    itemId,
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    onHash(value: typeof onHash) {
      onHash = value;
    },
  };
}
function snapshot(store: Awaited<ReturnType<typeof fixture>>) {
  const tables = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return tables.map(({ name }) => ({
    name,
    rows: store.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
  }));
}

test('actual migrated8 capture reports physical8 and preserves exact account history without receipts or schema7 byte drift', async (t) => {
  const store = await fixture(t);
  const original = ready(await store.capture.capture({ includeCookingHistory: true }));
  assert.deepEqual(ready(await store.capture.capture({ includeCookingHistory: true })), original);
  await migrateAccountContentHistoryDatabase(store.writer, { sha256 });
  const { historyEpoch: _epoch, revision: _revision, ...wire } = store.exact;
  const account = { ...wire, eventId: randomUUID(), cookedOn: '2026-10-03' };
  store.db
    .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
    .run(ownerId, account.eventId, JSON.stringify(account));
  store.db
    .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
    .run(
      ownerId,
      account.eventId,
      account.recipeId,
      account.contentRef.revisionId,
      account.contentRef.contentFingerprint,
    );
  const before = snapshot(store);
  const value = ready(await store.capture.capture({ includeCookingHistory: true }));
  assert.equal(value.databaseSchemaVersion, 8);
  assert.deepEqual(value.data.planReferences, original.data.planReferences);
  assert.equal(
    value.data.cookingHistory!.entries.length,
    original.data.cookingHistory!.entries.length + 1,
  );
  assert.deepEqual(
    value.data.cookingHistory!.entries.find((item) => item.entry.eventId === account.eventId),
    {
      kind: 'exact',
      entry: { ...account, historyEpoch: 0, revision: 7 },
    },
  );
  assert.equal(
    store.db.prepare('SELECT 1 FROM cooking_event WHERE event_id=?').get(account.eventId),
    undefined,
  );
  assert.equal(
    (await validatePortableContentBackup(JSON.stringify(value), { sha256 })).kind,
    'ready',
  );
  const old = createPortableBackupReader(store.reader, {
    catalogue: catalogue.identity,
    sha256,
    now: () => at,
  });
  assert.equal((await old()).kind, 'failed');
  assert.deepEqual(snapshot(store), before);
});

test('actual migrated8 history-off backup never fetches history entry payloads or withdrawal identities', async (t) => {
  const store = await fixture(t);
  await migrateAccountContentHistoryDatabase(store.writer, { sha256 });
  const withdrawn = randomUUID();
  store.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(withdrawn);
  const originalAll = store.read.connection.all;
  store.read.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    const rows = await originalAll<Row>(sql, values);
    const bytes = JSON.stringify(rows);
    for (const id of [store.exact.eventId, store.legacy.eventId, store.account.eventId, withdrawn])
      assert.equal(bytes.includes(id), false, 'Excluded history identity fetched');
    assert.doesNotMatch(bytes, /"(?:entryJson|receiptJson|entry_json|receipt_json)":/);
    return rows;
  };
  const before = snapshot(store),
    value = ready(await store.capture.capture());
  assert.equal(value.databaseSchemaVersion, 8);
  assert.equal(Object.hasOwn(value.data, 'cookingHistory'), false);
  assert.equal(value.data.personal.notes[0]!.text, rawNote);
  assert.deepEqual(snapshot(store), before);
});

test('captures core/personal and both exact versions of one planned recipe atomically, with history excluded by default', async (t) => {
  const store = await fixture(t),
    before = snapshot(store),
    result = await store.capture.capture(),
    value = ready(result);
  assert.equal(value.schemaVersion, 3);
  assert.equal(value.databaseSchemaVersion, 7);
  assert.equal(value.sourceRevision, 7);
  assert.equal(result.kind === 'ready' && result.revision, 7);
  assert.equal(Object.hasOwn(value.data, 'cookingHistory'), false);
  assert.equal(value.data.personal.notes[0]!.text, rawNote);
  assert.equal(value.data.personal.manualItems[0]!.amountText, rawAmount);
  assert.equal(value.data.personal.manualItems[0]!.unitText, rawUnit);
  assert.deepEqual(
    new Map(value.data.planReferences.map((row) => [row.occurrenceId, row.contentRef])),
    new Map([
      [store.occurrences[0], store.first.ref],
      [store.occurrences[1], store.second.ref],
    ]),
  );
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    'PRIVATE DRAFT SENTINEL',
    'PRIVATE TOKEN SENTINEL',
    'PRIVATE RECEIPT SENTINEL',
    'recipe_content_revision',
    'rawMeasure',
    'closedSession',
    'sessionId',
    'ownerId',
    'requestFingerprint',
  ])
    assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal((await validatePortableContentBackup(serialized, { sha256 })).kind, 'ready');
  assert.ok(Object.isFrozen(value.data.personal.notes));
  assert.deepEqual(snapshot(store), before);
});
test('explicit history includes exact, legacy, unresolved, imported and account metadata while preserving original entries', async (t) => {
  const store = await fixture(t),
    before = snapshot(store),
    value = ready(await store.capture.capture({ includeCookingHistory: true }));
  const entries = value.data.cookingHistory!.entries;
  assert.equal(entries.length, 5);
  assert.equal(value.counts.cookingHistory, 5);
  assert.deepEqual(
    entries.find((row) => row.entry.eventId === store.exact.eventId),
    { kind: 'exact', entry: store.exact },
  );
  assert.deepEqual(
    entries.find((row) => row.entry.eventId === store.unresolved.eventId),
    {
      kind: 'legacy',
      entry: store.unresolved,
      pin: { kind: 'unresolved', reason: 'content_mismatch' },
    },
  );
  assert.deepEqual(
    entries.find((row) => row.entry.eventId === store.backup.eventId)?.entry,
    store.backup,
  );
  assert.deepEqual(entries.find((row) => row.entry.eventId === store.account.eventId)?.entry, {
    ...store.account,
    historyEpoch: 0,
    revision: 7,
  });
  assert.deepEqual(snapshot(store), before);
});
test('history selection respects local withdrawals and account removal facts without copying deletion receipts', async (t) => {
  const store = await fixture(t);
  store.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(store.backup.eventId);
  store.db
    .prepare('DELETE FROM account_history_content_pin WHERE event_id=?')
    .run(store.account.eventId);
  store.db
    .prepare('DELETE FROM account_cooking_history WHERE event_id=?')
    .run(store.account.eventId);
  store.db
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(ownerId, store.account.eventId);
  const before = snapshot(store),
    value = ready(await store.capture.capture({ includeCookingHistory: true }));
  assert.equal(value.data.cookingHistory!.entries.length, 3);
  assert.deepEqual(snapshot(store), before);
});
test('the legacy export reader still refuses schema seven and invalid capture options never export', async (t) => {
  const store = await fixture(t),
    before = snapshot(store);
  const old = createPortableBackupReader(store.reader, {
    catalogue: catalogue.identity,
    sha256,
    now: () => at,
  });
  assert.equal((await old()).kind, 'failed');
  for (const input of [
    null,
    { includeCookingHistory: 'yes' },
    { includeCookingHistory: true, credentials: true },
  ])
    failed(
      await store.capture.capture(input as Parameters<typeof store.capture.capture>[0]),
      'invalid_options',
    );
  assert.deepEqual(snapshot(store), before);
});
test('baseline mismatch, wrong installation and replaced owner binding produce no portable file', async (t) => {
  const store = await fixture(t);
  const wrongBaseline = createPortableContentBackupReader({
    ...store.options,
    catalogue: { ...catalogue.identity, fingerprint: 'f'.repeat(64) },
  });
  failed(await wrongBaseline.capture(), 'source_invalid');
  wrongBaseline.close();
  const wrongInstallation = createPortableContentBackupReader({
    ...store.options,
    installationId: randomUUID(),
  });
  failed(await wrongInstallation.capture(), 'access_changed');
  wrongInstallation.close();
  store.db
    .prepare('UPDATE app_metadata SET value=? WHERE key=?')
    .run(JSON.stringify({ schemaVersion: 1, ownerId: randomUUID() }), ACCOUNT_BINDING_KEY);
  failed(await store.capture.capture(), 'access_changed');
});
test('malformed and oversized core or personal fields fail before their raw values can be materialized', async (t) => {
  const store = await fixture(t),
    all = store.read.connection.all;
  let largest = 0;
  store.read.connection.all = async <Row extends object>(
    sql: string,
    values: readonly SqlValue[] = [],
  ) => {
    const rows = await all<Row>(sql, values);
    for (const row of rows)
      for (const value of Object.values(row))
        if (typeof value === 'string') largest = Math.max(largest, Buffer.byteLength(value));
    return rows;
  };
  try {
    for (const [table, column, key, value] of [
      ['recipe_note', 'text', 'note_id', JSON.stringify('x'.repeat(100000))],
      ['recipe_note', 'text', 'note_id', 'not-json'],
      ['plan_occurrence', 'updated_at', 'occurrence_id', 'x'.repeat(100000)],
    ]) {
      const identity = table === 'recipe_note' ? store.noteId : store.occurrences[0]!;
      const old = store.db
        .prepare(`SELECT ${column} value FROM ${table} WHERE ${key}=?`)
        .get(identity) as { value: string };
      store.db.exec('PRAGMA ignore_check_constraints=ON');
      store.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(value!, identity);
      store.db.exec('PRAGMA ignore_check_constraints=OFF');
      const before = snapshot(store);
      largest = 0;
      failed(await store.capture.capture());
      assert.ok(largest < 100000);
      assert.deepEqual(snapshot(store), before);
      store.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`).run(old.value, identity);
    }
  } finally {
    store.read.connection.all = all;
  }
});
test('aggregate source bounds reject before copying individually valid large personal rows', async (t) => {
  const store = await fixture(t);
  store.db
    .exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<2300)
    INSERT INTO personal_collection(collection_id,name,deleted,revision,created_at,updated_at)
    SELECT printf('99999999-9999-4999-8999-%012x',n),json_quote(replace(hex(zeroblob(40)),'0','x')),0,1,'${at}','${at}' FROM numbers`);
  // Values are individually bounded SQL text; add a sufficiently large note projection, without
  // allocating a huge JavaScript source string or accepting a partial export.
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.db
    .exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<2300)
    INSERT INTO recipe_note(note_id,recipe_id,text,deleted,revision,created_at,updated_at)
    SELECT printf('99999999-9999-4999-8999-%012x',n),CAST(700000+n AS TEXT),json_quote(replace(hex(zeroblob(1800)),'0','x')),0,1,'${at}','${at}' FROM numbers`);
  store.db.exec('PRAGMA foreign_keys=ON');
  failed(await store.capture.capture(), 'too_large');
});
test('missing, extra, mismatched or corrupted planned revision pins never produce a partial exact-reference list', async (t) => {
  const store = await fixture(t),
    id = store.occurrences[0]!;
  store.db.prepare('DELETE FROM plan_content_pin WHERE occurrence_id=?').run(id);
  failed(await store.capture.capture());
  store.db
    .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
    .run(
      id,
      store.first.ref.recipeId,
      store.first.ref.revisionId,
      store.first.ref.contentFingerprint,
    );
  store.db.exec('PRAGMA foreign_keys=OFF');
  const orphan = randomUUID();
  store.db
    .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
    .run(
      orphan,
      store.first.ref.recipeId,
      store.first.ref.revisionId,
      store.first.ref.contentFingerprint,
    );
  store.db.exec('PRAGMA foreign_keys=ON');
  failed(await store.capture.capture());
  store.db.prepare('DELETE FROM plan_content_pin WHERE occurrence_id=?').run(orphan);
  store.db.exec('PRAGMA ignore_check_constraints=ON');
  store.db.prepare('UPDATE recipe_content_revision SET revision_json=? WHERE revision_id=?').run(
    JSON.stringify({
      ...store.first,
      document: {
        ...store.first.document,
        recipe: { ...store.first.document.recipe, title: 'Tampered' },
      },
    }),
    store.first.ref.revisionId,
  );
  store.db.exec('PRAGMA ignore_check_constraints=OFF');
  const before = snapshot(store);
  failed(await store.capture.capture());
  assert.deepEqual(snapshot(store), before);
});
test('history remains unread when excluded; included history rejects pin corruption and foreign account data', async (t) => {
  const store = await fixture(t);
  store.db
    .prepare('DELETE FROM local_history_content_pin WHERE event_id=?')
    .run(store.exact.eventId);
  ready(await store.capture.capture());
  failed(await store.capture.capture({ includeCookingHistory: true }));
  store.db
    .prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)')
    .run(
      store.exact.eventId,
      store.first.ref.recipeId,
      store.first.ref.revisionId,
      store.first.ref.contentFingerprint,
    );
  store.db
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(randomUUID(), randomUUID());
  failed(await store.capture.capture({ includeCookingHistory: true }));
});
test('more than one hundred exact history records reuse their snapshot proof across capture batches', async (t) => {
  const store = await fixture(t);
  store.db
    .prepare(
      `WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<205), ids AS(SELECT printf('99999999-9999-4999-8999-%012x',n) id FROM nums)
    INSERT INTO cooking_event SELECT id,0,'saved',?,?,?,json_set(?,'$.event.eventId',id) FROM ids`,
    )
    .run(store.exact.cookedOn, at, 'a'.repeat(64), JSON.stringify(store.receipt));
  store.db
    .prepare(
      "INSERT INTO local_history_content_pin SELECT event_id,?,?,?,NULL FROM cooking_event WHERE event_id LIKE '99999999-9999-4999-8999-%'",
    )
    .run(store.first.ref.recipeId, store.first.ref.revisionId, store.first.ref.contentFingerprint);
  let firstProofs = 0;
  store.onHash(async (text) => {
    if (text.startsWith('["cookmate-recipe-content-v1",') && text.includes('"rawMeasure":"100g"'))
      firstProofs++;
  });
  const value = ready(await store.capture.capture({ includeCookingHistory: true }));
  assert.equal(value.data.cookingHistory!.entries.length, 210);
  assert.equal(
    firstProofs,
    2,
    'one plan proof and one shared history proof, independent of batch count',
  );
});
test('owner or generation loss during final checksum suppresses an otherwise completed export', async (t) => {
  const store = await fixture(t),
    before = snapshot(store);
  for (const next of [null, { ownerId, authGeneration: 2 }]) {
    store.setAccess({ ownerId, authGeneration: 1 });
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        reached = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    store.onHash(async (text) => {
      if (text.includes('"format":"cookmate-local-backup"')) {
        reached();
        await gate;
      }
    });
    const pending = store.capture.capture();
    try {
      await entered;
      store.setAccess(next);
      release();
      failed(await pending, 'access_changed');
    } finally {
      release();
      store.onHash(undefined);
    }
  }
  assert.deepEqual(snapshot(store), before);
});
test('capture uses one read-only snapshot and returns no file after its instance is closed', async (t) => {
  const store = await fixture(t),
    original = store.read.connection.exec;
  const statements: string[] = [];
  store.read.connection.exec = async (sql) => {
    statements.push(sql);
    return original(sql);
  };
  try {
    ready(await store.capture.capture({ includeCookingHistory: true }));
    assert.deepEqual(statements, ['BEGIN', 'COMMIT']);
    store.capture.close();
    failed(await store.capture.capture(), 'access_changed');
    assert.deepEqual(statements, ['BEGIN', 'COMMIT']);
  } finally {
    store.read.connection.exec = original;
  }
});

test('schema8 backup clocks reject invalid scalars before bridge transfer while omitted history stays unread', async (t) => {
  const store = await fixture(t);
  await migrateAccountContentHistoryDatabase(store.writer, { sha256 });
  const all = store.read.connection.all;
  let oversizedTransfers = 0;
  store.read.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    const rows = await all<Row>(sql, values);
    for (const row of rows)
      for (const value of Object.values(row))
        if ((typeof value === 'string' || value instanceof Uint8Array) && value.length >= 1048576)
          oversizedTransfers++;
    return rows;
  };
  try {
    for (const [table, column, predicate, historyOnly] of [
      ['cooking_state', 'history_revision', 'singleton=1', true],
      ['cooking_state', 'history_epoch', 'singleton=1', true],
      ['state_revision', 'revision', "collection='store'", false],
      ['state_revision', 'revision', "collection='preferences'", false],
    ] as const) {
      const original = store.db
        .prepare(`SELECT ${column} value FROM ${table} WHERE ${predicate}`)
        .get() as { value: number };
      for (const value of ['x'.repeat(1048576), Buffer.alloc(1048576), -1, 0.5, 2 ** 53]) {
        store.db.exec('PRAGMA ignore_check_constraints=ON');
        store.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${predicate}`).run(value);
        store.db.exec('PRAGMA ignore_check_constraints=OFF');
        const changes = store.db.prepare('SELECT total_changes() count').get();
        failed(await store.capture.capture({ includeCookingHistory: true }));
        if (historyOnly) {
          const withoutHistory = ready(await store.capture.capture());
          assert.equal(Object.hasOwn(withoutHistory.data, 'cookingHistory'), false);
        } else failed(await store.capture.capture());
        assert.equal(oversizedTransfers, 0, `${table}.${column} crossed the SQL bridge`);
        assert.deepEqual(store.db.prepare('SELECT total_changes() count').get(), changes);
        store.db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${predicate}`).run(original.value);
      }
    }
    assert.equal(
      ready(await store.capture.capture({ includeCookingHistory: true })).databaseSchemaVersion,
      8,
    );
  } finally {
    store.read.connection.all = all;
  }
});

test('schema8 capture retirement during checksum returns no file even when hashing rejects', async (t) => {
  const store = await fixture(t);
  await migrateAccountContentHistoryDatabase(store.writer, { sha256 });
  const before = snapshot(store);
  store.onHash(async (text) => {
    if (text.includes('"format":"cookmate-local-backup"')) {
      store.capture.close();
      throw new Error('Synthetic retired checksum');
    }
  });
  const result = await store.capture.capture();
  failed(result, 'access_changed');
  assert.equal(result.kind === 'failed' && result.error.code, 'stale_context');
  assert.deepEqual(snapshot(store), before);
});
