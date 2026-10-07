import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type {
  AccountMergeConflict,
  AccountPlanOccurrence,
  AccountPurchaseMark,
  AccountSnapshot,
  AccountSyncState,
} from '@cookmate/account-sync';
import { getRecipe, identity } from '@cookmate/catalogue';
import { buildShoppingProjection, type ProjectedShoppingGroup } from '@cookmate/domain';
import { buildAccountPurchaseDescriptions } from './accountPurchaseDescriptions';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const projection = { readRecipe: getRecipe, sha256 };
const occurrence = (recipeId: string, id: 'a' | 'b'): AccountPlanOccurrence => ({
  occurrenceId: `${id.repeat(8)}-${id.repeat(4)}-4${id.repeat(3)}-8${id.repeat(3)}-${id.repeat(12)}`,
  recipeId,
  placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
});
function snapshot(item: AccountPlanOccurrence): AccountSnapshot {
  return {
    format: 'cookmate-account-snapshot',
    schemaVersion: 1,
    catalogue: identity,
    favourites: [],
    plan: [item],
    shopping: { selectedOccurrenceIds: [item.occurrenceId], purchaseMarks: [] },
    preferences: [],
    appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
    profile: { displayName: null },
  };
}
function mark(group: ProjectedShoppingGroup): AccountPurchaseMark {
  return {
    groupKey: group.groupKey,
    groupingVersion: group.groupingVersion,
    demandFingerprint: group.demandFingerprint,
    purchased: true,
    changed: false,
  };
}
function conflict(
  id: string,
  local: AccountPurchaseMark | null,
  account: AccountPurchaseMark | null,
  kind: 'purchase_state' | 'delete_edit' = 'purchase_state',
): AccountMergeConflict {
  return {
    id,
    kind,
    path: `shopping/purchaseMarks/${local?.groupKey ?? account?.groupKey}`,
    base: null,
    local,
    account,
  };
}
async function fixture() {
  const localMeal = occurrence('52819', 'a'),
    accountMeal = occurrence('53064', 'b');
  const local = snapshot(localMeal),
    account = snapshot(accountMeal);
  const localGroups = await buildShoppingProjection([{ ...localMeal, revision: 0 }], projection);
  const accountGroups = await buildShoppingProjection(
    [{ ...accountMeal, revision: 0 }],
    projection,
  );
  const localGroup = localGroups[0]!,
    accountGroup = accountGroups[0]!;
  const review: Extract<AccountSyncState, { kind: 'review' }> = {
    kind: 'review',
    initial: false,
    recovering: false,
    local,
    account,
    choice: 'merge',
    canConfirm: false,
    conflicts: [conflict('comparison', mark(localGroup), mark(accountGroup))],
  };
  return { review, localGroup, accountGroup, localGroups };
}
const description = (group: ProjectedShoppingGroup) => ({
  name: group.displayName,
  quantity: group.quantityLabel,
});

test('both sides use exact current catalogue projection labels and raw quantity wording', async () => {
  const f = await fixture();
  const result = await buildAccountPurchaseDescriptions(f.review, projection);
  assert.deepEqual(result, {
    comparison: { local: description(f.localGroup), account: description(f.accountGroup) },
  });
  const garlic = f.localGroups.find((group) => group.displayName.toLowerCase() === 'garlic')!;
  assert.ok(garlic);
  f.review.conflicts = [conflict('garlic', mark(garlic), null)];
  assert.deepEqual((await buildAccountPurchaseDescriptions(f.review, projection)).garlic?.local, {
    name: 'garlic',
    quantity: '1 clove finely chopped',
  });
});

test('each identity, rule version and demand mismatch is omitted independently', async () => {
  const f = await fixture();
  for (const changed of [
    { groupKey: 'f'.repeat(64) },
    { groupingVersion: 'different-rule' },
    { demandFingerprint: 'f'.repeat(64) },
  ]) {
    f.review.conflicts = [
      conflict('stale', { ...mark(f.localGroup), ...changed }, mark(f.accountGroup)),
    ];
    assert.deepEqual(await buildAccountPurchaseDescriptions(f.review, projection), {
      stale: { account: description(f.accountGroup) },
    });
  }
});

