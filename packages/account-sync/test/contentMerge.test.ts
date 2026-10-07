import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountSnapshotError, type AccountMergeResolution } from '../src/types';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
  type AccountContentHistoryRecord,
} from '../src/contentSnapshot';
import {
  mergeAccountContentSnapshots,
  type AccountContentMergeInput,
  type AccountContentMergeResult,
  type AccountContentConflictValue,
} from '../src/contentMerge';
import { id, occurrence, preference, purchase, timestamp, later } from './fixtures';
import {
  expandedSnapshot,
  note,
  manual,
  collection,
  membership,
  history,
} from './expandedFixtures';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ref = (version = 'a', recipeId = '52819') => ({
  recipeId,
  revisionId: `fixture-${version}`,
  contentFingerprint: version.repeat(64),
});
const snapshot = (): AccountContentSnapshot => {
  const { cookingHistory: _history, ...core } = expandedSnapshot();
  return { ...core, schemaVersion: 3, planReferences: [] };
};
function plan(value: AccountContentSnapshot, n: number, version = 'a', date = '2026-09-30') {
  value.plan.push(occurrence(n, '52819', date));
  value.planReferences.push({ occurrenceId: id(n), contentRef: ref(version) });
}
const input = (
  base = snapshot(),
  local = clone(base),
  account = clone(base),
): AccountContentMergeInput => ({
  base,
  local,
  account,
  contentScope: { schemaVersion: 3, historyIncluded: false },
});
function merged(value: AccountContentMergeInput) {
  const result = mergeAccountContentSnapshots(value);
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged') assert.fail();
  return result;
}
function conflicts(value: AccountContentMergeResult) {
  assert.equal(value.status, 'needs_review');
  if (value.status !== 'needs_review') assert.fail();
  assert.equal('snapshot' in value, false);
  return value.conflicts;
}
function resolve(value: AccountContentMergeInput, choice: AccountMergeResolution) {
  return merged({
    ...value,
    resolutions: Object.fromEntries(
      conflicts(mergeAccountContentSnapshots(value)).map((item) => [item.id, choice]),
    ),
  });
}
function exactHistory(n: number, version = 'a'): AccountContentHistoryRecord {
  return {
    kind: 'exact',
    entry: {
      readerVersion: 2,
      recipeId: '52819',
      contentRef: ref(version),
      eventId: id(n),
      recipeTitle: 'Exact authored recipe',
      photoAssetId: null,
      cookedOn: '2026-09-30',
      timeZone: 'Asia/Dubai',
      recordedAt: timestamp,
      note: ' Raw\n🍲 ',
    },
  };
}
function legacyHistory(n: number): AccountContentHistoryRecord {
  return {
    kind: 'legacy',
    entry: history(n),
    pin: { kind: 'unresolved', reason: 'content_mismatch' },
  };
}
function historyInput(): AccountContentMergeInput {
  const value = input();
  value.contentScope.historyIncluded = true;
  value.base.cookingHistory = { entries: [], removedEventIds: [] };
  value.local.cookingHistory = { entries: [], removedEventIds: [] };
  value.account.cookingHistory = { entries: [], removedEventIds: [] };
  return value;
}
function reason(work: () => unknown, expected: string) {
  assert.throws(
    work,
    (error: unknown) => error instanceof AccountSnapshotError && error.reason === expected,
  );
}

