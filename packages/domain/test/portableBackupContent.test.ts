import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { RecipeContentRef } from '@cookmate/contracts';
import {
  createPortableContentBackup,
  canonicalPortableContentJson,
  validatePortableContentBackup,
  type PortableContentBackupEnvelope,
  type PortableContentBackupInput,
  type PortableContentHistoryRecord,
  type PortableExactHistoryEntry,
} from '../src/portableBackupContent';
import {
  createPortableBackup,
  validatePortableBackup,
  PortableBackupError,
  PORTABLE_BACKUP_MAX_BYTES,
  type PortableBackupInput,
} from '../src/portableBackup';
import type { CookingHistoryEntry } from '../src/cooking';

const at = '2026-10-01T12:00:00.000Z',
  catalogue = { version: 'fixture-v1', fingerprint: 'a'.repeat(64) };
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
const first: RecipeContentRef = {
  recipeId: '52835',
  revisionId: 'first-exact-revision',
  contentFingerprint: 'b'.repeat(64),
};
const second: RecipeContentRef = {
  recipeId: '52835',
  revisionId: 'second-exact-revision',
  contentFingerprint: 'c'.repeat(64),
};
const legacyOptions = { sha256, currentCatalogue: catalogue, knownRecipeIds: new Set(['52835']) };
test('shared data-only encoder honors smaller exact UTF-8 budgets without executing accessors', () => {
  const value = { note: '🍲\u0000' };
  const canonical = canonicalPortableContentJson(value);
  const bytes = Buffer.byteLength(canonical, 'utf8');
  assert.equal(canonicalPortableContentJson(value, bytes), canonical);
  assert.throws(
    () => canonicalPortableContentJson(value, bytes - 1),
    (error: unknown) => error instanceof PortableBackupError && error.reason === 'too_large',
  );
  for (const budget of [0, -1, 1.5, Infinity, PORTABLE_BACKUP_MAX_BYTES + 1])
    assert.throws(() => canonicalPortableContentJson(value, budget), PortableBackupError);
  let touched = false;
  assert.throws(
    () =>
      canonicalPortableContentJson(
        {
          get note() {
            touched = true;
            return 'secret';
          },
        },
        100,
      ),
    PortableBackupError,
  );
  assert.equal(touched, false);
});
function fixture(): PortableContentBackupInput {
  const ids = [randomUUID(), randomUUID()];
  return {
    schemaVersion: 3,
    databaseSchemaVersion: 7,
    createdAt: at,
    catalogue: { ...catalogue },
    sourceRevision: 4,
    data: {
      favourites: [],
      occurrences: ids.map((occurrenceId, index) => ({
        occurrenceId,
        recipeId: first.recipeId,
        placement: { actualDate: `2026-10-0${index + 1}`, mealKey: 'dinner' as const },
        revision: 1,
        createdAt: at,
        updatedAt: at,
      })),
      shopping: {
        scope: { scopeId: randomUUID(), revision: 1, occurrenceIds: ids },
        projectionRevision: 1,
        projectionStatus: 'current',
        purchaseMarks: [],
      },
      preferences: {
        snapshot: { revision: 0, lastRemovalRevision: null, items: [] },
        removals: [],
      },
      personal: { notes: [], collections: [], memberships: [], manualItems: [] },
      planReferences: ids.map((occurrenceId, index) => ({
        occurrenceId,
        contentRef: { ...(index ? second : first) },
      })),
    },
  };
}
function exactEntry(): PortableExactHistoryEntry {
  return {
    readerVersion: 2,
    recipeId: first.recipeId,
    contentRef: { ...first },
    eventId: randomUUID(),
    recipeTitle: 'Exact archived title',
    photoAssetId: `sha256:${'d'.repeat(64)}`,
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: '  Private note 🍲\0  ',
    historyEpoch: 3,
    revision: 7,
  };
}
function legacyEntry(): CookingHistoryEntry {
  return {
    readerVersion: 1,
    recipeId: first.recipeId,
    catalogue: { ...catalogue },
    contentFingerprint: 'e'.repeat(64),
    eventId: randomUUID(),
    recipeTitle: 'Legacy title',
    photoKey: 'legacy_photo',
    cookedOn: '2026-10-01',
    timeZone: 'Asia/Dubai',
    recordedAt: at,
    note: null,
    historyEpoch: 1,
    revision: 2,
    origin: 'backup',
  };
}
async function checked(value: unknown) {
  const result = await validatePortableContentBackup(JSON.stringify(value), { sha256 });
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result;
}

