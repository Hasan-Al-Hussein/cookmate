import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ACCOUNT_CONTENT_SCOPE_MAX_BYTES,
  accountContentCaptureScopesEqual,
  canonicalAccountContentCaptureScope,
  canonicalAccountContentSyncScopeApproval,
  createAccountContentScopeApprovalEvidence,
  validateAccountContentCaptureScope,
  validateAccountContentScopeApprovalEvidence,
  validateAccountContentSyncScopeApproval,
  type AccountContentSyncScopeApproval,
} from '../src/contentScope';
import {
  canonicalAccountSyncScopeApproval,
  createAccountScopeApprovalEvidence,
  validateAccountCaptureScope,
  validateAccountScopeApprovalEvidence,
  validateAccountSyncScopeApproval,
} from '../src/scope';
import { AccountReplicationError } from '../src/replicationTypes';
import { id, timestamp } from './fixtures';

const approval = (): AccountContentSyncScopeApproval => ({
  schemaVersion: 1,
  ownerId: id(100),
  installationId: id(200),
  scopeVersion: 3,
  personalApproved: true,
  historyIncluded: false,
  decidedAt: timestamp,
});
const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const scope = () => ({
  version: 3 as const,
  approvalDigest: 'a'.repeat(64),
  historyIncluded: false,
});

test('private approval has exact owner/installation identity and explicit history participation in its canonical digest', async () => {
  const record = approval();
  assert.ok(validateAccountContentSyncScopeApproval(record));
  const serialized = canonicalAccountContentSyncScopeApproval(record);
  assert.equal(
    serialized,
    JSON.stringify({
      decidedAt: timestamp,
      historyIncluded: false,
      installationId: id(200),
      ownerId: id(100),
      personalApproved: true,
      schemaVersion: 1,
      scopeVersion: 3,
    }),
  );
  const evidence = await createAccountContentScopeApprovalEvidence(record, sha256);
  assert.equal(evidence.digest, await sha256(serialized));
  assert.ok(validateAccountContentScopeApprovalEvidence(evidence));
  assert.ok(Object.isFrozen(evidence) && Object.isFrozen(evidence.record));
  assert.equal(Reflect.set(evidence.record, 'historyIncluded', true), false);
  assert.equal(Reflect.set(evidence, 'digest', 'b'.repeat(64)), false);
  for (const changed of [
    { ...record, ownerId: id(101) },
    { ...record, installationId: id(201) },
    { ...record, historyIncluded: true },
  ])
    assert.notEqual(
      (await createAccountContentScopeApprovalEvidence(changed, sha256)).digest,
      evidence.digest,
    );
  assert.equal(record.historyIncluded, false);
});

