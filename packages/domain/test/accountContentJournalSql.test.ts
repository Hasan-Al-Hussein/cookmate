import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createRecipeContentRevision } from '@cookmate/catalogue/content';
import {
  AccountReplicationError,
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
  type AccountReplicationScope,
  type AccountSnapshotOptions,
} from '@cookmate/account-sync';
import {
  accountContentSnapshotFromBackup,
  canonicalAccountContentSnapshot,
} from '../../account-sync/src/contentSnapshot';
import { createAccountContentScopeApprovalEvidence } from '../../account-sync/src/contentScope';
import {
  accountContentPendingFingerprint,
  serializeAccountContentJournal,
} from '../../account-sync/src/contentReplicationRecords';
import { canonicalPortableContentJson } from '../src/portableBackupContent';
import {
  captureAccountContentLocal,
  captureAccountContentPendingBundle,
  captureAccountContentPendingLocal,
  type AccountContentCaptureOptions,
} from '../../../apps/mobile/src/data/accountContentCapture';
import {
  createAccountContentJournalRepository,
  type AccountContentRejectedPush,
  type AccountContentStageInput,
} from '../../../apps/mobile/src/data/accountContentJournal';
import {
  accountContentScopeApprovalKey,
  createAccountContentScopeApprovalService,
} from '../../../apps/mobile/src/data/accountContentScopeApproval';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_GUEST_KEY,
  ACCOUNT_SETTINGS_KEY,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { retainCookingRevisionInSnapshot } from '../../../apps/mobile/src/data/cookingContentRepository';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { authoredFixture, clone, sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Real disposable SQLite and private codecs. Seeded retained recipe revisions prove local
// integrity only: these tests establish no signed publication, hosted sync or user consent.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const contentKey = (owner = ownerId) => `account-replication:content-journal:${owner}`;
const guestKey = (owner = ownerId) => `account-replication:content-initial-guest:${owner}`;
const reason =
  (...expected: string[]) =>
  (error: unknown) =>
    error instanceof AccountReplicationError && expected.includes(error.reason);
const settings = (): AccountSnapshotOptions => ({
  appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
  profile: { displayName: null },
});
type Repository = ReturnType<typeof createAccountContentJournalRepository>;
type StageInput = AccountContentStageInput;
type Journal = Awaited<ReturnType<Repository['stage']>>;

async function fixture(t: TestContext, options: { guest?: boolean; schema?: 7 | 8 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-journal-'));
  const filename = join(directory, 'journal.db');
  const installationId = randomUUID();
  let storage = desktopConnection(filename),
    read = desktopConnection(filename);
  let queue = new SqlTransactionQueue();
  let writer = new SerializedWriter(storage.connection, queue);
  let reader = new SerializedReader(read.connection, queue);
  await configureConnection(storage.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
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
  function metadata(key: string, value: unknown) {
    storage.database
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  if (!options.guest) metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId });
  await migrateCookingContentDatabase(writer, { sha256 });
  const recipe = catalogue.recipes[0]!;
  const firstDocument = authoredFixture(recipe.recipeId);
  const first = await createRecipeContentRevision(firstDocument, 'journal-first', sha256);
  const next = clone(firstDocument);
  next.recipe.ingredients[0]!.rawMeasure = ' 200 grams ';
  const second = await createRecipeContentRevision(next, 'journal-second', sha256);
  const occurrences = [randomUUID(), randomUUID()];
  for (const [index, retained] of [first, second].entries()) {
    await writer.transaction((session) =>
      retainCookingRevisionInSnapshot(session, retained, sha256),
    );
    storage.database
      .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
      .run(occurrences[index]!, recipe.recipeId, '2026-10-01', index ? 'dinner' : 'lunch', at, at);
    storage.database
      .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
      .run(
        occurrences[index]!,
        recipe.recipeId,
        retained.ref.revisionId,
        retained.ref.contentFingerprint,
      );
  }
  storage.database
    .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)')
    .run(randomUUID(), recipe.recipeId, JSON.stringify('  Original quantity\nكمية 🍲  '), at, at);
  storage.database.prepare('INSERT INTO favourite VALUES (?,1,1,?,?)').run(recipe.recipeId, at, at);
  storage.database
    .prepare('UPDATE conversation SET composer_draft=?')
    .run(JSON.stringify('PRIVATE UNSENT QUESTION'));
  storage.database
    .prepare('INSERT INTO personal_operation VALUES (?,?,?)')
    .run(randomUUID(), 'a'.repeat(64), JSON.stringify({ private: 'PRIVATE OPERATION RECEIPT' }));
  storage.database.exec(
    "UPDATE state_revision SET revision=1 WHERE collection='store'; UPDATE personal_state SET revision=1",
  );
  if (options.schema !== 7) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const scope: AccountReplicationScope = { ownerId, authGeneration: 1 };
  let current: AccountReplicationScope | null = { ...scope };
  let localSettings = settings();
  let hashEffect: ((text: string) => void) | undefined;
  let readEffect: ((sql: string) => void) | undefined;
  let writeEffect: (() => void) | undefined;
  let commitEffect: (() => void) | undefined;
  let readCommitEffect: (() => void) | undefined;
  let scopeCheckEffect: (() => void) | undefined;
  const reads: { sql: string; rows: string }[] = [];
  function installHooks() {
    for (const connection of [storage.connection, read.connection]) {
      const all = connection.all;
      connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
        const rows = await all<Row>(sql, values);
        reads.push({ sql, rows: JSON.stringify(rows) });
        readEffect?.(sql);
        return rows;
      };
    }
    const prepare = storage.connection.prepare;
    storage.connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        ...statement,
        run: async (values) => {
          await statement.run(values);
          if (sql.startsWith('INSERT INTO app_metadata') && values[0] === contentKey()) {
            const effect = writeEffect;
            writeEffect = undefined;
            effect?.();
          }
        },
      };
    };
    const exec = storage.connection.exec;
    storage.connection.exec = async (sql) => {
      await exec(sql);
      if (sql === 'COMMIT') {
        const effect = commitEffect;
        commitEffect = undefined;
        effect?.();
      }
    };
    const readExec = read.connection.exec;
    read.connection.exec = async (sql) => {
      await readExec(sql);
      if (sql === 'COMMIT') {
        const effect = readCommitEffect;
        readCommitEffect = undefined;
        effect?.();
      }
    };
  }
  installHooks();
  const captureOptions: AccountContentCaptureOptions = {
    installationId,
    catalogue: catalogue.identity,
    currentScope: () => {
      const captured = current;
      const effect = scopeCheckEffect;
      scopeCheckEffect = undefined;
      effect?.();
      return captured;
    },
    getLocalSettings: () => localSettings,
    now: () => at,
    sha256: async (text) => {
      const value = await sha256(text);
      const effect = hashEffect;
      hashEffect = undefined;
      effect?.(text);
      return value;
    },
  };
  const create = () => createAccountContentJournalRepository({ ...captureOptions, reader, writer });
  let repository = create();
  const approvals = () =>
    createAccountContentScopeApprovalService({
      ...captureOptions,
      reader,
      writer,
      newId: randomUUID,
    });
  async function approve(historyIncluded = false) {
    const service = approvals();
    try {
      const review = await service.review(current!);
      return await service.approve(current!, review, { historyIncluded });
    } finally {
      service.close();
    }
  }
  await approve();
  const capture = () =>
    reader.transaction((session) => captureAccountContentLocal(session, current!, captureOptions), {
      kind: 'read_only',
    });
  async function input(overrides: Partial<StageInput> = {}): Promise<StageInput> {
    const capturedLocal: StageInput['capturedLocal'] = JSON.parse(
      canonicalPortableContentJson(await capture()),
    );
    return {
      operationId: randomUUID(),
      expectedJournalRevision: 0,
      expectedDeviceDataOwnerId: options.guest ? null : ownerId,
      initialImportReviewed: true,
      capturedLocal,
      remote: {
        ownerId,
        revision: 1,
        snapshot: capturedLocal.snapshot,
        updatedAt: at,
        deletionOperationId: null,
      },
      proposed: capturedLocal.snapshot,
      mode: 'pull',
      ...overrides,
    };
  }
  t.after(async () => {
    repository.close();
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  return {
    get db() {
      return storage.database;
    },
    get reader() {
      return reader;
    },
    get writer() {
      return writer;
    },
    get repository() {
      return repository;
    },
    installationId,
    scope,
    reads,
    metadata,
    input,
    capture,
    approve,
    first,
    second,
    captureOptions,
    create,
    raw: (key: string) =>
      storage.database.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value,
    setScope(value: AccountReplicationScope | null) {
      current = value;
    },
    setSettings(value: AccountSnapshotOptions) {
      localSettings = value;
    },
    afterHash(effect: typeof hashEffect) {
      hashEffect = effect;
    },
    afterRead(effect: typeof readEffect) {
      readEffect = effect;
    },
    afterWrite(effect: typeof writeEffect) {
      writeEffect = effect;
    },
    afterCommit(effect: typeof commitEffect) {
      commitEffect = effect;
    },
    afterReadCommit(effect: typeof readCommitEffect) {
      readCommitEffect = effect;
    },
    afterScopeCheck(effect: typeof scopeCheckEffect) {
      scopeCheckEffect = effect;
    },
    review: async () => {
      const service = approvals();
      try {
        return await service.review(current!);
      } finally {
        service.close();
      }
    },
    async reopen() {
      repository.close();
      await reader.close();
      await writer.close();
      storage = desktopConnection(filename);
      read = desktopConnection(filename);
      await configureConnection(storage.connection);
      await configureConnection(read.connection);
      await read.connection.exec('PRAGMA query_only=ON');
      queue = new SqlTransactionQueue();
      writer = new SerializedWriter(storage.connection, queue);
      reader = new SerializedReader(read.connection, queue);
      installHooks();
      repository = create();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function reviewedPush(f: Fixture, request: StageInput) {
  const review = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote: request.remote,
  });
  return f.repository.stageReviewedPush(f.scope, review, {
    initialImportReviewed: request.initialImportReviewed,
  });
}
async function seedSettledContentBase(f: Fixture, remote: StageInput['remote']) {
  assert.ok(remote.snapshot);
  const captured = await f.capture();
  const value = {
    schemaVersion: 3,
    ownerId,
    installationId: f.installationId,
    revision: 1,
    legacyJournalDigest: null,
    scope: captured.scope,
    base: remote,
    observed: {
      revision: remote.revision,
      snapshotDigest: await sha256(canonicalAccountContentSnapshot(remote.snapshot)),
      updatedAt: remote.updatedAt,
    },
    pending: null,
    lastApply: {
      ownerId,
      operationId: randomUUID(),
      requestFingerprint: 'b'.repeat(64),
      storeRevision: captured.storeRevision,
      serverRevision: remote.revision,
      appliedAt: at,
    },
  };
  const serialized = await serializeAccountContentJournal(value, ownerId, f.installationId, sha256);
  f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(contentKey(), serialized);
}
function cookingRows(f: Fixture) {
  return f.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name<>'app_metadata' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => [name, f.db.prepare(`SELECT * FROM ${String(name)} ORDER BY rowid`).all()]);
}
function pending(journal: Journal) {
  assert.ok(journal.pending);
  return journal.pending;
}
function acknowledgement(journal: Journal) {
  const request = pending(journal);
  return {
    operationId: request.operationId,
    requestFingerprint: request.requestFingerprint,
    receipt: {
      ownerId,
      operationId: request.operationId,
      revision: request.remote.revision + 1,
      committedAt: at,
    },
  };
}
function rejectedPush(journal: Journal): AccountContentRejectedPush {
  const request = pending(journal);
  return {
    operationId: request.operationId,
    requestFingerprint: request.requestFingerprint,
    expectedJournalRevision: journal.revision,
    reason: 'needs_review',
  };
}
function legacyJournal() {
  return {
    schemaVersion: 1,
    ownerId,
    revision: 1,
    base: null,
    observed: { revision: 0, snapshotDigest: null, updatedAt: null },
    pending: null,
    lastApply: null,
  };
}
function changeAdoption(f: Fixture) {
  // Valid structural local fence fixture, deliberately not a signed release/trust claim.
  f.db.prepare('UPDATE app_content_adoption SET revision=1,head_json=?').run(
    JSON.stringify({
      releaseId: 'journal-fixture-adoption',
      sequence: 1,
      fingerprint: 'a'.repeat(64),
    }),
  );
}
function recapturePending(
  f: Fixture,
  journal: Journal,
  scope: AccountReplicationScope = f.scope,
  identity = {
    operationId: pending(journal).operationId,
    requestFingerprint: pending(journal).requestFingerprint,
  },
) {
  return f.reader.transaction(
    (session) => captureAccountContentPendingLocal(session, scope, identity, f.captureOptions),
    { kind: 'read_only' },
  );
}
function assertNoCookingPayloadRead(f: Fixture) {
  assert.equal(
    f.reads.some(({ sql }) =>
      /\b(recipe_note|personal_collection|manual_shopping_item|plan_occurrence|cooking_event|imported_cooking_history|account_cooking_history)\b/i.test(
        sql,
      ),
    ),
    false,
  );
}

function seedBundleHistory(f: Fixture) {
  const eventId = randomUUID(),
    removedId = randomUUID();
  const event = {
    readerVersion: 2,
    recipeId: f.first.ref.recipeId,
    contentRef: f.first.ref,
    eventId,
    recipeTitle: f.first.document.recipe.title,
    photoAssetId: f.first.document.media[0]!.assetId,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'PRIVATE BUNDLE HISTORY 🍲',
    historyEpoch: 0,
    revision: 1,
  };
  f.db
    .prepare("INSERT INTO cooking_event VALUES (?,0,'saved',?,?,?,?)")
    .run(
      eventId,
      event.cookedOn,
      at,
      'a'.repeat(64),
      JSON.stringify({ kind: 'saved', event, closedSession: null }),
    );
  f.db
    .prepare('INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)')
    .run(eventId, event.recipeId, event.contentRef.revisionId, event.contentRef.contentFingerprint);
  f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(removedId);
  f.db.exec('UPDATE cooking_state SET history_revision=1');
  return { event, removedId };
}

function pendingBundle(f: Fixture, journal: Journal, options = f.captureOptions) {
  const request = pending(journal);
  return f.reader.transaction(
    (session) =>
      captureAccountContentPendingBundle(
        session,
        f.scope,
        {
          operationId: request.operationId,
          requestFingerprint: request.requestFingerprint,
        },
        options,
      ),
    { kind: 'read_only' },
  );
}

test('actual8 stage journals an exact approved capture and reopens without applying recipes or changing old bytes', async (t) => {
  const f = await fixture(t);
  f.metadata(journalKey(ownerId), legacyJournal());
  const legacy = f.raw(journalKey(ownerId));
  const request = await f.input({ mode: 'push' }),
    before = cookingRows(f);
  const result = await reviewedPush(f, request),
    staged = pending(result);
  assert.equal(result.schemaVersion, 3);
  assert.equal(staged.operationId, request.operationId);
  assert.deepEqual(
    staged.capturedLocal.snapshot.planReferences,
    request.capturedLocal.snapshot.planReferences,
  );
  assert.equal(staged.capturedLocal.snapshot.planReferences.length, 2);
  assert.equal(
    staged.capturedLocal.fenceDigest,
    await sha256(canonicalPortableContentJson(request.capturedLocal.fence, 32768)),
  );
  assert.equal(Object.hasOwn(staged.capturedLocal, 'fence'), false);
  assert.equal(Object.isFrozen(staged.proposed.personal.notes), true);
  assert.doesNotMatch(
    String(f.raw(contentKey())),
    /PRIVATE UNSENT|PRIVATE OPERATION|revision_json|authGeneration/,
  );
  assert.deepEqual(cookingRows(f), before);
  assert.equal(f.raw(journalKey(ownerId)), legacy);
  assert.deepEqual(await f.repository.read(f.scope), result);
  await f.reopen();
  assert.deepEqual(
    await f.repository.recover(f.scope, {
      operationId: request.operationId,
      requestFingerprint: staged.requestFingerprint,
    }),
    result,
  );
  assert.equal(f.raw(journalKey(ownerId)), legacy);
  assert.deepEqual(cookingRows(f), before);
});

test('same-operation stage retry keeps exact bytes across auth generation changes; changed requests cannot replace pending', async (t) => {
  const f = await fixture(t),
    request = await f.input({ mode: 'push' });
  const first = await reviewedPush(f, request),
    bytes = f.raw(contentKey());
  assert.deepEqual(await f.repository.stage(f.scope, request), first);
  const renewed = { ...f.scope, authGeneration: 2 };
  f.setScope(renewed);
  assert.deepEqual(await f.repository.stage(renewed, request), first);
  for (const changed of [
    { ...request, operationId: randomUUID() },
    {
      ...request,
      proposed: { ...request.proposed, profile: { displayName: 'A different reviewed result' } },
    },
    { ...request, mode: 'pull' as const },
  ])
    await assert.rejects(
      f.repository.stage(renewed, changed),
      reason('operation_pending', 'operation_changed', 'invalid_input'),
    );
  assert.equal(f.raw(contentKey()), bytes);
});

test('pull staging owns the exact request before awaits and retains the observed remote without applying it', async (t) => {
  const f = await fixture(t),
    captured = await f.input();
  const remote = { ...captured.remote, revision: 4, snapshot: captured.proposed, updatedAt: at };
  const request: StageInput = clone({ ...captured, mode: 'pull', remote });
  const before = cookingRows(f),
    original = clone(request);
  const work = f.repository.stage(f.scope, request);
  request.proposed.profile.displayName = 'Late caller edit';
  request.remote.revision = 5;
  const staged = await work;
  assert.equal(pending(staged).mode, 'pull');
  assert.deepEqual(pending(staged).remote, original.remote);
  assert.deepEqual(pending(staged).proposed, original.proposed);
  assert.deepEqual(cookingRows(f), before);
});

test('pending3 blocks new consent and capture but original-owner recovery survives changed approval and local state', async (t) => {
  const f = await fixture(t),
    request = await f.input();
  const staged = await f.repository.stage(f.scope, request),
    active = pending(staged);
  await assert.rejects(f.review(), reason('operation_pending'));
  await assert.rejects(f.capture(), reason('operation_pending'));
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(accountContentScopeApprovalKey(ownerId));
  f.db.exec("UPDATE state_revision SET revision=revision+1 WHERE collection='store'");
  changeAdoption(f);
  const before = cookingRows(f);
  assert.deepEqual(
    await f.repository.recover(f.scope, {
      operationId: active.operationId,
      requestFingerprint: active.requestFingerprint,
    }),
    staged,
  );
  assert.deepEqual(await f.repository.read(f.scope), staged);
  assert.deepEqual(cookingRows(f), before);
  await assert.rejects(
    f.repository.recover(f.scope, {
      operationId: active.operationId,
      requestFingerprint: 'f'.repeat(64),
    }),
    reason('operation_changed'),
  );
});

test('guest import needs explicit review and atomically claims its owner with an inert archive without applying the guest data', async (t) => {
  const f = await fixture(t, { guest: true }),
    request = await f.input({ initialImportReviewed: false });
  const before = cookingRows(f);
  await assert.rejects(f.repository.stage(f.scope, request), reason('initial_review_required'));
  assert.equal(f.raw(contentKey()), undefined);
  assert.equal(f.raw(guestKey()), undefined);
  const staged = await f.repository.stage(f.scope, { ...request, initialImportReviewed: true });
  const archive = String(f.raw(guestKey()));
  assert.match(archive, /Original quantity/);
  assert.doesNotMatch(archive, /PRIVATE UNSENT|PRIVATE OPERATION|authGeneration/);
  assert.deepEqual(JSON.parse(String(f.raw(ACCOUNT_BINDING_KEY))), { schemaVersion: 1, ownerId });
  assert.equal(f.raw(ACCOUNT_GUEST_KEY), undefined);
  assert.deepEqual(cookingRows(f), before);
  await f.reopen();
  assert.deepEqual(await f.repository.read(f.scope), staged);
  assert.equal(f.raw(guestKey()), archive);
});

test('all current capture fence changes stale a new stage without a journal or private data mutation', async (t) => {
  const f = await fixture(t);
  const mutations = [
    () => f.db.exec("UPDATE state_revision SET revision=revision+1 WHERE collection='store'"),
    () => f.db.exec('UPDATE personal_state SET revision=revision+1'),
    () => f.db.exec('UPDATE personal_state SET epoch=epoch+1'),
    () => f.db.exec('UPDATE cooking_state SET history_revision=history_revision+1'),
    () => f.db.exec('UPDATE cooking_state SET history_epoch=history_epoch+1'),
    () => changeAdoption(f),
    () =>
      f.db
        .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
        .run(randomUUID(), 'a'.repeat(64), '{}', '{}', '{}'),
    () => f.setSettings({ ...settings(), profile: { displayName: 'Changed after capture' } }),
  ];
  for (const mutate of mutations) {
    const request = await f.input();
    mutate();
    const before = cookingRows(f);
    await assert.rejects(
      f.repository.stage(f.scope, request),
      reason('local_changed', 'scope_changed', 'settings_changed'),
    );
    assert.equal(f.raw(contentKey()), undefined);
    assert.deepEqual(cookingRows(f), before);
  }
  const request = await f.input();
  await f.approve(true);
  await assert.rejects(
    f.repository.stage(f.scope, request),
    reason('scope_changed', 'local_changed'),
  );
  assert.equal(f.raw(contentKey()), undefined);
});

test('wrong captured values, installation and journal revision cannot stage an unreviewed candidate', async (t) => {
  const f = await fixture(t),
    request = await f.input();
  for (const changed of [
    { ...request, expectedJournalRevision: 1 },
    { ...request, expectedDeviceDataOwnerId: null },
    {
      ...request,
      capturedLocal: {
        ...request.capturedLocal,
        fence: { ...request.capturedLocal.fence, installationId: randomUUID() },
      },
    },
    {
      ...request,
      capturedLocal: {
        ...request.capturedLocal,
        snapshot: { ...request.capturedLocal.snapshot, profile: { displayName: 'Invented' } },
      },
    },
  ])
    await assert.rejects(
      f.repository.stage(f.scope, changed),
      reason('journal_changed', 'different_data_owner', 'local_changed', 'invalid_input'),
    );
  assert.equal(f.raw(contentKey()), undefined);
});

test('only actual8 may journal content snapshots and old pending/settings evidence is never rewritten', async (t) => {
  const old = await fixture(t, { schema: 7 }),
    request = await old.input();
  await assert.rejects(old.repository.stage(old.scope, request), reason('stored_data_invalid'));
  await assert.rejects(old.repository.read(old.scope), reason('stored_data_invalid'));
  assert.equal(old.raw(contentKey()), undefined);
  assert.equal(old.db.prepare('PRAGMA user_version').get()!.user_version, 7);
  const f = await fixture(t),
    fresh = await f.input();
  const snapshot = emptyAccountSnapshot(catalogue.identity, settings());
  const pendingLegacy = {
    ...legacyJournal(),
    pending: {
      operationId: randomUUID(),
      mode: 'push',
      capturedLocal: { storeRevision: 1, snapshot },
      remote: { ownerId, revision: 0, snapshot: null, updatedAt: null, deletionOperationId: null },
      proposed: snapshot,
      proposedDigest: await sha256(canonicalAccountSnapshot(snapshot)),
      acknowledgement: null,
    },
  };
  for (const pending of [
    pendingLegacy,
    {
      ...pendingLegacy,
      pending: {
        ...pendingLegacy.pending,
        acknowledgement: {
          ownerId,
          operationId: pendingLegacy.pending.operationId,
          revision: 1,
          committedAt: at,
        },
      },
    },
  ]) {
    f.metadata(journalKey(ownerId), pending);
    const bytes = f.raw(journalKey(ownerId));
    await assert.rejects(f.repository.stage(f.scope, fresh), reason('operation_pending'));
    assert.equal(f.raw(journalKey(ownerId)), bytes);
    assert.equal(f.raw(contentKey()), undefined);
  }
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(journalKey(ownerId));
  f.metadata(ACCOUNT_SETTINGS_KEY, null);
  await assert.rejects(f.repository.stage(f.scope, fresh), reason('settings_pending'));
  assert.equal(f.raw(ACCOUNT_SETTINGS_KEY), 'null');
  assert.equal(f.raw(contentKey()), undefined);
});

test('legacy nonempty bases or server observations require a future explicit conversion, even when settled', async (t) => {
  const f = await fixture(t);
  const snapshot = emptyAccountSnapshot(catalogue.identity, settings());
  const observed = {
    revision: 1,
    snapshotDigest: await sha256(canonicalAccountSnapshot(snapshot)),
    updatedAt: at,
  };
  for (const old of [
    { ...legacyJournal(), observed },
    {
      ...legacyJournal(),
      observed,
      base: { ownerId, revision: 1, snapshot, updatedAt: at, deletionOperationId: null },
      lastApply: {
        ownerId,
        operationId: randomUUID(),
        storeRevision: 1,
        serverRevision: 1,
        appliedAt: at,
      },
    },
  ]) {
    f.metadata(journalKey(ownerId), old);
    const bytes = f.raw(journalKey(ownerId)),
      request = await f.input();
    await assert.rejects(f.repository.stage(f.scope, request), reason('recovery_required'));
    assert.equal(f.raw(journalKey(ownerId)), bytes);
    assert.equal(f.raw(contentKey()), undefined);
  }
});

test('acknowledgement is exact, idempotent, recoverable and never applies or erases the pending request', async (t) => {
  const f = await fixture(t),
    request = await f.input({ mode: 'push' });
  const staged = await reviewedPush(f, request),
    ack = acknowledgement(staged),
    before = cookingRows(f);
  const acknowledged = await f.repository.recordAcknowledgement(f.scope, ack);
  assert.deepEqual(pending(acknowledged).acknowledgement, ack.receipt);
  assert.deepEqual(pending(acknowledged).proposed, pending(staged).proposed);
  const bytes = f.raw(contentKey());
  assert.deepEqual(await f.repository.recordAcknowledgement(f.scope, ack), acknowledged);
  for (const altered of [
    { ...ack, requestFingerprint: 'f'.repeat(64) },
    { ...ack, receipt: { ...ack.receipt, revision: ack.receipt.revision + 1 } },
    { ...ack, receipt: { ...ack.receipt, ownerId: otherOwnerId } },
    { ...ack, receipt: { ...ack.receipt, committedAt: '2026-10-02T12:00:00.000Z' } },
  ])
    await assert.rejects(
      f.repository.recordAcknowledgement(f.scope, altered),
      reason('invalid_input', 'operation_changed'),
    );
  assert.equal(f.raw(contentKey()), bytes);
  assert.deepEqual(cookingRows(f), before);
  await f.reopen();
  assert.deepEqual(
    await f.repository.recover(f.scope, {
      operationId: ack.operationId,
      requestFingerprint: ack.requestFingerprint,
    }),
    acknowledged,
  );
});

test('definite CAS rejection clears only its exact pending push and preserves guest archive, base and local data', async (t) => {
  for (const guest of [true, false]) {
    const f = await fixture(t, { guest }),
      request = await f.input({ mode: 'push' });
    if (!guest) await seedSettledContentBase(f, request.remote);
    const staged = await reviewedPush(f, request),
      input = rejectedPush(staged);
    const before = cookingRows(f);
    const metadata = () =>
      f.db.prepare('SELECT * FROM app_metadata WHERE key<>? ORDER BY key').all(contentKey());
    const otherMetadata = metadata();
    const discarded = await f.repository.discardRejected(f.scope, input);
    assert.deepEqual(discarded, { ...staged, revision: staged.revision + 1, pending: null });
    assert.deepEqual(cookingRows(f), before);
    assert.deepEqual(metadata(), otherMetadata);
    assert.equal(f.raw(guestKey()) !== undefined, guest);
    await f.reopen();
    assert.deepEqual(await f.repository.read(f.scope), discarded);
    assert.equal(
      await f.repository.recover(f.scope, {
        operationId: input.operationId,
        requestFingerprint: input.requestFingerprint,
      }),
      null,
    );
    await assert.rejects(f.repository.discardRejected(f.scope, input), reason('journal_changed'));
    const next = await reviewedPush(f, { ...request, operationId: randomUUID() });
    const bytes = f.raw(contentKey());
    await assert.rejects(
      f.repository.discardRejected(f.scope, { ...input, expectedJournalRevision: next.revision }),
      reason('operation_changed'),
    );
    assert.equal(f.raw(contentKey()), bytes);
    assert.deepEqual(cookingRows(f), before);
  }
});

test('definite CAS discard rejects wrong operation, fingerprint, revision and every uncertain outcome reason', async (t) => {
  const f = await fixture(t),
    staged = await reviewedPush(f, await f.input({ mode: 'push' }));
  const input = rejectedPush(staged),
    bytes = f.raw(contentKey()),
    before = cookingRows(f);
  for (const altered of [
    { ...input, operationId: randomUUID() },
    { ...input, requestFingerprint: 'f'.repeat(64) },
    { ...input, expectedJournalRevision: input.expectedJournalRevision - 1 },
    { ...input, expectedJournalRevision: input.expectedJournalRevision + 1 },
  ])
    await assert.rejects(
      f.repository.discardRejected(f.scope, altered),
      reason('operation_changed', 'journal_changed'),
    );
  for (const failure of [
    'unavailable',
    'cancelled',
    'operation_changed',
    'invalid_response',
    'account_changed',
    'snapshot_upgrade_required',
    'sync_rate_limited',
    'deletion_pending',
  ]) {
    const invalid: AccountContentRejectedPush = JSON.parse(
      JSON.stringify({ ...input, reason: failure }),
    );
    f.reads.length = 0;
    await assert.rejects(f.repository.discardRejected(f.scope, invalid), reason('invalid_input'));
    assert.equal(f.reads.length, 0);
  }
  for (const changed of [
    { ...input, extra: true },
    { ...input, requestFingerprint: 'not-a-fingerprint' },
    { ...input, expectedJournalRevision: -1 },
    { ...input, expectedJournalRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const invalid: AccountContentRejectedPush = JSON.parse(JSON.stringify(changed));
    await assert.rejects(f.repository.discardRejected(f.scope, invalid), reason('invalid_input'));
  }
  assert.equal(f.raw(contentKey()), bytes);
  assert.deepEqual(cookingRows(f), before);
  await f.reopen();
  assert.deepEqual(
    await f.repository.recover(f.scope, {
      operationId: input.operationId,
      requestFingerprint: input.requestFingerprint,
    }),
    staged,
  );
});

test('definite CAS discard cannot clear a pull or an acknowledged push', async (t) => {
  for (const mode of ['pull', 'push'] as const) {
    const f = await fixture(t),
      request = await f.input({ mode });
    let staged =
      mode === 'pull' ? await f.repository.stage(f.scope, request) : await reviewedPush(f, request);
    if (mode === 'push')
      staged = await f.repository.recordAcknowledgement(f.scope, acknowledgement(staged));
    const bytes = f.raw(contentKey()),
      before = cookingRows(f);
    await assert.rejects(
      f.repository.discardRejected(f.scope, rejectedPush(staged)),
      reason('operation_changed'),
    );
    assert.equal(f.raw(contentKey()), bytes);
    assert.deepEqual(cookingRows(f), before);
  }
});

test('definite CAS discard admits only the current schema, installation and persisted owner', async (t) => {
  const f = await fixture(t),
    staged = await reviewedPush(f, await f.input({ mode: 'push' }));
  const input = rejectedPush(staged),
    bytes = f.raw(contentKey());
  for (const schema of [5, 6, 7, 9]) {
    f.db.exec(`PRAGMA user_version=${schema}`);
    await assert.rejects(
      f.repository.discardRejected(f.scope, input),
      reason('stored_data_invalid'),
    );
    assert.equal(f.raw(contentKey()), bytes);
  }
  f.db.exec('PRAGMA user_version=8');
  for (const [key, invalid] of [
    ['installation_id', randomUUID()],
    [ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId: otherOwnerId })],
  ]) {
    const original = f.raw(key!);
    f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(invalid!, key!);
    await assert.rejects(
      f.repository.discardRejected(f.scope, input),
      reason('different_data_owner'),
    );
    assert.equal(f.raw(contentKey()), bytes);
    f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(String(original), key!);
  }
  const binding = f.raw(ACCOUNT_BINDING_KEY);
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
  await assert.rejects(
    f.repository.discardRejected(f.scope, input),
    reason('different_data_owner'),
  );
  f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(ACCOUNT_BINDING_KEY, String(binding));
  f.setScope({ ...f.scope, authGeneration: 2 });
  f.reads.length = 0;
  await assert.rejects(f.repository.discardRejected(f.scope, input), reason('account_changed'));
  assert.equal(f.reads.length, 0);
  assert.equal(f.raw(contentKey()), bytes);
});

test('definite CAS discard owns the request before any asynchronous SQL or hash boundary', async (t) => {
  const f = await fixture(t),
    staged = await reviewedPush(f, await f.input({ mode: 'push' }));
  const input = rejectedPush(staged),
    scope = { ...f.scope };
  f.afterRead(() => {
    f.afterRead(undefined);
    input.operationId = randomUUID();
    input.requestFingerprint = 'f'.repeat(64);
    input.expectedJournalRevision++;
    scope.ownerId = otherOwnerId;
  });
  const discarded = await f.repository.discardRejected(scope, input);
  assert.deepEqual(discarded, { ...staged, revision: staged.revision + 1, pending: null });
});

test('definite CAS discard rolls back if owner retires during reads, hashes, writes or final admission', async (t) => {
  for (const moment of ['read', 'hash', 'write', 'commit'] as const) {
    const f = await fixture(t),
      staged = await reviewedPush(f, await f.input({ mode: 'push' }));
    const bytes = f.raw(contentKey()),
      before = cookingRows(f);
    if (moment === 'read')
      f.afterRead(() => {
        f.afterRead(undefined);
        f.setScope(null);
      });
    if (moment === 'hash') f.afterHash(() => f.setScope(null));
    if (moment === 'write') f.afterWrite(() => f.repository.close());
    if (moment === 'commit')
      f.writer.setObserver({
        begin: async () => undefined,
        beforeCommit: async () => {
          f.setScope(null);
        },
        committed: async () => assert.fail('Retired owner must not commit'),
        failed: () => undefined,
      });
    await assert.rejects(
      f.repository.discardRejected(f.scope, rejectedPush(staged)),
      reason('account_changed'),
    );
    assert.equal(f.raw(contentKey()), bytes);
    assert.deepEqual(cookingRows(f), before);
    f.reads.length = 0;
    await assert.rejects(
      f.repository.discardRejected(f.scope, rejectedPush(staged)),
      reason('account_changed'),
    );
    assert.equal(f.reads.length, 0);
  }
});

test('definite CAS discard rechecks persisted installation and binding after its write and rolls back storage failure', async (t) => {
  for (const failure of ['installation', 'binding', 'write'] as const) {
    const f = await fixture(t),
      staged = await reviewedPush(f, await f.input({ mode: 'push' }));
    const before = f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all();
    f.afterWrite(() => {
      if (failure === 'write') throw new Error('Injected rejected push journal failure');
      if (failure === 'binding')
        f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
      else
        f.db
          .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
          .run(randomUUID());
    });
    await assert.rejects(
      f.repository.discardRejected(f.scope, rejectedPush(staged)),
      failure === 'write' ? /Injected rejected push/ : reason('different_data_owner'),
    );
    assert.deepEqual(f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all(), before);
  }
});

test('definite CAS discard resolves only exact lost local COMMIT acknowledgement and preserves reopen recovery', async (t) => {
  const f = await fixture(t),
    staged = await reviewedPush(f, await f.input({ mode: 'push' }));
  const input = rejectedPush(staged),
    before = cookingRows(f);
  f.afterCommit(() => {
    throw new Error('Lost rejected push COMMIT acknowledgement');
  });
  const discarded = await f.repository.discardRejected(f.scope, input);
  assert.equal(f.writer.requiresRecovery(), true);
  assert.deepEqual(discarded, { ...staged, revision: staged.revision + 1, pending: null });
  await f.reopen();
  assert.deepEqual(await f.repository.read(f.scope), discarded);
  await assert.rejects(f.repository.discardRejected(f.scope, input), reason('journal_changed'));
  assert.deepEqual(cookingRows(f), before);
});

test('definite CAS discard hides a committed result after owner retirement but does not undo it', async (t) => {
  const f = await fixture(t),
    staged = await reviewedPush(f, await f.input({ mode: 'push' }));
  f.afterCommit(() => f.setScope(null));
  await assert.rejects(
    f.repository.discardRejected(f.scope, rejectedPush(staged)),
    reason('account_changed'),
  );
  f.reads.length = 0;
  await assert.rejects(f.repository.read(f.scope), reason('account_changed'));
  assert.equal(f.reads.length, 0);
  f.setScope(f.scope);
  await f.reopen();
  assert.deepEqual(await f.repository.read(f.scope), {
    ...staged,
    revision: staged.revision + 1,
    pending: null,
  });
});

test('foreign-owner, malformed, null and oversized journals fail before private payload transfer', async (t) => {
  const f = await fixture(t),
    request = await f.input();
  f.metadata(contentKey(otherOwnerId), { private: 'FOREIGN JOURNAL PAYLOAD' });
  f.reads.length = 0;
  await assert.rejects(
    f.repository.read(f.scope),
    reason('stored_data_invalid', 'different_data_owner'),
  );
  assert.equal(
    f.reads.some(({ rows }) => rows.includes('FOREIGN JOURNAL PAYLOAD')),
    false,
  );
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(contentKey(otherOwnerId));
  for (const malformed of [
    'null',
    '{not-json}',
    JSON.stringify({ ...legacyJournal(), schemaVersion: 3 }),
  ]) {
    f.db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(contentKey(), malformed);
    await assert.rejects(f.repository.read(f.scope), reason('stored_data_invalid'));
    assert.equal(f.raw(contentKey()), malformed);
  }
  f.db
    .prepare('UPDATE app_metadata SET value=CAST(zeroblob(12000000) AS TEXT) WHERE key=?')
    .run(contentKey());
  f.reads.length = 0;
  await assert.rejects(f.repository.read(f.scope), reason('too_large'));
  assert.equal(
    f.reads.some(({ rows }) => rows.length > 10000),
    false,
    'over-limit body escaped bounded SQL',
  );
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(contentKey());
  await f.repository.stage(f.scope, request);
  f.metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId: otherOwnerId });
  f.reads.length = 0;
  await assert.rejects(f.repository.read(f.scope), reason('different_data_owner'));
  assert.equal(
    f.reads.some(({ rows }) => rows.includes('Original quantity')),
    false,
  );
});