test('physical source seven keeps its golden bytes; eight round-trips without relabelling or allowing unknown versions', async () => {
  const input = fixture();
  input.data.occurrences = [];
  input.data.planReferences = [];
  input.data.shopping.scope.scopeId = '11111111-1111-4111-8111-111111111111';
  input.data.shopping.scope.occurrenceIds = [];
  const seven = await createPortableContentBackup(input, sha256);
  // Captured from the unmodified database7 codec before adding explicit source8 support.
  assert.equal(
    seven.integrity.digest,
    'ab68e4fd605ce9f4876b4d11ec1569c5d16df2f768c6dded4da1021a7e8a98c2',
  );
  assert.equal(
    await sha256(canonicalPortableContentJson(seven)),
    '117bab8ac56ccdedace0b8d6d462e9c3c37e93e97ed32dcf2d3e7b7177b7a905',
  );
  const eight = await createPortableContentBackup({ ...input, databaseSchemaVersion: 8 }, sha256);
  const result = await checked(eight);
  assert.equal(result.value.databaseSchemaVersion, 8);
  assert.deepEqual(result.value.data, seven.data);
  assert.notEqual(eight.integrity.digest, seven.integrity.digest);
  assert.deepEqual(
    await validatePortableContentBackup(JSON.stringify({ ...eight, databaseSchemaVersion: 7 }), {
      sha256,
    }),
    { kind: 'invalid', reason: 'checksum_mismatch' },
  );
  assert.deepEqual(
    await validatePortableContentBackup(JSON.stringify({ ...eight, databaseSchemaVersion: 9 }), {
      sha256,
    }),
    { kind: 'invalid', reason: 'unsupported_version' },
  );
  assert.deepEqual(await validatePortableBackup(JSON.stringify(eight), legacyOptions), {
    kind: 'invalid',
    reason: 'unsupported_version',
  });
});
async function rejectsInput(value: unknown, reason = 'invalid_structure') {
  let hashes = 0;
  await assert.rejects(
    createPortableContentBackup(value as PortableContentBackupInput, async (text) => {
      hashes++;
      return sha256(text);
    }),
    (error: unknown) => error instanceof PortableBackupError && error.reason === reason,
  );
  assert.equal(hashes, 0);
}

test('two revisions of one recipe remain distinct exact Plan references and inspection grants no restoration trust', async () => {
  const input = fixture(),
    backup = await createPortableContentBackup(input, sha256),
    result = await checked(backup);
  assert.deepEqual(backup.data.planReferences, input.data.planReferences);
  assert.deepEqual(result.preview.exactReferences, [first, second]);
  assert.equal(result.preview.counts.plannedMeals, 2);
  assert.equal(result.preview.counts.selectedMeals, 2);
  assert.equal(result.preview.restoreAvailable, false);
  assert.equal(result.preview.archiveVerification, 'not_performed');
  assert.ok(result.preview.warnings.includes('checksum_is_not_authentication'));
  assert.ok(Object.isFrozen(result.value.data.planReferences[0]!.contentRef));
  assert.ok(Object.isFrozen(result.preview.exactReferences));
  assert.throws(() => {
    (result.value.data.planReferences as unknown as unknown[]).push({});
  }, TypeError);
});

test('legacy exact/unresolved and new exact history preserve original identity, text and origin without invented refs', async () => {
  const input = fixture(),
    legacy = legacyEntry(),
    exact = exactEntry();
  const entries: PortableContentHistoryRecord[] = [
    { kind: 'legacy', entry: legacy, pin: { kind: 'exact', ref: { ...first } } },
    { kind: 'exact', entry: exact },
  ];
  for (const reason of ['catalogue_mismatch', 'content_mismatch', 'recipe_unavailable'] as const)
    entries.push({ kind: 'legacy', entry: legacyEntry(), pin: { kind: 'unresolved', reason } });
  input.data.cookingHistory = { entries };
  const backup = await createPortableContentBackup(input, sha256),
    result = await checked(backup);
  assert.deepEqual(backup.data.cookingHistory, input.data.cookingHistory);
  assert.equal(backup.counts.cookingHistory, 5);
  assert.deepEqual(result.preview.exactReferences, [first, second]);
  assert.equal(result.preview.unresolvedLegacy.length, 3);
  assert.deepEqual(
    result.preview.unresolvedLegacy.map((row) => row.reason),
    ['catalogue_mismatch', 'content_mismatch', 'recipe_unavailable'],
  );
  assert.deepEqual(result.value.data.cookingHistory!.entries[0]!.entry, legacy);
  assert.equal(result.value.data.cookingHistory!.entries[1]!.entry.note, exact.note);
});

