import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  createRecipeContentRevision,
  type ContentLookup,
  type RecipeContentRevision,
} from '@cookmate/catalogue/content';
import { AccountReplicationError, type AccountCookingHistoryEntry } from '@cookmate/account-sync';
import {
  normalizeAccountContentCookingHistory,
  type AccountContentCookingHistory,
  type AccountContentHistoryRecord,
  type AccountExactCookingHistoryEntry,
} from '../../account-sync/src/contentSnapshot';
import { cookingContentIdentity, type Immutable } from '../src';
import { mergeAccountContentHistoryProjection } from '../../../apps/mobile/src/data/accountContentHistoryApply';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import {
  retainCookingRevisionInSnapshot,
  withStoredCookingHistoryEntries,
} from '../../../apps/mobile/src/data/cookingContentRepository';
import type { ContentReferenceInspectionView } from '../../../apps/mobile/src/data/contentReleaseStore';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedWriter,
  type SqlSession,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection } from './helpers/sqlite';

// Real disposable SQLite and migrations; the view below is a controlled host proof port.
// This suite does not establish signatures, media-byte rights, network sync or runtime activation.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const fingerprint = 'a'.repeat(64);
const rejected = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;
const history = (entries: AccountContentHistoryRecord[] = [], removedEventIds: string[] = []) =>
  normalizeAccountContentCookingHistory({ entries, removedEventIds });

