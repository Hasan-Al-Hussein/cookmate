import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  AccountReplicationError,
  canonicalAccountSnapshot,
  createAccountScopeApprovalEvidence,
  emptyAccountSnapshot,
  type AccountReplicationScope,
  type AccountSnapshotOptions,
} from '@cookmate/account-sync';
import { cookingContentIdentity } from '../src/cooking';
import { createAccountContentScopeApprovalEvidence } from '../../account-sync/src/contentScope';
import {
  ACCOUNT_CONTENT_SCOPE_APPROVAL_MAX_BYTES,
  accountContentScopeApprovalKey,
  assertAccountContentApprovalAvailable,
  createAccountContentScopeApprovalService,
  readAccountContentCaptureFence,
  readAccountContentPendingCaptureFence,
  readAccountContentScopeApproval,
} from '../../../apps/mobile/src/data/accountContentScopeApproval';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_SETTINGS_KEY,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { accountScopeApprovalKey } from '../../../apps/mobile/src/data/accountScopeApproval';
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
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Actual disposable SQLite; private consent metadata only, not hosted sync or runtime activation.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const reason = (expected: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === expected;
const initialSettings = (): AccountSnapshotOptions => ({
  appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
  profile: { displayName: null },
});

async function fixture(t: TestContext, migrate = true) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-content-scope-'));
  const filename = join(directory, 'store.db');
  const storage = desktopConnection(filename);
  await configureConnection(storage.connection);
  const queue = new SqlTransactionQueue();
  const writer = new SerializedWriter(storage.connection, queue);
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
  if (migrate) await migrateCookingContentDatabase(writer, { sha256: hash });
  const read = desktopConnection(filename);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const reader = new SerializedReader(read.connection, queue);
  let current: AccountReplicationScope | null = { ownerId, authGeneration: 1 };
  let settings = initialSettings();
  let afterWrite: (() => void) | undefined;
  let afterCommit: (() => void) | undefined;
  let afterHash: (() => void) | undefined;
  let afterRead: ((sql: string) => void) | undefined;
  const selectedColumns: string[] = [];
  let largeTransfers = 0;
  for (const connection of [storage.connection, read.connection]) {
    const originalAll = connection.all;
    connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      const rows = await originalAll<Row>(sql, values);
      rows.forEach((row) => selectedColumns.push(...Object.keys(row)));
      for (const row of rows)
        for (const value of Object.values(row)) {
          if (
            (typeof value === 'string' && value.length > 100_000) ||
            (value instanceof Uint8Array && value.length > 100_000)
          )
            largeTransfers++;
        }
      afterRead?.(sql);
      return rows;
    };
  }
  const originalPrepare = storage.connection.prepare;
  storage.connection.prepare = async (sql) => {
    const statement = await originalPrepare(sql);
    return {
      ...statement,
      run: async (values) => {
        await statement.run(values);
        if (
          sql.startsWith('INSERT INTO app_metadata') &&
          values[0] === accountContentScopeApprovalKey(ownerId)
        ) {
          const effect = afterWrite;
          afterWrite = undefined;
          effect?.();
        }
      },
    };
  };
  const originalExec = storage.connection.exec;
  storage.connection.exec = async (sql) => {
    await originalExec(sql);
    if (sql === 'COMMIT') {
      const effect = afterCommit;
      afterCommit = undefined;
      effect?.();
    }
  };
  const options = {
    reader,
    writer,
    installationId,
    currentScope: () => current,
    getLocalSettings: () => settings,
    now: () => at,
    newId: randomUUID,
    sha256: async (text: string) => {
      const value = await hash(text);
      const effect = afterHash;
      afterHash = undefined;
      effect?.();
      return value;
    },
  };
  const service = createAccountContentScopeApprovalService(options);
  const db = storage.database;
  const metadata = (key: string, value: unknown) =>
    db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  t.after(async () => {
    service.close();
    await reader.close();
    await writer.close();
    await removeFixtureDirectory(directory);
  });
  return {
    db,
    reader,
    writer,
    service,
    installationId,
    options,
    selectedColumns,
    get largeTransfers() {
      return largeTransfers;
    },
    scope: { ownerId, authGeneration: 1 },
    recreate: () => createAccountContentScopeApprovalService(options),
    setScope: (value: AccountReplicationScope | null) => {
      current = value;
    },
    setSettings: (value: AccountSnapshotOptions) => {
      settings = value;
    },
    afterWrite: (effect: () => void) => {
      afterWrite = effect;
    },
    afterCommit: (effect: () => void) => {
      afterCommit = effect;
    },
    afterHash: (effect: () => void) => {
      afterHash = effect;
    },
    afterRead: (effect: (sql: string) => void) => {
      afterRead = effect;
    },
    metadata,
    bind: (id = ownerId) => metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId: id }),
    raw: (key: string) => db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function dataState(f: Fixture) {
  return [
    'state_revision',
    'personal_state',
    'recipe_note',
    'personal_collection',
    'personal_collection_member',
    'manual_shopping_item',
    'cooking_state',
    'cooking_session',
    'cooking_event',
    'cooking_history_clear',
    'imported_cooking_history',
    'cooking_history_withdrawal',
    'app_content_adoption',
    'plan_content_pin',
    'operation_receipt',
  ].map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
}

