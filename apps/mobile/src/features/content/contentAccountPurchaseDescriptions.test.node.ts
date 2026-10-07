import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AccountPurchaseMark } from '@cookmate/account-sync';
import { catalogue } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  projectContentLookup,
  type ReadingLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type {
  AccountContentMergeConflict,
  AccountContentMergeResult,
} from '../../../../../packages/account-sync/src/contentMerge';
import type { AccountContentSnapshot } from '../../../../../packages/account-sync/src/contentSnapshot';
import {
  authoredFixture,
  clone,
  sha256,
} from '../../../../../packages/catalogue/test/content-fixtures';
import { published } from '../../../../../packages/catalogue/test/content-overlay-fixtures';
import { buildRevisionShoppingProjection } from '../../data/revisionShoppingProjection';
import {
  buildContentAccountPurchaseDescriptions,
  type ContentAccountPurchaseDescriptionOptions,
} from './contentAccountPurchaseDescriptions';

// Controlled exact-reader envelopes and fixture publications; actual shared domain arithmetic.
// These tests claim no signature, provider, media-byte or running-workspace verification.
const at = '2026-10-01T12:00:00.000Z';
type Exact = Awaited<ReturnType<ContentAccountPurchaseDescriptionOptions['readExact']>>;
type Review = {
  comparison: { local: AccountContentSnapshot; account: AccountContentSnapshot | null };
  merge: AccountContentMergeResult;
};
const key = (ref: RecipeContentRef) => canonicalContentJson(ref);
function snapshot(ref: RecipeContentRef, occurrenceId: string): AccountContentSnapshot {
  return {
    format: 'cookmate-account-snapshot',
    schemaVersion: 3,
    catalogue: catalogue.identity,
    favourites: [],
    preferences: [],
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
    plan: [
      {
        occurrenceId,
        recipeId: ref.recipeId,
        placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
        createdAt: at,
        updatedAt: at,
      },
    ],
    planReferences: [{ occurrenceId, contentRef: { ...ref } }],
    shopping: { selectedOccurrenceIds: [occurrenceId], purchaseMarks: [] },
    appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
    profile: { displayName: null },
  };
}
function conflict(
  id: string,
  local: AccountPurchaseMark | null,
  account: AccountPurchaseMark | null,
  kind: 'purchase_state' | 'delete_edit' = 'purchase_state',
): AccountContentMergeConflict {
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
  const document = authoredFixture('90001');
  document.recipe.ingredients = [{ position: 1, rawName: 'Salt', rawMeasure: '100g' }];
  const first = await published(document, 'display-first');
  const next = clone(document);
  next.recipe.ingredients[0]!.rawMeasure = '200g';
  next.recipe.title = 'Second exact version';
  const second = await published(next, 'display-second');
  const lookups = new Map<string, ReadingLookup>(
    [first, second].map((publication) => [
      key(publication.revision.ref),
      projectContentLookup({
        kind: 'readable',
        state: publication === first ? 'historical' : 'current',
        value: {
          origin: 'published',
          revision: publication.revision,
          publication,
          retainedSources: [],
        },
      }),
    ]),
  );
  const occurrenceId = randomUUID();
  const local = snapshot(first.revision.ref, occurrenceId),
    account = snapshot(second.revision.ref, occurrenceId);
  async function calculate(value: AccountContentSnapshot) {
    return buildRevisionShoppingProjection(
      value.plan.map((occurrence) => ({
        occurrence: { ...occurrence, revision: 0 },
        contentRef: value.planReferences.find(
          (ref) => ref.occurrenceId === occurrence.occurrenceId,
        )!.contentRef,
      })),
      { lookupExact: (ref) => lookups.get(key(ref)) ?? { kind: 'missing' }, sha256 },
    );
  }
  const localGroup = (await calculate(local)).groups[0]!,
    accountGroup = (await calculate(account)).groups[0]!;
  const mark = (group: typeof localGroup): AccountPurchaseMark => ({
    groupKey: group.groupKey,
    groupingVersion: group.groupingVersion,
    demandFingerprint: group.demandFingerprint,
    purchased: true,
    changed: false,
  });
  const review: Review = {
    comparison: { local, account },
    merge: {
      status: 'needs_review',
      conflicts: [conflict('salt', mark(localGroup), mark(accountGroup))],
      notices: [],
    },
  };
  const installationId = randomUUID(),
    ownerId = randomUUID(),
    reads: string[] = [];
  let hook: ((result: Exact, ref: RecipeContentRef) => Promise<Exact>) | undefined;
  const options: ContentAccountPurchaseDescriptionOptions = {
    sha256,
    async readExact(ref) {
      reads.push(key(ref));
      const result: Exact = {
        installationId,
        ownerId,
        head: null,
        adoptionRevision: 0,
        identity: catalogue.identity,
        value: lookups.get(key(ref)) ?? { kind: 'missing' },
      };
      return hook ? hook(result, ref) : result;
    },
  };
  return {
    review,
    local,
    account,
    first: first.revision.ref,
    second: second.revision.ref,
    localGroup,
    accountGroup,
    mark,
    lookups,
    reads,
    options,
    hook(value: typeof hook) {
      hook = value;
    },
  };
}
const localDescription = { name: 'Salt', quantity: '100 g' },
  accountDescription = { name: 'Salt', quantity: '200 g' };

