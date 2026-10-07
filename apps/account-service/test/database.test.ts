import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { ACCOUNT_SNAPSHOT_MAX_BYTES, parseAccountSnapshot } from '@cookmate/account-sync';
import { largeSnapshot } from './largeSnapshot';
import { contentSnapshotFixture, largeContentSnapshot } from './contentSnapshotFixture';
import { parseAccountServiceSnapshot } from '../src/snapshot';
import { serverTimestamp } from '../src/protocol';

const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const sa = '20000000-0000-4000-8000-000000000001';
const sb = '20000000-0000-4000-8000-000000000002';
const op = '30000000-0000-4000-8000-000000000001';
const op2 = '30000000-0000-4000-8000-000000000002';
const capA = 'a'.repeat(64);
const capB = 'b'.repeat(64);
// Minimal SQL-boundary payload: full domain validation is independently tested in the handler.
const snapshot = { format: 'cookmate-account-snapshot', schemaVersion: 1, fixture: 'A' };
let db: PGlite;
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key, user_id uuid references auth.users on delete cascade,
      created_at timestamptz not null default clock_timestamp());`);
  for (const migration of [
    '202609300001_account_sync.sql',
    '202609300002_account_deletion_receipts.sql',
    '202610010001_personal_snapshot_v2.sql',
    '202610010002_content_snapshot_v3.sql',
  ])
    await db.exec(
      await readFile(new URL(`../../../supabase/migrations/${migration}`, import.meta.url), 'utf8'),
    );
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec('truncate cookmate_private.account_deletions, auth.users cascade');
  await db.query('insert into auth.users values ($1),($2)', [a, b]);
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2),($3,$4)', [sa, a, sb, b]);
});
async function rpc<Value = Record<string, unknown>>(name: string, params: unknown[]) {
  const placeholders = params.map((_, i) => `$${i + 1}`).join(',');
  const result = await db.query<{ value: Value }>(
    `select public.${name}(${placeholders}) as value`,
    params,
  );
  return result.rows[0]!.value;
}
const read = (owner = a, session = sa) => rpc('cookmate_sync_read', [owner, session]);
const commit = (
  operation = op,
  expected = 0,
  payload: unknown = snapshot,
  owner = a,
  session = sa,
) => rpc('cookmate_sync_commit', [owner, session, operation, expected, JSON.stringify(payload)]);
const beginDelete = (operation = op2, expected = 1, digest = capA, owner = a, session = sa) =>
  rpc('cookmate_account_begin_delete', [owner, session, operation, expected, digest]);
interface DeletionReceipt {
  operationId: string;
  state: 'pending' | 'deleted';
  deletedAt: string | null;
  expiresAt: string | null;
  capabilityDigests: string[];
}
const deletionReceipt = (operation = op2) =>
  rpc<DeletionReceipt | null>('cookmate_account_deletion_receipt', [operation]);
const pruneDeletions = (limit = 100) => rpc<number>('cookmate_account_prune_deletions', [limit]);

test('first account starts empty; committing and reading in another session restores exactly', async () => {
  assert.equal((await read()).snapshot, null);
  const receipt = await commit();
  assert.equal(receipt.revision, 1);
  const secondSession = '20000000-0000-4000-8000-000000000003';
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [secondSession, a]);
  const restored = await read(a, secondSession);
  assert.deepEqual(restored.snapshot, snapshot);
  assert.equal(restored.updatedAt, receipt.committedAt);
});

test('snapshot v2 upgrade preserves legacy receipt replay and blocks new v1 downgrades', async () => {
  const originalReceipt = await commit();
  const expanded = { ...snapshot, schemaVersion: 2, fixture: 'Expanded private scope' };
  await commit(op2, 1, expanded);
  const upgraded = await read();
  assert.equal(upgraded.schemaVersion, 1, 'transport envelope does not change');
  assert.deepEqual(upgraded.snapshot, expanded);
  assert.deepEqual(await commit(), originalReceipt, 'legacy exact operation keeps its proof');
  assert.deepEqual(await read(), upgraded, 'receipt replay does not replace the newer snapshot');
  const newOperation = '30000000-0000-4000-8000-000000000003';
  await assert.rejects(commit(newOperation, 2), { code: 'CM426' });
  assert.deepEqual(await read(), upgraded);
  await assert.rejects(commit(op, 0, { ...snapshot, fixture: 'Altered retry' }), { code: 'CM409' });
  await assert.rejects(commit(newOperation, 2, { ...snapshot, schemaVersion: 4 }), {
    code: 'CM400',
  });
  await assert.rejects(commit(newOperation, 2, { ...snapshot, schemaVersion: '2' }), {
    code: 'CM400',
  });
  assert.equal((await commit(newOperation, 2, expanded)).revision, 3);
});
test('different account is empty and cannot use the first account session', async () => {
  await commit();
  assert.equal((await read(b, sb)).snapshot, null);
  await assert.rejects(read(b, sa), /account_session_invalid/);
  await assert.rejects(commit(op, 0, snapshot, b, sa), /account_session_invalid/);
});
test('same operation recovers the exact receipt after later commits', async () => {
  const first = await commit();
  await commit(op2, 1, { ...snapshot, fixture: 'later' });
  assert.deepEqual(await commit(), first);
  assert.equal((await read()).revision, 2);
});
test('operation identity cannot be rebound to a different payload or base', async () => {
  await commit();
  await assert.rejects(
    commit(op, 0, { ...snapshot, fixture: 'changed' }),
    /account_operation_rebound/,
  );
  await assert.rejects(commit(op, 1), /account_operation_rebound/);
  assert.deepEqual((await read()).snapshot, snapshot);
});
test('stale device is rejected without changing snapshot or writing a receipt', async () => {
  await commit();
  await assert.rejects(
    commit(op2, 0, { ...snapshot, fixture: 'stale' }),
    /account_revision_changed/,
  );
  assert.deepEqual((await read()).snapshot, snapshot);
  const rows = await db.query<{ count: number }>(
    'select count(*)::integer as count from cookmate_private.sync_receipts',
  );
  assert.equal(rows.rows[0]!.count, 1);
});
test('queued same-base writes yield one successful commit in the PGlite connection', async () => {
  const results = await Promise.allSettled([
    commit(),
    commit(op2, 0, { ...snapshot, fixture: 'other' }),
  ]);
  assert.equal(results.filter((v) => v.status === 'fulfilled').length, 1);
  assert.equal((await read()).revision, 1);
});
test('receipt and payload roll back together on a database failure', async () => {
  await db.exec(`create function cookmate_private.fail_receipt() returns trigger language plpgsql as $$
    begin raise exception 'injected_receipt_failure'; end; $$;
    create trigger fail_receipt before insert on cookmate_private.sync_receipts
      for each row execute function cookmate_private.fail_receipt();`);
  try {
    await assert.rejects(commit(), /injected_receipt_failure/);
  } finally {
    await db.exec(
      'drop trigger fail_receipt on cookmate_private.sync_receipts; drop function cookmate_private.fail_receipt()',
    );
  }
  assert.equal((await read()).revision, 0);
  assert.equal((await read()).snapshot, null);
});
test('revoked sessions cannot read, write or replay a committed receipt', async () => {
  await commit();
  await db.query('delete from auth.sessions where id=$1', [sa]);
  await assert.rejects(read(), /account_session_invalid/);
  await assert.rejects(commit(), /account_session_invalid/);
});
test('anonymous and authenticated roles cannot read tables or invoke privileged functions', async () => {
  await commit();
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(
        db.query('select * from cookmate_private.accounts'),
        /permission denied/,
      );
      await assert.rejects(
        db.query('select * from cookmate_private.sync_receipts'),
        /permission denied/,
      );
      await assert.rejects(read(), /permission denied/);
      await assert.rejects(commit(), /permission denied/);
      await assert.rejects(
        rpc('cookmate_account_begin_delete', [a, sa, op, 0, capA]),
        /permission denied/,
      );
      for (const table of ['account_deletions', 'account_deletion_capabilities']) {
        await assert.rejects(
          db.query(`select * from cookmate_private.${table}`),
          /permission denied/,
        );
        await assert.rejects(
          db.query(`delete from cookmate_private.${table}`),
          /permission denied/,
        );
      }
      await assert.rejects(deletionReceipt(), /permission denied/);
      await assert.rejects(pruneDeletions(), /permission denied/);
    } finally {
      await db.exec('reset role');
    }
  }
});
test('service role can access only the granted RPC boundary', async () => {
  await db.exec('set role service_role');
  try {
    await commit();
    assert.equal((await read()).revision, 1);
    await assert.rejects(db.query('select * from cookmate_private.accounts'), /permission denied/);
    await beginDelete();
    assert.equal((await deletionReceipt())?.state, 'pending');
    assert.equal(await pruneDeletions(), 0);
    for (const table of ['account_deletions', 'account_deletion_capabilities']) {
      await assert.rejects(
        db.query(`select * from cookmate_private.${table}`),
        /permission denied/,
      );
      await assert.rejects(db.query(`delete from cookmate_private.${table}`), /permission denied/);
    }
  } finally {
    await db.exec('reset role');
  }
});
test('deletion requires recent authentication, exact revision and repeatable operation', async () => {
  await commit();
  await db.query(
    "update auth.sessions set created_at=clock_timestamp()-interval '20 minutes' where id=$1",
    [sa],
  );
  await assert.rejects(beginDelete(), /account_recent_sign_in_required/);
  await db.query('update auth.sessions set created_at=clock_timestamp() where id=$1', [sa]);
  await assert.rejects(beginDelete(op2, 0), /account_revision_changed/);
  const result = await beginDelete();
  assert.equal(result.deletionPending, true);
  assert.deepEqual(await beginDelete(), result);
  await assert.rejects(commit(op2, 1), /account_deletion_pending/);
  assert.equal((await read()).deletionPending, true);
});
test('a new stale-base deletion and its retries leave no admission, capability or freeze', async () => {
  await commit();
  const before = await read();
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(beginDelete(op2, 0), { code: 'CM412' });
    assert.deepEqual(await read(), before);
    assert.equal((await read()).deletionOperationId, null);
    assert.equal((await read()).deletionPending, false);
    assert.equal(await deletionReceipt(), null);
    assert.deepEqual((await db.query('select * from cookmate_private.account_deletions')).rows, []);
    assert.deepEqual(
      (await db.query('select * from cookmate_private.account_deletion_capabilities')).rows,
      [],
    );
  }
  const nextOperation = '30000000-0000-4000-8000-000000000003';
  assert.equal((await commit(nextOperation, 1)).revision, 2, 'the account is not frozen');
  await assert.rejects(beginDelete(op2, 0), { code: 'CM412' });
  assert.equal(await deletionReceipt(), null);
  assert.equal((await read()).deletionPending, false);
});
test('a fresh session of the same owner can explicitly recover a pending deletion operation', async () => {
  await commit();
  const pending = await beginDelete();
  // Auth deletion has failed before it deleted the user; the original device loses its journal.
  await db.query('delete from auth.sessions where id=$1', [sa]);
  const freshSession = '20000000-0000-4000-8000-000000000004';
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [freshSession, a]);
  const recovered = await read(a, freshSession);
  assert.equal(recovered.deletionPending, true);
  assert.equal(recovered.deletionOperationId, op2);
  assert.equal(
    (await read(b, sb)).deletionOperationId,
    null,
    'other owner receives no pending identity',
  );
  await assert.rejects(read(a, sb), /account_session_invalid/);
  await assert.rejects(beginDelete(op, 1, capB, a, freshSession), /account_operation_rebound/);
  assert.deepEqual(
    await rpc('cookmate_account_begin_delete', [
      a,
      freshSession,
      recovered.deletionOperationId,
      recovered.revision,
      capB,
    ]),
    pending,
  );
  await assert.rejects(commit(op, 1, snapshot, a, freshSession), /account_deletion_pending/);
  assert.deepEqual((await deletionReceipt())?.capabilityDigests, [capA, capB]);
  await db.query('delete from auth.users where id=$1', [a]);
  await assert.rejects(read(a, freshSession), /account_session_invalid/);
  assert.deepEqual((await deletionReceipt())?.capabilityDigests, [capA, capB]);
  assert.equal((await deletionReceipt())?.state, 'deleted');
});
test('real auth user deletion cascades account data and receipts, preserving other owners', async () => {
  await commit();
  await commit(op, 0, { ...snapshot, fixture: 'B' }, b, sb);
  await db.query('delete from auth.users where id=$1', [a]);
  const rows = await db.query<{ user_id: string }>('select user_id from cookmate_private.accounts');
  assert.deepEqual(
    rows.rows.map((r) => r.user_id),
    [b],
  );
  const receipts = await db.query<{ user_id: string }>(
    'select user_id from cookmate_private.sync_receipts',
  );
  assert.deepEqual(
    receipts.rows.map((r) => r.user_id),
    [b],
  );
  await assert.rejects(read(), /account_session_invalid/);
});

test('deletion admission requires a bounded digest and removes the capability-free overload', async () => {
  await commit();
  const old = await db.query<{ signature: string | null }>(
    "select to_regprocedure('public.cookmate_account_begin_delete(uuid,uuid,uuid,bigint)')::text as signature",
  );
  assert.equal(old.rows[0]!.signature, null);
  for (const digest of [
    null,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    'a'.repeat(64) + '\n',
  ])
    await assert.rejects(rpc('cookmate_account_begin_delete', [a, sa, op2, 1, digest]), {
      code: 'CM400',
    });
  assert.equal(await deletionReceipt(), null);
  assert.equal((await read()).deletionPending, false);
  await assert.rejects(beginDelete(op2, 1, capA, a, sb), { code: 'CM401' });
});

test('pending deletion binds the exact base and owner without rebinding another operation', async () => {
  await commit();
  await commit(op, 0, { ...snapshot, fixture: 'B' }, b, sb);
  await beginDelete();
  const before = await deletionReceipt();
  await assert.rejects(beginDelete(op2, 0), { code: 'CM409' });
  await assert.rejects(beginDelete(op, 1), { code: 'CM409' });
  await assert.rejects(beginDelete(op2, 1, capB, b, sb), { code: 'CM409' });
  assert.deepEqual(await deletionReceipt(), before);
  assert.equal((await read(b, sb)).deletionPending, false);
  assert.equal((await read()).deletionOperationId, op2);
  await assert.rejects(commit(op2, 1), /account_deletion_pending/);
});

test('eight capabilities are retained, exact repeats are free and stale sign-in cannot add another', async () => {
  await commit();
  const digests = Array.from({ length: 8 }, (_, index) => index.toString(16).padStart(64, '0'));
  for (const digest of digests) await beginDelete(op2, 1, digest);
  const rowsBefore = await db.query(
    'select * from cookmate_private.account_deletion_capabilities order by capability_digest',
  );
  await beginDelete(op2, 1, digests[0]!);
  assert.deepEqual(
    (
      await db.query(
        'select * from cookmate_private.account_deletion_capabilities order by capability_digest',
      )
    ).rows,
    rowsBefore.rows,
  );
  await assert.rejects(beginDelete(op2, 1, capB), { code: 'CM430' });
  assert.deepEqual((await deletionReceipt())?.capabilityDigests, digests);
  await db.query(
    "update auth.sessions set created_at=clock_timestamp()-interval '20 minutes' where id=$1",
    [sa],
  );
  await assert.rejects(beginDelete(op2, 1, digests[0]!), { code: 'CM403' });
  assert.deepEqual((await deletionReceipt())?.capabilityDigests, digests);
  assert.equal((await read()).deletionPending, true);
});

test('Auth deletion atomically preserves minimal receipt and capabilities while erasing account data', async () => {
  await commit();
  await commit(op, 0, { ...snapshot, fixture: 'B' }, b, sb);
  await beginDelete();
  await beginDelete(op2, 1, capB);
  await db.query('delete from auth.users where id=$1', [a]);
  const receipt = await deletionReceipt();
  assert.ok(receipt);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'capabilityDigests',
    'deletedAt',
    'expiresAt',
    'operationId',
    'state',
  ]);
  assert.equal(receipt.operationId, op2);
  assert.equal(receipt.state, 'deleted');
  assert.deepEqual(receipt.capabilityDigests, [capA, capB]);
  assert.ok(receipt.deletedAt && receipt.expiresAt);
  assert.equal(
    Date.parse(receipt.expiresAt) - Date.parse(receipt.deletedAt),
    30 * 24 * 60 * 60 * 1000,
  );
  const retained = await db.query<{ pending_owner: string | null; base_revision: number | null }>(
    'select pending_owner, base_revision from cookmate_private.account_deletions where operation_id=$1',
    [op2],
  );
  assert.deepEqual(retained.rows, [{ pending_owner: null, base_revision: null }]);
  for (const table of ['accounts', 'sync_receipts']) {
    const owners = await db.query<{ user_id: string }>(
      `select user_id from cookmate_private.${table}`,
    );
    assert.deepEqual(
      owners.rows.map((row) => row.user_id),
      [b],
    );
  }
  assert.deepEqual((await read(b, sb)).snapshot, { ...snapshot, fixture: 'B' });
  await assert.rejects(read(), /account_session_invalid/);
  const before = await db.query('select * from cookmate_private.account_deletions');
  assert.deepEqual(await deletionReceipt(), receipt);
  assert.deepEqual(await deletionReceipt(), receipt);
  assert.deepEqual(
    (await db.query('select * from cookmate_private.account_deletions')).rows,
    before.rows,
  );
  assert.equal(await pruneDeletions(), 0, 'unexpired completed proof is retained');
});

test('rolled-back Auth deletion and completion-trigger failure retain pending proof and all old data', async () => {
  await commit();
  await beginDelete();
  const pending = await deletionReceipt();
  const account = await read();
  await db.exec('begin');
  try {
    await db.query('delete from auth.users where id=$1', [a]);
    assert.equal((await deletionReceipt())?.state, 'deleted');
  } finally {
    await db.exec('rollback');
  }
  assert.deepEqual(await deletionReceipt(), pending);
  assert.deepEqual(await read(), account);
  await db.exec(`create function cookmate_private.fail_deletion_completion() returns trigger language plpgsql as $$
    begin raise exception 'injected_deletion_completion_failure'; end; $$;
    create trigger fail_deletion_completion after update on cookmate_private.account_deletions
      for each row when (new.completed_at is not null)
      execute function cookmate_private.fail_deletion_completion();`);
  try {
    await assert.rejects(
      db.query('delete from auth.users where id=$1', [a]),
      /injected_deletion_completion_failure/,
    );
  } finally {
    await db.exec(
      'drop trigger fail_deletion_completion on cookmate_private.account_deletions; drop function cookmate_private.fail_deletion_completion()',
    );
  }
  assert.deepEqual(await deletionReceipt(), pending);
  assert.deepEqual(await read(), account);
  assert.equal(
    (await db.query('select * from cookmate_private.sync_receipts where user_id=$1', [a])).rows
      .length,
    1,
  );
});

test('legacy pending marker admits only its current frozen operation and revision', async () => {
  await commit();
  await db.query('update cookmate_private.accounts set deletion_operation=$1 where user_id=$2', [
    op2,
    a,
  ]);
  assert.equal(await deletionReceipt(), null, 'the migration does not invent historical proof');
  await assert.rejects(beginDelete(op, 1), { code: 'CM409' });
  await assert.rejects(beginDelete(op2, 0), { code: 'CM409' });
  assert.equal(await deletionReceipt(), null);
  assert.equal((await read()).deletionPending, true, 'the legacy operation remains frozen');
  assert.equal((await read()).deletionOperationId, op2);
  await beginDelete();
  assert.deepEqual(await deletionReceipt(), {
    operationId: op2,
    state: 'pending',
    deletedAt: null,
    expiresAt: null,
    capabilityDigests: [capA],
  });
  await assert.rejects(commit(op2, 1), /account_deletion_pending/);
});

test('unadmitted Auth deletion never manufactures a deletion receipt', async () => {
  await commit();
  await db.query('update cookmate_private.accounts set deletion_operation=$1 where user_id=$2', [
    op2,
    a,
  ]);
  await db.query('delete from auth.users where id=$1', [a]);
  assert.equal(await deletionReceipt(), null);
  assert.equal((await db.query('select * from cookmate_private.account_deletions')).rows.length, 0);
  assert.equal(
    (await db.query('select * from cookmate_private.account_deletion_capabilities')).rows.length,
    0,
  );
});

test('completed proof cannot be rebound to another owner or an administratively reused Auth UUID', async () => {
  await commit();
  await beginDelete();
  await db.query('delete from auth.users where id=$1', [a]);
  const receipt = await deletionReceipt();
  await assert.rejects(beginDelete(op2, 1, capB, b, sb), { code: 'CM409' });
  const newSession = '20000000-0000-4000-8000-000000000008';
  await db.query('insert into auth.users values ($1)', [a]);
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [newSession, a]);
  await assert.rejects(beginDelete(op2, 1, capA, a, newSession), { code: 'CM409' });
  assert.deepEqual(
    await deletionReceipt(),
    receipt,
    'historical lookup does not grant authority over the new account',
  );
  assert.equal((await read(a, newSession)).revision, 0);
  await commit(op, 0, { ...snapshot, fixture: 'new account' }, a, newSession);
  assert.deepEqual((await read(a, newSession)).snapshot, { ...snapshot, fixture: 'new account' });
  assert.deepEqual(await deletionReceipt(), receipt);
});

test('expiry hides completed proof and bounded pruning removes only expired parents and their capabilities', async () => {
  const pendingOp = '30000000-0000-4000-8000-000000000003';
  const c = '10000000-0000-4000-8000-000000000003';
  const sc = '20000000-0000-4000-8000-000000000003';
  await beginDelete(op, 0);
  await beginDelete(op2, 0, capB, b, sb);
  await db.query('delete from auth.users where id in ($1,$2)', [a, b]);
  assert.equal(await pruneDeletions(1), 0);
  await db.query('insert into auth.users values ($1)', [c]);
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [sc, c]);
  await beginDelete(pendingOp, 0, capA, c, sc);
  await db.exec(`update cookmate_private.account_deletions
    set admitted_at=clock_timestamp()-interval '40 days',
      completed_at=clock_timestamp()-interval '31 days', expires_at=clock_timestamp()-interval '1 day'
    where completed_at is not null;
    update cookmate_private.account_deletions set admitted_at=clock_timestamp()-interval '60 days'
    where completed_at is null;`);
  assert.equal(await deletionReceipt(op), null);
  assert.equal(await deletionReceipt(op2), null);
  assert.equal(await deletionReceipt('30000000-0000-4000-8000-000000000099'), null);
  const pending = await deletionReceipt(pendingOp);
  assert.equal(pending?.state, 'pending');
  for (const limit of [null, 0, 1001])
    await assert.rejects(rpc('cookmate_account_prune_deletions', [limit]), { code: 'CM400' });
  assert.equal(await pruneDeletions(1), 1);
  assert.equal(
    (
      await db.query(
        'select * from cookmate_private.account_deletions where completed_at is not null',
      )
    ).rows.length,
    1,
  );
  assert.equal(await pruneDeletions(1), 1);
  assert.equal(await rpc<number>('cookmate_account_prune_deletions', []), 0);
  assert.deepEqual(await deletionReceipt(pendingOp), pending);
  const parents = await db.query('select operation_id from cookmate_private.account_deletions');
  const caps = await db.query(
    'select operation_id from cookmate_private.account_deletion_capabilities',
  );
  assert.deepEqual(parents.rows, [{ operation_id: pendingOp }]);
  assert.deepEqual(caps.rows, [{ operation_id: pendingOp }]);
});

test('bounded backend rejects oversized or unsupported snapshots', async () => {
  await assert.rejects(
    commit(op, 0, { ...snapshot, fixture: 'x'.repeat(4 * 1024 * 1024) }),
    /account_invalid_request/,
  );
  await assert.rejects(commit(op, 0, { ...snapshot, schemaVersion: 4 }), /account_invalid_request/);
  assert.equal((await read()).revision, 0);
});

test('near-boundary valid snapshot survives JSONB whitespace expansion and restores exactly', async () => {
  const value = largeSnapshot();
  const wire = JSON.stringify(value);
  assert.ok(Buffer.byteLength(wire) <= ACCOUNT_SNAPSHOT_MAX_BYTES);
  assert.ok(Buffer.byteLength(wire) > ACCOUNT_SNAPSHOT_MAX_BYTES * 0.99);
  const size = await db.query<{ bytes: number }>('select octet_length($1::jsonb::text) as bytes', [
    wire,
  ]);
  assert.ok(size.rows[0]!.bytes > 2200000, 'fixture exceeds the previous incorrect JSONB cap');
  await commit(op, 0, value);
  const secondSession = '20000000-0000-4000-8000-000000000005';
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [secondSession, a]);
  const restored = await read(a, secondSession);
  assert.deepEqual(parseAccountSnapshot(JSON.stringify(restored.snapshot)), value);
});

test('format3 migration preserves populated legacy snapshots and exact stored receipt evidence', async () => {
  await commit();
  await commit(op, 0, { ...snapshot, schemaVersion: 2 }, b, sb);
  const rows = async () => ({
    accounts: (
      await db.query(
        'select user_id, revision, snapshot::text, updated_at from cookmate_private.accounts order by user_id',
      )
    ).rows,
    receipts: (
      await db.query('select * from cookmate_private.sync_receipts order by user_id, operation_id')
    ).rows,
  });
  const before = await rows();
  await db.exec(
    await readFile(
      new URL('../../../supabase/migrations/202610010002_content_snapshot_v3.sql', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(await rows(), before);
});

test('format3 upgrades preserve both legacy receipt versions and refuse every new downgrade', async () => {
  const one = await commit();
  const twoPayload = { ...snapshot, schemaVersion: 2, fixture: 'Expanded scope' };
  const two = await commit(op2, 1, twoPayload);
  const threeOperation = '30000000-0000-4000-8000-000000000003';
  const newOperation = '30000000-0000-4000-8000-000000000004';
  const exact = contentSnapshotFixture();
  const three = await commit(threeOperation, 2, exact);
  assert.equal(three.revision, 3);
  const state = await read();
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.snapshot, exact);
  assert.deepEqual(await commit(), one);
  assert.deepEqual(await commit(op2, 1, twoPayload), two);
  assert.deepEqual(await commit(threeOperation, 2, exact), three);
  assert.deepEqual(await read(), state, 'receipt replay never reinstalls an old snapshot');
  for (const payload of [snapshot, twoPayload]) {
    await assert.rejects(commit(newOperation, 3, payload), { code: 'CM426' });
    await assert.rejects(commit(newOperation, 0, payload), { code: 'CM426' });
  }
  await assert.rejects(commit(op, 0, { ...snapshot, fixture: 'Rebound old receipt' }), {
    code: 'CM409',
  });
  await assert.rejects(commit(newOperation, 2, exact), { code: 'CM412' });
  assert.deepEqual(await read(), state);
  assert.equal(
    (
      await db.query<{ count: number }>(
        'select count(*)::integer count from cookmate_private.sync_receipts',
      )
    ).rows[0]!.count,
    3,
  );
});

test('fresh and directly upgraded exact snapshots retain account isolation, roles, session and deletion guards', async () => {
  const exact = contentSnapshotFixture();
  await commit();
  await db.exec('set role service_role');
  try {
    assert.equal((await commit(op2, 1, exact)).revision, 2, '1 to3 is a real CAS transition');
    assert.equal(
      (await commit(op, 0, exact, b, sb)).revision,
      1,
      'new account may start at format3',
    );
  } finally {
    await db.exec('reset role');
  }
  assert.deepEqual((await read()).snapshot, exact);
  assert.deepEqual((await read(b, sb)).snapshot, exact);
  await assert.rejects(commit(op, 0, exact, a, sb), { code: 'CM401' });
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    try {
      await assert.rejects(commit(op, 0, exact), /permission denied/);
      await assert.rejects(read(), /permission denied/);
    } finally {
      await db.exec('reset role');
    }
  }
  await db.query('delete from auth.sessions where id=$1', [sb]);
  await assert.rejects(commit(op, 0, exact, b, sb), { code: 'CM401' });
  const deletion = '30000000-0000-4000-8000-000000000005';
  await beginDelete(deletion, 2);
  await assert.rejects(commit(op2, 1, exact), { code: 'CM410' });
  assert.deepEqual((await read()).snapshot, exact);
});

test('format3 admission keeps the finite commit rate limit while exact receipt replay remains free', async () => {
  const exact = contentSnapshotFixture();
  const original = await commit(op, 0, exact);
  await db.query(
    `insert into cookmate_private.sync_receipts(user_id,operation_id,base_revision,payload_digest,revision,committed_at)
    select $1::uuid,('90000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,i-1,'fixture',i,clock_timestamp() from generate_series(2,60) i`,
    [a],
  );
  const before = await read();
  await assert.rejects(commit(op2, 1, exact), { code: 'CM429' });
  assert.deepEqual(await commit(op, 0, exact), original);
  assert.deepEqual(await read(), before);
});

