import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  AccountSnapshotError,
  type AccountSnapshot,
  type AccountSnapshotOptions,
} from '../src/types';
import {
  canonicalAccountSnapshot,
  parseAccountSnapshot,
  validateAccountSnapshot,
} from '../src/validation';
import { mergeAccountSnapshots } from '../src/merge';
import { parseAccountRemoteState } from '../src/remote';
import {
  accountContentSnapshotFromBackup,
  canonicalAccountContentSnapshot,
  normalizeAccountContentSnapshot,
  normalizeAccountContentCookingHistory,
  parseAccountContentSnapshot,
  validateAccountContentSnapshot,
  type AccountContentSnapshot,
  type AccountContentAdapterOptions,
} from '../src/contentSnapshot';
import {
  createPortableContentBackup,
  type PortableContentBackupInput,
  type PortableContentBackupEnvelope,
} from '../../domain/src/portableBackupContent';
import { catalogue, id, options, occurrence, purchase, snapshot, timestamp } from './fixtures';
import {
  expandedSnapshot,
  note,
  collection,
  membership,
  manual,
  history,
} from './expandedFixtures';

const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const first = {
  recipeId: '52819',
  revisionId: 'fixture-first',
  contentFingerprint: 'b'.repeat(64),
};
const second = { ...first, revisionId: 'fixture-second', contentFingerprint: 'c'.repeat(64) };
function fixture(): AccountContentSnapshot {
  return {
    ...expandedSnapshot(),
    schemaVersion: 3,
    plan: [occurrence(1), occurrence(2, '52819', '2026-10-01')],
    planReferences: [
      { occurrenceId: id(1), contentRef: { ...first } },
      { occurrenceId: id(2), contentRef: { ...second } },
    ],
    personal: {
      notes: [note(10, '52819', ' Raw note \n🍲\0 ')],
      collections: [collection(20)],
      memberships: [membership(20)],
      manualItems: [{ ...manual(30), amountText: ' 1 ½ ', unitText: 'tsp. ' }],
    },
    cookingHistory: {
      entries: [
        {
          kind: 'legacy',
          entry: { ...history(41), origin: 'backup' },
          pin: { kind: 'exact', ref: { ...first } },
        },
        {
          kind: 'legacy',
          entry: history(42),
          pin: { kind: 'unresolved', reason: 'content_mismatch' },
        },
        {
          kind: 'exact',
          entry: {
            readerVersion: 2,
            recipeId: first.recipeId,
            contentRef: { ...second },
            eventId: id(43),
            recipeTitle: 'Archived exact title',
            photoAssetId: `sha256:${'d'.repeat(64)}`,
            cookedOn: '2026-10-01',
            timeZone: 'Asia/Dubai',
            recordedAt: timestamp,
            note: ' Exact\n🍲\0 ',
          },
        },
      ],
      removedEventIds: [id(45), id(44)],
    },
  };
}
function rejects(value: unknown, reason = 'invalid_structure') {
  assert.throws(
    () => normalizeAccountContentSnapshot(value),
    (error: unknown) => error instanceof AccountSnapshotError && error.reason === reason,
  );
}

