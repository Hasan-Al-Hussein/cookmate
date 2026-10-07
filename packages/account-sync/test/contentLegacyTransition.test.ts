import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PORTABLE_BACKUP_MAX_BYTES, portableBackupByteLength } from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../domain/src/portableBackupContent';
import {
  ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES,
  ACCOUNT_LEGACY_CONTENT_RESOLUTIONS_MAX_BYTES,
  accountLegacyContentTransitionFingerprint,
  parseAccountLegacyContentTransition,
  serializeAccountLegacyContentTransition,
  type AccountLegacyContentTransition,
  type AccountLegacyContentTransitionDraft,
} from '../src/contentLegacyTransition';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../src/contentSnapshot';
import { AccountReplicationError } from '../src/replicationTypes';
import { ACCOUNT_SNAPSHOT_MAX_BYTES, type AccountSnapshotV2 } from '../src/types';
import { canonicalAccountSnapshot, parseAccountSnapshot } from '../src/validation';
import { expandedSnapshot, history, note } from './expandedFixtures';
import { catalogue, id, later, occurrence, snapshot, timestamp } from './fixtures';

// Data-codec fixtures only: these refs/projection digests carry no content or review authority.
const ownerId = id(900),
  installationId = id(901),
  networkOperationId = id(902),
  localApplyOperationId = id(903);
const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const failure = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;
function content(historyIncluded = true): AccountContentSnapshot {
  const { cookingHistory: _history, ...core } = expandedSnapshot();
  return {
    ...core,
    schemaVersion: 3,
    plan: [occurrence(1)],
    planReferences: [
      {
        occurrenceId: id(1),
        contentRef: {
          recipeId: '52819',
          revisionId: 'fixture-bundled',
          contentFingerprint: 'b'.repeat(64),
        },
      },
    ],
    personal: {
      notes: [note(3, '52819', ' Original\n🍲\0 ')],
      collections: [],
      memberships: [],
      manualItems: [],
    },
    ...(historyIncluded
      ? {
          cookingHistory: {
            entries: [
              {
                kind: 'legacy' as const,
                entry: history(4),
                pin: { kind: 'unresolved' as const, reason: 'content_mismatch' as const },
              },
            ],
            removedEventIds: [id(5)],
          },
        }
      : {}),
  };
}
function legacy(): AccountSnapshotV2 {
  return {
    ...expandedSnapshot(),
    personal: content(false).personal,
    cookingHistory: { entries: [history(4)], removedEventIds: [id(5)] },
  };
}
function draftOf(value: AccountLegacyContentTransition): AccountLegacyContentTransitionDraft {
  const {
    schemaVersion: _version,
    kind: _kind,
    revision: _revision,
    requestFingerprint: _fingerprint,
    acknowledgement: _ack,
    handoff: _handoff,
    lastApply: _apply,
    ...draft
  } = value;
  return draft;
}
async function seal(value: AccountLegacyContentTransition) {
  value.remoteDigest = await sha256(canonicalAccountSnapshot(value.remote.snapshot!));
  value.proposedDigest = await sha256(canonicalAccountContentSnapshot(value.proposed));
  value.requestFingerprint = await accountLegacyContentTransitionFingerprint(
    draftOf(value),
    sha256,
  );
  return value;
}
async function fixture(historyIncluded = true): Promise<AccountLegacyContentTransition> {
  return seal({
    schemaVersion: 1,
    kind: 'legacy_to_content3',
    ownerId,
    installationId,
    revision: 1,
    legacy: {
      journalDigest: 'a'.repeat(64),
      journalRevision: 4,
      base: {
        ownerId,
        revision: 1,
        snapshot: legacy(),
        updatedAt: timestamp,
        deletionOperationId: null,
      },
      observed: { revision: 2, snapshotDigest: 'c'.repeat(64), updatedAt: timestamp },
      baseProjectionDigest: 'd'.repeat(64),
    },
    remote: {
      ownerId,
      revision: 3,
      snapshot: legacy(),
      updatedAt: later,
      deletionOperationId: null,
    },
    remoteDigest: '0'.repeat(64),
    remoteProjectionDigest: 'e'.repeat(64),
    capturedLocal: {
      storeRevision: 5,
      snapshot: content(historyIncluded),
      scope: { version: 3, approvalDigest: 'f'.repeat(64), historyIncluded },
      fenceDigest: '1'.repeat(64),
    },
    networkOperationId,
    localApplyOperationId,
    proposed: content(),
    proposedDigest: '0'.repeat(64),
    review: { initialImportReviewed: false, resolutions: { 'exact-fixture-conflict': 'local' } },
    requestFingerprint: '0'.repeat(64),
    acknowledgement: null,
    handoff: null,
    lastApply: null,
  });
}
function acknowledged(value: AccountLegacyContentTransition) {
  value.revision++;
  value.acknowledgement = {
    ownerId,
    operationId: networkOperationId,
    revision: value.remote.revision + 1,
    committedAt: '2026-10-01T12:00:01.654321+00:00',
  };
  return value;
}
function linked(value: AccountLegacyContentTransition) {
  acknowledged(value);
  value.revision++;
  value.handoff = { requestFingerprint: '9'.repeat(64) };
  return value;
}
function applied(value: AccountLegacyContentTransition) {
  linked(value);
  value.revision++;
  value.lastApply = {
    ownerId,
    operationId: localApplyOperationId,
    requestFingerprint: value.handoff!.requestFingerprint,
    serverRevision: value.acknowledgement!.revision,
    storeRevision: 6,
    appliedAt: '2026-10-01T12:00:02.000Z',
  };
  return value;
}
const serialize = (input: unknown, hash = sha256) =>
  serializeAccountLegacyContentTransition(input, ownerId, installationId, hash);
