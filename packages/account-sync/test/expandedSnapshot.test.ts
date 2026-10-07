import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPortableBackup } from '@cookmate/domain';
import type { PortableBackupInput } from '@cookmate/domain';
import {
  AccountSnapshotError,
  accountSnapshotFromBackup,
  canonicalAccountSnapshot,
  canonicalAccountHistory,
  normalizeAccountSnapshot,
  parseAccountSnapshot,
  validateAccountSnapshot,
  validateAccountHistory,
  validateAccountCookingHistoryEntry,
} from '../src';
import { catalogue, id, options, snapshot, timestamp } from './fixtures';
import {
  expandedSnapshot,
  note,
  collection,
  membership,
  manual,
  history,
} from './expandedFixtures';

test('v1 canonical bytes remain unchanged and v2 needs its explicit personal scope', () => {
  assert.equal(
    canonicalAccountSnapshot(snapshot()),
    `{"appPreferences":{"locale":"system","motion":"system","theme":"system"},"catalogue":{"fingerprint":"${'a'.repeat(64)}","version":"test-catalogue"},"favourites":[],"format":"cookmate-account-snapshot","plan":[],"preferences":[],"profile":{"displayName":null},"schemaVersion":1,"shopping":{"purchaseMarks":[],"selectedOccurrenceIds":[]}}`,
  );
  assert.equal(validateAccountSnapshot({ ...snapshot(), schemaVersion: 2 }), false);
  assert.equal(validateAccountSnapshot({ ...expandedSnapshot(), schemaVersion: 1 }), false);
  assert.ok(validateAccountSnapshot(expandedSnapshot()));
});

test('v2 canonical ordering covers every personal array and immutable history without mutation', () => {
  const value = expandedSnapshot();
  value.personal.notes = [note(9, '52835'), note()];
  value.personal.collections = [collection(9), collection()];
  value.personal.memberships = [membership(9), membership()];
  value.personal.manualItems = [manual(9), manual()];
  value.cookingHistory = { entries: [history(9), history()], removedEventIds: [id(20), id(19)] };
  const reverse = structuredClone(value);
  for (const rows of Object.values(reverse.personal)) rows.reverse();
  reverse.cookingHistory!.entries.reverse();
  reverse.cookingHistory!.removedEventIds.reverse();
  assert.equal(canonicalAccountSnapshot(value), canonicalAccountSnapshot(reverse));
  assert.deepEqual(
    parseAccountSnapshot(canonicalAccountSnapshot(value)),
    normalizeAccountSnapshot(value),
  );
  assert.equal(value.personal.notes[0]!.recipeId, '52835');
});

test('strict v2 allowlist rejects clocks, credentials, receipts, execution state and unsafe descriptors', () => {
  const value = expandedSnapshot();
  value.personal.notes = [note()];
  value.personal.collections = [collection()];
  value.personal.memberships = [membership()];
  value.personal.manualItems = [manual()];
  value.cookingHistory = { entries: [history()], removedEventIds: [] };
  for (const rows of [...Object.values(value.personal), value.cookingHistory.entries]) {
    for (const key of ['revision', 'historyEpoch', 'operationId', 'receipt', 'apiKey']) {
      const candidate = structuredClone(value);
      const target =
        rows === value.cookingHistory.entries
          ? candidate.cookingHistory!.entries[0]!
          : candidate.personal[
              Object.entries(value.personal).find(
                ([, list]) => list === rows,
              )![0] as keyof typeof value.personal
            ][0]!;
      Object.assign(target, { [key]: 'forbidden' });
      assert.equal(validateAccountSnapshot(candidate), false, key);
    }
  }
  let reads = 0;
  Object.defineProperty(value.personal.notes[0], 'text', {
    enumerable: true,
    get() {
      reads++;
      return 'hidden';
    },
  });
  assert.equal(validateAccountSnapshot(value), false);
  assert.equal(reads, 0);
  const sparse = expandedSnapshot();
  sparse.personal.notes = new Array(1);
  assert.equal(validateAccountSnapshot(sparse), false);
  const symbol = expandedSnapshot();
  Object.defineProperty(symbol.personal, Symbol('secret'), { value: 1 });
  assert.equal(validateAccountSnapshot(symbol), false);
});

test('redacted tombstones and relationships are enforced without deriving quantities or units', () => {
  const value = expandedSnapshot();
  value.personal.notes = [{ ...note(), deleted: true, text: null }];
  value.personal.collections = [{ ...collection(), deleted: true, name: null }];
  value.personal.memberships = [{ ...membership(), present: false }];
  value.personal.manualItems = [
    { ...manual(), deleted: true, name: null, amountText: null, unitText: null, category: null },
  ];
  assert.ok(validateAccountSnapshot(value));
  value.personal.notes[0]!.text = 'Must be redacted';
  assert.equal(validateAccountSnapshot(value), false);
  value.personal.notes[0]!.text = null;
  value.personal.memberships[0]!.present = true;
  assert.equal(validateAccountSnapshot(value), false);
  value.personal.memberships[0]!.present = false;
  value.personal.manualItems[0]!.purchased = true;
  assert.equal(validateAccountSnapshot(value), false);
  const duplicate = expandedSnapshot();
  duplicate.personal.notes = [note(), note(9)];
  assert.equal(validateAccountSnapshot(duplicate), false, 'one note per recipe');
  duplicate.personal.notes = [note(), note(1, '52835')];
  assert.equal(validateAccountSnapshot(duplicate), false, 'unique note identity');
});

