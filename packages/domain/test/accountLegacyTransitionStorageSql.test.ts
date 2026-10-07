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
  type AccountSnapshot,
  type AccountSnapshotV2,
} from '@cookmate/account-sync';
import {
  ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES,
  accountLegacyContentTransitionFingerprint,
  serializeAccountLegacyContentTransition,
  type AccountLegacyContentTransition,
} from '../../account-sync/src/contentLegacyTransition';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../account-sync/src/contentSnapshot';
import {
  accountContentPendingFingerprint,
  serializeAccountContentJournal,
  type AccountContentReplicationJournal,
} from '../../account-sync/src/contentReplicationRecords';
import { cookingContentIdentity } from '../src/cooking';
import { readAccountLegacyContentTransitionState } from '../../../apps/mobile/src/data/accountLegacyTransitionStorage';
import { accountLegacyContentTransitionKey } from '../../../apps/mobile/src/data/accountLegacyTransitionKeys';
import { convertBundledLegacyAccountSnapshot } from '../../../apps/mobile/src/data/accountLegacyContentConversion';
import { accountContentJournalKey } from '../../../apps/mobile/src/data/accountContentJournalStorage';
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
  type SqlSession,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

// Actual migrated disposable SQLite; seeded operation records are integrity fixtures, not
// proof of authenticated HTTP, user approval or real local execution.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z',
  serverAt = '2026-10-01T12:00:00.123456+00:00',
  committedAt = '2026-10-01T12:01:00.654321+00:00';
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const mutableContent = (value: unknown): AccountContentSnapshot =>
  JSON.parse(canonicalAccountContentSnapshot(value)) as AccountContentSnapshot;
const failure =
  (...expected: string[]) =>
  (error: unknown) =>
    error instanceof AccountReplicationError && expected.includes(error.reason);