test('every occurrence requires exactly one matching reference, including unselected occurrences', async () => {
  for (const alter of [
    (v: PortableContentBackupInput) => {
      v.data.planReferences.pop();
    },
    (v: PortableContentBackupInput) => {
      v.data.planReferences[1] = clone(v.data.planReferences[0]!);
    },
    (v: PortableContentBackupInput) => {
      v.data.planReferences[0]!.occurrenceId = randomUUID();
    },
    (v: PortableContentBackupInput) => {
      v.data.planReferences[0]!.contentRef.recipeId = '999';
    },
    (v: PortableContentBackupInput) => {
      v.data.planReferences[0]!.contentRef.revisionId = '';
    },
  ]) {
    const input = fixture();
    input.data.shopping.scope.occurrenceIds = [];
    alter(input);
    await rejectsInput(input);
  }
});

test('history rejects cross-union duplicate IDs, mismatched references and executable or unsupported fields', async () => {
  const base = fixture();
  base.data.cookingHistory = { entries: [{ kind: 'exact', entry: exactEntry() }] };
  const duplicate = clone(base),
    legacy = legacyEntry();
  legacy.eventId = duplicate.data.cookingHistory!.entries[0]!.entry.eventId;
  duplicate.data.cookingHistory!.entries.push({
    kind: 'legacy',
    entry: legacy,
    pin: { kind: 'unresolved', reason: 'content_mismatch' },
  });
  await rejectsInput(duplicate);
  for (const addition of [
    { closedSession: {} },
    { requestFingerprint: 'a'.repeat(64) },
    { operationId: randomUUID() },
    { origin: 'backup' },
    { readerVersion: 1 },
    { photoAssetId: 'file:///private/path' },
    { timeZone: 'Not/AZone' },
    { revision: 0 },
  ]) {
    const input = clone(base);
    Object.assign(input.data.cookingHistory!.entries[0]!.entry, addition);
    await rejectsInput(input);
  }
  const wrongRef = clone(base);
  (
    wrongRef.data.cookingHistory!.entries[0]!.entry as PortableExactHistoryEntry
  ).contentRef.recipeId = '99';
  await rejectsInput(wrongRef);
  const unresolved = fixture();
  unresolved.data.cookingHistory = {
    entries: [
      {
        kind: 'legacy',
        entry: legacyEntry(),
        pin: { kind: 'unresolved', reason: 'recipe_unavailable' },
      },
    ],
  };
  Object.assign(unresolved.data.cookingHistory.entries[0]!, {
    pin: { kind: 'unresolved', reason: 'guess_latest' },
  });
  await rejectsInput(unresolved);
  const mismatch = fixture();
  mismatch.data.cookingHistory = {
    entries: [
      {
        kind: 'legacy',
        entry: legacyEntry(),
        pin: { kind: 'exact', ref: { ...first, recipeId: '99' } },
      },
    ],
  };
  await rejectsInput(mismatch);
});

test('omitted history and explicitly included empty history remain distinct', async () => {
  const absent = await createPortableContentBackup(fixture(), sha256),
    included = fixture();
  included.data.cookingHistory = { entries: [] };
  const empty = await createPortableContentBackup(included, sha256);
  assert.equal(Object.hasOwn(absent.data, 'cookingHistory'), false);
  assert.equal(Object.hasOwn(absent.counts, 'cookingHistory'), false);
  assert.equal(empty.counts.cookingHistory, 0);
  assert.deepEqual(empty.data.cookingHistory, { entries: [] });
  await checked(absent);
  await checked(empty);
});

test('unknown versions and authority fields fail before hashing, and old readers cannot silently downgrade format3', async () => {
  const backup = await createPortableContentBackup(fixture(), sha256);
  let hashes = 0;
  for (const addition of [
    { schemaVersion: 4 },
    { databaseSchemaVersion: 9 },
    { schemaVersion: 2 },
    { credentials: { token: 'synthetic' } },
    { sessions: [] },
    { receipt: {} },
  ]) {
    const result = await validatePortableContentBackup(JSON.stringify({ ...backup, ...addition }), {
      sha256: async (text) => {
        hashes++;
        return sha256(text);
      },
    });
    assert.equal(result.kind, 'invalid');
  }
  assert.equal(hashes, 0);
  assert.deepEqual(await validatePortableBackup(JSON.stringify(backup), legacyOptions), {
    kind: 'invalid',
    reason: 'unsupported_version',
  });
  assert.deepEqual(
    await validatePortableBackup(
      JSON.stringify({ ...backup, schemaVersion: 2, databaseSchemaVersion: 6 }),
      legacyOptions,
    ),
    { kind: 'invalid', reason: 'invalid_structure' },
  );
  await rejectsInput({ ...fixture(), schemaVersion: 2 });
  await rejectsInput({ ...fixture(), data: { ...fixture().data, conversation: [] } });
});