test('owner loss after awaited hashing or journal SQL write rolls stage back without later private reads', async (t) => {
  const f = await fixture(t),
    request = await f.input();
  let readsAtLoss = 0;
  f.afterHash(() => {
    readsAtLoss = f.reads.length;
    f.setScope(null);
  });
  await assert.rejects(f.repository.stage(f.scope, request), reason('account_changed'));
  assert.equal(f.reads.length, readsAtLoss);
  assert.equal(f.raw(contentKey()), undefined);
  f.setScope(f.scope);
  f.afterWrite(() => f.setScope(null));
  await assert.rejects(f.repository.stage(f.scope, request), reason('account_changed'));
  assert.equal(f.raw(contentKey()), undefined);
  f.setScope(f.scope);
  f.repository.close();
  f.reads.length = 0;
  await assert.rejects(f.repository.read(f.scope), reason('account_changed'));
  assert.equal(f.reads.length, 0);
});

test('final synchronous admission after the awaited writer observer prevents stale stage COMMIT', async (t) => {
  const f = await fixture(t),
    request = await f.input(),
    before = cookingRows(f);
  f.writer.setObserver({
    begin: async () => undefined,
    beforeCommit: async () => {
      f.setScope(null);
    },
    committed: async () => assert.fail('A revoked owner must not commit'),
    failed: () => undefined,
  });
  await assert.rejects(f.repository.stage(f.scope, request), reason('account_changed'));
  assert.equal(f.raw(contentKey()), undefined);
  assert.deepEqual(cookingRows(f), before);
});

