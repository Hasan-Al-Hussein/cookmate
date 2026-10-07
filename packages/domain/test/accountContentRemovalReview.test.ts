import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AccountReplicationError, emptyAccountSnapshot } from '@cookmate/account-sync';
import type { SavedPreference } from '@cookmate/contracts';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../account-sync/src/contentSnapshot';
import {
  createPortableContentBackup,
  type PortableContentBackupEnvelope,
  type PortableContentBackupInput,
} from '../src/portableBackupContent';
import {
  assertAccountContentRemovalResolution,
  createAccountContentRemovalReview,
  resolveAccountContentRemovalReview,
  type AccountContentRemovalChoices,
} from '../../../apps/mobile/src/data/accountContentRemovalReview';

const at = '2026-10-01T12:00:00.000Z';
const later = '2026-10-01T12:30:00.000Z';
const catalogue = { version: 'review-fixture', fingerprint: 'a'.repeat(64) };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const error = (reason: string) => (value: unknown) =>
  value instanceof AccountReplicationError && value.reason === reason;
const preference = (n: number, value = '  Italian  '): SavedPreference => ({
  preferenceId: id(n),
  type: 'cuisine',
  value,
  revision: 3,
});
function candidate(): AccountContentSnapshot {
  return {
    ...emptyAccountSnapshot(catalogue, {
      appPreferences: { theme: 'dark', motion: 'reduced', locale: 'ar' },
      profile: { displayName: '  Exact profile  ' },
    }),
    schemaVersion: 3,
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
    planReferences: [],
  };
}
async function backup(change: (value: PortableContentBackupInput) => void = () => {}) {
  const input: PortableContentBackupInput = {
    schemaVersion: 3,
    databaseSchemaVersion: 8,
    createdAt: at,
    catalogue,
    sourceRevision: 3,
    data: {
      favourites: [],
      occurrences: [],
      shopping: {
        scope: { scopeId: id(100), revision: 1, occurrenceIds: [] },
        projectionRevision: 1,
        projectionStatus: 'current',
        purchaseMarks: [],
      },
      preferences: {
        snapshot: { revision: 3, lastRemovalRevision: null, items: [] },
        removals: [],
      },
      personal: { notes: [], collections: [], memberships: [], manualItems: [] },
      planReferences: [],
    },
  };
  change(input);
  // Each ordinary fixture is a codec-created, checksum-valid portable snapshot. This helper
  // reviews data only; it cannot establish storage, content trust, or account authority.
  return JSON.parse(
    JSON.stringify(await createPortableContentBackup(input, sha256)),
  ) as PortableContentBackupEnvelope;
}
const tombstone = (recipeId = '52835') => ({
  recipeId,
  saved: false,
  revision: 2,
  savedAt: at,
  updatedAt: later,
});

test('near-limit removal evidence shared by two conflicts remains admissible without expanded serialization', async () => {
  const text = 'ش'.repeat(256);
  const before = await backup((value) => {
    value.sourceRevision = 20001;
    value.data.preferences.snapshot.revision = 20001;
    value.data.preferences.snapshot.lastRemovalRevision = 20000;
    value.data.preferences.removals = Array.from({ length: 10000 }, (_, index) => ({
      preferenceId: id(1),
      type: 'cuisine',
      value: text,
      savedRevision: index * 2 + 1,
      removedRevision: index * 2 + 2,
    }));
  });
  const incoming = candidate();
  incoming.preferences = [
    { preferenceId: id(1), type: 'cuisine', value: 'Changed value' },
    { preferenceId: id(2), type: 'cuisine', value: text },
  ];
  const review = createAccountContentRemovalReview(incoming, before, false);
  assert.equal(review.conflicts.length, 2);
  for (const conflict of review.conflicts) {
    assert.equal(conflict.kind, 'preference');
    if (conflict.kind === 'preference') assert.equal(conflict.removals.length, 10000);
  }
  const resolution = resolveAccountContentRemovalReview(
    review,
    choices(review, 'save_account_version'),
  );
  assertAccountContentRemovalResolution(resolution, resolution.snapshot, before, false);
});
function choices(
  review: { readonly conflicts: readonly { readonly id: string }[] },
  value: 'keep_local' | 'save_account_version',
): AccountContentRemovalChoices {
  return Object.fromEntries(review.conflicts.map((conflict) => [conflict.id, value]));
}

