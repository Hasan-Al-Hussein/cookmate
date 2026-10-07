import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountSnapshotError,
  accountSnapshotsEqual,
  mergeAccountSnapshots,
  validateAccountSnapshot,
} from '../src/index';
import type {
  AccountMergeInput,
  AccountMergeResult,
  AccountMergeResolution,
  AccountSnapshot,
} from '../src/index';
import {
  clone,
  id,
  later,
  occurrence,
  preference,
  purchase,
  snapshot,
  timestamp,
} from './fixtures';

function merged(input: AccountMergeInput): AccountSnapshot {
  const result = mergeAccountSnapshots(input);
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged') assert.fail();
  assert.ok(validateAccountSnapshot(result.snapshot));
  return result.snapshot;
}
function conflicts(result: AccountMergeResult) {
  assert.equal(result.status, 'needs_review');
  if (result.status !== 'needs_review') assert.fail();
  assert.equal('snapshot' in result, false);
  return result.conflicts;
}
function resolve(input: AccountMergeInput, choice: AccountMergeResolution) {
  const decisions = conflicts(mergeAccountSnapshots(input));
  return merged({
    ...input,
    resolutions: Object.fromEntries(decisions.map((item) => [item.id, choice])),
  });
}

test('unchanged replicas are idempotent and detached; independent scopes merge', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.favourites = [{ recipeId: '52819', savedAt: timestamp }];
  account.plan = [occurrence(1)];
  account.shopping.selectedOccurrenceIds = [id(1)];
  const value = merged({ base, local, account });
  assert.equal(value.favourites.length, 1);
  assert.equal(value.plan.length, 1);
  assert.deepEqual(value.shopping.selectedOccurrenceIds, [id(1)]);
  assert.ok(accountSnapshotsEqual(value, merged({ base: value, local: value, account: value })));
  value.plan[0]!.recipeId = '52835';
  assert.equal(account.plan[0]!.recipeId, '52819');
});

test('semantic favourite removal is not resurrected by another device saved-time metadata', () => {
  const base = snapshot();
  base.favourites = [{ recipeId: '52819', savedAt: timestamp }];
  const local = clone(base),
    account = clone(base);
  local.favourites = [];
  account.favourites[0]!.savedAt = later;
  assert.equal(merged({ base, local, account }).favourites.length, 0);
});

test('new favourite on both devices deduplicates deterministically without a time-based winner', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.favourites = [{ recipeId: '52819', savedAt: later }];
  account.favourites = [{ recipeId: '52819', savedAt: timestamp }];
  const one = merged({ base, local, account }),
    swapped = merged({ base, local: account, account: local });
  assert.equal(one.favourites.length, 1);
  assert.ok(accountSnapshotsEqual(one, swapped));
});

test('one-sided favourite re-save preserves actual saved-at ordering while membership stays saved', () => {
  const base = snapshot();
  base.favourites = [{ recipeId: '52819', savedAt: timestamp }];
  const local = clone(base),
    account = clone(base);
  local.favourites[0]!.savedAt = later;
  assert.equal(merged({ base, local, account }).favourites[0]!.savedAt, later);
  assert.equal(merged({ base, local: account, account: local }).favourites[0]!.savedAt, later);
});

test('one-sided occurrence deletion wins over unchanged remote state and removes its selection', () => {
  const base = snapshot();
  base.plan = [occurrence(1)];
  base.shopping.selectedOccurrenceIds = [id(1)];
  const local = clone(base),
    account = clone(base);
  local.plan = [];
  local.shopping.selectedOccurrenceIds = [];
  const value = merged({ base, local, account });
  assert.deepEqual(value.plan, []);
  assert.deepEqual(value.shopping.selectedOccurrenceIds, []);
});