test('lost stage COMMIT acknowledgement recovers the exact durable request without another operation', async (t) => {
  const f = await fixture(t),
    request = await f.input(),
    before = cookingRows(f);
  f.afterCommit(() => {
    throw new Error('fixture lost stage acknowledgement');
  });
  const staged = await f.repository.stage(f.scope, request);
  assert.equal(f.writer.requiresRecovery(), true);
  assert.equal(pending(staged).operationId, request.operationId);
  assert.deepEqual(await f.repository.read(f.scope), staged);
  await f.reopen();
  assert.deepEqual(await f.repository.stage(f.scope, request), staged);
  assert.deepEqual(cookingRows(f), before);
});

test('lost acknowledgement-write COMMIT recovers the same exact receipt after reopening', async (t) => {
  const f = await fixture(t),
    staged = await reviewedPush(f, await f.input({ mode: 'push' })),
    ack = acknowledgement(staged);
  f.afterCommit(() => {
    throw new Error('fixture lost receipt acknowledgement');
  });
  const acknowledged = await f.repository.recordAcknowledgement(f.scope, ack);
  assert.equal(f.writer.requiresRecovery(), true);
  assert.deepEqual(pending(acknowledged).acknowledgement, ack.receipt);
  await f.reopen();
  assert.deepEqual(await f.repository.recordAcknowledgement(f.scope, ack), acknowledged);
});

