import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createRecipeContentRevision } from '@cookmate/catalogue/content';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  AccountReplicationError,
  AccountSnapshotError,
  canonicalAccountSnapshot,
  createAccountScopeApprovalEvidence,
  emptyAccountSnapshot,
  type AccountReplicationScope,
  type AccountSnapshot,
  type AccountSnapshotOptions,
} from '@cookmate/account-sync';
import { createAccountContentScopeApprovalEvidence } from '../../account-sync/src/contentScope';
import { canonicalAccountContentSnapshot } from '../../account-sync/src/contentSnapshot';
import { cookingContentIdentity, type CookingHistoryEntry } from '../src';
import {
  captureAccountContentLocal,
  type AccountContentCaptureOptions,
} from '../../../apps/mobile/src/data/accountContentCapture';
import { accountContentScopeApprovalKey } from '../../../apps/mobile/src/data/accountContentScopeApproval';
import { accountScopeApprovalKey } from '../../../apps/mobile/src/data/accountScopeApproval';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_SETTINGS_KEY,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { retainCookingRevisionInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import type {
  ContentCookedReceipt,
  ContentCookingHistoryEntry,
} from '../../../apps/mobile/src/data/contentCookingHistoryRecords';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Disposable local persistence and real codec fixtures. Directly retained revisions and seeded
// approval evidence prove neither signed publication trust nor an actual user's consent action.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  at = '2026-10-01T12:00:00.000Z';
const rawNote = '  Keep exact\nكمية 🍲\u0000\\ ',
  rawAmount = ' 1 ½ ',
  rawUnit = 'tsp. ';
const failure = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-account-content-capture-'));
  const filename = join(directory, 'capture.db');
  const write = desktopConnection(filename),
    read = desktopConnection(filename);
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
  const metadata = (key: string, value: unknown) =>
    db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId });
  const recipe = catalogue.recipes[0]!;
  const legacy: CookingHistoryEntry = {
    ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
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
    backupSourceId = randomUUID(),
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
    backupSourceId,
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
  const first = await createRecipeContentRevision(document, 'capture-first', sha256),
    next = clone(document);
  next.recipe.ingredients[0]!.rawMeasure = '200g';
  const second = await createRecipeContentRevision(next, 'capture-second', sha256);
  for (const value of [first, second])
    await writer.transaction((session) => retainCookingRevisionInSnapshot(session, value, sha256));
  const occurrences = [randomUUID(), randomUUID()];
  for (const [index, value] of [first, second].entries()) {
    db.prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)').run(
      occurrences[index]!,
      recipe.recipeId,
      '2026-10-01',
      index ? 'dinner' : 'lunch',
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
  db.prepare("INSERT INTO manual_shopping_item VALUES (?,?,?,?,'pantry',1,0,1,?,?)").run(
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
  metadata('fixture-secret', 'PRIVATE TOKEN SENTINEL');
  db.prepare('INSERT INTO personal_operation VALUES (?,?,?)').run(
    randomUUID(),
    'a'.repeat(64),
    JSON.stringify({ private: 'PRIVATE RECEIPT SENTINEL' }),
  );
  db.exec(
    "UPDATE state_revision SET revision=7 WHERE collection='store'; UPDATE personal_state SET revision=7",
  );
  let current: AccountReplicationScope | null = { ownerId, authGeneration: 1 };
  let settings: AccountSnapshotOptions = {
    appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
    profile: { displayName: null },
  };
  let onHash: ((text: string) => Promise<void>) | undefined;
  const reads: { sql: string; rows: string }[] = [];
  const all = read.connection.all;
  read.connection.all = async <Row extends object>(
    sql: string,
    values?: Parameters<typeof all>[1],
  ) => {
    const rows = await all<Row>(sql, values);
    reads.push({ sql, rows: JSON.stringify(rows) });
    return rows;
  };
  const options: AccountContentCaptureOptions = {
    installationId,
    catalogue: catalogue.identity,
    currentScope: () => current,
    getLocalSettings: () => settings,
    now: () => at,
    sha256: async (text) => {
      await onHash?.(text);
      return sha256(text);
    },
  };
  const requested: AccountReplicationScope = { ownerId, authGeneration: 1 };
  async function approve(historyIncluded: boolean) {
    const evidence = await createAccountContentScopeApprovalEvidence(
      {
        schemaVersion: 1,
        ownerId,
        installationId,
        scopeVersion: 3,
        personalApproved: true,
        historyIncluded,
        decidedAt: at,
      },
      sha256,
    );
    metadata(accountContentScopeApprovalKey(ownerId), evidence);
    return evidence;
  }
  return {
    db,
    reader,
    writer,
    read,
    options,
    requested,
    installationId,
    reads,
    legacy,
    unresolved,
    backup,
    backupSourceId,
    account,
    exact,
    first,
    second,
    occurrences,
    noteId,
    metadata,
    approve,
    capture: (overrides: Partial<AccountContentCaptureOptions> = {}) =>
      reader.transaction(
        (session) => captureAccountContentLocal(session, requested, { ...options, ...overrides }),
        { kind: 'read_only' },
      ),
    setScope(value: AccountReplicationScope | null) {
      current = value;
    },
    setSettings(value: AccountSnapshotOptions) {
      settings = value;
    },
    onHash(value: typeof onHash) {
      onHash = value;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function snapshot(f: Fixture) {
  return f.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => [name, f.db.prepare(`SELECT * FROM ${String(name)} ORDER BY rowid`).all()]);
}
function assertNoPersonalPayload(f: Fixture) {
  assert.equal(
    f.reads.some(
      ({ rows }) =>
        rows.includes('Lemons') || rows.includes('My dinners') || rows.includes('Keep exact'),
    ),
    false,
  );
}
function assertNoHistoryPayloadOrIds(f: Fixture, additionalIds: string[] = []) {
  const ids = [
    f.legacy.eventId,
    f.unresolved.eventId,
    f.backup.eventId,
    f.backupSourceId,
    f.account.eventId,
    f.exact.eventId,
    ...additionalIds,
  ];
  for (const id of ids)
    assert.equal(
      f.reads.some(({ rows }) => rows.includes(id)),
      false,
      'excluded history identity materialized',
    );
  assert.equal(
    f.reads.some(
      ({ rows }) =>
        rows.includes('"receiptJson":') ||
        rows.includes('"entryJson":') ||
        rows.includes('"receipt_json":') ||
        rows.includes('"entry_json":'),
    ),
    false,
  );
}
async function pending(f: Fixture, version: 1 | 2) {
  const core = emptyAccountSnapshot(catalogue.identity, f.options.getLocalSettings());
  const value: AccountSnapshot =
    version === 1
      ? core
      : {
          ...core,
          schemaVersion: 2,
          personal: { notes: [], collections: [], memberships: [], manualItems: [] },
        };
  const scope = { version: 2 as const, approvalDigest: 'a'.repeat(64), historyIncluded: false };
  const operationId = randomUUID();
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
      capturedLocal: { storeRevision: 0, snapshot: value, ...(version === 2 ? { scope } : {}) },
      remote: { ownerId, revision: 0, snapshot: null, updatedAt: null, deletionOperationId: null },
      proposed: value,
      proposedDigest: await sha256(canonicalAccountSnapshot(value)),
      acknowledgement:
        version === 2 ? { ownerId, operationId, revision: 1, committedAt: at } : null,
    },
  };
}

test('actual8 account capture preserves exact account history and full plan refs only under private3 opt-in', async (t) => {
  const f = await fixture(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  const { historyEpoch: _epoch, revision: _revision, ...wire } = f.exact;
  const account = { ...wire, eventId: randomUUID(), cookedOn: '2026-10-03' };
  f.db
    .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
    .run(ownerId, account.eventId, JSON.stringify(account));
  f.db
    .prepare('INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)')
    .run(
      ownerId,
      account.eventId,
      account.recipeId,
      account.contentRef.revisionId,
      account.contentRef.contentFingerprint,
    );
  await assert.rejects(f.capture(), failure('scope_review_required'));
  await f.approve(true);
  const before = snapshot(f),
    result = await f.capture();
  assert.equal(result.snapshot.schemaVersion, 3);
  assert.equal(result.scope.historyIncluded, true);
  assert.equal(result.snapshot.planReferences.length, 2);
  assert.deepEqual(
    result.snapshot.cookingHistory!.entries.find((item) => item.entry.eventId === account.eventId),
    { kind: 'exact', entry: account },
  );
  assert.equal(
    f.db.prepare('SELECT 1 FROM cooking_event WHERE event_id=?').get(account.eventId),
    undefined,
  );
  assert.doesNotMatch(
    canonicalAccountContentSnapshot(result.snapshot),
    /historyEpoch|requestFingerprint|closedSession/,
  );
  assert.deepEqual(snapshot(f), before);
});

test('actual8 history-off account capture excludes all private history entries and removal identities', async (t) => {
  const f = await fixture(t);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  const withdrawn = randomUUID();
  f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(withdrawn);
  await f.approve(false);
  const before = snapshot(f);
  f.reads.length = 0;
  const result = await f.capture();
  assert.equal(result.scope.historyIncluded, false);
  assert.equal(Object.hasOwn(result.snapshot, 'cookingHistory'), false);
  assertNoHistoryPayloadOrIds(f, [withdrawn]);
  assert.equal(result.snapshot.personal.notes[0]!.text, rawNote);
  assert.deepEqual(snapshot(f), before);
});

test('missing approval and valid old scope2 evidence cannot capture private data or mutate the schema7 workspace', async (t) => {
  const f = await fixture(t);
  const old = await createAccountScopeApprovalEvidence(
    {
      schemaVersion: 1,
      ownerId,
      scopeVersion: 2,
      personalApproved: true,
      historyIncluded: true,
      decidedAt: at,
    },
    sha256,
  );
  for (const seeded of [false, true]) {
    if (seeded) f.metadata(accountScopeApprovalKey(ownerId), old);
    const before = snapshot(f);
    f.reads.length = 0;
    await assert.rejects(f.capture(), failure('scope_review_required'));
    assertNoPersonalPayload(f);
    assertNoHistoryPayloadOrIds(f);
    assert.deepEqual(snapshot(f), before);
  }
});

test('history-off approval captures raw personal fields and exact plan refs without fetching history payloads or withdrawal IDs', async (t) => {
  const f = await fixture(t),
    evidence = await f.approve(false),
    withdrawn = randomUUID();
  f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(withdrawn);
  const before = snapshot(f);
  f.reads.length = 0;
  const result = await f.capture();
  assert.equal(result.scope.version, 3);
  assert.equal(result.scope.approvalDigest, evidence.digest);
  assert.equal(result.scope.historyIncluded, false);
  assert.equal(Object.hasOwn(result.snapshot, 'cookingHistory'), false);
  assert.equal(result.snapshot.personal.notes[0]!.text, rawNote);
  assert.equal(result.snapshot.personal.manualItems[0]!.amountText, rawAmount);
  assert.equal(result.snapshot.personal.manualItems[0]!.unitText, rawUnit);
  assertNoHistoryPayloadOrIds(f, [withdrawn]);
  assert.deepEqual(snapshot(f), before);
});

test('one settled read snapshot preserves two exact plan versions and mixed history while exporting no receipt, body or credentials', async (t) => {
  const f = await fixture(t),
    evidence = await f.approve(true),
    before = snapshot(f);
  const result = await f.capture();
  assert.equal(result.snapshot.schemaVersion, 3);
  assert.equal(result.storeRevision, 7);
  assert.deepEqual(result.scope, {
    version: 3,
    approvalDigest: evidence.digest,
    historyIncluded: true,
  });
  assert.equal(result.fence.ownerId, ownerId);
  assert.equal(result.fence.installationId, f.installationId);
  assert.equal(result.fence.authGeneration, 1);
  assert.deepEqual(
    new Map(result.snapshot.planReferences.map((row) => [row.occurrenceId, row.contentRef])),
    new Map([
      [f.occurrences[0], f.first.ref],
      [f.occurrences[1], f.second.ref],
    ]),
  );
  const entries = result.snapshot.cookingHistory!.entries;
  assert.equal(entries.length, 5);
  const { revision: _revision, historyEpoch: _epoch, ...expectedExact } = f.exact;
  assert.deepEqual(
    entries.find((row) => row.entry.eventId === f.exact.eventId),
    { kind: 'exact', entry: expectedExact },
  );
  const unknown = entries.find((row) => row.entry.eventId === f.unresolved.eventId);
  assert.ok(unknown?.kind === 'legacy');
  assert.deepEqual(unknown.pin, { kind: 'unresolved', reason: 'content_mismatch' });
  assert.equal(unknown.entry.note, rawNote);
  assert.equal(entries.find((row) => row.entry.eventId === f.account.eventId)?.kind, 'legacy');
  const imported = entries.find((row) => row.entry.eventId === f.backup.eventId);
  assert.ok(imported?.kind === 'legacy');
  assert.equal(imported.entry.origin, 'backup');
  const bytes = canonicalAccountContentSnapshot(result.snapshot);
  for (const forbidden of [
    'PRIVATE DRAFT SENTINEL',
    'PRIVATE TOKEN SENTINEL',
    'PRIVATE RECEIPT SENTINEL',
    'closedSession',
    'requestFingerprint',
    'authority_json',
    'rawMeasure',
    'sessionId',
    'historyEpoch',
    'installationId',
  ])
    assert.equal(bytes.includes(forbidden), false, forbidden);
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.snapshot.planReferences) &&
      Object.isFrozen(result.fence),
  );
  assert.deepEqual(snapshot(f), before);
});

