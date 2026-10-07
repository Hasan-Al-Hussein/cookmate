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
import {
  cookingContentIdentity,
  type CookingHistoryEntry,
  type PortablePersonalData,
  type RepositoryResult,
} from '../src';
import {
  createPortableContentBackup,
  type PortableContentBackupEnvelope,
  type PortableContentHistoryRecord,
} from '../src/portableBackupContent';
import { createPortableContentBackupReader } from '../../../apps/mobile/src/data/portableContentBackup';
import { createContentCookingHistoryReader } from '../../../apps/mobile/src/data/contentCookingHistoryRead';
import { createContentCookingHistoryClear } from '../../../apps/mobile/src/data/contentCookingHistoryClear';
import { replacePortableContentExpandedData } from '../../../apps/mobile/src/data/portableContentRestoreExpanded';
import { checkPortablePersonalRestore } from '../../../apps/mobile/src/data/portablePersonalRestore';
import { writePreparedPortablePersonalRestoreData } from '../../../apps/mobile/src/data/portableRestoreExpanded';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  retainCookingRevisionInSnapshot,
  verifyHistoryContentBindings,
} from '../../../apps/mobile/src/data/cookingContentRepository';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Transaction-local persistence only. The test caller supplies retained fixture revisions and
// a restore ledger; neither establishes signed publication or a mounted restore service.
const at = '2026-10-01T12:00:00.000Z',
  restoredAt = '2026-10-01T13:00:00.000Z';
function ready<Value>(result: RepositoryResult<Value> | { kind: 'uncertain' }): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}

