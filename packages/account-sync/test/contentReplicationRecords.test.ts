import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PORTABLE_BACKUP_MAX_BYTES, portableBackupByteLength } from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../domain/src/portableBackupContent';
import {
  ACCOUNT_CONTENT_JOURNAL_MAX_BYTES,
  accountContentPendingFingerprint,
  normalizeAccountContentRemoteState,
  parseAccountContentJournal,
  serializeAccountContentJournal,
  type AccountContentPendingDraft,
  type AccountContentReplicationJournal,
} from '../src/contentReplicationRecords';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../src/contentSnapshot';
import { AccountReplicationError } from '../src/replicationTypes';
import { ACCOUNT_SNAPSHOT_MAX_BYTES } from '../src/types';
import { canonicalAccountSnapshot, parseAccountSnapshot } from '../src/validation';
import { expandedSnapshot, history, note } from './expandedFixtures';
import { catalogue, id, occurrence, snapshot, timestamp } from './fixtures';

const ownerId = id(900),
  installationId = id(901),
  operationId = id(902);
const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const failure = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;
const first = {
  recipeId: '52819',
  revisionId: 'fixture-first',
  contentFingerprint: 'a'.repeat(64),
};
const second = { ...first, revisionId: 'fixture-second', contentFingerprint: 'b'.repeat(64) };
function content(historyIncluded = true): AccountContentSnapshot {
  const { cookingHistory: _legacyHistory, ...core } = expandedSnapshot();
  return {
    ...core,
    schemaVersion: 3,
    plan: [occurrence(1), occurrence(2, '52819', '2026-10-02')],
    planReferences: [
      { occurrenceId: id(1), contentRef: { ...first } },
      { occurrenceId: id(2), contentRef: { ...second } },
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
function requestDraft(value: AccountContentReplicationJournal): AccountContentPendingDraft {
  const pending = value.pending!;
  return {
    operationId: pending.operationId,
    mode: pending.mode,
    capturedLocal: pending.capturedLocal,
    remote: pending.remote,
    proposed: pending.proposed,
  };
}
async function seal(value: AccountContentReplicationJournal) {
  const pending = value.pending!;
  pending.proposedDigest = await sha256(canonicalAccountContentSnapshot(pending.proposed));
  pending.requestFingerprint = await accountContentPendingFingerprint(
    value.ownerId,
    value.installationId,
    value.legacyJournalDigest,
    requestDraft(value),
    sha256,
  );
  value.observed = {
    revision: pending.remote.revision,
    updatedAt: pending.remote.updatedAt,
    snapshotDigest:
      pending.remote.snapshot === null
        ? null
        : await sha256(canonicalAccountContentSnapshot(pending.remote.snapshot)),
  };
  return value;
}
async function fixture(historyIncluded = true): Promise<AccountContentReplicationJournal> {
  const scope = { version: 3 as const, approvalDigest: 'c'.repeat(64), historyIncluded };
  const remote = {
    ownerId,
    revision: 2,
    snapshot: content(),
    updatedAt: timestamp,
    deletionOperationId: null,
  };
  return seal({
    schemaVersion: 3,
    ownerId,
    installationId,
    revision: 4,
    legacyJournalDigest: 'd'.repeat(64),
    scope,
    base: { ...clone(remote), revision: 1 },
    observed: { revision: 2, snapshotDigest: '0'.repeat(64), updatedAt: timestamp },
    lastApply: {
      ownerId,
      operationId: id(899),
      storeRevision: 3,
      serverRevision: 1,
      appliedAt: timestamp,
      requestFingerprint: 'e'.repeat(64),
    },
    pending: {
      operationId,
      requestFingerprint: '0'.repeat(64),
      mode: 'push',
      capturedLocal: {
        storeRevision: 5,
        snapshot: content(historyIncluded),
        scope: { ...scope },
        fenceDigest: 'f'.repeat(64),
      },
      remote,
      proposed: content(),
      proposedDigest: '0'.repeat(64),
      acknowledgement: null,
    },
  });
}
const serialize = (value: unknown, hash = sha256) =>
  serializeAccountContentJournal(value, ownerId, installationId, hash);
const parse = (value: string, hash = sha256) =>
  parseAccountContentJournal(value, ownerId, installationId, hash);

test('private journal round-trips exact format3 references, complete capture-fence digest and bound immutable receipts', async () => {
  const value = await fixture(),
    before = clone(value),
    serialized = await serialize(value),
    result = await parse(serialized);
  assert.deepEqual(result, before);
  assert.equal(await serialize(result), serialized);
  assert.deepEqual(value, before);
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.pending) &&
      Object.isFrozen(result.pending!.capturedLocal.snapshot.planReferences[0]!.contentRef),
  );
  assert.throws(() => {
    (result.pending!.proposed.planReferences as unknown as unknown[]).pop();
  }, TypeError);
  assert.equal(result.pending!.capturedLocal.fenceDigest, 'f'.repeat(64));
  assert.equal(result.pending!.proposed.planReferences[1]!.contentRef.revisionId, 'fixture-second');
  assert.equal(result.lastApply!.requestFingerprint, 'e'.repeat(64));
});

test('real PostgreSQL UTC microsecond observations and acknowledgements retain their exact wire strings', async () => {
  const value = await fixture();
  const observedAt = '2026-10-01T12:00:00.123456+00:00';
  const committedAt = '2026-10-01T12:00:01.654321+00:00';
  value.base!.updatedAt = observedAt;
  value.pending!.remote.updatedAt = observedAt;
  value.pending!.acknowledgement = {
    ownerId,
    operationId,
    revision: value.pending!.remote.revision + 1,
    committedAt,
  };
  await seal(value);
  const result = await parse(await serialize(value));
  assert.equal(result.base!.updatedAt, observedAt);
  assert.equal(result.observed.updatedAt, observedAt);
  assert.equal(result.pending!.remote.updatedAt, observedAt);
  assert.equal(result.pending!.acknowledgement!.committedAt, committedAt);
});

test('transport timestamp compatibility does not admit non-UTC observations or relax local apply time', async () => {
  const invalidRemote = await fixture();
  invalidRemote.pending!.remote.updatedAt = '2026-10-01T16:00:00.123456+04:00';
  await assert.rejects(serialize(invalidRemote), failure('invalid_input'));
  const invalidLocal = await fixture();
  invalidLocal.lastApply!.appliedAt = '2026-10-01T12:00:00.123456+00:00';
  await assert.rejects(serialize(invalidLocal), failure('invalid_input'));
});

test('pending fingerprint binds every immutable field and is independent of journal revision and acknowledgement', async () => {
  const journal = await fixture(),
    draft = requestDraft(journal);
  const expected = await sha256(
    canonicalPortableContentJson({
      ownerId,
      installationId,
      legacyJournalDigest: journal.legacyJournalDigest,
      ...draft,
    }),
  );
  assert.equal(journal.pending!.requestFingerprint, expected);
  const changes: ((value: AccountContentPendingDraft) => void)[] = [
    (value) => {
      value.operationId = id(903);
    },
    (value) => {
      value.mode = 'pull';
    },
    (value) => {
      value.capturedLocal.fenceDigest = '1'.repeat(64);
    },
    (value) => {
      value.capturedLocal.storeRevision++;
    },
    (value) => {
      value.capturedLocal.scope.approvalDigest = '2'.repeat(64);
    },
    (value) => {
      value.capturedLocal.snapshot.personal.notes[0]!.text = 'late local note';
    },
    (value) => {
      value.remote.revision++;
    },
    (value) => {
      value.proposed.personal.notes[0]!.text = 'reviewed change';
    },
  ];
  for (const change of changes) {
    const copy = clone(draft);
    change(copy);
    assert.notEqual(
      await accountContentPendingFingerprint(
        ownerId,
        installationId,
        journal.legacyJournalDigest,
        copy,
        sha256,
      ),
      expected,
    );
  }
  assert.notEqual(
    await accountContentPendingFingerprint(
      ownerId,
      id(999),
      journal.legacyJournalDigest,
      draft,
      sha256,
    ),
    expected,
  );
  assert.notEqual(
    await accountContentPendingFingerprint(ownerId, installationId, null, draft, sha256),
    expected,
  );
  const other = clone(draft);
  other.remote.ownerId = id(998);
  assert.notEqual(
    await accountContentPendingFingerprint(
      id(998),
      installationId,
      journal.legacyJournalDigest,
      other,
      sha256,
    ),
    expected,
  );
  journal.revision++;
  journal.pending!.acknowledgement = { ownerId, operationId, revision: 3, committedAt: timestamp };
  assert.equal((await parse(await serialize(journal))).pending!.requestFingerprint, expected);
});

test('remote normalization is strict, owns input and never relabels legacy snapshots or deletion state', async () => {
  const journal = await fixture(),
    original = clone(journal.pending!.remote);
  const normalized = normalizeAccountContentRemoteState(original, ownerId);
  original.snapshot!.personal.notes[0]!.text = 'mutated';
  assert.notEqual(
    normalized.snapshot!.personal.notes[0]!.text,
    original.snapshot!.personal.notes[0]!.text,
  );
  assert.ok(Object.isFrozen(normalized.snapshot));
  const empty = {
    ownerId,
    revision: 0,
    snapshot: null,
    updatedAt: null,
    deletionOperationId: null,
  };
  assert.deepEqual(normalizeAccountContentRemoteState(empty, ownerId), empty);
  assert.equal(
    normalizeAccountContentRemoteState({ ...empty, deletionOperationId: id(99) }, ownerId)
      .deletionOperationId,
    id(99),
  );
  for (const patch of [
    { ownerId: id(99) },
    { revision: -1 },
    { revision: 1 },
    { snapshot: snapshot() },
    { updatedAt: timestamp },
    { deletionOperationId: 'invalid' },
    { accessToken: 'hidden' },
  ])
    assert.throws(
      () => normalizeAccountContentRemoteState({ ...empty, ...patch }, ownerId),
      failure('invalid_input'),
    );
  for (const snapshotValue of [snapshot(), expandedSnapshot()])
    assert.throws(
      () =>
        normalizeAccountContentRemoteState(
          { ...journal.pending!.remote, snapshot: snapshotValue },
          ownerId,
        ),
      failure('invalid_input'),
    );
});

test('catalogue, approval and history participation must agree without uploading opted-out local history', async () => {
  const off = await fixture(false);
  const result = await parse(await serialize(off));
  assert.equal(Object.hasOwn(result.pending!.capturedLocal.snapshot, 'cookingHistory'), false);
  assert.deepEqual(
    result.pending!.proposed.cookingHistory,
    result.pending!.remote.snapshot!.cookingHistory,
  );
  for (const change of [
    (value: AccountContentReplicationJournal) => {
      value.pending!.capturedLocal.snapshot.cookingHistory = { entries: [], removedEventIds: [] };
    },
    (value: AccountContentReplicationJournal) => {
      delete value.pending!.proposed.cookingHistory;
    },
    (value: AccountContentReplicationJournal) => {
      value.pending!.proposed.cookingHistory!.removedEventIds = [];
    },
    (value: AccountContentReplicationJournal) => {
      value.scope.approvalDigest = '0'.repeat(64);
    },
    (value: AccountContentReplicationJournal) => {
      value.pending!.proposed.catalogue = { ...catalogue, version: 'different' };
    },
    (value: AccountContentReplicationJournal) => {
      value.base!.snapshot!.catalogue = { ...catalogue, version: 'different' };
    },
  ]) {
    const value = clone(off);
    change(value);
    await assert.rejects(serialize(value), failure('invalid_input'));
  }
  const empty = clone(off);
  delete empty.pending!.remote.snapshot!.cookingHistory;
  delete empty.pending!.proposed.cookingHistory;
  await seal(empty);
  await serialize(empty);
  empty.pending!.proposed.cookingHistory = { entries: [], removedEventIds: [] };
  await assert.rejects(
    serialize(empty),
    failure('invalid_input'),
    'omission is different from included-empty history',
  );
  const on = await fixture();
  delete on.pending!.capturedLocal.snapshot.cookingHistory;
  await assert.rejects(serialize(on), failure('invalid_input'));
  const missingProposed = await fixture();
  delete missingProposed.pending!.proposed.cookingHistory;
  await assert.rejects(serialize(missingProposed), failure('invalid_input'));
});

test('observation fences cannot regress, disagree at the same revision or conceal changed snapshot bytes', async () => {
  const original = await fixture();
  for (const change of [
    (value: AccountContentReplicationJournal) => {
      value.observed.revision = 0;
      value.observed.snapshotDigest = null;
      value.observed.updatedAt = null;
    },
    (value: AccountContentReplicationJournal) => {
      value.observed.snapshotDigest = '1'.repeat(64);
    },
    (value: AccountContentReplicationJournal) => {
      value.observed.updatedAt = '2026-10-01T12:00:00.000Z';
    },
    (value: AccountContentReplicationJournal) => {
      value.pending!.remote.revision = 0;
      value.pending!.remote.snapshot = null;
      value.pending!.remote.updatedAt = null;
    },
    (value: AccountContentReplicationJournal) => {
      value.pending!.remote.snapshot!.personal.notes[0]!.text = 'tampered remote';
    },
    (value: AccountContentReplicationJournal) => {
      value.pending!.proposedDigest = '2'.repeat(64);
    },
    (value: AccountContentReplicationJournal) => {
      value.pending!.requestFingerprint = '3'.repeat(64);
    },
  ]) {
    const value = clone(original);
    change(value);
    await assert.rejects(serialize(value), failure('invalid_input'));
  }
  const same = clone(original);
  same.base!.revision = 2;
  same.lastApply!.serverRevision = 2;
  await serialize(same);
  same.base!.snapshot!.personal.notes[0]!.text = 'different base at same revision';
  await assert.rejects(serialize(same), failure('invalid_input'));
  const settled = clone(original);
  settled.pending = null;
  settled.observed = {
    revision: 1,
    updatedAt: timestamp,
    snapshotDigest: await sha256(canonicalAccountContentSnapshot(settled.base!.snapshot)),
  };
  await serialize(settled);
  settled.observed.snapshotDigest = '0'.repeat(64);
  await assert.rejects(serialize(settled), failure('invalid_input'));
});

test('base and last-apply proof remain paired, owner-bound and distinct from a pending operation', async () => {
  const original = await fixture();
  const changes: ((value: AccountContentReplicationJournal) => void)[] = [
    (value) => {
      value.base = null;
    },
    (value) => {
      value.lastApply = null;
    },
    (value) => {
      value.lastApply!.ownerId = id(99);
    },
    (value) => {
      value.lastApply!.serverRevision = 2;
    },
    (value) => {
      value.lastApply!.storeRevision = 0;
    },
    (value) => {
      value.lastApply!.requestFingerprint = 'not-a-hash';
    },
    (value) => {
      value.lastApply!.operationId = operationId;
    },
    (value) => {
      value.pending!.capturedLocal.storeRevision = 2;
    },
    (value) => {
      value.base!.deletionOperationId = id(99);
    },
    (value) => {
      value.base!.revision = 3;
      value.lastApply!.serverRevision = 3;
    },
  ];
  for (const change of changes) {
    const value = clone(original);
    change(value);
    await assert.rejects(serialize(value), failure('invalid_input'));
  }
  const initial = clone(original);
  initial.base = null;
  initial.lastApply = null;
  initial.pending = null;
  initial.observed = { revision: 0, snapshotDigest: null, updatedAt: null };
  assert.deepEqual(await parse(await serialize(initial)), initial);
});

test('push acknowledgement binds exact owner, operation and next revision; pulls cannot manufacture it', async () => {
  const value = await fixture(),
    ack = { ownerId, operationId, revision: 3, committedAt: timestamp };
  value.pending!.acknowledgement = ack;
  assert.deepEqual((await parse(await serialize(value))).pending!.acknowledgement, ack);
  for (const patch of [
    { ownerId: id(99) },
    { operationId: id(99) },
    { revision: 2 },
    { revision: 4 },
    { committedAt: '2026-02-30T00:00:00.000Z' },
    { extra: 'authority' },
  ]) {
    const changed = clone(value);
    changed.pending!.acknowledgement = { ...ack, ...patch };
    await assert.rejects(serialize(changed), failure('invalid_input'));
  }
  const pull = await fixture();
  pull.pending!.mode = 'pull';
  await seal(pull);
  await serialize(pull);
  pull.pending!.acknowledgement = ack;
  await assert.rejects(serialize(pull), failure('invalid_input'));
  pull.pending!.acknowledgement = null;
  pull.pending!.proposed.personal.notes[0]!.text = 'not the exact remote pull';
  await assert.rejects(serialize(pull), failure('invalid_input'));
  const deleted = await fixture();
  deleted.pending!.remote.deletionOperationId = id(99);
  await assert.rejects(serialize(deleted), failure('invalid_input'));
});

test('strict private versions and exact fields reject downgrade and hidden authority without changing legacy bytes', async () => {
  const legacy = snapshot(),
    legacy2 = expandedSnapshot(),
    bytes1 = canonicalAccountSnapshot(legacy),
    bytes2 = canonicalAccountSnapshot(legacy2);
  const value = await fixture();
  for (const schemaVersion of [1, 2, 4]) {
    await assert.rejects(serialize({ ...value, schemaVersion }), failure('invalid_input'));
    await assert.rejects(
      parse(JSON.stringify({ ...value, schemaVersion })),
      failure('stored_data_invalid'),
    );
  }
  for (const entry of [legacy, legacy2]) {
    const changed = clone(value);
    Object.assign(changed.pending!, { proposed: entry });
    await assert.rejects(serialize(changed), failure('invalid_input'));
  }
  for (const key of Object.keys(value)) {
    const missing: Record<string, unknown> = { ...value };
    delete missing[key];
    await assert.rejects(serialize(missing), failure('invalid_input'));
  }
  await assert.rejects(
    serialize({ ...value, accessToken: 'not allowed' }),
    failure('invalid_input'),
  );
  const extra = clone(value);
  Object.assign(extra.pending!.capturedLocal, { authGeneration: 1 });
  await assert.rejects(
    serialize(extra),
    failure('invalid_input'),
    'mobile fence schema must stay behind its digest',
  );
  const scope2 = clone(value);
  Object.assign(scope2.scope, { version: 2 });
  await assert.rejects(serialize(scope2), failure('invalid_input'));
  await assert.rejects(parse('not JSON'), failure('stored_data_invalid'));
  await assert.rejects(
    parseAccountContentJournal(await serialize(value), id(99), installationId, sha256),
    failure('stored_data_invalid'),
  );
  await assert.rejects(
    parseAccountContentJournal(await serialize(value), ownerId, id(99), sha256),
    failure('stored_data_invalid'),
  );
  assert.throws(() => parseAccountSnapshot(JSON.stringify(content())));
  assert.equal(canonicalAccountSnapshot(legacy), bytes1);
  assert.equal(canonicalAccountSnapshot(legacy2), bytes2);
});

test('descriptor-safe ownership rejects getters, hidden properties, toJSON, cycles and sparse data before hashing', async () => {
  const value = await fixture();
  let hashes = 0;
  const checkedHash = async (text: string) => {
    hashes++;
    return sha256(text);
  };
  const getter = clone(value);
  Object.defineProperty(getter, 'scope', {
    enumerable: true,
    get: () => assert.fail('getter executed'),
  });
  await assert.rejects(serialize(getter, checkedHash), failure('invalid_input'));
  const hidden = clone(value);
  Object.defineProperty(hidden.pending!, 'token', { value: 'secret', enumerable: false });
  await assert.rejects(serialize(hidden, checkedHash), failure('invalid_input'));
  const toJSON = clone(value);
  Object.assign(toJSON.pending!.proposed, { toJSON: () => assert.fail('toJSON executed') });
  await assert.rejects(serialize(toJSON, checkedHash), failure('invalid_input'));
  const nested = clone(value);
  Object.defineProperty(
    nested.pending!.capturedLocal.snapshot.planReferences[0]!.contentRef,
    'revisionId',
    { enumerable: true, get: () => assert.fail('nested getter executed') },
  );
  await assert.rejects(serialize(nested, checkedHash), failure('invalid_input'));
  const cyclic = clone(value);
  Object.assign(cyclic.pending!, { cycle: cyclic });
  await assert.rejects(serialize(cyclic, checkedHash), failure('invalid_input'));
  const sparse = clone(value);
  delete sparse.pending!.proposed.plan[0];
  await assert.rejects(serialize(sparse, checkedHash), failure('invalid_input'));
  assert.equal(hashes, 0);
});

test('serialization and request fingerprint own all inputs before awaited hashing and hash failures give no partial result', async () => {
  const value = await fixture(),
    expected = await serialize(value);
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  let firstHash = true;
  const result = serialize(value, async (text) => {
    if (firstHash) {
      firstHash = false;
      entered();
      await paused;
    }
    return sha256(text);
  });
  await started;
  value.ownerId = id(999);
  value.scope.historyIncluded = false;
  value.pending!.proposed.personal.notes[0]!.text = 'changed during hash';
  value.pending!.capturedLocal.fenceDigest = '0'.repeat(64);
  release();
  assert.equal(await result, expected);
  const journal = await fixture(),
    draft = requestDraft(journal),
    expectedFingerprint = journal.pending!.requestFingerprint;
  let resume!: () => void;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const pending = accountContentPendingFingerprint(
    ownerId,
    installationId,
    journal.legacyJournalDigest,
    draft,
    async (text) => {
      await wait;
      return sha256(text);
    },
  );
  draft.capturedLocal.fenceDigest = '0'.repeat(64);
  draft.proposed.personal.notes[0]!.text = 'late';
  resume();
  assert.equal(await pending, expectedFingerprint);
  const error = new Error('hash unavailable');
  await assert.rejects(
    serialize(await fixture(), async () => {
      throw error;
    }),
    (actual: unknown) => actual === error,
  );
  await assert.rejects(
    serialize(await fixture(), async () => 'not-a-digest'),
    failure('invalid_input'),
  );
});

test('journal and per-snapshot byte bounds reject before hashes, including UTF8 and hostile large input', async () => {
  let calls = 0;
  const noHash = async () => {
    calls++;
    return 'a'.repeat(64);
  };
  await assert.rejects(
    parse(' '.repeat(ACCOUNT_CONTENT_JOURNAL_MAX_BYTES + 1), noHash),
    failure('too_large'),
  );
  await assert.rejects(
    parse('🍲'.repeat(ACCOUNT_CONTENT_JOURNAL_MAX_BYTES / 4 + 1), noHash),
    failure('too_large'),
  );
  const value = await fixture();
  value.pending!.proposed.personal.notes[0]!.text = 'x'.repeat(ACCOUNT_CONTENT_JOURNAL_MAX_BYTES);
  await assert.rejects(serialize(value, noHash), failure('too_large'));
  const individual = await fixture();
  individual.pending!.proposed.personal.notes[0]!.text = 'x'.repeat(ACCOUNT_SNAPSHOT_MAX_BYTES);
  await assert.rejects(serialize(individual, noHash), failure('too_large'));
  assert.equal(calls, 0);
});

test('four independently capped snapshots may use the explicit64KiB journal allowance above the portable encoder cap', async () => {
  const large = content(),
    record = {
      kind: 'legacy' as const,
      entry: { ...history(10), note: 'x'.repeat(500) },
      pin: { kind: 'unresolved' as const, reason: 'content_mismatch' as const },
    };
  large.cookingHistory = { entries: [], removedEventIds: [] };
  const emptyBytes = portableBackupByteLength(canonicalAccountContentSnapshot(large)),
    recordBytes = portableBackupByteLength(canonicalPortableContentJson(record));
  const target = ACCOUNT_SNAPSHOT_MAX_BYTES - 64,
    count = Math.floor((target - emptyBytes + 1) / (recordBytes + 1));
  large.cookingHistory.entries = Array.from({ length: count }, (_, index) => ({
    ...clone(record),
    entry: { ...record.entry, eventId: id(10000 + index) },
  }));
  let remaining = target - portableBackupByteLength(canonicalAccountContentSnapshot(large));
  for (const value of large.cookingHistory.entries) {
    const addition = Math.min(remaining, 1500);
    value.entry.note = (value.entry.note ?? '') + 'x'.repeat(addition);
    remaining -= addition;
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  assert.equal(portableBackupByteLength(canonicalAccountContentSnapshot(large)), target);
  const value = await fixture();
  value.base!.snapshot = large;
  value.pending!.capturedLocal.snapshot = large;
  value.pending!.remote.snapshot = large;
  value.pending!.proposed = large;
  await seal(value);
  const serialized = await serialize(value);
  assert.ok(portableBackupByteLength(serialized) > PORTABLE_BACKUP_MAX_BYTES);
  assert.ok(portableBackupByteLength(serialized) <= ACCOUNT_CONTENT_JOURNAL_MAX_BYTES);
  assert.equal((await parse(serialized)).pending!.proposed.cookingHistory!.entries.length, count);
});