test('two clients converge with distinct exact plan versions and independent personal changes, without mutating input', () => {
  const value = input();
  plan(value.local, 1, 'a');
  plan(value.account, 2, 'b', '2026-10-01');
  value.local.shopping.selectedOccurrenceIds = [id(1)];
  value.account.shopping.selectedOccurrenceIds = [id(2)];
  value.local.personal.notes = [note()];
  value.account.personal.manualItems = [manual()];
  const before = clone(value),
    result = merged(value).snapshot;
  assert.equal(result.plan.length, 2);
  assert.deepEqual(
    result.planReferences.map((row) => row.contentRef),
    [ref('a'), ref('b')],
  );
  assert.deepEqual(result.shopping.selectedOccurrenceIds, [id(1), id(2)]);
  assert.equal(result.personal.notes.length, 1);
  assert.equal(result.personal.manualItems.length, 1);
  assert.equal(
    canonicalAccountContentSnapshot(result),
    canonicalAccountContentSnapshot(
      merged({ ...value, local: value.account, account: value.local }).snapshot,
    ),
  );
  const settled = clone(result) as AccountContentSnapshot;
  assert.equal(
    canonicalAccountContentSnapshot(result),
    canonicalAccountContentSnapshot(merged(input(settled)).snapshot),
  );
  assert.deepEqual(value, before);
  assert.ok(Object.isFrozen(result.planReferences[0]!.contentRef));
});
test('a one-sided revision change follows its exact occurrence while timestamp metadata is not a conflict clock', () => {
  const base = snapshot();
  plan(base, 1);
  const value = input(base);
  value.local.planReferences[0]!.contentRef = ref('b');
  value.account.plan[0]!.updatedAt = later;
  assert.deepEqual(merged(value).snapshot.planReferences[0]!.contentRef, ref('b'));
  const opposite = merged({ ...value, local: value.account, account: value.local }).snapshot;
  assert.deepEqual(opposite.planReferences[0]!.contentRef, ref('b'));
});
test('same identity content conflicts expose full typed references and reject decisions after evidence changes', () => {
  const base = snapshot();
  plan(base, 1);
  base.shopping.selectedOccurrenceIds = [id(1)];
  const value = input(base);
  value.local.planReferences[0]!.contentRef = ref('b');
  value.account.planReferences[0]!.contentRef = ref('c');
  value.account.plan[0]!.placement.actualDate = '2026-10-03';
  const review = conflicts(mergeAccountContentSnapshots(value));
  assert.equal(review[0]!.kind, 'occurrence_edit');
  function fullReference(candidate: AccountContentConflictValue) {
    assert.ok(
      candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        'occurrenceId' in candidate,
    );
    if (
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      'occurrenceId' in candidate
    )
      return candidate.contentRef;
    assert.fail();
  }
  assert.deepEqual(fullReference(review[0]!.local), ref('b'));
  assert.ok(review[0]!.id.includes(ref('c').contentFingerprint));
  for (const choice of ['local', 'account'] as const) {
    const result = resolve(value, choice).snapshot;
    assert.deepEqual(result.planReferences[0]!.contentRef, ref(choice === 'local' ? 'b' : 'c'));
    assert.equal(
      result.plan[0]!.placement.actualDate,
      choice === 'local' ? '2026-09-30' : '2026-10-03',
    );
    assert.deepEqual(result.shopping.selectedOccurrenceIds, [id(1)]);
  }
  const resolutions = { [review[0]!.id]: 'local' as const };
  value.local.planReferences[0]!.contentRef = ref('d');
  reason(() => mergeAccountContentSnapshots({ ...value, resolutions }), 'invalid_resolution');
});
test('same recipe at the same slot but different exact revisions requires a choice, never deduplication', () => {
  const value = input();
  plan(value.local, 1, 'a');
  plan(value.account, 2, 'b');
  value.local.shopping.selectedOccurrenceIds = [id(1)];
  value.account.shopping.selectedOccurrenceIds = [id(2)];
  const review = conflicts(mergeAccountContentSnapshots(value));
  assert.equal(review[0]!.kind, 'slot_collision');
  for (const choice of ['local', 'account'] as const) {
    const result = resolve(value, choice);
    const expected = choice === 'local' ? 1 : 2;
    assert.equal(result.snapshot.plan[0]!.occurrenceId, id(expected));
    assert.deepEqual(result.snapshot.shopping.selectedOccurrenceIds, [id(expected)]);
    assert.deepEqual(
      result.snapshot.planReferences[0]!.contentRef,
      ref(choice === 'local' ? 'a' : 'b'),
    );
    assert.equal(
      result.notices.some((notice) => notice.kind === 'deduplicated_occurrence'),
      false,
    );
  }
});
test('identical new exact versions deduplicate deterministically and remap Shopping selection', () => {
  const value = input();
  plan(value.local, 2);
  plan(value.account, 1);
  value.local.shopping.selectedOccurrenceIds = [id(2)];
  const result = merged(value);
  assert.deepEqual(
    result.snapshot.plan.map((row) => row.occurrenceId),
    [id(1)],
  );
  assert.deepEqual(result.snapshot.shopping.selectedOccurrenceIds, [id(1)]);
  assert.deepEqual(result.notices, [
    { kind: 'deduplicated_occurrence', fromId: id(2), toId: id(1) },
  ]);
  assert.equal(
    canonicalAccountContentSnapshot(result.snapshot),
    canonicalAccountContentSnapshot(
      merged({ ...value, local: value.account, account: value.local }).snapshot,
    ),
  );
});
test('slot collision choice preserves affected identities at their other dates with matching full refs', () => {
  const base = snapshot();
  plan(base, 1, 'a');
  plan(base, 2, 'b', '2026-10-01');
  const value = input(base);
  value.local.plan[0]!.placement.actualDate = '2026-10-02';
  value.account.plan[1]!.placement.actualDate = '2026-10-02';
  value.account.shopping.selectedOccurrenceIds = [id(1), id(2)];
  assert.equal(conflicts(mergeAccountContentSnapshots(value))[0]!.kind, 'slot_collision');
  for (const choice of ['local', 'account'] as const) {
    const result = resolve(value, choice).snapshot;
    assert.equal(result.plan.length, 2);
    assert.deepEqual(
      result.plan.map((row) => row.placement.actualDate),
      value[choice].plan.map((row) => row.placement.actualDate),
    );
    assert.deepEqual(result.planReferences, base.planReferences);
    assert.deepEqual(result.shopping.selectedOccurrenceIds, [id(1), id(2)]);
  }
});
test('base-dependent plan deletion still wins over unchanged state but exact-version edits need separate review', () => {
  const base = snapshot();
  plan(base, 1);
  base.shopping.selectedOccurrenceIds = [id(1)];
  const value = input(base);
  value.local.plan = [];
  value.local.planReferences = [];
  value.local.shopping.selectedOccurrenceIds = [];
  value.account.plan[0]!.updatedAt = later;
  assert.deepEqual(merged(value).snapshot.plan, []);
  value.account.planReferences[0]!.contentRef = ref('b');
  assert.equal(conflicts(mergeAccountContentSnapshots(value))[0]!.kind, 'delete_edit');
  assert.deepEqual(resolve(value, 'local').snapshot.planReferences, []);
  assert.deepEqual(resolve(value, 'account').snapshot.planReferences[0]!.contentRef, ref('b'));
});
test('identity conflicts are resolved before inspecting slots, so provisional old rows do not manufacture collisions', () => {
  const base = snapshot();
  plan(base, 1);
  plan(base, 2, 'b', '2026-10-01');
  const value = input(base);
  value.local.plan[0]!.placement.actualDate = '2026-10-02';
  value.local.planReferences[0]!.contentRef = ref('c');
  value.account.plan[0]!.placement.actualDate = '2026-10-03';
  value.account.planReferences[0]!.contentRef = ref('d');
  value.account.plan[1]!.placement.actualDate = '2026-09-30';
  assert.deepEqual(
    conflicts(mergeAccountContentSnapshots(value)).map((row) => row.kind),
    ['occurrence_edit'],
  );
  assert.equal(resolve(value, 'local').snapshot.plan.length, 2);
  assert.equal(resolve(value, 'account').snapshot.plan.length, 2);
});
test('purchase demand conflicts need a choice and purchased output explicitly requires exact reprojection', () => {
  const value = input();
  value.base.shopping.purchaseMarks = [purchase()];
  value.local.shopping.purchaseMarks = [purchase(true)];
  value.account.shopping.purchaseMarks = [
    { ...purchase(), demandFingerprint: 'd'.repeat(64), changed: true },
  ];
  assert.equal(conflicts(mergeAccountContentSnapshots(value))[0]!.kind, 'purchase_state');
  const local = resolve(value, 'local');
  assert.deepEqual(local.snapshot.shopping.purchaseMarks, value.local.shopping.purchaseMarks);
  assert.deepEqual(local.notices, [
    {
      kind: 'purchase_requires_reprojection',
      fromId: purchase().groupKey,
      toId: purchase().groupKey,
    },
  ]);
  assert.deepEqual(
    resolve(value, 'account').snapshot.shopping.purchaseMarks,
    value.account.shopping.purchaseMarks,
  );
});
test('personal known removals keep existing review semantics in both directions and missing rows do not erase tombstones', () => {
  const base = snapshot();
  base.personal.notes = [{ ...note(), deleted: true, text: null }];
  base.personal.manualItems = [
    { ...manual(), deleted: true, name: null, amountText: null, unitText: null, category: null },
  ];
  const value = input(base);
  value.account.personal.notes = [note()];
  value.account.personal.manualItems = [manual()];
  value.reviewPersonalRemovals = true;
  assert.deepEqual(
    conflicts(mergeAccountContentSnapshots(value)).map((row) => row.kind),
    ['delete_edit', 'delete_edit'],
  );
  assert.deepEqual(resolve(value, 'local').snapshot.personal, base.personal);
  assert.deepEqual(resolve(value, 'account').snapshot.personal, value.account.personal);
  const reversed = { ...value, local: value.account, account: value.local };
  assert.deepEqual(resolve(reversed, 'account').snapshot.personal, base.personal);
  const absent = input(base, snapshot(), clone(base));
  assert.deepEqual(merged(absent).snapshot.personal, base.personal);
});
test('collection removal versus member edits remains one subtree review without duplicate row conflicts', () => {
  const base = snapshot();
  base.personal.collections = [collection()];
  base.personal.memberships = [membership()];
  const value = input(base);
  value.local.personal.collections = [{ ...collection(), deleted: true, name: null }];
  value.local.personal.memberships = [{ ...membership(), present: false }];
  value.account.personal.memberships.push(membership(2, '52835'));
  const review = conflicts(mergeAccountContentSnapshots(value));
  assert.deepEqual(
    review.map((row) => row.kind),
    ['collection_subtree'],
  );
  assert.equal(resolve(value, 'account').snapshot.personal.memberships.length, 2);
  assert.equal(resolve(value, 'local').snapshot.personal.memberships[0]!.present, false);
});
test('mixed immutable history converges by event identity and unioned removals suppress old replicas', () => {
  const value = historyInput();
  value.base.cookingHistory!.entries = [exactHistory(10)];
  value.local.cookingHistory!.entries = [legacyHistory(11)];
  value.local.cookingHistory!.removedEventIds = [id(10)];
  value.account.cookingHistory!.entries = [exactHistory(10), exactHistory(12, 'b')];
  value.account.cookingHistory!.removedEventIds = [id(99)];
  const result = merged(value).snapshot;
  assert.deepEqual(
    result.cookingHistory!.entries.map((row) => row.entry.eventId),
    [id(11), id(12)],
  );
  assert.deepEqual(result.cookingHistory!.removedEventIds, [id(10), id(99)]);
  assert.equal(
    canonicalAccountContentSnapshot(result),
    canonicalAccountContentSnapshot(
      merged({ ...value, local: value.account, account: value.local }).snapshot,
    ),
  );
});
test('same immutable history ID with a different exact ref, title, legacy pin or kind fails even if withdrawn', () => {
  for (const change of [
    (row: AccountContentHistoryRecord) => {
      if (row.kind === 'exact') row.entry.contentRef = ref('b');
    },
    (row: AccountContentHistoryRecord) => {
      row.entry.recipeTitle = 'Changed title';
    },
  ]) {
    const value = historyInput();
    value.base.cookingHistory!.entries = [exactHistory(10)];
    value.account.cookingHistory!.entries = [exactHistory(10)];
    change(value.account.cookingHistory!.entries[0]!);
    value.local.cookingHistory!.removedEventIds = [id(10)];
    reason(() => mergeAccountContentSnapshots(value), 'history_identity_collision');
  }
  const value = historyInput();
  value.local.cookingHistory!.entries = [legacyHistory(10)];
  value.account.cookingHistory!.entries = [exactHistory(10)];
  reason(() => mergeAccountContentSnapshots(value), 'history_identity_collision');
  value.account.cookingHistory!.entries = [
    { kind: 'legacy', entry: history(10), pin: { kind: 'exact', ref: ref() } },
  ];
  reason(() => mergeAccountContentSnapshots(value), 'history_identity_collision');
});
test('history opt-out retains only the account subtree, without uploading local entries or removal facts', () => {
  const value = historyInput();
  value.contentScope.historyIncluded = false;
  value.local.cookingHistory = { entries: [exactHistory(10)], removedEventIds: [id(11)] };
  value.account.cookingHistory = { entries: [legacyHistory(11)], removedEventIds: [id(12)] };
  assert.deepEqual(merged(value).snapshot.cookingHistory, value.account.cookingHistory);
  delete value.account.cookingHistory;
  assert.equal(Object.hasOwn(merged(value).snapshot, 'cookingHistory'), false);
});
test('favourite deletion, preference deduplication and setting conflicts reuse existing core policy', () => {
  const base = snapshot();
  base.favourites = [{ recipeId: '52819', savedAt: timestamp }];
  const value = input(base);
  value.local.favourites = [];
  value.account.favourites[0]!.savedAt = later;
  value.local.preferences = [preference(1)];
  value.account.preferences = [preference(2)];
  value.local.appPreferences.theme = 'dark';
  value.account.appPreferences.theme = 'light';
  assert.equal(conflicts(mergeAccountContentSnapshots(value))[0]!.kind, 'setting');
  const result = resolve(value, 'local').snapshot;
  assert.deepEqual(result.favourites, []);
  assert.equal(result.preferences.length, 1);
  assert.equal(result.appPreferences.theme, 'dark');
});
test('wrong scope, legacy branches, malformed refs, stale/unused decisions and hostile values fail closed', () => {
  const value = input();
  const run = (raw: unknown) => mergeAccountContentSnapshots(raw as AccountContentMergeInput);
  const absent = clone(value) as Partial<AccountContentMergeInput>;
  delete absent.contentScope;
  reason(() => run(absent), 'scope_review_required');
  for (const contentScope of [
    { schemaVersion: 2, historyIncluded: false },
    { schemaVersion: 3, historyIncluded: 'yes' },
    { schemaVersion: 3, historyIncluded: false, approved: true },
  ])
    reason(() => run({ ...value, contentScope }), 'invalid_structure');
  reason(() => run({ ...value, base: expandedSnapshot() }), 'unsupported_version');
  reason(
    () => run({ ...value, contentScope: { schemaVersion: 3, historyIncluded: true } }),
    'scope_review_required',
  );
  reason(() => run({ ...value, resolutions: { unused: 'local' } }), 'invalid_resolution');
  reason(() => run({ ...value, resolutions: null }), 'invalid_resolution');
  reason(() => run({ ...value, reviewPersonalRemovals: 1 }), 'invalid_structure');
  const malformed = input();
  plan(malformed.local, 1);
  malformed.local.planReferences = [];
  reason(() => run(malformed), 'invalid_structure');
  let invoked = false;
  const hostile = Object.defineProperty({}, 'base', {
    enumerable: true,
    get() {
      invoked = true;
      return snapshot();
    },
  });
  reason(() => run(hostile), 'invalid_structure');
  assert.equal(invoked, false);
  reason(() => run({ ...value, extra: '\0'.repeat(1500000) }), 'too_large');
  const mismatch = input();
  mismatch.account.catalogue.fingerprint = 'b'.repeat(64);
  assert.equal(mergeAccountContentSnapshots(mismatch).status, 'incompatible_catalogue');
  reason(() => run({ ...mismatch, resolutions: { stale: 'account' } }), 'invalid_resolution');
});
