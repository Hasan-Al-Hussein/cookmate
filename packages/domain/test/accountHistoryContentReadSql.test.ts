import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { AccountReplicationError, type AccountCookingHistoryEntry } from '@cookmate/account-sync';
import { cookingContentIdentity } from '../src/cooking';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { ACCOUNT_BINDING_KEY } from '../../../apps/mobile/src/data/accountReplicationRecords';
import { ACCOUNT_HISTORY_ENTRY_MAX_BYTES } from '../../../apps/mobile/src/data/schema';
import {
  admitAccountHistoryProjection,
  mergeAccountHistoryProjection,
  readAccountHistoryProjection,
  verifyAccountHistoryContent,
  type AccountHistoryProjectionReadOptions,
} from '../../../apps/mobile/src/data/accountHistoryProjection';
import {
  configureConnection,
  SerializedWriter,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

// Actual disposable SQLite. The opt-in covers strict legacy account data reads, not hosted sync,
// exact-content account history, projection writes or cooking-operation authority.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const readOptions: AccountHistoryProjectionReadOptions = { contentSchema: true };
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const content = {
  catalogue: catalogue.identity,
  readRecipe: (id: string) => catalogue.getRecipe(id),
  sha256,
};
const failure = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;

async function fixture(t: TestContext, migrate = true) {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
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
  const bind = (owner: string) =>
    storage.database
      .prepare(
        `INSERT INTO app_metadata(key,value) VALUES (?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId: owner }));
  bind(ownerId);
  const recipe = catalogue.recipes[0]!;
  const entry: AccountCookingHistoryEntry = {
    ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: '2026-10-01T12:00:00.000Z',
    note: '  Exact private account note\n🍲  ',
  };
  const removedEventId = randomUUID();
  await writer.transaction((session) =>
    mergeAccountHistoryProjection(
      session,
      ownerId,
      {
        entries: [entry],
        removedEventIds: [removedEventId],
      },
      content,
    ),
  );
  if (migrate) await migrateCookingContentDatabase(writer, { sha256 });
  return { ...storage, writer, entry, removedEventId, bind };
}

function snapshot(store: Awaited<ReturnType<typeof fixture>>) {
  return [
    'account_cooking_history',
    'account_cooking_history_removed',
    'account_history_content_pin',
    'cooking_event',
    'cooking_state',
    'state_revision',
    'cooking_history_withdrawal',
    'app_metadata',
  ].map((table) => ({
    table,
    rows: store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  }));
}

function watchPayloadReads(store: Awaited<ReturnType<typeof fixture>>) {
  const original = store.connection.all;
  let payloadReads = 0;
  store.connection.all = async <Row extends object>(
    sql: string,
    values: readonly SqlValue[] = [],
  ) => {
    const rows = await original<Row>(sql, values);
    for (const row of rows) if (Object.hasOwn(row, 'entryJson')) payloadReads++;
    return rows;
  };
  return {
    count: () => payloadReads,
    restore: () => {
      store.connection.all = original;
    },
  };
}

test('default account-history reads stay schema-six-only; explicit schema-seven reads preserve strict v1 bytes', async (t) => {
  const store = await fixture(t, false);
  const legacy = await readAccountHistoryProjection(store.connection, ownerId);
  assert.deepEqual(legacy, { entries: [store.entry], removedEventIds: [store.removedEventId] });
  const originalJson = (
    store.database.prepare('SELECT entry_json FROM account_cooking_history').get() as {
      entry_json: string;
    }
  ).entry_json;
  await migrateCookingContentDatabase(store.writer, { sha256 });
  const before = snapshot(store);
  await assert.rejects(
    admitAccountHistoryProjection(store.connection, ownerId),
    failure('stored_data_invalid'),
  );
  await assert.rejects(
    readAccountHistoryProjection(store.connection, ownerId),
    failure('stored_data_invalid'),
  );
  assert.deepEqual(await admitAccountHistoryProjection(store.connection, ownerId, readOptions), {
    entryCount: 1,
    removalCount: 1,
    entryBytes: Buffer.byteLength(originalJson),
  });
  const read = await readAccountHistoryProjection(store.connection, ownerId, readOptions);
  assert.deepEqual(read, legacy);
  assert.ok(Object.isFrozen(read));
  assert.ok(Object.isFrozen(read.entries[0]));
  assert.equal(read.entries[0]!.readerVersion, 1);
  assert.equal(Object.hasOwn(read.entries[0]!, 'contentRef'), false);
  assert.deepEqual(snapshot(store), before);
});

test('read opt-in permits schema seven only, with an explicit true value and no future-schema fallback', async (t) => {
  const store = await fixture(t);
  const before = snapshot(store);
  for (const options of [{ contentSchema: false }, { contentSchema: 'true' }, {}]) {
    await assert.rejects(
      readAccountHistoryProjection(
        store.connection,
        ownerId,
        options as AccountHistoryProjectionReadOptions,
      ),
      failure('stored_data_invalid'),
    );
  }
  for (const version of [5, 8]) {
    store.database.exec(`PRAGMA user_version=${version}`);
    await assert.rejects(
      admitAccountHistoryProjection(store.connection, ownerId, readOptions),
      failure('stored_data_invalid'),
    );
    await assert.rejects(
      readAccountHistoryProjection(store.connection, ownerId, readOptions),
      failure('stored_data_invalid'),
    );
  }
  store.database.exec('PRAGMA user_version=7');
  assert.deepEqual(snapshot(store), before);
});

test('owner mismatch and foreign projection/removal contamination fail before any private payload read', async (t) => {
  const store = await fixture(t),
    observed = watchPayloadReads(store);
  try {
    store.bind(otherOwner);
    await assert.rejects(
      readAccountHistoryProjection(store.connection, ownerId, readOptions),
      failure('different_data_owner'),
    );
    store.bind(ownerId);
    for (const table of ['account_cooking_history', 'account_cooking_history_removed']) {
      const eventId = randomUUID();
      if (table === 'account_cooking_history')
        store.database.prepare('INSERT INTO account_cooking_history VALUES (?,?,?)').run(
          otherOwner,
          eventId,
          JSON.stringify({
            ...store.entry,
            eventId,
            note: 'Foreign private text must not be projected',
          }),
        );
      else
        store.database
          .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
          .run(otherOwner, eventId);
      const before = snapshot(store);
      await assert.rejects(
        admitAccountHistoryProjection(store.connection, ownerId, readOptions),
        failure('different_data_owner'),
      );
      await assert.rejects(
        readAccountHistoryProjection(store.connection, ownerId, readOptions),
        failure('different_data_owner'),
      );
      assert.deepEqual(snapshot(store), before);
      store.database.prepare(`DELETE FROM ${table} WHERE owner_id=?`).run(otherOwner);
    }
    assert.equal(observed.count(), 0);
  } finally {
    observed.restore();
  }
});

test('metadata admission is not semantic entry validation, and the read opt-in accepts no version-two account wire', async (t) => {
  const store = await fixture(t);
  for (const change of [
    { timeZone: 'Mars/Olympus' },
    { readerVersion: 2 },
    {
      contentRef: {
        recipeId: store.entry.recipeId,
        revisionId: 'invented-exact-ref',
        contentFingerprint: store.entry.contentFingerprint,
      },
    },
  ]) {
    // Strict DDL already rejects the version/shape changes; seed corruption deliberately to
    // exercise the independent read boundary, then immediately restore CHECK enforcement.
    store.database.exec('PRAGMA ignore_check_constraints=ON');
    store.database
      .prepare('UPDATE account_cooking_history SET entry_json=?')
      .run(JSON.stringify({ ...store.entry, ...change }));
    store.database.exec('PRAGMA ignore_check_constraints=OFF');
    const before = snapshot(store);
    assert.equal(
      (await admitAccountHistoryProjection(store.connection, ownerId, readOptions)).entryCount,
      1,
    );
    await assert.rejects(
      readAccountHistoryProjection(store.connection, ownerId, readOptions),
      failure('stored_data_invalid'),
    );
    assert.deepEqual(snapshot(store), before);
  }
  // Catalogue matching remains the existing separate content verification boundary.
  store.database
    .prepare('UPDATE account_cooking_history SET entry_json=?')
    .run(JSON.stringify({ ...store.entry, recipeTitle: 'Not the original source title' }));
  const history = await readAccountHistoryProjection(store.connection, ownerId, readOptions);
  await assert.rejects(
    verifyAccountHistoryContent(history, content),
    failure('history_content_mismatch'),
  );
});

test('schema-seven admission rejects malformed, mismatched, overlapped and oversized rows before projecting values', async (t) => {
  const store = await fixture(t),
    observed = watchPayloadReads(store);
  try {
    for (const [payload, reason] of [
      ['not JSON', 'stored_data_invalid'],
      [JSON.stringify({ ...store.entry, eventId: randomUUID() }), 'stored_data_invalid'],
      [
        JSON.stringify({ ...store.entry, note: 'x'.repeat(ACCOUNT_HISTORY_ENTRY_MAX_BYTES + 1) }),
        'too_large',
      ],
    ] as const) {
      store.database.exec('PRAGMA ignore_check_constraints=ON');
      store.database.prepare('UPDATE account_cooking_history SET entry_json=?').run(payload);
      store.database.exec('PRAGMA ignore_check_constraints=OFF');
      const before = snapshot(store);
      await assert.rejects(
        admitAccountHistoryProjection(store.connection, ownerId, readOptions),
        failure(reason),
      );
      await assert.rejects(
        readAccountHistoryProjection(store.connection, ownerId, readOptions),
        failure(reason),
      );
      assert.deepEqual(snapshot(store), before);
    }
    store.database
      .prepare('UPDATE account_cooking_history SET entry_json=?')
      .run(JSON.stringify(store.entry));
    store.database
      .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
      .run(ownerId, store.entry.eventId);
    const before = snapshot(store);
    await assert.rejects(
      readAccountHistoryProjection(store.connection, ownerId, readOptions),
      failure('stored_data_invalid'),
    );
    assert.deepEqual(snapshot(store), before);
    assert.equal(observed.count(), 0);
  } finally {
    observed.restore();
  }
});

test('projection apply, removal and even no-op mutation paths remain schema-six-only after successful opted-in reads', async (t) => {
  const store = await fixture(t);
  await readAccountHistoryProjection(store.connection, ownerId, readOptions);
  const before = snapshot(store);
  let preparedWrites = 0;
  const originalPrepare = store.connection.prepare;
  store.connection.prepare = async (sql) => {
    preparedWrites++;
    return originalPrepare(sql);
  };
  try {
    for (const candidate of [
      { entries: [store.entry], removedEventIds: [store.removedEventId] },
      { entries: [{ ...store.entry, eventId: randomUUID() }], removedEventIds: [] },
      { entries: [], removedEventIds: [store.entry.eventId] },
    ])
      for (const options of [content, { ...content, contentSchema: true }]) {
        await assert.rejects(
          store.writer.transaction((session) =>
            mergeAccountHistoryProjection(session, ownerId, candidate, options),
          ),
          failure('stored_data_invalid'),
        );
        assert.deepEqual(snapshot(store), before);
      }
    assert.equal(preparedWrites, 0, 'no projection mutation may be prepared on schema seven');
  } finally {
    store.connection.prepare = originalPrepare;
  }
});