test('history has strict immutable data fields and disjoint bounded redacted removal identities', () => {
  const value = expandedSnapshot();
  value.cookingHistory = { entries: [history()], removedEventIds: [] };
  assert.ok(validateAccountSnapshot(value));
  value.cookingHistory.removedEventIds = [id(4)];
  assert.equal(validateAccountSnapshot(value), false);
  value.cookingHistory.removedEventIds = [id(5), id(5)];
  assert.equal(validateAccountSnapshot(value), false);
  value.cookingHistory.removedEventIds = [];
  value.cookingHistory.entries[0]!.timeZone = 'Not/A_Zone';
  assert.equal(validateAccountSnapshot(value), false);
  value.cookingHistory.entries[0]!.timeZone = 'Asia/Dubai';
  value.cookingHistory.entries[0]!.note = 'a'.repeat(2001);
  assert.equal(validateAccountSnapshot(value), false);
  value.cookingHistory.entries = [];
  value.cookingHistory.removedEventIds = Array.from({ length: 10001 }, (_, i) => id(i));
  assert.equal(validateAccountSnapshot(value), false);
});

test('history-only projection helpers share strict entry validation and stable nonmutating canonical bytes', () => {
  const value = { entries: [history(9), history()], removedEventIds: [id(20), id(19)] };
  assert.ok(validateAccountHistory(value));
  assert.ok(validateAccountCookingHistoryEntry(value.entries[0]));
  assert.equal(validateAccountCookingHistoryEntry({ ...history(), historyEpoch: 0 }), false);
  const canonical = canonicalAccountHistory(value);
  assert.equal(
    canonical,
    canonicalAccountHistory({
      entries: [...value.entries].reverse(),
      removedEventIds: [...value.removedEventIds].reverse(),
    }),
  );
  assert.deepEqual(
    JSON.parse(canonical).entries.map((item: { eventId: string }) => item.eventId),
    [id(4), id(9)],
  );
  assert.equal(value.entries[0]!.eventId, id(9));
  assert.throws(
    () => canonicalAccountHistory({ ...value, removedEventIds: [id(4)] }),
    AccountSnapshotError,
  );
});

test('v2 shares local personal character/active-count bounds and the total account byte cap', () => {
  const value = expandedSnapshot();
  value.personal.notes = [note(1, '52819', '🍋'.repeat(4000))];
  assert.ok(validateAccountSnapshot(value), 'personal limits count Unicode code points');
  value.personal.notes[0]!.text += 'a';
  assert.equal(validateAccountSnapshot(value), false);
  value.personal.notes = [];
  value.personal.collections = Array.from({ length: 101 }, (_, i) => collection(i));
  assert.equal(validateAccountSnapshot(value), false);
  value.personal.collections = [];
  value.personal.notes = Array.from({ length: 200 }, (_, i) =>
    note(i, String(i + 1), '🍋'.repeat(4000)),
  );
  assert.throws(
    () => canonicalAccountSnapshot(value),
    (error) => error instanceof AccountSnapshotError && error.reason === 'too_large',
  );
});

function backupInput(): PortableBackupInput {
  return {
    schemaVersion: 2,
    databaseSchemaVersion: 5,
    createdAt: timestamp,
    catalogue,
    sourceRevision: 2,
    data: {
      favourites: [],
      occurrences: [],
      shopping: {
        scope: { scopeId: id(30), revision: 0, occurrenceIds: [] },
        projectionRevision: 0,
        projectionStatus: 'current',
        purchaseMarks: [],
      },
      preferences: {
        snapshot: { revision: 0, lastRemovalRevision: null, items: [] },
        removals: [],
      },
      personal: {
        notes: [{ ...note(), revision: 1 }],
        collections: [{ ...collection(), revision: 1 }],
        memberships: [{ ...membership(), revision: 1 }],
        manualItems: [{ ...manual(), revision: 1 }],
      },
      cookingHistory: { entries: [{ ...history(), revision: 1, historyEpoch: 3 }] },
    },
  };
}

test('portable adapter remains v1 by default; expanded and history projection require explicit options', async () => {
  const backup = await createPortableBackup(backupInput(), async (text) =>
    createHash('sha256').update(text).digest('hex'),
  );
  const legacy = accountSnapshotFromBackup(backup, options);
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(Object.hasOwn(legacy, 'personal'), false);
  const personal = accountSnapshotFromBackup(backup, options, {
    schemaVersion: 2,
    includeCookingHistory: false,
  });
  assert.equal(personal.schemaVersion, 2);
  assert.equal(personal.personal.notes[0]!.text, 'Less salt');
  assert.equal(Object.hasOwn(personal, 'cookingHistory'), false);
  const expanded = accountSnapshotFromBackup(backup, options, {
    schemaVersion: 2,
    includeCookingHistory: true,
  });
  assert.deepEqual(expanded.cookingHistory, { entries: [history()], removedEventIds: [] });
  assert.equal(canonicalAccountSnapshot(expanded).includes('revision'), false);
  assert.equal(canonicalAccountSnapshot(expanded).includes('Epoch'), false);
  const removed = accountSnapshotFromBackup(backup, options, {
    schemaVersion: 2,
    includeCookingHistory: true,
    removedHistoryEventIds: [id(4)],
  });
  assert.deepEqual(removed.cookingHistory, { entries: [], removedEventIds: [id(4)] });
  assert.throws(
    () =>
      accountSnapshotFromBackup(backup, options, {
        schemaVersion: 2,
        includeCookingHistory: false,
        removedHistoryEventIds: [id(4)],
      }),
    AccountSnapshotError,
  );
  const old = { ...structuredClone(backup), schemaVersion: 1 as const };
  assert.throws(
    () =>
      accountSnapshotFromBackup(old, options, { schemaVersion: 2, includeCookingHistory: false }),
    AccountSnapshotError,
  );
});
