import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createBundledRecipeRevision } from '@cookmate/catalogue/content';
import {
  AccountReplicationError,
  type AccountReplicationScope,
  type AccountSnapshotOptions,
} from '@cookmate/account-sync';
import type { AccountContentSnapshot } from '../../account-sync/src/contentSnapshot';
import { canonicalPortableContentJson } from '../src/portableBackupContent';
import type { AccountContentLocalCapture } from '../../../apps/mobile/src/data/accountContentCapture';
import {
  createContentAccountServices,
  createContentAccountBootstrap,
  type ContentAccountServicesOptions,
  type ContentAccountBootstrapOptions,
} from '../../../apps/mobile/src/data/contentAccountServices';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_SETTINGS_KEY,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { createContentManualShopping } from '../../../apps/mobile/src/data/contentManualShopping';
import { createContentCookingSessions } from '../../../apps/mobile/src/data/contentCookingSessions';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Disposable physical8 SQL with controlled content inspection; no Auth, transport or sign-in.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const reason =
  (...expected: string[]) =>
  (error: unknown) =>
    error instanceof AccountReplicationError && expected.includes(error.reason);
const settings = (): AccountSnapshotOptions => ({
  appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
  profile: { displayName: null },
});
const remote = () => ({
  ownerId,
  revision: 0,
  snapshot: null,
  updatedAt: null,
  deletionOperationId: null,
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-account-services-'));
  const filename = join(directory, 'store.db');
  const installationId = randomUUID();
  let write = desktopConnection(filename),
    read = desktopConnection(filename);
  let queue = new SqlTransactionQueue(),
    reader = new SerializedReader(read.connection, queue),
    writer = new SerializedWriter(write.connection, queue);
  await configureConnection(write.connection);
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
  write.database
    .prepare('INSERT INTO app_metadata VALUES (?,?)')
    .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId }));
  await migrateCookingContentDatabase(writer, { sha256: hash });
  await migrateAccountContentHistoryDatabase(writer, { sha256: hash });
  const scope = { ownerId, authGeneration: 1 };
  let current: AccountReplicationScope | null = { ...scope },
    localSettings = settings();
  let afterRead: ((sql: string) => void) | undefined;
  let afterWrite: ((sql: string, values: readonly SqlValue[]) => void) | undefined;
  let afterCommit: (() => void) | undefined;
  let afterHash: (() => void) | undefined;
  let afterNotify: (() => void) | undefined;
  let held = false,
    busy = false,
    largeTransfers = 0,
    sqlCalls = 0;
  const notifications: Parameters<ContentAccountServicesOptions['onCommitted']>[] = [];
  function hooks() {
    for (const connection of [read.connection, write.connection]) {
      const all = connection.all;
      connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
        sqlCalls++;
        const rows = await all<Row>(sql, values);
        for (const row of rows)
          for (const value of Object.values(row))
            if (
              (typeof value === 'string' && value.length > 100_000) ||
              (value instanceof Uint8Array && value.length > 100_000)
            )
              largeTransfers++;
        afterRead?.(sql);
        return rows;
      };
    }
    const prepare = write.connection.prepare,
      exec = write.connection.exec;
    write.connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        ...statement,
        async run(values) {
          await statement.run(values);
          const effect = afterWrite;
          afterWrite = undefined;
          effect?.(sql, values);
        },
      };
    };
    write.connection.exec = async (sql) => {
      await exec(sql);
      if (sql === 'COMMIT') {
        const effect = afterCommit;
        afterCommit = undefined;
        effect?.();
      }
    };
  }
  hooks();
  const owned = new Set<{ close(): void }>();
  function options(): ContentAccountServicesOptions {
    return {
      reader,
      writer,
      installationId,
      catalogue: catalogue.identity,
      scope,
      currentScope: () => current,
      getLocalSettings: () => localSettings,
      now: () => at,
      newId: randomUUID,
      async sha256(text) {
        const result = await hash(text);
        const effect = afterHash;
        afterHash = undefined;
        effect?.();
        return result;
      },
      contentStore: {
        async withVerifiedReferenceInspection(head, refs, work) {
          assert.equal(head, null);
          assert.deepEqual(refs, []);
          let live = true;
          try {
            return await work({
              head: null,
              latestHead: null,
              adoptedRecipeIds: catalogue.recipes.map((recipe) => recipe.recipeId),
              entries: [],
              assertActive() {
                assert.ok(live);
                return undefined;
              },
            });
          } finally {
            live = false;
          }
        },
      },
      acquireExclusive() {
        if (held || busy) return null;
        held = true;
        return () => {
          held = false;
        };
      },
      onCommitted(...args) {
        notifications.push(args);
        afterNotify?.();
      },
    };
  }
  async function create(overrides: Partial<ContentAccountServicesOptions> = {}) {
    const value = await createContentAccountServices({ ...options(), ...overrides });
    owned.add(value);
    return value;
  }
  async function bootstrap(overrides: Partial<ContentAccountBootstrapOptions> = {}) {
    const value = await createContentAccountBootstrap({ ...options(), ...overrides });
    owned.add(value);
    return value;
  }
  async function reopenConnections() {
    for (const value of owned) value.close();
    await reader.close();
    await writer.close();
    write = desktopConnection(filename);
    read = desktopConnection(filename);
    await configureConnection(write.connection);
    await configureConnection(read.connection);
    await read.connection.exec('PRAGMA query_only=ON');
    queue = new SqlTransactionQueue();
    reader = new SerializedReader(read.connection, queue);
    writer = new SerializedWriter(write.connection, queue);
    hooks();
  }
  let service = await create();
  async function approve(historyIncluded = false) {
    return service.approval.approve(scope, await service.approval.review(scope), {
      historyIncluded,
    });
  }
  async function stage() {
    const operationId = randomUUID();
    const review = await service.journal.reviewPush(scope, { operationId, remote: remote() });
    const journal = await service.journal.stageReviewedPush(scope, review, {
      initialImportReviewed: true,
    });
    assert.ok(journal.pending);
    return { operationId, requestFingerprint: journal.pending.requestFingerprint };
  }
  async function accept(identity: Awaited<ReturnType<typeof stage>>) {
    return service.journal.recordAcknowledgement(scope, {
      ...identity,
      receipt: { ownerId, operationId: identity.operationId, revision: 1, committedAt: at },
    });
  }
  t.after(async () => {
    for (const value of owned) value.close();
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  return {
    scope,
    installationId,
    create,
    bootstrap,
    approve,
    stage,
    accept,
    notifications,
    get service() {
      return service;
    },
    get db() {
      return write.database;
    },
    get reader() {
      return reader;
    },
    get writer() {
      return writer;
    },
    get held() {
      return held;
    },
    get sqlCalls() {
      return sqlCalls;
    },
    get largeTransfers() {
      return largeTransfers;
    },
    setScope(value: AccountReplicationScope | null) {
      current = value;
    },
    setSettings(value: AccountSnapshotOptions) {
      localSettings = value;
    },
    busy(value: boolean) {
      busy = value;
    },
    afterRead(value: typeof afterRead) {
      afterRead = value;
    },
    afterWrite(value: typeof afterWrite) {
      afterWrite = value;
    },
    afterCommit(value: typeof afterCommit) {
      afterCommit = value;
    },
    afterHash(value: typeof afterHash) {
      afterHash = value;
    },
    afterNotify(value: typeof afterNotify) {
      afterNotify = value;
    },
    async reopen() {
      await reopenConnections();
      service = await create();
    },
    async reopenUnbound() {
      await reopenConnections();
      return bootstrap();
    },
  };
}

test('composition requires existing private8 owner/install and never prepares or claims a guest', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.create({ installationId: randomUUID() }), reason('different_data_owner'));
  await assert.rejects(
    f.create({ scope: { ownerId: otherOwnerId, authGeneration: 1 } }),
    reason('account_changed'),
  );
  for (const version of [5, 6, 7, 9]) {
    f.db.exec(`PRAGMA user_version=${version}`);
    await assert.rejects(f.create(), reason('stored_data_invalid'));
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, version);
  }
  f.db.exec('PRAGMA user_version=8');
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
  await assert.rejects(f.create(), reason('different_data_owner'));
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(ACCOUNT_BINDING_KEY),
    undefined,
  );
});

