import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueBoundary } from '@cookmate/catalogue';
import type { PlanOccurrence, Recipe } from '@cookmate/contracts';
import { buildShoppingProjection, reconcilePurchaseState } from '../src/shoppingProjection';
import { shiftPlanDate } from '../src/dates';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const readRecipe = (id: string) => catalogue.recipes.find((recipe) => recipe.recipeId === id);
function occurrence(recipeId: string, index = 0): PlanOccurrence {
  return {
    occurrenceId: randomUUID(),
    recipeId,
    placement: {
      actualDate: shiftPlanDate('2026-09-28', Math.floor(index / 3))!,
      mealKey: (['breakfast', 'lunch', 'dinner'] as const)[index % 3]!,
    },
    revision: 1,
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
  };
}

test('all source rows and exactly six reviewed instruction-only demands contribute once per selected occurrence', async () => {
  const input = catalogue.recipes.map((recipe, index) => occurrence(recipe.recipeId, index));
  const groups = await buildShoppingProjection(input, { readRecipe, sha256 });
  const contributions = groups.flatMap((group) => group.contributions);
  assert.equal(contributions.length, 966);
  assert.equal(new Set(contributions.map((item) => item.contributionId)).size, 966);
  assert.equal(contributions.filter((item) => item.quantity.kind === 'unknown').length, 6);
  assert.equal(contributions.filter((item) => item.quantity.kind === 'review_source').length, 6);
  for (const contribution of contributions)
    assert.equal(catalogueBoundary.hasSource(contribution.source), true);
  assert.equal(
    contributions.some(
      (item) => item.source.section === 'annotation' && item.source.annotationId.includes('photo'),
    ),
    false,
  );
  assert.deepEqual(
    await buildShoppingProjection([...input].reverse(), { readRecipe, sha256 }),
    groups,
  );
});

test('repeated component rows aggregate safely with traceability, while incompatible and unknown demand stay separate', async () => {
  const base = structuredClone(readRecipe('53064')) as Recipe;
  base.annotations = [];
  base.ingredients = ['100g', '200g', '1 tbsp', null].map((rawMeasure, index) => ({
    recipeId: base.recipeId,
    position: index + 1,
    rawName: 'Synthetic test ingredient',
    rawMeasure,
    source: { sheet: 'Ingredients' as const, row: index + 6, column: 'D' },
  })) as Recipe['ingredients'];
  const selected = occurrence(base.recipeId);
  const groups = await buildShoppingProjection([selected], { readRecipe: () => base, sha256 });
  assert.equal(groups.length, 3);
  const grams = groups.find((group) => group.quantityLabel === '300 g')!;
  assert.equal(grams.contributions.length, 2);
  assert.deepEqual(
    grams.contributions.map((item) => item.rawMeasure),
    ['100g', '200g'],
  );
  assert.ok(groups.some((group) => group.quantityLabel === '1 tbsp'));
  assert.ok(groups.some((group) => group.quantityLabel === 'Amount not supplied'));
  const twice = await buildShoppingProjection([selected, occurrence(base.recipeId, 1)], {
    readRecipe: () => base,
    sha256,
  });
  assert.ok(
    twice.some((group) => group.quantityLabel === '600 g' && group.contributions.length === 4),
  );
});

test('demand identity ignores display/date order but detects a different contributing occurrence despite equal total', async () => {
  const selected = occurrence('53150');
  const first = await buildShoppingProjection([selected], { readRecipe, sha256 });
  const moved = {
    ...selected,
    revision: 2,
    placement: { ...selected.placement, actualDate: '2026-10-01' },
  };
  assert.deepEqual(await buildShoppingProjection([moved], { readRecipe, sha256 }), first);
  const repeated = await buildShoppingProjection([occurrence(selected.recipeId)], {
    readRecipe,
    sha256,
  });
  assert.deepEqual(
    repeated.map((group) => group.quantityLabel),
    first.map((group) => group.quantityLabel),
  );
  assert.deepEqual(
    repeated.map((group) => group.groupKey),
    first.map((group) => group.groupKey),
  );
  assert.ok(
    repeated.every((group, index) => group.demandFingerprint !== first[index]!.demandFingerprint),
  );
});

test('purchase progress preserves exact unchanged demand, but changed, removed/re-added and split/merged demand requires review', () => {
  const previous = {
    demandFingerprint: 'a'.repeat(64),
    purchased: true,
    changed: false,
    revision: 4,
  };
  assert.deepEqual(
    reconcilePurchaseState({ demandFingerprint: previous.demandFingerprint }, previous),
    { purchased: true, changed: false, revision: 4 },
  );
  assert.deepEqual(reconcilePurchaseState({ demandFingerprint: 'b'.repeat(64) }, previous), {
    purchased: false,
    changed: true,
    revision: 5,
  });
  assert.deepEqual(
    reconcilePurchaseState(
      { demandFingerprint: previous.demandFingerprint },
      { ...previous, active: false },
    ),
    { purchased: false, changed: true, revision: 5 },
  );
  assert.deepEqual(reconcilePurchaseState({ demandFingerprint: 'c'.repeat(64) }, undefined, true), {
    purchased: false,
    changed: true,
    revision: 0,
  });
  assert.deepEqual(reconcilePurchaseState({ demandFingerprint: 'c'.repeat(64) }), {
    purchased: false,
    changed: false,
    revision: 0,
  });
});

test('projection takes ownership before asynchronous hashes and rejects unknown or duplicate selected sources', async () => {
  const base = structuredClone(readRecipe('53150')) as Recipe;
  const selected = occurrence(base.recipeId);
  const original = await buildShoppingProjection([selected], { readRecipe: () => base, sha256 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = buildShoppingProjection([selected], {
    readRecipe: () => base,
    sha256: async (text) => {
      await gate;
      return sha256(text);
    },
  });
  base.ingredients[0]!.rawMeasure = '999kg';
  selected.recipeId = '53064';
  release();
  assert.deepEqual(await pending, original);
  await assert.rejects(
    buildShoppingProjection([selected], { readRecipe: () => undefined, sha256 }),
    /unavailable/,
  );
  await assert.rejects(
    buildShoppingProjection([selected, selected], { readRecipe, sha256 }),
    /Invalid selected occurrence/,
  );
  const duplicateSource = structuredClone(readRecipe('53064')) as Recipe;
  duplicateSource.ingredients.push(structuredClone(duplicateSource.ingredients[0]!));
  await assert.rejects(
    buildShoppingProjection([selected], { readRecipe: () => duplicateSource, sha256 }),
    /Duplicate source contribution/,
  );
});