test('owner drift after successful COMMIT suppresses stage delivery but original owner retains recovery', async (t) => {
  const f = await fixture(t),
    request = await f.input();
  f.afterCommit(() => f.setScope({ ownerId: otherOwnerId, authGeneration: 2 }));
  await assert.rejects(f.repository.stage(f.scope, request), reason('account_changed'));
  assert.ok(f.raw(contentKey()));
  f.setScope(f.scope);
  await f.reopen();
  const recovered = await f.repository.read(f.scope);
  assert.ok(recovered);
  assert.equal(pending(recovered).operationId, request.operationId);
  assert.equal(
    canonicalAccountContentSnapshot(pending(recovered).proposed),
    canonicalAccountContentSnapshot(request.proposed),
  );
});

test('owner drift during acknowledgement COMMIT cannot deliver its receipt to a replacement account', async (t) => {
  const f = await fixture(t),
    staged = await reviewedPush(f, await f.input({ mode: 'push' })),
    ack = acknowledgement(staged);
  f.afterCommit(() => f.setScope({ ownerId: otherOwnerId, authGeneration: 2 }));
  await assert.rejects(f.repository.recordAcknowledgement(f.scope, ack), reason('account_changed'));
  f.reads.length = 0;
  await assert.rejects(
    f.repository.recover(f.scope, {
      operationId: ack.operationId,
      requestFingerprint: ack.requestFingerprint,
    }),
    reason('account_changed'),
  );
  assert.equal(f.reads.length, 0);
  f.setScope(f.scope);
  await f.reopen();
  const result = await f.repository.recover(f.scope, {
    operationId: ack.operationId,
    requestFingerprint: ack.requestFingerprint,
  });
  assert.ok(result);
  assert.deepEqual(pending(result).acknowledgement, ack.receipt);
});