test('favourite review exposes exact removal evidence and separately approves keeping or restoring', async () => {
  const before = await backup((value) => {
    value.data.favourites = [tombstone()];
  });
  const incoming = candidate();
  incoming.favourites = [
    { recipeId: '52835', savedAt: later },
    { recipeId: '52836', savedAt: at },
  ];
  const review = createAccountContentRemovalReview(incoming, before, false);
  assert.deepEqual(review.conflicts, [
    {
      id: 'favourite:52835',
      kind: 'favourite',
      incoming: incoming.favourites[0],
      current: { kind: 'removed', row: before.data.favourites[0] },
      reasons: ['exactFavouriteRemoval'],
    },
  ]);
  const kept = resolveAccountContentRemovalReview(review, { 'favourite:52835': 'keep_local' });
  assert.deepEqual(kept.snapshot.favourites, [incoming.favourites[1]]);
  assertAccountContentRemovalResolution(kept, kept.snapshot, before, false);
  const saved = resolveAccountContentRemovalReview(review, {
    'favourite:52835': 'save_account_version',
  });
  assert.deepEqual(saved.snapshot.favourites, incoming.favourites);
  assertAccountContentRemovalResolution(saved, saved.snapshot, before, false);
  assert.equal(before.data.favourites[0]!.saved, false);
});

test('preference removals match either exact identity or equivalent value without inventing facts', async () => {
  const before = await backup((value) => {
    value.data.preferences.snapshot.lastRemovalRevision = 2;
    value.data.preferences.removals = [
      {
        preferenceId: id(1),
        type: 'cuisine',
        value: 'Italian',
        savedRevision: 1,
        removedRevision: 2,
      },
      { preferenceId: id(2), type: 'cuisine', value: 'Thai', savedRevision: 1, removedRevision: 2 },
    ];
  });
  const incoming = candidate();
  incoming.preferences = [
    { preferenceId: id(1), type: 'cuisine', value: 'Changed exact ID' },
    { preferenceId: id(3), type: 'cuisine', value: 'Thai' },
  ];
  const review = createAccountContentRemovalReview(incoming, before, true);
  assert.equal(review.conflicts.length, 2);
  for (const [index, conflict] of review.conflicts.entries()) {
    assert.equal(conflict.kind, 'preference');
    if (conflict.kind !== 'preference') assert.fail('Expected preference evidence');
    assert.deepEqual(conflict.removals, [before.data.preferences.removals[index]]);
    assert.deepEqual(conflict.current, { kind: 'absent' });
    assert.deepEqual(conflict.reasons, ['exactPreferenceRemoval', 'retainedRestoreArchive']);
    assert.equal(conflict.lastRemovalRevision, 2);
  }
  const kept = resolveAccountContentRemovalReview(review, choices(review, 'keep_local'));
  assert.deepEqual(kept.snapshot.preferences, []);
});

test('unknown removal and retained archive are explicit uncertainty without fabricated deleted text', async () => {
  const incoming = candidate();
  incoming.preferences = [{ preferenceId: id(1), type: 'cuisine', value: 'Thai' }];
  for (const [marker, archive, reasons] of [
    [2, false, ['unidentifiedPreferenceRemoval']],
    [null, true, ['retainedRestoreArchive']],
    [2, true, ['unidentifiedPreferenceRemoval', 'retainedRestoreArchive']],
  ] as const) {
    const before = await backup((value) => {
      value.data.preferences.snapshot.lastRemovalRevision = marker;
    });
    const review = createAccountContentRemovalReview(incoming, before, archive);
    const conflict = review.conflicts[0]!;
    assert.equal(conflict.kind, 'preference');
    if (conflict.kind !== 'preference') assert.fail('Expected preference evidence');
    assert.deepEqual(conflict.removals, []);
    assert.deepEqual(conflict.current, { kind: 'absent' });
    assert.deepEqual(conflict.reasons, reasons);
    assert.deepEqual(conflict.incoming, incoming.preferences[0]);
  }
});