test('checksum handles key order/whitespace but detects changed exact references and dishonest counts', async () => {
  const backup = await createPortableContentBackup(fixture(), sha256);
  const whitespace = await validatePortableContentBackup(
    JSON.stringify(Object.fromEntries(Object.entries(backup).reverse()), null, 2),
    { sha256 },
  );
  assert.equal(whitespace.kind, 'ready');
  const changed = clone(backup) as PortableContentBackupEnvelope;
  changed.data.planReferences[0]!.contentRef.contentFingerprint = 'f'.repeat(64);
  assert.deepEqual(await validatePortableContentBackup(JSON.stringify(changed), { sha256 }), {
    kind: 'invalid',
    reason: 'checksum_mismatch',
  });
  changed.counts.plannedMeals++;
  assert.deepEqual(await validatePortableContentBackup(JSON.stringify(changed), { sha256 }), {
    kind: 'invalid',
    reason: 'invalid_structure',
  });
  // A newly checksummed untrusted identity is still only an inventory claim, never archive proof.
  const untrusted = fixture();
  untrusted.data.planReferences[0]!.contentRef.contentFingerprint = 'f'.repeat(64);
  assert.equal(
    (await checked(await createPortableContentBackup(untrusted, sha256))).preview
      .archiveVerification,
    'not_performed',
  );
});

test('data-only admission rejects getters, toJSON, symbols, hidden fields, cycles, sparse arrays and nonplain objects without invoking them', async () => {
  let invoked = 0;
  const getter = fixture();
  Object.defineProperty(getter, 'data', {
    enumerable: true,
    get() {
      invoked++;
      throw new Error('Getter ran');
    },
  });
  await rejectsInput(getter);
  const toJSON = fixture();
  Object.assign(toJSON, {
    toJSON() {
      invoked++;
      throw new Error('toJSON ran');
    },
  });
  await rejectsInput(toJSON);
  const hidden = fixture();
  Object.defineProperty(hidden.data, 'private', { value: 1 });
  await rejectsInput(hidden);
  const symbol = fixture();
  Object.defineProperty(symbol, Symbol('private'), { value: true });
  await rejectsInput(symbol);
  const cyclic = fixture();
  Object.assign(cyclic.data, { cycle: cyclic });
  await rejectsInput(cyclic);
  const sparse = fixture();
  delete sparse.data.planReferences[0];
  await rejectsInput(sparse);
  const custom = fixture();
  Object.setPrototypeOf(custom.data, { inherited: true });
  await rejectsInput(custom);
  const negativeZero = fixture();
  negativeZero.sourceRevision = -0;
  await rejectsInput(negativeZero);
  assert.equal(invoked, 0);
});

test('ownership is completed before hashing so caller mutation cannot alter admitted bytes', async () => {
  const input = fixture(),
    before = clone(input);
  let hashed = '';
  const backup = await createPortableContentBackup(input, async (text) => {
    hashed = text;
    input.data.planReferences.length = 0;
    input.data.occurrences[0]!.recipeId = '99';
    await Promise.resolve();
    return sha256(text);
  });
  assert.deepEqual(backup.data, before.data);
  assert.ok(hashed.includes(first.revisionId));
  await checked(backup);
  for (const failing of [
    async () => {
      throw new Error('Unavailable');
    },
    async () => 'bad-digest',
  ]) {
    await assert.rejects(
      createPortableContentBackup(fixture(), failing),
      (error: unknown) =>
        error instanceof PortableBackupError && error.reason === 'integrity_unavailable',
    );
    assert.deepEqual(
      await validatePortableContentBackup(JSON.stringify(backup), { sha256: failing }),
      { kind: 'invalid', reason: 'integrity_unavailable' },
    );
  }
});