function draftOf(value: AccountLegacyContentTransition) {
  const {
    schemaVersion: _schema,
    kind: _kind,
    revision: _revision,
    requestFingerprint: _fingerprint,
    acknowledgement: _ack,
    handoff: _handoff,
    lastApply: _last,
    ...draft
  } = value;
  return draft;
}
async function seal(value: AccountLegacyContentTransition) {
  value.requestFingerprint = await accountLegacyContentTransitionFingerprint(
    draftOf(value),
    sha256,
  );
  return value;
}
async function fixture(t: TestContext, options: { schema?: 7 | 8; expanded?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-legacy-transition-storage-'));
  const path = join(directory, 'storage.db');
  const write = desktopConnection(path),
    read = desktopConnection(path);
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
  const raw = (key: string, value: string) =>
    db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  const metadata = (key: string, value: unknown) => raw(key, JSON.stringify(value));
  metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId });
  const original = emptyAccountSnapshot(catalogue.identity, {
    appPreferences: { theme: 'dark', motion: 'system', locale: 'en' },
    profile: { displayName: null },
  });
  const recipe = catalogue.recipes[0]!;
  original.plan = [
    {
      occurrenceId: randomUUID(),
      recipeId: recipe.recipeId,
      placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
      createdAt: at,
      updatedAt: at,
    },
  ];
  let source: AccountSnapshot = original;
  if (options.expanded) {
    const expanded: AccountSnapshotV2 = {
      ...original,
      schemaVersion: 2,
      personal: {
        notes: [
          {
            noteId: randomUUID(),
            recipeId: recipe.recipeId,
            text: ' Exact note\nكمية 🍲 ',
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
            eventId: randomUUID(),
            ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
            recipeTitle: recipe.title,
            photoKey: recipe.photoKey,
            cookedOn: '2026-10-01',
            timeZone: 'Asia/Dubai',
            recordedAt: at,
            note: ' original ',
          },
        ],
        removedEventIds: [randomUUID()],
      },
    };
    source = expanded;
  }
  const remote = {
    ownerId,
    revision: 4,
    snapshot: source,
    updatedAt: serverAt,
    deletionOperationId: null,
  };
  const shared = {
    ownerId,
    revision: 1,
    base: clone(remote),
    observed: {
      revision: 4,
      snapshotDigest: await sha256(canonicalAccountSnapshot(source)),
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
  const old: AccountReplicationJournal = options.expanded
    ? {
        ...shared,
        schemaVersion: 2,
        scope: { version: 2, approvalDigest: 'a'.repeat(64), historyIncluded: true },
      }
    : { ...shared, schemaVersion: 1 };
  raw(journalKey(ownerId), JSON.stringify(old, null, 2));
  db.exec("UPDATE state_revision SET revision=5 WHERE collection='store'");
  await migrateCookingContentDatabase(writer, { sha256 });
  if (options.schema !== 7) await migrateAccountContentHistoryDatabase(writer, { sha256 });
  const conversion = await convertBundledLegacyAccountSnapshot(source, sha256);
  const oldBytes = String(
    db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!.value,
  );
  const transition = await seal({
    schemaVersion: 1,
    kind: 'legacy_to_content3',
    ownerId,
    installationId,
    revision: 1,
    legacy: {
      journalDigest: await sha256(oldBytes),
      journalRevision: old.revision,
      base: clone(old.base),
      observed: clone(old.observed!),
      baseProjectionDigest: conversion.convertedDigest,
    },
    remote,
    remoteDigest: conversion.sourceDigest,
    remoteProjectionDigest: conversion.convertedDigest,
    capturedLocal: {
      storeRevision: 5,
      snapshot: mutableContent(conversion.snapshot),
      scope: {
        version: 3,
        approvalDigest: 'b'.repeat(64),
        historyIncluded: options.expanded === true,
      },
      fenceDigest: 'c'.repeat(64),
    },
    networkOperationId: randomUUID(),
    localApplyOperationId: randomUUID(),
    proposed: mutableContent(conversion.snapshot),
    proposedDigest: conversion.convertedDigest,
    review: { initialImportReviewed: false, resolutions: {} },
    requestFingerprint: '0'.repeat(64),
    acknowledgement: null,
    handoff: null,
    lastApply: null,
  });
  const persist = async (value = transition) => {
    await seal(value);
    raw(
      accountLegacyContentTransitionKey(ownerId),
      await serializeAccountLegacyContentTransition(value, ownerId, installationId, sha256),
    );
  };
  await persist();
  const sqlLog: string[] = [],
    transferred: unknown[] = [];
  let beforeQuery: ((sql: string, values: readonly SqlValue[]) => void) | undefined;
  const load = (hash = sha256, owner = ownerId, install = installationId) =>
    reader.transaction(
      async (session) => {
        const guarded: SqlSession = {
          all: async <Row extends object>(sql: string, values: readonly SqlValue[] = []) => {
            sqlLog.push(sql);
            beforeQuery?.(sql, values);
            const result = await session.all<Row>(sql, values);
            transferred.push(...result);
            return result;
          },
          exec: async () => assert.fail('read-only helper attempted exec'),
          prepare: async () => assert.fail('read-only helper attempted prepare'),
        };
        return readAccountLegacyContentTransitionState(guarded, owner, install, hash);
      },
      { kind: 'read_only' },
    );
  return {
    db,
    reader,
    writer,
    old,
    oldBytes,
    transition,
    installationId,
    persist,
    raw,
    metadata,
    load,
    sqlLog,
    transferred,
    beforeQuery(effect: (sql: string, values: readonly SqlValue[]) => void) {
      beforeQuery = effect;
    },
    async saveContent(value: AccountContentReplicationJournal) {
      raw(
        accountContentJournalKey(ownerId),
        await serializeAccountContentJournal(value, ownerId, installationId, sha256),
      );
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function linked(f: Fixture): Promise<AccountContentReplicationJournal> {
  const value = f.transition;
  value.acknowledgement = {
    ownerId,
    operationId: value.networkOperationId,
    revision: value.remote.revision + 1,
    committedAt,
  };
  const remote = {
    ownerId,
    revision: value.acknowledgement.revision,
    snapshot: clone(value.proposed),
    updatedAt: committedAt,
    deletionOperationId: null,
  };
  const pendingDraft = {
    operationId: value.localApplyOperationId,
    mode: 'pull' as const,
    capturedLocal: clone(value.capturedLocal),
    remote,
    proposed: clone(value.proposed),
  };
  const requestFingerprint = await accountContentPendingFingerprint(
    ownerId,
    f.installationId,
    value.legacy.journalDigest,
    pendingDraft,
    sha256,
  );
  value.handoff = { requestFingerprint };
  value.revision = 3;
  const journal: AccountContentReplicationJournal = {
    schemaVersion: 3,
    ownerId,
    installationId: f.installationId,
    revision: 1,
    legacyJournalDigest: value.legacy.journalDigest,
    scope: clone(value.capturedLocal.scope),
    base: null,
    observed: {
      revision: remote.revision,
      snapshotDigest: value.proposedDigest,
      updatedAt: committedAt,
    },
    lastApply: null,
    pending: {
      ...pendingDraft,
      requestFingerprint,
      proposedDigest: value.proposedDigest,
      acknowledgement: null,
    },
  };
  await f.persist();
  await f.saveContent(journal);
  return journal;
}
async function completed(f: Fixture): Promise<AccountContentReplicationJournal> {
  const journal = await linked(f),
    value = f.transition;
  value.lastApply = {
    ownerId,
    operationId: value.localApplyOperationId,
    storeRevision: 6,
    serverRevision: value.acknowledgement!.revision,
    appliedAt: '2026-10-01T12:02:00.000Z',
    requestFingerprint: value.handoff!.requestFingerprint,
  };
  value.revision++;
  journal.revision++;
  journal.base = clone(journal.pending!.remote);
  journal.pending = null;
  journal.lastApply = clone(value.lastApply);
  f.db.exec("UPDATE state_revision SET revision=6 WHERE collection='store'");
  await f.persist();
  await f.saveContent(journal);
  return journal;
}

test('actual migrated8 reads immutable sidecar and original bytes without any writes', async (t) => {
  const f = await fixture(t),
    before = f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all();
  const result = await f.load();
  assert.deepEqual(result.transition, f.transition);
  assert.equal(
    result.digest,
    await sha256(
      String(
        f.db
          .prepare('SELECT value FROM app_metadata WHERE key=?')
          .get(accountLegacyContentTransitionKey(ownerId))!.value,
      ),
    ),
  );
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.transition!.capturedLocal.snapshot.planReferences),
  );
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!.value,
    f.oldBytes,
  );
  assert.deepEqual(f.db.prepare('SELECT * FROM app_metadata ORDER BY key').all(), before);
  assert.notEqual(
    result.transition!.legacy.journalDigest,
    result.transition!.legacy.baseProjectionDigest,
  );
});

test('actual format2 conversion preserves exact raw personal/history data and original wire evidence', async (t) => {
  const f = await fixture(t, { expanded: true }),
    result = await f.load();
  assert.equal(result.transition!.remote.snapshot!.schemaVersion, 2);
  assert.equal(result.transition!.proposed.personal.notes[0]!.text, ' Exact note\nكمية 🍲 ');
  assert.equal(result.transition!.proposed.cookingHistory!.entries[0]!.kind, 'legacy');
  assert.equal(result.transition!.proposed.cookingHistory!.entries[0]!.entry.note, ' original ');
  assert.deepEqual(
    result.transition!.proposed.cookingHistory!.removedEventIds,
    f.transition.proposed.cookingHistory!.removedEventIds,
  );
  assert.equal(
    f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))!.value,
    f.oldBytes,
  );
});

