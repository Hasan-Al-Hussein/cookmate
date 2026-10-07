import assert from 'node:assert/strict';
import test from 'node:test';
import type { Recipe } from '@cookmate/contracts';
import { catalogue, getRecipe, getReviewedBundledInstructionRoles } from '../src/index';
import reviewed from '../reviewed-instruction-roles.json';

const recipe = getRecipe('52819')!;

test('explicit review preserves all five source passages and original anchors', () => {
  const before = JSON.stringify(recipe);
  assert.deepEqual(getReviewedBundledInstructionRoles(recipe, catalogue.identity), [
    { sequence: 1, role: 'introduction' },
    { sequence: 2, role: 'procedure' },
    { sequence: 3, role: 'procedure' },
    { sequence: 4, role: 'procedure' },
    { sequence: 5, role: 'procedure' },
  ]);
  assert.equal(JSON.stringify(recipe), before);
  assert.equal(reviewed.review.reviewerId, 'codex-source-comparison');
  assert.match(reviewed.review.scope, /not human approval/);
});

test('current runtime catalogue identity must match the reviewed source revision', () => {
  assert.deepEqual(
    getReviewedBundledInstructionRoles(recipe, {
      ...catalogue.identity,
      fingerprint: 'f'.repeat(64),
    }),
    [],
  );
  assert.deepEqual(
    getReviewedBundledInstructionRoles(recipe, {
      ...catalogue.identity,
      version: 'different-version',
    }),
    [],
  );
});

test('unknown recipes remain neutral even if their first passage sounds introductory', () => {
  assert.deepEqual(getReviewedBundledInstructionRoles(getRecipe('53262')!, catalogue.identity), []);
  assert.deepEqual(
    getReviewedBundledInstructionRoles({ ...recipe, recipeId: '99999' }, catalogue.identity),
    [],
  );
});

test('changed source text, source coordinates, ownership and sequence invalidate all role labels', () => {
  const mutations: ((value: Recipe) => void)[] = [
    (value) => {
      value.instructions[0]!.rawText += ' ';
    },
    (value) => {
      value.instructions[0]!.source.row++;
    },
    (value) => {
      value.instructions[0]!.source.sheet = 'Recipes';
    },
    (value) => {
      value.instructions[0]!.source.column = 'C';
    },
    (value) => {
      delete value.instructions[0]!.source.column;
    },
    (value) => {
      value.instructions[0]!.recipeId = '99999';
    },
    (value) => {
      value.instructions[0]!.sequence = 2;
    },
    (value) => {
      value.instructions[0]!.presentation = 'heading';
    },
    (value) => {
      value.instructions.pop();
    },
    (value) => {
      value.instructions.reverse();
    },
  ];
  for (const mutate of mutations) {
    const changed = JSON.parse(JSON.stringify(recipe)) as Recipe;
    mutate(changed);
    assert.deepEqual(getReviewedBundledInstructionRoles(changed, catalogue.identity), []);
  }
});
