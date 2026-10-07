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
  type AccountRemoteState,
  type AccountReplicationJournal,
  type AccountReplicationScope,
  type AccountSnapshotOptions,
  type AccountSnapshotV2,
} from '@cookmate/account-sync';
import { cookingContentIdentity } from '../src/cooking';
import {
  accountLegacyContentTransitionKey,
  captureAccountLegacyTransitionInSnapshot,
} from '../../../apps/mobile/src/data/accountLegacyTransitionCapture';
import {
  accountContentScopeApprovalKey,
  createAccountContentScopeApprovalService,
} from '../../../apps/mobile/src/data/accountContentScopeApproval';
import {
  ACCOUNT_BINDING_KEY,
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
} from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = '2026-10-01T12:00:00.000Z';
const serverAt = '2026-10-01T12:00:00.123456+00:00';
const failure =
  (...reasons: string[]) =>
  (error: unknown) =>
    error instanceof AccountReplicationError && reasons.includes(error.reason);

async function fixture(t: TestContext, historyIncluded = false) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-legacy-transition-capture-'));
  const path = join(directory, 'capture.db');
  const write = desktopConnection(path),
    read = desktopConnection(path);
  await configureConnection(write.connection);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const queue = new SqlTransactionQueue();
  const writer = new SerializedWriter(write.connection, queue),
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
  let settings: AccountSnapshotOptions = {
    appPreferences: { theme: 'dark', motion: 'system', locale: 'en' },
    profile: { displayName: null },
  };
  const original = emptyAccountSnapshot(catalogue.identity, settings);
  const occurrenceId = randomUUID(),
    recipeId = catalogue.recipes[0]!.recipeId;
  original.plan = [
    {
      occurrenceId,
      recipeId,
      placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
      createdAt: at,
      updatedAt: at,
    },
  ];
  db.prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)').run(
    occurrenceId,
    recipeId,
    '2026-10-01',
    'dinner',
    at,
    at,
  );
  db.exec("UPDATE state_revision SET revision=1 WHERE collection='store'");
  const remote: AccountRemoteState = {
    ownerId,
    revision: 4,
    snapshot: original,
    updatedAt: serverAt,
    deletionOperationId: null,
  };
  const journal: AccountReplicationJournal = {
    schemaVersion: 1,
    ownerId,
    revision: 1,
    base: structuredClone(remote),
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
  metadata(journalKey(ownerId), journal);
  await migrateCookingContentDatabase(writer, { sha256 });
  await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const scope: AccountReplicationScope = { ownerId, authGeneration: 1 };
  let current: AccountReplicationScope | null = { ...scope };
  let effect: ((text: string) => void) | undefined;
  const options = {
    installationId,
    catalogue: catalogue.identity,
    currentScope: () => current,
    getLocalSettings: () => settings,
    now: () => at,
    sha256: async (text: string) => {
      const result = await sha256(text);
      effect?.(text);
      return result;
    },
  };
  const approval = createAccountContentScopeApprovalService({
    ...options,
    reader,
    writer,
    newId: randomUUID,
  });
  try {
    const review = await approval.review(scope);
    await approval.approve(scope, review, { historyIncluded });
  } finally {
    approval.close();
  }
  const capture = (value: unknown = remote) =>
    reader.transaction(
      (session) => captureAccountLegacyTransitionInSnapshot(session, scope, value, options),
      { kind: 'read_only' },
    );
  return {
    db,
    reader,
    writer,
    metadata,
    options,
    scope,
    journal,
    remote,
    capture,
    installationId,
    setScope(value: AccountReplicationScope | null) {
      current = value;
    },
    setSettings(value: AccountSnapshotOptions) {
      settings = value;
    },
    hashEffect(value: (text: string) => void) {
      effect = value;
    },
    rawJournal: () =>
      db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!.value,
  };
}