test('scope3 approval remains deliberate and exact; history is omitted until separately opted in', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.capture(), reason('scope_review_required'));
  const review = await f.service.approval.review(f.scope);
  assert.equal(review.historyIncluded, false);
  await assert.rejects(
    f.service.approval.approve(f.scope, { ...review }, { historyIncluded: false }),
    reason('scope_review_required'),
  );
  await f.service.approval.approve(f.scope, review, { historyIncluded: false });
  assert.equal(Object.hasOwn((await f.service.capture()).snapshot, 'cookingHistory'), false);
  await f.approve(true);
  assert.deepEqual((await f.service.capture()).snapshot.cookingHistory, {
    entries: [],
    removedEventIds: [],
  });
  const next = await f.service.approval.review(f.scope);
  f.setSettings({ ...settings(), profile: { displayName: 'New private preference' } });
  await assert.rejects(
    f.service.approval.approve(f.scope, next, { historyIncluded: false }),
    reason('local_changed'),
  );
});

test('reviewed staged push, original-ID acknowledgement and local apply survive physical reopen', async (t) => {
  const f = await fixture(t);
  await f.approve();
  const identity = await f.stage();
  await assert.rejects(f.service.capture(), reason('operation_pending'));
  await f.accept(identity);
  await f.reopen();
  const saved = await f.service.journal.recover(f.scope, identity);
  assert.equal(saved?.pending?.acknowledgement?.operationId, identity.operationId);
  await assert.rejects(
    f.service.journal.recover(f.scope, { ...identity, requestFingerprint: 'f'.repeat(64) }),
    reason('operation_changed'),
  );
  const review = await f.service.apply.review(f.scope, identity);
  const receipt = await f.service.apply.apply(f.scope, review);
  assert.equal(receipt.operationId, identity.operationId);
  assert.equal(f.held, false);
  assert.equal(f.notifications.length, 1);
  await f.reopen();
  assert.deepEqual(await f.service.apply.recover(f.scope, identity), receipt);
  assert.equal((await f.service.journal.read(f.scope))?.pending, null);
  assert.equal(await f.service.legacyTransition.read(f.scope), null);
});

