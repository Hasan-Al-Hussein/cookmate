import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createPortableBackup,
  summarizePortableBackupReferences,
  validatePortableBackup,
} from '../src/portableBackup';
import type { PortableBackupInput } from '../src/portableBackup';

const at = '2026-10-01T08:00:00.000Z';
const catalogue = { version: 'reference-fixture-v1', fingerprint: 'a'.repeat(64) };
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const options = { currentCatalogue: catalogue, knownRecipeIds: new Set(['52835', '52839']) };
function fixture(): PortableBackupInput {
  const collectionId = randomUUID();
  return {
    schemaVersion: 2,
    databaseSchemaVersion: 5,
    createdAt: at,
    catalogue,
    sourceRevision: 4,
    data: {
      favourites: [
        { recipeId: '52835', saved: true, revision: 1, savedAt: at, updatedAt: at },
        { recipeId: '52839', saved: false, revision: 1, savedAt: at, updatedAt: at },
      ],
      occurrences: [
        {
          occurrenceId: randomUUID(),
          recipeId: '52835',
          placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
          revision: 1,
          createdAt: at,
          updatedAt: at,
        },
      ],
      shopping: {
        scope: { scopeId: randomUUID(), revision: 0, occurrenceIds: [] },
        projectionRevision: 0,
        projectionStatus: 'current',
        purchaseMarks: [],
      },
      preferences: {
        snapshot: { revision: 0, lastRemovalRevision: null, items: [] },
        removals: [],
      },
      personal: {
        notes: [
          {
            noteId: randomUUID(),
            recipeId: '52835',
            text: 'PRIVATE-NOTE',
            deleted: false,
            revision: 1,
            createdAt: at,
            updatedAt: at,
          },
        ],
        collections: [
          {
            collectionId,
            name: 'PRIVATE-COLLECTION',
            deleted: false,
            revision: 1,
            createdAt: at,
            updatedAt: at,
          },
        ],
        memberships: [
          { collectionId, recipeId: '52839', present: false, revision: 1, updatedAt: at },
        ],
        manualItems: [],
      },
    },
  };
}
function addHistory(input: PortableBackupInput) {
  input.data.cookingHistory = {
    entries: [
      {
        recipeId: '52835',
        catalogue,
        contentFingerprint: 'b'.repeat(64),
        readerVersion: 1,
        eventId: randomUUID(),
        recipeTitle: 'PRIVATE-RECORDED-TITLE',
        photoKey: '52835',
        cookedOn: '2026-09-30',
        timeZone: 'Asia/Dubai',
        recordedAt: at,
        note: 'PRIVATE-HISTORY-NOTE',
        historyEpoch: 0,
        revision: 1,
      },
    ],
  };
}
async function inspect(input: PortableBackupInput) {
  const backup = await createPortableBackup(input, sha256);
  const serialized = JSON.stringify(backup);
  const result = await validatePortableBackup(serialized, { ...options, sha256 });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') assert.fail();
  assert.equal(JSON.stringify(result.value), serialized);
  return result;
}

test('same full catalogue identity confirms unique referenced IDs including tombstones, without private field values', async () => {
  const result = await inspect(fixture());
  const summary = result.preview.referenceSummary;
  assert.deepEqual(summary.knownExactRecipeIds, ['52835', '52839']);
  assert.equal(summary.totalRecipeIds, 2);
  assert.deepEqual(summary.unresolved, []);
  assert.equal(summary.archiveResolution, 'unavailable');
  assert.deepEqual(summary.trustedArchivedRecipeIds, []);
  assert.equal(summary.restoreAuthorized, false);
  assert.equal(result.preview.restoreAvailable, false);
  assert.ok(Object.isFrozen(summary.knownExactRecipeIds));
  assert.ok(!JSON.stringify(summary).includes('PRIVATE-'));
});

test('same IDs in a different version or fingerprint remain unresolved, never replaced with current content or archives', async () => {
  for (const different of [
    { ...catalogue, version: 'older-version' },
    { ...catalogue, fingerprint: 'c'.repeat(64) },
  ]) {
    const input = fixture();
    input.catalogue = different;
    const result = await inspect(input);
    assert.deepEqual(result.preview.referenceSummary.knownExactRecipeIds, []);
    assert.deepEqual(result.preview.referenceSummary.unresolved, [
      { recipeId: '52835', reasons: ['catalogue_mismatch'] },
      { recipeId: '52839', reasons: ['catalogue_mismatch'] },
    ]);
    assert.equal(result.preview.catalogueMatches, false);
    assert.deepEqual(result.preview.unknownRecipeIds, []);
    assert.ok(result.preview.warnings.includes('catalogue_mismatch'));
  }
});