test('opt-in capture unions local cleared/cancelled facts, account removals and withdrawn backup source lineage', async (t) => {
  const f = await fixture(t);
  await f.approve(true);
  const cleared = randomUUID(),
    cancelled = randomUUID(),
    priorWithdrawal = randomUUID();
  for (const [eventId, state] of [
    [cleared, 'cleared'],
    [cancelled, 'cancelled'],
  ])
    f.db
      .prepare('INSERT INTO cooking_event VALUES (?,0,?,NULL,NULL,NULL,NULL)')
      .run(eventId!, state!);
  for (const eventId of [priorWithdrawal, f.backup.eventId])
    f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(eventId);
  f.db
    .prepare('DELETE FROM account_history_content_pin WHERE owner_id=? AND event_id=?')
    .run(ownerId, f.account.eventId);
  f.db
    .prepare('DELETE FROM account_cooking_history WHERE owner_id=? AND event_id=?')
    .run(ownerId, f.account.eventId);
  f.db
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(ownerId, f.account.eventId);
  const before = snapshot(f),
    result = await f.capture(),
    history = result.snapshot.cookingHistory!;
  assert.deepEqual(
    history.removedEventIds,
    [
      cleared,
      cancelled,
      priorWithdrawal,
      f.backup.eventId,
      f.backupSourceId,
      f.account.eventId,
    ].sort(),
  );
  assert.deepEqual(
    history.entries.map((row) => row.entry.eventId).sort(),
    [f.legacy.eventId, f.unresolved.eventId, f.exact.eventId].sort(),
  );
  assert.deepEqual(snapshot(f), before);
});

