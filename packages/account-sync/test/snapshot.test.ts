import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPortableBackup } from '@cookmate/domain';
import type { PortableBackupEnvelope, PortableBackupInput } from '@cookmate/domain';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  AccountSnapshotError,
  accountSnapshotFromBackup,
  accountSnapshotsEqual,
  canonicalAccountSnapshot,
  parseAccountSnapshot,
  validateAccountSnapshot,
} from '../src/index';
import {
  catalogue,
  clone,
  id,
  occurrence,
  options,
  preference,
  purchase,
  snapshot,
  timestamp,
} from './fixtures';

test('bounded wire snapshot round-trips; array/object order has no content significance', () => {
  const first = snapshot();
  first.plan = [occurrence(2, '52835', '2026-10-01'), occurrence(1)];
  first.shopping.selectedOccurrenceIds = [id(2), id(1)];
  first.favourites = [
    { recipeId: '52835', savedAt: timestamp },
    { recipeId: '52819', savedAt: timestamp },
  ];
  const reordered = clone(first);
  reordered.plan.reverse();
  reordered.favourites.reverse();
  reordered.shopping.selectedOccurrenceIds.reverse();
  const text = canonicalAccountSnapshot(first);
  assert.equal(text, canonicalAccountSnapshot(reordered));
  assert.ok(accountSnapshotsEqual(first, parseAccountSnapshot(text)));
  assert.equal(first.plan[0]!.occurrenceId, id(2), 'normalization does not mutate callers');
});

test('unknown versions and invalid JSON are reported without accepting a candidate', () => {
  assert.throws(
    () => parseAccountSnapshot('{'),
    (error) => error instanceof AccountSnapshotError && error.reason === 'invalid_json',
  );
  assert.throws(
    () => parseAccountSnapshot(JSON.stringify({ ...snapshot(), schemaVersion: 3 })),
    (error) => error instanceof AccountSnapshotError && error.reason === 'unsupported_version',
  );
  assert.equal(validateAccountSnapshot({ ...snapshot(), format: 'other-app' }), false);
});

test('allowlist rejects credentials, conversation or revision fields at every scope', () => {
  for (const key of [
    'apiKey',
    'messages',
    'credentials',
    'accessToken',
    'sourceRevision',
    'createdAt',
    'personal',
    'cookingHistory',
  ])
    assert.equal(validateAccountSnapshot({ ...snapshot(), [key]: 'must-not-sync' }), false, key);
  const value = snapshot();
  value.plan = [occurrence(1)];
  (value.plan[0] as unknown as Record<string, unknown>).revision = 5;
  assert.equal(validateAccountSnapshot(value), false);
  assert.equal(
    validateAccountSnapshot({ ...snapshot(), profile: { displayName: null, admin: true } }),
    false,
  );
});

test('identity, date, duplicates and intrinsic cross-references are enforced', () => {
  const value = snapshot();
  value.plan = [occurrence(1)];
  value.shopping.selectedOccurrenceIds = [id(2)];
  assert.equal(validateAccountSnapshot(value), false);
  value.shopping.selectedOccurrenceIds = [id(1), id(1)];
  assert.equal(validateAccountSnapshot(value), false);
  value.shopping.selectedOccurrenceIds = [id(1)];
  assert.ok(validateAccountSnapshot(value));
  value.plan.push(occurrence(2));
  assert.equal(validateAccountSnapshot(value), false, 'unique meal slot');
  value.plan = [occurrence(1, '52819', '2026-02-30')];
  assert.equal(validateAccountSnapshot(value), false);
  value.plan = [occurrence(1, 'not-a-recipe')];
  assert.equal(validateAccountSnapshot(value), false);
  value.plan = [occurrence(1)];
  value.plan[0]!.occurrenceId = 'not-a-uuid';
  assert.equal(validateAccountSnapshot(value), false);
});

test('known field lengths, scalar enums, valid instants and semantic preferences are enforced', () => {
  const value = snapshot();
  value.preferences = [preference(1), preference(2)];
  assert.equal(validateAccountSnapshot(value), false);
  value.preferences = [preference(1, 'x'.repeat(257))];
  assert.equal(validateAccountSnapshot(value), false);
  value.preferences = [];
  value.profile.displayName = 'x'.repeat(121);
  assert.equal(validateAccountSnapshot(value), false);
  value.profile.displayName = null;
  value.favourites = [{ recipeId: '52819', savedAt: '2026-09-30' }];
  assert.equal(validateAccountSnapshot(value), false);
  assert.equal(
    validateAccountSnapshot({
      ...snapshot(),
      appPreferences: { theme: 'night', motion: 'system', locale: 'en' },
    }),
    false,
  );
});

test('shopping selected meals stop at 1000 and purchase group identities remain unique', () => {
  const value = snapshot();
  value.plan = Array.from({ length: 1001 }, (_, index) =>
    occurrence(
      index + 1,
      '52819',
      new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
    ),
  );
  value.shopping.selectedOccurrenceIds = value.plan.slice(0, 1000).map((item) => item.occurrenceId);
  assert.ok(validateAccountSnapshot(value));
  value.shopping.selectedOccurrenceIds.push(id(1001));
  assert.equal(validateAccountSnapshot(value), false);
  value.shopping.selectedOccurrenceIds = [];
  value.shopping.purchaseMarks = [purchase(), purchase(true)];
  assert.equal(validateAccountSnapshot(value), false);
});

