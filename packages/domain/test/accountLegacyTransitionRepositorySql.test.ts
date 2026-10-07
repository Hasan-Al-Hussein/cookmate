import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  AccountReplicationError,
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
  type AccountReplicationJournal,
  type AccountReplicationScope,
  type AccountSnapshotOptions,
  type AccountSnapshotV2,
} from '@cookmate/account-sync';
import { createAccountContentScopeApprovalEvidence } from '../../account-sync/src/contentScope';
import { cookingContentIdentity } from '../src/cooking';
import {
  createAccountLegacyTransitionRepository,
  type AccountLegacyTransitionChoices,
} from '../../../apps/mobile/src/data/accountLegacyTransitionRepository';
import { accountLegacyContentTransitionKey } from '../../../apps/mobile/src/data/accountLegacyTransitionKeys';
import { readAccountContentJournalState } from '../../../apps/mobile/src/data/accountContentJournalStorage';
import {
  accountContentScopeApprovalKey,
  createAccountContentScopeApprovalService,
} from '../../../apps/mobile/src/data/accountContentScopeApproval';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_SETTINGS_KEY,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Actual disposable schema8 SQLite and issued scope/review services. Server acknowledgements
// are controlled transport evidence; no hosted HTTP, authentication or content-trust claim.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z',
  serverAt = '2026-10-01T12:00:00.123456+00:00',
  committedAt = '2026-10-01T12:01:00.654321+00:00';
const failure =
  (...expected: string[]) =>
  (error: unknown) =>
    error instanceof AccountReplicationError && expected.includes(error.reason);
const copy = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const choice: AccountLegacyTransitionChoices = { initialImportReviewed: false };