test('initial guest capture is explicitly targeted to an owner without binding or creating a journal', async (t) => {
  const f = await fixture(t);
  f.db.exec('DELETE FROM account_history_content_pin; DELETE FROM account_cooking_history');
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
  await f.approve(true);
  const before = snapshot(f),
    result = await f.capture();
  assert.equal(result.fence.ownerId, ownerId);
  assert.equal(result.fence.binding, null);
  assert.equal(result.snapshot.cookingHistory!.entries.length, 4);
  assert.equal(
    f.db.prepare('SELECT 1 FROM app_metadata WHERE key=?').get(journalKey(ownerId)),
    undefined,
  );
  assert.deepEqual(snapshot(f), before);
});

test('foreign ownership, wrong installation, legacy schema and tampered approval deny whole capture before private transfer', async (t) => {
  const f = await fixture(t),
    evidence = await f.approve(false);
  f.metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId: otherOwnerId });
  let before = snapshot(f);
  await assert.rejects(f.capture(), failure('different_data_owner'));
  assert.deepEqual(snapshot(f), before);
  f.metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId });
  before = snapshot(f);
  await assert.rejects(f.capture({ installationId: randomUUID() }), failure('stored_data_invalid'));
  assert.deepEqual(snapshot(f), before);
  f.db.exec('PRAGMA user_version=6');
  await assert.rejects(f.capture(), failure('stored_data_invalid'));
  assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 6);
  f.db.exec('PRAGMA user_version=7');
  f.metadata(accountContentScopeApprovalKey(ownerId), { ...evidence, digest: 'f'.repeat(64) });
  before = snapshot(f);
  f.reads.length = 0;
  await assert.rejects(f.capture(), failure('stored_data_invalid'));
  assertNoPersonalPayload(f);
  assertNoHistoryPayloadOrIds(f);
  assert.deepEqual(snapshot(f), before);
});