test('private history normalization owns exact mixed records and removals without accepting receipt authority', () => {
  const input = fixture().cookingHistory!;
  const result = normalizeAccountContentCookingHistory(input);
  assert.deepEqual(
    result.entries.map((row) => row.entry.eventId),
    [...input.entries.map((row) => row.entry.eventId)].sort(),
  );
  assert.deepEqual(result.removedEventIds, [...input.removedEventIds].sort());
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.entries) &&
      Object.isFrozen(result.entries[0]!.entry),
  );
  const retainedTitle = result.entries[0]!.entry.recipeTitle;
  input.entries[0]!.entry.recipeTitle = 'Caller changed this later';
  assert.equal(result.entries[0]!.entry.recipeTitle, retainedTitle);
  for (const invalid of [
    { ...input, receipt: {} },
    { ...input, entries: [input.entries[0], input.entries[0]] },
    { ...input, removedEventIds: [input.entries[0]!.entry.eventId] },
    {
      ...input,
      entries: [{ ...input.entries[2], entry: { ...input.entries[2]!.entry, historyEpoch: 9 } }],
    },
  ])
    assert.throws(() => normalizeAccountContentCookingHistory(invalid), AccountSnapshotError);
  let invoked = false;
  assert.throws(
    () =>
      normalizeAccountContentCookingHistory({
        get entries() {
          invoked = true;
          return [];
        },
        removedEventIds: [],
      }),
    AccountSnapshotError,
  );
  assert.equal(invoked, false);
  assert.throws(
    () =>
      normalizeAccountContentCookingHistory({
        entries: [],
        removedEventIds: [],
        padding: 'x'.repeat(ACCOUNT_SNAPSHOT_MAX_BYTES),
      }),
    (error: unknown) => error instanceof AccountSnapshotError && error.reason === 'too_large',
  );
});
async function portable() {
  const value = fixture();
  const input: PortableContentBackupInput = {
    schemaVersion: 3,
    databaseSchemaVersion: 7,
    createdAt: timestamp,
    catalogue,
    sourceRevision: 9,
    data: {
      favourites: [
        {
          recipeId: first.recipeId,
          saved: true,
          savedAt: timestamp,
          updatedAt: timestamp,
          revision: 1,
        },
      ],
      occurrences: value.plan.map((row) => ({ ...row, revision: 2 })),
      planReferences: value.planReferences,
      shopping: {
        scope: { scopeId: id(50), revision: 1, occurrenceIds: [id(1), id(2)] },
        projectionStatus: 'current',
        projectionRevision: 1,
        purchaseMarks: [
          { ...purchase(true), revision: 3, projectionRevision: 1 },
          {
            ...purchase(false),
            groupKey: 'e'.repeat(64),
            changed: true,
            revision: 1,
            projectionRevision: 0,
          },
        ],
      },
      preferences: {
        snapshot: { revision: 0, lastRemovalRevision: null, items: [] },
        removals: [],
      },
      personal: {
        notes: value.personal.notes.map((row) => ({ ...row, revision: 4 })),
        collections: value.personal.collections.map((row) => ({ ...row, revision: 4 })),
        memberships: value.personal.memberships.map((row) => ({ ...row, revision: 4 })),
        manualItems: value.personal.manualItems.map((row) => ({ ...row, revision: 4 })),
      },
      cookingHistory: {
        entries: value.cookingHistory!.entries.map((row) =>
          row.kind === 'legacy'
            ? { ...row, entry: { ...row.entry, revision: 7, historyEpoch: 2 } }
            : { ...row, entry: { ...row.entry, revision: 8, historyEpoch: 2 } },
        ),
      },
    },
  };
  return { input, backup: await createPortableContentBackup(input, sha256) };
}

