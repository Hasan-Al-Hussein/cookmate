import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import {
  createBundledRecipeRevision,
  createRecipeContentRevision,
} from '@cookmate/catalogue/content';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  AccountReplicationError,
  AccountSnapshotError,
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
  normalizeAccountSnapshot,
  type AccountCookingHistoryEntry,
  type AccountPlanOccurrence,
  type AccountSnapshotV1,
  type AccountSnapshotV2,
} from '@cookmate/account-sync';
import { canonicalAccountContentSnapshot } from '../../account-sync/src/contentSnapshot';
import { authoredFixture, sha256 } from '../../catalogue/test/content-fixtures';
import { cookingContentIdentity } from '../src/cooking';
import { portableBackupByteLength } from '../src/portableBackup';
import { convertBundledLegacyAccountSnapshot } from '../../../apps/mobile/src/data/accountLegacyContentConversion';

const at = '2026-10-01T12:00:00.000Z';
const recipe = catalogue.recipes[0]!;
const secondRecipe = catalogue.recipes[1]!;
const base = (): AccountSnapshotV1 =>
  emptyAccountSnapshot(catalogue.identity, {
    appPreferences: { theme: 'dark', motion: 'reduced', locale: 'ar' },
    profile: { displayName: '  Original profile  ' },
  });