test('no-base remains absent and an absent sidecar does not invent state or hydrate private bodies', async (t) => {
  const f = await fixture(t);
  f.old.base = null;
  f.old.lastApply = null;
  f.metadata(journalKey(ownerId), f.old);
  f.transition.legacy.base = null;
  f.transition.legacy.baseProjectionDigest = null;
  f.transition.legacy.journalDigest = await sha256(JSON.stringify(f.old));
  await f.persist();
  assert.equal((await f.load()).transition!.legacy.base, null);
  f.db
    .prepare('DELETE FROM app_metadata WHERE key=?')
    .run(accountLegacyContentTransitionKey(ownerId));
  f.sqlLog.length = 0;
  assert.deepEqual(await f.load(), { transition: null, digest: null });
  assert.ok(f.sqlLog.every((sql) => !/\bvalue\b/i.test(sql)));
});

test('foreign namespaces are denied using keys before any private payload, even without an owned sidecar', async (t) => {
  const f = await fixture(t);
  for (const key of [
    accountLegacyContentTransitionKey(otherOwner),
    journalKey(otherOwner),
    accountContentJournalKey(otherOwner),
    `account-replication:content-initial-guest:${otherOwner}`,
  ]) {
    f.raw(key, 'not private JSON');
    f.sqlLog.length = 0;
    await assert.rejects(f.load(), failure('different_data_owner'));
    assert.ok(
      f.sqlLog.every((sql) => !/\bvalue\b/i.test(sql)),
      key,
    );
    f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(key);
  }
  f.db
    .prepare('DELETE FROM app_metadata WHERE key=?')
    .run(accountLegacyContentTransitionKey(ownerId));
  f.raw(accountLegacyContentTransitionKey(otherOwner), 'private');
  await assert.rejects(f.load(), failure('different_data_owner'));
});