async function fixture(t: TestContext) {
  const store = desktopConnection();
  await configureConnection(store.connection);
  const writer = new SerializedWriter(store.connection);
  t.after(() => writer.close());
  await initializeDatabase(
    writer,
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
  const db = store.database;
  db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(
    ACCOUNT_BINDING_KEY,
    JSON.stringify({ schemaVersion: 1, ownerId }),
  );
  await migrateCookingContentDatabase(writer, { sha256 });
  const first = await createRecipeContentRevision(authoredFixture(), 'history-apply-first', sha256);
  const secondDocument = authoredFixture();
  secondDocument.recipe.title = 'Fixture soup, revised';
  secondDocument.recipe.instructions[1]!.rawText = 'Stir once.\nRest.';
  const second = await createRecipeContentRevision(secondDocument, 'history-apply-second', sha256);
  const recipe = catalogue.recipes[0]!,
    bundled = await createBundledRecipeRevision(recipe.recipeId, sha256);
  await writer.transaction(async (session) => {
    for (const revision of [first, second, bundled])
      await retainCookingRevisionInSnapshot(session, revision, sha256);
  });
  await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
  const legacy = (eventId = randomUUID()): AccountCookingHistoryEntry => ({
    ...identity,
    eventId,
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: ' Original legacy\n🍲\0\\ ',
  });
  const exact = (
    revision = first,
    eventId: string = randomUUID(),
  ): AccountExactCookingHistoryEntry => ({
    readerVersion: 2,
    eventId,
    recipeId: revision.ref.recipeId,
    contentRef: { ...revision.ref },
    recipeTitle: revision.document.recipe.title,
    photoAssetId: revision.document.media[0]!.assetId,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: ' Exact note\n量🍲\0\\ ',
  });
  const record = (entry: AccountExactCookingHistoryEntry): AccountContentHistoryRecord => ({
    kind: 'exact',
    entry,
  });
  const legacyRecord = (entry = legacy(), unresolved = false): AccountContentHistoryRecord => ({
    kind: 'legacy',
    entry,
    pin: unresolved
      ? { kind: 'unresolved', reason: 'content_mismatch' }
      : { kind: 'exact', ref: { ...bundled.ref } },
  });
  function pinFor(value: AccountContentHistoryRecord) {
    return value.kind === 'exact'
      ? { kind: 'exact' as const, ref: value.entry.contentRef }
      : value.pin;
  }
  function seedPin(table: string, value: AccountContentHistoryRecord) {
    const pin = pinFor(value);
    const params = [
      value.entry.eventId,
      value.entry.recipeId,
      pin.kind === 'exact' ? pin.ref.revisionId : null,
      pin.kind === 'exact' ? pin.ref.contentFingerprint : null,
      pin.kind === 'unresolved' ? pin.reason : null,
    ];
    if (table === 'account_history_content_pin') params.unshift(ownerId);
    db.prepare(`INSERT INTO ${table} VALUES (${params.map(() => '?').join(',')})`).run(...params);
  }
  function seedAccount(value: AccountContentHistoryRecord) {
    db.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
      ownerId,
      value.entry.eventId,
      JSON.stringify(value.entry, null, 2) + '\n',
    );
    seedPin('account_history_content_pin', value);
  }
  function seedLocal(value: AccountContentHistoryRecord) {
    const event = { ...value.entry, historyEpoch: 0, revision: 1 };
    const json = JSON.stringify({ kind: 'saved', event, closedSession: null }, null, 2) + '\n';
    db.prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)").run(
      event.eventId,
      event.cookedOn,
      at,
      fingerprint,
      json,
    );
    seedPin('local_history_content_pin', value);
    return json;
  }
  function seedBackup(value: AccountContentHistoryRecord, sourceId = randomUUID()) {
    const restoreId = randomUUID(),
      event = { ...value.entry, historyEpoch: 0, revision: 1, origin: 'backup' };
    db.prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)').run(
      restoreId,
      fingerprint,
      '{}',
      '{}',
      '{}',
    );
    db.prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)').run(
      event.eventId,
      sourceId,
      restoreId,
      event.cookedOn,
      at,
      JSON.stringify(event),
    );
    seedPin('imported_history_content_pin', value);
    return sourceId;
  }
  let active = true;
  let entries: ContentReferenceInspectionView['entries'] = [first, second, bundled].map(
    (revision) => ({
      ref: revision.ref,
      lookup: readable(revision),
    }),
  );
  const view: ContentReferenceInspectionView = {
    head: null,
    latestHead: null,
    adoptedRecipeIds: [first.ref.recipeId, bundled.ref.recipeId],
    get entries() {
      this.assertActive();
      return entries;
    },
    assertActive(): undefined {
      assert.ok(active, 'controlled reservation ended');
      return undefined;
    },
  };
  const apply = (incoming: Immutable<AccountContentCookingHistory>, revision = 1) =>
    writer.transaction((session) =>
      mergeAccountContentHistoryProjection(session, ownerId, incoming, { view, revision, sha256 }),
    );
  return {
    ...store,
    db,
    writer,
    first,
    second,
    bundled,
    exact,
    legacy,
    record,
    legacyRecord,
    seedAccount,
    seedLocal,
    seedBackup,
    apply,
    view,
    setActive(value: boolean) {
      active = value;
    },
    setLookups(value: ContentReferenceInspectionView['entries']) {
      entries = value;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function readable(revision: Immutable<RecipeContentRevision>): ContentLookup {
  return {
    kind: 'readable',
    state: 'historical',
    value: {
      origin: 'published',
      revision,
      retainedSources: [],
      publication: {
        formatVersion: 2,
        revision,
        permissions: [],
        publicationFingerprint: 'e'.repeat(64),
      },
    },
  };
}
function snapshot(f: Fixture) {
  return [
    'account_cooking_history',
    'account_cooking_history_removed',
    'account_history_content_pin',
    'cooking_event',
    'local_history_content_pin',
    'imported_cooking_history',
    'imported_history_content_pin',
    'cooking_history_withdrawal',
    'cooking_session',
    'cooking_state',
    'state_revision',
    'app_metadata',
    'portable_restore_operation',
    'recipe_identity',
    'recipe_content_revision',
  ].map((table) => ({
    table,
    rows: f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  }));
}

test('actual migrated8 merges original IDs and two exact versions alongside legacy history, without cooking authority', async (t) => {
  const f = await fixture(t),
    first = f.record(f.exact()),
    second = f.record(f.exact(f.second)),
    legacy = f.legacyRecord();
  const original = f.seedLocal(first),
    before = snapshot(f);
  const input = history([second, legacy, first]);
  const result = await f.apply(input, 8);
  assert.deepEqual(result, { changed: true, history: input, historyEpoch: 0, historyRevision: 8 });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.history.entries));
  assert.deepEqual(
    f.db
      .prepare('SELECT event_id FROM account_cooking_history ORDER BY event_id')
      .all()
      .map((row) => row.event_id),
    input.entries.map((row) => row.entry.eventId),
  );
  assert.equal(
    f.db.prepare('SELECT receipt_json FROM cooking_event').get()!.receipt_json,
    original,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cooking_event').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cooking_session').get()!.n, 0);
  const untouched = new Set([
    'account_cooking_history',
    'account_cooking_history_removed',
    'account_history_content_pin',
    'cooking_state',
  ]);
  assert.deepEqual(
    snapshot(f).filter((row) => !untouched.has(row.table)),
    before.filter((row) => !untouched.has(row.table)),
  );
  const stored = await f.writer.transaction((session) =>
    withStoredCookingHistoryEntries(session, sha256, (read) =>
      read(input.entries.map((row) => ({ source: 'account', eventId: row.entry.eventId }))),
    ),
  );
  assert.equal(stored.length, 3);
  assert.deepEqual(
    stored
      .filter((row) => row.value.readerVersion === 2)
      .map((row) => row.pin.kind === 'exact' && row.pin.ref.revisionId)
      .sort(),
    [f.first.ref.revisionId, f.second.ref.revisionId].sort(),
  );
});