test('unchanged live preferences and deletion-only candidates require no revival choice', async () => {
  const before = await backup((value) => {
    value.data.favourites = [tombstone()];
    value.data.preferences.snapshot.items = [preference(1)];
    value.data.preferences.snapshot.lastRemovalRevision = 2;
    value.data.preferences.removals = [
      {
        preferenceId: id(1),
        type: 'cuisine',
        value: 'Italian',
        savedRevision: 1,
        removedRevision: 2,
      },
    ];
  });
  for (const preferences of [
    [],
    [{ preferenceId: id(1), type: 'cuisine' as const, value: '  Italian  ' }],
  ]) {
    const incoming = candidate();
    incoming.preferences = preferences;
    const review = createAccountContentRemovalReview(incoming, before, true);
    assert.deepEqual(review.conflicts, []);
    const resolution = resolveAccountContentRemovalReview(review, {});
    assert.equal(
      canonicalAccountContentSnapshot(resolution.snapshot),
      canonicalAccountContentSnapshot(incoming),
    );
    assertAccountContentRemovalResolution(resolution, incoming, before, true);
  }
});

test('a changed preference can keep the current exact live value with raw spacing intact', async () => {
  const before = await backup((value) => {
    value.data.preferences.snapshot.items = [preference(1)];
    value.data.preferences.snapshot.lastRemovalRevision = 2;
  });
  const incoming = candidate();
  incoming.preferences = [{ preferenceId: id(1), type: 'cuisine', value: 'Thai' }];
  const review = createAccountContentRemovalReview(incoming, before, false);
  assert.deepEqual(review.conflicts[0]!.current, { kind: 'live', row: preference(1) });
  const kept = resolveAccountContentRemovalReview(review, {
    [`preference:${id(1)}`]: 'keep_local',
  });
  assert.deepEqual(kept.snapshot.preferences, [
    { preferenceId: id(1), type: 'cuisine', value: '  Italian  ' },
  ]);
  assertAccountContentRemovalResolution(kept, kept.snapshot, before, false);
  assert.throws(
    () => assertAccountContentRemovalResolution(kept, incoming, before, false),
    error('operation_changed'),
  );
});

test('mixed choices preserve exact plans, history, personal data, settings and unrelated rows', async () => {
  const before = await backup((value) => {
    value.data.favourites = [tombstone()];
    value.data.preferences.snapshot.lastRemovalRevision = 2;
  });
  const incoming = candidate();
  incoming.favourites = [{ recipeId: '52835', savedAt: later }];
  incoming.preferences = [{ preferenceId: id(1), type: 'ingredient_like', value: '  海盐 \n' }];
  const ref = {
    recipeId: '52835',
    revisionId: 'archived-exact-revision',
    contentFingerprint: 'b'.repeat(64),
  };
  incoming.plan = [
    {
      occurrenceId: id(10),
      recipeId: ref.recipeId,
      placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
      createdAt: at,
      updatedAt: at,
    },
  ];
  incoming.planReferences = [{ occurrenceId: id(10), contentRef: ref }];
  incoming.shopping.selectedOccurrenceIds = [id(10)];
  incoming.personal.notes = [
    {
      noteId: id(11),
      recipeId: ref.recipeId,
      text: '  Exact note\n🍲  ',
      deleted: false,
      createdAt: at,
      updatedAt: at,
    },
  ];
  incoming.cookingHistory = {
    entries: [
      {
        kind: 'exact',
        entry: {
          readerVersion: 2,
          recipeId: ref.recipeId,
          contentRef: ref,
          eventId: id(12),
          recipeTitle: 'Exact title',
          photoAssetId: null,
          cookedOn: '2026-10-01',
          timeZone: 'Asia/Dubai',
          recordedAt: at,
          note: 'Raw history',
        },
      },
    ],
    removedEventIds: [id(13)],
  };
  const review = createAccountContentRemovalReview(incoming, before, false);
  const resolution = resolveAccountContentRemovalReview(review, {
    'favourite:52835': 'keep_local',
    [`preference:${id(1)}`]: 'save_account_version',
  });
  const expected = clone(incoming);
  expected.favourites = [];
  assert.equal(
    canonicalAccountContentSnapshot(resolution.snapshot),
    canonicalAccountContentSnapshot(expected),
  );
  assertAccountContentRemovalResolution(resolution, expected, before, false);
});