async function seedCounts(f: Fixture) {
  const recipe = catalogue.recipes[0]!;
  f.bind();
  f.db
    .prepare('INSERT INTO recipe_note VALUES (?,?,?,?,?,?,?)')
    .run(randomUUID(), recipe.recipeId, JSON.stringify('PRIVATE NOTE'), 0, 1, at, at);
  const collectionId = randomUUID();
  f.db
    .prepare('INSERT INTO personal_collection VALUES (?,?,?,?,?,?)')
    .run(collectionId, JSON.stringify('PRIVATE COLLECTION'), 0, 1, at, at);
  f.db
    .prepare('INSERT INTO personal_collection_member VALUES (?,?,?,?,?)')
    .run(collectionId, recipe.recipeId, 1, 1, at);
  f.db
    .prepare('INSERT INTO manual_shopping_item VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), JSON.stringify('PRIVATE ITEM'), null, null, 'pantry', 0, 0, 1, at, at);
  const localId = randomUUID(),
    hiddenId = randomUUID();
  // Counts may inspect visibility metadata, never these intentionally opaque payloads.
  for (const [eventId, epoch] of [
    [localId, 0],
    [randomUUID(), 1],
    [hiddenId, 0],
  ] as const)
    f.db
      .prepare('INSERT INTO cooking_event VALUES (?,?,?,?,?,?,?)')
      .run(
        eventId,
        epoch,
        'saved',
        '2026-10-01',
        at,
        'a'.repeat(64),
        JSON.stringify({ private: 'LOCAL PAYLOAD' }),
      );
  f.db.prepare('INSERT INTO cooking_history_withdrawal VALUES (?)').run(hiddenId);
  const restoreId = randomUUID();
  f.db
    .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
    .run(restoreId, 'b'.repeat(64), '{}', '{}', '{}');
  f.db
    .prepare('INSERT INTO imported_cooking_history VALUES (?,?,?,0,?,?,?)')
    .run(
      randomUUID(),
      randomUUID(),
      restoreId,
      '2026-10-01',
      at,
      JSON.stringify({ private: 'IMPORTED PAYLOAD' }),
    );
  const accountEntry = {
    ...(await cookingContentIdentity(recipe, catalogue.identity, hash)),
    eventId: localId,
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: 'PRIVATE ACCOUNT',
  };
  f.db
    .prepare('INSERT INTO account_cooking_history VALUES (?,?,?)')
    .run(ownerId, localId, JSON.stringify(accountEntry));
  f.db.exec('UPDATE cooking_state SET history_revision=1');
}

function settledJournal() {
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
async function pendingJournal() {
  const snapshot = emptyAccountSnapshot(catalogue.identity, initialSettings());
  return {
    ...settledJournal(),
    pending: {
      operationId: randomUUID(),
      mode: 'push',
      capturedLocal: { storeRevision: 0, snapshot },
      remote: { ownerId, revision: 0, snapshot: null, updatedAt: null, deletionOperationId: null },
      proposed: snapshot,
      proposedDigest: await hash(canonicalAccountSnapshot(snapshot)),
      acknowledgement: null,
    },
  };
}

test('actual8 consent rejects an old7 review and still requires private3 approval instead of promoting oldv2 evidence', async (t) => {
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
    hash,
  );
  f.metadata(accountScopeApprovalKey(ownerId), old);
  const oldBytes = f.raw(accountScopeApprovalKey(ownerId));
  const beforeMigrationReview = await f.service.review(f.scope);
  await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash });
  assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 8);
  await assert.rejects(
    f.service.approve(f.scope, beforeMigrationReview, { historyIncluded: true }),
    reason('local_changed'),
  );
  assert.equal(await f.service.read(f.scope), null);
  const before = dataState(f),
    review = await f.service.review(f.scope);
  assert.equal(review.historyIncluded, false);
  const evidence = await f.service.approve(f.scope, review, { historyIncluded: true });
  assert.deepEqual(await f.recreate().read(f.scope), evidence);
  const fence = await f.reader.transaction((session) =>
    readAccountContentCaptureFence(session, ownerId, f.installationId, hash, initialSettings()),
  );
  assert.equal(fence.databaseSchemaVersion, 8);
  assert.equal(fence.approval?.digest, evidence.digest);
  assert.equal(f.raw(accountScopeApprovalKey(ownerId)), oldBytes);
  assert.deepEqual(dataState(f), before);
});

