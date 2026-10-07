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
  type ContentLookup,
} from '@cookmate/catalogue/content';
import {
  AccountReplicationError,
  AccountRemoteError,
  type AccountSnapshotOptions,
} from '@cookmate/account-sync';
import { createAccountContentCoordinator } from '../../account-sync/src/contentCoordinator';
import type { AccountContentRemote } from '../../account-sync/src/contentRemote';
import { canonicalAccountContentSnapshot } from '../../account-sync/src/contentSnapshot';
import {
  createContentAccountServices,
  type ContentAccountServices,
  type ContentAccountServicesOptions,
} from '../../../apps/mobile/src/data/contentAccountServices';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_SETTINGS_KEY,
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
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Actual owner-bound schema8 services and SQLite. Remote/content ports below are controlled
// fixtures: no provider, HTTP, signed publication, runtime mounting or sign-in proof is claimed.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = '2026-10-01T12:00:00.000Z';
const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const settings = (): AccountSnapshotOptions => ({
  appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
  profile: { displayName: null },
});
const reason = (expected: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === expected;
type RemoteState = Awaited<ReturnType<AccountContentRemote['read']>>;
type CommitRequest = Parameters<AccountContentRemote['commit']>[0];
type CommitReceipt = Awaited<ReturnType<AccountContentRemote['commit']>>;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-account-coordinator-'));
  const filename = join(directory, 'store.db');
  const installationId = randomUUID(),
    scope = { ownerId, authGeneration: 1 };
  let write = desktopConnection(filename),
    read = desktopConnection(filename);
  let queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(write.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  async function configure() {
    await configureConnection(write.connection);
    await configureConnection(read.connection);
    await read.connection.exec('PRAGMA query_only=ON');
  }
  await configure();
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
  const recipeId = catalogue.recipes[0]!.recipeId;
  const retained = await createBundledRecipeRevision(recipeId, hash);
  await writer.transaction((session) => retainCookingRevisionInSnapshot(session, retained, hash));
  const occurrenceId = randomUUID(),
    noteId = randomUUID();
  write.database
    .prepare('INSERT INTO plan_occurrence VALUES (?,?,?,?,1,?,?)')
    .run(occurrenceId, recipeId, '2026-10-01', 'dinner', at, at);
  write.database
    .prepare('INSERT INTO plan_content_pin VALUES (?,?,?,?)')
    .run(occurrenceId, recipeId, retained.ref.revisionId, retained.ref.contentFingerprint);
  write.database
    .prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)')
    .run(noteId, recipeId, JSON.stringify('Private note retained across exact sync'), at, at);
  write.database.exec(
    "UPDATE state_revision SET revision=1 WHERE collection='store'; UPDATE personal_state SET revision=1",
  );
  let localSettings = settings(),
    held = false,
    live = true;
  const notifications: Parameters<ContentAccountServicesOptions['onCommitted']>[] = [];
  const inspections: (readonly string[])[] = [];
  const contentStore: ContentAccountServicesOptions['contentStore'] = {
    async withVerifiedReferenceInspection(head, refs, work) {
      assert.equal(head, null);
      inspections.push(refs.map((ref) => canonicalContentJson(ref)));
      let reserved = true;
      try {
        return await work({
          head: null,
          latestHead: null,
          adoptedRecipeIds: catalogue.recipes.map((recipe) => recipe.recipeId),
          entries: refs.map((ref) => {
            const lookup: ContentLookup =
              canonicalContentJson(ref) === canonicalContentJson(retained.ref)
                ? {
                    kind: 'readable',
                    state: 'current',
                    value: {
                      origin: 'packaged_baseline',
                      revision: retained,
                      publication: null,
                      retainedSources: [],
                    },
                  }
                : { kind: 'missing' };
            return { ref, lookup };
          }),
          assertActive() {
            assert.ok(reserved && live);
            return undefined;
          },
        });
      } finally {
        reserved = false;
      }
    },
  };
  async function createServices() {
    return createContentAccountServices({
      reader,
      writer,
      installationId,
      catalogue: catalogue.identity,
      scope,
      currentScope: () => (live ? scope : null),
      getLocalSettings: () => localSettings,
      now: () => at,
      newId: randomUUID,
      sha256: hash,
      contentStore,
      acquireExclusive() {
        if (held) return null;
        held = true;
        return () => {
          held = false;
        };
      },
      onCommitted(...args) {
        notifications.push(args);
      },
    });
  }
  let services: ContentAccountServices = await createServices();
  await services.approval.approve(scope, await services.approval.review(scope), {
    historyIncluded: false,
  });
  let cloud: RemoteState = {
    ownerId,
    revision: 0,
    snapshot: null,
    updatedAt: null,
    deletionOperationId: null,
  };
  const requests: CommitRequest[] = [],
    receipts = new Map<string, CommitReceipt>();
  let loseAck = false,
    project = true;
  const projected: string[] = [];
  const remote: AccountContentRemote = {
    ownerId,
    async read() {
      return structuredClone(cloud);
    },
    async commit(request) {
      const pending = (await services.journal.read(scope))?.pending;
      assert.ok(pending, 'actual SQL outbox exists before controlled remote dispatch');
      assert.equal(pending.operationId, request.operationId);
      assert.equal(
        canonicalAccountContentSnapshot(pending.proposed),
        canonicalAccountContentSnapshot(request.snapshot),
      );
      requests.push(structuredClone(request));
      const saved = receipts.get(request.operationId);
      if (saved) return structuredClone(saved);
      if (request.expectedRevision !== cloud.revision) throw new AccountRemoteError('needs_review');
      const receipt = {
        ownerId,
        operationId: request.operationId,
        revision: cloud.revision + 1,
        committedAt: at,
      };
      cloud = {
        ownerId,
        revision: receipt.revision,
        snapshot: structuredClone(request.snapshot),
        updatedAt: at,
        deletionOperationId: null,
      };
      receipts.set(request.operationId, receipt);
      if (loseAck) {
        loseAck = false;
        throw new AccountRemoteError('unavailable');
      }
      return structuredClone(receipt);
    },
  };
  // Deliberately pass the concrete facade directly: this call is also the structural type proof.
  function createCoordinator() {
    return createAccountContentCoordinator({
      scope,
      services,
      remote,
      isCurrent: () => live,
      newId: randomUUID,
      async projectSettings(pending, isCurrent) {
        assert.equal(isCurrent(), true);
        assert.ok(await services.apply.inspectSettings(scope));
        if (!project) return false;
        localSettings = structuredClone(pending.projection);
        projected.push(pending.operationId);
        return true;
      },
    });
  }
  let coordinator = createCoordinator();
  t.after(async () => {
    await coordinator.invalidate();
    live = false;
    services.close();
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  return {
    scope,
    recipeId,
    occurrenceId,
    noteId,
    retained,
    requests,
    inspections,
    notifications,
    projected,
    get services() {
      return services;
    },
    get coordinator() {
      return coordinator;
    },
    get db() {
      return write.database;
    },
    get cloud() {
      return cloud;
    },
    get localSettings() {
      return localSettings;
    },
    setCloud(value: RemoteState) {
      cloud = structuredClone(value);
    },
    loseAcknowledgement() {
      loseAck = true;
    },
    projectSettings(value: boolean) {
      project = value;
    },
    async reopen() {
      await coordinator.invalidate();
      services.close();
      await reader.close();
      await writer.close();
      write = desktopConnection(filename);
      read = desktopConnection(filename);
      await configure();
      queue = new SqlTransactionQueue();
      writer = new SerializedWriter(write.connection, queue);
      reader = new SerializedReader(read.connection, queue);
      services = await createServices();
      coordinator = createCoordinator();
    },
  };
}

test('actual bound schema8 coordinator reopens a lost remote ACK with the exact persisted operation and content pins', async (t) => {
  const f = await fixture(t);
  const before = await f.services.capture();
  await f.coordinator.sync();
  const initial = f.coordinator.getSnapshot();
  assert.equal(initial.kind, 'review');
  assert.equal(await f.services.journal.read(f.scope), null);
  f.loseAcknowledgement();
  await f.coordinator.confirm();
  assert.deepEqual(f.coordinator.getSnapshot(), {
    kind: 'failed',
    reason: 'unavailable',
    pending: true,
  });
  const pending = (await f.services.journal.read(f.scope))!.pending!;
  assert.equal(pending.acknowledgement, null);
  await assert.rejects(f.services.capture(), reason('operation_pending'));
  await f.reopen();
  await f.coordinator.sync();
  assert.equal(f.coordinator.getSnapshot().kind, 'synced');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0], f.requests[1]);
  const settled = (await f.services.journal.read(f.scope))!;
  assert.equal(settled.pending, null);
  assert.equal(settled.lastApply!.operationId, pending.operationId);
  assert.equal(settled.lastApply!.requestFingerprint, pending.requestFingerprint);
  assert.equal(
    (await f.services.apply.recover(f.scope, {
      operationId: pending.operationId,
      requestFingerprint: pending.requestFingerprint,
    }))!.operationId,
    pending.operationId,
  );
  const after = await f.services.capture();
  assert.deepEqual(after.snapshot.planReferences, before.snapshot.planReferences);
  assert.deepEqual(after.snapshot.personal.notes, before.snapshot.personal.notes);
  assert.equal(Object.hasOwn(after.snapshot, 'cookingHistory'), false);
  assert.ok(f.inspections.some((refs) => refs.includes(canonicalContentJson(f.retained.ref))));
  assert.equal(f.notifications.length, 1);
});