test('keep-local value collisions reject the combination instead of silently removing another preference', async () => {
  const before = await backup((value) => {
    value.data.preferences.snapshot.items = [preference(1, 'Italian')];
  });
  const incoming = candidate();
  incoming.preferences = [
    { preferenceId: id(1), type: 'cuisine', value: 'Thai' },
    { preferenceId: id(2), type: 'cuisine', value: 'Italian' },
  ];
  const review = createAccountContentRemovalReview(incoming, before, true);
  assert.throws(
    () =>
      resolveAccountContentRemovalReview(review, {
        [`preference:${id(1)}`]: 'keep_local',
        [`preference:${id(2)}`]: 'save_account_version',
      }),
    error('invalid_input'),
  );
  const kept = resolveAccountContentRemovalReview(review, {
    [`preference:${id(1)}`]: 'keep_local',
    [`preference:${id(2)}`]: 'keep_local',
  });
  assert.deepEqual(kept.snapshot.preferences, [
    { preferenceId: id(1), type: 'cuisine', value: 'Italian' },
  ]);
  assert.equal(incoming.preferences.length, 2);
});

test('decisions require every exact conflict once with no missing, extra or unsupported keys', async () => {
  const before = await backup((value) => {
    value.data.favourites = [tombstone()];
  });
  const incoming = candidate();
  incoming.favourites = [{ recipeId: '52835', savedAt: at }];
  const review = createAccountContentRemovalReview(incoming, before, false);
  for (const value of [
    {},
    { unrelated: 'keep_local' },
    { 'favourite:52835': 'keep_local', extra: 'keep_local' },
    { 'favourite:52835': 'yes' },
    null,
    [],
  ]) {
    assert.throws(
      () => resolveAccountContentRemovalReview(review, value as AccountContentRemovalChoices),
      error('invalid_input'),
    );
  }
  const empty = createAccountContentRemovalReview(candidate(), before, false);
  assert.throws(
    () => resolveAccountContentRemovalReview(empty, { extra: 'keep_local' }),
    error('invalid_input'),
  );
});

test('cloned reviews and cloned resolutions cannot authorize any output', async () => {
  const before = await backup();
  const incoming = candidate();
  const review = createAccountContentRemovalReview(incoming, before, false);
  assert.throws(
    () => resolveAccountContentRemovalReview(clone(review), {}),
    error('invalid_input'),
  );
  const resolution = resolveAccountContentRemovalReview(review, {});
  assert.throws(
    () => assertAccountContentRemovalResolution(clone(resolution), incoming, before, false),
    error('invalid_input'),
  );
  assert.throws(
    () => resolveAccountContentRemovalReview({ conflicts: [] }, {}),
    error('invalid_input'),
  );
});

test('same conflict ID never authorizes a changed candidate or an unrelated output field', async () => {
  const before = await backup((value) => {
    value.data.favourites = [tombstone()];
  });
  const incoming = candidate();
  incoming.favourites = [{ recipeId: '52835', savedAt: at }];
  const review = createAccountContentRemovalReview(incoming, before, false);
  const resolution = resolveAccountContentRemovalReview(review, {
    'favourite:52835': 'save_account_version',
  });
  for (const change of [
    (value: AccountContentSnapshot) => {
      value.favourites[0]!.savedAt = later;
    },
    (value: AccountContentSnapshot) => {
      value.profile.displayName = 'A different profile';
    },
    (value: AccountContentSnapshot) => {
      value.favourites.push({ recipeId: '52836', savedAt: at });
    },
  ]) {
    const different = clone(incoming);
    change(different);
    assert.throws(
      () => assertAccountContentRemovalResolution(resolution, different, before, false),
      error('operation_changed'),
    );
  }
});

test('favourite revision, original timestamp and updated timestamp are all bound evidence', async () => {
  const before = await backup((value) => {
    value.data.favourites = [tombstone()];
  });
  const incoming = candidate();
  incoming.favourites = [{ recipeId: '52835', savedAt: at }];
  const review = createAccountContentRemovalReview(incoming, before, false);
  const resolution = resolveAccountContentRemovalReview(review, {
    'favourite:52835': 'save_account_version',
  });
  for (const change of [
    (value: PortableContentBackupEnvelope) => {
      value.data.favourites[0]!.revision = 3;
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.favourites[0]!.savedAt = later;
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.favourites[0]!.updatedAt = at;
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.favourites[0]!.saved = true;
    },
  ]) {
    const changed = clone(before);
    change(changed);
    assert.throws(
      () => assertAccountContentRemovalResolution(resolution, resolution.snapshot, changed, false),
      error('local_changed'),
    );
  }
});

