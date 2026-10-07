import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  AccountReplicationError,
  canonicalAccountSnapshot,
  canonicalAccountSyncScopeApproval,
  createAccountScopeApprovalEvidence,
  emptyAccountSnapshot,
} from '@cookmate/account-sync';
import type { AccountReplicationScope } from '@cookmate/account-sync';
import {
  ACCOUNT_SCOPE_APPROVAL_MAX_BYTES,
  accountScopeApprovalKey,
  createAccountScopeApprovalService,
  readAccountScopeApproval,
} from '../../../apps/mobile/src/data/accountScopeApproval';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_SETTINGS_KEY,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const reason = (expected: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === expected;

async function fixture(accountHistory = false) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-scope-'));
  const filename = join(directory, 'store.db');
  const storage = desktopConnection(filename);
  await configureConnection(storage.connection);
  const queue = new SqlTransactionQueue();
  const writer = new SerializedWriter(storage.connection, queue);
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
      ...(accountHistory ? { enableAccountHistory: true } : {}),
    },
  );
  const read = desktopConnection(filename);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const reader = new SerializedReader(read.connection, queue);
  let current: AccountReplicationScope | null = { ownerId, authGeneration: 1 };
  let afterWrite: (() => void) | undefined;
  let afterCommit: (() => void) | undefined;
  const originalPrepare = storage.connection.prepare;
  storage.connection.prepare = async (sql) => {
    const statement = await originalPrepare(sql);
    return {
      ...statement,
      run: async (values) => {
        await statement.run(values);
        if (
          sql.startsWith('INSERT INTO app_metadata') &&
          values[0] === accountScopeApprovalKey(ownerId)
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
    currentScope: () => current,
    now: () => at,
    newId: randomUUID,
    sha256: hash,
  };
  const db = storage.database;
  const metadata = (key: string, value: unknown) => {
    db.prepare(
      'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, JSON.stringify(value));
  };
  return {
    db,
    reader,
    writer,
    service: createAccountScopeApprovalService(options),
    recreate: () => createAccountScopeApprovalService(options),
    scope: { ownerId, authGeneration: 1 },
    setScope: (value: AccountReplicationScope | null) => {
      current = value;
    },
    afterWrite: (effect: () => void) => {
      afterWrite = effect;
    },
    afterCommit: (effect: () => void) => {
      afterCommit = effect;
    },
    metadata,
    bind: (id = ownerId) => metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId: id }),
    raw: (key: string) => db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value,
    async close() {
      await reader.close();
      await writer.close();
      await removeFixtureDirectory(directory);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function seedCounts(f: Fixture) {
  const recipes = catalogue.recipes.slice(0, 3);
  for (let index = 0; index < 2; index++) {
    f.db
      .prepare('INSERT INTO recipe_note VALUES (?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        recipes[index]!.recipeId,
        index ? null : JSON.stringify('PRIVATE NOTE'),
        index,
        1,
        at,
        at,
      );
    const collectionId = randomUUID();
    f.db
      .prepare('INSERT INTO personal_collection VALUES (?,?,?,?,?,?)')
      .run(collectionId, index ? null : JSON.stringify('PRIVATE COLLECTION'), index, 1, at, at);
    f.db
      .prepare('INSERT INTO personal_collection_member VALUES (?,?,?,?,?)')
      .run(collectionId, recipes[0]!.recipeId, Number(!index), 1, at);
    f.db
      .prepare('INSERT INTO manual_shopping_item VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        index ? null : JSON.stringify('PRIVATE ITEM'),
        null,
        null,
        index ? null : 'pantry',
        0,
        index,
        1,
        at,
        at,
      );
  }
  // These rows exercise SQL visibility discriminators; approval never reads receipt/entry payloads.
  for (const epoch of [0, 1]) {
    f.db
      .prepare('INSERT INTO cooking_event VALUES (?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        epoch,
        'saved',
        '2026-10-01',
        at,
        'a'.repeat(64),
        JSON.stringify({ private: 'HISTORY' }),
      );
  }
  f.db
    .prepare("INSERT INTO cooking_event VALUES (?,0,'cleared',NULL,NULL,NULL,NULL)")
    .run(randomUUID());
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
      JSON.stringify({ private: 'IMPORTED' }),
    );
}
function state(f: Fixture) {
  const names = [
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
  ];
  return names.map((name) => [name, f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
}
async function pendingV1() {
  const snapshot = emptyAccountSnapshot(catalogue.identity, {
    appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
    profile: { displayName: null },
  });
  return {
    schemaVersion: 1,
    ownerId,
    revision: 1,
    base: null,
    observed: { revision: 0, snapshotDigest: null, updatedAt: null },
    pending: {
      operationId: randomUUID(),
      mode: 'push',
      capturedLocal: { storeRevision: 0, snapshot },
      remote: { ownerId, revision: 0, snapshot: null, updatedAt: null, deletionOperationId: null },
      proposed: snapshot,
      proposedDigest: await hash(canonicalAccountSnapshot(snapshot)),
      acknowledgement: null,
    },
    lastApply: null,
  };
}

test('scope review is read-only, defaults history off, and counts actual current visible rows without text', async () => {
  const f = await fixture();
  try {
    seedCounts(f);
    const before = state(f);
    const review = await f.service.review(f.scope);
    assert.deepEqual(review.counts, {
      notes: 1,
      collections: 1,
      memberships: 1,
      manualItems: 1,
      cookingHistory: 2,
    });
    assert.equal(review.ownerId, ownerId);
    assert.equal(review.historyIncluded, false);
    assert.equal(review.previousApprovalDigest, null);
    assert.equal(Object.isFrozen(review), true);
    assert.equal(Object.isFrozen(review.counts), true);
    assert.doesNotMatch(JSON.stringify(review), /PRIVATE|HISTORY|IMPORTED/);
    assert.equal(await f.service.read(f.scope), null);
    assert.equal(f.raw(accountScopeApprovalKey(ownerId)), undefined);
    assert.deepEqual(state(f), before);
  } finally {
    await f.close();
  }
});

test('only deliberate exact review approval persists bounded owner evidence and survives service recreation', async () => {
  const f = await fixture();
  try {
    seedCounts(f);
    const before = state(f);
    const review = await f.service.review(f.scope);
    const approved = await f.service.approve(f.scope, review, { historyIncluded: true });
    assert.deepEqual(approved.record, {
      schemaVersion: 1,
      ownerId,
      scopeVersion: 2,
      personalApproved: true,
      historyIncluded: true,
      decidedAt: at,
    });
    assert.equal(approved.digest, await hash(canonicalAccountSyncScopeApproval(approved.record)));
    assert.ok(
      Buffer.byteLength(f.raw(accountScopeApprovalKey(ownerId)) as string) <=
        ACCOUNT_SCOPE_APPROVAL_MAX_BYTES,
    );
    assert.deepEqual(await f.recreate().read(f.scope), approved);
    assert.deepEqual(
      await f.reader.transaction((session) => readAccountScopeApproval(session, ownerId, hash)),
      approved,
    );
    assert.equal(Object.isFrozen(approved.record), true);
    assert.deepEqual(state(f), before);
    assert.equal(f.raw(ACCOUNT_BINDING_KEY), undefined);
    const next = await f.service.review(f.scope);
    assert.equal(next.historyIncluded, true);
    assert.equal(next.previousApprovalDigest, approved.digest);
    await f.service.approve(f.scope, next, { historyIncluded: false });
    assert.equal((await f.service.read(f.scope))?.record.historyIncluded, false);
    assert.deepEqual(state(f), before);
  } finally {
    await f.close();
  }
});

test('clones, other service capabilities, reused reviews, extra choices and changed auth generation cannot approve', async () => {
  const f = await fixture();
  try {
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
      f.service.approve(f.scope, review, { historyIncluded: false, approved: true } as {
        historyIncluded: boolean;
      }),
      reason('invalid_input'),
    );
    const nextScope = { ownerId, authGeneration: 2 };
    f.setScope(nextScope);
    await assert.rejects(
      f.service.approve(nextScope, review, { historyIncluded: false }),
      reason('account_changed'),
    );
    f.setScope(f.scope);
    await f.service.approve(f.scope, review, { historyIncluded: false });
    await assert.rejects(
      f.service.approve(f.scope, review, { historyIncluded: false }),
      reason('scope_review_required'),
    );
  } finally {
    await f.close();
  }
});

test('every captured data revision and epoch rejects a stale review without creating approval', async () => {
  const f = await fixture();
  try {
    for (const mutation of [
      "UPDATE state_revision SET revision=revision+1 WHERE collection='store'",
      'UPDATE personal_state SET revision=revision+1',
      'UPDATE personal_state SET epoch=epoch+1',
      'UPDATE cooking_state SET history_revision=history_revision+1',
      'UPDATE cooking_state SET history_epoch=history_epoch+1',
    ]) {
      const review = await f.service.review(f.scope);
      f.db.exec(mutation);
      await assert.rejects(
        f.service.approve(f.scope, review, { historyIncluded: false }),
        reason('local_changed'),
      );
      assert.equal(f.raw(accountScopeApprovalKey(ownerId)), undefined);
    }
    const review = await f.service.review(f.scope);
    seedCounts(f);
    await assert.rejects(
      f.service.approve(f.scope, review, { historyIncluded: false }),
      reason('local_changed'),
    );
  } finally {
    await f.close();
  }
});

test('an intervening approval invalidates the previous exact review even when local revisions are unchanged', async () => {
  const f = await fixture();
  try {
    const first = await f.service.review(f.scope);
    const second = await f.service.review(f.scope);
    const persisted = await f.service.approve(f.scope, first, { historyIncluded: false });
    await assert.rejects(
      f.service.approve(f.scope, second, { historyIncluded: true }),
      reason('scope_changed'),
    );
    assert.deepEqual(await f.service.read(f.scope), persisted);
  } finally {
    await f.close();
  }
});

test('pending v1 operation bytes are preserved and block both review and transactional approval', async () => {
  const f = await fixture();
  try {
    f.bind();
    const review = await f.service.review(f.scope);
    const raw = JSON.stringify(await pendingV1(), null, 2);
    f.db.prepare('INSERT INTO app_metadata VALUES (?,?)').run(journalKey(ownerId), raw);
    await assert.rejects(f.service.review(f.scope), reason('operation_pending'));
    await assert.rejects(
      f.service.approve(f.scope, review, { historyIncluded: false }),
      reason('operation_pending'),
    );
    assert.equal(f.raw(journalKey(ownerId)), raw);
    assert.equal(f.raw(accountScopeApprovalKey(ownerId)), undefined);
  } finally {
    await f.close();
  }
});

test('pending settings and owner-isolation corruption block review and approval without changing metadata', async () => {
  const f = await fixture();
  try {
    const review = await f.service.review(f.scope);
    f.metadata(ACCOUNT_SETTINGS_KEY, {
      ownerId,
      operationId: randomUUID(),
      previous: {},
      projection: {},
    });
    const raw = f.raw(ACCOUNT_SETTINGS_KEY);
    await assert.rejects(f.service.review(f.scope), reason('settings_pending'));
    await assert.rejects(
      f.service.approve(f.scope, review, { historyIncluded: true }),
      reason('settings_pending'),
    );
    assert.equal(f.raw(ACCOUNT_SETTINGS_KEY), raw);
    f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(ACCOUNT_SETTINGS_KEY);
    const journal = { ...(await pendingV1()), pending: null };
    f.metadata(journalKey(ownerId), journal);
    await assert.rejects(f.service.review(f.scope), reason('stored_data_invalid'));
    f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(journalKey(ownerId));
    f.metadata(journalKey(otherOwnerId), { private: 'foreign payload deliberately not decoded' });
    await assert.rejects(f.service.review(f.scope), reason('stored_data_invalid'));
    f.bind(otherOwnerId);
    await assert.rejects(f.service.review(f.scope), reason('different_data_owner'));
    await assert.rejects(f.service.read(f.scope), reason('different_data_owner'));
  } finally {
    await f.close();
  }
});

test('stored approvals must have exact fields, matching owner and recomputed digest within byte bound', async () => {
  const f = await fixture();
  try {
    const valid = await createAccountScopeApprovalEvidence(
      {
        schemaVersion: 1,
        ownerId,
        scopeVersion: 2,
        personalApproved: true,
        historyIncluded: false,
        decidedAt: at,
      },
      hash,
    );
    for (const value of [
      { ...valid, digest: '0'.repeat(64) },
      { ...valid, extra: true },
      { ...valid, record: { ...valid.record, approvedByUI: true } },
      { ...valid, record: { ...valid.record, ownerId: otherOwnerId } },
      { ...valid, record: { ...valid.record, personalApproved: false } },
      null,
    ]) {
      f.metadata(accountScopeApprovalKey(ownerId), value);
      await assert.rejects(f.service.read(f.scope), reason('stored_data_invalid'));
      await assert.rejects(f.service.review(f.scope), reason('stored_data_invalid'));
    }
    f.metadata(accountScopeApprovalKey(ownerId), {
      oversized: 'x'.repeat(ACCOUNT_SCOPE_APPROVAL_MAX_BYTES),
    });
    await assert.rejects(f.service.read(f.scope), reason('too_large'));
  } finally {
    await f.close();
  }
});

test('owner change after the SQL write rolls back approval; a change after COMMIT never returns success', async () => {
  const f = await fixture();
  try {
    const review = await f.service.review(f.scope);
    f.afterWrite(() => f.setScope(null));
    await assert.rejects(
      f.service.approve(f.scope, review, { historyIncluded: true }),
      reason('account_changed'),
    );
    assert.equal(f.raw(accountScopeApprovalKey(ownerId)), undefined);
    f.setScope(f.scope);
    const second = await f.service.review(f.scope);
    f.afterCommit(() => f.setScope({ ownerId: otherOwnerId, authGeneration: 2 }));
    await assert.rejects(
      f.service.approve(f.scope, second, { historyIncluded: false }),
      reason('account_changed'),
    );
    // The commit already happened; the original owner can recover the truthful persisted result.
    f.setScope(f.scope);
    assert.equal((await f.service.read(f.scope))?.record.historyIncluded, false);
  } finally {
    await f.close();
  }
});

test('the final commit admission catches auth changes during transaction cleanup', async () => {
  const f = await fixture();
  try {
    const review = await f.service.review(f.scope);
    f.writer.setObserver({
      begin: async () => undefined,
      beforeCommit: async () => {
        f.setScope({ ownerId, authGeneration: 2 });
      },
      committed: async () => assert.fail('A stale owner generation must not commit'),
      failed: () => undefined,
    });
    await assert.rejects(
      f.service.approve(f.scope, review, { historyIncluded: false }),
      reason('account_changed'),
    );
    assert.equal(f.raw(accountScopeApprovalKey(ownerId)), undefined);
  } finally {
    await f.close();
  }
});

test('binding changes and unknown schema versions fail closed without upgrading the database', async () => {
  const f = await fixture();
  try {
    const review = await f.service.review(f.scope);
    f.bind();
    await assert.rejects(
      f.service.approve(f.scope, review, { historyIncluded: false }),
      reason('different_data_owner'),
    );
    for (const version of [4, 7, 8]) {
      f.db.exec(`PRAGMA user_version=${version}`);
      await assert.rejects(f.service.review(f.scope), reason('stored_data_invalid'));
      await assert.rejects(f.service.read(f.scope), reason('stored_data_invalid'));
      assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, version);
    }
    assert.equal(f.raw(accountScopeApprovalKey(ownerId)), undefined);
  } finally {
    await f.close();
  }
});

test('actual schema six retains its supported scope2 approval without promoting consent', async () => {
  const f = await fixture(true);
  try {
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 6);
    const review = await f.service.review(f.scope);
    const evidence = await f.service.approve(f.scope, review, { historyIncluded: false });
    assert.equal(evidence.record.scopeVersion, 2);
    assert.deepEqual(await f.service.read(f.scope), evidence);
    assert.equal(f.db.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) count FROM app_metadata WHERE key GLOB 'account-replication:content-scope:*'",
        )
        .get()!.count,
      0,
    );
  } finally {
    await f.close();
  }
});