test('deletion versus recipe edit requires review; either explicit choice remains structurally valid', () => {
  const base = snapshot();
  base.plan = [occurrence(1)];
  const local = clone(base),
    account = clone(base);
  local.plan = [];
  account.plan[0]!.recipeId = '52835';
  const input = { base, local, account };
  assert.equal(conflicts(mergeAccountSnapshots(input))[0]!.kind, 'delete_edit');
  assert.equal(resolve(input, 'local').plan.length, 0);
  assert.equal(resolve(input, 'account').plan[0]!.recipeId, '52835');
});

test('occurrence timestamp-only changes do not turn an unchanged meal into a deletion conflict', () => {
  const base = snapshot();
  base.plan = [occurrence(1)];
  const local = clone(base),
    account = clone(base);
  local.plan = [];
  account.plan[0]!.updatedAt = later;
  assert.equal(merged({ base, local, account }).plan.length, 0);
});

test('same identity concurrent edits are explicit even if one device clock is later', () => {
  const base = snapshot();
  base.plan = [occurrence(1)];
  const local = clone(base),
    account = clone(base);
  local.plan[0]!.recipeId = '52835';
  account.plan[0]!.placement.actualDate = '2026-10-02';
  account.plan[0]!.updatedAt = '2099-01-01T00:00:00.000Z';
  const input = { base, local, account };
  assert.equal(conflicts(mergeAccountSnapshots(input))[0]!.kind, 'occurrence_edit');
  assert.equal(resolve(input, 'local').plan[0]!.placement.actualDate, '2026-09-30');
  assert.equal(resolve(input, 'account').plan[0]!.recipeId, '52819');
});

test('unresolved meal edits never manufacture provisional slot collisions', () => {
  const base = snapshot();
  base.plan = [occurrence(1), occurrence(2, '52835', '2026-10-01')];
  const local = clone(base),
    account = clone(base);
  local.plan[0]!.placement.actualDate = '2026-10-02';
  account.plan[0]!.placement.actualDate = '2026-10-03';
  account.plan[1]!.placement.actualDate = '2026-09-30';
  const input = { base, local, account };
  const review = conflicts(mergeAccountSnapshots(input));
  assert.deepEqual(
    review.map((item) => item.kind),
    ['occurrence_edit'],
  );
  for (const choice of ['local', 'account'] as const) {
    const value = resolve(input, choice);
    assert.equal(value.plan.length, 2);
    assert.equal(
      value.plan.find((item) => item.occurrenceId === id(1))!.placement.actualDate,
      choice === 'local' ? '2026-10-02' : '2026-10-03',
    );
    assert.equal(
      value.plan.find((item) => item.occurrenceId === id(2))!.placement.actualDate,
      '2026-09-30',
    );
  }
});

test('unresolved preference edits never manufacture provisional duplicate-value conflicts', () => {
  const base = snapshot();
  base.preferences = [preference(1, 'Italian'), preference(2, 'Mexican')];
  const local = clone(base),
    account = clone(base);
  local.preferences[0]!.value = 'French';
  account.preferences[0]!.value = 'Spanish';
  account.preferences[1]!.value = 'Italian';
  const input = { base, local, account };
  assert.deepEqual(
    conflicts(mergeAccountSnapshots(input)).map((item) => item.kind),
    ['preference_edit'],
  );
  assert.deepEqual(
    resolve(input, 'local').preferences.map((item) => item.value),
    ['French', 'Italian'],
  );
});

test('real collision discovered after an edit choice uses a second explicit review', () => {
  const base = snapshot();
  base.plan = [occurrence(1), occurrence(2, '52835', '2026-10-01')];
  const local = clone(base),
    account = clone(base);
  local.plan[0]!.placement.actualDate = '2026-10-02';
  account.plan[0]!.placement.actualDate = '2026-10-03';
  account.plan[1]!.placement.actualDate = '2026-10-02';
  const input = { base, local, account };
  const first = conflicts(mergeAccountSnapshots(input));
  assert.deepEqual(
    first.map((item) => item.kind),
    ['occurrence_edit'],
  );
  const resolutions = { [first[0]!.id]: 'local' as const };
  const second = conflicts(mergeAccountSnapshots({ ...input, resolutions }));
  assert.deepEqual(
    second.map((item) => item.kind),
    ['slot_collision'],
  );
  const value = merged({ ...input, resolutions: { ...resolutions, [second[0]!.id]: 'local' } });
  assert.equal(value.plan[0]!.placement.actualDate, '2026-10-02');
  assert.equal(value.plan[1]!.placement.actualDate, '2026-10-01');
});