test('lost acknowledgement recovers the same staged bytes and never creates a second operation', async (t) => {
  const f = await fixture(t);
  await f.approve();
  const identity = await f.stage();
  f.afterCommit(() => {
    throw new Error('Lost commit acknowledgement');
  });
  const saved = await f.accept(identity);
  assert.equal(f.writer.requiresRecovery(), true);
  await f.reopen();
  const replay = await f.accept(identity);
  assert.deepEqual(replay, saved);
  assert.equal(saved.pending?.operationId, identity.operationId);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) count FROM app_metadata WHERE key GLOB 'account-replication:content-journal:*'",
      )
      .get()!.count,
    1,
  );
});

test('retirement after a committed acknowledgement suppresses late disclosure; original scope recovers', async (t) => {
  const f = await fixture(t);
  await f.approve();
  const identity = await f.stage();
  f.afterCommit(() => f.setScope(null));
  await assert.rejects(f.accept(identity), reason('account_changed'));
  const count = f.sqlCalls;
  await assert.rejects(f.service.journal.recover(f.scope, identity), reason('account_changed'));
  assert.equal(f.sqlCalls, count);
  f.setScope(f.scope);
  await f.reopen();
  assert.equal(
    (await f.service.journal.recover(f.scope, identity))?.pending?.acknowledgement?.revision,
    1,
  );
});

test('close during query/hash/write revokes every borrowed port without closing host SQL', async (t) => {
  for (const moment of ['query', 'hash', 'write'] as const) {
    const f = await fixture(t);
    const review = await f.service.approval.review(f.scope);
    if (moment === 'query')
      f.afterRead(() => {
        f.afterRead(undefined);
        f.service.close();
      });
    if (moment === 'hash') f.afterHash(() => f.service.close());
    if (moment === 'write') f.afterWrite(() => f.service.close());
    await assert.rejects(
      f.service.approval.approve(f.scope, review, { historyIncluded: false }),
      reason('account_changed'),
    );
    for (const work of [
      () => f.service.approval.read(f.scope),
      () => f.service.capture(),
      () => f.service.journal.read(f.scope),
      () => f.service.legacyTransition.read(f.scope),
      () => f.service.apply.inspectSettings(f.scope),
    ])
      await assert.rejects(work(), reason('account_changed'));
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) count FROM app_metadata WHERE key GLOB 'account-replication:content-scope:*'",
        )
        .get()!.count,
      0,
    );
    assert.equal(
      (
        await f.reader.transaction((session) => session.all<{ value: number }>('SELECT 1 value'))
      )[0]!.value,
      1,
    );
  }
});

