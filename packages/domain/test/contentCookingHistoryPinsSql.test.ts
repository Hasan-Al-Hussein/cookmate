import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  createRecipeContentRevision,
  type RecipeContentRevision,
} from '@cookmate/catalogue/content';
import { cookingContentIdentity, type CookedReceipt } from '../src';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { readAccountHistoryProjection } from '../../../apps/mobile/src/data/accountHistoryProjection';
import {
  readHistoryContentPins,
  readStoredLocalCookingEvent,
  retainCookingRevisionInSnapshot,
  verifyCookingPinBindings,
  withStoredCookingHistoryEntries,
  requireCookingContentVersion,
  requireCookingContentReadVersion,
} from '../../../apps/mobile/src/data/cookingContentRepository';
import { COOKING_CONTENT_LIMITS } from '../../../apps/mobile/src/data/cookingContentSchema';
import type {
  ContentCookedReceipt,
  ContentCookingHistoryEntry,
} from '../../../apps/mobile/src/data/contentCookingHistoryRecords';
import {
  configureConnection,
  SerializedWriter,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Synthetic persistence fixtures exercise real SQLite and local integrity only. No record seeded
// here establishes signed publication, host operation authority, portability or account sync.
const at = '2026-10-01T12:00:00.000Z';
const requestFingerprint = 'a'.repeat(64);
type Store = ReturnType<typeof desktopConnection> & { writer: SerializedWriter };
type SavedContentReceipt = Extract<ContentCookedReceipt, { kind: 'saved' }>;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-history-pins-'));
  const path = join(directory, 'cooking.db');
  const writers: SerializedWriter[] = [];
  const open = async (): Promise<Store> => {
    const handle = desktopConnection(path);
    await configureConnection(handle.connection);
    const writer = new SerializedWriter(handle.connection);
    writers.push(writer);
    return { ...handle, writer };
  };
  const store = await open();
  t.after(async () => {
    for (const writer of writers) await writer.close();
    await removeFixtureDirectory(directory);
  });
  await initializeDatabase(
    store.writer,
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
  return { ...store, open };
}

function insertSaved(
  store: Store,
  receipt: Extract<CookedReceipt | ContentCookedReceipt, { kind: 'saved' }>,
) {
  const { event } = receipt,
    json = JSON.stringify(receipt, null, 2);
  store.database
    .prepare("INSERT INTO cooking_event VALUES (?,?,'saved',?,?,?,?)")
    .run(
      event.eventId,
      event.historyEpoch,
      event.cookedOn,
      event.recordedAt,
      requestFingerprint,
      json,
    );
  return json;
}

async function addAuthored(store: Store) {
  const revision = await createRecipeContentRevision(
    authoredFixture(),
    'fixture-history-pin-v1',
    sha256,
  );
  await store.writer.transaction((session) =>
    retainCookingRevisionInSnapshot(session, revision, sha256),
  );
  const event: ContentCookingHistoryEntry = {
    readerVersion: 2,
    recipeId: revision.ref.recipeId,
    contentRef: { ...revision.ref },
    eventId: randomUUID(),
    recipeTitle: revision.document.recipe.title,
    photoAssetId: revision.document.media[0]!.assetId,
    cookedOn: '2026-09-30',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'Exact private note\n量 🍲  ',
    historyEpoch: 0,
    revision: 2,
  };
  const receipt: SavedContentReceipt = {
    kind: 'saved',
    event,
    closedSession: {
      readerVersion: 2,
      recipeId: event.recipeId,
      contentRef: { ...event.contentRef },
      sessionId: randomUUID(),
      revision: 3,
      passageSequence: 2,
      state: 'completed',
      updatedAt: at,
      lastOperationId: event.eventId,
    },
  };
  const json = insertSaved(store, receipt);
  store.database
    .prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)')
    .run(
      event.eventId,
      event.recipeId,
      event.contentRef.revisionId,
      event.contentRef.contentFingerprint,
    );
  return { ...store, event, receipt, revision, json };
}
async function authored(t: TestContext) {
  const store = await fixture(t);
  await migrateCookingContentDatabase(store.writer, { sha256 });
  return { ...(await addAuthored(store)), open: store.open };
}