const parse = (input: string, hash = sha256) =>
  parseAccountLegacyContentTransition(input, ownerId, installationId, hash);

test('round-trips immutable evidence through acknowledgement, linked handoff and genuine local receipt without conflating original digests', async () => {
  const value = await fixture(),
    originalLegacyBytes = canonicalAccountSnapshot(value.legacy.base!.snapshot!);
  const fingerprint = value.requestFingerprint;
  for (const advance of [
    (value: AccountLegacyContentTransition) => value,
    acknowledged,
    linked,
    applied,
  ]) {
    const state = advance(clone(value)),
      before = clone(state),
      serialized = await serialize(state),
      result = await parse(serialized);
    assert.deepEqual(result, before);
    assert.equal(await serialize(result), serialized);
    assert.deepEqual(state, before);
    assert.equal(result.requestFingerprint, fingerprint);
    assert.equal(canonicalAccountSnapshot(state.legacy.base!.snapshot!), originalLegacyBytes);
    assert.notEqual(result.remoteDigest, result.remoteProjectionDigest);
    assert.notEqual(result.legacy.journalDigest, result.legacy.baseProjectionDigest);
    assert.ok(
      Object.isFrozen(result) &&
        Object.isFrozen(result.capturedLocal.snapshot.planReferences[0]!.contentRef),
    );
    assert.throws(() => {
      (result.proposed.plan as unknown as unknown[]).pop();
    }, TypeError);
  }
  assert.equal(value.acknowledgement, null);
  assert.equal(value.lastApply, null);
  assert.equal(
    value.review.initialImportReviewed,
    false,
    'a retained flag is not implicit approval',
  );
});

test('no-base remains null even with an old remote observation; absent legacy history is not invented', async () => {
  const value = await fixture(false);
  value.legacy.base = null;
  value.legacy.baseProjectionDigest = null;
  value.remote.snapshot = snapshot();
  delete value.proposed.cookingHistory;
  await seal(value);
  const result = await parse(await serialize(value));
  assert.equal(result.legacy.base, null);
  assert.equal(result.legacy.baseProjectionDigest, null);
  assert.equal(result.remote.snapshot!.schemaVersion, 1);
  assert.equal(result.lastApply, null);
  assert.equal(Object.hasOwn(result.capturedLocal.snapshot, 'cookingHistory'), false);
  assert.equal(Object.hasOwn(result.proposed, 'cookingHistory'), false);
  const bad = clone(value);
  bad.legacy.baseProjectionDigest = '1'.repeat(64);
  await assert.rejects(serialize(bad), failure('invalid_input'));
});