test('persisted identity is checked before each borrowed transaction and bounded before transfer', async (t) => {
  for (const key of ['installation_id', ACCOUNT_BINDING_KEY]) {
    const f = await fixture(t);
    await f.approve();
    f.db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run('X'.repeat(1024 * 1024), key);
    for (const work of [
      () => f.service.approval.read(f.scope),
      () => f.service.capture(),
      () => f.service.journal.read(f.scope),
      () => f.service.legacyTransition.read(f.scope),
      () => f.service.apply.inspectSettings(f.scope),
    ])
      await assert.rejects(
        work(),
        reason('different_data_owner', 'too_large', 'stored_data_invalid'),
      );
    assert.equal(f.largeTransfers, 0);
  }
});

test('exclusive apply waits for the host gate and retirement during notification hides success', async (t) => {
  const f = await fixture(t);
  await f.approve();
  const identity = await f.stage();
  await f.accept(identity);
  const review = await f.service.apply.review(f.scope, identity);
  f.busy(true);
  await assert.rejects(f.service.apply.apply(f.scope, review), reason('store_busy'));
  f.busy(false);
  f.afterNotify(() => f.service.close());
  await assert.rejects(f.service.apply.apply(f.scope, review), reason('account_changed'));
  assert.equal(f.held, false);
  await f.reopen();
  assert.equal(
    (await f.service.apply.recover(f.scope, identity))?.operationId,
    identity.operationId,
  );
});

test('remote settings stay pending until exact local projection is acknowledged', async (t) => {
  const f = await fixture(t);
  await f.approve();
  const capture: AccountContentLocalCapture = JSON.parse(JSON.stringify(await f.service.capture()));
  const snapshot: AccountContentSnapshot = JSON.parse(JSON.stringify(capture.snapshot));
  snapshot.profile.displayName = 'Reviewed account preference';
  const staged = await f.service.journal.stage(f.scope, {
    operationId: randomUUID(),
    expectedJournalRevision: 0,
    expectedDeviceDataOwnerId: ownerId,
    initialImportReviewed: true,
    capturedLocal: capture,
    proposed: snapshot,
    mode: 'pull',
    remote: { ...remote(), revision: 1, snapshot, updatedAt: at },
  });
  assert.ok(staged.pending);
  const identity = {
    operationId: staged.pending.operationId,
    requestFingerprint: staged.pending.requestFingerprint,
  };
  await f.service.apply.apply(f.scope, await f.service.apply.review(f.scope, identity));
  const pending = await f.service.apply.inspectSettings(f.scope);
  assert.ok(pending);
  await assert.rejects(f.service.capture(), reason('settings_pending'));
  await assert.rejects(
    f.service.apply.acknowledgeSettings(f.scope, pending),
    reason('settings_changed'),
  );
  f.setSettings(pending.projection);
  await f.service.apply.acknowledgeSettings(f.scope, pending);
  assert.equal(await f.service.apply.inspectSettings(f.scope), null);
  assert.equal(
    (await f.service.capture()).snapshot.profile.displayName,
    snapshot.profile.displayName,
  );
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(ACCOUNT_SETTINGS_KEY),
    undefined,
  );
});

const bootstrapJournalKey = `account-replication:content-journal:${ownerId}`;
const bootstrapArchiveKey = `account-replication:content-initial-guest:${ownerId}`;
async function unboundFixture(t: TestContext) {
  const f = await fixture(t);
  f.service.close();
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
  // This is the lifecycle caller's admitted-clone boundary, not marker-validation proof.
  // The account factory must neither create a lifecycle marker nor claim an unverified file.
  const before = f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all();
  const bootstrap = await f.bootstrap();
  assert.deepEqual(f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all(), before);
  return { f, bootstrap };
}
async function approveBootstrap(
  bootstrap: Awaited<ReturnType<typeof createContentAccountBootstrap>>,
) {
  const review = await bootstrap.approval.review(bootstrap.scope);
  await bootstrap.approval.approve(bootstrap.scope, review, { historyIncluded: false });
}

