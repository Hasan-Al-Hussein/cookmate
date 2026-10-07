import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import {
  formatExactQuantity,
  ingredientGroupingIdentity,
  parseSourceQuantity,
  REVIEWED_INGREDIENT_CASE_KEYS,
  sumCompatibleQuantities,
} from '../src/quantities';

function parsed(raw: string) {
  const result = parseSourceQuantity(raw);
  if (result.kind !== 'exact') assert.fail(`Expected supported quantity ${raw}`);
  return result;
}
test('supported source integer/decimal/fraction grammar produces reduced exact values', () => {
  for (const [raw, numerator, denominator, unit] of [
    ['100g', '100', '1', 'g'],
    ['1.5kg', '3', '2', 'kg'],
    ['1 1/2 cups', '3', '2', 'cup'],
    ['1½ kg', '3', '2', 'kg'],
    ['1 ½ tbsp', '3', '2', 'tbsp'],
    ['½ tsp', '1', '2', 'tsp'],
    ['2/3 Cup', '2', '3', 'cup'],
    ['3  tablespoons', '3', '1', 'tbsp'],
    ['4 cloves', '4', '1', 'clove'],
    ['0.5', '1', '2', 'count'],
    ['1 Litre', '1', '1', 'L'],
    ['0 tsp', '0', '1', 'tsp'],
  ])
    assert.deepEqual(parseSourceQuantity(raw!), { kind: 'exact', numerator, denominator, unit });
});
test('unknown, ranges, qualifiers and package sizes remain raw contributions instead of guessed totals', () => {
  assert.deepEqual(parseSourceQuantity(null), { kind: 'unknown' });
  assert.deepEqual(parseSourceQuantity('  '), { kind: 'unknown' });
  for (const raw of [
    'To taste',
    'For frying',
    'Dash',
    '1 dash',
    '2-3 tbsp',
    '2-1/2 cups',
    'Juice of 1',
    '2 x 400g',
    '400ml can',
    '1 can',
    '1 chopped',
    '450 grams Boneless skin',
    '1.5 tbs minced',
    '650g/1lb 8 oz',
    '1/0 tsp',
    '-1g',
    '1e3g',
    '½1 cup',
    '½/2 cup',
    '½.5 cup',
  ])
    assert.deepEqual(parseSourceQuantity(raw), { kind: 'unparsed' }, raw);
});
test('compatible totals are exact and incompatible units never silently combine', () => {
  assert.equal(
    formatExactQuantity(sumCompatibleQuantities([parsed('100 g'), parsed('200g')])),
    '300 g',
  );
  assert.equal(
    formatExactQuantity(sumCompatibleQuantities([parsed('0.1 g'), parsed('0.2g')])),
    '0.3 g',
  );
  assert.equal(
    formatExactQuantity(sumCompatibleQuantities([parsed('1/3 cup'), parsed('1 cup')])),
    '1 1/3 cup',
  );
  assert.equal(
    formatExactQuantity(sumCompatibleQuantities([parsed('1/2 tbsp'), parsed('2 tblsp')])),
    '2.5 tbsp',
  );
  assert.throws(() => sumCompatibleQuantities([parsed('1 tbsp'), parsed('100g')]), /Incompatible/);
  assert.throws(() => sumCompatibleQuantities([parsed('1kg'), parsed('100g')]), /Incompatible/);
  const values = [parsed('1/3 cup'), parsed('1/2 cup'), parsed('2/3 cup')];
  assert.deepEqual(sumCompatibleQuantities(values), sumCompatibleQuantities([...values].reverse()));
});
test('ingredient grouping uses reviewed case equivalence only; all source rows and repeated components remain distinct inputs', () => {
  assert.equal(ingredientGroupingIdentity('Soy Sauce'), ingredientGroupingIdentity('soy sauce'));
  assert.notEqual(
    ingredientGroupingIdentity('Chilli Powder'),
    ingredientGroupingIdentity('Cayenne Pepper'),
  );
  assert.notEqual(
    ingredientGroupingIdentity('Garlic'),
    ingredientGroupingIdentity('Minced Garlic'),
  );
  assert.notEqual(ingredientGroupingIdentity('Sugar'), ingredientGroupingIdentity('sugar'));
  const names = new Map<string, Set<string>>();
  for (const recipe of catalogue.recipes)
    for (const ingredient of recipe.ingredients) {
      const key = ingredient.rawName.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!names.has(key)) names.set(key, new Set());
      names.get(key)!.add(ingredient.rawName);
      const quantity = parseSourceQuantity(ingredient.rawMeasure);
      assert.ok(['exact', 'unparsed', 'unknown'].includes(quantity.kind));
      if (quantity.kind === 'exact') assert.ok(formatExactQuantity(quantity));
    }
  assert.deepEqual(
    [...names]
      .filter(([, forms]) => forms.size > 1)
      .map(([key]) => key)
      .sort(),
    [...REVIEWED_INGREDIENT_CASE_KEYS].sort(),
  );
  const repeated = catalogue.recipes
    .flatMap((recipe) => recipe.ingredients)
    .filter((entry) => entry.rawName === 'Baking Powder');
  assert.ok(repeated.length > 1);
  assert.equal(catalogue.recipes.flatMap((recipe) => recipe.ingredients).length, 960);
});