async function fixture(t: TestContext, historyIncluded = false) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-legacy-transition-repository-'));
  const path = join(directory, 'repository.db');
  let write = desktopConnection(path),
    read = desktopConnection(path),
    queue = new SqlTransactionQueue();
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  let writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  const installationId = randomUUID(),
    recipe = catalogue.recipes[0]!;
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
  const metadata = (key: string, value: unknown) =>
    write.database
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId });
  let settings: AccountSnapshotOptions = {
    appPreferences: { theme: 'dark', motion: 'system', locale: 'en' },
    profile: { displayName: null },
  };
  const original = emptyAccountSnapshot(catalogue.identity, settings);
  const occurrenceId = randomUUID();
  original.plan = [
    {
      occurrenceId,
      recipeId: recipe.recipeId,
      placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
      createdAt: at,
      updatedAt: at,
    },
  ];
  write.database
    .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
    .run(occurrenceId, recipe.recipeId, '2026-10-01', 'dinner', at, at);
  write.database.exec("UPDATE state_revision SET revision=1 WHERE collection='store'");
  const remote = {
    ownerId,
    revision: 4,
    snapshot: original,
    updatedAt: serverAt,
    deletionOperationId: null,
  };
  const old: AccountReplicationJournal = {
    schemaVersion: 1,
    ownerId,
    revision: 1,
    base: copy(remote),
    observed: {
      revision: 4,
      snapshotDigest: await sha256(canonicalAccountSnapshot(original)),
      updatedAt: serverAt,
    },
    pending: null,
    lastApply: {
      ownerId,
      operationId: randomUUID(),
      storeRevision: 1,
      serverRevision: 4,
      appliedAt: at,
    },
  };
  metadata(journalKey(ownerId), old);
  await migrateCookingContentDatabase(writer, { sha256 });
  await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const scope: AccountReplicationScope = { ownerId, authGeneration: 1 };
  let current: AccountReplicationScope | null = { ...scope };
  let hashEffect: ((text: string) => void) | undefined,
    writeEffect: ((sql: string, values: readonly SqlValue[]) => void) | undefined,
    commitEffect: (() => void) | undefined,
    observerEffect: (() => void) | undefined,
    readEffect: ((sql: string) => void) | undefined,
    prepareEffect: (() => void) | undefined;
  const ids: string[] = [],
    readSql: string[] = [];
  const options = {
    installationId,
    catalogue: catalogue.identity,
    currentScope: () => current,
    getLocalSettings: () => settings,
    now: () => at,
    sha256: async (text: string) => {
      const digest = await sha256(text);
      const effect = hashEffect;
      hashEffect = undefined;
      effect?.(text);
      return digest;
    },
    newId: () => {
      const id = randomUUID();
      ids.push(id);
      return id;
    },
  };
  function hooks() {
    for (const connection of [write.connection, read.connection]) {
      const all = connection.all;
      connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
        const result = await all<Row>(sql, values);
        readSql.push(sql);
        readEffect?.(sql);
        return result;
      };
    }
    const prepare = write.connection.prepare,
      exec = write.connection.exec;
    write.connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      const effect = prepareEffect;
      prepareEffect = undefined;
      effect?.();
      return {
        ...statement,
        run: async (values) => {
          await statement.run(values);
          writeEffect?.(sql, values);
        },
      };
    };
    write.connection.exec = async (sql) => {
      await exec(sql);
      if (sql === 'COMMIT') {
        const effect = commitEffect;
        commitEffect = undefined;
        effect?.();
      }
    };
    writer.setObserver({
      begin: async () => {},
      beforeCommit: async () => {
        const effect = observerEffect;
        observerEffect = undefined;
        effect?.();
      },
      committed: async () => {},
      failed: () => {},
    });
  }
  hooks();
  const approval = createAccountContentScopeApprovalService({ ...options, reader, writer });
  try {
    const review = await approval.review(scope);
    await approval.approve(scope, review, { historyIncluded });
  } finally {
    approval.close();
  }
  const create = () => createAccountLegacyTransitionRepository({ ...options, reader, writer });
  let repository = create();
  t.after(async () => {
    repository.close();
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  return {
    get db() {
      return write.database;
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
    scope,
    old,
    remote,
    recipe,
    installationId,
    metadata,
    create,
    options,
    ids,
    readSql,
    identity(value: { networkOperationId: string; requestFingerprint: string }) {
      return {
        operationId: value.networkOperationId,
        requestFingerprint: value.requestFingerprint,
      };
    },
    receipt(value: { networkOperationId: string; remote: { revision: number } }) {
      return {
        ownerId,
        operationId: value.networkOperationId,
        revision: value.remote.revision + 1,
        committedAt,
      };
    },
    setScope(value: AccountReplicationScope | null) {
      current = value;
    },
    setSettings(value: AccountSnapshotOptions) {
      settings = value;
    },
    hash(effect: (text: string) => void) {
      hashEffect = effect;
    },
    afterWrite(effect: (sql: string, values: readonly SqlValue[]) => void) {
      writeEffect = effect;
    },
    afterCommit(effect: () => void) {
      commitEffect = effect;
    },
    afterObserver(effect: () => void) {
      observerEffect = effect;
    },
    afterPrepare(effect: () => void) {
      prepareEffect = effect;
    },
    clearHooks() {
      hashEffect = undefined;
      writeEffect = undefined;
      readEffect = undefined;
      observerEffect = undefined;
      prepareEffect = undefined;
    },
    async readContent() {
      return reader.transaction(
        (session) => readAccountContentJournalState(session, ownerId, sha256),
        { kind: 'read_only' },
      );
    },
    async reopen() {
      repository.close();
      await reader.close();
      await writer.close();
      write = desktopConnection(path);
      read = desktopConnection(path);
      await configureConnection(write.connection);
      await configureConnection(read.connection);
      await read.connection.exec('PRAGMA query_only=ON');
      queue = new SqlTransactionQueue();
      writer = new SerializedWriter(write.connection, queue);
      reader = new SerializedReader(read.connection, queue);
      hooks();
      repository = create();
    },
    statementCounts: () => write.statementCounts(),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function staged(f: Fixture) {
  const review = await f.repository.review(f.scope, f.remote);
  return f.repository.stage(f.scope, review, choice);
}
async function acknowledged(f: Fixture) {
  const value = await staged(f);
  return f.repository.recordAcknowledgement(f.scope, {
    ...f.identity(value),
    receipt: f.receipt(value),
  });
}

test('issued review stages one exact transition and true acknowledgement atomically hands off without cooking writes', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare('UPDATE conversation SET composer_draft=?')
    .run(JSON.stringify('PRIVATE UNSENT DRAFT'));
  const before = {
    plan: f.db.prepare('SELECT * FROM plan_occurrence').all(),
    cooking: f.db.prepare('SELECT * FROM cooking_state').all(),
    history: f.db.prepare('SELECT * FROM cooking_event').all(),
    receipts: f.db.prepare('SELECT * FROM operation_receipt').all(),
    conversation: f.db.prepare('SELECT * FROM conversation').all(),
    old: f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!.value,
  };
  const review = await f.repository.review(f.scope, f.remote);
  assert.deepEqual(Object.keys(review).sort(), [
    'initialImportRequired',
    'merge',
    'removalReview',
    'reviewId',
  ]);
  assert.ok(Object.isFrozen(review) && Object.isFrozen(review.merge));
  assert.equal(review.initialImportRequired, false);
  const value = await f.repository.stage(f.scope, review, choice),
    wanted = f.identity(value);
  assert.notEqual(value.networkOperationId, value.localApplyOperationId);
  assert.equal(value.lastApply, null);
  await assert.rejects(f.repository.handoff(f.scope, wanted), failure('acknowledgement_required'));
  const ack = await f.repository.recordAcknowledgement(f.scope, {
    ...wanted,
    receipt: f.receipt(value),
  });
  assert.equal(ack.acknowledgement!.committedAt, committedAt);
  const handed = await f.repository.handoff(f.scope, wanted),
    journal = (await f.readContent()).journal!;
  assert.equal(journal.base, null);
  assert.equal(journal.lastApply, null);
  assert.equal(journal.pending!.mode, 'pull');
  assert.equal(journal.pending!.operationId, value.localApplyOperationId);
  assert.equal(journal.pending!.requestFingerprint, handed.handoff!.requestFingerprint);
  assert.deepEqual(journal.pending!.capturedLocal, value.capturedLocal);
  assert.deepEqual(journal.pending!.remote.snapshot, value.proposed);
  assert.equal(journal.pending!.remote.revision, value.remote.revision + 1);
  assert.deepEqual(
    {
      plan: f.db.prepare('SELECT * FROM plan_occurrence').all(),
      cooking: f.db.prepare('SELECT * FROM cooking_state').all(),
      history: f.db.prepare('SELECT * FROM cooking_event').all(),
      receipts: f.db.prepare('SELECT * FROM operation_receipt').all(),
      conversation: f.db.prepare('SELECT * FROM conversation').all(),
      old: f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!
        .value,
    },
    before,
  );
});

test('only exact issued reviews can stage; remote input is detached and forged or cross-repository tokens fail', async (t) => {
  const f = await fixture(t),
    original = copy(f.remote);
  f.hash(() => {
    f.remote.snapshot.profile.displayName = 'caller tampered';
  });
  const review = await f.repository.review(f.scope, f.remote);
  await assert.rejects(f.repository.stage(f.scope, copy(review), choice), failure('local_changed'));
  const other = f.create();
  try {
    await assert.rejects(other.stage(f.scope, review, choice), failure('local_changed'));
  } finally {
    other.close();
  }
  const saved = await f.repository.stage(f.scope, review, choice);
  assert.deepEqual(saved.remote, original);
});

test('stage binds exact choices once, retries stable IDs and never treats a different retained choice as success', async (t) => {
  const f = await fixture(t),
    review = await f.repository.review(f.scope, f.remote),
    beforeIds = f.ids.length;
  const first = await f.repository.stage(f.scope, review, choice),
    bytes = f.db
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get(accountLegacyContentTransitionKey(ownerId))!.value;
  const second = await f.repository.stage(f.scope, review, choice);
  assert.deepEqual(second, first);
  assert.equal(f.ids.length, beforeIds + 2);
  assert.equal(
    f.db
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get(accountLegacyContentTransitionKey(ownerId))!.value,
    bytes,
  );
  await assert.rejects(
    f.repository.stage(f.scope, review, { initialImportReviewed: true }),
    failure('operation_changed'),
  );
  await assert.rejects(
    f.repository.stage(f.scope, review, {
      initialImportReviewed: false,
      resolutions: { arbitrary: 'local' },
    }),
    failure('operation_changed'),
  );
  await f.reopen();
  assert.deepEqual(await f.repository.recover(f.scope, f.identity(first)), first);
});

test('same-owner generation replacement invalidates issued review but preserves explicit durable recovery', async (t) => {
  const f = await fixture(t),
    review = await f.repository.review(f.scope, f.remote),
    value = await f.repository.stage(f.scope, review, choice);
  const current = { ownerId, authGeneration: 2 };
  f.setScope(current);
  await assert.rejects(f.repository.stage(current, review, choice), failure('local_changed'));
  assert.deepEqual(await f.repository.recover(current, f.identity(value)), value);
  await assert.rejects(
    f.repository.recover(current, { ...f.identity(value), requestFingerprint: '0'.repeat(64) }),
    failure('operation_changed'),
  );
});

test('late local edits reject pre-stage review but remain local after handoff with original captured state', async (t) => {
  const f = await fixture(t),
    review = await f.repository.review(f.scope, f.remote);
  f.db.prepare('UPDATE plan_occurrence SET local_date=?,revision=2').run('2026-10-02');
  f.db.exec("UPDATE state_revision SET revision=2 WHERE collection='store'");
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('local_changed'));
  assert.equal(await f.repository.read(f.scope), null);
  const currentReview = await f.repository.review(f.scope, f.remote),
    value = await f.repository.stage(f.scope, currentReview, choice);
  f.db.prepare('UPDATE plan_occurrence SET local_date=?,revision=3').run('2026-10-03');
  f.db.exec("UPDATE state_revision SET revision=3 WHERE collection='store'");
  await f.repository.recordAcknowledgement(f.scope, {
    ...f.identity(value),
    receipt: f.receipt(value),
  });
  await f.repository.handoff(f.scope, f.identity(value));
  const journal = (await f.readContent()).journal!;
  assert.equal(journal.pending!.capturedLocal.snapshot.plan[0]!.placement.actualDate, '2026-10-02');
  assert.equal(
    f.db.prepare('SELECT local_date FROM plan_occurrence').get()!.local_date,
    '2026-10-03',
  );
});

test('base-null import requires a separate affirmative review without persisting a fabricated merge ancestor', async (t) => {
  const f = await fixture(t);
  f.old.base = null;
  f.old.lastApply = null;
  f.metadata(journalKey(ownerId), f.old);
  const review = await f.repository.review(f.scope, f.remote);
  assert.equal(review.initialImportRequired, true);
  await assert.rejects(
    f.repository.stage(f.scope, review, choice),
    failure('initial_review_required'),
  );
  const value = await f.repository.stage(f.scope, review, { initialImportReviewed: true });
  assert.equal(value.legacy.base, null);
  assert.equal(value.legacy.baseProjectionDigest, null);
  assert.equal(value.lastApply, null);
});

test('personal removed-versus-live conflicts require exact separate choices; retained alternatives cannot reuse a staged result', async (t) => {
  const f = await fixture(t),
    noteId = randomUUID();
  f.db
    .prepare('INSERT INTO recipe_note VALUES (?,?,NULL,1,1,?,?)')
    .run(noteId, f.recipe.recipeId, at, at);
  f.db.exec('UPDATE personal_state SET revision=1');
  const source: AccountSnapshotV2 = {
    ...f.remote.snapshot,
    schemaVersion: 2,
    personal: {
      notes: [
        {
          noteId,
          recipeId: f.recipe.recipeId,
          text: 'Server retained live note',
          deleted: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
      collections: [],
      memberships: [],
      manualItems: [],
    },
  };
  const remote = { ...f.remote, revision: 5, snapshot: source };
  const review = await f.repository.review(f.scope, remote);
  assert.equal(review.merge.status, 'needs_review');
  if (review.merge.status !== 'needs_review') assert.fail('expected a removal conflict');
  const resolutions = Object.fromEntries(
    review.merge.conflicts.map((conflict) => [conflict.id, 'local' as const]),
  );
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('invalid_input'));
  const value = await f.repository.stage(f.scope, review, {
    initialImportReviewed: false,
    resolutions,
  });
  assert.equal(value.proposed.personal.notes[0]!.deleted, true);
  await assert.rejects(
    f.repository.stage(f.scope, review, {
      initialImportReviewed: false,
      resolutions: Object.fromEntries(
        Object.keys(resolutions).map((key) => [key, 'account' as const]),
      ),
    }),
    failure('operation_changed'),
  );
});

test('history opt-out preserves converted remote history and never uploads device history', async (t) => {
  const f = await fixture(t),
    eventId = randomUUID();
  const source: AccountSnapshotV2 = {
    ...f.remote.snapshot,
    schemaVersion: 2,
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
    cookingHistory: {
      entries: [
        {
          ...(await cookingContentIdentity(f.recipe, catalogue.identity, sha256)),
          eventId,
          recipeTitle: f.recipe.title,
          photoKey: f.recipe.photoKey,
          cookedOn: '2026-10-01',
          timeZone: 'Asia/Dubai',
          recordedAt: at,
          note: 'Private existing account history',
        },
      ],
      removedEventIds: [randomUUID()],
    },
  };
  const review = await f.repository.review(f.scope, { ...f.remote, revision: 5, snapshot: source });
  const value = await f.repository.stage(f.scope, review, choice);
  assert.equal(Object.hasOwn(value.capturedLocal.snapshot, 'cookingHistory'), false);
  assert.equal(value.proposed.cookingHistory!.entries[0]!.entry.eventId, eventId);
  assert.deepEqual(
    value.proposed.cookingHistory!.removedEventIds,
    source.cookingHistory!.removedEventIds,
  );
});

test('acknowledgement is exact and idempotent; conflicting identity or receipt never alters the retained operation', async (t) => {
  const f = await fixture(t),
    value = await staged(f),
    wanted = f.identity(value),
    receipt = f.receipt(value);
  for (const patch of [
    { operationId: randomUUID() },
    { revision: receipt.revision + 1 },
    { committedAt: '2026-10-01T16:00:00+04:00' },
    { ownerId: otherOwner },
  ])
    await assert.rejects(
      f.repository.recordAcknowledgement(f.scope, { ...wanted, receipt: { ...receipt, ...patch } }),
      failure('invalid_input'),
    );
  const ack = await f.repository.recordAcknowledgement(f.scope, { ...wanted, receipt });
  assert.deepEqual(await f.repository.recordAcknowledgement(f.scope, { ...wanted, receipt }), ack);
  await assert.rejects(
    f.repository.recordAcknowledgement(f.scope, {
      ...wanted,
      receipt: { ...receipt, committedAt: at },
    }),
    failure('operation_changed'),
  );
  assert.deepEqual(await f.repository.recover(f.scope, wanted), ack);
});

test('scope and pending settings gates block mutation while inspection remains available', async (t) => {
  const f = await fixture(t),
    value = await staged(f),
    wanted = f.identity(value);
  const prior = f.db
    .prepare('SELECT value FROM app_metadata WHERE key=?')
    .get(accountContentScopeApprovalKey(ownerId))!.value;
  assert.ok(typeof prior === 'string');
  const changed = await createAccountContentScopeApprovalEvidence(
    {
      schemaVersion: 1,
      ownerId,
      installationId: f.installationId,
      scopeVersion: 3,
      personalApproved: true,
      historyIncluded: true,
      decidedAt: at,
    },
    sha256,
  );
  f.metadata(accountContentScopeApprovalKey(ownerId), changed);
  await assert.rejects(
    f.repository.recordAcknowledgement(f.scope, { ...wanted, receipt: f.receipt(value) }),
    failure('scope_changed'),
  );
  f.db
    .prepare('UPDATE app_metadata SET value=? WHERE key=?')
    .run(prior, accountContentScopeApprovalKey(ownerId));
  const ack = await f.repository.recordAcknowledgement(f.scope, {
    ...wanted,
    receipt: f.receipt(value),
  });
  f.metadata(ACCOUNT_SETTINGS_KEY, null);
  await assert.rejects(f.repository.handoff(f.scope, wanted), failure('settings_pending'));
  assert.deepEqual(await f.repository.read(f.scope), ack);
});

test('active direct or assistant work and unresolved settled commands block new transition metadata', async (t) => {
  const f = await fixture(t),
    review = await f.repository.review(f.scope, f.remote),
    intentId = randomUUID(),
    operationId = randomUUID();
  f.db.prepare('INSERT INTO pending_intent VALUES (?,0,?,?)').run(intentId, 'ready', '{}');
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('active_actions'));
  f.db.prepare("UPDATE pending_intent SET phase='settled'").run();
  f.db
    .prepare('INSERT INTO command_slot VALUES (?,?,0,?,?)')
    .run(randomUUID(), intentId, operationId, '{}');
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('recovery_required'));
  f.db.prepare('INSERT INTO direct_command_recovery(operation_id) VALUES (?)').run(operationId);
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('active_actions'));
  assert.equal(await f.repository.read(f.scope), null);
});