test('a retained previous apply remains recoverable while another exact operation is pending', async (t) => {
  const f = await fixture(t),
    request = await f.input();
  request.remote = { ...request.remote, revision: 1, snapshot: request.proposed, updatedAt: at };
  const staged = await f.repository.stage(f.scope, request),
    active = pending(staged);
  const earlier = {
    ownerId,
    operationId: randomUUID(),
    storeRevision: 1,
    serverRevision: 1,
    appliedAt: at,
    requestFingerprint: 'b'.repeat(64),
  };
  const bytes = await serializeAccountContentJournal(
    { ...staged, revision: 3, base: request.remote, lastApply: earlier },
    ownerId,
    f.installationId,
    sha256,
  );
  f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(bytes, contentKey());
  const before = cookingRows(f),
    expected = await f.repository.read(f.scope);
  assert.ok(expected);
  for (const operation of [earlier, active]) {
    assert.deepEqual(
      await f.repository.recover(f.scope, {
        operationId: operation.operationId,
        requestFingerprint: operation.requestFingerprint,
      }),
      expected,
    );
    await assert.rejects(
      f.repository.recover(f.scope, {
        operationId: operation.operationId,
        requestFingerprint: 'f'.repeat(64),
      }),
      reason('operation_changed'),
    );
  }
  assert.equal(
    await f.repository.recover(f.scope, {
      operationId: randomUUID(),
      requestFingerprint: 'f'.repeat(64),
    }),
    null,
  );
  assert.equal(f.raw(contentKey()), bytes);
  assert.deepEqual(cookingRows(f), before);
});

test('recovery rechecks access after read delivery before returning an operation across a microtask boundary', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input()),
    active = pending(staged);
  f.afterReadCommit(() => f.afterScopeCheck(() => queueMicrotask(() => f.setScope(null))));
  await assert.rejects(
    f.repository.recover(f.scope, {
      operationId: active.operationId,
      requestFingerprint: active.requestFingerprint,
    }),
    reason('account_changed'),
  );
  f.setScope(f.scope);
  assert.deepEqual(await f.repository.read(f.scope), staged);
});

test('operation-bound recapture returns current late edits and current auth generation while retaining original pending bytes', async (t) => {
  const f = await fixture(t),
    request = await f.input({ mode: 'push' });
  const staged = await reviewedPush(f, request),
    bytes = f.raw(contentKey());
  f.db
    .prepare('UPDATE recipe_note SET text=?,revision=2')
    .run(JSON.stringify('  Late personal edit\n🍲 '));
  f.db.exec(
    "UPDATE state_revision SET revision=2 WHERE collection='store'; UPDATE personal_state SET revision=2",
  );
  f.db
    .prepare('UPDATE plan_content_pin SET revision_id=?,content_fingerprint=? WHERE revision_id=?')
    .run(f.second.ref.revisionId, f.second.ref.contentFingerprint, f.first.ref.revisionId);
  f.setSettings({ ...settings(), profile: { displayName: 'Late local profile' } });
  const renewed = { ...f.scope, authGeneration: 2 };
  f.setScope(renewed);
  const before = cookingRows(f),
    captured = await recapturePending(f, staged, renewed);
  assert.equal(captured.storeRevision, 2);
  assert.equal(captured.fence.authGeneration, 2);
  assert.equal(captured.fence.binding, ownerId);
  assert.equal(captured.snapshot.personal.notes[0]!.text, '  Late personal edit\n🍲 ');
  assert.equal(captured.snapshot.profile.displayName, 'Late local profile');
  assert.ok(
    captured.snapshot.planReferences.every(
      (row) => row.contentRef.revisionId === f.second.ref.revisionId,
    ),
  );
  assert.deepEqual(captured.scope, request.capturedLocal.scope);
  assert.equal(Object.isFrozen(captured.snapshot.personal.notes), true);
  assert.equal(f.raw(contentKey()), bytes);
  assert.deepEqual(cookingRows(f), before);
  assert.equal(pending((await f.repository.read(renewed))!).capturedLocal.storeRevision, 1);
  await assert.rejects(f.capture(), reason('operation_pending'));
  const acknowledged = await f.repository.recordAcknowledgement(renewed, acknowledgement(staged));
  const acknowledgedBytes = f.raw(contentKey()),
    afterAck = await recapturePending(f, acknowledged, renewed);
  assert.equal(afterAck.storeRevision, 2);
  assert.deepEqual(afterAck.snapshot, captured.snapshot);
  assert.equal(f.raw(contentKey()), acknowledgedBytes);
});