test('request fingerprint binds every immutable evidence group and exact review choices, independent of progress', async () => {
  const value = await fixture(),
    expected = value.requestFingerprint;
  assert.equal(
    expected,
    await sha256(
      canonicalPortableContentJson({
        domain: 'cookmate-account-legacy-content-transition-v1',
        ...draftOf(value),
      }),
    ),
  );
  const changes: ((copy: AccountLegacyContentTransition) => void)[] = [
    (copy) => {
      copy.installationId = id(999);
    },
    (copy) => {
      copy.legacy.journalDigest = '2'.repeat(64);
    },
    (copy) => {
      copy.legacy.journalRevision++;
    },
    (copy) => {
      copy.legacy.base!.snapshot!.profile.displayName = 'Old base';
    },
    (copy) => {
      copy.legacy.baseProjectionDigest = '3'.repeat(64);
    },
    (copy) => {
      copy.legacy.observed.snapshotDigest = '4'.repeat(64);
    },
    (copy) => {
      copy.legacy.observed.updatedAt = later;
    },
    (copy) => {
      copy.remote.revision++;
    },
    (copy) => {
      copy.remote.snapshot!.profile.displayName = 'Remote';
    },
    (copy) => {
      copy.remoteProjectionDigest = '5'.repeat(64);
    },
    (copy) => {
      copy.capturedLocal.storeRevision++;
    },
    (copy) => {
      copy.capturedLocal.fenceDigest = '6'.repeat(64);
    },
    (copy) => {
      copy.capturedLocal.scope.approvalDigest = '7'.repeat(64);
    },
    (copy) => {
      copy.capturedLocal.snapshot.personal.notes[0]!.text = 'Exact late local text';
    },
    (copy) => {
      copy.networkOperationId = id(998);
    },
    (copy) => {
      copy.localApplyOperationId = id(997);
    },
    (copy) => {
      copy.proposed.personal.notes[0]!.text = 'Reviewed text';
    },
    (copy) => {
      copy.review.initialImportReviewed = true;
    },
    (copy) => {
      copy.review.resolutions = { ...copy.review.resolutions, 'exact-fixture-conflict': 'account' };
    },
  ];
  for (const change of changes) {
    const copy = clone(value);
    change(copy);
    await seal(copy);
    assert.notEqual(copy.requestFingerprint, expected);
  }
  const scope = clone(value);
  scope.capturedLocal.scope.historyIncluded = false;
  delete scope.capturedLocal.snapshot.cookingHistory;
  await seal(scope);
  assert.notEqual(scope.requestFingerprint, expected);
  const otherOwner = clone(value);
  otherOwner.ownerId = id(996);
  otherOwner.remote.ownerId = id(996);
  otherOwner.legacy.base!.ownerId = id(996);
  await seal(otherOwner);
  assert.notEqual(otherOwner.requestFingerprint, expected);
});

test('same original revisions bind exact digests and timestamps, never projected values or stale snapshot bytes', async () => {
  const value = await fixture();
  value.remote.updatedAt = '2026-10-01T12:00:00.123456+00:00';
  value.legacy.base = clone(value.remote);
  value.legacy.observed = {
    revision: 3,
    snapshotDigest: value.remoteDigest,
    updatedAt: value.remote.updatedAt,
  };
  await seal(value);
  const result = await parse(await serialize(value));
  assert.equal(result.legacy.observed.updatedAt, value.remote.updatedAt);
  const changes: ((copy: AccountLegacyContentTransition) => void)[] = [
    (copy) => {
      copy.legacy.observed.snapshotDigest = copy.remoteProjectionDigest;
    },
    (copy) => {
      copy.legacy.observed.updatedAt = timestamp;
    },
    (copy) => {
      copy.legacy.base!.updatedAt = timestamp;
    },
    (copy) => {
      copy.legacy.base!.snapshot!.profile.displayName = 'Tampered base';
    },
    (copy) => {
      copy.remote.snapshot!.profile.displayName = 'Tampered remote';
    },
    (copy) => {
      copy.proposed.personal.notes[0]!.text = 'Tampered proposal';
    },
    (copy) => {
      copy.proposedDigest = '8'.repeat(64);
    },
    (copy) => {
      copy.requestFingerprint = '8'.repeat(64);
    },
  ];
  for (const change of changes) {
    const copy = clone(value);
    change(copy);
    await assert.rejects(serialize(copy), failure('invalid_input'));
  }
});