test('failed second handoff write rolls both linked records back and exact retry reuses IDs', async (t) => {
  const f = await fixture(t),
    ack = await acknowledged(f),
    wanted = f.identity(ack);
  f.afterWrite((sql, values) => {
    if (
      sql.startsWith('INSERT INTO app_metadata') &&
      values[0] === accountLegacyContentTransitionKey(ownerId)
    )
      throw new Error('fixture sidecar link failure');
  });
  await assert.rejects(f.repository.handoff(f.scope, wanted), /fixture sidecar link failure/);
  assert.equal((await f.readContent()).journal, null);
  assert.deepEqual(await f.repository.read(f.scope), ack);
  f.clearHooks();
  const linked = await f.repository.handoff(f.scope, wanted);
  assert.equal(linked.localApplyOperationId, ack.localApplyOperationId);
});

test('lost stage COMMIT acknowledgement recovers exact durable identities then reopens without a new review', async (t) => {
  const f = await fixture(t),
    review = await f.repository.review(f.scope, f.remote);
  f.afterCommit(() => {
    throw new Error('fixture lost stage ACK');
  });
  const value = await f.repository.stage(f.scope, review, choice);
  await f.reopen();
  assert.deepEqual(await f.repository.recover(f.scope, f.identity(value)), value);
});