const expanded = (): AccountSnapshotV2 => ({
  ...base(),
  schemaVersion: 2,
  personal: { notes: [], collections: [], memberships: [], manualItems: [] },
});
function planned(index: number, recipeId = recipe.recipeId): AccountPlanOccurrence {
  const date = new Date('2026-10-01T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + Math.floor(index / 3));
  return {
    occurrenceId: randomUUID(),
    recipeId,
    placement: {
      actualDate: date.toISOString().slice(0, 10),
      mealKey: (['breakfast', 'lunch', 'dinner'] as const)[index % 3]!,
    },
    createdAt: at,
    updatedAt: at,
  };
}
async function history(): Promise<AccountCookingHistoryEntry> {
  return {
    ...(await cookingContentIdentity(recipe, catalogue.identity, sha256)),
    eventId: randomUUID(),
    recipeTitle: recipe.title,
    photoKey: recipe.photoKey,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: '  Source kept\n量 🍲  ',
  };
}
const snapshotError = (reason: string) => (error: unknown) =>
  error instanceof AccountSnapshotError && error.reason === reason;
const replicationError = (reason: string) => (error: unknown) =>
  error instanceof AccountReplicationError && error.reason === reason;

test('v1 conversion pins original packaged plans and separates canonical source and derived digests', async () => {
  const source = base();
  source.plan = [planned(1, secondRecipe.recipeId), planned(0)];
  source.favourites = [{ recipeId: recipe.recipeId, savedAt: at }];
  source.shopping = {
    selectedOccurrenceIds: [source.plan[1]!.occurrenceId],
    purchaseMarks: [
      {
        groupKey: '1'.repeat(64),
        groupingVersion: 'original-grouping',
        demandFingerprint: '2'.repeat(64),
        purchased: true,
        changed: false,
      },
    ],
  };
  source.preferences = [{ preferenceId: randomUUID(), type: 'ingredient_like', value: '  Salt  ' }];
  const original = JSON.stringify(source);
  const canonicalSource = canonicalAccountSnapshot(source);
  const result = await convertBundledLegacyAccountSnapshot(source, sha256);
  assert.equal(result.sourceVersion, 1);
  assert.equal(result.sourceDigest, await sha256(canonicalSource));
  assert.equal(
    result.convertedDigest,
    await sha256(canonicalAccountContentSnapshot(result.snapshot)),
  );
  assert.notEqual(result.sourceDigest, result.convertedDigest);
  assert.equal(JSON.stringify(source), original);
  assert.equal(canonicalAccountSnapshot(source), canonicalSource);
  const normalized = normalizeAccountSnapshot(source);
  assert.deepEqual(result.snapshot.plan, normalized.plan);
  assert.deepEqual(result.snapshot.shopping, normalized.shopping);
  assert.deepEqual(result.snapshot.preferences, normalized.preferences);
  assert.deepEqual(result.snapshot.profile, source.profile);
  assert.deepEqual(result.snapshot.personal, {
    notes: [],
    collections: [],
    memberships: [],
    manualItems: [],
  });
  assert.equal(Object.hasOwn(result.snapshot, 'cookingHistory'), false);
  for (const occurrence of result.snapshot.plan) {
    const originalRevision = await createBundledRecipeRevision(occurrence.recipeId, sha256);
    assert.deepEqual(
      result.snapshot.planReferences.find((item) => item.occurrenceId === occurrence.occurrenceId)
        ?.contentRef,
      originalRevision.ref,
    );
  }
  assert.deepEqual(result.unresolvedHistoryEventIds, []);
  assert.deepEqual(Object.keys(result).sort(), [
    'convertedDigest',
    'snapshot',
    'sourceDigest',
    'sourceVersion',
    'unresolvedHistoryEventIds',
  ]);
});

test('v2 conversion preserves raw personal values, membership removals and all tombstone identities', async () => {
  const source = expanded(),
    collectionId = randomUUID(),
    removedCollectionId = randomUUID();
  source.personal = {
    notes: [
      {
        noteId: randomUUID(),
        recipeId: recipe.recipeId,
        text: '  Original\n量 🍲  ',
        deleted: false,
        createdAt: at,
        updatedAt: at,
      },
      {
        noteId: randomUUID(),
        recipeId: secondRecipe.recipeId,
        text: null,
        deleted: true,
        createdAt: at,
        updatedAt: at,
      },
    ],
    collections: [
      { collectionId, name: '  Weeknights  ', deleted: false, createdAt: at, updatedAt: at },
      {
        collectionId: removedCollectionId,
        name: null,
        deleted: true,
        createdAt: at,
        updatedAt: at,
      },
    ],
    memberships: [
      { collectionId, recipeId: recipe.recipeId, present: true, updatedAt: at },
      {
        collectionId: removedCollectionId,
        recipeId: secondRecipe.recipeId,
        present: false,
        updatedAt: at,
      },
    ],
    manualItems: [
      {
        kind: 'manual',
        itemId: randomUUID(),
        name: '  Lemons  ',
        amountText: ' 1 ½ ',
        unitText: '  bags ',
        category: 'produce',
        purchased: true,
        deleted: false,
        createdAt: at,
        updatedAt: at,
      },
      {
        kind: 'manual',
        itemId: randomUUID(),
        name: null,
        amountText: null,
        unitText: null,
        category: null,
        purchased: false,
        deleted: true,
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
  const before = canonicalAccountSnapshot(source);
  const result = await convertBundledLegacyAccountSnapshot(source, sha256);
  assert.equal(result.sourceVersion, 2);
  assert.equal(result.sourceDigest, await sha256(before));
  assert.deepEqual(result.snapshot.personal, normalizeAccountSnapshot(source).personal);
  assert.equal(canonicalAccountSnapshot(source), before);
  assert.equal(Object.hasOwn(result.snapshot, 'cookingHistory'), false);
});

test('legacy history proves exact title, photo and fingerprint while retaining every unresolved entry and removal', async () => {
  const source = expanded(),
    original = await history();
  const changed: AccountCookingHistoryEntry[] = [
    { ...original, eventId: randomUUID(), recipeTitle: `${original.recipeTitle} changed` },
    { ...original, eventId: randomUUID(), photoKey: 'different-photo.jpg' },
    { ...original, eventId: randomUUID(), contentFingerprint: 'f'.repeat(64) },
    {
      ...original,
      eventId: randomUUID(),
      catalogue: { ...catalogue.identity, fingerprint: 'f'.repeat(64) },
    },
    { ...original, eventId: randomUUID(), recipeId: '90001' },
  ];
  const removedEventIds = [randomUUID(), randomUUID()];
  source.cookingHistory = { entries: [original, ...changed], removedEventIds };
  source.cookingHistory.entries[0]!.origin = 'backup';
  const before = canonicalAccountSnapshot(source);
  const result = await convertBundledLegacyAccountSnapshot(source, sha256);
  const entries = result.snapshot.cookingHistory!.entries;
  assert.deepEqual(
    entries.map((item) => item.entry),
    normalizeAccountSnapshot(source).cookingHistory!.entries,
  );
  const proven = entries.find((item) => item.entry.eventId === original.eventId)!;
  assert.equal(proven.kind, 'legacy');
  if (proven.kind !== 'legacy') throw new Error('Expected legacy evidence');
  assert.deepEqual(proven.pin, {
    kind: 'exact',
    ref: (await createBundledRecipeRevision(recipe.recipeId, sha256)).ref,
  });
  assert.deepEqual(result.unresolvedHistoryEventIds, changed.map((item) => item.eventId).sort());
  for (const [index, entry] of changed.entries()) {
    const record = entries.find((item) => item.entry.eventId === entry.eventId)!;
    if (record.kind !== 'legacy') throw new Error('Expected original legacy record');
    assert.deepEqual(record.pin, {
      kind: 'unresolved',
      reason:
        index === 3
          ? 'catalogue_mismatch'
          : index === 4
            ? 'recipe_unavailable'
            : 'content_mismatch',
    });
  }
  assert.deepEqual(result.snapshot.cookingHistory!.removedEventIds, [...removedEventIds].sort());
  assert.equal(canonicalAccountSnapshot(source), before);
});

test('absent history stays absent, but an explicitly present empty history subtree stays present', async () => {
  const source = expanded();
  const absent = await convertBundledLegacyAccountSnapshot(source, sha256);
  source.cookingHistory = { entries: [], removedEventIds: [] };
  const present = await convertBundledLegacyAccountSnapshot(source, sha256);
  assert.equal(Object.hasOwn(absent.snapshot, 'cookingHistory'), false);
  assert.deepEqual(present.snapshot.cookingHistory, { entries: [], removedEventIds: [] });
  assert.notEqual(absent.sourceDigest, present.sourceDigest);
});

test('wrong packaged catalogue or unavailable plan recipes fail before any hash port call', async () => {
  let calls = 0;
  const hash = async (text: string) => {
    calls++;
    return sha256(text);
  };
  for (const catalogueChange of [
    { ...catalogue.identity, version: 'different-version' },
    { ...catalogue.identity, fingerprint: 'f'.repeat(64) },
  ]) {
    await assert.rejects(
      convertBundledLegacyAccountSnapshot({ ...base(), catalogue: catalogueChange }, hash),
      replicationError('catalogue_mismatch'),
    );
  }
  await assert.rejects(
    convertBundledLegacyAccountSnapshot({ ...base(), plan: [planned(0, '90001')] }, hash),
    replicationError('unknown_recipe'),
  );
  assert.equal(calls, 0);
});

test('caller-supplied authored references never replace original packaged identity', async () => {
  const authored = await createRecipeContentRevision(
    authoredFixture(recipe.recipeId),
    'authored-substitution',
    sha256,
  );
  const source = base();
  source.plan = [planned(0)];
  await assert.rejects(
    convertBundledLegacyAccountSnapshot(
      {
        ...source,
        planReferences: [{ occurrenceId: source.plan[0]!.occurrenceId, contentRef: authored.ref }],
      },
      sha256,
    ),
    snapshotError('invalid_structure'),
  );
  await assert.rejects(
    convertBundledLegacyAccountSnapshot(
      { ...source, plan: [{ ...source.plan[0]!, contentRef: authored.ref }] },
      sha256,
    ),
    snapshotError('invalid_structure'),
  );
  await assert.rejects(
    convertBundledLegacyAccountSnapshot({ ...source, schemaVersion: 3 }, sha256),
    snapshotError('unsupported_version'),
  );
  const value = expanded();
  value.cookingHistory = {
    entries: [{ ...(await history()), contentFingerprint: authored.ref.contentFingerprint }],
    removedEventIds: [],
  };
  const result = await convertBundledLegacyAccountSnapshot(value, sha256);
  assert.deepEqual(result.unresolvedHistoryEventIds, [value.cookingHistory.entries[0]!.eventId]);
});

test('source values and canonical evidence are owned synchronously before an asynchronous hash', async () => {
  const source = expanded();
  source.plan = [planned(0)];
  source.cookingHistory = { entries: [await history()], removedEventIds: [] };
  const expected = await convertBundledLegacyAccountSnapshot(source, sha256);
  let release: () => void = () => {
    throw new Error('Gate not initialized');
  };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const conversion = convertBundledLegacyAccountSnapshot(source, async (value) => {
    if (++calls === 1) await gate;
    return sha256(value);
  });
  assert.equal(calls, 1);
  source.plan[0]!.recipeId = '90001';
  source.profile.displayName = 'changed while awaiting';
  source.cookingHistory.entries[0]!.recipeTitle = 'changed title';
  source.cookingHistory.removedEventIds.push(randomUUID());
  release();
  assert.deepEqual(await conversion, expected);
});

test('data-only input rejects accessors, functions, cycles and mutation-authority fields without executing them', async () => {
  let invoked = 0,
    hashes = 0;
  const accessor = base();
  Object.defineProperty(accessor, 'profile', {
    enumerable: true,
    get() {
      invoked++;
      return { displayName: null };
    },
  });
  const cycle: Record<string, unknown> = { ...base() };
  cycle.profile = cycle;
  const candidates = [
    accessor,
    {
      ...base(),
      toJSON() {
        invoked++;
        return base();
      },
    },
    cycle,
    { ...base(), operationId: randomUUID() },
    { ...base(), approval: { personalApproved: true } },
    {
      ...base(),
      contentStore: {
        lookup() {
          invoked++;
        },
      },
    },
  ];
  for (const candidate of candidates)
    await assert.rejects(
      convertBundledLegacyAccountSnapshot(candidate, async (text) => {
        hashes++;
        return sha256(text);
      }),
      snapshotError('invalid_structure'),
    );
  assert.equal(invoked, 0);
  assert.equal(hashes, 0);
});

test('input exceeding the 2 MiB UTF-8 limit is rejected before hashing or shape cloning', async () => {
  let calls = 0;
  const source = { ...base(), profile: { displayName: '🍲'.repeat(600_000) } };
  await assert.rejects(
    convertBundledLegacyAccountSnapshot(source, async (text) => {
      calls++;
      return sha256(text);
    }),
    snapshotError('too_large'),
  );
  assert.equal(calls, 0);
});

test('derived references cannot grow an otherwise valid legacy snapshot beyond the format3 byte cap', async () => {
  const source = base();
  source.plan = Array.from({ length: 6000 }, (_, index) => planned(index));
  assert.ok(
    portableBackupByteLength(canonicalAccountSnapshot(source)) < ACCOUNT_SNAPSHOT_MAX_BYTES,
  );
  await assert.rejects(
    convertBundledLegacyAccountSnapshot(source, sha256),
    snapshotError('too_large'),
  );
});

test('many plan occurrences derive packaged content once per distinct recipe, not once per occurrence', async () => {
  const source = base();
  source.plan = Array.from({ length: 75 }, (_, index) =>
    planned(index, index % 2 ? recipe.recipeId : secondRecipe.recipeId),
  );
  const proofCalls = new Map<string, number>();
  const result = await convertBundledLegacyAccountSnapshot(source, async (text) => {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value) && typeof value[0] === 'string')
      proofCalls.set(value[0], (proofCalls.get(value[0]) ?? 0) + 1);
    return sha256(text);
  });
  assert.equal(result.snapshot.planReferences.length, 75);
  assert.equal(proofCalls.get('cookmate-recipe-content-v1'), 2);
  assert.equal(proofCalls.get('cookmate-recipe-revision-v1'), 2);
  assert.equal(proofCalls.size, 2);
});

test('intermediate packaged and legacy identity hashes enforce the same strict digest contract', async () => {
  const plannedSource = base();
  plannedSource.plan = [planned(0)];
  const historySource = expanded();
  historySource.cookingHistory = { entries: [await history()], removedEventIds: [] };
  for (const [source, invalidCall] of [
    [plannedSource, 2],
    [plannedSource, 3],
    [historySource, 2],
    [historySource, 3],
    [historySource, 4],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      convertBundledLegacyAccountSnapshot(source, async (text) =>
        ++calls === invalidCall ? 'NOT-A-VALID-SHA256' : sha256(text),
      ),
      replicationError('invalid_input'),
    );
    assert.equal(calls, invalidCall);
  }
});

test('returned evidence is deeply immutable and hash failures propagate without a partial conversion', async () => {
  const source = expanded();
  source.plan = [planned(0)];
  source.cookingHistory = { entries: [await history()], removedEventIds: [] };
  const result = await convertBundledLegacyAccountSnapshot(source, sha256);
  function check(value: unknown) {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    Object.values(value).forEach(check);
  }
  check(result);
  assert.equal(
    Reflect.set(result.snapshot.planReferences[0]!.contentRef, 'revisionId', 'changed'),
    false,
  );
  assert.equal(Object.isFrozen(source), false);
  await assert.rejects(
    convertBundledLegacyAccountSnapshot(base(), async () => 'not-a-digest'),
    replicationError('invalid_input'),
  );
  const denied = new Error('host hash lifetime ended');
  await assert.rejects(
    convertBundledLegacyAccountSnapshot(base(), async () => {
      throw denied;
    }),
    (error) => error === denied,
  );
  let calls = 0;
  await assert.rejects(
    convertBundledLegacyAccountSnapshot(base(), async (text) => {
      if (++calls === 2) throw denied;
      return sha256(text);
    }),
    (error) => error === denied,
  );
  assert.equal(calls, 2);
});