test('operation-bound guest recapture reads only its newly claimed owner and never rewrites the initial guest archive', async (t) => {
  const f = await fixture(t, { guest: true });
  const request = await f.input(),
    staged = await f.repository.stage(f.scope, request);
  assert.equal(request.capturedLocal.fence.binding, null);
  const archive = f.raw(guestKey()),
    bytes = f.raw(contentKey()),
    before = cookingRows(f);
  const captured = await recapturePending(f, staged);
  assert.equal(captured.fence.binding, ownerId);
  assert.equal(
    canonicalAccountContentSnapshot(captured.snapshot),
    canonicalAccountContentSnapshot(request.capturedLocal.snapshot),
  );
  assert.equal(f.raw(guestKey()), archive);
  assert.equal(f.raw(contentKey()), bytes);
  assert.deepEqual(cookingRows(f), before);
});

test('pending recapture requires the exact persisted operation and fingerprint, never an arbitrary caller flag', async (t) => {
  const f = await fixture(t),
    request = await f.input();
  await assert.rejects(
    f.reader.transaction((session) =>
      captureAccountContentPendingLocal(
        session,
        f.scope,
        { operationId: request.operationId, requestFingerprint: 'a'.repeat(64) },
        f.captureOptions,
      ),
    ),
    reason('operation_changed', 'operation_pending'),
  );
  const staged = await f.repository.stage(f.scope, request),
    active = pending(staged),
    bytes = f.raw(contentKey());
  for (const identity of [
    { operationId: randomUUID(), requestFingerprint: active.requestFingerprint },
    { operationId: active.operationId, requestFingerprint: 'f'.repeat(64) },
  ])
    await assert.rejects(
      recapturePending(f, staged, f.scope, identity),
      reason('operation_changed'),
    );
  assert.equal(f.raw(contentKey()), bytes);
});

test('pending recapture refuses changed consent, a changed legacy journal and pending settings without promoting scope', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input());
  const originalApproval = String(f.raw(accountContentScopeApprovalKey(ownerId))),
    bytes = f.raw(contentKey());
  const changed = await createAccountContentScopeApprovalEvidence(
    {
      schemaVersion: 1,
      ownerId,
      installationId: f.installationId,
      scopeVersion: 3,
      personalApproved: true,
      historyIncluded: true,
      decidedAt: '2026-10-01T13:00:00.000Z',
    },
    sha256,
  );
  f.metadata(accountContentScopeApprovalKey(ownerId), changed);
  await assert.rejects(recapturePending(f, staged), reason('scope_changed'));
  f.db
    .prepare('UPDATE app_metadata SET value=? WHERE key=?')
    .run(originalApproval, accountContentScopeApprovalKey(ownerId));
  f.metadata(journalKey(ownerId), legacyJournal());
  await assert.rejects(recapturePending(f, staged), reason('local_changed'));
  assert.equal(f.raw(journalKey(ownerId)), JSON.stringify(legacyJournal()));
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(journalKey(ownerId));
  f.metadata(ACCOUNT_SETTINGS_KEY, null);
  await assert.rejects(recapturePending(f, staged), reason('settings_pending'));
  assert.equal(f.raw(ACCOUNT_SETTINGS_KEY), 'null');
  assert.equal(f.raw(contentKey()), bytes);
});

test('pending recapture retains strict schema8, installation and current-owner admission', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input()),
    bytes = f.raw(contentKey());
  f.db.exec('PRAGMA user_version=7');
  await assert.rejects(recapturePending(f, staged), reason('stored_data_invalid'));
  f.db.exec('PRAGMA user_version=8');
  f.db.prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'").run(randomUUID());
  await assert.rejects(
    recapturePending(f, staged),
    reason('stored_data_invalid', 'different_data_owner'),
  );
  f.db.prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'").run(f.installationId);
  f.metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId: otherOwnerId });
  f.reads.length = 0;
  await assert.rejects(recapturePending(f, staged), reason('different_data_owner'));
  assert.equal(
    f.reads.some(({ rows }) => rows.includes('Original quantity')),
    false,
  );
  assert.equal(f.raw(contentKey()), bytes);
});

test('pending recapture owns its scope and operation identity before its first await', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input()),
    active = pending(staged);
  const captured = await f.reader.transaction((session) => {
    const scope = { ...f.scope },
      identity = { operationId: active.operationId, requestFingerprint: active.requestFingerprint };
    const work = captureAccountContentPendingLocal(session, scope, identity, f.captureOptions);
    scope.ownerId = otherOwnerId;
    scope.authGeneration = 99;
    identity.operationId = randomUUID();
    identity.requestFingerprint = 'f'.repeat(64);
    return work;
  });
  assert.equal(captured.fence.ownerId, ownerId);
  assert.equal(captured.fence.authGeneration, 1);
  assert.equal(captured.scope.approvalDigest, active.capturedLocal.scope.approvalDigest);
});

test('pending recapture stops after an awaited query or digest loses owner authority', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input()),
    bytes = f.raw(contentKey());
  let readsAtLoss = 0,
    lost = false;
  f.afterRead((sql) => {
    if (!lost && sql === 'PRAGMA user_version') {
      lost = true;
      readsAtLoss = f.reads.length;
      f.setScope(null);
    }
  });
  await assert.rejects(recapturePending(f, staged), reason('account_changed'));
  assert.equal(lost, true);
  assert.equal(f.reads.length, readsAtLoss);
  f.afterRead(undefined);
  f.setScope(f.scope);
  f.afterHash(() => {
    readsAtLoss = f.reads.length;
    f.setScope(null);
  });
  await assert.rejects(recapturePending(f, staged), reason('account_changed'));
  assert.equal(f.reads.length, readsAtLoss);
  assert.equal(f.raw(contentKey()), bytes);
});

test('pending bundle returns the very same schema8 backup and account projection, including current late edits and approved exact history', async (t) => {
  const f = await fixture(t),
    seeded = seedBundleHistory(f);
  await f.approve(true);
  const staged = await f.repository.stage(f.scope, await f.input());
  f.db
    .prepare('UPDATE recipe_note SET text=?,revision=2')
    .run(JSON.stringify('Late bundle note\n量'));
  f.db.exec(
    "UPDATE state_revision SET revision=2 WHERE collection='store'; UPDATE personal_state SET revision=2",
  );
  const before = cookingRows(f),
    metadata = f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all();
  f.reads.length = 0;
  let captureTimes = 0;
  const result = await pendingBundle(f, staged, {
    ...f.captureOptions,
    now: () => {
      captureTimes++;
      return at;
    },
  });
  assert.equal(
    captureTimes,
    1,
    'The envelope must come from the original capture, never a second read',
  );
  assert.equal(
    f.reads.filter(({ sql }) => /FROM plan_occurrence ORDER BY local_date/.test(sql)).length,
    1,
  );
  assert.equal(result.backup.schemaVersion, 3);
  assert.equal(result.backup.databaseSchemaVersion, 8);
  assert.equal(result.backup.sourceRevision, 2);
  assert.equal(result.capture.storeRevision, result.backup.sourceRevision);
  assert.deepEqual(result.capture.snapshot.planReferences, result.backup.data.planReferences);
  assert.equal(result.backup.data.personal.notes[0]!.text, 'Late bundle note\n量');
  assert.equal(result.capture.snapshot.personal.notes[0]!.text, 'Late bundle note\n量');
  assert.equal(result.backup.data.cookingHistory!.entries[0]!.entry.eventId, seeded.event.eventId);
  assert.deepEqual(result.capture.snapshot.cookingHistory!.removedEventIds, [seeded.removedId]);
  const reconstructed = await accountContentSnapshotFromBackup(
    result.backup,
    settings(),
    {
      schemaVersion: 3,
      includeCookingHistory: true,
      removedHistoryEventIds: result.capture.snapshot.cookingHistory!.removedEventIds,
    },
    sha256,
  );
  assert.deepEqual(reconstructed, result.capture.snapshot);
  for (const object of [
    result,
    result.capture,
    result.backup,
    result.backup.data,
    result.backup.data.personal.notes,
    result.backup.data.cookingHistory!.entries[0]!.entry,
  ])
    assert.equal(Object.isFrozen(object), true);
  assert.deepEqual(cookingRows(f), before);
  assert.deepEqual(f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all(), metadata);
  assert.equal(pending(staged).capturedLocal.storeRevision, 1);
});

test('pending history-off bundle omits private history and removal IDs without hydrating them', async (t) => {
  const f = await fixture(t),
    seeded = seedBundleHistory(f);
  const staged = await f.repository.stage(f.scope, await f.input()),
    before = cookingRows(f),
    bytes = f.raw(contentKey());
  f.reads.length = 0;
  const bundle = await pendingBundle(f, staged);
  assert.equal(Object.hasOwn(bundle.backup.data, 'cookingHistory'), false);
  assert.equal(Object.hasOwn(bundle.capture.snapshot, 'cookingHistory'), false);
  assert.equal(bundle.capture.scope.historyIncluded, false);
  const transferred = f.reads.map((row) => row.rows).join('\n');
  for (const privateValue of [
    seeded.event.note,
    seeded.event.eventId,
    seeded.removedId,
    'PRIVATE UNSENT QUESTION',
    'PRIVATE OPERATION RECEIPT',
  ]) {
    assert.equal(transferred.includes(privateValue), false);
    assert.equal(JSON.stringify(bundle).includes(privateValue), false);
  }
  assert.deepEqual(cookingRows(f), before);
  assert.equal(f.raw(contentKey()), bytes);
});