test('new occurrence identity collision does not silently deduplicate different recipes', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.plan = [occurrence(1)];
  account.plan = [occurrence(1, '52835')];
  assert.equal(
    conflicts(mergeAccountSnapshots({ base, local, account }))[0]!.kind,
    'occurrence_edit',
  );
});

test('independent identical new meals deduplicate stable IDs and remap selection', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.plan = [occurrence(2)];
  local.shopping.selectedOccurrenceIds = [id(2)];
  account.plan = [occurrence(1)];
  const result = mergeAccountSnapshots({ base, local, account });
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged') assert.fail();
  assert.deepEqual(
    result.snapshot.plan.map((item) => item.occurrenceId),
    [id(1)],
  );
  assert.deepEqual(result.snapshot.shopping.selectedOccurrenceIds, [id(1)]);
  assert.deepEqual(result.notices, [
    { kind: 'deduplicated_occurrence', fromId: id(2), toId: id(1) },
  ]);
  assert.ok(
    accountSnapshotsEqual(result.snapshot, merged({ base, local: account, account: local })),
  );
});

test('different recipes newly competing for one meal slot require explicit side selection', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.plan = [occurrence(1)];
  account.plan = [occurrence(2, '52835')];
  const input = { base, local, account };
  assert.equal(conflicts(mergeAccountSnapshots(input))[0]!.kind, 'slot_collision');
  assert.deepEqual(
    resolve(input, 'local').plan.map((item) => item.occurrenceId),
    [id(1)],
  );
  assert.deepEqual(
    resolve(input, 'account').plan.map((item) => item.occurrenceId),
    [id(2)],
  );
});

test('divergent existing identities cannot silently collapse even when their recipes now match', () => {
  const base = snapshot();
  base.plan = [occurrence(1), occurrence(2, '52819', '2026-10-01')];
  const local = clone(base),
    account = clone(base);
  local.plan[0]!.placement.actualDate = '2026-10-02';
  account.plan[1]!.placement.actualDate = '2026-10-02';
  const input = { base, local, account };
  const found = conflicts(mergeAccountSnapshots(input));
  assert.equal(found[0]!.kind, 'slot_collision');
  const localChoice = resolve(input, 'local');
  assert.equal(
    localChoice.plan.length,
    2,
    'other original identity remains at its chosen-side placement',
  );
  assert.equal(
    localChoice.plan.find((item) => item.occurrenceId === id(2))!.placement.actualDate,
    '2026-10-01',
  );
});

test('selection merges by membership without trusting occurrence ordering', () => {
  const base = snapshot();
  base.plan = [occurrence(1), occurrence(2, '52835', '2026-10-01')];
  base.shopping.selectedOccurrenceIds = [id(1)];
  const local = clone(base),
    account = clone(base);
  local.shopping.selectedOccurrenceIds = [];
  account.shopping.selectedOccurrenceIds.push(id(2));
  assert.deepEqual(merged({ base, local, account }).shopping.selectedOccurrenceIds, [id(2)]);
});

test('new identical preferences deduplicate but opposite preference types stay distinct', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.preferences = [preference(2)];
  account.preferences = [preference(1)];
  const value = merged({ base, local, account });
  assert.deepEqual(value.preferences, [preference(1)]);
  account.preferences[0]!.type = 'ingredient_avoid';
  assert.equal(merged({ base, local, account }).preferences.length, 2);
});