test('format3 SQL constraint accepts only explicit supported numeric versions and bounds JSONB storage', async () => {
  await commit(op, 0, contentSnapshotFixture());
  for (const schemaVersion of [0, 4, 3.5, '3', null]) {
    await assert.rejects(commit(op2, 1, { ...snapshot, schemaVersion }), { code: 'CM400' });
    await assert.rejects(
      db.query('update cookmate_private.accounts set snapshot=$1::jsonb where user_id=$2', [
        JSON.stringify({ ...snapshot, schemaVersion }),
        a,
      ]),
      { code: '23514' },
    );
  }
  await assert.rejects(
    commit(op2, 1, { ...contentSnapshotFixture(), oversize: 'x'.repeat(4 * 1024 * 1024) }),
    { code: 'CM400' },
  );
  assert.equal((await read()).revision, 1);
});

test('near-boundary format3 exact references survive actual JSONB formatting and strict service revalidation', async () => {
  const value = largeContentSnapshot(ACCOUNT_SNAPSHOT_MAX_BYTES - 1024);
  const expected = parseAccountServiceSnapshot(value, true);
  const json = JSON.stringify(value);
  assert.ok(Buffer.byteLength(json) <= ACCOUNT_SNAPSHOT_MAX_BYTES);
  const size = await db.query<{ bytes: number }>('select octet_length($1::jsonb::text) bytes', [
    json,
  ]);
  assert.ok(size.rows[0]!.bytes > ACCOUNT_SNAPSHOT_MAX_BYTES);
  await commit(op, 0, value);
  assert.deepEqual(parseAccountServiceSnapshot((await read()).snapshot, true), expected);
});