test('present sidecar requires physical8, bound owner and exact installation before sidecar hydration', async (t) => {
  const f = await fixture(t, { schema: 7 });
  await assert.rejects(f.load(), failure('stored_data_invalid'));
  assert.ok(f.sqlLog.every((sql) => !sql.includes('CASE')));
  await migrateAccountContentHistoryDatabase(f.writer, { sha256 });
  f.metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId: otherOwner });
  f.beforeQuery((_sql, values) => {
    if (values.includes(accountLegacyContentTransitionKey(ownerId)))
      assert.ok(!_sql.includes('CASE'));
  });
  await assert.rejects(f.load(), failure('different_data_owner'));
  f.metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId });
  await assert.rejects(f.load(sha256, ownerId, randomUUID()), failure('stored_data_invalid'));
});

test('oversized sidecar and invalid store scalar are rejected before raw values leave SQLite', async (t) => {
  const f = await fixture(t);
  f.db
    .prepare("UPDATE app_metadata SET value=replace(hex(zeroblob(?)),'00','x') WHERE key=?")
    .run(
      ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES + 1,
      accountLegacyContentTransitionKey(ownerId),
    );
  await assert.rejects(f.load(), failure('too_large'));
  assert.ok(
    f.transferred.every(
      (row) =>
        !Object.values(row as object).some(
          (value) => typeof value === 'string' && value.length > 10000,
        ),
    ),
  );
  await f.persist();
  f.transferred.length = 0;
  f.db.exec('PRAGMA ignore_check_constraints=ON');
  f.db.exec(
    "UPDATE state_revision SET revision=replace(hex(zeroblob(50000)),'00','x') WHERE collection='store'",
  );
  await assert.rejects(f.load(), failure('stored_data_invalid'));
  assert.ok(
    f.transferred.every(
      (row) =>
        !Object.values(row as object).some(
          (value) => typeof value === 'string' && value.length >= 50000,
        ),
    ),
  );
});

test('null, malformed, tampered sidecar digest and every invalid hash output fail closed without rewriting', async (t) => {
  const f = await fixture(t);
  for (const raw of [
    'null',
    '{broken',
    JSON.stringify({ ...f.transition, requestFingerprint: '0'.repeat(64) }),
  ]) {
    f.raw(accountLegacyContentTransitionKey(ownerId), raw);
    await assert.rejects(f.load(), failure('stored_data_invalid'));
    assert.equal(
      f.db
        .prepare('SELECT value FROM app_metadata WHERE key=?')
        .get(accountLegacyContentTransitionKey(ownerId))!.value,
      raw,
    );
  }
  await f.persist();
  let count = 0;
  await f.load(async (text) => {
    count++;
    return sha256(text);
  });
  for (let invalid = 1; invalid <= count; invalid++) {
    let calls = 0;
    await assert.rejects(
      f.load(async (text) => (++calls === invalid ? 'not-a-digest' : sha256(text))),
      failure('stored_data_invalid'),
    );
  }
});