test('foreign account deletion facts are rejected without copying their identifiers or payloads', async (t) => {
  const f = await fixture(t),
    foreignId = randomUUID();
  await f.approve(true);
  f.db
    .prepare('INSERT INTO account_cooking_history_removed VALUES (?,?)')
    .run(otherOwnerId, foreignId);
  const before = snapshot(f);
  f.reads.length = 0;
  await assert.rejects(f.capture(), failure('different_data_owner'));
  assertNoHistoryPayloadOrIds(f, [foreignId]);
  assert.deepEqual(snapshot(f), before);
});

test('old pending v1 and acknowledged v2 operations retain their exact original bytes and block capture', async (t) => {
  const f = await fixture(t);
  await f.approve(true);
  for (const version of [1, 2] as const) {
    const bytes = JSON.stringify(await pending(f, version), null, 2);
    f.db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(journalKey(ownerId), bytes);
    const before = snapshot(f);
    f.reads.length = 0;
    await assert.rejects(f.capture(), failure('operation_pending'));
    assert.equal(
      f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!.value,
      bytes,
    );
    assertNoPersonalPayload(f);
    assertNoHistoryPayloadOrIds(f);
    assert.deepEqual(snapshot(f), before);
  }
});

test('pending settings and foreign journal keys block before reading private local data', async (t) => {
  const f = await fixture(t);
  await f.approve(false);
  f.metadata(ACCOUNT_SETTINGS_KEY, null);
  let before = snapshot(f);
  await assert.rejects(f.capture(), failure('settings_pending'));
  assert.deepEqual(snapshot(f), before);
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_SETTINGS_KEY);
  f.metadata(journalKey(otherOwnerId), { private: 'FOREIGN JOURNAL SENTINEL' });
  before = snapshot(f);
  f.reads.length = 0;
  await assert.rejects(f.capture(), failure('stored_data_invalid'));
  assert.equal(
    f.reads.some(({ rows }) => rows.includes('FOREIGN JOURNAL SENTINEL')),
    false,
  );
  assertNoPersonalPayload(f);
  assert.deepEqual(snapshot(f), before);
});