test('identical stored exact and unresolved legacy records remain unchanged without fresh unavailable body proof', async (t) => {
  const f = await fixture(t),
    exact = f.record(f.exact());
  const unresolved = f.legacyRecord({ ...f.legacy(), contentFingerprint: 'f'.repeat(64) }, true);
  f.seedAccount(exact);
  f.seedAccount(unresolved);
  f.db.exec('UPDATE cooking_state SET history_revision=4,history_epoch=2');
  f.setLookups([]);
  const before = snapshot(f),
    result = await f.apply(history([exact, unresolved]), 0);
  assert.equal(result.changed, false);
  assert.equal(result.historyRevision, 4);
  assert.equal(result.historyEpoch, 2);
  assert.deepEqual(snapshot(f), before);
});

test('removals union account, clear, cancellation, withdrawals and import lineage without body access or receipt rewriting', async (t) => {
  const f = await fixture(t),
    account = f.record(f.exact()),
    stale = f.record(f.exact(f.second)),
    cancelled = f.record(f.exact()),
    cleared = f.record(f.exact());
  f.seedAccount(account);
  f.db
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(ownerId, stale.entry.eventId);
  for (const [value, state] of [
    [cancelled, 'cancelled'],
    [cleared, 'cleared'],
  ] as const)
    f.db
      .prepare('INSERT INTO cooking_event VALUES (?,0,?,NULL,NULL,NULL,NULL)')
      .run(value.entry.eventId, state);
  const sourceId = randomUUID(),
    backup = f.record(f.exact());
  f.seedBackup(backup, sourceId);
  f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(sourceId);
  const privateBefore = snapshot(f).filter((row) =>
    [
      'cooking_event',
      'imported_cooking_history',
      'imported_history_content_pin',
      'cooking_history_withdrawal',
      'portable_restore_operation',
    ].includes(row.table),
  );
  f.setLookups([]);
  const result = await f.apply(
    history([stale, cancelled, cleared, backup], [account.entry.eventId]),
    5,
  );
  assert.deepEqual(result.history.entries, []);
  assert.deepEqual(
    result.history.removedEventIds,
    [
      stale.entry.eventId,
      cancelled.entry.eventId,
      cleared.entry.eventId,
      backup.entry.eventId,
      sourceId,
      account.entry.eventId,
    ].sort(),
  );
  assert.deepEqual(
    snapshot(f).filter((row) => privateBefore.some((before) => before.table === row.table)),
    privateBefore,
  );
  const retry = await f.apply(history([stale, cancelled, cleared, backup]), 6);
  assert.equal(retry.changed, false);
  assert.equal(retry.historyRevision, 5);
});

test('same immutable ID with changed note, exact version or civil date is refused against every extant source', async (t) => {
  for (const source of ['account', 'local', 'backup'] as const) {
    const f = await fixture(t),
      event = f.exact(),
      stored = f.record(event);
    ({ account: f.seedAccount, local: f.seedLocal, backup: f.seedBackup })[source](stored);
    const before = snapshot(f);
    for (const changed of [
      { ...event, note: 'Changed' },
      { ...f.exact(f.second, event.eventId) },
      { ...event, cookedOn: '2026-09-30' },
    ]) {
      await assert.rejects(
        f.apply(history([f.record(changed)])),
        rejected('history_content_mismatch'),
      );
      assert.deepEqual(snapshot(f), before);
    }
  }
});

test('removed-ID collisions still compare extant local and backup copies before deleting account projection', async (t) => {
  const f = await fixture(t),
    event = f.exact(),
    value = f.record(event);
  f.seedLocal(value);
  f.seedBackup(f.record({ ...event, note: 'Different immutable event' }));
  const before = snapshot(f);
  await assert.rejects(
    f.apply(history([], [value.entry.eventId])),
    rejected('history_content_mismatch'),
  );
  assert.deepEqual(snapshot(f), before);
});