test('approval rejects unknown fields, nonmatching versions, invalid identities and malformed instants', () => {
  const record = approval();
  for (const value of [
    null,
    { ...record, extra: true },
    { ...record, schemaVersion: 2 },
    { ...record, scopeVersion: 1 },
    { ...record, scopeVersion: 2 },
    { ...record, scopeVersion: 4 },
    { ...record, personalApproved: false },
    { ...record, historyIncluded: undefined },
    { ...record, historyIncluded: 1 },
    { ...record, ownerId: 'someone' },
    { ...record, installationId: 'another-device' },
    { ...record, ownerId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { ...record, installationId: id(200).replace('-4000-', '-7000-') },
    { ...record, decidedAt: '2026-02-30T08:00:00.000Z' },
    { ...record, decidedAt: '2026-10-01T12:00:00+04:00' },
  ]) {
    assert.equal(validateAccountContentSyncScopeApproval(value), false);
    assert.throws(() => canonicalAccountContentSyncScopeApproval(value), AccountReplicationError);
  }
});

test('hostile descriptors, prototypes and toJSON never execute during validation or hashing', async () => {
  let invocations = 0,
    hashes = 0;
  const getter = { ...approval() };
  Object.defineProperty(getter, 'ownerId', {
    enumerable: true,
    get() {
      invocations++;
      throw new Error('getter ran');
    },
  });
  const toJSON = {
    ...approval(),
    toJSON() {
      invocations++;
      throw new Error('toJSON ran');
    },
  };
  const hidden = { ...approval() };
  Object.defineProperty(hidden, 'hidden', { value: true });
  const symbol = { ...approval(), [Symbol('hidden')]: true };
  const inherited = Object.assign(
    Object.create({ unrelated: true }),
    approval(),
  ) as AccountContentSyncScopeApproval;
  for (const value of [getter, toJSON, hidden, symbol, inherited]) {
    assert.equal(validateAccountContentSyncScopeApproval(value), false);
    await assert.rejects(
      createAccountContentScopeApprovalEvidence(value, async () => {
        hashes++;
        return 'a'.repeat(64);
      }),
      AccountReplicationError,
    );
  }
  const nested = { record: approval(), digest: 'a'.repeat(64) };
  Object.defineProperty(nested, 'record', {
    enumerable: true,
    get() {
      invocations++;
      throw new Error('nested getter ran');
    },
  });
  assert.equal(validateAccountContentScopeApprovalEvidence(nested), false);
  const hostileScope = { ...scope() };
  Object.defineProperty(hostileScope, 'historyIncluded', {
    enumerable: true,
    get() {
      invocations++;
      return false;
    },
  });
  assert.equal(validateAccountContentCaptureScope(hostileScope), false);
  assert.throws(() => canonicalAccountContentCaptureScope(hostileScope), AccountReplicationError);
  assert.equal(invocations, 0);
  assert.equal(hashes, 0);
});

test('ownership precedes the hash await and evidence remains immutable after caller mutation', async () => {
  const record = approval(),
    original = { ...record };
  let resolve!: (digest: string) => void;
  let hashed = '';
  const pending = createAccountContentScopeApprovalEvidence(record, async (serialized) => {
    hashed = serialized;
    return new Promise<string>((done) => {
      resolve = done;
    });
  });
  record.historyIncluded = true;
  record.ownerId = id(101);
  record.installationId = id(201);
  resolve(await sha256(hashed));
  const evidence = await pending;
  assert.deepEqual(evidence.record, original);
  assert.equal(evidence.digest, await sha256(canonicalAccountContentSyncScopeApproval(original)));
  assert.ok(Object.isFrozen(evidence.record));
});

test('the 4096-byte data-only boundary rejects large UTF-8 input before invoking the hash', async () => {
  assert.equal(ACCOUNT_CONTENT_SCOPE_MAX_BYTES, 4096);
  const record = { ...approval(), decidedAt: '🍲'.repeat(1100) };
  let hashes = 0;
  assert.ok(record.decidedAt.length < ACCOUNT_CONTENT_SCOPE_MAX_BYTES);
  assert.equal(validateAccountContentSyncScopeApproval(record), false);
  await assert.rejects(
    createAccountContentScopeApprovalEvidence(record, async () => {
      hashes++;
      return 'a'.repeat(64);
    }),
    (error) => error instanceof AccountReplicationError && error.reason === 'too_large',
  );
  assert.equal(hashes, 0);
  assert.equal(
    validateAccountContentScopeApprovalEvidence({ record: approval(), digest: 'a'.repeat(4097) }),
    false,
  );
  assert.equal(
    validateAccountContentCaptureScope({ ...scope(), approvalDigest: 'a'.repeat(4097) }),
    false,
  );
});

test('hash failures and malformed digests never produce evidence; structural validation grants no digest authority', async () => {
  for (const digest of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])
    await assert.rejects(
      createAccountContentScopeApprovalEvidence(approval(), async () => digest),
      AccountReplicationError,
    );
  const failure = new Error('fixture hash unavailable');
  await assert.rejects(
    createAccountContentScopeApprovalEvidence(approval(), async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  const evidence = await createAccountContentScopeApprovalEvidence(approval(), sha256);
  assert.equal(validateAccountContentScopeApprovalEvidence({ ...evidence, extra: true }), false);
  assert.equal(
    validateAccountContentScopeApprovalEvidence({ ...evidence, digest: 'invalid' }),
    false,
  );
  const changed = { record: { ...evidence.record, ownerId: id(101) }, digest: evidence.digest };
  assert.ok(
    validateAccountContentScopeApprovalEvidence(changed),
    'shape validation deliberately does not authenticate evidence',
  );
  assert.notEqual(
    (await createAccountContentScopeApprovalEvidence(changed.record, sha256)).digest,
    changed.digest,
  );
});

test('capture scope equality binds version, approval digest and the explicit history choice', () => {
  const first = scope();
  assert.ok(validateAccountContentCaptureScope(first));
  assert.ok(accountContentCaptureScopesEqual(first, { ...first }));
  assert.equal(accountContentCaptureScopesEqual(first, { ...first, historyIncluded: true }), false);
  assert.equal(
    accountContentCaptureScopesEqual(first, { ...first, approvalDigest: 'b'.repeat(64) }),
    false,
  );
  for (const value of [
    { version: 1 },
    { ...first, version: 2 },
    { ...first, version: 4 },
    { version: 3, approvalDigest: first.approvalDigest },
    { ...first, historyIncluded: null },
    { ...first, approvalDigest: 'A'.repeat(64) },
    { ...first, extra: true },
  ]) {
    assert.equal(validateAccountContentCaptureScope(value), false);
    assert.throws(() => canonicalAccountContentCaptureScope(value), AccountReplicationError);
  }
});

test('version2 canonical approval and validation remain unchanged and reject private version3 evidence', async () => {
  const { installationId: _installation, ...fields } = approval();
  const legacy = { ...fields, scopeVersion: 2 as const };
  const golden = `{"decidedAt":"${timestamp}","historyIncluded":false,"ownerId":"${id(100)}","personalApproved":true,"schemaVersion":1,"scopeVersion":2}`;
  assert.ok(validateAccountSyncScopeApproval(legacy));
  assert.equal(canonicalAccountSyncScopeApproval(legacy), golden);
  const evidence = await createAccountScopeApprovalEvidence(legacy, sha256);
  assert.deepEqual(evidence, { record: JSON.parse(golden), digest: await sha256(golden) });
  assert.ok(validateAccountScopeApprovalEvidence(evidence));
  assert.equal(validateAccountContentSyncScopeApproval(legacy), false);
  assert.equal(validateAccountContentScopeApprovalEvidence(evidence), false);
  assert.equal(validateAccountSyncScopeApproval(approval()), false);
  assert.equal(
    validateAccountScopeApprovalEvidence(
      await createAccountContentScopeApprovalEvidence(approval(), sha256),
    ),
    false,
  );
  assert.equal(validateAccountCaptureScope(scope()), false);
  assert.ok(validateAccountCaptureScope({ ...scope(), version: 2 }));
});