test('preference deletion versus edit is not resurrected or resolved by IDs alone', () => {
  const base = snapshot();
  base.preferences = [preference(1)];
  const local = clone(base),
    account = clone(base);
  local.preferences = [];
  account.preferences[0]!.value = 'Mexican';
  assert.equal(conflicts(mergeAccountSnapshots({ base, local, account }))[0]!.kind, 'delete_edit');
  account.preferences[0]!.value = 'Italian';
  assert.deepEqual(merged({ base, local, account }).preferences, []);
});

test('existing preference identities converging on one value require review', () => {
  const base = snapshot();
  base.preferences = [preference(1, 'Italian'), preference(2, 'Mexican')];
  const local = clone(base),
    account = clone(base);
  local.preferences[0]!.value = 'French';
  account.preferences[1]!.value = 'French';
  const input = { base, local, account };
  assert.equal(conflicts(mergeAccountSnapshots(input))[0]!.kind, 'preference_collision');
  assert.equal(resolve(input, 'local').preferences.length, 2);
});

test('purchase changes sharing exact fingerprint merge; divergent demand is never treated as the same checked state', () => {
  const base = snapshot();
  base.shopping.purchaseMarks = [purchase()];
  const local = clone(base),
    account = clone(base);
  local.shopping.purchaseMarks[0]!.purchased = true;
  const result = mergeAccountSnapshots({ base, local, account });
  assert.equal(result.status, 'merged');
  if (result.status !== 'merged') assert.fail();
  assert.equal(result.snapshot.shopping.purchaseMarks[0]!.purchased, true);
  assert.equal(result.notices[0]!.kind, 'purchase_requires_reprojection');
  account.shopping.purchaseMarks[0]!.demandFingerprint = 'd'.repeat(64);
  account.shopping.purchaseMarks[0]!.changed = true;
  assert.equal(
    conflicts(mergeAccountSnapshots({ base, local, account }))[0]!.kind,
    'purchase_state',
  );
});

test('concurrent theme and profile choices remain distinct review items', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.appPreferences.theme = 'dark';
  account.appPreferences.theme = 'light';
  local.profile.displayName = 'Local';
  account.profile.displayName = 'Account';
  const input = { base, local, account },
    found = conflicts(mergeAccountSnapshots(input));
  assert.equal(found.length, 2);
  assert.ok(found.every((item) => item.kind === 'setting'));
  assert.equal(resolve(input, 'local').appPreferences.theme, 'dark');
  assert.equal(resolve(input, 'account').profile.displayName, 'Account');
});

test('stale and unknown review decisions are rejected rather than applied to new values', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.profile.displayName = 'Local';
  account.profile.displayName = 'Account';
  const input = { base, local, account },
    found = conflicts(mergeAccountSnapshots(input));
  const resolutions = { [found[0]!.id]: 'local' as const };
  account.profile.displayName = 'New account name';
  assert.throws(
    () => mergeAccountSnapshots({ ...input, resolutions }),
    (error) => error instanceof AccountSnapshotError && error.reason === 'invalid_resolution',
  );
  assert.throws(
    () =>
      mergeAccountSnapshots({
        base,
        local: base,
        account: base,
        resolutions: { missing: 'account' },
      }),
    (error) => error instanceof AccountSnapshotError && error.reason === 'invalid_resolution',
  );
});

test('catalogue mismatch is incompatible and cannot be selected as an alternate snapshot', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  account.catalogue.fingerprint = 'b'.repeat(64);
  assert.deepEqual(mergeAccountSnapshots({ base, local, account }), {
    status: 'incompatible_catalogue',
  });
});

test('three-way merge is symmetric for independent additive changes', () => {
  const base = snapshot(),
    local = clone(base),
    account = clone(base);
  local.plan = [occurrence(2, '52835', '2026-10-01')];
  local.preferences = [preference(3)];
  account.plan = [occurrence(1)];
  account.preferences = [preference(4, 'Mexican')];
  assert.ok(
    accountSnapshotsEqual(
      merged({ base, local, account }),
      merged({ base, local: account, account: local }),
    ),
  );
});