test('identical exact and legacy mirrors deduplicate while preserving backup origin and every original byte', async (t) => {
  const f = await fixture(t),
    exact = f.record(f.exact()),
    legacy = f.legacyRecord();
  for (const row of [exact, legacy]) {
    f.seedLocal(row);
    f.seedBackup(row);
  }
  const privateBefore = snapshot(f).filter(
    (row) =>
      !['account_cooking_history', 'account_history_content_pin', 'cooking_state'].includes(
        row.table,
      ),
  );
  await f.apply(history([exact, legacy]), 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM account_cooking_history').get()!.n, 2);
  assert.deepEqual(
    snapshot(f).filter(
      (row) =>
        !['account_cooking_history', 'account_history_content_pin', 'cooking_state'].includes(
          row.table,
        ),
    ),
    privateBefore,
  );
});

test('legacy account wire origin remains immutable even though cross-source storage origin is normalized', async (t) => {
  const f = await fixture(t),
    entry = f.legacy(),
    stored = f.legacyRecord({ ...entry, origin: 'backup' });
  f.seedAccount(stored);
  const before = snapshot(f);
  await assert.rejects(
    f.apply(history([f.legacyRecord(entry)])),
    rejected('history_content_mismatch'),
  );
  assert.deepEqual(snapshot(f), before);
  f.seedLocal(f.legacyRecord(entry));
  assert.equal((await f.apply(history([stored]), 0)).changed, false);
});

test('new unresolved, missing, withdrawn, wrong-title and unrelated-media additions cannot use retained bytes as authority', async (t) => {
  const f = await fixture(t),
    value = f.record(f.exact()),
    before = snapshot(f);
  const unresolved = f.legacyRecord({ ...f.legacy(), contentFingerprint: 'f'.repeat(64) }, true);
  await assert.rejects(f.apply(history([unresolved])), rejected('history_content_mismatch'));
  for (const lookup of [
    { kind: 'missing' },
    { kind: 'withdrawn', recipeId: f.first.ref.recipeId, reason: 'Fixture withdrawal' },
  ] as const) {
    f.setLookups([{ ref: f.first.ref, lookup }]);
    await assert.rejects(f.apply(history([value])), rejected('history_content_mismatch'));
  }
  f.setLookups([{ ref: f.first.ref, lookup: readable(f.first) }]);
  for (const patch of [{ recipeTitle: 'Wrong' }, { photoAssetId: `sha256:${'f'.repeat(64)}` }])
    await assert.rejects(
      f.apply(history([f.record({ ...f.exact(), ...patch })])),
      rejected('history_content_mismatch'),
    );
  assert.deepEqual(snapshot(f), before);
});

test('schema, foreign-key and actual-owner gates run before history payload reads', async (t) => {
  const f = await fixture(t),
    value = f.record(f.exact()),
    all = f.connection.all;
  f.seedAccount(value);
  let payloadReads = 0;
  f.connection.all = async <Row extends object>(sql: string, params?: readonly SqlValue[]) => {
    if (/SELECT event_id eventId,entry_json/.test(sql)) payloadReads++;
    return all<Row>(sql, params);
  };
  for (const version of [6, 7, 9]) {
    f.db.exec(`PRAGMA user_version=${version}`);
    await assert.rejects(f.apply(history()), rejected('stored_data_invalid'));
  }
  f.db.exec('PRAGMA user_version=8');
  await assert.rejects(
    f.writer.transaction((session) =>
      mergeAccountContentHistoryProjection(session, otherOwner, history(), {
        view: f.view,
        sha256,
        revision: 1,
      }),
    ),
    rejected('different_data_owner'),
  );
  f.db.exec('PRAGMA foreign_keys=OFF');
  await assert.rejects(
    mergeAccountContentHistoryProjection(f.connection, ownerId, history(), {
      view: f.view,
      sha256,
      revision: 1,
    }),
    rejected('stored_data_invalid'),
  );
  f.db.exec('PRAGMA foreign_keys=ON');
  f.db
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(otherOwner, randomUUID());
  await assert.rejects(f.apply(history()), rejected('different_data_owner'));
  assert.equal(payloadReads, 0);
});

test('failed account insert rolls back removals, retained revisions, pins and clocks in the caller transaction', async (t) => {
  const f = await fixture(t),
    old = f.record(f.exact());
  f.seedAccount(old);
  const document = authoredFixture('90002'),
    newRevision = await createRecipeContentRevision(document, 'new-retained-during-apply', sha256);
  const added = f.record(f.exact(newRevision));
  f.setLookups([{ ref: newRevision.ref, lookup: readable(newRevision) }]);
  const before = snapshot(f),
    prepare = f.connection.prepare;
  f.connection.prepare = async (sql) => {
    const statement = await prepare(sql);
    return {
      ...statement,
      run: async (values) => {
        await statement.run(values);
        if (sql.startsWith('INSERT INTO account_cooking_history('))
          throw new Error('injected post-insert failure');
      },
    };
  };
  await assert.rejects(
    f.apply(history([added], [old.entry.eventId]), 9),
    /injected post-insert failure/,
  );
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(f.statementCounts(), {
    prepared: f.statementCounts().prepared,
    finalized: f.statementCounts().prepared,
  });
});

test('reservation loss after digest or SQL write aborts and rolls back before returning history', async (t) => {
  for (const phase of ['hash', 'write', 'prepare'] as const) {
    const f = await fixture(t),
      value = f.record(f.exact()),
      before = snapshot(f);
    const prepare = f.connection.prepare;
    if (phase === 'write' || phase === 'prepare')
      f.connection.prepare = async (sql) => {
        const statement = await prepare(sql);
        if (phase === 'prepare') f.setActive(false);
        return {
          ...statement,
          run: async (values) => {
            await statement.run(values);
            if (sql.startsWith('INSERT INTO account_cooking_history(')) f.setActive(false);
          },
        };
      };
    const work = (session: SqlSession) =>
      mergeAccountContentHistoryProjection(session, ownerId, history([value]), {
        view: f.view,
        revision: 1,
        sha256: async (text) => {
          const result = await sha256(text);
          if (phase === 'hash') f.setActive(false);
          return result;
        },
      });
    if (phase === 'prepare') {
      // A caller-owned raw transaction isolates this helper's cleanup from SerializedWriter's
      // independent finalizer, which otherwise masks a leaked prepared statement.
      f.db.exec('BEGIN');
      try {
        await assert.rejects(work(f.connection), /controlled reservation ended/);
        assert.equal(f.statementCounts().prepared, f.statementCounts().finalized);
      } finally {
        f.db.exec('ROLLBACK');
      }
    } else await assert.rejects(f.writer.transaction(work), /controlled reservation ended/);
    assert.deepEqual(snapshot(f), before);
    assert.equal(f.statementCounts().prepared, f.statementCounts().finalized);
  }
});

test('input data, revision and proof/hash ports are captured before the first asynchronous SQL step', async (t) => {
  const f = await fixture(t),
    value = f.record(f.exact()),
    input: AccountContentCookingHistory = { entries: [value], removedEventIds: [] };
  const options = { view: f.view, revision: 7, sha256 };
  const all = f.connection.all;
  let changed = false;
  f.connection.all = async <Row extends object>(sql: string, params?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, params);
    if (!changed && sql === 'PRAGMA user_version') {
      changed = true;
      input.entries.length = 0;
      options.revision = 0;
      options.sha256 = async () => {
        assert.fail('mutated hash port used');
      };
      options.view = {
        ...f.view,
        assertActive: () => {
          assert.fail('mutated view used');
        },
      };
    }
    return rows;
  };
  const result = await f.writer.transaction((session) =>
    mergeAccountContentHistoryProjection(session, ownerId, input, options),
  );
  assert.equal(result.history.entries[0]!.entry.eventId, value.entry.eventId);
  assert.equal(result.historyRevision, 7);
});