test('all preference removal facts, live revisions, global clocks and archive presence are bound', async () => {
  const before = await backup((value) => {
    value.data.preferences.snapshot.items = [preference(1)];
    value.data.preferences.snapshot.lastRemovalRevision = 2;
    value.data.preferences.removals = [
      { preferenceId: id(2), type: 'cuisine', value: 'Thai', savedRevision: 1, removedRevision: 2 },
    ];
  });
  const incoming = candidate();
  incoming.preferences = [{ preferenceId: id(3), type: 'cuisine', value: 'Thai' }];
  const review = createAccountContentRemovalReview(incoming, before, false);
  const resolution = resolveAccountContentRemovalReview(review, {
    [`preference:${id(3)}`]: 'save_account_version',
  });
  for (const change of [
    (value: PortableContentBackupEnvelope) => {
      value.sourceRevision = 4;
    },
    (value: PortableContentBackupEnvelope) => {
      value.databaseSchemaVersion = 7;
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.preferences.snapshot.items[0]!.revision = 2;
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.preferences.snapshot.items[0]!.value = 'Italian';
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.preferences.snapshot.lastRemovalRevision = 3;
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.preferences.snapshot.revision = 4;
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.preferences.removals[0]!.value = 'Different old text';
    },
    (value: PortableContentBackupEnvelope) => {
      value.data.preferences.removals.push({
        preferenceId: id(9),
        type: 'cuisine',
        value: 'Unrelated removed choice',
        savedRevision: 1,
        removedRevision: 2,
      });
    },
  ]) {
    const changed = clone(before);
    change(changed);
    assert.throws(
      () => assertAccountContentRemovalResolution(resolution, resolution.snapshot, changed, false),
      error('local_changed'),
    );
  }
  assert.throws(
    () => assertAccountContentRemovalResolution(resolution, resolution.snapshot, before, true),
    error('local_changed'),
  );
});

test('equivalent evidence ordering does not invalidate an exact resolution', async () => {
  const before = await backup((value) => {
    value.data.favourites = [tombstone('52835'), tombstone('52836')];
    value.data.preferences.snapshot.items = [preference(1, 'Italian'), preference(2, 'Thai')];
    value.data.preferences.snapshot.lastRemovalRevision = 2;
    value.data.preferences.removals = [1, 2].map((n) => ({
      preferenceId: id(n),
      type: 'cuisine',
      value: `Previous ${n}`,
      savedRevision: 1,
      removedRevision: 2,
    }));
  });
  const review = createAccountContentRemovalReview(candidate(), before, false);
  const resolution = resolveAccountContentRemovalReview(review, {});
  before.data.favourites.reverse();
  before.data.preferences.snapshot.items.reverse();
  before.data.preferences.removals.reverse();
  assertAccountContentRemovalResolution(resolution, resolution.snapshot, before, false);
});

test('review and resolution own inert copies and deeply freeze their exposed data', async () => {
  const before = await backup((value) => {
    value.data.favourites = [tombstone()];
  });
  const stableBefore = clone(before);
  const incoming = candidate();
  incoming.favourites = [{ recipeId: '52835', savedAt: at }];
  const review = createAccountContentRemovalReview(incoming, before, false);
  incoming.favourites[0]!.savedAt = later;
  before.data.favourites[0]!.updatedAt = at;
  const selected: Record<string, 'keep_local' | 'save_account_version'> = {
    'favourite:52835': 'save_account_version',
  };
  const resolution = resolveAccountContentRemovalReview(review, selected);
  selected['favourite:52835'] = 'keep_local';
  assert.equal(resolution.snapshot.favourites[0]!.savedAt, at);
  assert.equal(resolution.choices['favourite:52835'], 'save_account_version');
  assertAccountContentRemovalResolution(resolution, resolution.snapshot, stableBefore, false);
  assert.equal(Object.isFrozen(review.conflicts), true);
  assert.equal(Object.isFrozen(review.conflicts[0]!.incoming), true);
  assert.equal(Object.isFrozen(resolution.snapshot.personal.notes), true);
  assert.equal(Object.isFrozen(resolution.choices), true);
});