test('private3 review is counts-only and read-only, defaults history off, and does not reuse v2 consent', async (t) => {
  const f = await fixture(t);
  await seedCounts(f);
  const old = await createAccountScopeApprovalEvidence(
    {
      schemaVersion: 1,
      ownerId,
      scopeVersion: 2,
      personalApproved: true,
      historyIncluded: true,
      decidedAt: at,
    },
    hash,
  );
  f.metadata(accountScopeApprovalKey(ownerId), old);
  const oldBytes = f.raw(accountScopeApprovalKey(ownerId));
  const before = dataState(f);
  const review = await f.service.review(f.scope);
  assert.deepEqual(review.counts, {
    notes: 1,
    collections: 1,
    memberships: 1,
    manualItems: 1,
    cookingHistory: 2,
  });
  assert.equal(review.scopeVersion, 3);
  assert.equal(review.installationId, f.installationId);
  assert.equal(review.historyIncluded, false);
  assert.equal(review.previousApprovalDigest, null);
  assert.equal(await f.service.read(f.scope), null);
  assert.equal(Object.isFrozen(review.counts), true);
  assert.doesNotMatch(JSON.stringify(review), /PRIVATE|PAYLOAD/);
  assert.ok(
    !f.selectedColumns.some((key) =>
      /^(receipt_?json|entry_?json|text_?json|name_?json|eventId)$/i.test(key),
    ),
  );
  assert.deepEqual(dataState(f), before);
  assert.equal(f.raw(accountScopeApprovalKey(ownerId)), oldBytes);
  assert.equal(f.raw(accountContentScopeApprovalKey(ownerId)), undefined);
});

test('deliberate exact review persists only installation-bound metadata; choice is owned before await', async (t) => {
  const f = await fixture(t);
  const before = dataState(f);
  const review = await f.service.review(f.scope);
  const choice = { historyIncluded: true };
  const pending = f.service.approve(f.scope, review, choice);
  choice.historyIncluded = false;
  const approved = await pending;
  assert.deepEqual(approved.record, {
    schemaVersion: 1,
    ownerId,
    installationId: f.installationId,
    scopeVersion: 3,
    personalApproved: true,
    historyIncluded: true,
    decidedAt: at,
  });
  assert.equal(Object.isFrozen(approved.record), true);
  assert.ok(
    Buffer.byteLength(f.raw(accountContentScopeApprovalKey(ownerId)) as string) <=
      ACCOUNT_CONTENT_SCOPE_APPROVAL_MAX_BYTES,
  );
  assert.deepEqual(await f.recreate().read(f.scope), approved);
  assert.deepEqual(
    await f.reader.transaction((session) =>
      readAccountContentScopeApproval(session, ownerId, f.installationId, hash),
    ),
    approved,
  );
  assert.equal(f.raw(ACCOUNT_BINDING_KEY), undefined);
  assert.deepEqual(dataState(f), before);
  const next = await f.service.review(f.scope);
  assert.equal(next.historyIncluded, true);
  assert.equal(next.previousApprovalDigest, approved.digest);
  await f.service.approve(f.scope, next, { historyIncluded: false });
  assert.equal((await f.service.read(f.scope))?.record.historyIncluded, false);
  assert.deepEqual(dataState(f), before);
});