test('original legacy raw bytes, revision, base and observation cannot be substituted by resigned sidecar evidence', async (t) => {
  const f = await fixture(t),
    original = clone(f.transition);
  f.raw(journalKey(ownerId), `${f.oldBytes}\n`);
  await assert.rejects(f.load(), failure('stored_data_invalid'));
  f.raw(journalKey(ownerId), f.oldBytes);
  for (const change of [
    (value: AccountLegacyContentTransition) => {
      value.legacy.journalRevision++;
    },
    (value: AccountLegacyContentTransition) => {
      value.legacy.base = null;
      value.legacy.baseProjectionDigest = null;
    },
    (value: AccountLegacyContentTransition) => {
      value.legacy.observed.revision = 3;
      value.legacy.base!.revision = 3;
      value.legacy.observed.snapshotDigest = value.remoteDigest;
    },
  ]) {
    const changed = clone(original);
    change(changed);
    await f.persist(changed);
    await assert.rejects(f.load(), failure('stored_data_invalid'));
  }
  f.raw(journalKey(ownerId), 'null');
  const nullOld = clone(original);
  nullOld.legacy.journalDigest = await sha256('null');
  await f.persist(nullOld);
  await assert.rejects(f.load(), failure('stored_data_invalid'));
});

test('projection digests must equal installed bundled conversion and opted-out history cannot change', async (t) => {
  const f = await fixture(t),
    original = clone(f.transition);
  for (const field of ['base', 'remote'] as const) {
    const changed = clone(original);
    if (field === 'base') changed.legacy.baseProjectionDigest = '0'.repeat(64);
    else changed.remoteProjectionDigest = '0'.repeat(64);
    await f.persist(changed);
    await assert.rejects(f.load(), failure('stored_data_invalid'));
  }
  const changed = clone(original);
  changed.proposed.cookingHistory = { entries: [], removedEventIds: [] };
  changed.proposedDigest = await sha256(canonicalAccountContentSnapshot(changed.proposed));
  await f.persist(changed);
  await assert.rejects(f.load(), failure('stored_data_invalid'));
});

test('legacy pending operation, original apply clock and captured current clock cannot be bypassed', async (t) => {
  const f = await fixture(t),
    original = clone(f.transition);
  f.old.pending = {
    operationId: randomUUID(),
    mode: 'pull',
    capturedLocal: { storeRevision: 1, snapshot: clone(f.old.base!.snapshot!) },
    remote: clone(f.old.base!),
    proposed: clone(f.old.base!.snapshot!),
    proposedDigest: f.old.observed!.snapshotDigest!,
    acknowledgement: null,
  };
  f.metadata(journalKey(ownerId), f.old);
  f.transition.legacy.journalDigest = await sha256(JSON.stringify(f.old));
  await f.persist();
  await assert.rejects(f.load(), failure('operation_pending'));
  f.old.pending = null;
  f.old.lastApply!.storeRevision = 6;
  f.metadata(journalKey(ownerId), f.old);
  f.transition.legacy.journalDigest = await sha256(JSON.stringify(f.old));
  await f.persist();
  await assert.rejects(f.load(), failure('stored_data_invalid'));
  f.raw(journalKey(ownerId), f.oldBytes);
  const future = clone(original);
  future.capturedLocal.storeRevision = 6;
  await f.persist(future);
  await assert.rejects(f.load(), failure('stored_data_invalid'));
});

test('pre-handoff forbids any3 journal; exact acknowledged pull links unchanged capture and actual server state', async (t) => {
  const f = await fixture(t),
    original = clone(f.transition),
    journal = await linked(f);
  assert.deepEqual((await f.load()).transition, f.transition);
  await f.persist(original);
  await assert.rejects(f.load(), failure('stored_data_invalid'));
  await f.persist();
  const changed = clone(journal);
  changed.pending!.capturedLocal.fenceDigest = '0'.repeat(64);
  const {
    requestFingerprint: _fp,
    proposedDigest: _digest,
    acknowledgement: _ack,
    ...draft
  } = changed.pending!;
  changed.pending!.requestFingerprint = await accountContentPendingFingerprint(
    ownerId,
    f.installationId,
    changed.legacyJournalDigest,
    draft,
    sha256,
  );
  f.transition.handoff!.requestFingerprint = changed.pending!.requestFingerprint;
  await f.persist();
  await f.saveContent(changed);
  await assert.rejects(
    f.load(),
    failure('stored_data_invalid'),
    'a different capture cannot be hidden by relinking a new valid fingerprint',
  );
});