test('a same-group mark from a different occurrence does not identify the current demand', async () => {
  const f = await fixture();
  const different = occurrence('52819', 'b');
  const changedGroups = await buildShoppingProjection([{ ...different, revision: 0 }], projection);
  const stale = changedGroups.find((group) => group.groupKey === f.localGroup.groupKey)!;
  assert.equal(stale.groupingVersion, f.localGroup.groupingVersion);
  assert.notEqual(stale.demandFingerprint, f.localGroup.demandFingerprint);
  f.review.conflicts = [conflict('different-occurrence', mark(stale), null)];
  assert.deepEqual(await buildAccountPurchaseDescriptions(f.review, projection), {});
});

test('purchase deletion conflicts identify only their non-null matching side', async () => {
  const f = await fixture();
  f.review.conflicts = [
    conflict('deleted-here', null, mark(f.accountGroup), 'delete_edit'),
    conflict('deleted-there', mark(f.localGroup), null, 'delete_edit'),
    conflict('both-absent', null, null, 'delete_edit'),
  ];
  assert.deepEqual(await buildAccountPurchaseDescriptions(f.review, projection), {
    'deleted-here': { account: description(f.accountGroup) },
    'deleted-there': { local: description(f.localGroup) },
  });
  f.review.account = null;
  assert.deepEqual(await buildAccountPurchaseDescriptions(f.review, projection), {
    'deleted-there': { local: description(f.localGroup) },
  });
});

test('unselected, missing-selection and unknown-recipe projections cannot lend stale labels', async () => {
  for (const mode of ['unselected', 'missing', 'unknown', 'duplicate'] as const) {
    const f = await fixture();
    if (mode === 'unselected') f.review.local.shopping.selectedOccurrenceIds = [];
    if (mode === 'missing')
      f.review.local.shopping.selectedOccurrenceIds.push('missing-occurrence');
    if (mode === 'unknown') f.review.local.plan[0]!.recipeId = '999999999';
    if (mode === 'duplicate')
      f.review.local.shopping.selectedOccurrenceIds.push(f.review.local.plan[0]!.occurrenceId);
    assert.deepEqual(await buildAccountPurchaseDescriptions(f.review, projection), {
      comparison: { account: description(f.accountGroup) },
    });
  }
});

test('recipe or hash failure omits affected descriptions instead of guessing or throwing', async () => {
  const f = await fixture();
  assert.deepEqual(
    await buildAccountPurchaseDescriptions(f.review, {
      ...projection,
      readRecipe: (id) => {
        if (id === '52819') throw new Error('source unavailable');
        return getRecipe(id);
      },
    }),
    { comparison: { account: description(f.accountGroup) } },
  );
  assert.deepEqual(
    await buildAccountPurchaseDescriptions(f.review, {
      ...projection,
      sha256: async () => {
        throw new Error('hash unavailable');
      },
    }),
    {},
  );
});

test('unrelated conflicts do not trigger recipe reads or hashing', async () => {
  const f = await fixture();
  let recipeReads = 0;
  let hashes = 0;
  f.review.conflicts = [
    {
      id: 'preference',
      kind: 'delete_edit',
      path: 'preferences/item',
      base: null,
      local: null,
      account: { preferenceId: 'item', type: 'cuisine', value: 'Italian' },
    },
  ];
  assert.deepEqual(
    await buildAccountPurchaseDescriptions(f.review, {
      readRecipe: (id) => {
        recipeReads++;
        return getRecipe(id);
      },
      sha256: async (text) => {
        hashes++;
        return sha256(text);
      },
    }),
    {},
  );
  assert.equal(recipeReads, 0);
  assert.equal(hashes, 0);
});

test('async completion remains bound to captured conflict IDs, marks and selected recipe data', async () => {
  const f = await fixture();
  let resume!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let first = true;
  const result = buildAccountPurchaseDescriptions(f.review, {
    ...projection,
    sha256: async (text) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return sha256(text);
    },
  });
  await started;
  f.review.conflicts[0]!.id = 'changed-after-start';
  (f.review.conflicts[0]!.local as AccountPurchaseMark).demandFingerprint = 'f'.repeat(64);
  f.review.local.plan[0]!.recipeId = '999999999';
  f.review.local.shopping.selectedOccurrenceIds = [];
  resume();
  assert.deepEqual(await result, {
    comparison: { local: description(f.localGroup), account: description(f.accountGroup) },
  });
});