async function fixture(t: TestContext, databaseVersion: 7 | 8 = 7) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-expanded-'));
  const path = join(directory, 'cooking.db'),
    write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  t.after(async () => {
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(
    writer,
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
  const db = write.database,
    ownerId = randomUUID(),
    access: ContentAdoptionAccess = { ownerId, authGeneration: 0 };
  db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
    ACCOUNT_BINDING_KEY,
    JSON.stringify({ schemaVersion: 1, ownerId }),
  );
  const recipes = catalogue.recipes.slice(0, 3),
    recipe = recipes[0]!,
    identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  const legacy: CookingHistoryEntry = {
    ...identity,
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-09-29',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'Original local receipt bytes',
    historyEpoch: 1,
    revision: 3,
  };
  const oldLocal = { ...legacy, eventId: randomUUID(), historyEpoch: 0, revision: 1 };
  for (const event of [legacy, oldLocal])
    db.prepare("INSERT INTO cooking_event VALUES (?,?,'saved',?,?,?,?)").run(
      event.eventId,
      event.historyEpoch,
      event.cookedOn,
      at,
      'a'.repeat(64),
      JSON.stringify({ kind: 'saved', event, closedSession: null }, null, 2),
    );
  const oldRestoreId = randomUUID(),
    oldSourceId = randomUUID(),
    oldImported = { ...legacy, eventId: randomUUID(), origin: 'backup' as const };
  db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
    oldRestoreId,
    'a'.repeat(64),
    '{}',
    '{}',
    '{}',
  );
  db.prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,1,?,?,?)').run(
    oldImported.eventId,
    oldSourceId,
    oldRestoreId,
    oldImported.cookedOn,
    at,
    JSON.stringify(oldImported),
  );
  const {
    historyEpoch: _epoch,
    revision: _revision,
    ...account
  } = { ...legacy, eventId: randomUUID() };
  db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
    ownerId,
    account.eventId,
    JSON.stringify(account),
  );
  const personal: PortablePersonalData = {
    notes: recipes.map((row, index) => ({
      noteId: randomUUID(),
      recipeId: row.recipeId,
      text: index === 1 ? null : `Keep note ${index}`,
      deleted: index === 1,
      revision: 2,
      createdAt: at,
      updatedAt: at,
    })),
    collections: [
      {
        collectionId: randomUUID(),
        name: 'Collection',
        deleted: false,
        revision: 2,
        createdAt: at,
        updatedAt: at,
      },
      {
        collectionId: randomUUID(),
        name: null,
        deleted: true,
        revision: 2,
        createdAt: at,
        updatedAt: at,
      },
    ],
    memberships: [],
    manualItems: [
      {
        kind: 'manual',
        itemId: randomUUID(),
        name: 'Omitted item',
        amountText: '2',
        unitText: 'cups',
        category: 'pantry',
        purchased: true,
        deleted: false,
        revision: 2,
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
  personal.memberships = [
    {
      collectionId: personal.collections[0]!.collectionId,
      recipeId: recipe.recipeId,
      present: true,
      revision: 2,
      updatedAt: at,
    },
    {
      collectionId: personal.collections[0]!.collectionId,
      recipeId: recipes[1]!.recipeId,
      present: false,
      revision: 2,
      updatedAt: at,
    },
  ];
  await writer.transaction((session) =>
    writePreparedPortablePersonalRestoreData(session, personal, 2),
  );
  db.exec(
    "UPDATE cooking_state SET history_epoch=1,history_revision=3; UPDATE state_revision SET revision=3 WHERE collection='store'",
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
  await migrateCookingContentDatabase(writer, { sha256 });
  const authored = await createRecipeContentRevision(
      authoredFixture('90001'),
      'expanded-authored',
      sha256,
    ),
    bundled = await createBundledRecipeRevision(recipe.recipeId, sha256);
  await writer.transaction((session) => retainCookingRevisionInSnapshot(session, authored, sha256));
  const exact: PortableContentHistoryRecord = {
    kind: 'exact',
    entry: {
      readerVersion: 2,
      recipeId: authored.ref.recipeId,
      contentRef: { ...authored.ref },
      eventId: randomUUID(),
      recipeTitle: authored.document.recipe.title,
      photoAssetId: authored.document.media[0]!.assetId,
      cookedOn: '2026-09-30',
      timeZone: 'Asia/Dubai',
      recordedAt: at,
      note: '  Restored exact note\nكمية 🍲  ',
      historyEpoch: 9,
      revision: 42,
    },
  };
  const legacyRecord: PortableContentHistoryRecord = {
    kind: 'legacy',
    entry: legacy,
    pin: { kind: 'exact', ref: { ...bundled.ref } },
  };
  const common = {
    reader,
    writer,
    installationId: ids.installationId,
    sha256,
    now: () => restoredAt,
    getAccess: () => access,
    assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined {
      assert.deepEqual(scope, access);
      return undefined;
    },
    onCommitted() {},
  };
  if (databaseVersion === 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const restoreOptions = databaseVersion === 8 ? { cookingSchemaVersion: 8 as const } : {};
  const capture = createPortableContentBackupReader({ ...common, catalogue: catalogue.identity }),
    history = createContentCookingHistoryReader(common),
    clear = createContentCookingHistoryClear({ ...common, ...restoreOptions, newId: randomUUID });
  t.after(() => {
    capture.close();
    history.close();
    clear.close();
  });
  const base = ready(await capture.capture());
  async function source(
    entries: PortableContentHistoryRecord[] | null = [exact, legacyRecord],
    imported: PortablePersonalData = {
      notes: [{ ...personal.notes[0]!, text: ' Reviewed replacement  ' }],
      collections: [],
      memberships: [],
      manualItems: [],
    },
  ) {
    const { cookingHistory: _history, ...data } = base.data;
    return createPortableContentBackup(
      {
        schemaVersion: 3,
        databaseSchemaVersion: databaseVersion,
        createdAt: at,
        catalogue: catalogue.identity,
        sourceRevision: 3,
        data: {
          ...data,
          personal: imported,
          ...(entries === null ? {} : { cookingHistory: { entries } }),
        },
      },
      sha256,
    );
  }
  function snapshot(tables?: readonly string[]) {
    const names =
      tables ??
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name);
    return names.map((name) => ({
      name,
      rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
    }));
  }
  async function apply(
    value: Parameters<typeof replacePortableContentExpandedData>[1],
    operationId: string = randomUUID(),
    revision = 4,
    hash = sha256,
  ) {
    return writer.transaction(async (session) => {
      const result = await replacePortableContentExpandedData(
        session,
        value,
        operationId,
        revision,
        hash,
        restoredAt,
        restoreOptions,
      );
      const ledger = await session.prepare(
        'INSERT INTO portable_restore_operation VALUES (?,?,3,?,?,?,?)',
      );
      try {
        await ledger.run([
          operationId,
          value.integrity.digest,
          revision,
          JSON.stringify(value),
          '{}',
          '{}',
        ]);
      } finally {
        await ledger.finalize();
      }
      await verifyHistoryContentBindings(session, sha256);
      return result;
    });
  }
  return {
    db,
    write,
    read,
    writer,
    reader,
    source,
    apply,
    snapshot,
    history,
    capture,
    clear,
    personal,
    exact,
    legacyRecord,
    legacy,
    oldLocal,
    oldImported,
    oldSourceId,
    account,
    ownerId,
    authored,
    bundled,
  };
}

test('source8 metadata can restore compatible format3 data into physical7 without migrating or rewriting the source', async (t) => {
  const f = await fixture(t),
    seven = await f.source();
  const eight = await createPortableContentBackup(
    {
      schemaVersion: 3,
      databaseSchemaVersion: 8,
      createdAt: seven.createdAt,
      catalogue: { ...seven.catalogue },
      sourceRevision: seven.sourceRevision,
      data: JSON.parse(JSON.stringify(seven.data)),
    },
    sha256,
  );
  const sourceBytes = JSON.stringify(eight);
  const result = await f.apply(eight);
  assert.equal(result.importedHistoryCount, 2);
  assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 7);
  assert.equal(JSON.stringify(eight), sourceBytes);
  const history = ready(await f.history.readHistory());
  assert.equal(history.items.length, 2);
});

test('physical8 expanded replacement requires explicit target and preserves account exact history removal lineage', async (t) => {
  const f = await fixture(t, 8),
    source = await f.source();
  const before = f.snapshot();
  await assert.rejects(
    f.writer.transaction((session) =>
      replacePortableContentExpandedData(session, source, randomUUID(), 4, sha256, restoredAt),
    ),
  );
  await assert.rejects(
    f.reader.transaction((session) =>
      checkPortablePersonalRestore(session, source, { contentSchema: true }),
    ),
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.exact.kind, 'exact');
  if (f.exact.kind !== 'exact') assert.fail();
  const { historyEpoch: _epoch, revision: _revision, ...entry } = f.exact.entry;
  const account = { ...entry, eventId: randomUUID() };
  f.db
    .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
    .run(f.ownerId, account.eventId, JSON.stringify(account));
  f.db
    .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
    .run(
      f.ownerId,
      account.eventId,
      account.recipeId,
      account.contentRef.revisionId,
      account.contentRef.contentFingerprint,
    );
  const receipts = f.snapshot([
    'cooking_event',
    'local_history_content_pin',
    'content_cooking_event_authority',
  ]);
  assert.equal((await f.apply(source)).historyIncluded, true);
  assert.ok(
    f.db.prepare('SELECT 1 FROM cooking_history_withdrawal WHERE event_id=?').get(account.eventId),
  );
  assert.ok(
    f.db
      .prepare('SELECT 1 FROM account_cooking_history_removed WHERE owner_id=? AND event_id=?')
      .get(f.ownerId, account.eventId),
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_history_content_pin').get()!.n, 0);
  assert.deepEqual(f.snapshot(receipts.map((row) => row.name)), receipts);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 8);
});

test('physical8 expanded restore rejects large personal and history clocks before bridge transfer or writes', async (t) => {
  const f = await fixture(t, 8),
    source = await f.source();
  let oversizedTransfers = 0;
  for (const connection of [f.read.connection, f.write.connection]) {
    const all = connection.all;
    connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      const rows = await all<Row>(sql, values);
      for (const row of rows)
        for (const value of Object.values(row))
          if ((typeof value === 'string' || value instanceof Uint8Array) && value.length >= 1048576)
            oversizedTransfers++;
      return rows;
    };
  }
  for (const [table, column] of [
    ['personal_state', 'revision'],
    ['personal_state', 'epoch'],
    ['cooking_state', 'history_revision'],
    ['cooking_state', 'history_epoch'],
  ]) {
    const original = f.db.prepare(`SELECT ${column} value FROM ${table}`).get() as {
      value: number;
    };
    for (const value of ['x'.repeat(1048576), Buffer.alloc(1048576), -1, 0.5, 2 ** 53]) {
      f.db.exec('PRAGMA ignore_check_constraints=ON');
      f.db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
      f.db.exec('PRAGMA ignore_check_constraints=OFF');
      const changes = f.db.prepare('SELECT total_changes() n').get();
      await assert.rejects(f.apply(source));
      assert.equal(oversizedTransfers, 0, `${table}.${column} crossed the SQL bridge`);
      assert.deepEqual(f.db.prepare('SELECT total_changes() n').get(), changes);
      f.db.prepare(`UPDATE ${table} SET ${column}=?`).run(original.value);
    }
  }
  assert.equal((await f.apply(source)).importedHistoryCount, 2);
});

for (const version of [7, 8] as const)
  test(`physical${version} mixed exact/legacy replacement retains personal removals, rebases imported clocks and keeps original local receipt bytes/pins`, async (t) => {
    const f = await fixture(t, version),
      source = await f.source(),
      operationId = randomUUID();
    const localBefore = f.snapshot([
      'cooking_event',
      'local_history_content_pin',
      'content_cooking_event_authority',
    ]);
    const unrelated = f.snapshot([
      'plan_occurrence',
      'plan_content_pin',
      'shopping_scope',
      'shopping_selection',
      'shopping_group',
      'shopping_contribution',
      'purchase_state',
      'favourite',
      'app_content_adoption',
    ]);
    assert.equal(
      (
        await f.reader.transaction((session) =>
          checkPortablePersonalRestore(session, source, {
            contentSchema: true,
            ...(version === 8 ? { cookingSchemaVersion: 8 as const } : {}),
          }),
        )
      ).allowed,
      true,
    );
    await assert.rejects(
      f.reader.transaction((session) => checkPortablePersonalRestore(session, source)),
    );
    assert.deepEqual(await f.apply(source, operationId), {
      personal: true,
      historyIncluded: true,
      importedHistoryCount: 2,
      historyEpoch: 2,
    });
    const rows = f.db
      .prepare('SELECT * FROM imported_cooking_history ORDER BY source_event_id')
      .all();
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every((row) => row.restore_operation_id === operationId && row.history_epoch === 2),
    );
    for (const row of rows) {
      const entry = JSON.parse(row.entry_json as string) as Record<string, unknown>;
      assert.equal(entry.origin, 'backup');
      assert.equal(entry.revision, 4);
      assert.equal(entry.historyEpoch, 2);
      assert.notEqual(row.event_id, row.source_event_id);
      assert.equal(
        f.db
          .prepare('SELECT 1 FROM cooking_history_withdrawal WHERE event_id=?')
          .get(row.event_id!),
        undefined,
      );
    }
    const visible = ready(await f.history.readHistory());
    assert.equal(visible.items.length, 2);
    assert.deepEqual(
      new Set(visible.items.map((item) => item.entry.readerVersion)),
      new Set([1, 2]),
    );
    assert.deepEqual(
      f.snapshot(['cooking_event', 'local_history_content_pin', 'content_cooking_event_authority']),
      localBefore,
    );
    assert.deepEqual(f.snapshot(unrelated.map((row) => row.name)), unrelated);
    const notes = f.db
      .prepare(
        'SELECT note_id,text,deleted,revision,updated_at FROM recipe_note ORDER BY recipe_id',
      )
      .all();
    assert.equal(notes.find((row) => row.note_id === f.personal.notes[0]!.noteId)!.deleted, 0);
    for (const note of f.personal.notes.slice(1)) {
      const stored = notes.find((row) => row.note_id === note.noteId)!;
      assert.equal(stored.deleted, 1);
      assert.equal(stored.text, null);
    }
    assert.equal(
      f.db
        .prepare(
          'SELECT present FROM personal_collection_member WHERE collection_id=? AND recipe_id=?',
        )
        .get(f.personal.collections[0]!.collectionId, f.legacy.recipeId)!.present,
      0,
    );
    assert.equal(
      f.db.prepare('SELECT deleted,name,purchased FROM manual_shopping_item').get()!.deleted,
      1,
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_cooking_history').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_history_content_pin').get()!.n, 0);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(
      await (version === 8 ? migrateAccountContentHistoryDatabase : migrateCookingContentDatabase)(
        f.writer,
        { sha256 },
      ),
      'existing',
    );
    const exported = ready(await f.capture.capture({ includeCookingHistory: true }));
    assert.equal(exported.data.cookingHistory?.entries.length, 2);
  });