test('private format3 preserves two exact versions of one recipe, legacy evidence and raw personal values', () => {
  const source = fixture(),
    before = clone(source),
    value = normalizeAccountContentSnapshot(source);
  assert.deepEqual(value.planReferences, source.planReferences);
  assert.deepEqual(value.cookingHistory!.entries, source.cookingHistory!.entries);
  assert.equal(value.personal.manualItems[0]!.amountText, ' 1 ½ ');
  assert.equal(value.personal.manualItems[0]!.unitText, 'tsp. ');
  assert.deepEqual(source, before);
  assert.ok(Object.isFrozen(value.planReferences[0]!.contentRef));
  assert.ok(Object.isFrozen(value.cookingHistory!.entries[0]!.entry));
  assert.deepEqual(parseAccountContentSnapshot(canonicalAccountContentSnapshot(source)), value);
});
test('canonical ordering covers references, history and inherited core/personal arrays without treating order as revisions', () => {
  const firstValue = fixture(),
    reordered = clone(firstValue);
  reordered.plan.reverse();
  reordered.planReferences.reverse();
  reordered.cookingHistory!.entries.reverse();
  reordered.cookingHistory!.removedEventIds.reverse();
  assert.equal(
    canonicalAccountContentSnapshot(firstValue),
    canonicalAccountContentSnapshot(reordered),
  );
  assert.equal(reordered.planReferences[0]!.contentRef.revisionId, second.revisionId);
});
test('exact plan mappings must be complete, unique and match their occurrence recipe identity', () => {
  for (const mutate of [
    (v: AccountContentSnapshot) => v.planReferences.pop(),
    (v: AccountContentSnapshot) => v.planReferences.push({ ...v.planReferences[0]! }),
    (v: AccountContentSnapshot) => {
      v.planReferences[0]!.occurrenceId = id(999);
    },
    (v: AccountContentSnapshot) => {
      v.planReferences[0]!.contentRef.recipeId = '52835';
    },
    (v: AccountContentSnapshot) => {
      v.planReferences[0]!.contentRef.contentFingerprint = 'not-a-fingerprint';
    },
    (v: AccountContentSnapshot) =>
      Object.assign(v.planReferences[0]!.contentRef, { trusted: true }),
  ]) {
    const value = fixture();
    mutate(value);
    rejects(value);
  }
});
test('existing core and personal relationship/tombstone validators remain authoritative', () => {
  for (const mutate of [
    (v: AccountContentSnapshot) => {
      v.shopping.selectedOccurrenceIds = [id(999)];
    },
    (v: AccountContentSnapshot) => {
      v.plan[1]!.placement = { ...v.plan[0]!.placement };
    },
    (v: AccountContentSnapshot) => {
      v.personal.collections[0]!.deleted = true;
      v.personal.collections[0]!.name = null;
    },
    (v: AccountContentSnapshot) => {
      v.personal.notes[0]!.deleted = true;
    },
    (v: AccountContentSnapshot) => {
      v.personal.manualItems[0]!.deleted = true;
    },
  ]) {
    const value = fixture();
    mutate(value);
    rejects(value);
  }
});
test('strict history union rejects mixed bodies, clocks, invalid dates/zones/photos and mismatched refs', () => {
  for (const extra of [
    'revision',
    'historyEpoch',
    'receipt',
    'closedSession',
    'sessionId',
    'credentials',
    'body',
  ]) {
    for (const index of [0, 2]) {
      const value = fixture();
      Object.assign(value.cookingHistory!.entries[index]!.entry, { [extra]: 1 });
      rejects(value);
    }
  }
  for (const fields of [
    { cookedOn: '2026-02-30' },
    { timeZone: 'Not/A_Zone' },
    { photoAssetId: 'https://example.test/image.jpg' },
    { contentRef: { ...first, recipeId: '52835' } },
    { readerVersion: 1 },
    { photoKey: 'fake-workbook-photo' },
  ]) {
    const value = fixture();
    Object.assign(value.cookingHistory!.entries[2]!.entry, fields);
    rejects(value);
  }
  const wrongPin = fixture();
  Object.assign(wrongPin.cookingHistory!.entries[0]!, {
    pin: { kind: 'exact', ref: { ...first, recipeId: '52835' } },
  });
  rejects(wrongPin);
  const zeroPhoto = fixture();
  const exact = zeroPhoto.cookingHistory!.entries[2]!;
  assert.equal(exact.kind, 'exact');
  if (exact.kind === 'exact') exact.entry.photoAssetId = null;
  assert.ok(validateAccountContentSnapshot(zeroPhoto));
});
test('history event IDs and removal facts are disjoint and unique across legacy/exact records', () => {
  const duplicate = fixture();
  duplicate.cookingHistory!.entries[2]!.entry.eventId =
    duplicate.cookingHistory!.entries[0]!.entry.eventId;
  rejects(duplicate);
  const removed = fixture();
  removed.cookingHistory!.removedEventIds.push(removed.cookingHistory!.entries[0]!.entry.eventId);
  rejects(removed);
  const repeated = fixture();
  repeated.cookingHistory!.removedEventIds.push(id(44));
  rejects(repeated);
  const malformed = fixture();
  malformed.cookingHistory!.removedEventIds = ['not-an-id'];
  rejects(malformed);
});
test('unsafe descriptors, sparse arrays, cycles, extended prototypes and hidden keys are rejected without execution', () => {
  let calls = 0;
  const getter = fixture();
  Object.defineProperty(getter.personal.notes[0], 'text', {
    enumerable: true,
    get() {
      calls++;
      return 'should not run';
    },
  });
  rejects(getter);
  assert.equal(calls, 0);
  const toJson = fixture();
  Object.assign(toJson, {
    toJSON() {
      calls++;
      return fixture();
    },
  });
  rejects(toJson);
  assert.equal(calls, 0);
  const sparse = fixture();
  sparse.planReferences = new Array(2);
  rejects(sparse);
  const hidden = fixture();
  Object.defineProperty(hidden, 'secret', { value: 'hidden' });
  rejects(hidden);
  const symbol = fixture();
  Object.defineProperty(symbol, Symbol('secret'), { value: 1 });
  rejects(symbol);
  const cycle = fixture();
  Object.assign(cycle, { self: cycle });
  rejects(cycle);
  const prototype = fixture();
  Object.setPrototypeOf(prototype, { inherited: true });
  rejects(prototype);
});
test('byte and depth limits run before cloning malformed or oversized values', () => {
  for (const payload of ['🍲'.repeat(600000), '\u0000'.repeat(400000)])
    rejects({ ...fixture(), payload }, 'too_large');
  let deep: unknown = null;
  for (let index = 0; index < 40; index++) deep = { next: deep };
  rejects({ ...fixture(), deep }, 'too_large');
  assert.throws(
    () => parseAccountContentSnapshot('x'.repeat(ACCOUNT_SNAPSHOT_MAX_BYTES + 1)),
    (error: unknown) => error instanceof AccountSnapshotError && error.reason === 'too_large',
  );
  assert.throws(
    () => parseAccountContentSnapshot('{'),
    (error: unknown) => error instanceof AccountSnapshotError && error.reason === 'invalid_json',
  );
  rejects({ ...fixture(), schemaVersion: 4 }, 'unsupported_version');
});
test('unchanged format1/2 golden bytes and the old parser, merge and remote boundary continue rejecting format3', () => {
  const common = `"appPreferences":{"locale":"system","motion":"system","theme":"system"},"catalogue":{"fingerprint":"${'a'.repeat(64)}","version":"test-catalogue"},"favourites":[],"format":"cookmate-account-snapshot","plan":[],"preferences":[],"profile":{"displayName":null},"schemaVersion":1,"shopping":{"purchaseMarks":[],"selectedOccurrenceIds":[]}`;
  assert.equal(canonicalAccountSnapshot(snapshot()), `{${common}}`);
  const v2 = common
    .replace(
      '"plan":[]',
      '"personal":{"collections":[],"manualItems":[],"memberships":[],"notes":[]},"plan":[]',
    )
    .replace('"schemaVersion":1', '"schemaVersion":2');
  assert.equal(canonicalAccountSnapshot(expandedSnapshot()), `{${v2}}`);
  const value = fixture();
  assert.equal(validateAccountSnapshot(value), false);
  assert.throws(
    () => parseAccountSnapshot(JSON.stringify(value)),
    (error: unknown) =>
      error instanceof AccountSnapshotError && error.reason === 'unsupported_version',
  );
  assert.throws(
    () =>
      mergeAccountSnapshots({
        base: snapshot(),
        local: value as unknown as AccountSnapshot,
        account: snapshot(),
      }),
    (error: unknown) =>
      error instanceof AccountSnapshotError && error.reason === 'unsupported_version',
  );
  assert.throws(() =>
    parseAccountRemoteState(
      {
        ownerId: id(100),
        revision: 1,
        schemaVersion: 1,
        snapshot: value,
        updatedAt: timestamp,
        deletionPending: false,
        deletionOperationId: null,
      },
      id(100),
    ),
  );
});
test('physical8 portable input preserves the same account3 data without changing account wire or pretending source7', async () => {
  const { input, backup } = await portable();
  const eight = await createPortableContentBackup({ ...input, databaseSchemaVersion: 8 }, sha256);
  const choices = { schemaVersion: 3 as const, includeCookingHistory: true };
  const expected = await accountContentSnapshotFromBackup(backup, options, choices, sha256);
  const converted = await accountContentSnapshotFromBackup(eight, options, choices, sha256);
  assert.equal(eight.databaseSchemaVersion, 8);
  assert.equal(backup.databaseSchemaVersion, 7);
  assert.equal(
    canonicalAccountContentSnapshot(converted),
    canonicalAccountContentSnapshot(expected),
  );
});