test('an absent current account rejects before reading settings or any private SQL row', async (t) => {
  const f = await fixture(t),
    before = snapshot(f);
  f.setScope(null);
  f.reads.length = 0;
  let settingsReads = 0;
  await assert.rejects(
    f.capture({
      getLocalSettings() {
        settingsReads++;
        assert.fail('stale access must not read local settings');
      },
    }),
    failure('account_changed'),
  );
  assert.equal(settingsReads, 0);
  assert.deepEqual(
    f.reads.map(({ sql }) => sql),
    ['PRAGMA foreign_keys'],
    'only the enclosing transaction may check connection safety before invoking capture',
  );
  assert.deepEqual(snapshot(f), before);
});

test('owner, generation and settings changes during awaited hashing suppress the result and preserve stored bytes', async (t) => {
  const f = await fixture(t);
  await f.approve(false);
  const original = clone(f.options.getLocalSettings());
  for (const [change, expected] of [
    [() => f.setScope({ ownerId: otherOwnerId, authGeneration: 1 }), 'account_changed'],
    [() => f.setScope({ ownerId, authGeneration: 2 }), 'account_changed'],
    [() => f.setScope(null), 'account_changed'],
    [() => f.setSettings({ ...original, profile: { displayName: 'Changed' } }), 'settings_changed'],
  ] as const) {
    f.setScope({ ownerId, authGeneration: 1 });
    f.setSettings(original);
    const before = snapshot(f);
    let fired = false;
    f.onHash(async (text) => {
      if (!fired && text.includes('"format":"cookmate-local-backup"')) {
        fired = true;
        change();
      }
    });
    await assert.rejects(f.capture(), failure(expected));
    assert.equal(fired, true, 'race reached checksum after the payload snapshot');
    assert.deepEqual(snapshot(f), before);
  }
});