function retainedDigest(store: Store) {
  const digest = createHash('sha256');
  for (const table of [
    'cooking_event',
    'local_history_content_pin',
    'recipe_content_revision',
    'recipe_content_source',
    'cooking_state',
    'state_revision',
  ]) {
    digest.update(table);
    digest.update(
      JSON.stringify(store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    );
  }
  return digest.digest('hex');
}
async function rejectsUnchanged(store: Awaited<ReturnType<typeof authored>>, corrupt: () => void) {
  store.database.exec(
    'PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON; SAVEPOINT corrupt_fixture',
  );
  try {
    corrupt();
    const before = retainedDigest(store);
    await assert.rejects(
      readStoredLocalCookingEvent(store.connection, store.event.eventId, { sha256 }),
    );
    await assert.rejects(verifyCookingPinBindings(store.connection, sha256));
    assert.equal(
      retainedDigest(store),
      before,
      'invalid evidence is never repaired or rewritten during read',
    );
  } finally {
    store.database.exec(
      'ROLLBACK TO corrupt_fixture; RELEASE corrupt_fixture; PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON',
    );
  }
}
function changeReceipt(store: Awaited<ReturnType<typeof authored>>, receipt: unknown) {
  store.database
    .prepare('UPDATE cooking_event SET receipt_json=? WHERE event_id=?')
    .run(JSON.stringify(receipt), store.event.eventId);
}

test('one exact revision is fetched and hashed once across a session and multiple local history pages', async (t) => {
  const store = await authored(t);
  const copies = COOKING_CONTENT_LIMITS.page * 2 + 5;
  // SQL duplicates only controlled receipt data, changing both linked event IDs consistently.
  store.database
    .prepare(
      `WITH RECURSIVE fixture(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<?
  ), ids AS (SELECT printf('99999999-9999-4999-8999-%012x',n) id FROM fixture)
  INSERT INTO cooking_event
    SELECT id,?,'saved',?,?,?,json_set(?, '$.event.eventId',id,'$.closedSession.lastOperationId',id)
    FROM ids`,
    )
    .run(
      copies,
      store.event.historyEpoch,
      store.event.cookedOn,
      at,
      requestFingerprint,
      store.json,
    );
  store.database
    .prepare(
      `INSERT INTO local_history_content_pin
    SELECT event_id,?,?,?,NULL FROM cooking_event WHERE event_id<>?`,
    )
    .run(
      store.event.recipeId,
      store.revision.ref.revisionId,
      store.revision.ref.contentFingerprint,
      store.event.eventId,
    );
  const closed = store.receipt.closedSession;
  assert.ok(closed);
  store.database
    .prepare('INSERT INTO cooking_session VALUES (?,?,?,?,?,?,?,?)')
    .run(
      closed.recipeId,
      closed.sessionId,
      closed.revision,
      closed.state,
      closed.updatedAt,
      closed.lastOperationId,
      requestFingerprint,
      JSON.stringify(closed),
    );
  store.database
    .prepare('INSERT INTO cooking_session_content_pin VALUES (?,?,?,?,NULL)')
    .run(
      closed.sessionId,
      closed.recipeId,
      closed.contentRef.revisionId,
      closed.contentRef.contentFingerprint,
    );
  assert.equal(
    (store.database.prepare('SELECT COUNT(*) count FROM cooking_event').get() as { count: number })
      .count,
    copies + 1,
  );
  const expectedBody = canonicalContentJson(store.revision);
  const originalAll = store.connection.all;
  let bodyReads = 0,
    bodyHashes = 0,
    referenceHashes = 0;
  store.connection.all = async <Row extends object>(
    sql: string,
    values: readonly SqlValue[] = [],
  ) => {
    const result = await originalAll<Row>(sql, values);
    for (const row of result)
      for (const value of Object.values(row)) if (value === expectedBody) bodyReads++;
    return result;
  };
  const measuredHash = async (value: string) => {
    if (value.startsWith('["cookmate-recipe-content-v1",')) bodyHashes++;
    if (value.startsWith('["cookmate-recipe-revision-v1",')) referenceHashes++;
    return sha256(value);
  };
  try {
    await store.writer.transaction((session) => verifyCookingPinBindings(session, measuredHash));
    assert.deepEqual(
      { bodyReads, bodyHashes, referenceHashes },
      { bodyReads: 1, bodyHashes: 1, referenceHashes: 1 },
    );
    // Each separate read call owns a fresh SQL-snapshot cache, never a cross-transaction cache.
    bodyReads = bodyHashes = referenceHashes = 0;
    const page = await store.writer.transaction((session) =>
      readHistoryContentPins(session, {
        source: 'local',
        limit: COOKING_CONTENT_LIMITS.page,
        sha256: measuredHash,
      }),
    );
    assert.equal(page.items.length, COOKING_CONTENT_LIMITS.page);
    assert.ok(page.nextAfter);
    assert.deepEqual(
      { bodyReads, bodyHashes, referenceHashes },
      { bodyReads: 1, bodyHashes: 1, referenceHashes: 1 },
    );
  } finally {
    store.connection.all = originalAll;
  }
});

test('schema8 exact account history has retained pin proof but never a local cooked receipt', async (t) => {
  const store = await authored(t),
    ownerId = randomUUID();
  store.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run('account-replication:owner', JSON.stringify({ schemaVersion: 1, ownerId }));
  await migrateAccountContentHistoryDatabase(store.writer, { sha256 });
  const { historyEpoch: _epoch, revision: _revision, ...data } = store.event;
  const entry = { ...data, eventId: randomUUID() };
  const original = JSON.stringify(entry, null, 2);
  store.database
    .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
    .run(ownerId, entry.eventId, original);
  store.database
    .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
    .run(
      ownerId,
      entry.eventId,
      entry.recipeId,
      entry.contentRef.revisionId,
      entry.contentRef.contentFingerprint,
    );
  assert.equal(await requireCookingContentReadVersion(store.connection), 8);
  await assert.rejects(requireCookingContentVersion(store.connection));
  await assert.rejects(
    readAccountHistoryProjection(store.connection, ownerId, { contentSchema: true }),
  );
  const before = retainedDigest(store);
  const pins = await readHistoryContentPins(store.connection, {
    source: 'account',
    ownerId,
    sha256,
  });
  assert.deepEqual(pins.items, [
    {
      source: 'account',
      ownerId,
      eventId: entry.eventId,
      recipeId: entry.recipeId,
      pin: { kind: 'exact', ref: entry.contentRef },
    },
  ]);
  const records = await withStoredCookingHistoryEntries(store.connection, sha256, (read) =>
    read([{ source: 'account', eventId: entry.eventId }]),
  );
  assert.deepEqual(records[0], {
    source: 'account',
    value: entry,
    pin: { kind: 'exact', ref: entry.contentRef },
  });
  assert.ok(Object.isFrozen(records[0]!.value));
  assert.equal(
    await readStoredLocalCookingEvent(store.connection, entry.eventId, { sha256 }),
    null,
  );
  assert.deepEqual(
    (await readStoredLocalCookingEvent(store.connection, store.event.eventId, { sha256 }))?.receipt,
    store.receipt,
  );
  await verifyCookingPinBindings(store.connection, sha256);
  assert.equal(retainedDigest(store), before);
  assert.equal(
    (
      store.database
        .prepare('SELECT entry_json FROM account_cooking_history WHERE event_id=?')
        .get(entry.eventId) as { entry_json: string }
    ).entry_json,
    original,
  );
  for (const change of [
    { recipeTitle: 'Wrong retained title' },
    { photoAssetId: `sha256:${'f'.repeat(64)}` },
    { timeZone: 'Not/A-Timezone' },
    { contentRef: { ...entry.contentRef, revisionId: 'another-revision' } },
  ]) {
    store.database
      .prepare('UPDATE account_cooking_history SET entry_json=? WHERE event_id=?')
      .run(JSON.stringify({ ...entry, ...change }), entry.eventId);
    await assert.rejects(
      readHistoryContentPins(store.connection, { source: 'account', ownerId, sha256 }),
    );
    assert.equal(retainedDigest(store), before);
  }
  store.database
    .prepare('UPDATE account_cooking_history SET entry_json=? WHERE event_id=?')
    .run(original, entry.eventId);
  await verifyCookingPinBindings(store.connection, sha256);
});

test('export batches own keys and share proofs only within their active SQL callback', async (t) => {
  const store = await authored(t);
  let bodyHashes = 0;
  const measuredHash = async (value: string) => {
    if (value.startsWith('["cookmate-recipe-content-v1",')) bodyHashes++;
    return sha256(value);
  };
  let escaped: (() => Promise<unknown>) | undefined;
  const before = retainedDigest(store);
  await store.writer.transaction((session) =>
    withStoredCookingHistoryEntries(session, measuredHash, async (read) => {
      const keys = [{ source: 'local' as const, eventId: store.event.eventId }];
      const pending = read(keys);
      keys[0]!.eventId = randomUUID();
      assert.equal((await pending)[0]!.value.eventId, store.event.eventId);
      assert.equal(
        (await read([{ source: 'local', eventId: store.event.eventId }]))[0]!.value.eventId,
        store.event.eventId,
      );
      escaped = () => read([{ source: 'local', eventId: store.event.eventId }]);
    }),
  );
  assert.equal(bodyHashes, 1);
  assert.ok(escaped);
  await assert.rejects(escaped);
  await store.writer.transaction((session) =>
    withStoredCookingHistoryEntries(session, measuredHash, async (read) => {
      await read([{ source: 'local', eventId: store.event.eventId }]);
    }),
  );
  assert.equal(bodyHashes, 2, 'New snapshot revalidates retained evidence');
  assert.equal(retainedDigest(store), before);
});

test('malformed history keys cannot hide before the first lexical page', async (t) => {
  const store = await authored(t);
  await rejectsUnchanged(store, () => {
    store.database.exec(
      "UPDATE cooking_event SET event_id=''; UPDATE local_history_content_pin SET event_id=''",
    );
  });
});

test('legacy exact/unresolved receipt bytes coexist unchanged with authored version-two history through actual reopen', async (t) => {
  const store = await fixture(t);
  const legacy: { receipt: Extract<CookedReceipt, { kind: 'saved' }>; json: string }[] = [];
  for (const [index, recipe] of catalogue.recipes.slice(0, 2).entries()) {
    const identity = await cookingContentIdentity(recipe, catalogue.identity, sha256);
    const receipt: Extract<CookedReceipt, { kind: 'saved' }> = {
      kind: 'saved',
      event: {
        ...identity,
        ...(index === 1 ? { contentFingerprint: 'e'.repeat(64) } : {}),
        eventId: randomUUID(),
        recipeTitle: recipe.title,
        photoKey: recipe.photoKey,
        cookedOn: '2026-09-30',
        timeZone: 'Asia/Dubai',
        recordedAt: at,
        note: '  Legacy note remains exact\n🍲 ',
        historyEpoch: 0,
        revision: 1,
      },
      closedSession: null,
    };
    legacy.push({ receipt, json: insertSaved(store, receipt) });
  }
  await migrateCookingContentDatabase(store.writer, { sha256 });
  const added = await addAuthored(store),
    before = retainedDigest(store);
  await store.writer.close();
  const reopened = await store.open();
  assert.equal(await migrateCookingContentDatabase(reopened.writer, { sha256 }), 'existing');
  for (const [index, original] of legacy.entries()) {
    const result = await readStoredLocalCookingEvent(
      reopened.connection,
      original.receipt.event.eventId,
      { sha256 },
    );
    assert.deepEqual(result?.receipt, original.receipt);
    assert.equal(result?.requestFingerprint, requestFingerprint);
    assert.deepEqual(
      result?.pin,
      index === 0
        ? {
            kind: 'exact',
            ref: (await createBundledRecipeRevision(original.receipt.event.recipeId, sha256)).ref,
          }
        : { kind: 'unresolved', reason: 'content_mismatch' },
    );
    assert.equal(
      (
        reopened.database
          .prepare('SELECT receipt_json FROM cooking_event WHERE event_id=?')
          .get(original.receipt.event.eventId) as { receipt_json: string }
      ).receipt_json,
      original.json,
    );
  }
  assert.deepEqual(
    (await readStoredLocalCookingEvent(reopened.connection, added.event.eventId, { sha256 }))
      ?.receipt,
    added.receipt,
  );
  const pins = await readHistoryContentPins(reopened.connection, { source: 'local', sha256 });
  assert.equal(pins.items.length, 3);
  assert.deepEqual(pins.items.find((item) => item.eventId === added.event.eventId)?.pin, {
    kind: 'exact',
    ref: added.revision.ref,
  });
  assert.equal(retainedDigest(reopened), before);
});

test('saved exact history freezes its evidence and permits deliberate no-photo/no-session choices without a workbook row', async (t) => {
  const store = await authored(t);
  const result = await readStoredLocalCookingEvent(store.connection, store.event.eventId, {
    sha256,
  });
  assert.deepEqual(result, {
    receipt: store.receipt,
    pin: { kind: 'exact', ref: store.revision.ref },
    requestFingerprint,
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result!.receipt));
  assert.equal(result!.receipt.kind, 'saved');
  if (result!.receipt.kind === 'saved') {
    assert.ok(Object.isFrozen(result!.receipt.event));
    assert.ok(Object.isFrozen(result!.receipt.closedSession));
  }
  assert.equal(
    store.database.prepare('SELECT 1 FROM recipe WHERE recipe_id=?').get(store.event.recipeId),
    undefined,
  );
  assert.equal(
    store.database.prepare('SELECT 1 FROM cooking_session').get(),
    undefined,
    'historical closed session does not require the current session row',
  );
  const alternate: SavedContentReceipt = {
    kind: 'saved',
    event: { ...store.event, photoAssetId: null },
    closedSession: null,
  };
  changeReceipt(store, alternate);
  assert.deepEqual(
    (await readStoredLocalCookingEvent(store.connection, store.event.eventId, { sha256 }))?.receipt,
    alternate,
  );
  assert.equal(await readStoredLocalCookingEvent(store.connection, randomUUID(), { sha256 }), null);
});

test('event title, media and exact reference must agree with the retained pinned revision', async (t) => {
  const store = await authored(t);
  for (const change of [
    { recipeTitle: 'An altered title' },
    { photoAssetId: `sha256:${'f'.repeat(64)}` },
    { contentRef: { ...store.event.contentRef, revisionId: 'other-revision' } },
    { contentRef: { ...store.event.contentRef, contentFingerprint: 'f'.repeat(64) } },
    { recipeId: '90002', contentRef: { ...store.event.contentRef, recipeId: '90002' } },
  ])
    await rejectsUnchanged(store, () =>
      changeReceipt(store, {
        kind: 'saved',
        event: { ...store.event, ...change },
        closedSession: null,
      }),
    );
});

test('saved history rejects missing, unresolved and foreign-parent exact pins', async (t) => {
  const store = await authored(t);
  for (const mutate of [
    () => store.database.exec('DELETE FROM local_history_content_pin'),
    () =>
      store.database.prepare('UPDATE local_history_content_pin SET event_id=?').run(randomUUID()),
    () =>
      store.database
        .prepare('UPDATE local_history_content_pin SET recipe_id=?')
        .run(catalogue.recipes[0]!.recipeId),
    () =>
      store.database.exec(
        "UPDATE local_history_content_pin SET revision_id=NULL,content_fingerprint=NULL,unresolved_reason='content_mismatch'",
      ),
  ])
    await rejectsUnchanged(store, mutate);
});

test('embedded completed-session proof uses an original passage in the same exact recipe at the save instant', async (t) => {
  const store = await authored(t);
  for (const change of [
    { passageSequence: 3 },
    { state: 'active' },
    { lastOperationId: randomUUID() },
    { updatedAt: '2026-10-01T12:00:01.000Z' },
    { contentRef: { ...store.event.contentRef, revisionId: 'different-revision' } },
  ])
    await rejectsUnchanged(store, () =>
      changeReceipt(store, {
        ...store.receipt,
        closedSession: { ...store.receipt.closedSession, ...change },
      }),
    );
  changeReceipt(store, {
    ...store.receipt,
    closedSession: { ...store.receipt.closedSession, passageSequence: 1 },
  });
  const result = await readStoredLocalCookingEvent(store.connection, store.event.eventId, {
    sha256,
  });
  assert.equal(result?.receipt.kind, 'saved');
  if (result?.receipt.kind === 'saved')
    assert.equal(result.receipt.closedSession?.passageSequence, 1);
});

test('saved event scalar columns must agree with their bounded receipt', async (t) => {
  const store = await authored(t);
  for (const [column, value] of [
    ['history_epoch', 1],
    ['cooked_on', '2026-09-29'],
    ['recorded_at', '2026-10-01T12:00:01.000Z'],
    ['request_fingerprint', 'not-a-hash'],
    ['state', 'cleared'],
  ] as const)
    await rejectsUnchanged(store, () =>
      store.database.prepare(`UPDATE cooking_event SET ${column}=?`).run(value),
    );
  await rejectsUnchanged(store, () =>
    changeReceipt(store, {
      kind: 'saved',
      event: { ...store.event, eventId: randomUUID() },
      closedSession: null,
    }),
  );
});

test('cleared and cancelled local events reopen as payload-free tombstones without history pins', async (t) => {
  const store = await authored(t);
  store.database.exec('DELETE FROM local_history_content_pin; DELETE FROM cooking_event');
  const tombstones = ['cleared', 'cancelled'].map((kind) => ({
    kind,
    eventId: randomUUID(),
    historyEpoch: 2,
  }));
  for (const item of tombstones)
    store.database
      .prepare('INSERT INTO cooking_event VALUES (?,?,?,NULL,NULL,NULL,NULL)')
      .run(item.eventId, item.historyEpoch, item.kind);
  const before = retainedDigest(store);
  await store.writer.close();
  const reopened = await store.open();
  assert.equal(await migrateCookingContentDatabase(reopened.writer, { sha256 }), 'existing');
  for (const item of tombstones)
    assert.deepEqual(
      await readStoredLocalCookingEvent(reopened.connection, item.eventId, { sha256 }),
      { receipt: item, pin: null, requestFingerprint: null },
    );
  assert.equal(
    (await readHistoryContentPins(reopened.connection, { source: 'local', sha256 })).items.length,
    0,
  );
  assert.equal(retainedDigest(reopened), before);
});

test('tombstones refuse residual payload columns and residual local-history pins', async (t) => {
  const store = await authored(t);
  store.database.exec(
    "DELETE FROM local_history_content_pin; UPDATE cooking_event SET state='cancelled',cooked_on=NULL,recorded_at=NULL,request_fingerprint=NULL,receipt_json=NULL",
  );
  for (const [column, value] of [
    ['cooked_on', store.event.cookedOn],
    ['recorded_at', at],
    ['request_fingerprint', requestFingerprint],
    ['receipt_json', store.json],
    ['state', 'unknown'],
  ] as const)
    await rejectsUnchanged(store, () =>
      store.database.prepare(`UPDATE cooking_event SET ${column}=?`).run(value),
    );
  await rejectsUnchanged(store, () =>
    store.database
      .prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)')
      .run(
        store.event.eventId,
        store.event.recipeId,
        store.revision.ref.revisionId,
        store.revision.ref.contentFingerprint,
      ),
  );
});