test('handoff rejects mismatched operation, mode, ack time, proposal, legacy digest and missing journal', async (t) => {
  const f = await fixture(t),
    originalJournal = await linked(f),
    original = clone(f.transition);
  const changes: ((journal: AccountContentReplicationJournal) => void)[] = [
    (value) => {
      value.pending!.operationId = randomUUID();
    },
    (value) => {
      value.pending!.mode = 'push';
    },
    (value) => {
      value.pending!.remote.updatedAt = at;
      value.observed.updatedAt = at;
    },
    (value) => {
      value.pending!.proposed.profile.displayName = 'changed';
      value.pending!.remote.snapshot = clone(value.pending!.proposed);
    },
    (value) => {
      value.legacyJournalDigest = '0'.repeat(64);
    },
  ];
  for (const change of changes) {
    const journal = clone(originalJournal);
    change(journal);
    const pending = journal.pending!;
    pending.proposedDigest = await sha256(canonicalAccountContentSnapshot(pending.proposed));
    journal.observed.snapshotDigest = await sha256(
      canonicalAccountContentSnapshot(pending.remote.snapshot),
    );
    const {
      requestFingerprint: _fp,
      proposedDigest: _digest,
      acknowledgement: _ack,
      ...draft
    } = pending;
    pending.requestFingerprint = await accountContentPendingFingerprint(
      ownerId,
      f.installationId,
      journal.legacyJournalDigest,
      draft,
      sha256,
    );
    const sidecar = clone(original);
    sidecar.handoff!.requestFingerprint = pending.requestFingerprint;
    await f.persist(sidecar);
    await f.saveContent(journal);
    await assert.rejects(
      f.load(),
      failure(
        journal.legacyJournalDigest !== originalJournal.legacyJournalDigest
          ? 'local_changed'
          : 'stored_data_invalid',
      ),
    );
  }
  f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(accountContentJournalKey(ownerId));
  await assert.rejects(f.load(), failure('stored_data_invalid'));
});

test('completed sidecar requires exact atomic receipt/base linkage and rejects manufactured half-commit', async (t) => {
  const f = await fixture(t),
    journal = await completed(f),
    original = clone(f.transition);
  assert.deepEqual((await f.load()).transition, original);
  f.transition.lastApply = null;
  await f.persist();
  await assert.rejects(f.load(), failure('stored_data_invalid'));
  await f.persist(original);
  for (const patch of [
    { operationId: randomUUID() },
    { appliedAt: '2026-10-01T12:03:00.000Z' },
    { requestFingerprint: '0'.repeat(64) },
  ]) {
    const changed = clone(journal);
    Object.assign(changed.lastApply!, patch);
    await f.saveContent(changed);
    await assert.rejects(f.load(), failure('stored_data_invalid'));
  }
  const future = clone(journal);
  future.lastApply!.storeRevision = 7;
  await f.saveContent(future);
  await assert.rejects(f.load(), failure('stored_data_invalid'));
});

test('later genuine3 journal evidence may advance monotonically, but same server revision must retain acknowledged bytes', async (t) => {
  const f = await fixture(t),
    journal = await completed(f);
  journal.revision++;
  journal.lastApply!.operationId = randomUUID();
  journal.lastApply!.requestFingerprint = '8'.repeat(64);
  journal.lastApply!.storeRevision = 7;
  journal.lastApply!.appliedAt = '2026-10-01T12:03:00.000Z';
  f.db.exec("UPDATE state_revision SET revision=7 WHERE collection='store'");
  await f.saveContent(journal);
  await f.load();
  journal.base!.snapshot!.profile.displayName = 'different bytes at same revision';
  journal.observed.snapshotDigest = await sha256(
    canonicalAccountContentSnapshot(journal.base!.snapshot),
  );
  await f.saveContent(journal);
  await assert.rejects(f.load(), failure('stored_data_invalid'));
  journal.base!.revision++;
  journal.base!.updatedAt = '2026-10-01T12:03:00.123456+00:00';
  journal.observed.revision++;
  journal.observed.updatedAt = journal.base!.updatedAt;
  journal.lastApply!.serverRevision++;
  await f.saveContent(journal);
  const result = await f.load();
  assert.equal(
    result.transition!.lastApply!.storeRevision,
    6,
    'sidecar completion remains historical exact evidence',
  );
});