test('sync write, read and historical replay emit UTC under a non-UTC SQL session without changing its zone', async () => {
  await db.exec("set timezone to 'Asia/Dubai'");
  try {
    const original = await commit();
    assert.equal(serverTimestamp(original.committedAt), true);
    const upgraded = await commit(op2, 1, contentSnapshotFixture());
    assert.equal(serverTimestamp(upgraded.committedAt), true);
    const state = await read();
    assert.equal(serverTimestamp(state.updatedAt), true);
    assert.equal(state.updatedAt, upgraded.committedAt);
    assert.deepEqual(await commit(), original);
    assert.deepEqual(await commit(op2, 1, contentSnapshotFixture()), upgraded);
    const account = await db.query<{ same: boolean }>(
      'select updated_at=$2::timestamptz same from cookmate_private.accounts where user_id=$1',
      [a, upgraded.committedAt],
    );
    assert.equal(account.rows[0]!.same, true, 'wire value denotes the exact stored instant');
    for (const receipt of [original, upgraded]) {
      const retained = await db.query<{ same: boolean }>(
        'select committed_at=$3::timestamptz same from cookmate_private.sync_receipts where user_id=$1 and operation_id=$2',
        [a, receipt.operationId, receipt.committedAt],
      );
      assert.equal(retained.rows[0]!.same, true);
    }
    assert.equal(
      (await db.query<{ zone: string }>("select current_setting('TimeZone') zone")).rows[0]!.zone,
      'Asia/Dubai',
    );
  } finally {
    await db.exec('reset timezone');
  }
});

test('deletion receipt timestamps also satisfy the UTC contract under a non-UTC SQL session', async () => {
  await db.exec("set timezone to 'Asia/Dubai'");
  try {
    await commit();
    await beginDelete();
    await db.query('delete from auth.users where id=$1', [a]);
    const receipt = await deletionReceipt();
    assert.ok(receipt);
    assert.equal(receipt.state, 'deleted');
    assert.equal(serverTimestamp(receipt.deletedAt), true);
    assert.equal(serverTimestamp(receipt.expiresAt), true);
    const stored = await db.query<{ same: boolean }>(
      'select completed_at=$2::timestamptz and expires_at=$3::timestamptz same from cookmate_private.account_deletions where operation_id=$1',
      [op2, receipt.deletedAt, receipt.expiresAt],
    );
    assert.equal(stored.rows[0]!.same, true);
    assert.deepEqual(await deletionReceipt(), receipt);
    assert.equal(
      (await db.query<{ zone: string }>("select current_setting('TimeZone') zone")).rows[0]!.zone,
      'Asia/Dubai',
    );
  } finally {
    await db.exec('reset timezone');
  }
});
