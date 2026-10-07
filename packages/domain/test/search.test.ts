import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { catalogue, catalogueBoundary } from '../../catalogue/src/index';
import { createRecipeSearch, normalizeSearchText, SEARCH_RULE_FINGERPRINT } from '../src/index';
import type { SearchCriteria } from '../src/index';

const engine = createRecipeSearch(catalogue);
const ids = (criteria: SearchCriteria) =>
  engine.search(criteria).matches.map((match) => match.recipeId);

test('source oracle preserves independent Alfredo identities and Unicode/fragment/case matching', () => {
  assert.deepEqual(ids({ query: 'alfredo' }), ['53064', '52835']);
  assert.equal(ids({ query: ' FETTUCCINE   alfredo ' })[0], '53064');
  assert.equal(ids({ query: 'Fettucine alfredo' })[0], '52835');
  assert.deepEqual(ids({ query: 'sullance' }), ['53187']);
  assert.deepEqual(ids({ query: '  PÁDRON  ' }), ['53150']);
  assert.equal(normalizeSearchText('  Šúĺlance  s MÁKOM '), 'sullance s makom');
});

test('filters combine with query using AND, including all selected exact source ingredients', () => {
  assert.deepEqual(
    ids({
      query: 'peppers',
      category: 'Vegan',
      cuisine: 'Spanish',
      ingredients: ['Olive Oil', 'Padron peppers'],
    }),
    ['53150'],
  );
  assert.deepEqual(
    ids({
      query: 'peppers',
      category: 'Vegan',
      cuisine: 'Spanish',
      ingredients: ['Olive Oil', 'Black Pepper'],
    }),
    [],
  );
  assert.deepEqual(
    ids({ query: 'peppers', cuisine: 'Italian', ingredients: ['Padron peppers'] }),
    [],
  );
  assert.equal(ids({}).length, 100);
  assert.equal(new Set(ids({})).size, 100);
});

test('country/demonym alias is explicit and preserves original source label', () => {
  const result = engine.search({ query: 'Indian' });
  assert.ok(result.matches.some((match) => match.recipeId === '53076'));
  const bread = result.matches.find((match) => match.recipeId === '53076');
  assert.equal(bread?.reasons[0]?.interpretation, 'cuisine_alias');
  assert.equal(bread?.reasons[0]?.sourceText, 'India');
  assert.deepEqual(result.suggestions, []);
});

test('typos remain separate labelled suggestions and cannot relax explicit filters', () => {
  const result = engine.search({ query: 'alfreod' });
  assert.deepEqual(result.matches, []);
  assert.deepEqual(
    result.suggestions.map((match) => match.recipeId),
    ['53064', '52835'],
  );
  assert.ok(
    result.suggestions.every((match) =>
      match.reasons.some((reason) => reason.interpretation === 'possible_spelling'),
    ),
  );
  assert.deepEqual(engine.search({ query: 'alfreod', cuisine: 'Spanish' }).suggestions, []);
  assert.deepEqual(engine.search({ query: 'zzzzzzzzzzzzzzzz' }).suggestions, []);
});

test('source-backed reasons resolve through the exact shared citation boundary', () => {
  for (const criteria of [{ query: 'soy sauce' }, { query: 'Italian' }, { query: 'alfreod' }]) {
    const result = engine.search(criteria);
    for (const match of [...result.matches, ...result.suggestions]) {
      for (const reason of match.reasons) {
        assert.equal(reason.source.recipeId, match.recipeId);
        assert.ok(catalogueBoundary.hasSource(reason.source));
      }
    }
  }
});

test('unsupported or malformed criteria are failures instead of silently ignored filters', () => {
  assert.throws(() => engine.search({ calories: 400 } as SearchCriteria), /Unsupported/);
  assert.throws(() => engine.search({ ingredients: [''] }), /Invalid/);
  assert.throws(() => engine.search({ query: 42 } as unknown as SearchCriteria), /Invalid/);
  assert.throws(() => engine.search(null as unknown as SearchCriteria), /Unsupported/);
});

test('repeat consumers preserve source/rule identity, stable order and caller isolation', () => {
  const secondConsumer = createRecipeSearch(catalogue);
  const first = engine.search({ query: 'alfredo' });
  assert.deepEqual(first, secondConsumer.search({ query: 'alfredo' }));
  first.matches[0]!.reasons[0]!.source.recipeId = '99999';
  assert.equal(
    engine.search({ query: 'alfredo' }).matches[0]?.reasons[0]?.source.recipeId,
    '53064',
  );
  assert.deepEqual(engine.search({}).catalogue, catalogue.identity);
});

test('search rule fingerprint matches the shipped source implementation', async () => {
  const source = (await readFile(new URL('../src/search.ts', import.meta.url), 'utf8')).replace(
    /\r\n/g,
    '\n',
  );
  assert.equal(createHash('sha256').update(source).digest('hex'), SEARCH_RULE_FINGERPRINT);
});