test('actual account pull settles projected settings before capture and resumes settings after physical reopen', async (t) => {
  const f = await fixture(t),
    before = await f.services.capture();
  f.setCloud({
    ownerId,
    revision: 4,
    updatedAt: at,
    deletionOperationId: null,
    snapshot: {
      ...before.snapshot,
      appPreferences: { ...before.snapshot.appPreferences, theme: 'dark' },
      profile: { displayName: 'Fixture account profile' },
    },
  });
  await f.coordinator.sync();
  f.coordinator.select('account');
  f.projectSettings(false);
  await f.coordinator.confirm();
  assert.deepEqual(f.coordinator.getSnapshot(), {
    kind: 'failed',
    reason: 'settings_changed',
    pending: false,
  });
  assert.equal(f.requests.length, 0);
  const pendingSettings = await f.services.apply.inspectSettings(f.scope);
  assert.ok(pendingSettings);
  await assert.rejects(f.services.capture(), reason('settings_pending'));
  const settled = (await f.services.journal.read(f.scope))!;
  assert.equal(settled.pending, null);
  assert.equal(settled.base!.revision, 4);
  await f.reopen();
  f.projectSettings(true);
  await f.coordinator.sync();
  assert.equal(f.coordinator.getSnapshot().kind, 'synced');
  assert.equal(f.localSettings.appPreferences.theme, 'dark');
  assert.deepEqual(f.projected, [pendingSettings.operationId]);
  assert.equal(await f.services.apply.inspectSettings(f.scope), null);
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(ACCOUNT_SETTINGS_KEY),
    undefined,
  );
  assert.deepEqual(
    (await f.services.capture()).snapshot.planReferences,
    before.snapshot.planReferences,
  );
  assert.equal(f.notifications.length, 1);
});

