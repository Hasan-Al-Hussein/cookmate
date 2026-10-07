import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  AccountReplicationError,
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
  type AccountReplicationJournal,
  type AccountSnapshot,
} from '@cookmate/account-sync';
import { assertLegacyAccountSettledForContentMigration } from '../../../apps/mobile/src/data/contentMigrationAdmission';
import {
  ACCOUNT_BINDING_KEY,
  ACCOUNT_JOURNAL_MAX_BYTES,
  ACCOUNT_SETTINGS_KEY,
  journalKey,
} from '../../../apps/mobile/src/data/accountReplicationRecords';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import {
  configureConnection,
  SerializedWriter,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

// Actual disposable SQLite. The gate checks legacy settlement, never performs it or migrates data.
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreignOwnerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-01T12:00:00.000Z';
const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const reason = (expected: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === expected;

async function fixture(t: TestContext, version: 6 | 7 = 6) {
  const { database: db, connection } = desktopConnection();
  await configureConnection(connection);
  const writer = new SerializedWriter(connection);
  t.after(() => writer.close());
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
      enableAccountHistory: true,
    },
  );
  if (version === 7) await migrateCookingContentDatabase(writer, { sha256 });
  // Opaque pre-existing receipts deliberately remain untouched by this metadata-only gate.
  db.prepare('INSERT INTO operation_receipt VALUES (?,?,?,?,?,?,?)').run(
    randomUUID(),
    randomUUID(),
    'a'.repeat(64),
    'committed',
    at,
    'unchanged',
    '[ {"kept":"exact bytes"} ]',
  );
  db.prepare('INSERT INTO personal_operation VALUES (?,?,?)').run(
    randomUUID(),
    'b'.repeat(64),
    '{ "kept" : "personal receipt" }',
  );
  const raw = (key: string, value: string) =>
    db
      .prepare(
        'INSERT INTO app_metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  const metadata = (key: string, value: unknown) => raw(key, JSON.stringify(value));
  const bind = () => metadata(ACCOUNT_BINDING_KEY, { schemaVersion: 1, ownerId });
  const state = () => ({
    metadata: db.prepare('SELECT key,value FROM app_metadata ORDER BY key').all(),
    receipts: db.prepare('SELECT * FROM operation_receipt ORDER BY operation_id').all(),
    personal: db.prepare('SELECT * FROM personal_operation ORDER BY operation_id').all(),
    schema: db.prepare('PRAGMA user_version').get(),
    clocks: db.prepare('SELECT * FROM state_revision ORDER BY collection').all(),
  });
  const check = () =>
    writer.transaction(
      (session) => assertLegacyAccountSettledForContentMigration(session, sha256),
      { kind: 'read_only' },
    );
  return { db, connection, writer, raw, metadata, bind, state, check };
}

async function journal(
  version: 1 | 2,
  pending: false | 'unacknowledged' | 'acknowledged' = false,
): Promise<AccountReplicationJournal> {
  const core = emptyAccountSnapshot(catalogue.identity, {
    appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
    profile: { displayName: 'Private legacy profile' },
  });
  const snapshot: AccountSnapshot =
    version === 1
      ? core
      : {
          ...core,
          schemaVersion: 2,
          personal: { notes: [], collections: [], memberships: [], manualItems: [] },
        };
  const scope =
    version === 1
      ? { version: 1 as const }
      : {
          version: 2 as const,
          approvalDigest: 'c'.repeat(64),
          historyIncluded: false,
        };
  const digest = await sha256(canonicalAccountSnapshot(snapshot));
  const remote = { ownerId, revision: 1, snapshot, updatedAt: at, deletionOperationId: null };
  const operationId = randomUUID();
  const common = {
    ownerId,
    revision: 2,
    base: remote,
    observed: { revision: 1, snapshotDigest: digest, updatedAt: at },
    lastApply: {
      ownerId,
      operationId: randomUUID(),
      storeRevision: 1,
      serverRevision: 1,
      appliedAt: at,
    },
    pending: pending
      ? {
          operationId,
          mode: 'push' as const,
          capturedLocal: { storeRevision: 1, snapshot, scope },
          remote,
          proposed: snapshot,
          proposedDigest: digest,
          acknowledgement:
            pending === 'acknowledged'
              ? { ownerId, operationId, revision: 2, committedAt: at }
              : null,
        }
      : null,
  };
  return version === 1 ? { ...common, schemaVersion: 1 } : { ...common, schemaVersion: 2, scope };
}

test('guest and same-owner no-journal metadata admit physical6/7 without writes or receipt changes', async (t) => {
  for (const version of [6, 7] as const) {
    const f = await fixture(t, version);
    for (const bound of [false, true]) {
      if (bound) f.bind();
      const before = f.state();
      await f.check();
      assert.deepEqual(f.state(), before);
    }
  }
});

test('settled strict legacy1/2 journals admit with exact bytes, scope and retained receipts preserved', async (t) => {
  for (const physical of [6, 7] as const) {
    const f = await fixture(t, physical);
    f.bind();
    for (const version of [1, 2] as const) {
      const bytes = JSON.stringify(await journal(version), null, 2);
      f.raw(journalKey(ownerId), bytes);
      const before = f.state();
      await f.check();
      assert.deepEqual(f.state(), before);
      assert.equal(
        f.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(journalKey(ownerId))?.value,
        bytes,
      );
    }
  }
});

test('pending legacy1/2 operations block before migration, including acknowledged-but-unsettled operations', async (t) => {
  const f = await fixture(t);
  f.bind();
  for (const version of [1, 2] as const)
    for (const pending of ['unacknowledged', 'acknowledged'] as const) {
      f.raw(journalKey(ownerId), JSON.stringify(await journal(version, pending), null, 2));
      const before = f.state();
      await assert.rejects(f.check(), reason('operation_pending'));
      assert.deepEqual(f.state(), before);
    }
});

test('any pending-settings key blocks, even null/malformed settings, without decoding or clearing it', async (t) => {
  const f = await fixture(t, 7);
  f.bind();
  f.metadata(journalKey(ownerId), await journal(2));
  for (const bytes of ['null', '{', '{"ownerId":"another-owner","pending":true}']) {
    f.raw(ACCOUNT_SETTINGS_KEY, bytes);
    const before = f.state();
    await assert.rejects(f.check(), reason('settings_pending'));
    assert.deepEqual(f.state(), before);
  }
});

test('foreign and unbound journal keys deny without reading private bodies', async (t) => {
  const f = await fixture(t);
  const originalAll = f.connection.all;
  const observed: { sql: string; values: readonly SqlValue[] }[] = [];
  f.connection.all = async <Row extends object>(sql: string, values: readonly SqlValue[] = []) => {
    observed.push({ sql, values });
    return originalAll<Row>(sql, values);
  };
  for (const key of [
    journalKey(ownerId),
    journalKey(foreignOwnerId),
    'account-replication:journal:invalid-owner',
  ]) {
    f.raw(key, 'PRIVATE FOREIGN INVALID JSON');
    observed.length = 0;
    const before = f.state();
    await assert.rejects(f.check(), reason('stored_data_invalid'));
    assert.ok(
      !observed.some(
        (item) => item.values.includes(key) && /CASE.*value|length\(CAST\(value/i.test(item.sql),
      ),
    );
    assert.deepEqual(f.state(), before);
    f.db.prepare('DELETE FROM app_metadata WHERE key=?').run(key);
  }
  f.bind();
  f.raw(journalKey(foreignOwnerId), 'PRIVATE FOREIGN INVALID JSON');
  await assert.rejects(f.check(), reason('stored_data_invalid'));
  assert.ok(!observed.some((item) => item.values.includes(journalKey(foreignOwnerId))));
});

test('known null, malformed, owner-mismatched or checksum-invalid journals are corruption, not absence', async (t) => {
  const f = await fixture(t);
  f.bind();
  const valid = await journal(1);
  for (const bytes of [
    'null',
    '{',
    '{}',
    JSON.stringify({ ...valid, ownerId: foreignOwnerId }),
    JSON.stringify({
      ...valid,
      observed: { revision: 1, snapshotDigest: '0'.repeat(64), updatedAt: at },
    }),
  ]) {
    f.raw(journalKey(ownerId), bytes);
    const before = f.state();
    await assert.rejects(f.check(), reason('stored_data_invalid'));
    assert.deepEqual(f.state(), before);
  }
});

test('malformed/null owner binding is rejected before journal body access', async (t) => {
  const f = await fixture(t);
  f.raw(journalKey(ownerId), 'PRIVATE BODY NOT JSON');
  for (const bytes of ['null', '{}', '{"schemaVersion":1,"ownerId":"invalid"}']) {
    f.raw(ACCOUNT_BINDING_KEY, bytes);
    const before = f.state();
    await assert.rejects(f.check(), reason('stored_data_invalid'));
    assert.deepEqual(f.state(), before);
  }
});

test('oversized known journal is rejected before a large value is materialized', async (t) => {
  const f = await fixture(t);
  f.bind();
  f.db
    .prepare('INSERT INTO app_metadata(key,value) VALUES (?,CAST(zeroblob(?) AS TEXT))')
    .run(journalKey(ownerId), ACCOUNT_JOURNAL_MAX_BYTES + 1);
  const originalAll = f.connection.all;
  let sawBoundedProjection = false;
  f.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    const rows = await originalAll<Row>(sql, values);
    if (values?.includes(journalKey(ownerId)) && sql.includes('CASE')) {
      sawBoundedProjection = true;
      assert.equal((rows[0] as { value: unknown }).value, null);
    }
    return rows;
  };
  await assert.rejects(f.check(), reason('too_large'));
  assert.equal(sawBoundedProjection, true);
  assert.equal(
    f.db
      .prepare('SELECT length(CAST(value AS BLOB)) size FROM app_metadata WHERE key=?')
      .get(journalKey(ownerId))?.size,
    ACCOUNT_JOURNAL_MAX_BYTES + 1,
  );
});

test('unsupported physical schemas are denied before account reads and are never promoted', async (t) => {
  const f = await fixture(t);
  for (const version of [5, 8, 99]) {
    f.db.exec(`PRAGMA user_version=${version}`);
    const before = f.state();
    await assert.rejects(f.check(), reason('stored_data_invalid'));
    assert.deepEqual(f.state(), before);
  }
});