test('hash unavailability and malformed plan pins fail whole capture without replacing source data', async (t) => {
  const f = await fixture(t);
  await f.approve(false);
  const error = new Error('fixture hash unavailable'),
    before = snapshot(f);
  await assert.rejects(
    f.capture({
      sha256: async () => {
        throw error;
      },
    }),
    (actual) => actual === error,
  );
  assert.deepEqual(snapshot(f), before);
  f.db.prepare('DELETE FROM plan_content_pin WHERE occurrence_id=?').run(f.occurrences[0]!);
  const missing = snapshot(f);
  await assert.rejects(f.capture());
  assert.deepEqual(snapshot(f), missing);
});

test('the account2MiB cap rejects the complete otherwise valid portable projection without truncation or writes', async (t) => {
  const f = await fixture(t);
  await f.approve(false);
  const insert = f.db.prepare(
    "INSERT INTO manual_shopping_item VALUES (?,?,?,?,'pantry',0,0,7,?,?)",
  );
  f.db.exec('BEGIN');
  try {
    for (let index = 1; index <= 2100; index++)
      insert.run(
        `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`,
        JSON.stringify('食'.repeat(160)),
        JSON.stringify('量'.repeat(80)),
        JSON.stringify('匙'.repeat(80)),
        at,
        at,
      );
    f.db.exec('COMMIT');
  } catch (error) {
    f.db.exec('ROLLBACK');
    throw error;
  }
  assert.ok(
    Number(
      f.db
        .prepare(
          'SELECT SUM(length(CAST(name AS BLOB))+length(CAST(amount_text AS BLOB))+length(CAST(unit_text AS BLOB))) bytes FROM manual_shopping_item',
        )
        .get()!.bytes,
    ) >
      ACCOUNT_SNAPSHOT_MAX_BYTES - 200_000,
  );
  const before = snapshot(f);
  let completePortableHash = false;
  f.onHash(async (text) => {
    if (text.includes('"format":"cookmate-local-backup"')) completePortableHash = true;
  });
  await assert.rejects(
    f.capture(),
    (error) => error instanceof AccountSnapshotError && error.reason === 'too_large',
  );
  assert.equal(
    completePortableHash,
    true,
    'the format3 portable projection succeeded before the smaller account wire cap',
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM manual_shopping_item').get()!.count, 2101);
  assert.deepEqual(snapshot(f), before);
});