test('rejects remote/base downgrade, empty or already-upgraded remote, unsafe increments, wrong identity and catalogue', async () => {
  const value = await fixture();
  const changes: ((copy: AccountLegacyContentTransition) => void)[] = [
    (copy) => {
      copy.remote.revision = 1;
    },
    (copy) => {
      copy.legacy.base!.revision = 3;
    },
    (copy) => {
      copy.remote.snapshot = snapshot();
    },
    (copy) => {
      copy.remote.snapshot = null;
    },
    (copy) => {
      Object.assign(copy.remote, { snapshot: content() });
    },
    (copy) => {
      copy.remote.revision = Number.MAX_SAFE_INTEGER;
    },
    (copy) => {
      copy.revision = Number.MAX_SAFE_INTEGER;
    },
    (copy) => {
      copy.revision = 0;
    },
    (copy) => {
      copy.legacy.journalRevision = 0;
    },
    (copy) => {
      copy.legacy.observed.revision = Number.MAX_SAFE_INTEGER + 1;
    },
    (copy) => {
      copy.remote.deletionOperationId = id(997);
    },
    (copy) => {
      copy.remote.ownerId = id(996);
    },
    (copy) => {
      copy.networkOperationId = copy.localApplyOperationId;
    },
    (copy) => {
      copy.capturedLocal.snapshot.catalogue = { ...catalogue, version: 'different' };
    },
    (copy) => {
      copy.legacy.base!.snapshot!.catalogue = { ...catalogue, version: 'different' };
    },
  ];
  for (const change of changes) {
    const copy = clone(value);
    change(copy);
    await assert.rejects(serialize(copy), failure('invalid_input'));
  }
  const bytes = await serialize(value);
  await assert.rejects(
    parseAccountLegacyContentTransition(bytes, id(999), installationId, sha256),
    failure('stored_data_invalid'),
  );
  await assert.rejects(
    parseAccountLegacyContentTransition(bytes, ownerId, id(999), sha256),
    failure('stored_data_invalid'),
  );
});

test('acknowledgement requires the genuine network identity and next revision, preserving exact UTC microseconds', async () => {
  const value = acknowledged(await fixture()),
    result = await parse(await serialize(value));
  assert.equal(result.acknowledgement!.committedAt, '2026-10-01T12:00:01.654321+00:00');
  for (const patch of [
    { ownerId: id(99) },
    { operationId: localApplyOperationId },
    { revision: 3 },
    { revision: 5 },
    { committedAt: '2026-10-01T16:00:00.000+04:00' },
    { committedAt: '2026-02-30T12:00:00.000Z' },
    { extra: 'fake authority' },
  ]) {
    const copy = clone(value);
    Object.assign(copy.acknowledgement!, patch);
    await assert.rejects(serialize(copy), failure('invalid_input'));
  }
});