test('actual pull uses the issued apply removal review and keeps the accepted account base intact', async (t) => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO favourite VALUES (?,0,1,?,?)').run(f.recipeId, at, at);
  const before = await f.services.capture();
  f.setCloud({
    ownerId,
    revision: 2,
    updatedAt: at,
    deletionOperationId: null,
    snapshot: { ...before.snapshot, favourites: [{ recipeId: f.recipeId, savedAt: at }] },
  });
  await f.coordinator.sync();
  const push = f.coordinator.getSnapshot();
  assert.equal(push.kind, 'review');
  if (push.kind !== 'review' || push.phase !== 'push') assert.fail('expected issued push review');
  assert.equal(push.review.removalReview!.conflicts.length, 1);
  f.coordinator.select('account');
  await f.coordinator.confirm();
  const apply = f.coordinator.getSnapshot();
  if (apply.kind !== 'review' || apply.phase !== 'apply')
    assert.fail('expected exact apply review');
  assert.deepEqual(apply.review.blockers, ['removed_core_choices']);
  const removalId = apply.review.removalReview!.conflicts[0]!.id;
  const identity = {
    operationId: apply.review.operationId,
    requestFingerprint: apply.review.requestFingerprint,
  };
  await assert.rejects(
    f.services.apply.apply(f.scope, { ...apply.review }, undefined, { [removalId]: 'keep_local' }),
    reason('invalid_input'),
  );
  await f.coordinator.confirm();
  assert.deepEqual(f.coordinator.getSnapshot(), {
    kind: 'failed',
    reason: 'recovery_required',
    pending: true,
  });
  await f.coordinator.confirm({ [removalId]: 'keep_local' });
  assert.deepEqual(f.coordinator.getSnapshot(), { kind: 'local' });
  const settled = (await f.services.journal.read(f.scope))!;
  assert.equal(settled.pending, null);
  assert.equal(settled.lastApply!.operationId, identity.operationId);
  assert.deepEqual(settled.base!.snapshot!.favourites, [{ recipeId: f.recipeId, savedAt: at }]);
  assert.deepEqual((await f.services.capture()).snapshot.favourites, []);
  assert.equal(
    f.db.prepare('SELECT saved FROM favourite WHERE recipe_id=?').get(f.recipeId)!.saved,
    0,
  );
  assert.equal(f.requests.length, 0);
  assert.equal(f.notifications.length, 1);
});