test('bootstrap alone admits an unbound clone; construction rejects bound/foreign/schema/install mismatches', async (t) => {
  const { f, bootstrap } = await unboundFixture(t);
  assert.deepEqual(Object.keys(bootstrap).sort(), [
    'approval',
    'capture',
    'close',
    'journal',
    'scope',
  ]);
  assert.deepEqual(Object.keys(bootstrap.journal).sort(), [
    'discardRejected',
    'read',
    'recordAcknowledgement',
    'recover',
    'reviewPush',
    'stage',
    'stageReviewedPush',
  ]);
  await assert.rejects(f.create(), reason('different_data_owner'));
  await assert.rejects(
    f.bootstrap({ installationId: randomUUID() }),
    reason('different_data_owner'),
  );
  await assert.rejects(
    f.bootstrap({ scope: { ...f.scope, authGeneration: 2 } }),
    reason('account_changed'),
  );
  for (const version of [5, 6, 7, 9]) {
    f.db.exec(`PRAGMA user_version=${version}`);
    await assert.rejects(f.bootstrap(), reason('stored_data_invalid'));
  }
  f.db.exec('PRAGMA user_version=8');
  for (const owner of [ownerId, otherOwnerId]) {
    f.db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(ACCOUNT_BINDING_KEY, JSON.stringify({ schemaVersion: 1, ownerId: owner }));
    await assert.rejects(f.bootstrap(), reason('different_data_owner'));
  }
  await assert.rejects(bootstrap.journal.read(f.scope), reason('different_data_owner'));
});

test('bootstrap reviewed push alone commits initial binding, guest archive and exact pending request', async (t) => {
  const { f, bootstrap } = await unboundFixture(t);
  await assert.rejects(bootstrap.capture(), reason('scope_review_required'));
  await approveBootstrap(bootstrap);
  const captured = await bootstrap.capture();
  assert.equal(captured.fence.binding, null);
  assert.equal(Object.hasOwn(captured.snapshot, 'cookingHistory'), false);
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(ACCOUNT_BINDING_KEY),
    undefined,
  );
  const operationId = randomUUID();
  const review = await bootstrap.journal.reviewPush(f.scope, { operationId, remote: remote() });
  assert.equal(review.initialImportRequired, true);
  await assert.rejects(
    bootstrap.journal.stageReviewedPush(f.scope, { ...review }, { initialImportReviewed: true }),
    reason('local_changed'),
  );
  await assert.rejects(
    bootstrap.journal.stageReviewedPush(f.scope, review, { initialImportReviewed: false }),
    reason('initial_review_required'),
  );
  const staged = await bootstrap.journal.stageReviewedPush(f.scope, review, {
    initialImportReviewed: true,
  });
  assert.ok(staged.pending);
  const rawBinding = f.db
    .prepare('SELECT value FROM app_metadata WHERE key=?')
    .get(ACCOUNT_BINDING_KEY)!.value;
  assert.equal(rawBinding, JSON.stringify({ schemaVersion: 1, ownerId }));
  const archive = f.db
    .prepare('SELECT value FROM app_metadata WHERE key=?')
    .get(bootstrapArchiveKey)!.value;
  assert.equal(typeof archive, 'string');
  assert.deepEqual(JSON.parse(String(archive)), {
    schemaVersion: 3,
    ownerId,
    installationId: f.installationId,
    capturedLocal: {
      storeRevision: captured.storeRevision,
      scope: captured.scope,
      snapshot: captured.snapshot,
      fenceDigest: await hash(canonicalPortableContentJson(captured.fence, 32768)),
    },
  });
  const identity = { operationId, requestFingerprint: staged.pending.requestFingerprint };
  assert.deepEqual(await bootstrap.journal.recover(f.scope, identity), staged);
  assert.deepEqual(
    await bootstrap.journal.stageReviewedPush(f.scope, review, { initialImportReviewed: true }),
    staged,
  );
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(bootstrapArchiveKey)!.value,
    archive,
  );
  await assert.rejects(bootstrap.capture(), reason('operation_pending'));
  bootstrap.close();
  await f.reopen();
  assert.deepEqual(await f.service.journal.recover(f.scope, identity), staged);
});

