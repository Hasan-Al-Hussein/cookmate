import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AccountReplicationError,
  accountCaptureScope,
  accountSnapshotsEqualForScope,
  canonicalAccountSnapshot,
  canonicalAccountSyncScopeApproval,
  createAccountScopeApprovalEvidence,
  validateAccountCaptureScope,
  validateAccountSyncScopeApproval,
} from '../src';
import { id, snapshot, timestamp } from './fixtures';
import { expandedSnapshot, history } from './expandedFixtures';
const approval = () => ({
  schemaVersion: 1 as const,
  ownerId: id(100),
  scopeVersion: 2 as const,
  personalApproved: true as const,
  historyIncluded: false,
  decidedAt: timestamp,
});
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');

test('scope approval has an exact owner-bound allowlist and canonical digest, not a UI boolean', async () => {
  const record = approval();
  assert.ok(validateAccountSyncScopeApproval(record));
  assert.equal(validateAccountSyncScopeApproval({ ...record, userConfirmed: true }), false);
  assert.equal(validateAccountSyncScopeApproval({ ...record, personalApproved: false }), false);
  assert.equal(validateAccountSyncScopeApproval({ ...record, ownerId: 'another-person' }), false);
  assert.equal(validateAccountSyncScopeApproval({ ...record, decidedAt: 'yesterday' }), false);
  let reads = 0;
  const accessor = { ...record };
  Object.defineProperty(accessor, 'historyIncluded', {
    enumerable: true,
    get() {
      reads++;
      return true;
    },
  });
  assert.equal(validateAccountSyncScopeApproval(accessor), false);
  assert.equal(reads, 0);
  const evidence = await createAccountScopeApprovalEvidence(record, sha256);
  assert.equal(evidence.digest, await sha256(canonicalAccountSyncScopeApproval(record)));
  record.historyIncluded = true;
  assert.equal(evidence.record.historyIncluded, false, 'captured record is detached');
  assert.notEqual(
    (await createAccountScopeApprovalEvidence(record, sha256)).digest,
    evidence.digest,
  );
  await assert.rejects(
    createAccountScopeApprovalEvidence(approval(), async () => 'invalid'),
    AccountReplicationError,
  );
});

test('legacy captures normalize scope internally; expanded capture requires explicit matching discriminator', () => {
  const legacy = { storeRevision: 0, snapshot: snapshot() };
  assert.deepEqual(accountCaptureScope(legacy), { version: 1 });
  assert.equal(Object.hasOwn(legacy, 'scope'), false);
  assert.equal(validateAccountCaptureScope({ version: 2, historyIncluded: false }), false);
  assert.throws(
    () => accountCaptureScope({ storeRevision: 0, snapshot: expandedSnapshot() }),
    AccountReplicationError,
  );
  assert.throws(
    () =>
      accountCaptureScope({
        ...legacy,
        scope: { version: 2, approvalDigest: 'a'.repeat(64), historyIncluded: false },
      }),
    AccountReplicationError,
  );
});

test('history-off convergence ignores only history while full wire bytes and personal data remain meaningful', () => {
  const local = expandedSnapshot(),
    remote = expandedSnapshot();
  remote.cookingHistory = { entries: [history()], removedEventIds: [] };
  const scope = { version: 2 as const, approvalDigest: 'a'.repeat(64), historyIncluded: false };
  assert.ok(accountSnapshotsEqualForScope(local, remote, scope));
  assert.notEqual(canonicalAccountSnapshot(local), canonicalAccountSnapshot(remote));
  assert.equal(
    accountSnapshotsEqualForScope(local, remote, { ...scope, historyIncluded: true }),
    false,
  );
  assert.equal(
    accountSnapshotsEqualForScope(snapshot(), remote, scope),
    false,
    'scope comparison cannot fake a version upgrade',
  );
  remote.profile.displayName = 'Another name';
  assert.equal(accountSnapshotsEqualForScope(local, remote, scope), false);
  assert.equal(
    Object.hasOwn(remote, 'cookingHistory'),
    true,
    'comparison never alters full remote state',
  );
});

test('local captures require history presence to exactly match their participation scope', () => {
  for (const historyIncluded of [false, true]) {
    const scope = { version: 2 as const, approvalDigest: 'a'.repeat(64), historyIncluded };
    const value = expandedSnapshot();
    if (historyIncluded) value.cookingHistory = { entries: [], removedEventIds: [] };
    assert.deepEqual(accountCaptureScope({ storeRevision: 0, snapshot: value, scope }), scope);
    if (historyIncluded) delete value.cookingHistory;
    else value.cookingHistory = { entries: [history()], removedEventIds: [] };
    assert.throws(
      () => accountCaptureScope({ storeRevision: 0, snapshot: value, scope }),
      (error) => error instanceof AccountReplicationError && error.reason === 'stored_data_invalid',
    );
  }
});