test('actual migrated8 captures original journal/remote evidence separately from bundled projections without writing', async (t) => {
  const f = await fixture(t);
  const originalBytes = f.rawJournal();
  const rowsBefore = f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all();
  const result = await f.capture();
  assert.equal(result.local.fence.databaseSchemaVersion, 8);
  assert.equal(result.backup.databaseSchemaVersion, 8);
  assert.equal(result.backup.sourceRevision, result.local.storeRevision);
  assert.deepEqual(result.backup.data.planReferences, result.local.snapshot.planReferences);
  assert.equal(Object.hasOwn(result.backup.data, 'cookingHistory'), false);
  assert.equal(Object.isFrozen(result.backup.data.favourites), true);
  assert.equal(result.hasRestoreArchive, false);
  assert.equal(result.legacy.journalDigest, await sha256(String(originalBytes)));
  assert.equal(result.remote.snapshot!.schemaVersion, 1);
  assert.equal(result.remote.updatedAt, serverAt);
  assert.deepEqual(result.legacy.base, f.remote);
  assert.equal(result.baseConversion!.sourceDigest, result.legacy.observed.snapshotDigest);
  assert.equal(result.remoteConversion.sourceDigest, result.legacy.observed.snapshotDigest);
  assert.equal(result.remoteConversion.snapshot.schemaVersion, 3);
  assert.notEqual(result.remoteConversion.convertedDigest, result.remoteConversion.sourceDigest);
  assert.deepEqual(
    result.local.snapshot.planReferences,
    result.remoteConversion.snapshot.planReferences,
  );
  assert.ok(Object.isFrozen(result.remoteConversion.snapshot.planReferences));
  assert.equal(f.rawJournal(), originalBytes);
  assert.deepEqual(f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all(), rowsBefore);
});

test('observed legacy state without a local base remains explicitly base-null', async (t) => {
  const f = await fixture(t);
  f.journal.base = null;
  f.journal.lastApply = null;
  f.metadata(journalKey(ownerId), f.journal);
  const result = await f.capture();
  assert.equal(result.legacy.base, null);
  assert.equal(result.baseConversion, null);
  assert.equal(result.legacy.observed.revision, 4);
  assert.equal(result.remoteConversion.sourceVersion, 1);
});

test('populated format2 personal and history evidence stays original while derived pins are separately proved', async (t) => {
  const f = await fixture(t);
  const recipe = catalogue.recipes[0]!;
  const original: AccountSnapshotV2 = {
    ...f.remote.snapshot!,
    schemaVersion: 2,
    personal: {
      notes: [
        {
          noteId: randomUUID(),
          recipeId: recipe.recipeId,
          text: '  Exact note\nكمية 🍲  ',
          deleted: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
      collections: [],
      memberships: [],
      manualItems: [],
    },
    cookingHistory: {
      entries: [
        {
          ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
          eventId: randomUUID(),
          recipeTitle: recipe.title,
          photoKey: recipe.photoKey,
          cookedOn: '2026-10-01',
          timeZone: 'Asia/Dubai',
          recordedAt: at,
          note: '  Original history note  ',
        },
      ],
      removedEventIds: [randomUUID()],
    },
  };
  const remote = { ...f.remote, snapshot: original };
  const journal: AccountReplicationJournal = {
    ...f.journal,
    schemaVersion: 2,
    scope: { version: 2, approvalDigest: 'd'.repeat(64), historyIncluded: true },
    base: structuredClone(remote),
    observed: {
      revision: 4,
      updatedAt: serverAt,
      snapshotDigest: await sha256(canonicalAccountSnapshot(original)),
    },
  };
  f.metadata(journalKey(ownerId), journal);
  const originalBytes = f.rawJournal();
  const result = await f.capture(remote);
  assert.equal(
    result.local.scope.historyIncluded,
    false,
    'old remote history is evidence, not fresh local upload consent',
  );
  assert.equal(Object.hasOwn(result.local.snapshot, 'cookingHistory'), false);
  assert.deepEqual(result.remote.snapshot, original);
  assert.equal(result.baseConversion!.sourceVersion, 2);
  assert.deepEqual(result.remoteConversion.snapshot.personal, original.personal);
  assert.deepEqual(
    result.remoteConversion.snapshot.cookingHistory!.removedEventIds,
    original.cookingHistory!.removedEventIds,
  );
  const projected = result.remoteConversion.snapshot.cookingHistory!.entries[0]!;
  assert.equal(projected.kind, 'legacy');
  if (projected.kind !== 'legacy') assert.fail('Expected retained original legacy entry');
  assert.equal(projected.pin.kind, 'exact');
  assert.deepEqual(projected.entry, original.cookingHistory!.entries[0]);
  assert.equal(f.rawJournal(), originalBytes);
});

test('newer actual legacy remote preserves the prior base and original digests', async (t) => {
  const f = await fixture(t);
  const later = structuredClone(f.remote);
  later.revision = 5;
  later.snapshot!.profile.displayName = 'Later server choice';
  later.updatedAt = '2026-10-01T13:00:00.123456+00:00';
  const result = await f.capture(later);
  assert.equal(result.legacy.base!.revision, 4);
  assert.equal(result.remote.revision, 5);
  assert.notEqual(result.baseConversion!.sourceDigest, result.remoteConversion.sourceDigest);
  assert.equal(result.baseConversion!.snapshot.profile.displayName, null);
});

test('stale, rebound and deleting remote states cannot produce an upgrade context', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.capture({ ...f.remote, revision: 3 }), failure('stale_server_revision'));
  await assert.rejects(f.capture({ ...f.remote, updatedAt: at }), failure('stale_server_revision'));
  const rebound = structuredClone(f.remote);
  rebound.snapshot!.profile.displayName = 'Changed under same revision';
  await assert.rejects(f.capture(rebound), failure('stale_server_revision'));
  await assert.rejects(
    f.capture({ ...f.remote, deletionOperationId: randomUUID() }),
    failure('deletion_pending'),
  );
});