test('history omission leaves all cooking rows and clocks untouched; explicit empty history withdraws the selected scope', async (t) => {
  const f = await fixture(t, 8),
    source = await f.source(null);
  const tables = [
    'cooking_state',
    'cooking_event',
    'local_history_content_pin',
    'imported_cooking_history',
    'imported_history_content_pin',
    'account_cooking_history',
    'account_history_content_pin',
    'account_cooking_history_removed',
    'cooking_history_withdrawal',
  ];
  const before = f.snapshot(tables);
  assert.deepEqual(await f.apply(source), {
    personal: true,
    historyIncluded: false,
    importedHistoryCount: 0,
    historyEpoch: null,
  });
  assert.deepEqual(f.snapshot(tables), before);
  assert.deepEqual(await f.apply(await f.source([]), randomUUID(), 5), {
    personal: true,
    historyIncluded: true,
    importedHistoryCount: 0,
    historyEpoch: 2,
  });
  assert.equal(ready(await f.history.readHistory()).items.length, 0);
});

test('known personal removals and unresolved legacy history block the whole transaction without deletion', async (t) => {
  const f = await fixture(t);
  const removed = { ...f.personal.notes[1]!, deleted: false, text: 'Cannot resurrect' };
  for (const source of [
    await f.source([], { notes: [removed], collections: [], memberships: [], manualItems: [] }),
    await f.source([
      { kind: 'legacy', entry: f.legacy, pin: { kind: 'unresolved', reason: 'content_mismatch' } },
    ]),
  ]) {
    const before = f.snapshot();
    await assert.rejects(f.apply(source));
    assert.deepEqual(f.snapshot(), before);
  }
});