test('bootstrap retains the existing exact pull staging contract and requires initial import review', async (t) => {
  const { f, bootstrap } = await unboundFixture(t);
  await approveBootstrap(bootstrap);
  const capturedLocal = await bootstrap.capture();
  const input = {
    operationId: randomUUID(),
    expectedJournalRevision: 0,
    expectedDeviceDataOwnerId: null,
    initialImportReviewed: false,
    capturedLocal,
    proposed: capturedLocal.snapshot,
    mode: 'pull' as const,
    remote: { ...remote(), revision: 1, snapshot: capturedLocal.snapshot, updatedAt: at },
  };
  await assert.rejects(bootstrap.journal.stage(f.scope, input), reason('initial_review_required'));
  const staged = await bootstrap.journal.stage(f.scope, { ...input, initialImportReviewed: true });
  assert.equal(staged.pending?.mode, 'pull');
  assert.equal(staged.pending?.operationId, input.operationId);
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) count FROM app_metadata WHERE key IN (?,?,?)')
      .get(ACCOUNT_BINDING_KEY, bootstrapArchiveKey, bootstrapJournalKey)!.count,
    3,
  );
});

test('bootstrap preserves populated guest rows and original owner-null operation authority', async (t) => {
  const { f, bootstrap } = await unboundFixture(t);
  const guest = { ownerId: null, authGeneration: 0 };
  const common = {
    reader: f.reader,
    writer: f.writer,
    installationId: f.installationId,
    now: () => at,
    getAccess: () => guest,
    assertAccess(scope: Readonly<{ ownerId: string | null; authGeneration: number }>): undefined {
      assert.deepEqual(scope, guest);
      return undefined;
    },
    onCommitted() {},
  };
  const manual = createContentManualShopping({
    ...common,
    platform: { newId: randomUUID, sha256: hash },
  });
  const sessions = createContentCookingSessions({
    ...common,
    cookingSchemaVersion: 8,
    sha256: hash,
    contentStore: {
      async withVerifiedReading(head, refs, work) {
        assert.equal(head, null);
        assert.equal(refs.length, 1);
        return work({
          head: null,
          latestHead: null,
          snapshot: null,
          hasWithdrawal: false,
          assertActive: () => undefined,
          async readPhoto() {
            throw new Error('Unused photo port');
          },
        });
      },
    },
  });
  const itemId = randomUUID();
  try {
    const added = await manual.execute({
      kind: 'addManualItem',
      operationId: randomUUID(),
      expectedEpoch: 0,
      itemId,
      fields: {
        name: 'Guest coffee filters',
        amountText: '2',
        unitText: 'packs',
        category: 'other',
      },
    });
    assert.equal(added.kind, 'ready', JSON.stringify(added));
    const recipe = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, hash);
    const saved = await sessions.saveSession({
      operationId: randomUUID(),
      sessionId: randomUUID(),
      contentRef: recipe.ref,
      expectedRevision: null,
      passageSequence: recipe.document.recipe.instructions[0]!.sequence,
    });
    assert.equal(saved.kind, 'ready', JSON.stringify(saved));
  } finally {
    // Guest actions are settled and their services retired before initial account review.
    manual.close();
    sessions.close();
  }
  const tables = [
    'manual_shopping_item',
    'personal_operation',
    'cooking_session',
    'cooking_session_content_pin',
    'content_cooking_session_operation',
    'personal_state',
    'cooking_state',
    'state_revision',
  ] as const;
  const rows = () => tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
  const before = rows();
  const authority = f.db
    .prepare('SELECT authority_json FROM content_cooking_session_operation')
    .get()!.authority_json;
  assert.equal(JSON.parse(String(authority)).ownerId, null);
  await approveBootstrap(bootstrap);
  const captured = await bootstrap.capture();
  assert.equal(captured.snapshot.personal.manualItems[0]?.itemId, itemId);
  const review = await bootstrap.journal.reviewPush(f.scope, {
    operationId: randomUUID(),
    remote: remote(),
  });
  const staged = await bootstrap.journal.stageReviewedPush(f.scope, review, {
    initialImportReviewed: true,
  });
  assert.ok(staged.pending);
  assert.equal(staged.pending.proposed.personal.manualItems[0]?.name, 'Guest coffee filters');
  const archive = JSON.parse(
    String(
      f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(bootstrapArchiveKey)!.value,
    ),
  );
  assert.deepEqual(archive.capturedLocal, {
    storeRevision: captured.storeRevision,
    scope: captured.scope,
    snapshot: captured.snapshot,
    fenceDigest: await hash(canonicalPortableContentJson(captured.fence, 32768)),
  });
  assert.deepEqual(rows(), before);
  await f.reopen();
  assert.deepEqual(rows(), before);
  assert.equal(
    f.db.prepare('SELECT authority_json FROM content_cooking_session_operation').get()!
      .authority_json,
    authority,
  );
});