test('lost acknowledgement and two-key handoff COMMIT replies recover only matching durable phases', async (t) => {
  const f = await fixture(t),
    value = await staged(f),
    wanted = f.identity(value);
  f.afterCommit(() => {
    throw new Error('fixture lost ACK write reply');
  });
  const ack = await f.repository.recordAcknowledgement(f.scope, {
    ...wanted,
    receipt: f.receipt(value),
  });
  await f.reopen();
  assert.ok(ack.acknowledgement);
  f.afterCommit(() => {
    throw new Error('fixture lost handoff reply');
  });
  const handed = await f.repository.handoff(f.scope, wanted);
  await f.reopen();
  assert.deepEqual(await f.repository.recover(f.scope, wanted), handed);
  assert.equal(
    (await f.readContent()).journal!.pending!.requestFingerprint,
    handed.handoff!.requestFingerprint,
  );
});

test('owner and settings drift during await prevent stage or metadata delivery', async (t) => {
  const f = await fixture(t),
    review = await f.repository.review(f.scope, f.remote);
  f.hash(() => f.setScope({ ownerId: otherOwner, authGeneration: 2 }));
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('account_changed'));
  f.setScope(f.scope);
  assert.equal(await f.repository.read(f.scope), null);
  f.hash(() =>
    f.setSettings({
      appPreferences: { theme: 'light', motion: 'system', locale: 'en' },
      profile: { displayName: null },
    }),
  );
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('settings_changed'));
  assert.equal(await f.repository.read(f.scope), null);
});