test('handoff and local receipt are ordered and bound to distinct operations, server revision and nonregressing local clocks', async () => {
  const value = applied(await fixture());
  const changes: ((copy: AccountLegacyContentTransition) => void)[] = [
    (copy) => {
      copy.acknowledgement = null;
    },
    (copy) => {
      copy.handoff = null;
    },
    (copy) => {
      copy.lastApply!.operationId = networkOperationId;
    },
    (copy) => {
      copy.lastApply!.ownerId = id(99);
    },
    (copy) => {
      copy.lastApply!.serverRevision++;
    },
    (copy) => {
      copy.lastApply!.storeRevision = 4;
    },
    (copy) => {
      copy.lastApply!.storeRevision = 0;
    },
    (copy) => {
      copy.lastApply!.requestFingerprint = '8'.repeat(64);
    },
    (copy) => {
      copy.lastApply!.appliedAt = '2026-10-01T12:00:02.123456+00:00';
    },
  ];
  for (const change of changes) {
    const copy = clone(value);
    change(copy);
    await assert.rejects(serialize(copy), failure('invalid_input'));
  }
  const noAck = await fixture();
  noAck.handoff = { requestFingerprint: '8'.repeat(64) };
  await assert.rejects(serialize(noAck), failure('invalid_input'));
  value.lastApply!.storeRevision = value.capturedLocal.storeRevision;
  await serialize(value);
});

test('capture scope3 participation is exact; projection and history-exclusion equality still require host verification', async () => {
  const off = await fixture(false),
    result = await parse(await serialize(off));
  assert.equal(Object.hasOwn(result.capturedLocal.snapshot, 'cookingHistory'), false);
  assert.ok(
    result.proposed.cookingHistory,
    'excluded remote history can remain in a complete proposal',
  );
  const includedOff = clone(off);
  includedOff.capturedLocal.snapshot.cookingHistory = { entries: [], removedEventIds: [] };
  await assert.rejects(serialize(includedOff), failure('invalid_input'));
  const on = await fixture();
  delete on.capturedLocal.snapshot.cookingHistory;
  await assert.rejects(serialize(on), failure('invalid_input'));
  const noProposed = await fixture();
  delete noProposed.proposed.cookingHistory;
  await assert.rejects(serialize(noProposed), failure('invalid_input'));
  const oldScope = clone(off);
  Object.assign(oldScope.capturedLocal.scope, { version: 2 });
  await assert.rejects(serialize(oldScope), failure('invalid_input'));
  const shapeOnly = clone(off);
  shapeOnly.remoteProjectionDigest = '2'.repeat(64);
  shapeOnly.proposed.cookingHistory!.removedEventIds = [];
  await seal(shapeOnly);
  await serialize(shapeOnly);
  assert.notEqual(
    shapeOnly.requestFingerprint,
    off.requestFingerprint,
    'the host must independently authenticate projections and compare opted-out history',
  );
});

test('strict keys, versions and malformed serialized records fail without widening active1/2 codecs', async () => {
  const value = await fixture(),
    old1 = snapshot(),
    old2 = legacy(),
    bytes1 = canonicalAccountSnapshot(old1),
    bytes2 = canonicalAccountSnapshot(old2);
  for (const key of Object.keys(value)) {
    const missing: Record<string, unknown> = { ...value };
    delete missing[key];
    await assert.rejects(serialize(missing), failure('invalid_input'));
  }
  for (const patch of [
    { schemaVersion: 2 },
    { kind: 'already_content3' },
    { authToken: 'never stored' },
  ])
    await assert.rejects(serialize({ ...value, ...patch }), failure('invalid_input'));
  const extra = clone(value);
  Object.assign(extra.capturedLocal, { authGeneration: 1 });
  await assert.rejects(serialize(extra), failure('invalid_input'));
  await assert.rejects(parse('not JSON'), failure('stored_data_invalid'));
  await assert.rejects(
    parse(JSON.stringify({ ...value, requestFingerprint: '0'.repeat(64) })),
    failure('stored_data_invalid'),
  );
  assert.throws(() => parseAccountSnapshot(JSON.stringify(content())));
  assert.throws(() => parseAccountSnapshot(JSON.stringify(value)));
  assert.equal(canonicalAccountSnapshot(old1), bytes1);
  assert.equal(canonicalAccountSnapshot(old2), bytes2);
});

