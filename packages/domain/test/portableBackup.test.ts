import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createPortableBackup,
  PORTABLE_BACKUP_MAX_BYTES,
  portableBackupByteLength,
  validatePortableBackup,
} from '../src/portableBackup';
import type { PortableBackupEnvelope, PortableBackupInput } from '../src/portableBackup';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const identity = { version: 'synthetic-catalogue-v1', fingerprint: 'a'.repeat(64) };
const timestamp = '2026-09-30T08:00:00.000Z';
const options = { sha256, currentCatalogue: identity, knownRecipeIds: new Set(['52835']) };

function fixture(): PortableBackupInput {
  const occurrenceId = randomUUID();
  return {
    createdAt: timestamp,
    catalogue: identity,
    sourceRevision: 4,
    data: {
      favourites: [
        { recipeId: '52835', saved: true, revision: 1, savedAt: timestamp, updatedAt: timestamp },
      ],
      occurrences: [
        {
          occurrenceId,
          recipeId: '52835',
          placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      shopping: {
        scope: { scopeId: randomUUID(), revision: 1, occurrenceIds: [occurrenceId] },
        projectionRevision: 1,
        projectionStatus: 'current',
        purchaseMarks: [
          {
            groupKey: 'b'.repeat(64),
            groupingVersion: 'synthetic-quantity-v1',
            demandFingerprint: 'c'.repeat(64),
            projectionRevision: 1,
            purchased: true,
            changed: false,
            revision: 1,
          },
        ],
      },
      preferences: {
        snapshot: {
          revision: 1,
          lastRemovalRevision: null,
          items: [{ preferenceId: randomUUID(), type: 'cuisine', value: 'Italian', revision: 1 }],
        },
        removals: [],
      },
    },
  };
}

test('plain export validates exactly and provides review counts without enabling restore', async () => {
  const backup = await createPortableBackup(fixture(), sha256);
  const checked = await validatePortableBackup(JSON.stringify(backup), options);
  assert.equal(checked.kind, 'ready');
  if (checked.kind !== 'ready') assert.fail();
  assert.deepEqual(checked.preview.counts, {
    favourites: 1,
    tombstones: 0,
    plannedMeals: 1,
    selectedMeals: 1,
    purchaseMarks: 1,
    purchasedItems: 1,
    preferences: 1,
    preferenceRemovals: 0,
  });
  assert.deepEqual(checked.preview.selectedDateRange, { first: '2026-09-30', last: '2026-09-30' });
  assert.equal(checked.preview.restoreAvailable, false);
  assert.ok(checked.preview.warnings.includes('personal_data_plaintext'));
  assert.ok(checked.preview.warnings.includes('checksum_is_not_authentication'));
  assert.ok(checked.preview.warnings.includes('shopping_requires_reprojection'));
  assert.equal(Object.isFrozen(checked.value.data.occurrences), true);
});

test('canonical integrity tolerates JSON whitespace and object key order, not changed data', async () => {
  const backup = await createPortableBackup(fixture(), sha256);
  const reordered = Object.fromEntries(Object.entries(backup).reverse());
  assert.equal(
    (await validatePortableBackup(JSON.stringify(reordered, null, 2), options)).kind,
    'ready',
  );
  const altered = JSON.parse(JSON.stringify(backup));
  altered.data.preferences.snapshot.items[0].value = 'Spanish';
  assert.deepEqual(await validatePortableBackup(JSON.stringify(altered), options), {
    kind: 'invalid',
    reason: 'checksum_mismatch',
  });
});

test('unknown recipe references remain in the package and appear explicitly in its preview', async () => {
  const input = fixture();
  input.catalogue = { version: 'other-catalogue', fingerprint: 'd'.repeat(64) };
  input.data.occurrences[0]!.recipeId = '999999';
  const backup = await createPortableBackup(input, sha256);
  const checked = await validatePortableBackup(JSON.stringify(backup), options);
  assert.equal(checked.kind, 'ready');
  if (checked.kind !== 'ready') assert.fail();
  assert.deepEqual(checked.preview.unknownRecipeIds, ['999999']);
  assert.equal(checked.preview.catalogueMatches, false);
  assert.equal(checked.value.data.occurrences[0]!.recipeId, '999999');
  assert.ok(checked.preview.warnings.includes('catalogue_mismatch'));
});

test('future versions and unexpected executable/private fields are rejected before hashing', async () => {
  const backup = await createPortableBackup(fixture(), sha256);
  let hashes = 0;
  const guarded = {
    ...options,
    sha256: async (text: string) => {
      hashes++;
      return sha256(text);
    },
  };
  for (const addition of [
    { schemaVersion: 3 },
    { databaseSchemaVersion: 7 },
    { pendingActions: [{ command: 'setFavourite' }] },
    { credentials: { token: 'synthetic-secret' } },
  ]) {
    assert.equal(
      (await validatePortableBackup(JSON.stringify({ ...backup, ...addition }), guarded)).kind,
      'invalid',
    );
  }
  assert.equal(hashes, 0);
});

test('dangling shopping selections, duplicate dates, invalid dates and dishonest counts fail safely', async () => {
  const backup = await createPortableBackup(fixture(), sha256);
  const variants: ((value: PortableBackupEnvelope) => void)[] = [
    (value) => {
      value.data.shopping.scope.occurrenceIds = [randomUUID()];
    },
    (value) => {
      value.data.occurrences.push({ ...value.data.occurrences[0]!, occurrenceId: randomUUID() });
      value.counts.plannedMeals++;
    },
    (value) => {
      value.data.occurrences[0]!.placement.actualDate = '2026-02-30';
    },
    (value) => {
      value.counts.favourites = 4;
    },
    (value) => {
      value.data.favourites[0]!.saved = 1 as unknown as boolean;
    },
    (value) => {
      value.data.shopping.purchaseMarks[0]!.projectionRevision = 2;
    },
  ];
  for (const change of variants) {
    const value = JSON.parse(JSON.stringify(backup));
    change(value);
    assert.deepEqual(await validatePortableBackup(JSON.stringify(value), options), {
      kind: 'invalid',
      reason: 'invalid_structure',
    });
  }
});

test('removal provenance cannot silently revive a removed preference version', async () => {
  const input = fixture();
  const current = input.data.preferences.snapshot.items[0]!;
  input.data.preferences.snapshot.revision = 2;
  input.data.preferences.snapshot.lastRemovalRevision = 2;
  input.data.preferences.removals = [
    {
      preferenceId: current.preferenceId,
      type: current.type,
      value: current.value,
      savedRevision: 1,
      removedRevision: 2,
    },
  ];
  await assert.rejects(createPortableBackup(input, sha256), /invalid_structure/);
  input.data.preferences.snapshot.items = [{ ...current, value: 'Spanish', revision: 2 }];
  const replacement = await createPortableBackup(input, sha256);
  assert.equal((await validatePortableBackup(JSON.stringify(replacement), options)).kind, 'ready');
  assert.equal(replacement.data.preferences.snapshot.items[0]!.value, 'Spanish');
  assert.equal(replacement.data.preferences.removals[0]!.value, 'Italian');
  input.data.preferences.snapshot.items = [];
  const backup = await createPortableBackup(input, sha256);
  assert.equal((await validatePortableBackup(JSON.stringify(backup), options)).kind, 'ready');
});

test('backup owns its snapshot before an asynchronous hash and preserves tombstones', async () => {
  const input = fixture();
  input.data.favourites[0]!.saved = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = createPortableBackup(input, async (text) => {
    await gate;
    return sha256(text);
  });
  input.data.favourites[0]!.saved = true;
  input.data.preferences.snapshot.items[0]!.value = 'Changed after snapshot';
  release();
  const backup = await saving;
  assert.equal(backup.counts.tombstones, 1);
  assert.equal(backup.data.favourites[0]!.saved, false);
  assert.equal(backup.data.preferences.snapshot.items[0]!.value, 'Italian');
  assert.equal((await validatePortableBackup(JSON.stringify(backup), options)).kind, 'ready');
});

test('UTF-8 size, parsing and unavailable hashing have distinct bounded failures', async () => {
  assert.equal(portableBackupByteLength('🍋العربية'), Buffer.byteLength('🍋العربية'));
  assert.deepEqual(
    await validatePortableBackup(' '.repeat(PORTABLE_BACKUP_MAX_BYTES + 1), options),
    { kind: 'invalid', reason: 'too_large' },
  );
  assert.deepEqual(await validatePortableBackup('{', options), {
    kind: 'invalid',
    reason: 'invalid_json',
  });
  const backup = await createPortableBackup(fixture(), sha256);
  assert.deepEqual(
    await validatePortableBackup(JSON.stringify(backup), {
      ...options,
      sha256: async () => {
        throw new Error('Synthetic hash adapter failure');
      },
    }),
    { kind: 'invalid', reason: 'integrity_unavailable' },
  );
});