test('final admission after observer rollback and post-COMMIT owner loss never deliver stale operation authority', async (t) => {
  const f = await fixture(t),
    review = await f.repository.review(f.scope, f.remote);
  f.afterObserver(() => f.setScope(null));
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('account_changed'));
  f.setScope(f.scope);
  assert.equal(await f.repository.read(f.scope), null);
  f.afterCommit(() => f.setScope(null));
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('account_changed'));
  f.setScope(f.scope);
  const durable = await f.repository.read(f.scope);
  assert.ok(durable);
  assert.equal(durable.networkOperationId, f.ids.at(-2));
});

test('close during prepared statement finalizes it and refuses further use; changed input getters never run', async (t) => {
  const f = await fixture(t),
    review = await f.repository.review(f.scope, f.remote);
  let executed = false;
  const malicious = { initialImportReviewed: false };
  Object.defineProperty(malicious, 'resolutions', {
    enumerable: true,
    get() {
      executed = true;
      return {};
    },
  });
  await assert.rejects(f.repository.stage(f.scope, review, malicious));
  assert.equal(executed, false);
  const before = f.statementCounts();
  f.afterPrepare(() => f.repository.close());
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('account_changed'));
  const after = f.statementCounts();
  assert.equal(after.prepared - before.prepared, after.finalized - before.finalized);
  await assert.rejects(f.repository.read(f.scope), failure('account_changed'));
});