test('UTF8/escaped-byte, depth and node limits reject whole input before copying oversized strings or hashing', async () => {
  await rejectsInput({ ...fixture(), extra: 'x'.repeat(PORTABLE_BACKUP_MAX_BYTES) }, 'too_large');
  await rejectsInput({ ...fixture(), extra: '界'.repeat(3 * 1024 * 1024) }, 'too_large');
  await rejectsInput({ ...fixture(), extra: '\0'.repeat(2 * 1024 * 1024) }, 'too_large');
  await rejectsInput({ ...fixture(), extra: new Array(500_001) }, 'too_large');
  let deep: unknown = null;
  for (let i = 0; i < 40; i++) deep = [deep];
  await rejectsInput({ ...fixture(), extra: deep }, 'too_large');
  let hashes = 0;
  const guard = {
    sha256: async (text: string) => {
      hashes++;
      return sha256(text);
    },
  };
  assert.deepEqual(
    await validatePortableContentBackup('"' + '界'.repeat(3 * 1024 * 1024) + '"', guard),
    { kind: 'invalid', reason: 'too_large' },
  );
  assert.deepEqual(await validatePortableContentBackup('{', guard), {
    kind: 'invalid',
    reason: 'invalid_json',
  });
  assert.equal(hashes, 0);
});

test('legacy format1/2 golden canonical input and serialized envelope remain unchanged', async () => {
  const scopeId = '11111111-1111-4111-8111-111111111111';
  const core = {
    favourites: [],
    occurrences: [],
    shopping: {
      scope: { scopeId, revision: 0, occurrenceIds: [] },
      projectionRevision: 0,
      projectionStatus: 'current' as const,
      purchaseMarks: [],
    },
    preferences: { snapshot: { revision: 0, lastRemovalRevision: null, items: [] }, removals: [] },
  };
  const personal = { notes: [], collections: [], memberships: [], manualItems: [] };
  const coreCounts = {
    favourites: 0,
    tombstones: 0,
    plannedMeals: 0,
    selectedMeals: 0,
    purchaseMarks: 0,
    purchasedItems: 0,
    preferences: 0,
    preferenceRemovals: 0,
  };
  const personalCounts = {
    notes: 0,
    noteTombstones: 0,
    collections: 0,
    collectionTombstones: 0,
    memberships: 0,
    removedMemberships: 0,
    manualItems: 0,
    manualTombstones: 0,
    purchasedManualItems: 0,
  };
  const canonicalCore = '"favourites":[],"occurrences":[],';
  const canonicalPersonal =
    '"personal":{"collections":[],"manualItems":[],"memberships":[],"notes":[]},';
  const canonicalTail =
    '"preferences":{"removals":[],"snapshot":{"items":[],"lastRemovalRevision":null,"revision":0}},"shopping":{"projectionRevision":0,"projectionStatus":"current","purchaseMarks":[],"scope":{"occurrenceIds":[],"revision":0,"scopeId":"11111111-1111-4111-8111-111111111111"}}';
  const canonicalCounts = '"favourites":0,';
  const canonicalPersonalCounts =
    '"personal":{"collectionTombstones":0,"collections":0,"manualItems":0,"manualTombstones":0,"memberships":0,"noteTombstones":0,"notes":0,"purchasedManualItems":0,"removedMemberships":0},';
  const canonicalCountsTail =
    '"plannedMeals":0,"preferenceRemovals":0,"preferences":0,"purchaseMarks":0,"purchasedItems":0,"selectedMeals":0,"tombstones":0';
  for (const version of [1, 2] as const) {
    const input: PortableBackupInput = {
      schemaVersion: version,
      databaseSchemaVersion: 6,
      createdAt: at,
      catalogue,
      sourceRevision: 0,
      data: version === 1 ? core : { ...core, personal },
    };
    const expectedCanonical = `{"catalogue":{"fingerprint":"${'a'.repeat(64)}","version":"fixture-v1"},"counts":{${canonicalCounts}${version === 2 ? canonicalPersonalCounts : ''}${canonicalCountsTail}},"createdAt":"2026-10-01T12:00:00.000Z","data":{${canonicalCore}${version === 2 ? canonicalPersonal : ''}${canonicalTail}},"databaseSchemaVersion":6,"format":"cookmate-local-backup","schemaVersion":${version},"sourceRevision":0}`;
    const backup = await createPortableBackup(input, async (value) => {
      assert.equal(value, expectedCanonical);
      return sha256(value);
    });
    const expected = {
      ...input,
      format: 'cookmate-local-backup',
      counts: version === 1 ? coreCounts : { ...coreCounts, personal: personalCounts },
      integrity: { algorithm: 'sha256', digest: await sha256(expectedCanonical) },
    };
    assert.equal(JSON.stringify(backup), JSON.stringify(expected));
    assert.equal(
      (await validatePortableBackup(JSON.stringify(backup), legacyOptions)).kind,
      'ready',
    );
  }
});
