import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueBoundary } from '@cookmate/catalogue';
import {
  AccountReplicationError,
  accountSnapshotsEqual,
  canonicalAccountSnapshot,
  mergeAccountSnapshots,
} from '@cookmate/account-sync';
import type {
  AccountReplicationScope,
  AccountReplicationJournal,
  AccountRemoteState,
  AccountSnapshot,
  AccountSnapshotV2,
  AccountSnapshotOptions,
} from '@cookmate/account-sync';
import type { CookMateServices, DirectActionInput, RepositoryResult } from '../src';
import { createAccountReplicationRepository } from '../../../apps/mobile/src/data/accountReplication';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_JOURNAL_MAX_BYTES,
  capture,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import { readRestoreEpoch } from '../../../apps/mobile/src/data/restoreEpoch';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  runBound,
} from '../../../apps/mobile/src/data/sql';
import { readShoppingLedgerInSnapshot } from '../../../apps/mobile/src/data/shoppingRepository';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const timestamp = '2026-09-30T12:00:00.000Z';
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const platform = {
  newId: randomUUID,
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
};
const projection = {
  sha256: platform.sha256,
  readRecipe: (id: string) => catalogue.recipes.find((item) => item.recipeId === id),
};
function ready<T>(result: RepositoryResult<T>): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
async function action(services: CookMateServices, input: DirectActionInput) {
  const review = ready(await services.commands.reviewDirect(input));
  const command = ready(await services.commands.prepareDirect(review));
  const result = await services.commands.execute(command);
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  return command;
}
const reason = (expected: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === expected;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('expanded capture owns its scope and rejects omitted or malformed scope authority', async () => {
  const f = await fixture();
  try {
    const local = (await f.repository.inspect(f.scope)).local;
    const expanded: AccountSnapshotV2 = {
      ...local.snapshot,
      schemaVersion: 2,
      personal: { notes: [], collections: [], memberships: [], manualItems: [] },
    };
    assert.throws(
      () => capture({ storeRevision: local.storeRevision, snapshot: expanded }),
      reason('stored_data_invalid'),
    );
    assert.throws(() => capture({ ...local, scope: undefined }), reason('invalid_input'));
    const scope = { version: 2 as const, approvalDigest: 'a'.repeat(64), historyIncluded: false };
    const captured = capture({ ...local, snapshot: expanded, scope });
    scope.historyIncluded = true;
    assert.equal(captured.scope?.version === 2 && captured.scope.historyIncluded, false);
  } finally {
    await f.close();
  }
});

test('legacy local apply stays gated while v2 journals decode without changing pending bytes', async () => {
  const f = await fixture();
  try {
    const local = (await f.repository.inspect(f.scope)).local;
    const expanded: AccountSnapshotV2 = {
      ...local.snapshot,
      schemaVersion: 2,
      personal: { notes: [], collections: [], memberships: [], manualItems: [] },
    };
    await assert.rejects(f.stage(expanded), reason('scope_review_required'));
    assert.equal((await f.repository.inspect(f.scope)).journal, null);
    const legacy = await f.stage();
    const scope = { version: 2 as const, approvalDigest: 'a'.repeat(64), historyIncluded: false };
    const upgraded: AccountReplicationJournal = {
      ...legacy,
      schemaVersion: 2,
      scope,
      pending: {
        ...legacy.pending!,
        capturedLocal: { ...local, snapshot: expanded, scope },
        proposed: expanded,
        proposedDigest: await platform.sha256(canonicalAccountSnapshot(expanded)),
      },
    };
    const serialized = JSON.stringify(upgraded);
    f.database
      .prepare('UPDATE app_metadata SET value=? WHERE key=?')
      .run(serialized, journalKey(ownerId));
    assert.deepEqual((await f.repository.inspect(f.scope)).journal, upgraded);
    assert.equal(
      f.database.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!
        .value,
      serialized,
    );
    await assert.rejects(f.apply(upgraded), reason('scope_review_required'));
    const invalidLegacy = { ...upgraded, schemaVersion: 1 };
    delete (invalidLegacy as { scope?: unknown }).scope;
    f.database
      .prepare('UPDATE app_metadata SET value=? WHERE key=?')
      .run(JSON.stringify(invalidLegacy), journalKey(ownerId));
    await assert.rejects(f.repository.inspect(f.scope), reason('stored_data_invalid'));
  } finally {
    await f.close();
  }
});
function server(snapshot: AccountSnapshot | null, revision = snapshot ? 1 : 0): AccountRemoteState {
  return {
    ownerId,
    revision,
    snapshot,
    updatedAt: snapshot ? timestamp : null,
    deletionOperationId: null,
  };
}

async function fixture(
  seed?: (
    services: CookMateServices,
    database: ReturnType<typeof desktopConnection>['database'],
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-account-'));
  const filename = join(directory, 'store.db');
  const initialConnections: ReturnType<typeof desktopConnection>[] = [];
  const initial = await createLocalStore({
    enablePortableRestore: true,
    enableCooking: true,
    enablePersonal: true,
    platform,
    now: () => timestamp,
    dateContext: () => ({ localDate: '2026-09-30', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    openConnection: async () => {
      const connection = desktopConnection(filename);
      initialConnections.push(connection);
      return connection.connection;
    },
  });
  assert.equal(initial.kind, 'ready', JSON.stringify(initial));
  if (initial.kind !== 'ready') assert.fail();
  await seed?.(initial.services, initialConnections[0]!.database);
  await initial.services.close();
  let scope: AccountReplicationScope | null = { ownerId, authGeneration: 1 };
  let settings: AccountSnapshotOptions = {
    appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
    profile: { displayName: null },
  };
  let write: ReturnType<typeof desktopConnection>;
  let writer: SerializedWriter;
  let reader: SerializedReader;
  let repository: ReturnType<typeof createAccountReplicationRepository>;
  let exclusive = false;
  let loseCommitResponse = false;
  const notifications: unknown[] = [];
  async function open() {
    const queue = new SqlTransactionQueue();
    write = desktopConnection(filename);
    const originalExec = write.connection.exec;
    write.connection.exec = async (sql) => {
      await originalExec(sql);
      if (sql === 'COMMIT' && loseCommitResponse) {
        loseCommitResponse = false;
        throw new Error('injected lost COMMIT response');
      }
    };
    const read = desktopConnection(filename);
    await configureConnection(write.connection);
    await configureConnection(read.connection);
    await read.connection.exec('PRAGMA query_only=ON');
    writer = new SerializedWriter(write.connection, queue);
    reader = new SerializedReader(read.connection, queue);
    repository = createAccountReplicationRepository({
      reader,
      writer,
      ...projection,
      catalogue: catalogue.identity,
      knownRecipeIds: catalogueBoundary.recipeIds,
      now: () => timestamp,
      currentScope: () => scope,
      getLocalSettings: () => settings,
      acquireExclusive: () => {
        if (exclusive) return null;
        exclusive = true;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            exclusive = false;
          }
        };
      },
      onCommitted: (change) => {
        assert.equal(exclusive, false);
        notifications.push(change);
      },
    });
  }
  await open();
  return {
    filename,
    notifications,
    get scope() {
      assert.ok(scope);
      return { ...scope };
    },
    get repository() {
      return repository;
    },
    get writer() {
      return writer;
    },
    get reader() {
      return reader;
    },
    get database() {
      return write.database;
    },
    setScope(value: AccountReplicationScope | null) {
      scope = value;
    },
    setSettings(value: AccountSnapshotOptions) {
      settings = copy(value);
    },
    loseNextCommitResponse() {
      loseCommitResponse = true;
    },
    get settings() {
      return copy(settings);
    },
    async stage(proposed?: AccountSnapshot, remote = server(null), mode: 'push' | 'pull' = 'push') {
      const inspection = await repository.inspect(this.scope);
      return repository.stage(this.scope, {
        operationId: randomUUID(),
        expectedJournalRevision: inspection.journal?.revision ?? 0,
        expectedDeviceDataOwnerId: inspection.deviceDataOwnerId,
        initialImportReviewed: true,
        capturedLocal: inspection.local,
        remote,
        proposed: proposed ?? inspection.local.snapshot,
        mode,
      });
    },
    async ack(journal: AccountReplicationJournal) {
      assert.ok(journal.pending);
      return repository.recordAcknowledgement(this.scope, {
        operationId: journal.pending.operationId,
        receipt: {
          ownerId,
          operationId: journal.pending.operationId,
          revision: journal.pending.remote.revision + 1,
          committedAt: timestamp,
        },
      });
    },
    async apply(journal: AccountReplicationJournal, snapshot?: AccountSnapshot) {
      const inspection = await repository.inspect(this.scope);
      return repository.apply(this.scope, {
        operationId: journal.pending!.operationId,
        expectedJournalRevision: inspection.journal!.revision,
        expectedLocal: inspection.local,
        rebased: snapshot ?? journal.pending!.proposed,
      });
    },
    async reopen() {
      await reader.close();
      await writer.close();
      await open();
    },
    async close() {
      await reader.close();
      await writer.close();
      await removeFixtureDirectory(directory);
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test('two devices converge repeatedly while dormant purchase safety history stays local', async () => {
  const a = await fixture(async (services) => {
    await action(services, {
      kind: 'placeRecipe',
      recipeId: '52835',
      placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
    });
    const plan = ready(await services.queries.readPlan('2026-09-30', '2026-09-30'));
    await action(services, {
      kind: 'setShoppingSelection',
      occurrenceIds: plan.occurrences.map((item) => item.occurrenceId),
    });
    await action(services, { kind: 'setShoppingSelection', occurrenceIds: [] });
  });
  const b = await fixture();
  try {
    const dormantCount = Number(
      a.database.prepare('SELECT COUNT(*) AS count FROM shopping_group').get()!.count,
    );
    assert.ok(dormantCount > 0);
    const shared = (await a.repository.inspect(a.scope)).local.snapshot;
    assert.equal(shared.shopping.purchaseMarks.length, 0);
    const uploaded = await a.ack(await a.stage(shared));
    await a.apply(uploaded);
    const cloud = server(shared, 1);
    for (let round = 0; round < 3; round++) {
      for (const device of [b, a]) {
        const pending = await device.stage(shared, cloud, 'pull');
        await device.apply(pending);
        const current = await device.repository.inspect(device.scope);
        assert.ok(accountSnapshotsEqual(current.local.snapshot, current.journal!.base!.snapshot!));
        assert.ok(accountSnapshotsEqual(current.local.snapshot, shared));
      }
    }
    assert.equal(
      Number(a.database.prepare('SELECT COUNT(*) AS count FROM shopping_group').get()!.count),
      dormantCount,
    );
    assert.equal(
      Number(b.database.prepare('SELECT COUNT(*) AS count FROM shopping_group').get()!.count),
      0,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

async function lateFavourite(f: Fixture, recipeId: string) {
  await f.writer.transaction(async (session) => {
    const revision =
      Number(
        (
          await session.all<{ revision: number }>(
            "SELECT revision FROM state_revision WHERE collection='store'",
          )
        )[0]!.revision,
      ) + 1;
    await runBound(session, 'INSERT INTO favourite VALUES (?,1,?,?,?)', [
      recipeId,
      revision,
      timestamp,
      timestamp,
    ]);
    await runBound(
      session,
      "UPDATE state_revision SET revision=? WHERE collection IN ('store','favourites')",
      [revision],
    );
  });
}

test('first account adoption needs explicit review and retains guest capture without private data', async () => {
  const f = await fixture(async (services, db) => {
    await action(services, { kind: 'setFavourite', recipeId: '52835', saved: true });
    db.prepare('UPDATE conversation SET composer_draft=?').run(
      JSON.stringify('private draft survives'),
    );
    db.prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)').run(
      randomUUID(),
      '52835',
      JSON.stringify('private note survives'),
      timestamp,
      timestamp,
    );
  });
  try {
    const inspected = await f.repository.inspect(f.scope);
    const input = {
      operationId: randomUUID(),
      expectedJournalRevision: 0,
      expectedDeviceDataOwnerId: null,
      initialImportReviewed: false,
      capturedLocal: inspected.local,
      remote: server(null),
      proposed: inspected.local.snapshot,
      mode: 'push' as const,
    };
    await assert.rejects(f.repository.stage(f.scope, input), reason('initial_review_required'));
    assert.equal((await f.repository.inspect(f.scope)).journal, null);
    const staged = await f.repository.stage(f.scope, { ...input, initialImportReviewed: true });
    assert.equal(staged.pending?.capturedLocal.snapshot.favourites[0]?.recipeId, '52835');
    assert.doesNotMatch(
      JSON.stringify(staged),
      /private draft|private note|composer_draft|accessToken/,
    );
    await f.reopen();
    assert.deepEqual(await f.repository.readInitialGuestCapture(f.scope), inspected.local);
    assert.match(
      f.database.prepare('SELECT composer_draft FROM conversation').get()!.composer_draft as string,
      /private draft survives/,
    );
    assert.match(
      f.database.prepare('SELECT text FROM recipe_note').get()!.text as string,
      /private note survives/,
    );
  } finally {
    await f.close();
  }
});

test('lost HTTP/reopen keeps exact operation; acknowledgement rebase preserves late edit and remote-only additions', async () => {
  const f = await fixture();
  try {
    const original = (await f.repository.inspect(f.scope)).local.snapshot;
    const proposed = copy(original);
    proposed.favourites.push({ recipeId: '52835', savedAt: timestamp });
    const staged = await f.stage(proposed);
    const operationId = staged.pending!.operationId;
    await f.reopen();
    assert.deepEqual((await f.repository.inspect(f.scope)).journal, staged);
    await lateFavourite(f, '52839');
    const acknowledged = await f.ack(staged);
    assert.equal(acknowledged.pending!.operationId, operationId);
    await f.reopen();
    const recovered = await f.repository.inspect(f.scope);
    const merged = mergeAccountSnapshots({
      base: recovered.journal!.pending!.capturedLocal.snapshot,
      local: recovered.local.snapshot,
      account: proposed,
    });
    assert.equal(merged.status, 'merged');
    if (merged.status !== 'merged') assert.fail();
    const receipt = await f.apply(recovered.journal!, merged.snapshot);
    await f.reopen();
    assert.deepEqual(await f.repository.readApplyReceipt(f.scope, operationId), receipt);
    const after = await f.repository.inspect(f.scope);
    assert.deepEqual(
      after.local.snapshot.favourites.map((item) => item.recipeId),
      ['52835', '52839'],
    );
    assert.ok(accountSnapshotsEqual(after.journal!.base!.snapshot!, proposed));
    assert.equal(after.journal!.pending, null);
    const next = mergeAccountSnapshots({
      base: after.journal!.base!.snapshot!,
      local: after.local.snapshot,
      account: proposed,
    });
    assert.equal(next.status, 'merged');
    if (next.status === 'merged')
      assert.deepEqual(
        next.snapshot.favourites.map((item) => item.recipeId),
        ['52835', '52839'],
      );
  } finally {
    await f.close();
  }
});

test('apply refuses stale local generation without advancing acknowledged base', async () => {
  const f = await fixture();
  try {
    const ack = await f.ack(await f.stage());
    const before = await f.repository.inspect(f.scope);
    await lateFavourite(f, '52835');
    await assert.rejects(
      f.repository.apply(f.scope, {
        operationId: ack.pending!.operationId,
        expectedJournalRevision: ack.revision,
        expectedLocal: before.local,
        rebased: ack.pending!.proposed,
      }),
      reason('local_changed'),
    );
    const after = await f.repository.inspect(f.scope);
    assert.equal(after.journal!.base, null);
    assert.ok(after.journal!.pending!.acknowledgement);
    assert.equal(after.local.snapshot.favourites.length, 1);
    assert.equal(f.notifications.length, 0);
  } finally {
    await f.close();
  }
});

test('final COMMIT guard rolls back account apply when auth owner/generation changes', async () => {
  const f = await fixture();
  try {
    const proposed = copy((await f.repository.inspect(f.scope)).local.snapshot);
    proposed.favourites.push({ recipeId: '52835', savedAt: timestamp });
    const ack = await f.ack(await f.stage(proposed));
    const originalScope = f.scope;
    f.writer.setObserver({
      begin: async () => {},
      beforeCommit: async () => {
        f.setScope({ ownerId, authGeneration: 2 });
      },
      committed: async () => {},
      failed: () => {},
    });
    await assert.rejects(f.apply(ack), reason('account_changed'));
    await f.reopen();
    f.setScope(originalScope);
    const after = await f.repository.inspect(f.scope);
    assert.equal(after.local.snapshot.favourites.length, 0);
    assert.equal(after.journal!.base, null);
    assert.equal(f.notifications.length, 0);
    assert.equal(await f.reader.transaction(readRestoreEpoch), 0);
  } finally {
    await f.close();
  }
});

test('settings projection is durable, carries previous value and never clears before matching controller CAS', async () => {
  const f = await fixture();
  try {
    const original = f.settings;
    const proposed = copy((await f.repository.inspect(f.scope)).local.snapshot);
    proposed.appPreferences.theme = 'dark';
    proposed.appPreferences.locale = 'ar';
    proposed.profile.displayName = 'Kitchen reader';
    const ack = await f.ack(await f.stage(proposed));
    await f.apply(ack);
    await f.reopen();
    const pending = (await f.repository.inspect(f.scope)).pendingSettings!;
    assert.deepEqual(pending.previous, original);
    assert.equal(pending.projection.appPreferences.theme, 'dark');
    await assert.rejects(
      f.repository.acknowledgeSettings(f.scope, pending),
      reason('settings_changed'),
    );
    await assert.rejects(f.stage(proposed, server(proposed)), reason('settings_pending'));
    f.setSettings(pending.projection);
    await f.repository.acknowledgeSettings(f.scope, pending);
    assert.equal((await f.repository.inspect(f.scope)).pendingSettings, null);
    assert.ok(
      accountSnapshotsEqual((await f.repository.inspect(f.scope)).local.snapshot, proposed),
    );
  } finally {
    await f.close();
  }
});

test('settings changes at the final COMMIT guard roll back journal stage atomically', async () => {
  const f = await fixture();
  try {
    f.writer.setObserver({
      begin: async () => {},
      beforeCommit: async () => {
        const next = f.settings;
        next.appPreferences.theme = 'dark';
        f.setSettings(next);
      },
      committed: async () => {},
      failed: () => {},
    });
    await assert.rejects(f.stage(), reason('settings_changed'));
    await f.reopen();
    const after = await f.repository.inspect(f.scope);
    assert.equal(after.journal, null);
    assert.equal(after.deviceDataOwnerId, null);
    assert.equal(await f.repository.readInitialGuestCapture(f.scope), null);
  } finally {
    await f.close();
  }
});

test('purchase adoption accepts only actual source demand fingerprints and preserves source quantities', async () => {
  const f = await fixture(async (services) => {
    await action(services, {
      kind: 'placeRecipe',
      recipeId: '52835',
      placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
    });
    const plan = ready(await services.queries.readPlan('2026-09-30', '2026-09-30'));
    await action(services, {
      kind: 'setShoppingSelection',
      occurrenceIds: plan.occurrences.map((item) => item.occurrenceId),
    });
  });
  try {
    const originalIngredients = f.database
      .prepare('SELECT * FROM ingredient_entry ORDER BY recipe_id,position')
      .all();
    const proposed = copy((await f.repository.inspect(f.scope)).local.snapshot);
    assert.ok(proposed.shopping.purchaseMarks.length > 1);
    proposed.shopping.purchaseMarks[0]!.purchased = true;
    proposed.shopping.purchaseMarks[1]!.purchased = true;
    proposed.shopping.purchaseMarks[1]!.demandFingerprint = 'f'.repeat(64);
    const ack = await f.ack(await f.stage(proposed));
    await f.apply(ack);
    const ledger = await f.reader.transaction((session) =>
      readShoppingLedgerInSnapshot(session, projection),
    );
    assert.equal(
      ledger.groups.find(
        (group) => group.groupKey === proposed.shopping.purchaseMarks[0]!.groupKey,
      )!.purchased,
      1,
    );
    const invalid = ledger.groups.find(
      (group) => group.groupKey === proposed.shopping.purchaseMarks[1]!.groupKey,
    )!;
    assert.equal(invalid.purchased, 0);
    assert.equal(invalid.changed, 1);
    assert.deepEqual(
      f.database.prepare('SELECT * FROM ingredient_entry ORDER BY recipe_id,position').all(),
      originalIngredients,
    );
  } finally {
    await f.close();
  }
});

test('proven CAS rejection preserves observed fence and guest backup without advancing merge base', async () => {
  const f = await fixture();
  try {
    const proposed = copy((await f.repository.inspect(f.scope)).local.snapshot);
    const staged = await f.stage(proposed, server(proposed, 4));
    const guest = await f.repository.readInitialGuestCapture(f.scope);
    const cleared = await f.repository.discardRejected(f.scope, {
      operationId: staged.pending!.operationId,
      expectedJournalRevision: staged.revision,
      reason: 'needs_review',
    });
    assert.equal(cleared.base, null);
    assert.equal(cleared.pending, null);
    assert.equal(cleared.observed!.revision, 4);
    await f.reopen();
    assert.deepEqual(await f.repository.readInitialGuestCapture(f.scope), guest);
    await assert.rejects(f.stage(proposed, server(proposed, 3)), reason('stale_server_revision'));
    const changed = copy(proposed);
    changed.appPreferences.theme = 'dark';
    await assert.rejects(f.stage(proposed, server(changed, 4)), reason('stale_server_revision'));
    const ack = await f.ack(await f.stage(proposed, server(proposed, 4)));
    await assert.rejects(
      f.repository.discardRejected(f.scope, {
        operationId: ack.pending!.operationId,
        expectedJournalRevision: ack.revision,
        reason: 'needs_review',
      }),
      reason('operation_changed'),
    );
  } finally {
    await f.close();
  }
});

test('owner binding prevents cross-account upload and rejects pending-deletion remote', async () => {
  const f = await fixture();
  try {
    const initial = await f.repository.inspect(f.scope);
    await assert.rejects(
      f.stage(initial.local.snapshot, { ...server(null), deletionOperationId: randomUUID() }),
      reason('deletion_pending'),
    );
    await f.stage();
    f.setScope({ ownerId: randomUUID(), authGeneration: 2 });
    const other = await f.repository.inspect(f.scope);
    assert.equal(other.deviceDataOwnerId, ownerId);
    assert.equal(other.journal, null);
    await assert.rejects(
      f.repository.stage(f.scope, {
        operationId: randomUUID(),
        expectedJournalRevision: 0,
        expectedDeviceDataOwnerId: ownerId,
        initialImportReviewed: true,
        capturedLocal: other.local,
        remote: { ...server(null), ownerId: f.scope.ownerId },
        proposed: other.local.snapshot,
        mode: 'push',
      }),
      reason('different_data_owner'),
    );
  } finally {
    await f.close();
  }
});

test('pull uses observed account state without fabricating a server receipt and cannot be discarded as failed upload', async () => {
  const f = await fixture();
  try {
    const proposed = copy((await f.repository.inspect(f.scope)).local.snapshot);
    proposed.favourites.push({ recipeId: '52835', savedAt: timestamp });
    const staged = await f.stage(proposed, server(proposed, 6), 'pull');
    await assert.rejects(f.ack(staged), reason('operation_changed'));
    await assert.rejects(
      f.repository.discardRejected(f.scope, {
        operationId: staged.pending!.operationId,
        expectedJournalRevision: staged.revision,
        reason: 'needs_review',
      }),
      reason('operation_changed'),
    );
    const receipt = await f.apply(staged);
    assert.equal(receipt.serverRevision, 6);
    assert.equal((await f.repository.inspect(f.scope)).journal!.base!.revision, 6);
  } finally {
    await f.close();
  }
});

test('corrupt, oversized and foreign-owner journal records fail closed', async () => {
  const f = await fixture();
  try {
    await f.stage();
    const original = f.database
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get(journalKey(ownerId))!.value as string;
    for (const bad of [
      'null',
      '{"schemaVersion":99}',
      JSON.stringify({ ...JSON.parse(original), ownerId: randomUUID() }),
    ]) {
      f.database
        .prepare('UPDATE app_metadata SET value=? WHERE key=?')
        .run(bad, journalKey(ownerId));
      await assert.rejects(f.repository.inspect(f.scope), reason('stored_data_invalid'));
    }
    f.database
      .prepare('UPDATE app_metadata SET value=? WHERE key=?')
      .run(' '.repeat(ACCOUNT_JOURNAL_MAX_BYTES + 1), journalKey(ownerId));
    await assert.rejects(f.repository.inspect(f.scope), reason('too_large'));
    f.database
      .prepare('UPDATE app_metadata SET value=? WHERE key=?')
      .run(original, journalKey(ownerId));
    f.database.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_BINDING_KEY);
    await assert.rejects(f.repository.inspect(f.scope), reason('stored_data_invalid'));
  } finally {
    await f.close();
  }
});

test('apply fences direct reviews held in another already-open facade', async () => {
  const f = await fixture();
  const sibling = await createLocalStore({
    enablePortableRestore: true,
    enableCooking: true,
    enablePersonal: true,
    platform,
    now: () => timestamp,
    dateContext: () => ({ localDate: '2026-09-30', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    openConnection: async () => desktopConnection(f.filename).connection,
  });
  assert.equal(sibling.kind, 'ready');
  if (sibling.kind !== 'ready') assert.fail();
  try {
    const review = ready(
      await sibling.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '52835',
        saved: true,
      }),
    );
    const ack = await f.ack(await f.stage());
    const receipt = await f.apply(ack);
    assert.equal(await f.reader.transaction(readRestoreEpoch), receipt.storeRevision);
    const prepared = await sibling.services.commands.prepareDirect(review);
    assert.equal(prepared.kind, 'failed');
    assert.equal((await f.repository.inspect(f.scope)).local.snapshot.favourites.length, 0);
  } finally {
    await sibling.services.close();
    await f.close();
  }
});

test('SQL failure before COMMIT leaves local data, journal base and receipt unadvanced after reopen', async () => {
  const f = await fixture();
  try {
    const proposed = copy((await f.repository.inspect(f.scope)).local.snapshot);
    proposed.favourites.push({ recipeId: '52835', savedAt: timestamp });
    const ack = await f.ack(await f.stage(proposed));
    f.writer.setObserver({
      begin: async () => {},
      beforeCommit: async () => {
        throw new Error('injected failure before COMMIT');
      },
      committed: async () => {},
      failed: () => {},
    });
    await assert.rejects(f.apply(ack), /injected failure/);
    await f.reopen();
    const after = await f.repository.inspect(f.scope);
    assert.deepEqual(after.journal, ack);
    assert.equal(after.local.snapshot.favourites.length, 0);
    assert.equal(await f.repository.readApplyReceipt(f.scope, ack.pending!.operationId), null);
    assert.equal(f.notifications.length, 0);
  } finally {
    await f.close();
  }
});

test('lost SQLite COMMIT acknowledgement is resolved only by the actual persisted apply receipt', async () => {
  const f = await fixture();
  try {
    const proposed = copy((await f.repository.inspect(f.scope)).local.snapshot);
    proposed.favourites.push({ recipeId: '52835', savedAt: timestamp });
    const ack = await f.ack(await f.stage(proposed));
    f.loseNextCommitResponse();
    const receipt = await f.apply(ack);
    assert.equal(receipt.operationId, ack.pending!.operationId);
    assert.equal(f.writer.requiresRecovery(), true);
    assert.deepEqual(await f.repository.readApplyReceipt(f.scope, receipt.operationId), receipt);
    assert.equal(f.notifications.length, 1);
    await f.reopen();
    assert.equal((await f.repository.inspect(f.scope)).local.snapshot.favourites.length, 1);
  } finally {
    await f.close();
  }
});

test('preference adoption withdraws only changed versions and preserves private conversation, notes and receipts', async () => {
  let changedId = '';
  let retainedId = '';
  const f = await fixture(async (services, db) => {
    const first = await action(services, {
      kind: 'savePreference',
      type: 'cuisine',
      explicitValue: 'Italian',
    });
    const second = await action(services, {
      kind: 'savePreference',
      type: 'ingredient_like',
      explicitValue: 'Tomato',
    });
    const items = ready(await services.queries.readPreferences()).items;
    const changed = items.find((item) => item.type === 'cuisine')!;
    const retained = items.find((item) => item.type === 'ingredient_like')!;
    changedId = changed.preferenceId;
    retainedId = retained.preferenceId;
    const conversationId = db.prepare('SELECT conversation_id FROM conversation').get()!
      .conversation_id as string;
    const messageId = randomUUID();
    db.prepare('INSERT INTO message VALUES (?,?,0,0,?,?,?,?)').run(
      messageId,
      conversationId,
      'user',
      JSON.stringify('private conversation'),
      'complete',
      timestamp,
    );
    db.prepare('UPDATE conversation SET next_sequence=1,composer_draft=?').run(
      JSON.stringify('private unsent draft'),
    );
    for (const [item, command] of [
      [changed, first],
      [retained, second],
    ] as const)
      db.prepare('INSERT INTO source_preference_link VALUES (?,?,?,?,?,NULL,?)').run(
        messageId,
        item.preferenceId,
        item.type,
        JSON.stringify(item.value),
        item.revision,
        command.operationId,
      );
    db.prepare('INSERT INTO recipe_note VALUES (?,?,?,0,1,?,?)').run(
      randomUUID(),
      '52835',
      JSON.stringify('private recipe annotation'),
      timestamp,
      timestamp,
    );
  });
  try {
    const privateTables = [
      'message',
      'conversation',
      'recipe_note',
      'operation_receipt',
      'cooking_event',
      'cooking_session',
      'manual_shopping_item',
    ];
    const before = privateTables.map((table) => f.database.prepare(`SELECT * FROM ${table}`).all());
    const unchanged = f.database
      .prepare('SELECT * FROM saved_preference WHERE preference_id=?')
      .get(retainedId);
    const proposed = copy((await f.repository.inspect(f.scope)).local.snapshot);
    proposed.preferences = proposed.preferences.filter((item) => item.preferenceId !== changedId);
    await f.apply(await f.ack(await f.stage(proposed)));
    assert.deepEqual(
      privateTables.map((table) => f.database.prepare(`SELECT * FROM ${table}`).all()),
      before,
    );
    assert.deepEqual(
      f.database.prepare('SELECT * FROM saved_preference WHERE preference_id=?').get(retainedId),
      unchanged,
    );
    assert.notEqual(
      f.database
        .prepare('SELECT removed_revision FROM source_preference_link WHERE preference_id=?')
        .get(changedId)!.removed_revision,
      null,
    );
    assert.equal(
      f.database
        .prepare('SELECT removed_revision FROM source_preference_link WHERE preference_id=?')
        .get(retainedId)!.removed_revision,
      null,
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM source_preference_link').get()!.count,
      2,
    );
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});

test('atomic plan slot swaps preserve occurrence identities and cross-week shopping selections', async () => {
  const f = await fixture(async (services) => {
    await action(services, {
      kind: 'placeRecipe',
      recipeId: '52835',
      placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
    });
    await action(services, {
      kind: 'placeRecipe',
      recipeId: '52839',
      placement: { actualDate: '2026-10-07', mealKey: 'lunch' },
    });
    const plan = ready(await services.queries.readPlan('2026-09-30', '2026-10-07'));
    await action(services, {
      kind: 'setShoppingSelection',
      occurrenceIds: plan.occurrences.map((item) => item.occurrenceId),
    });
  });
  try {
    const original = (await f.repository.inspect(f.scope)).local.snapshot;
    const proposed = copy(original);
    [proposed.plan[0]!.placement, proposed.plan[1]!.placement] = [
      proposed.plan[1]!.placement,
      proposed.plan[0]!.placement,
    ];
    await f.apply(await f.ack(await f.stage(proposed)));
    const result = (await f.repository.inspect(f.scope)).local.snapshot;
    assert.deepEqual(
      result.plan.map((item) => item.occurrenceId).sort(),
      original.plan.map((item) => item.occurrenceId).sort(),
    );
    assert.deepEqual(
      result.shopping.selectedOccurrenceIds,
      original.shopping.selectedOccurrenceIds,
    );
    const ledger = await f.reader.transaction((session) =>
      readShoppingLedgerInSnapshot(session, projection),
    );
    assert.equal(ledger.snapshot.selectedOccurrences.length, 2);
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    await f.close();
  }
});

test('unacknowledged pushes and malformed or reused acknowledgement receipts never advance the base', async () => {
  const f = await fixture();
  try {
    const staged = await f.stage();
    await assert.rejects(f.apply(staged), reason('acknowledgement_required'));
    const receipt = {
      ownerId,
      operationId: staged.pending!.operationId,
      revision: 9,
      committedAt: timestamp,
    };
    await assert.rejects(
      f.repository.recordAcknowledgement(f.scope, { operationId: receipt.operationId, receipt }),
      reason('invalid_input'),
    );
    await assert.rejects(
      f.repository.recordAcknowledgement(f.scope, {
        operationId: receipt.operationId,
        receipt: { ...receipt, revision: 1, extra: 'untrusted' } as typeof receipt,
      }),
      reason('invalid_input'),
    );
    const ack = await f.ack(staged);
    assert.deepEqual(await f.ack(staged), ack);
    assert.equal(ack.base, null);
    await assert.rejects(
      f.repository.recordAcknowledgement(f.scope, {
        operationId: receipt.operationId,
        receipt: { ...receipt, revision: 1, committedAt: '2026-09-30T12:01:00.000Z' },
      }),
      reason('operation_changed'),
    );
  } finally {
    await f.close();
  }
});

test('real facade composes account replication with its owned writer and refuses calls after close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-account-facade-'));
  const filename = join(directory, 'store.db');
  const scope = { ownerId, authGeneration: 1 };
  const result = await createLocalStore({
    enablePortableRestore: true,
    enableCooking: true,
    enablePersonal: true,
    platform,
    now: () => timestamp,
    dateContext: () => ({ localDate: '2026-09-30', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    accountReplication: {
      currentScope: () => scope,
      getLocalSettings: () => ({
        appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
        profile: { displayName: null },
      }),
    },
    openConnection: async () => desktopConnection(filename).connection,
  });
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  try {
    const repository = result.services.accountReplication!;
    assert.ok(repository);
    const before = await repository.inspect(scope);
    const proposed = copy(before.local.snapshot);
    proposed.favourites.push({ recipeId: '52835', savedAt: timestamp });
    const operationId = randomUUID();
    const staged = await repository.stage(scope, {
      operationId,
      expectedJournalRevision: 0,
      expectedDeviceDataOwnerId: null,
      initialImportReviewed: true,
      capturedLocal: before.local,
      remote: server(null),
      proposed,
      mode: 'push',
    });
    assert.equal(staged.pending!.operationId, operationId);
    const ack = await repository.recordAcknowledgement(scope, {
      operationId,
      receipt: { ownerId, operationId, revision: 1, committedAt: timestamp },
    });
    const current = await repository.inspect(scope);
    const receipt = await repository.apply(scope, {
      operationId,
      expectedJournalRevision: ack.revision,
      expectedLocal: current.local,
      rebased: proposed,
    });
    assert.equal(ready(await result.services.queries.readFavourites()).length, 1);
    assert.deepEqual(await repository.readApplyReceipt(scope, operationId), receipt);
    await result.services.close();
    await assert.rejects(repository.inspect(scope), reason('account_changed'));
    await assert.rejects(
      repository.readApplyReceipt(scope, operationId),
      reason('account_changed'),
    );
  } finally {
    await result.services.close();
    await removeFixtureDirectory(directory);
  }
});