test('accessors, functions, symbols, cycles and sparse arrays are rejected before invoking code or hashes', async () => {
  const value = await fixture();
  let calls = 0;
  const noHash = async (text: string) => {
    calls++;
    return sha256(text);
  };
  const getter = clone(value);
  Object.defineProperty(getter, 'remote', {
    enumerable: true,
    get: () => assert.fail('getter executed'),
  });
  const nested = clone(value);
  Object.defineProperty(nested.proposed.personal.notes[0]!, 'text', {
    enumerable: true,
    get: () => assert.fail('nested getter executed'),
  });
  const hidden = clone(value);
  Object.defineProperty(hidden.legacy, 'secret', { enumerable: false, value: 'private' });
  const symbol = clone(value);
  Object.assign(symbol.review, { [Symbol('hidden')]: true });
  const functional = clone(value);
  Object.assign(functional.proposed, { toJSON: () => assert.fail('toJSON executed') });
  const cycle = clone(value);
  Object.assign(cycle.review, { cycle });
  const sparse = clone(value);
  delete sparse.proposed.plan[0];
  for (const invalid of [getter, nested, hidden, symbol, functional, cycle, sparse])
    await assert.rejects(serialize(invalid, noHash), failure('invalid_input'));
  assert.equal(calls, 0);
});

test('individual snapshot, total UTF8 and resolution bounds fail before any hash', async () => {
  const value = await fixture();
  let calls = 0;
  const noHash = async () => {
    calls++;
    return 'a'.repeat(64);
  };
  await assert.rejects(
    parse(' '.repeat(ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES + 1), noHash),
    failure('too_large'),
  );
  await assert.rejects(
    parse('🍲'.repeat(ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES / 4 + 1), noHash),
    failure('too_large'),
  );
  for (const field of ['proposed', 'capturedLocal', 'remote', 'base'] as const) {
    const copy = clone(value),
      large = 'x'.repeat(ACCOUNT_SNAPSHOT_MAX_BYTES);
    if (field === 'proposed') copy.proposed.personal.notes[0]!.text = large;
    else if (field === 'capturedLocal') copy.capturedLocal.snapshot.personal.notes[0]!.text = large;
    else if (field === 'remote') copy.remote.snapshot!.profile.displayName = large;
    else copy.legacy.base!.snapshot!.profile.displayName = large;
    await assert.rejects(serialize(copy, noHash), failure('too_large'));
  }
  const largeKeys = clone(value);
  largeKeys.review.resolutions = {
    ['🍲'.repeat(ACCOUNT_LEGACY_CONTENT_RESOLUTIONS_MAX_BYTES / 4)]: 'local',
  };
  await assert.rejects(serialize(largeKeys, noHash), failure('too_large'));
  const many = clone(value);
  many.review.resolutions = Object.fromEntries(
    Array.from({ length: 1001 }, (_, index) => [`c${index}`, 'local' as const]),
  );
  await assert.rejects(serialize(many, noHash), failure('invalid_input'));
  const emptyKey = clone(value);
  emptyKey.review.resolutions = { '': 'local' };
  await assert.rejects(serialize(emptyKey, noHash), failure('invalid_input'));
  assert.equal(calls, 0);
});