for (const decision of ['keep_local', 'save_account_version'] as const) {
  test(`pre-upload favourite removal review requires an exact choice and stages ${decision} without changing local data`, async (t) => {
    const f = await fixture(t);
    f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run(f.recipe.recipeId, at, at);
    const remote = copy(f.remote);
    remote.revision = 5;
    remote.snapshot.favourites = [{ recipeId: f.recipe.recipeId, savedAt: at }];
    const review = await f.repository.review(f.scope, remote);
    assert.equal(review.merge.status, 'merged');
    assert.ok(review.removalReview);
    assert.equal(review.removalReview.conflicts.length, 1);
    const conflict = review.removalReview.conflicts[0]!;
    assert.equal(conflict.kind, 'favourite');
    assert.deepEqual(conflict.reasons, ['exactFavouriteRemoval']);
    const oldBytes = f.db
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get(journalKey(ownerId))!.value;
    await assert.rejects(f.repository.stage(f.scope, review, choice), failure('invalid_input'));
    await assert.rejects(
      f.repository.stage(f.scope, copy(review), {
        ...choice,
        removalChoices: { [conflict.id]: decision },
      }),
      failure('local_changed'),
    );
    await assert.rejects(
      f.repository.stage(f.scope, review, { ...choice, removalChoices: { other: decision } }),
      failure('invalid_input'),
    );
    assert.equal(await f.repository.read(f.scope), null);
    const value = await f.repository.stage(f.scope, review, {
      ...choice,
      removalChoices: { [conflict.id]: decision },
    });
    assert.deepEqual(
      value.proposed.favourites,
      decision === 'keep_local' ? [] : remote.snapshot.favourites,
    );
    assert.equal(f.db.prepare('SELECT saved FROM favourite').get()!.saved, 0);
    assert.equal(
      f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!.value,
      oldBytes,
    );
    assert.deepEqual(Object.keys(value.review).sort(), ['initialImportReviewed', 'resolutions']);
    assert.equal(Object.hasOwn(value, 'backup'), false);
    assert.equal(Object.hasOwn(value, 'removalReview'), false);
    const again = await f.repository.stage(f.scope, review, {
      ...choice,
      removalChoices: { [conflict.id]: decision },
    });
    assert.deepEqual(again, value);
    await assert.rejects(
      f.repository.stage(f.scope, review, {
        ...choice,
        removalChoices: {
          [conflict.id]: decision === 'keep_local' ? 'save_account_version' : 'keep_local',
        },
      }),
      failure('operation_changed'),
    );
  });
}