test('pending bundle requires an exact persisted operation and retains settings admission', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input()),
    request = pending(staged),
    bytes = f.raw(contentKey());
  for (const identity of [
    { operationId: randomUUID(), requestFingerprint: request.requestFingerprint },
    { operationId: request.operationId, requestFingerprint: 'f'.repeat(64) },
  ]) {
    f.reads.length = 0;
    await assert.rejects(
      f.reader.transaction((session) =>
        captureAccountContentPendingBundle(session, f.scope, identity, f.captureOptions),
      ),
    );
    assertNoCookingPayloadRead(f);
  }
  f.metadata(ACCOUNT_SETTINGS_KEY, null);
  await assert.rejects(pendingBundle(f, staged), reason('settings_pending'));
  assert.equal(f.raw(contentKey()), bytes);
});

test('pending bundle suppresses both capture and backup after query or hash owner loss, without later private reads', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input()),
    before = cookingRows(f),
    bytes = f.raw(contentKey());
  let readsAtLoss = 0,
    lost = false;
  f.afterRead((sql) => {
    if (!lost && /FROM plan_occurrence ORDER BY local_date/.test(sql)) {
      lost = true;
      readsAtLoss = f.reads.length;
      f.setScope(null);
    }
  });
  await assert.rejects(pendingBundle(f, staged), reason('account_changed'));
  assert.equal(lost, true);
  assert.equal(f.reads.length, readsAtLoss);
  f.afterRead(undefined);
  f.setScope(f.scope);
  f.afterHash(() => {
    readsAtLoss = f.reads.length;
    f.setScope(null);
  });
  await assert.rejects(pendingBundle(f, staged), reason('account_changed'));
  assert.equal(f.reads.length, readsAtLoss);
  assert.deepEqual(cookingRows(f), before);
  assert.equal(f.raw(contentKey()), bytes);
});

test('pending recapture rejects a codec-valid future captured store revision before private data projection', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input()),
    active = pending(staged);
  const capturedLocal = { ...active.capturedLocal, storeRevision: 2 };
  const draft = {
    operationId: active.operationId,
    mode: active.mode,
    capturedLocal,
    remote: active.remote,
    proposed: active.proposed,
  };
  const requestFingerprint = await accountContentPendingFingerprint(
    ownerId,
    f.installationId,
    staged.legacyJournalDigest,
    draft,
    sha256,
  );
  const future = { ...staged, pending: { ...active, capturedLocal, requestFingerprint } };
  const bytes = await serializeAccountContentJournal(future, ownerId, f.installationId, sha256);
  f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(bytes, contentKey());
  f.reads.length = 0;
  await assert.rejects(recapturePending(f, future), reason('stored_data_invalid'));
  assertNoCookingPayloadRead(f);
  await assert.rejects(f.repository.read(f.scope), reason('stored_data_invalid'));
  assert.equal(f.raw(contentKey()), bytes);
});

test('shared journal reads reject a codec-valid settled apply from a future store before private data projection', async (t) => {
  const f = await fixture(t),
    request = await f.input();
  request.remote = { ...request.remote, revision: 1, snapshot: request.proposed, updatedAt: at };
  const staged = await f.repository.stage(f.scope, request);
  const future = {
    ...staged,
    revision: 3,
    base: request.remote,
    pending: null,
    lastApply: {
      ownerId,
      operationId: randomUUID(),
      storeRevision: 2,
      serverRevision: 1,
      appliedAt: at,
      requestFingerprint: 'b'.repeat(64),
    },
  };
  const bytes = await serializeAccountContentJournal(future, ownerId, f.installationId, sha256);
  f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(bytes, contentKey());
  f.reads.length = 0;
  await assert.rejects(recapturePending(f, staged), reason('stored_data_invalid'));
  assertNoCookingPayloadRead(f);
  await assert.rejects(f.repository.read(f.scope), reason('stored_data_invalid'));
  await assert.rejects(f.capture(), reason('stored_data_invalid'));
  assertNoCookingPayloadRead(f);
  assert.equal(f.raw(contentKey()), bytes);
});

test('oversized nonnumeric store revision is rejected without materializing its bytes or cooking payloads', async (t) => {
  const f = await fixture(t),
    staged = await f.repository.stage(f.scope, await f.input()),
    bytes = f.raw(contentKey());
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db
    .prepare("UPDATE state_revision SET revision=?||hex(zeroblob(32768)) WHERE collection='store'")
    .run('BROKEN_STORE_CLOCK:');
  f.db.exec('PRAGMA ignore_check_constraints=OFF');
  f.reads.length = 0;
  await assert.rejects(recapturePending(f, staged), reason('stored_data_invalid'));
  assertNoCookingPayloadRead(f);
  assert.equal(
    f.reads.some(({ rows }) => rows.includes('BROKEN_STORE_CLOCK:')),
    false,
  );
  assert.equal(
    f.reads.some(({ rows }) => rows.length > 64000),
    false,
  );
  await assert.rejects(f.repository.read(f.scope), reason('stored_data_invalid'));
  assert.equal(f.raw(contentKey()), bytes);
});

test('a new raw push cannot stage an arbitrary proposal or claim a guest binding without repository-issued approval', async (t) => {
  const f = await fixture(t, { guest: true });
  const request = await f.input({ mode: 'push' });
  request.proposed = clone(request.proposed);
  request.proposed.profile.displayName = 'Unreviewed arbitrary upload';
  const before = cookingRows(f);
  await assert.rejects(f.repository.stage(f.scope, request), reason('recovery_required'));
  await assert.rejects(
    Reflect.apply(f.repository.stage, undefined, [
      f.scope,
      request,
      { approved: true, proposed: request.proposed },
    ]),
    reason('recovery_required'),
  );
  assert.equal(f.raw(contentKey()), undefined);
  assert.equal(f.raw(guestKey()), undefined);
  assert.equal(f.raw(ACCOUNT_BINDING_KEY), undefined);
  assert.deepEqual(cookingRows(f), before);
});

test('push comparison snapshots retain the exact captured sides, remain frozen and represent an empty account as null', async (t) => {
  const f = await fixture(t),
    request = await f.input({ mode: 'push' });
  assert.ok(request.remote.snapshot);
  request.remote.snapshot = clone(request.remote.snapshot);
  const accountFirst = request.remote.snapshot.planReferences.find(
    (item) => item.contentRef.revisionId === f.first.ref.revisionId,
  );
  assert.ok(accountFirst);
  accountFirst.contentRef = clone(f.second.ref);
  request.remote.snapshot.personal.notes[0]!.text = 'Account-only reviewed note';
  const expectedAccount = clone(request.remote.snapshot);
  const review = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote: request.remote,
  });
  assert.deepEqual(review.comparison.local, request.capturedLocal.snapshot);
  assert.deepEqual(review.comparison.account, expectedAccount);
  assert.notDeepEqual(
    review.comparison.local.planReferences,
    review.comparison.account!.planReferences,
  );
  assert.notDeepEqual(
    review.comparison.local.personal.notes,
    review.comparison.account!.personal.notes,
  );
  assert.ok(Object.isFrozen(review.comparison));
  assert.ok(Object.isFrozen(review.comparison.local.personal.notes[0]));
  assert.ok(Object.isFrozen(review.comparison.account!.planReferences[0]!.contentRef));
  assert.equal(
    Reflect.set(review.comparison.account!.personal.notes[0]!, 'text', 'Attempted alteration'),
    false,
  );
  request.remote.snapshot.personal.notes[0]!.text = 'Caller changed after review';
  accountFirst.contentRef = clone(f.first.ref);
  assert.deepEqual(review.comparison.account, expectedAccount);
  const empty = await f.repository.reviewPush(f.scope, {
    operationId: randomUUID(),
    remote: { ownerId, revision: 0, snapshot: null, updatedAt: null, deletionOperationId: null },
  });
  assert.equal(empty.comparison.account, null);
  assert.deepEqual(empty.comparison.local, request.capturedLocal.snapshot);
  assert.equal(f.raw(contentKey()), undefined);
});

test('push reviews are exact repository capabilities, require initial import review, and reject clone, peer and old-generation use', async (t) => {
  const f = await fixture(t),
    request = await f.input({ mode: 'push' });
  const review = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote: request.remote,
  });
  assert.equal(review.initialImportRequired, true);
  assert.equal(review.merge.status, 'merged');
  assert.deepEqual(review.removalReview!.conflicts, []);
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.merge));
  await assert.rejects(
    f.repository.stageReviewedPush(f.scope, review, { initialImportReviewed: false }),
    reason('initial_review_required'),
  );
  await assert.rejects(
    f.repository.stageReviewedPush(f.scope, clone(review), { initialImportReviewed: true }),
    reason('local_changed'),
  );
  const peer = f.create();
  try {
    await assert.rejects(
      peer.stageReviewedPush(f.scope, review, { initialImportReviewed: true }),
      reason('local_changed'),
    );
  } finally {
    peer.close();
  }
  const renewed = { ...f.scope, authGeneration: 2 };
  f.setScope(renewed);
  await assert.rejects(
    f.repository.stageReviewedPush(renewed, review, { initialImportReviewed: true }),
    reason('local_changed'),
  );
  assert.equal(f.raw(contentKey()), undefined);
});