test('four individually valid near-limit snapshots fit above8MiB without duplicating converted bases', async () => {
  const target = ACCOUNT_SNAPSHOT_MAX_BYTES - 64;
  const old = legacy();
  old.cookingHistory = { entries: [], removedEventIds: [] };
  const oldRecord = { ...history(10), note: 'x'.repeat(500) };
  const oldEmpty = portableBackupByteLength(canonicalAccountSnapshot(old));
  const oldCount = Math.floor(
    (target - oldEmpty + 1) /
      (portableBackupByteLength(canonicalPortableContentJson(oldRecord)) + 1),
  );
  old.cookingHistory.entries = Array.from({ length: oldCount }, (_, index) => ({
    ...oldRecord,
    eventId: id(10000 + index),
  }));
  let remaining = target - portableBackupByteLength(canonicalAccountSnapshot(old));
  for (const entry of old.cookingHistory.entries) {
    const add = Math.min(remaining, 1500);
    entry.note += 'x'.repeat(add);
    remaining -= add;
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  const current = content();
  current.cookingHistory = { entries: [], removedEventIds: [] };
  const contentRecord = {
    kind: 'legacy' as const,
    entry: oldRecord,
    pin: { kind: 'unresolved' as const, reason: 'content_mismatch' as const },
  };
  const currentEmpty = portableBackupByteLength(canonicalAccountContentSnapshot(current));
  const currentCount = Math.floor(
    (target - currentEmpty + 1) /
      (portableBackupByteLength(canonicalPortableContentJson(contentRecord)) + 1),
  );
  current.cookingHistory.entries = Array.from({ length: currentCount }, (_, index) => ({
    ...contentRecord,
    entry: { ...oldRecord, eventId: id(20000 + index) },
  }));
  remaining = target - portableBackupByteLength(canonicalAccountContentSnapshot(current));
  for (const row of current.cookingHistory.entries) {
    const add = Math.min(remaining, 1500);
    row.entry.note = (row.entry.note ?? '') + 'x'.repeat(add);
    remaining -= add;
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  const value = await fixture();
  value.legacy.base!.snapshot = old;
  value.remote.snapshot = old;
  value.capturedLocal.snapshot = current;
  value.proposed = current;
  await seal(value);
  const serialized = await serialize(value),
    bytes = portableBackupByteLength(serialized);
  assert.ok(
    bytes > PORTABLE_BACKUP_MAX_BYTES && bytes <= ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES,
  );
  const result = await parse(serialized);
  assert.equal(result.remote.snapshot!.schemaVersion, 2);
  assert.equal(result.proposed.cookingHistory!.entries.length, currentCount);
  assert.equal(portableBackupByteLength(canonicalAccountSnapshot(old)), target);
  assert.equal(portableBackupByteLength(canonicalAccountContentSnapshot(current)), target);
});

test('owns all immutable evidence before the first await, for both serialization and request hashing', async () => {
  const value = await fixture(),
    expected = await serialize(value);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  let first = true;
  const pending = serialize(value, async (text) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    return sha256(text);
  });
  await started;
  value.ownerId = id(99);
  value.legacy.journalDigest = '8'.repeat(64);
  value.proposed.personal.notes[0]!.text = 'Late edit';
  value.review.resolutions = {};
  release();
  assert.equal(await pending, expected);
  const fresh = await fixture(),
    draft = draftOf(fresh),
    expectedFingerprint = fresh.requestFingerprint;
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const fingerprint = accountLegacyContentTransitionFingerprint(draft, async (text) => {
    await wait;
    return sha256(text);
  });
  draft.capturedLocal.fenceDigest = '9'.repeat(64);
  draft.remoteProjectionDigest = '9'.repeat(64);
  draft.review.initialImportReviewed = true;
  resume();
  assert.equal(await fingerprint, expectedFingerprint);
});

test('validates every digest result, reports stored corruption and preserves actual hash-port failures', async () => {
  const value = await fixture();
  value.legacy.base = clone(value.remote);
  value.legacy.observed = {
    revision: 3,
    snapshotDigest: value.remoteDigest,
    updatedAt: value.remote.updatedAt,
  };
  await seal(value);
  const bytes = await serialize(value);
  for (const invalidCall of [1, 2, 3, 4]) {
    let calls = 0;
    const invalid = async (text: string) =>
      ++calls === invalidCall ? 'not-a-digest' : sha256(text);
    await assert.rejects(serialize(value, invalid), failure('invalid_input'));
  }
  await assert.rejects(
    parse(bytes, async () => 'bad'),
    failure('stored_data_invalid'),
  );
  const unavailable = new Error('hash port unavailable');
  await assert.rejects(
    serialize(value, async () => {
      throw unavailable;
    }),
    (error) => error === unavailable,
  );
  await assert.rejects(
    parse(bytes, async () => {
      throw unavailable;
    }),
    (error) => error === unavailable,
  );
});