test('cloned, foreign-service, reused, closed and generation-stale reviews cannot approve', async (t) => {
  const f = await fixture(t);
  const review = await f.service.review(f.scope);
  await assert.rejects(
    f.service.approve(f.scope, { ...review }, { historyIncluded: false }),
    reason('scope_review_required'),
  );
  await assert.rejects(
    f.recreate().approve(f.scope, review, { historyIncluded: false }),
    reason('scope_review_required'),
  );
  await assert.rejects(
    f.service.approve(f.scope, review, { historyIncluded: true, extra: true } as {
      historyIncluded: boolean;
    }),
    reason('invalid_input'),
  );
  f.setScope({ ownerId, authGeneration: 2 });
  await assert.rejects(
    f.service.approve({ ownerId, authGeneration: 2 }, review, { historyIncluded: true }),
    reason('account_changed'),
  );
  f.setScope(f.scope);
  await f.service.approve(f.scope, review, { historyIncluded: true });
  await assert.rejects(
    f.service.approve(f.scope, review, { historyIncluded: true }),
    reason('scope_review_required'),
  );
  const next = await f.service.review(f.scope);
  f.service.close();
  await assert.rejects(
    f.service.approve(f.scope, next, { historyIncluded: false }),
    reason('account_changed'),
  );
  await assert.rejects(f.service.read(f.scope), reason('account_changed'));
  f.options.getLocalSettings = () => assert.fail('Closed service must not read private settings');
  await assert.rejects(f.service.review(f.scope), reason('account_changed'));
});

test('store, personal/history clocks, adoption, restore and settings changes stale exact reviews', async (t) => {
  const f = await fixture(t);
  for (const mutation of [
    "UPDATE state_revision SET revision=revision+1 WHERE collection='store'",
    'UPDATE personal_state SET revision=revision+1',
    'UPDATE personal_state SET epoch=epoch+1',
    'UPDATE cooking_state SET history_revision=history_revision+1',
    'UPDATE cooking_state SET history_epoch=history_epoch+1',
    'UPDATE app_content_adoption SET revision=revision+1',
  ]) {
    const review = await f.service.review(f.scope);
    f.db.exec(mutation);
    await assert.rejects(
      f.service.approve(f.scope, review, { historyIncluded: false }),
      reason('local_changed'),
    );
  }
  const restored = await f.service.review(f.scope);
  f.db
    .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
    .run(randomUUID(), 'a'.repeat(64), '{}', '{}', '{}');
  await assert.rejects(
    f.service.approve(f.scope, restored, { historyIncluded: false }),
    reason('local_changed'),
  );
  const settings = await f.service.review(f.scope);
  f.setSettings({ ...initialSettings(), profile: { displayName: 'Changed privately' } });
  await assert.rejects(
    f.service.approve(f.scope, settings, { historyIncluded: false }),
    reason('local_changed'),
  );
  assert.equal(f.raw(accountContentScopeApprovalKey(ownerId)), undefined);
});

test('a changed observed journal or prior content approval requires a fresh scope review', async (t) => {
  const f = await fixture(t);
  f.bind();
  f.metadata(journalKey(ownerId), settledJournal());
  const review = await f.service.review(f.scope);
  f.metadata(journalKey(ownerId), {
    ...settledJournal(),
    revision: 2,
    observed: { revision: 1, snapshotDigest: 'b'.repeat(64), updatedAt: at },
  });
  await assert.rejects(
    f.service.approve(f.scope, review, { historyIncluded: true }),
    reason('scope_changed'),
  );
  const first = await f.service.review(f.scope),
    second = await f.service.review(f.scope);
  const saved = await f.service.approve(f.scope, first, { historyIncluded: false });
  await assert.rejects(
    f.service.approve(f.scope, second, { historyIncluded: true }),
    reason('scope_changed'),
  );
  assert.deepEqual(await f.service.read(f.scope), saved);
});

test('old pending journals and settings block consent without changing any retained bytes', async (t) => {
  const f = await fixture(t);
  f.bind();
  const review = await f.service.review(f.scope);
  const bytes = JSON.stringify(await pendingJournal(), null, 2);
  f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(journalKey(ownerId), bytes);
  await assert.rejects(f.service.review(f.scope), reason('operation_pending'));
  await assert.rejects(
    f.service.approve(f.scope, review, { historyIncluded: false }),
    reason('operation_pending'),
  );
  await assert.rejects(
    f.reader.transaction((session) =>
      assertAccountContentApprovalAvailable(session, ownerId, hash),
    ),
    reason('operation_pending'),
  );
  assert.equal(f.raw(journalKey(ownerId)), bytes);
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(journalKey(ownerId));
  f.metadata(ACCOUNT_SETTINGS_KEY, null);
  await assert.rejects(f.service.review(f.scope), reason('settings_pending'));
  assert.equal(f.raw(ACCOUNT_SETTINGS_KEY), 'null');
  assert.equal(f.raw(accountContentScopeApprovalKey(ownerId)), undefined);
});