for (const choice of ['keep_local', 'save_account_version'] as const) {
  test(`reviewed push requires and binds ${choice} for a removed favourite before creating network work`, async (t) => {
    const f = await fixture(t, { guest: true });
    f.db.exec('UPDATE favourite SET saved=0');
    const request = await f.input({ mode: 'push' });
    assert.ok(request.remote.snapshot);
    request.remote.snapshot.favourites = [{ recipeId: f.first.ref.recipeId, savedAt: at }];
    const review = await f.repository.reviewPush(f.scope, {
      operationId: request.operationId,
      remote: request.remote,
    });
    assert.ok(review.removalReview);
    const conflict = review.removalReview.conflicts[0]!;
    assert.equal(conflict.kind, 'favourite');
    await assert.rejects(
      f.repository.stageReviewedPush(f.scope, review, { initialImportReviewed: true }),
      reason('invalid_input'),
    );
    assert.equal(f.raw(ACCOUNT_BINDING_KEY), undefined);
    assert.equal(f.raw(contentKey()), undefined);
    assert.equal(f.raw(guestKey()), undefined);
    const selected = { initialImportReviewed: true, removalChoices: { [conflict.id]: choice } };
    const result = await f.repository.stageReviewedPush(f.scope, review, selected);
    assert.equal(pending(result).mode, 'push');
    assert.deepEqual(
      pending(result).proposed.favourites,
      choice === 'keep_local' ? [] : request.remote.snapshot.favourites,
    );
    assert.equal(f.db.prepare('SELECT saved FROM favourite').get()!.saved, 0);
    assert.deepEqual(await f.repository.stageReviewedPush(f.scope, review, selected), result);
    await assert.rejects(
      f.repository.stageReviewedPush(f.scope, review, {
        initialImportReviewed: true,
        removalChoices: {
          [conflict.id]: choice === 'keep_local' ? 'save_account_version' : 'keep_local',
        },
      }),
      reason('operation_changed'),
    );
    assert.doesNotMatch(
      String(f.raw(contentKey())),
      /removalReview|exactFavouriteRemoval|savedRevision/,
    );
  });
}

test('reviewed push fences every capture clock and archive presence before staging', async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    () => f.db.exec("UPDATE state_revision SET revision=revision+1 WHERE collection='store'"),
    () => f.db.exec('UPDATE personal_state SET revision=revision+1'),
    () => f.db.exec('UPDATE cooking_state SET history_epoch=history_epoch+1'),
    () => changeAdoption(f),
    () =>
      f.db
        .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
        .run(randomUUID(), 'b'.repeat(64), '{}', '{}', '{}'),
    () => f.setSettings({ ...settings(), profile: { displayName: 'Changed after push review' } }),
  ]) {
    const request = await f.input({ mode: 'push' });
    const review = await f.repository.reviewPush(f.scope, {
      operationId: request.operationId,
      remote: request.remote,
    });
    mutate();
    await assert.rejects(
      f.repository.stageReviewedPush(f.scope, review, { initialImportReviewed: true }),
      reason('local_changed', 'scope_changed', 'settings_changed'),
    );
    assert.equal(f.raw(contentKey()), undefined);
  }
});

test('same-clock favourite removal changes invalidate the opaque resolution inside push staging', async (t) => {
  const f = await fixture(t);
  f.db.exec('UPDATE favourite SET saved=0');
  const request = await f.input({ mode: 'push' });
  assert.ok(request.remote.snapshot);
  request.remote.snapshot.favourites = [{ recipeId: f.first.ref.recipeId, savedAt: at }];
  const review = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote: request.remote,
  });
  assert.ok(review.removalReview);
  f.db.prepare('UPDATE favourite SET updated_at=?').run('2026-10-01T13:00:00.000Z');
  await assert.rejects(
    f.repository.stageReviewedPush(f.scope, review, {
      initialImportReviewed: true,
      removalChoices: { [review.removalReview.conflicts[0]!.id]: 'save_account_version' },
    }),
    reason('local_changed'),
  );
  assert.equal(f.raw(contentKey()), undefined);
});

test('preference revival is reviewed before push and guessed choices cannot authorize a newly exposed conflict', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID();
  const request = await f.input({ mode: 'push' });
  assert.ok(request.remote.snapshot);
  request.remote.snapshot.preferences = [{ preferenceId, type: 'cuisine', value: 'Original' }];
  await seedSettledContentBase(f, request.remote);
  f.db
    .prepare('INSERT INTO saved_preference VALUES (?,?,?,1)')
    .run(preferenceId, 'cuisine', JSON.stringify('Local replacement'));
  f.db.exec(
    "UPDATE preference_state SET last_removal_revision=1;UPDATE state_revision SET revision=1 WHERE collection='preferences'",
  );
  const remote = clone(request.remote);
  remote.revision = 2;
  assert.ok(remote.snapshot);
  remote.snapshot.preferences[0]!.value = 'Account replacement';
  const unresolved = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote,
  });
  assert.equal(unresolved.initialImportRequired, false);
  assert.equal(unresolved.merge.status, 'needs_review');
  assert.equal(unresolved.removalReview, null);
  if (unresolved.merge.status !== 'needs_review')
    assert.fail('Expected ordinary preference conflict');
  const resolutions = Object.fromEntries(
    unresolved.merge.conflicts.map((row) => [row.id, 'account' as const]),
  );
  await assert.rejects(
    f.repository.stageReviewedPush(f.scope, unresolved, {
      initialImportReviewed: false,
      resolutions,
      removalChoices: { [`preference:${preferenceId}`]: 'save_account_version' },
    }),
    reason('recovery_required'),
  );
  const review = await f.repository.reviewPush(
    f.scope,
    { operationId: request.operationId, remote },
    resolutions,
  );
  assert.ok(review.removalReview);
  assert.deepEqual(review.removalReview.conflicts[0]!.reasons, ['unidentifiedPreferenceRemoval']);
  const result = await f.repository.stageReviewedPush(f.scope, review, {
    initialImportReviewed: false,
    removalChoices: { [`preference:${preferenceId}`]: 'keep_local' },
  });
  assert.deepEqual(pending(result).proposed.preferences, [
    { preferenceId, type: 'cuisine', value: 'Local replacement' },
  ]);
});

test('reviewed push uses the actual accepted base so unchanged remote favourites do not revive a local removal', async (t) => {
  const f = await fixture(t),
    request = await f.input({ mode: 'push' });
  await seedSettledContentBase(f, request.remote);
  f.db.exec('UPDATE favourite SET saved=0');
  const review = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote: request.remote,
  });
  assert.equal(review.initialImportRequired, false);
  assert.equal(review.merge.status, 'merged');
  assert.deepEqual(review.removalReview!.conflicts, []);
  const result = await f.repository.stageReviewedPush(f.scope, review, {
    initialImportReviewed: false,
  });
  assert.deepEqual(pending(result).proposed.favourites, []);
  assert.deepEqual(result.base, request.remote);
});

test('push review owns remote evidence before waits and never accepts a caller-supplied alternative proposal', async (t) => {
  const f = await fixture(t),
    request = await f.input({ mode: 'push' });
  const original = clone(request.remote);
  f.afterHash(() => {
    request.remote.revision = 9;
    request.remote.snapshot!.profile.displayName = 'Late mutable remote';
  });
  const review = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote: request.remote,
  });
  const result = await f.repository.stageReviewedPush(f.scope, review, {
    initialImportReviewed: true,
  });
  assert.deepEqual(pending(result).remote, original);
  assert.notEqual(pending(result).proposed.profile.displayName, 'Late mutable remote');
  await assert.rejects(
    f.repository.stage(f.scope, {
      ...request,
      proposed: { ...request.proposed, profile: { displayName: 'Alternative' } },
    }),
    reason('operation_changed'),
  );
});

test('push history opt-out retains only exact remote history metadata and no device history is uploaded', async (t) => {
  const f = await fixture(t);
  const localHistory = seedBundleHistory(f);
  const request = await f.input({ mode: 'push' });
  assert.ok(request.remote.snapshot);
  request.remote.snapshot.cookingHistory = { entries: [], removedEventIds: [randomUUID()] };
  const review = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote: request.remote,
  });
  const result = await f.repository.stageReviewedPush(f.scope, review, {
    initialImportReviewed: true,
  });
  assert.equal(Object.hasOwn(pending(result).capturedLocal.snapshot, 'cookingHistory'), false);
  assert.deepEqual(pending(result).proposed.cookingHistory, request.remote.snapshot.cookingHistory);
  assert.equal(
    JSON.stringify(pending(result).proposed).includes(localHistory.event.eventId),
    false,
  );
});

test('lost reviewed-push COMMIT acknowledgement recovers and allows only exact retained raw replay after reopen', async (t) => {
  const f = await fixture(t),
    request = await f.input({ mode: 'push' });
  const review = await f.repository.reviewPush(f.scope, {
    operationId: request.operationId,
    remote: request.remote,
  });
  f.afterCommit(() => {
    throw new Error('fixture lost reviewed push ACK');
  });
  const staged = await f.repository.stageReviewedPush(f.scope, review, {
    initialImportReviewed: true,
  });
  assert.equal(f.writer.requiresRecovery(), true);
  await f.reopen();
  assert.deepEqual(await f.repository.stage(f.scope, request), staged);
  await assert.rejects(
    f.repository.stage(f.scope, {
      ...request,
      proposed: { ...request.proposed, profile: { displayName: 'Different after reopen' } },
    }),
    reason('operation_changed'),
  );
  const ack = acknowledgement(staged);
  assert.deepEqual(
    pending(await f.repository.recordAcknowledgement(f.scope, ack)).acknowledgement,
    ack.receipt,
  );
});