for (const decision of ['keep_local', 'save_account_version'] as const) {
  test(`global preference-removal marker requires explicit ${decision} before any upload staging`, async (t) => {
    const f = await fixture(t),
      preferenceId = randomUUID();
    f.db.exec(
      "UPDATE preference_state SET last_removal_revision=1;UPDATE state_revision SET revision=1 WHERE collection='preferences'",
    );
    const remote = copy(f.remote);
    remote.revision = 5;
    remote.snapshot.preferences = [
      { preferenceId, type: 'ingredient_avoid', value: '  Avoid "nuts"\u0000 عربي  ' },
    ];
    const review = await f.repository.review(f.scope, remote);
    assert.ok(review.removalReview);
    const conflict = review.removalReview.conflicts[0]!;
    assert.equal(conflict.kind, 'preference');
    if (conflict.kind !== 'preference') assert.fail('Expected preference review');
    assert.deepEqual(conflict.reasons, ['unidentifiedPreferenceRemoval']);
    assert.deepEqual(conflict.removals, []);
    assert.deepEqual(conflict.current, { kind: 'absent' });
    await assert.rejects(f.repository.stage(f.scope, review, choice), failure('invalid_input'));
    assert.equal(await f.repository.read(f.scope), null);
    const result = await f.repository.stage(f.scope, review, {
      ...choice,
      removalChoices: { [conflict.id]: decision },
    });
    assert.deepEqual(
      result.proposed.preferences,
      decision === 'keep_local' ? [] : remote.snapshot.preferences,
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saved_preference').get()!.n, 0);
    assert.equal(f.db.prepare('SELECT last_removal_revision n FROM preference_state').get()!.n, 1);
  });
}

test('exact source removal evidence reaches review without source messages or local revisions entering the proposal', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID(),
    messageId = randomUUID(),
    operationId = randomUUID();
  const raw = '  Original removed value\u0000  ';
  const conversationId = f.db.prepare('SELECT conversation_id FROM conversation').get()!
    .conversation_id;
  assert.equal(typeof conversationId, 'string');
  f.db
    .prepare('INSERT INTO operation_receipt VALUES (?,?,?,?,?,?,?)')
    .run(operationId, randomUUID(), 'a'.repeat(64), 'committed', at, 'unchanged', '[]');
  f.db
    .prepare('INSERT INTO message VALUES (?,?,0,0,?,?,?,?)')
    .run(
      messageId,
      conversationId!,
      'user',
      JSON.stringify('PRIVATE original message'),
      'complete',
      at,
    );
  f.db
    .prepare('INSERT INTO source_preference_link VALUES (?,?,?,?,1,2,?)')
    .run(messageId, preferenceId, 'ingredient_avoid', JSON.stringify(raw), operationId);
  f.db.exec(
    "UPDATE preference_state SET last_removal_revision=2;UPDATE state_revision SET revision=2 WHERE collection IN ('preferences','store')",
  );
  const before = f.db.prepare('SELECT * FROM source_preference_link').all();
  const remote = copy(f.remote);
  remote.revision = 5;
  remote.snapshot.preferences = [
    { preferenceId: randomUUID(), type: 'ingredient_avoid', value: raw },
  ];
  const review = await f.repository.review(f.scope, remote);
  assert.ok(review.removalReview);
  const conflict = review.removalReview.conflicts[0]!;
  assert.equal(conflict.kind, 'preference');
  if (conflict.kind !== 'preference') assert.fail('Expected exact removal');
  assert.deepEqual(conflict.reasons, ['exactPreferenceRemoval']);
  assert.deepEqual(conflict.removals, [
    { preferenceId, type: 'ingredient_avoid', value: raw, savedRevision: 1, removedRevision: 2 },
  ]);
  const result = await f.repository.stage(f.scope, review, {
    ...choice,
    removalChoices: { [conflict.id]: 'save_account_version' },
  });
  assert.deepEqual(result.proposed.preferences, remote.snapshot.preferences);
  assert.equal(JSON.stringify(result).includes('PRIVATE original message'), false);
  assert.equal(JSON.stringify(result).includes('savedRevision'), false);
  assert.deepEqual(f.db.prepare('SELECT * FROM source_preference_link').all(), before);
});