test('invalid/oversized or accessor inputs and invalid allocated revisions fail before any query', async (t) => {
  const f = await fixture(t),
    value = f.record(f.exact()),
    all = f.connection.all;
  let queries = 0;
  f.connection.all = async <Row extends object>(sql: string, params?: readonly SqlValue[]) => {
    queries++;
    return all<Row>(sql, params);
  };
  const hostile = { entries: [], removedEventIds: [] };
  Object.defineProperty(hostile, 'entries', {
    enumerable: true,
    get: () => assert.fail('hostile getter invoked'),
  });
  for (const input of [
    hostile,
    { entries: [value], removedEventIds: [], extra: 'not allowed' },
    { entries: [], removedEventIds: [], extra: 'x'.repeat(2 * 1024 * 1024) },
  ])
    await assert.rejects(
      mergeAccountContentHistoryProjection(
        f.connection,
        ownerId,
        input as AccountContentCookingHistory,
        { view: f.view, sha256, revision: 1 },
      ),
    );
  for (const revision of [-1, Number.MAX_SAFE_INTEGER + 1, NaN])
    await assert.rejects(
      mergeAccountContentHistoryProjection(f.connection, ownerId, history(), {
        view: f.view,
        sha256,
        revision,
      }),
      rejected('invalid_input'),
    );
  assert.equal(queries, 0);
});