test('foreign journals are denied without reading their payload; known null journals are corruption', async (t) => {
  const f = await fixture(t);
  f.bind();
  f.metadata(journalKey(otherOwnerId), { private: 'FOREIGN CONTENT' });
  await assert.rejects(f.service.review(f.scope), reason('stored_data_invalid'));
  assert.equal(f.selectedColumns.includes('bytes'), true); // current owner binding only
  const foreignRaw = f.raw(journalKey(otherOwnerId));
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(journalKey(otherOwnerId));
  f.metadata(journalKey(ownerId), null);
  await assert.rejects(f.service.review(f.scope), reason('stored_data_invalid'));
  assert.equal(f.raw(journalKey(ownerId)), 'null');
  assert.match(String(foreignRaw), /FOREIGN CONTENT/);
  f.bind(otherOwnerId);
  await assert.rejects(f.service.read(f.scope), reason('different_data_owner'));
});

test('stored approval requires exact owner/install/digest/keys and rejects null or oversized bytes', async (t) => {
  const f = await fixture(t);
  const key = accountContentScopeApprovalKey(ownerId);
  const evidence = await createAccountContentScopeApprovalEvidence(
    {
      schemaVersion: 1,
      ownerId,
      installationId: f.installationId,
      scopeVersion: 3,
      personalApproved: true,
      historyIncluded: false,
      decidedAt: at,
    },
    hash,
  );
  for (const value of [
    null,
    { ...evidence, extra: true },
    { ...evidence, digest: '0'.repeat(64) },
    { ...evidence, record: { ...evidence.record, installationId: randomUUID() } },
    { ...evidence, record: { ...evidence.record, ownerId: otherOwnerId } },
    { ...evidence, record: { ...evidence.record, scopeVersion: 2 } },
  ]) {
    f.metadata(key, value);
    await assert.rejects(f.service.read(f.scope), reason('stored_data_invalid'));
  }
  f.metadata(key, { huge: 'x'.repeat(ACCOUNT_CONTENT_SCOPE_APPROVAL_MAX_BYTES) });
  await assert.rejects(f.service.read(f.scope), reason('too_large'));
  f.metadata(key, evidence);
  f.db.prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'").run(randomUUID());
  await assert.rejects(f.service.read(f.scope), reason('stored_data_invalid'));
});

test('scope guards stop follow-up SQL after awaited query/hash owner loss and close', async (t) => {
  const f = await fixture(t);
  const review = await f.service.review(f.scope);
  await f.service.approve(f.scope, review, { historyIncluded: true });
  f.afterHash(() => f.setScope(null));
  await assert.rejects(f.service.review(f.scope), reason('account_changed'));
  f.setScope(f.scope);
  let count = 0;
  f.afterRead((sql) => {
    count++;
    if (sql.includes("key='installation_id'")) f.service.close();
    else if (count > 3) assert.fail('No follow-up private reads after close');
  });
  await assert.rejects(f.service.read(f.scope), reason('account_changed'));
  assert.equal(count, 3); // foreign_keys, schema, installation
});

test('owner/settings changes after SQL write or before final commit roll back approval', async (t) => {
  const f = await fixture(t);
  const review = await f.service.review(f.scope);
  f.afterWrite(() => f.setScope(null));
  await assert.rejects(
    f.service.approve(f.scope, review, { historyIncluded: true }),
    reason('account_changed'),
  );
  assert.equal(f.raw(accountContentScopeApprovalKey(ownerId)), undefined);
  f.setScope(f.scope);
  const next = await f.service.review(f.scope);
  f.writer.setObserver({
    begin: async () => undefined,
    beforeCommit: async () => {
      f.setSettings({ ...initialSettings(), profile: { displayName: 'Changed' } });
    },
    committed: async () => assert.fail('Stale settings must not commit'),
    failed: () => undefined,
  });
  await assert.rejects(
    f.service.approve(f.scope, next, { historyIncluded: false }),
    reason('local_changed'),
  );
  assert.equal(f.raw(accountContentScopeApprovalKey(ownerId)), undefined);
});