test('scope approval is mandatory and a future legacy apply clock is rejected', async (t) => {
  const f = await fixture(t);
  f.journal.lastApply!.storeRevision = 2;
  f.metadata(journalKey(ownerId), f.journal);
  await assert.rejects(f.capture(), failure('stored_data_invalid'));
  f.journal.lastApply!.storeRevision = 1;
  f.metadata(journalKey(ownerId), f.journal);
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(accountContentScopeApprovalKey(ownerId));
  await assert.rejects(f.capture(), failure('scope_review_required'));
});

test('existing or foreign transition markers block preparation without reading their bodies', async (t) => {
  const f = await fixture(t);
  const foreign = accountLegacyContentTransitionKey('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  f.metadata(foreign, 'PRIVATE FOREIGN BODY');
  const reads: string[] = [];
  const result = f.reader.transaction(
    (session) =>
      captureAccountLegacyTransitionInSnapshot(
        {
          ...session,
          all: async <Row extends object>(
            sql: string,
            values?: Parameters<typeof session.all>[1],
          ) => {
            const rows = await session.all<Row>(sql, values);
            reads.push(JSON.stringify(rows));
            return rows;
          },
        },
        f.scope,
        f.remote,
        f.options,
      ),
    { kind: 'read_only' },
  );
  await assert.rejects(result, failure('different_data_owner'));
  assert.ok(!reads.join('').includes('PRIVATE FOREIGN BODY'));
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(foreign);
  f.metadata(accountLegacyContentTransitionKey(ownerId), null);
  await assert.rejects(f.capture(), failure('operation_pending'));
});

test('history capture follows current explicit consent while old server history remains original evidence', async (t) => {
  const f = await fixture(t, true);
  const result = await f.capture();
  assert.equal(result.local.scope.historyIncluded, true);
  assert.deepEqual(result.local.snapshot.cookingHistory, { entries: [], removedEventIds: [] });
  assert.equal(Object.hasOwn(result.remote.snapshot!, 'cookingHistory'), false);
});

test('owner and settings changes during conversion reject the complete result', async (t) => {
  const f = await fixture(t);
  f.hashEffect((text) => {
    if (text.includes('cookmate-account-snapshot')) f.setScope(null);
  });
  await assert.rejects(f.capture(), failure('account_changed'));
  f.setScope(f.scope);
  f.hashEffect((text) => {
    if (text.includes('cookmate-account-snapshot'))
      f.setSettings({
        appPreferences: { theme: 'light', motion: 'system', locale: 'en' },
        profile: { displayName: null },
      });
  });
  await assert.rejects(f.capture(), failure('settings_changed'));
});

test('remote input is detached before hash waits and accessor input is not executed', async (t) => {
  const f = await fixture(t);
  const expected = structuredClone(f.remote);
  f.hashEffect(() => {
    f.remote.snapshot!.profile.displayName = 'Late caller mutation';
  });
  assert.deepEqual((await f.capture()).remote, expected);
  let invoked = false;
  const malicious = { ...expected };
  Object.defineProperty(malicious, 'snapshot', {
    enumerable: true,
    get() {
      invoked = true;
      return expected.snapshot;
    },
  });
  await assert.rejects(f.capture(malicious));
  assert.equal(invoked, false);
});