test('incoming clear/cancellation and withdrawn source-lineage facts reject reimport before any personal or history writes', async (t) => {
  const f = await fixture(t),
    source = await f.source(),
    id = f.exact.entry.eventId;
  for (const state of ['cleared', 'cancelled'] as const) {
    f.db.prepare('INSERT INTO cooking_event VALUES (?,0,?,NULL,NULL,NULL,NULL)').run(id, state);
    const before = f.snapshot();
    await assert.rejects(f.apply(source), /previously removed history/);
    assert.deepEqual(f.snapshot(), before);
    f.db.prepare('DELETE FROM cooking_event WHERE event_id=?').run(id);
  }
  f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(f.oldImported.eventId);
  const fromOldSource = await f.source([
    { ...f.exact, entry: { ...f.exact.entry, eventId: f.oldSourceId } },
  ]);
  const before = f.snapshot();
  await assert.rejects(f.apply(fromOldSource), /previously removed history/);
  assert.deepEqual(f.snapshot(), before);
});

test('deterministic ID collision, invalid hash, clock regression and lineage capacity fail atomically', async (t) => {
  const f = await fixture(t),
    source = await f.source();
  for (const revision of [2, 3]) {
    const before = f.snapshot();
    await assert.rejects(f.apply(source, randomUUID(), revision), /revision must advance/);
    assert.deepEqual(f.snapshot(), before);
  }
  for (const hash of [
    async () => 'invalid',
    async () => {
      throw new Error('fixture hash failed');
    },
    async () => '1'.repeat(64),
  ]) {
    const before = f.snapshot();
    await assert.rejects(f.apply(source, randomUUID(), 4, hash));
    assert.deepEqual(f.snapshot(), before);
  }
  const cancelled = '11111111-1111-4111-8111-111111111111';
  f.db
    .prepare("INSERT INTO cooking_event VALUES (?,0,'cancelled',NULL,NULL,NULL,NULL)")
    .run(cancelled);
  const collisionBefore = f.snapshot();
  await assert.rejects(
    f.apply(await f.source([f.exact]), randomUUID(), 4, async () => '1'.repeat(64)),
    /identity conflict/,
  );
  assert.deepEqual(f.snapshot(), collisionBefore);
  f.db.prepare('DELETE FROM cooking_event WHERE event_id=?').run(cancelled);
  // Five existing identities (two local, imported+source, account) plus 9,995 old removals.
  f.db.exec(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9995) INSERT INTO cooking_history_withdrawal SELECT printf('eeeeeeee-eeee-4eee-8eee-%012x',i) FROM n",
  );
  const before = f.snapshot();
  await assert.rejects(f.apply(source), /withdrawals exceed supported bounds/);
  assert.deepEqual(f.snapshot(), before);
});