test('successful COMMIT followed by owner loss never delivers success; original owner reads evidence', async (t) => {
  const f = await fixture(t);
  const review = await f.service.review(f.scope);
  f.afterCommit(() => f.setScope({ ownerId: otherOwnerId, authGeneration: 2 }));
  await assert.rejects(
    f.service.approve(f.scope, review, { historyIncluded: false }),
    reason('account_changed'),
  );
  f.setScope(f.scope);
  assert.equal((await f.recreate().read(f.scope))?.record.historyIncluded, false);
});

test('lost COMMIT acknowledgement keeps durable consent readable without rewriting old operations', async (t) => {
  const f = await fixture(t);
  f.bind();
  f.metadata(journalKey(ownerId), settledJournal());
  const bytes = f.raw(journalKey(ownerId));
  const before = dataState(f);
  const review = await f.service.review(f.scope);
  f.afterCommit(() => {
    throw new Error('fixture lost acknowledgement');
  });
  await assert.rejects(
    f.service.approve(f.scope, review, { historyIncluded: true }),
    /lost acknowledgement/,
  );
  assert.equal((await f.recreate().read(f.scope))?.record.historyIncluded, true);
  assert.equal(f.raw(journalKey(ownerId)), bytes);
  assert.deepEqual(dataState(f), before);
});

test('shared capture fence is immutable and private-schema-only; wrong installation or binding cannot approve', async (t) => {
  const f = await fixture(t);
  const fence = await f.reader.transaction((session) =>
    readAccountContentCaptureFence(session, ownerId, f.installationId, hash, initialSettings()),
  );
  assert.equal(fence.approval, null);
  assert.equal(fence.binding, null);
  assert.equal(Object.isFrozen(fence.counts), true);
  assert.equal(fence.adoption, '{"head":null,"revision":0}');
  const review = await f.service.review(f.scope);
  f.bind();
  await assert.rejects(
    f.service.approve(f.scope, review, { historyIncluded: false }),
    reason('different_data_owner'),
  );
  for (const version of [6, 9]) {
    f.db.exec(`PRAGMA user_version=${version}`);
    await assert.rejects(f.service.review(f.scope), reason('stored_data_invalid'));
    await assert.rejects(f.service.read(f.scope), reason('stored_data_invalid'));
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, version);
  }
  assert.equal(f.raw(accountContentScopeApprovalKey(ownerId)), undefined);
});

for (const schema of [7, 8])
  for (const clock of ['adoption', 'restore'] as const) {
    test(`schema${schema} ${clock} clock rejects oversized/corrupt scalars before bridge transfer`, async (t) => {
      const f = await fixture(t);
      if (schema === 8) await migrateAccountContentHistoryDatabase(f.writer, { sha256: hash });
      f.bind();
      if (clock === 'restore')
        f.db
          .prepare('INSERT INTO portable_restore_operation VALUES (?,?,0,1,?,?,?)')
          .run(randomUUID(), 'a'.repeat(64), '{}', '{}', '{}');
      f.db.exec('PRAGMA ignore_check_constraints=ON');
      const update =
        clock === 'adoption'
          ? 'UPDATE app_content_adoption SET revision=?'
          : 'UPDATE portable_restore_operation SET committed_revision=?';
      for (const bad of ['X'.repeat(1024 * 1024), Buffer.alloc(1024 * 1024), -1, 0.5, 2 ** 53]) {
        const review = await f.service.review(f.scope);
        f.db.prepare(update).run(bad);
        for (const work of [
          () => f.service.review(f.scope),
          () => f.service.approve(f.scope, review, { historyIncluded: false }),
          () =>
            f.reader.transaction((session) =>
              readAccountContentCaptureFence(
                session,
                ownerId,
                f.installationId,
                hash,
                initialSettings(),
              ),
            ),
          () =>
            f.reader.transaction((session) =>
              readAccountContentPendingCaptureFence(
                session,
                ownerId,
                f.installationId,
                hash,
                initialSettings(),
                { operationId: randomUUID(), requestFingerprint: 'b'.repeat(64) },
              ),
            ),
        ])
          await assert.rejects(work(), reason('stored_data_invalid'));
        // Reading existing consent is deliberately independent of workspace/body clocks.
        assert.equal(await f.service.read(f.scope), null);
        assert.equal(f.largeTransfers, 0);
        assert.equal(f.raw(accountContentScopeApprovalKey(ownerId)), undefined);
        f.db.prepare(update).run(clock === 'restore' ? 1 : 0);
      }
    });
  }