test('accessors and toJSON cannot run through candidate, local evidence or decisions', async () => {
  const before = await backup();
  let executions = 0;
  const incoming = candidate();
  Object.defineProperty(incoming, 'favourites', {
    enumerable: true,
    get: () => {
      executions++;
      return [];
    },
  });
  assert.throws(
    () => createAccountContentRemovalReview(incoming, before, false),
    error('invalid_input'),
  );
  const hostile = clone(before);
  Object.defineProperty(hostile.data.preferences.snapshot, 'items', {
    enumerable: true,
    get: () => {
      executions++;
      return [];
    },
  });
  assert.throws(
    () => createAccountContentRemovalReview(candidate(), hostile, false),
    error('invalid_input'),
  );
  const review = createAccountContentRemovalReview(candidate(), before, false);
  const toJSON = {
    toJSON() {
      executions++;
      return {};
    },
  };
  assert.throws(
    () =>
      resolveAccountContentRemovalReview(review, toJSON as unknown as AccountContentRemovalChoices),
    error('invalid_input'),
  );
  assert.equal(executions, 0);
});

test('invalid local evidence and unsupported candidate shape are rejected before issuing authority', async () => {
  const before = await backup();
  const invalidCatalogue = clone(before);
  Object.assign(invalidCatalogue, { catalogue: null });
  assert.throws(
    () => createAccountContentRemovalReview(candidate(), invalidCatalogue, false),
    error('invalid_input'),
  );
  const wrongCatalogue = clone(before);
  wrongCatalogue.catalogue.version = 'other';
  assert.throws(
    () => createAccountContentRemovalReview(candidate(), wrongCatalogue, false),
    error('invalid_input'),
  );
  const invalidRemoval = clone(before);
  invalidRemoval.data.preferences.removals = [
    { preferenceId: id(1), type: 'cuisine', value: 'Thai', savedRevision: 2, removedRevision: 1 },
  ];
  assert.throws(
    () => createAccountContentRemovalReview(candidate(), invalidRemoval, false),
    error('invalid_input'),
  );
  const legacy = { ...candidate(), schemaVersion: 2 };
  assert.throws(
    () => createAccountContentRemovalReview(legacy as AccountContentSnapshot, before, false),
    error('invalid_input'),
  );
  assert.throws(
    () => createAccountContentRemovalReview(candidate(), before, 'yes' as unknown as boolean),
    error('invalid_input'),
  );
});

test('bounded ownership rejects oversized candidate, backup and decision objects', async () => {
  const before = await backup();
  const hugeCandidate = candidate();
  hugeCandidate.profile.displayName = 'x'.repeat(2 * 1024 * 1024);
  assert.throws(
    () => createAccountContentRemovalReview(hugeCandidate, before, false),
    error('too_large'),
  );
  const hugeBackup = clone(before);
  Object.assign(hugeBackup, { excessive: 'x'.repeat(8 * 1024 * 1024) });
  assert.throws(
    () => createAccountContentRemovalReview(candidate(), hugeBackup, false),
    error('too_large'),
  );
  const review = createAccountContentRemovalReview(candidate(), before, false);
  const hugeChoices = { ['x'.repeat(1024 * 1024)]: 'keep_local' as const };
  assert.throws(() => resolveAccountContentRemovalReview(review, hugeChoices), error('too_large'));
});

test('the supported 10000 favourite removals resolve without an artificial small-choice cap', async () => {
  const rows = Array.from({ length: 10000 }, (_, n) => tombstone(String(n + 1)));
  const before = await backup((value) => {
    value.data.favourites = rows;
  });
  const incoming = candidate();
  incoming.favourites = rows.map(({ recipeId }) => ({ recipeId, savedAt: at }));
  const review = createAccountContentRemovalReview(incoming, before, false);
  assert.equal(review.conflicts.length, 10000);
  const resolution = resolveAccountContentRemovalReview(review, choices(review, 'keep_local'));
  assert.deepEqual(resolution.snapshot.favourites, []);
  assertAccountContentRemovalResolution(resolution, resolution.snapshot, before, false);
});
