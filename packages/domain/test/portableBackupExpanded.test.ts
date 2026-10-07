import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createPortableBackup,
  validatePortableBackup,
  PORTABLE_BACKUP_MAX_BYTES,
} from '../src/portableBackup';
import type { PortableBackupEnvelope, PortableBackupInput } from '../src/portableBackup';

const at = '2026-09-30T12:00:00.000Z';
const catalogue = { version: 'fixture-v1', fingerprint: 'a'.repeat(64) };
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const options = { sha256, currentCatalogue: catalogue, knownRecipeIds: new Set(['52835']) };
function fixture(): PortableBackupInput {
  const collectionId = randomUUID();
  return {
    schemaVersion: 2,
    databaseSchemaVersion: 5,
    createdAt: at,
    catalogue,
    sourceRevision: 4,
    data: {
      favourites: [],
      occurrences: [],
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
            text: '  My private note 🍲\u0000  ',
            deleted: false,
            revision: 1,
            createdAt: at,
            updatedAt: at,
          },
        ],
        collections: [
          {
            collectionId,
            name: 'Weekend',
            deleted: false,
            revision: 3,
            createdAt: at,
            updatedAt: at,
          },
        ],
        memberships: [
          { collectionId, recipeId: '52835', present: true, revision: 3, updatedAt: at },
        ],
        manualItems: [
          {
            kind: 'manual',
            itemId: randomUUID(),
            name: 'Paper towels',
            amountText: 'a few',
            unitText: null,
            category: 'other',
            purchased: true,
            deleted: false,
            revision: 4,
            createdAt: at,
            updatedAt: at,
          },
        ],
      },
    },
  };
}
test('format2 covers personal exact text and honest counts while history is absent by default', async () => {
  const input = fixture();
  const value = await createPortableBackup(input, sha256);
  const result = await validatePortableBackup(JSON.stringify(value), options);
  assert.equal(result.kind, 'ready');
  assert.deepEqual(value.counts.personal, {
    notes: 1,
    noteTombstones: 0,
    collections: 1,
    collectionTombstones: 0,
    memberships: 1,
    removedMemberships: 0,
    manualItems: 1,
    manualTombstones: 0,
    purchasedManualItems: 1,
  });
  assert.equal(value.counts.cookingHistory, undefined);
  assert.equal(value.data.personal!.notes[0]!.text, input.data.personal!.notes[0]!.text);
  assert.equal(Object.isFrozen(value.data.personal!.notes[0]), true);
});
test('format1 cannot carry private collections or new counts and format2 requires a personal-capable schema', async () => {
  const input = fixture();
  await assert.rejects(createPortableBackup({ ...input, schemaVersion: 1 }, sha256));
  await assert.rejects(createPortableBackup({ ...input, databaseSchemaVersion: 4 }, sha256));
  const core = fixture();
  delete core.data.personal;
  core.schemaVersion = 1;
  const legacy = await createPortableBackup(core, sha256);
  assert.equal(
    (
      await validatePortableBackup(
        JSON.stringify({ ...legacy, counts: { ...legacy.counts, cookingHistory: 0 } }),
        options,
      )
    ).kind,
    'invalid',
  );
  assert.equal((await validatePortableBackup(JSON.stringify(legacy), options)).kind, 'ready');
});
test('dangling members, duplicate stable IDs, leaked deleted text, extra fields and incorrect counts reject before hashing', async () => {
  const value = await createPortableBackup(fixture(), sha256);
  const changes: ((v: PortableBackupEnvelope) => void)[] = [
    (v) => {
      v.data.personal!.memberships[0]!.collectionId = randomUUID();
    },
    (v) => {
      v.data.personal!.notes.push({ ...v.data.personal!.notes[0]! });
    },
    (v) => {
      v.data.personal!.notes[0]!.deleted = true;
    },
    (v) => {
      v.data.personal!.collections[0]!.deleted = true;
      v.data.personal!.collections[0]!.name = null;
    },
    (v) => {
      v.data.personal!.manualItems[0]!.deleted = true;
    },
    (v) => {
      (v.data.personal as unknown as Record<string, unknown>).pendingActions = [];
    },
    (v) => {
      v.counts.personal!.purchasedManualItems = 0;
    },
    (v) => {
      v.data.personal!.notes[0]!.noteId = v.data.personal!.notes[0]!.noteId.toUpperCase();
    },
  ];
  let hashes = 0;
  for (const change of changes) {
    const copy = JSON.parse(JSON.stringify(value)) as PortableBackupEnvelope;
    change(copy);
    const result = await validatePortableBackup(JSON.stringify(copy), {
      ...options,
      sha256: async (s) => {
        hashes++;
        return sha256(s);
      },
    });
    assert.equal(result.kind, 'invalid');
  }
  assert.equal(hashes, 0);
});
test('redacted tombstones roundtrip and unknown personal recipes remain whole-file review blockers', async () => {
  const input = fixture(),
    personal = input.data.personal!;
  personal.notes[0]!.deleted = true;
  personal.notes[0]!.text = null;
  personal.collections[0]!.deleted = true;
  personal.collections[0]!.name = null;
  personal.memberships[0]!.present = false;
  personal.manualItems[0] = {
    ...personal.manualItems[0]!,
    deleted: true,
    name: null,
    amountText: null,
    unitText: null,
    category: null,
    purchased: false,
  };
  personal.memberships[0]!.recipeId = '99999';
  const value = await createPortableBackup(input, sha256),
    result = await validatePortableBackup(JSON.stringify(value), options);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') assert.fail();
  assert.deepEqual(result.preview.unknownRecipeIds, ['99999']);
  assert.equal(result.value.data.personal!.memberships[0]!.recipeId, '99999');
  assert.equal(value.counts.personal!.noteTombstones, 1);
  assert.equal(value.counts.personal!.removedMemberships, 1);
  assert.equal(value.counts.personal!.manualTombstones, 1);
});
test('explicit history preserves historical identity and private note but excludes receipt/session capabilities', async () => {
  const input = fixture();
  input.data.cookingHistory = {
    entries: [
      {
        recipeId: '52835',
        catalogue,
        contentFingerprint: 'b'.repeat(64),
        readerVersion: 1,
        eventId: randomUUID(),
        recipeTitle: 'Original title',
        photoKey: '52835',
        cookedOn: '2026-09-29',
        timeZone: 'Asia/Dubai',
        recordedAt: at,
        note: 'History note',
        historyEpoch: 0,
        revision: 1,
      },
    ],
  };
  const value = await createPortableBackup(input, sha256);
  assert.equal(value.counts.cookingHistory, 1);
  assert.equal((await validatePortableBackup(JSON.stringify(value), options)).kind, 'ready');
  for (const field of ['requestFingerprint', 'closedSession', 'operationId']) {
    const copy = JSON.parse(JSON.stringify(value));
    copy.data.cookingHistory.entries[0][field] = 'not exportable';
    assert.equal((await validatePortableBackup(JSON.stringify(copy), options)).kind, 'invalid');
  }
  const unknown = JSON.parse(JSON.stringify(value)) as PortableBackupEnvelope;
  unknown.data.cookingHistory!.entries[0]!.recipeId = '999';
  const checked = await validatePortableBackup(
    JSON.stringify(await createPortableBackup(unknown, sha256)),
    options,
  );
  assert.equal(checked.kind, 'ready');
  if (checked.kind === 'ready') assert.deepEqual(checked.preview.unknownRecipeIds, ['999']);
});
test('expanded payloads obey existing whole-package size and integrity limits', async () => {
  const value = await createPortableBackup(fixture(), sha256);
  const altered = JSON.parse(JSON.stringify(value));
  altered.data.personal.notes[0].text = 'Changed';
  assert.deepEqual(await validatePortableBackup(JSON.stringify(altered), options), {
    kind: 'invalid',
    reason: 'checksum_mismatch',
  });
  assert.deepEqual(
    await validatePortableBackup(' '.repeat(PORTABLE_BACKUP_MAX_BYTES + 1), options),
    { kind: 'invalid', reason: 'too_large' },
  );
});