test('ordinary merge choices that reveal a removal require a fresh visible resolved review', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID();
  f.old.base!.snapshot!.preferences = [{ preferenceId, type: 'cuisine', value: 'Original' }];
  f.old.observed!.snapshotDigest = await sha256(canonicalAccountSnapshot(f.old.base!.snapshot!));
  f.metadata(journalKey(ownerId), f.old);
  f.db
    .prepare('INSERT INTO saved_preference VALUES (?,?,?,1)')
    .run(preferenceId, 'cuisine', JSON.stringify('Local replacement'));
  f.db.exec(
    "UPDATE preference_state SET last_removal_revision=1;UPDATE state_revision SET revision=1 WHERE collection='preferences'",
  );
  const remote = copy(f.remote);
  remote.revision = 5;
  remote.snapshot.preferences = [{ preferenceId, type: 'cuisine', value: 'Account replacement' }];
  const unresolved = await f.repository.review(f.scope, remote);
  assert.equal(unresolved.merge.status, 'needs_review');
  assert.equal(unresolved.removalReview, null);
  if (unresolved.merge.status !== 'needs_review')
    assert.fail('Expected ordinary preference conflict');
  const resolutions = Object.fromEntries(
    unresolved.merge.conflicts.map((row) => [row.id, 'account' as const]),
  );
  await assert.rejects(
    f.repository.stage(f.scope, unresolved, {
      ...choice,
      resolutions,
      removalChoices: { [`preference:${preferenceId}`]: 'save_account_version' },
    }),
    failure('recovery_required'),
  );
  assert.equal(await f.repository.read(f.scope), null);
  const review = await f.repository.review(f.scope, remote, resolutions);
  assert.equal(review.merge.status, 'merged');
  assert.ok(review.removalReview);
  assert.equal(review.removalReview.conflicts.length, 1);
  const conflict = review.removalReview.conflicts[0]!;
  assert.equal(conflict.kind, 'preference');
  assert.deepEqual(conflict.current, {
    kind: 'live',
    row: { preferenceId, type: 'cuisine', value: 'Local replacement', revision: 1 },
  });
  const result = await f.repository.stage(f.scope, review, {
    ...choice,
    removalChoices: { [conflict.id]: 'keep_local' },
  });
  assert.deepEqual(result.proposed.preferences, [
    { preferenceId, type: 'cuisine', value: 'Local replacement' },
  ]);
  assert.deepEqual(result.review.resolutions, resolutions);
});

test('same-clock changed removal evidence invalidates the staged review inside the writer snapshot', async (t) => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run(f.recipe.recipeId, at, at);
  const remote = copy(f.remote);
  remote.revision = 5;
  remote.snapshot.favourites = [{ recipeId: f.recipe.recipeId, savedAt: at }];
  const review = await f.repository.review(f.scope, remote);
  assert.ok(review.removalReview);
  f.db.prepare('UPDATE favourite SET updated_at=?').run('2026-10-01T12:30:00.000Z');
  await assert.rejects(
    f.repository.stage(f.scope, review, {
      ...choice,
      removalChoices: { [review.removalReview.conflicts[0]!.id]: 'save_account_version' },
    }),
    failure('local_changed'),
  );
  assert.equal(await f.repository.read(f.scope), null);
});

test('restore-archive presence is a conservative same-snapshot conflict without hydrating archive bodies', async (t) => {
  const f = await fixture(t),
    preferenceId = randomUUID();
  const remote = copy(f.remote);
  remote.revision = 5;
  remote.snapshot.preferences = [{ preferenceId, type: 'cuisine', value: 'Thai' }];
  const first = await f.repository.review(f.scope, remote);
  assert.deepEqual(first.removalReview!.conflicts, []);
  f.db
    .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
    .run(randomUUID(), 'b'.repeat(64), '{"private":"before"}', '{"private":"imported"}', '{}');
  await assert.rejects(f.repository.stage(f.scope, first, choice), failure('local_changed'));
  const reads = f.readSql.length;
  const review = await f.repository.review(f.scope, remote);
  assert.ok(review.removalReview);
  const conflict = review.removalReview.conflicts[0]!;
  assert.deepEqual(conflict.reasons, ['retainedRestoreArchive']);
  await assert.rejects(f.repository.stage(f.scope, review, choice), failure('invalid_input'));
  const result = await f.repository.stage(f.scope, review, {
    ...choice,
    removalChoices: { [conflict.id]: 'keep_local' },
  });
  assert.deepEqual(result.proposed.preferences, []);
  assert.equal(
    f.readSql
      .slice(reads)
      .some((sql) =>
        /SELECT.*(?:before_json|imported_json|receipt_json).*FROM portable_restore_operation/i.test(
          sql,
        ),
      ),
    false,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM portable_restore_operation').get()!.n, 1);
});

test('removal choices are owned before hashes and lost stage acknowledgement retains the adjusted exact candidate', async (t) => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run(f.recipe.recipeId, at, at);
  const remote = copy(f.remote);
  remote.revision = 5;
  remote.snapshot.favourites = [{ recipeId: f.recipe.recipeId, savedAt: at }];
  const review = await f.repository.review(f.scope, remote);
  assert.ok(review.removalReview);
  const id = review.removalReview.conflicts[0]!.id;
  const selected: AccountLegacyTransitionChoices = {
    ...choice,
    removalChoices: { [id]: 'keep_local' },
  };
  f.hash(() => {
    selected.removalChoices = { [id]: 'save_account_version' };
  });
  f.afterCommit(() => {
    throw new Error('fixture lost adjusted stage ACK');
  });
  const result = await f.repository.stage(f.scope, review, selected);
  assert.deepEqual(result.proposed.favourites, []);
  await f.reopen();
  assert.deepEqual(await f.repository.recover(f.scope, f.identity(result)), result);
  assert.equal(f.db.prepare('SELECT saved FROM favourite').get()!.saved, 0);
});