test('private personal restore admits byte/type/count/aggregate bounds before any raw personal projection', async (t) => {
  const f = await fixture(t),
    source = await f.source(null);
  let rawReads = 0;
  for (const connection of [f.read.connection, f.write.connection]) {
    const all = connection.all;
    connection.all = async <Row extends object>(sql: string, values: readonly SqlValue[] = []) => {
      if (/^SELECT (note_id AS noteId|collection_id AS collectionId|item_id AS itemId)/.test(sql))
        rawReads++;
      return all<Row>(sql, values);
    };
  }
  for (const column of ['note_id', 'text', 'created_at'] as const) {
    const row = f.db
      .prepare(`SELECT ${column} value FROM recipe_note WHERE recipe_id=?`)
      .get(f.legacy.recipeId)!;
    const value =
      column === 'text'
        ? JSON.stringify('x'.repeat(100_000))
        : `${row.value}\u0000${'x'.repeat(100_000)}`;
    f.db.exec('PRAGMA ignore_check_constraints=ON');
    f.db
      .prepare(`UPDATE recipe_note SET ${column}=? WHERE recipe_id=?`)
      .run(value, f.legacy.recipeId);
    f.db.exec('PRAGMA ignore_check_constraints=OFF');
    const before = f.snapshot();
    rawReads = 0;
    await assert.rejects(
      f.reader.transaction((session) =>
        checkPortablePersonalRestore(session, source, { contentSchema: true }),
      ),
    );
    await assert.rejects(f.apply(source));
    assert.equal(rawReads, 0, `${column} caused a raw projection`);
    assert.deepEqual(f.snapshot(), before);
    f.db
      .prepare(`UPDATE recipe_note SET ${column}=? WHERE recipe_id=?`)
      .run(row.value!, f.legacy.recipeId);
  }
  // Individually legal JSON strings still exceed the full private-personal snapshot byte cap.
  f.db
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4500)
    INSERT INTO manual_shopping_item SELECT printf('ffffffff-ffff-4fff-8fff-%012x',i),?,?,?,'pantry',0,0,2,?,? FROM n`,
    )
    .run(
      JSON.stringify('\u0000'.repeat(160)),
      JSON.stringify('\u0000'.repeat(80)),
      JSON.stringify('\u0000'.repeat(80)),
      at,
      at,
    );
  const before = f.snapshot();
  rawReads = 0;
  await assert.rejects(
    f.reader.transaction((session) =>
      checkPortablePersonalRestore(session, source, { contentSchema: true }),
    ),
  );
  await assert.rejects(f.apply(source));
  assert.equal(rawReads, 0, 'aggregate overflow caused raw row copies');
  assert.deepEqual(f.snapshot(), before);
});

test('missing retained exact revision or failed pin insertion rolls back personal replacement, withdrawals and all imported rows', async (t) => {
  const f = await fixture(t),
    source = await f.source(),
    originalPrepare = f.write.connection.prepare;
  f.write.connection.prepare = async (sql) => {
    if (sql.startsWith('INSERT INTO imported_history_content_pin'))
      throw new Error('fixture pin insert failed');
    return originalPrepare(sql);
  };
  const before = f.snapshot();
  await assert.rejects(f.apply(source), /fixture pin insert failed/);
  assert.deepEqual(f.snapshot(), before);
  f.write.connection.prepare = originalPrepare;
  if (f.exact.kind !== 'exact') assert.fail();
  const missing = await f.source([
    {
      ...f.exact,
      entry: {
        ...f.exact.entry,
        contentRef: { ...f.exact.entry.contentRef, revisionId: 'not-retained' },
      },
    },
  ]);
  await assert.rejects(f.apply(missing), /FOREIGN KEY constraint failed/);
  assert.deepEqual(f.snapshot(), before);
});

test('caller final verification rejects substituted metadata and missing deferred restore ledger', async (t) => {
  const f = await fixture(t),
    source = await f.source([
      { ...f.exact, entry: { ...f.exact.entry, recipeTitle: 'Forged title' } },
    ]);
  const before = f.snapshot();
  await assert.rejects(f.apply(source));
  assert.deepEqual(f.snapshot(), before);
  const valid = await f.source();
  await assert.rejects(
    f.writer.transaction((session) =>
      replacePortableContentExpandedData(session, valid, randomUUID(), 4, sha256, restoredAt),
    ),
    /FOREIGN KEY constraint failed/,
  );
  assert.deepEqual(f.snapshot(), before);
});

test('owned format-three records do not change during awaited ID hashing', async (t) => {
  const f = await fixture(t),
    source: PortableContentBackupEnvelope = JSON.parse(JSON.stringify(await f.source()));
  let mutated = false;
  await f.apply(source, randomUUID(), 4, async (text) => {
    if (!mutated) {
      mutated = true;
      source.data.personal.notes[0]!.text = 'Late mutation';
      source.data.cookingHistory!.entries.length = 0;
    }
    return sha256(text);
  });
  assert.equal(ready(await f.history.readHistory()).items.length, 2);
  assert.equal(
    f.db.prepare('SELECT text FROM recipe_note WHERE recipe_id=?').get(f.legacy.recipeId)!.text,
    JSON.stringify(' Reviewed replacement  '),
  );
});

test('a later actual clear withdraws every generated and source ID so the original file cannot resurrect history', async (t) => {
  const f = await fixture(t),
    source = await f.source();
  await f.apply(source);
  const imported = f.db
    .prepare('SELECT event_id,source_event_id FROM imported_cooking_history')
    .all();
  const review = ready(await f.clear.reviewClearHistory());
  assert.equal(review.count, 2);
  ready(await f.clear.clearHistory(review, randomUUID()));
  for (const row of imported)
    for (const id of [row.event_id, row.source_event_id])
      assert.ok(f.db.prepare('SELECT 1 FROM cooking_history_withdrawal WHERE event_id=?').get(id!));
  const before = f.snapshot();
  await assert.rejects(f.apply(source, randomUUID(), 6), /previously removed history/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(ready(await f.history.readHistory()).items.length, 0);
});