test('same recipe ID with distinct exact revisions keeps each reviewed quantity', async () => {
  const f = await fixture();
  assert.equal(f.first.recipeId, f.second.recipeId);
  assert.equal(f.localGroup.groupKey, f.accountGroup.groupKey);
  assert.notEqual(f.localGroup.demandFingerprint, f.accountGroup.demandFingerprint);
  assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {
    salt: { local: localDescription, account: accountDescription },
  });
  assert.deepEqual(f.reads, [key(f.first), key(f.second)]);
});

test('group, rule, or demand mismatch never borrows the other reviewed side label', async () => {
  const f = await fixture();
  for (const changed of [
    { groupKey: 'f'.repeat(64) },
    { groupingVersion: 'other-rule' },
    { demandFingerprint: f.accountGroup.demandFingerprint },
  ]) {
    f.review.merge = {
      status: 'needs_review',
      conflicts: [
        conflict('mismatch', { ...f.mark(f.localGroup), ...changed }, f.mark(f.accountGroup)),
      ],
      notices: [],
    };
    assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {
      mismatch: { account: accountDescription },
    });
  }
});

test('missing, withdrawn, rejected or differently referenced content leaves that side unidentified', async () => {
  const f = await fixture();
  const original = f.lookups.get(key(f.first))!;
  for (const unavailable of [
    { kind: 'missing' } as const,
    { kind: 'withdrawn', recipeId: f.first.recipeId, reason: 'withdrawn fixture' } as const,
    f.lookups.get(key(f.second))!,
  ]) {
    f.lookups.set(key(f.first), unavailable);
    assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {
      salt: { account: accountDescription },
    });
  }
  f.lookups.set(key(f.first), original);
  f.hook(async (result, ref) => {
    if (key(ref) === key(f.first)) throw new Error('unavailable');
    return result;
  });
  assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {
    salt: { account: accountDescription },
  });
});

test('only selected exact references are prefetched and shared full references are deduplicated', async () => {
  const f = await fixture();
  const unrelated = randomUUID();
  f.local.plan.push({ ...f.local.plan[0]!, occurrenceId: unrelated });
  f.local.planReferences.push({
    occurrenceId: unrelated,
    contentRef: { ...f.first, revisionId: 'unselected-version' },
  });
  f.review.comparison.account = clone(f.local);
  f.review.merge = {
    status: 'needs_review',
    conflicts: [conflict('same', f.mark(f.localGroup), f.mark(f.localGroup))],
    notices: [],
  };
  assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {
    same: { local: localDescription, account: localDescription },
  });
  assert.deepEqual(f.reads, [key(f.first)]);
});

test('missing or duplicate selected occurrence/reference identities omit only their affected side', async () => {
  for (const issue of ['selection', 'pin', 'duplicate-pin', 'wrong-recipe'] as const) {
    const f = await fixture();
    if (issue === 'selection') f.local.shopping.selectedOccurrenceIds.push(randomUUID());
    if (issue === 'pin') f.local.planReferences = [];
    if (issue === 'duplicate-pin') f.local.planReferences.push(clone(f.local.planReferences[0]!));
    if (issue === 'wrong-recipe') f.local.planReferences[0]!.contentRef.recipeId = '99999';
    assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {
      salt: { account: accountDescription },
    });
    assert.deepEqual(f.reads, [key(f.second)]);
  }
});

test('review identities and selected exact inputs are owned before an asynchronous read', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.hook(async (result) => {
    entered();
    await blocked;
    return result;
  });
  const result = buildContentAccountPurchaseDescriptions(f.review, f.options);
  await started;
  f.local.planReferences[0]!.contentRef = { ...f.second };
  f.local.shopping.selectedOccurrenceIds = [];
  f.review.merge = { status: 'merged', snapshot: f.local, notices: [] };
  release();
  assert.deepEqual(await result, {
    salt: { local: localDescription, account: accountDescription },
  });
});

test('different owner, installation, adoption or catalogue envelopes cannot be combined', async () => {
  for (const changed of [
    { ownerId: randomUUID() },
    { installationId: randomUUID() },
    { adoptionRevision: 2 },
    { identity: { ...catalogue.identity, fingerprint: 'f'.repeat(64) } },
  ]) {
    const f = await fixture();
    f.hook(async (result, ref) =>
      key(ref) === key(f.second) ? { ...result, ...changed } : result,
    );
    assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {});
  }
});

test('deletion comparisons identify only non-null sides and unrelated conflicts perform no reads', async () => {
  const f = await fixture();
  f.review.merge = {
    status: 'needs_review',
    conflicts: [
      conflict('removed-local', null, f.mark(f.accountGroup), 'delete_edit'),
      conflict('removed-account', f.mark(f.localGroup), null, 'delete_edit'),
    ],
    notices: [],
  };
  assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {
    'removed-local': { account: accountDescription },
    'removed-account': { local: localDescription },
  });
  f.reads.length = 0;
  f.review.merge = {
    status: 'needs_review',
    conflicts: [
      {
        id: 'setting',
        kind: 'setting',
        path: 'profile/displayName',
        base: null,
        local: 'Local',
        account: 'Account',
      },
    ],
    notices: [],
  };
  assert.deepEqual(await buildContentAccountPurchaseDescriptions(f.review, f.options), {});
  assert.deepEqual(f.reads, []);
});

test('hash failure cannot identify a purchase comparison', async () => {
  const f = await fixture();
  assert.deepEqual(
    await buildContentAccountPurchaseDescriptions(f.review, {
      ...f.options,
      sha256: async () => {
        throw new Error('hash unavailable');
      },
    }),
    {},
  );
});