test('bootstrap first-binding interruption rolls back archive, binding and pending journal together', async (t) => {
  for (const interruption of ['retire_after_binding', 'fail_after_journal'] as const) {
    const { f, bootstrap } = await unboundFixture(t);
    await approveBootstrap(bootstrap);
    const review = await bootstrap.journal.reviewPush(f.scope, {
      operationId: randomUUID(),
      remote: remote(),
    });
    const before = f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all();
    const hook = (_sql: string, values: readonly SqlValue[]) => {
      const target =
        interruption === 'retire_after_binding' ? ACCOUNT_BINDING_KEY : bootstrapJournalKey;
      if (values[0] !== target) {
        f.afterWrite(hook);
        return;
      }
      if (interruption === 'retire_after_binding') bootstrap.close();
      else throw new Error('Injected final journal write failure');
    };
    f.afterWrite(hook);
    await assert.rejects(
      bootstrap.journal.stageReviewedPush(f.scope, review, { initialImportReviewed: true }),
      interruption === 'retire_after_binding'
        ? reason('account_changed')
        : /Injected final journal/,
    );
    assert.deepEqual(f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all(), before);
    const reopened = await f.reopenUnbound();
    assert.equal(await reopened.journal.read(f.scope), null);
    assert.equal((await reopened.capture()).fence.binding, null);
  }
});

test('bootstrap late close after commit hides success and original request recovers in the bound facade', async (t) => {
  const { f, bootstrap } = await unboundFixture(t);
  await approveBootstrap(bootstrap);
  const operationId = randomUUID();
  const review = await bootstrap.journal.reviewPush(f.scope, { operationId, remote: remote() });
  f.afterCommit(() => bootstrap.close());
  await assert.rejects(
    bootstrap.journal.stageReviewedPush(f.scope, review, { initialImportReviewed: true }),
    reason('account_changed'),
  );
  await assert.rejects(f.bootstrap(), reason('different_data_owner'));
  await f.reopen();
  const staged = await f.service.journal.read(f.scope);
  assert.ok(staged?.pending);
  assert.equal(staged.pending.operationId, operationId);
  const identity = { operationId, requestFingerprint: staged.pending.requestFingerprint };
  assert.deepEqual(await f.service.journal.recover(f.scope, identity), staged);
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) count FROM app_metadata WHERE key IN (?,?,?)')
      .get(ACCOUNT_BINDING_KEY, bootstrapArchiveKey, bootstrapJournalKey)!.count,
    3,
  );
});

test('bootstrap owner generation loss during hashing rejects subsequent access without SQL', async (t) => {
  const { f, bootstrap } = await unboundFixture(t);
  await approveBootstrap(bootstrap);
  f.afterHash(() => f.setScope({ ...f.scope, authGeneration: 2 }));
  await assert.rejects(bootstrap.capture(), reason('account_changed'));
  const calls = f.sqlCalls;
  await assert.rejects(bootstrap.approval.read(f.scope), reason('account_changed'));
  await assert.rejects(bootstrap.journal.read(f.scope), reason('account_changed'));
  assert.equal(f.sqlCalls, calls);
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(ACCOUNT_BINDING_KEY),
    undefined,
  );
});

test('unbound bootstrap reopen retains consent but requires fresh issued review capabilities', async (t) => {
  const { f, bootstrap } = await unboundFixture(t);
  await approveBootstrap(bootstrap);
  const old = await bootstrap.journal.reviewPush(f.scope, {
    operationId: randomUUID(),
    remote: remote(),
  });
  const reopened = await f.reopenUnbound();
  assert.equal((await reopened.approval.read(f.scope))?.record.historyIncluded, false);
  await assert.rejects(
    reopened.journal.stageReviewedPush(f.scope, old, { initialImportReviewed: true }),
    reason('local_changed'),
  );
  const review = await reopened.journal.reviewPush(f.scope, {
    operationId: randomUUID(),
    remote: remote(),
  });
  assert.ok(
    (await reopened.journal.stageReviewedPush(f.scope, review, { initialImportReviewed: true }))
      .pending,
  );
});