test('portable3 conversion preserves exact references and personal strings while omitting local clocks and dormant marks', async () => {
  const { backup } = await portable(),
    before = JSON.stringify(backup);
  const value = await accountContentSnapshotFromBackup(
    backup,
    options,
    { schemaVersion: 3, includeCookingHistory: true },
    sha256,
  );
  assert.deepEqual(value.planReferences, backup.data.planReferences);
  assert.equal(value.cookingHistory!.entries.length, 3);
  assert.equal(value.shopping.purchaseMarks.length, 1);
  assert.equal(value.shopping.purchaseMarks[0]!.purchased, true);
  assert.equal(value.personal.notes[0]!.text, fixture().personal.notes[0]!.text);
  assert.equal(value.personal.manualItems[0]!.amountText, ' 1 ½ ');
  const serialized = canonicalAccountContentSnapshot(value);
  for (const key of [
    'historyEpoch',
    '"revision"',
    'sourceRevision',
    'databaseSchemaVersion',
    'integrity',
    'scopeId',
    'receipt',
  ])
    assert.equal(serialized.includes(key), false, key);
  assert.equal(JSON.stringify(backup), before);
});
test('history participation is explicit and known removal IDs suppress entries without reviving or inventing an event', async () => {
  const { backup } = await portable();
  const excluded = await accountContentSnapshotFromBackup(
    backup,
    options,
    { schemaVersion: 3, includeCookingHistory: false },
    sha256,
  );
  assert.equal(Object.hasOwn(excluded, 'cookingHistory'), false);
  const included = await accountContentSnapshotFromBackup(
    backup,
    options,
    { schemaVersion: 3, includeCookingHistory: true, removedHistoryEventIds: [id(43), id(99)] },
    sha256,
  );
  assert.deepEqual(included.cookingHistory!.removedEventIds, [id(43), id(99)]);
  assert.equal(
    included.cookingHistory!.entries.some((row) => row.entry.eventId === id(43)),
    false,
  );
  await assert.rejects(
    accountContentSnapshotFromBackup(
      backup,
      options,
      { schemaVersion: 3, includeCookingHistory: false, removedHistoryEventIds: [] },
      sha256,
    ),
  );
  const { input } = await portable();
  delete input.data.cookingHistory;
  const noHistory = await createPortableContentBackup(input, sha256);
  await assert.rejects(
    accountContentSnapshotFromBackup(
      noHistory,
      options,
      { schemaVersion: 3, includeCookingHistory: true },
      sha256,
    ),
  );
});
test('adapter owns source, settings and removal choices before asynchronous checksum verification', async () => {
  const source = clone((await portable()).backup),
    settings: AccountSnapshotOptions = clone(options),
    choices: AccountContentAdapterOptions = {
      schemaVersion: 3,
      includeCookingHistory: true,
      removedHistoryEventIds: [id(43)],
    };
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const pending = accountContentSnapshotFromBackup(source, settings, choices, async (text) => {
    entered();
    await gate;
    return sha256(text);
  });
  try {
    await reached;
    Object.assign(source, { schemaVersion: 1 });
    settings.profile.displayName = 'Later owner';
    choices.includeCookingHistory = false;
    choices.removedHistoryEventIds = [id(41)];
    release();
    const value = await pending;
    assert.equal(value.profile.displayName, null);
    assert.deepEqual(value.cookingHistory!.removedEventIds, [id(43)]);
    assert.equal(
      value.cookingHistory!.entries.some((row) => row.entry.eventId === id(41)),
      true,
    );
  } finally {
    release();
  }
});
test('adapter rejects checksum changes and invalid settings/options instead of accepting a partially checked file', async () => {
  const { backup } = await portable();
  const corrupted = clone(backup);
  Object.assign(corrupted.integrity, { digest: 'f'.repeat(64) });
  await assert.rejects(
    accountContentSnapshotFromBackup(
      corrupted,
      options,
      { schemaVersion: 3, includeCookingHistory: false },
      sha256,
    ),
  );
  for (const settings of [
    { ...options, profile: { displayName: null, admin: true } },
    { ...options, appPreferences: null },
  ])
    await assert.rejects(
      accountContentSnapshotFromBackup(
        backup,
        settings as unknown as AccountSnapshotOptions,
        { schemaVersion: 3, includeCookingHistory: false },
        sha256,
      ),
    );
  for (const choices of [
    { schemaVersion: 2, includeCookingHistory: false },
    { schemaVersion: 3, includeCookingHistory: 'yes' },
    { schemaVersion: 3, includeCookingHistory: true, removedHistoryEventIds: [id(99), id(99)] },
  ])
    await assert.rejects(
      accountContentSnapshotFromBackup(
        backup,
        options,
        choices as AccountContentAdapterOptions,
        sha256,
      ),
    );
  const invalid = clone(backup);
  Object.assign(invalid.data, { session: { secret: true } });
  await assert.rejects(
    accountContentSnapshotFromBackup(
      invalid as PortableContentBackupEnvelope,
      options,
      { schemaVersion: 3, includeCookingHistory: false },
      sha256,
    ),
  );
});
test('portable files may exceed the account cap, but converted account output still must fit two MiB', async () => {
  const { input } = await portable();
  input.data.personal.notes = Array.from({ length: 550 }, (_, index) => ({
    ...note(1000 + index, String(70000 + index), 'x'.repeat(4000)),
    revision: 1,
  }));
  const source = await createPortableContentBackup(input, sha256);
  assert.ok(Buffer.byteLength(JSON.stringify(source)) > ACCOUNT_SNAPSHOT_MAX_BYTES);
  await assert.rejects(
    accountContentSnapshotFromBackup(
      source,
      options,
      { schemaVersion: 3, includeCookingHistory: false },
      sha256,
    ),
    (error: unknown) => error instanceof AccountSnapshotError && error.reason === 'too_large',
  );
});