test('sparse arrays, accessor fields, symbols and prototypes cannot bypass validation', () => {
  const sparse = snapshot();
  sparse.favourites = new Array(1);
  assert.equal(validateAccountSnapshot(sparse), false);
  Object.defineProperty(sparse.favourites, 'other', { value: 'x', enumerable: true });
  assert.equal(validateAccountSnapshot(sparse), false);
  const value = snapshot();
  let reads = 0;
  Object.defineProperty(value.profile, 'displayName', {
    enumerable: true,
    get() {
      reads++;
      return 'secret';
    },
  });
  assert.equal(validateAccountSnapshot(value), false);
  assert.equal(reads, 0);
  Object.defineProperty(value, 'format', {
    enumerable: true,
    get() {
      reads++;
      return 'cookmate-account-snapshot';
    },
  });
  assert.equal(validateAccountSnapshot(value), false);
  assert.equal(reads, 0);
  const symbolic = snapshot();
  Object.defineProperty(symbolic, Symbol('token'), { value: 'secret' });
  assert.equal(validateAccountSnapshot(symbolic), false);
  const inherited = Object.create(snapshot());
  assert.equal(validateAccountSnapshot(inherited), false);
});

test('UTF-8 byte cap applies before parsing and also after structural validation, without truncation', () => {
  assert.throws(
    () => parseAccountSnapshot(' '.repeat(ACCOUNT_SNAPSHOT_MAX_BYTES + 1)),
    (error) => error instanceof AccountSnapshotError && error.reason === 'too_large',
  );
  const value = snapshot();
  value.shopping.purchaseMarks = Array.from({ length: 6000 }, (_, index) => ({
    ...purchase(),
    groupKey: index.toString(16).padStart(64, '0'),
    groupingVersion: '厨'.repeat(80),
  }));
  const serialized = JSON.stringify(value);
  assert.ok(serialized.length < ACCOUNT_SNAPSHOT_MAX_BYTES);
  assert.ok(Buffer.byteLength(serialized) > ACCOUNT_SNAPSHOT_MAX_BYTES);
  assert.equal(validateAccountSnapshot(value), false);
  assert.throws(
    () => canonicalAccountSnapshot(value),
    (error) => error instanceof AccountSnapshotError && error.reason === 'too_large',
  );
  assert.throws(
    () => parseAccountSnapshot(serialized),
    (error) => error instanceof AccountSnapshotError && error.reason === 'too_large',
  );
});

function backupInput(): PortableBackupInput {
  return {
    createdAt: timestamp,
    catalogue,
    sourceRevision: 5,
    data: {
      favourites: [
        { recipeId: '52819', saved: true, revision: 3, savedAt: timestamp, updatedAt: timestamp },
        { recipeId: '52835', saved: false, revision: 4, savedAt: timestamp, updatedAt: timestamp },
      ],
      occurrences: [{ ...occurrence(1), revision: 3 }],
      shopping: {
        scope: { scopeId: id(9), revision: 1, occurrenceIds: [id(1)] },
        projectionRevision: 3,
        projectionStatus: 'current',
        purchaseMarks: [{ ...purchase(true), revision: 3, projectionRevision: 3 }],
      },
      preferences: {
        snapshot: {
          revision: 2,
          lastRemovalRevision: null,
          items: [{ ...preference(2), revision: 2 }],
        },
        removals: [],
      },
    },
  };
}

test('backup adapter projects only sync scope and ignores local clocks, private data and tombstones', async () => {
  const original = backupInput();
  const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
  const envelope = await createPortableBackup(original, sha256);
  const value = accountSnapshotFromBackup(envelope, options);
  assert.equal(value.favourites.length, 1);
  assert.equal(value.plan[0]!.occurrenceId, id(1));
  assert.equal(value.shopping.purchaseMarks[0]!.purchased, true);
  assert.equal(JSON.stringify(value).includes('revision'), false);
  const changedClock = structuredClone(envelope) as PortableBackupEnvelope;
  changedClock.sourceRevision = 500;
  changedClock.createdAt = '2026-10-01T00:00:00.000Z';
  changedClock.data.occurrences[0]!.revision = 90;
  const extended = { ...changedClock, apiKey: 'secret', conversations: [{ content: 'private' }] };
  assert.equal(
    canonicalAccountSnapshot(value),
    canonicalAccountSnapshot(accountSnapshotFromBackup(extended, options)),
  );
  assert.equal(JSON.stringify(value).includes('secret'), false);
});

test('backup adapter never exports pending or stale projection marks as purchased', async () => {
  const original = backupInput();
  original.data.shopping.projectionStatus = 'pending';
  const envelope = await createPortableBackup(original, async (text) =>
    createHash('sha256').update(text).digest('hex'),
  );
  const value = accountSnapshotFromBackup(envelope, options);
  assert.equal(value.shopping.purchaseMarks[0]!.purchased, false);
  assert.equal(value.shopping.purchaseMarks[0]!.changed, true);
});

test('dormant purchase history stays local and cannot make identical accounts diverge', async () => {
  const original = backupInput();
  const envelope = await createPortableBackup(original, async (text) =>
    createHash('sha256').update(text).digest('hex'),
  );
  const withDormant = structuredClone(envelope) as PortableBackupEnvelope;
  withDormant.data.shopping.purchaseMarks.push({
    ...withDormant.data.shopping.purchaseMarks[0]!,
    groupKey: 'd'.repeat(64),
    projectionRevision: withDormant.data.shopping.projectionRevision - 1,
    purchased: false,
    changed: true,
  });
  assert.equal(
    canonicalAccountSnapshot(accountSnapshotFromBackup(withDormant, options)),
    canonicalAccountSnapshot(accountSnapshotFromBackup(envelope, options)),
  );
  assert.equal(
    withDormant.data.shopping.purchaseMarks.length,
    envelope.data.shopping.purchaseMarks.length + 1,
  );
});