test('missing personal references retain exact IDs with every applicable reason and do not overlap confirmed IDs', async () => {
  const input = fixture();
  input.data.personal!.memberships[0]!.recipeId = '99999';
  input.catalogue = { version: 'unavailable-catalogue', fingerprint: 'd'.repeat(64) };
  const result = await inspect(input);
  const summary = result.preview.referenceSummary;
  assert.equal(summary.totalRecipeIds, 3);
  assert.deepEqual(summary.unresolved.find((entry) => entry.recipeId === '99999')?.reasons, [
    'catalogue_mismatch',
    'recipe_unavailable',
  ]);
  assert.deepEqual(result.preview.unknownRecipeIds, ['99999']);
  assert.equal(result.value.data.personal!.memberships[0]!.recipeId, '99999');
  assert.ok(
    summary.unresolved.every((entry) => !summary.knownExactRecipeIds.includes(entry.recipeId)),
  );
  assert.ok(Object.isFrozen(summary.unresolved[0]!.reasons));
});

test('history is unverified during ordinary inspection even when a core reference to the same recipe is exact', async () => {
  const input = fixture();
  addHistory(input);
  const result = await inspect(input);
  const summary = result.preview.referenceSummary;
  assert.deepEqual(summary.knownExactRecipeIds, ['52839']);
  assert.deepEqual(summary.unresolved, [
    { recipeId: '52835', reasons: ['history_content_unverified'] },
  ]);
  assert.equal(summary.historyEntries, 1);
  assert.equal(summary.historyContentVerification, 'not_checked');
  assert.ok(!JSON.stringify(summary).includes('PRIVATE-'));
  assert.equal(result.value.data.cookingHistory!.entries[0]!.contentFingerprint, 'b'.repeat(64));
});

test('only explicit restore content-check attestation resolves history, and cannot erase catalogue or missing-ID failures', async () => {
  const input = fixture();
  addHistory(input);
  const result = await inspect(input);
  const verified = summarizePortableBackupReferences(result.value, {
    ...options,
    historyContentVerification: 'verified',
  });
  assert.deepEqual(verified.knownExactRecipeIds, ['52835', '52839']);
  assert.deepEqual(verified.unresolved, []);
  assert.equal(verified.restoreAuthorized, false);
  const mismatch = summarizePortableBackupReferences(result.value, {
    ...options,
    historyContentVerification: 'mismatch',
  });
  assert.deepEqual(mismatch.unresolved, [
    { recipeId: '52835', reasons: ['history_content_mismatch'] },
  ]);
  input.data.cookingHistory!.entries[0]!.catalogue = { ...catalogue, fingerprint: 'e'.repeat(64) };
  const changed = await inspect(input);
  const unresolved = summarizePortableBackupReferences(changed.value, {
    currentCatalogue: catalogue,
    knownRecipeIds: new Set(['52839']),
    historyContentVerification: 'verified',
  });
  assert.deepEqual(unresolved.unresolved, [
    { recipeId: '52835', reasons: ['catalogue_mismatch', 'recipe_unavailable'] },
  ]);
});

test('integrity failure produces no reference summary and an empty reference set grants no restore authority', async () => {
  const input = fixture();
  input.data.favourites = [];
  input.data.occurrences = [];
  input.data.personal!.notes = [];
  input.data.personal!.memberships = [];
  const result = await inspect(input);
  assert.equal(result.preview.referenceSummary.totalRecipeIds, 0);
  assert.equal(result.preview.referenceSummary.restoreAuthorized, false);
  assert.equal(result.preview.referenceSummary.archiveResolution, 'unavailable');
  const tampered = JSON.parse(JSON.stringify(result.value));
  tampered.catalogue.version = 'tampered';
  assert.deepEqual(await validatePortableBackup(JSON.stringify(tampered), { ...options, sha256 }), {
    kind: 'invalid',
    reason: 'checksum_mismatch',
  });
});