test('changed history requires an advanced allocated clock; no-op never advances epoch or history revision', async (t) => {
  const f = await fixture(t),
    input = history([f.record(f.exact())]);
  f.db.exec('UPDATE cooking_state SET history_epoch=3,history_revision=8');
  const before = snapshot(f);
  for (const revision of [0, 7, 8]) {
    await assert.rejects(f.apply(input, revision), rejected('local_changed'));
    assert.deepEqual(snapshot(f), before);
  }
  const result = await f.apply(input, 9);
  assert.equal(result.historyEpoch, 3);
  assert.equal(result.historyRevision, 9);
  assert.equal((await f.apply(input, 20)).historyRevision, 9);
});

test('oversized stored account payload is rejected before raw transfer and never repaired', async (t) => {
  const f = await fixture(t),
    value = f.record(f.exact());
  f.seedAccount(value);
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db
    .prepare('UPDATE account_cooking_history SET entry_json=?')
    .run(JSON.stringify(value.entry) + ' '.repeat(32769));
  f.db.exec('PRAGMA ignore_check_constraints=OFF');
  const before = snapshot(f),
    all = f.connection.all;
  let largest = 0;
  f.connection.all = async <Row extends object>(sql: string, params?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, params);
    for (const row of rows)
      for (const item of Object.values(row))
        if (typeof item === 'string') largest = Math.max(largest, Buffer.byteLength(item));
    return rows;
  };
  await assert.rejects(f.apply(history()), rejected('too_large'));
  assert.ok(largest <= 32768);
  assert.deepEqual(snapshot(f), before);
});

test('many added events sharing one exact ref retain and hash that body only once', async (t) => {
  const f = await fixture(t),
    incoming = history(Array.from({ length: 120 }, () => f.record(f.exact())));
  const body = canonicalContentJson(f.first),
    all = f.connection.all;
  let bodyReads = 0,
    bodyHashes = 0,
    refHashes = 0;
  f.connection.all = async <Row extends object>(sql: string, params?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, params);
    for (const row of rows) for (const item of Object.values(row)) if (item === body) bodyReads++;
    return rows;
  };
  const result = await f.writer.transaction((session) =>
    mergeAccountContentHistoryProjection(session, ownerId, incoming, {
      view: f.view,
      revision: 1,
      sha256: async (text) => {
        if (text.startsWith('["cookmate-recipe-content-v1",')) bodyHashes++;
        if (text.startsWith('["cookmate-recipe-revision-v1",')) refHashes++;
        return sha256(text);
      },
    }),
  );
  assert.equal(result.history.entries.length, 120);
  assert.deepEqual(
    { bodyReads, bodyHashes, refHashes },
    { bodyReads: 1, bodyHashes: 1, refHashes: 1 },
  );
});

test('foreign-key audit returns one sentinel rather than materializing unrelated corrupt-table violations', async (t) => {
  const f = await fixture(t);
  f.db.exec(
    'PRAGMA foreign_keys=OFF; CREATE TABLE fixture_parent(id INTEGER PRIMARY KEY); CREATE TABLE fixture_child(id INTEGER REFERENCES fixture_parent(id)); WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<3000) INSERT INTO fixture_child SELECT n FROM ids; PRAGMA foreign_keys=ON',
  );
  const before = snapshot(f),
    all = f.connection.all;
  let transferred = 0;
  f.connection.all = async <Row extends object>(sql: string, params?: readonly SqlValue[]) => {
    const rows = await all<Row>(sql, params);
    if (/foreign_key_check/i.test(sql)) {
      assert.match(sql, /SELECT 1 FROM pragma_foreign_key_check LIMIT 1/i);
      transferred += rows.length;
      for (const row of rows) assert.deepEqual(Object.values(row), [1]);
    }
    return rows;
  };
  await assert.rejects(f.apply(history([f.record(f.exact())])), rejected('stored_data_invalid'));
  assert.equal(transferred, 1);
  assert.deepEqual(snapshot(f), before);
});