test('retained revision body and scalar kind corruption block actual reopen without repairing history', async (t) => {
  const store = await authored(t);
  await rejectsUnchanged(store, () =>
    store.database
      .prepare("UPDATE recipe_content_revision SET kind='imported' WHERE recipe_id=?")
      .run(store.event.recipeId),
  );
  const changed: RecipeContentRevision = JSON.parse(canonicalContentJson(store.revision));
  changed.document.recipe.title = 'Changed content with stale retained fingerprint';
  store.database
    .prepare('UPDATE recipe_content_revision SET revision_json=? WHERE recipe_id=?')
    .run(canonicalContentJson(changed), store.event.recipeId);
  const before = retainedDigest(store);
  await store.writer.close();
  const reopened = await store.open();
  await assert.rejects(migrateCookingContentDatabase(reopened.writer, { sha256 }));
  assert.equal(retainedDigest(reopened), before);
});

test('oversized saved parent, pin and retained-revision data never escape bounded SQL admission', async (t) => {
  const store = await authored(t),
    originalAll = store.connection.all;
  let largest = 0;
  store.connection.all = async <Row extends object>(
    sql: string,
    values: readonly SqlValue[] = [],
  ) => {
    const rows = await originalAll<Row>(sql, values);
    for (const row of rows)
      for (const value of Object.values(row))
        if (typeof value === 'string') largest = Math.max(largest, Buffer.byteLength(value));
    return rows;
  };
  t.after(() => {
    store.connection.all = originalAll;
  });
  for (const [maximum, corrupt] of [
    [
      32768,
      () =>
        store.database
          .prepare('UPDATE cooking_event SET receipt_json=?')
          .run(JSON.stringify({ extra: 'x'.repeat(32769) })),
    ],
    [
      32768,
      () =>
        store.database
          .prepare('UPDATE cooking_event SET request_fingerprint=?')
          .run('f'.repeat(32769)),
    ],
    [
      32768,
      () =>
        store.database
          .prepare('UPDATE local_history_content_pin SET revision_id=?')
          .run('x'.repeat(32769)),
    ],
    [
      COOKING_CONTENT_LIMITS.revisionBytes,
      () =>
        store.database
          .prepare('UPDATE recipe_content_revision SET revision_json=? WHERE recipe_id=?')
          .run('x'.repeat(COOKING_CONTENT_LIMITS.revisionBytes + 1), store.event.recipeId),
    ],
  ] as const) {
    largest = 0;
    await rejectsUnchanged(store, corrupt);
    assert.ok(largest <= maximum, `raw oversized value reached JavaScript: ${largest}`);
  }
  // Non-saved rows are not an escape hatch from admission.
  store.database.exec(
    "DELETE FROM local_history_content_pin; UPDATE cooking_event SET state='cleared',cooked_on=NULL,recorded_at=NULL,request_fingerprint=NULL,receipt_json=NULL",
  );
  for (const column of ['event_id', 'receipt_json', 'recorded_at']) {
    largest = 0;
    await rejectsUnchanged(store, () =>
      store.database.prepare(`UPDATE cooking_event SET ${column}=?`).run('x'.repeat(32769)),
    );
    assert.ok(largest <= 32768, `oversized cleared ${column} reached JavaScript: ${largest}`);
  }
});
