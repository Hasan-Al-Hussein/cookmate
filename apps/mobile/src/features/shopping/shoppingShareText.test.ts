import {
  formatShoppingShare,
  formatContentShoppingShare,
  assertShoppingShareSize,
  SHOPPING_SHARE_MAX_BYTES,
  shoppingShareByteLength,
} from './shoppingShareText';
import { shoppingShareFixture, contentShoppingShareFixture } from './shoppingShare.test-support';
import { getRecipe } from '@cookmate/catalogue';

const { Buffer } = require('node:buffer') as { Buffer: { byteLength(text: string): number } };

const info = (id: string) => ({
  ...(id === '52839'
    ? { title: 'Synthetic first recipe', sourceNotes: [] }
    : {
        title: 'Synthetic second recipe',
        sourceNotes: ['Original source warning, preserved in full.'],
      }),
  recipePage: getRecipe(id)?.recipePage ?? null,
  originalSourceUrl: getRecipe(id)?.originalSourceUrl ?? null,
});

test('exports checklist quantities, purchased state, all selected dates and complete source warnings', () => {
  const snapshot = shoppingShareFixture();
  const before = JSON.stringify(snapshot);
  const text = formatShoppingShare(snapshot, info);
  expect(text).toContain('To buy 2 · Purchased 1');
  expect(text).toContain('[ ] Pasta — 475 g');
  expect(text).toContain('[x] Salt — Amount not supplied');
  expect(text).toContain('Changed — review');
  expect(text).toContain('[ ] Sauce ingredients — Review source instructions');
  expect(text).toContain('This amount needs recipe-source review.');
  expect(text).toContain('Wednesday 30 September 2026 · Dinner — Synthetic first recipe');
  expect(text).toContain('Thursday 8 October 2026 · Lunch — Synthetic second recipe');
  expect(text).toContain('Original source warning, preserved in full.');
  expect(text.indexOf('[ ] Pasta')).toBeLessThan(text.indexOf('Selected meals'));
  expect(JSON.stringify(snapshot)).toBe(before);
});

test('a repeated recipe keeps every dated meal but prints its source note once', () => {
  const snapshot = shoppingShareFixture();
  snapshot.selectedOccurrences = snapshot.selectedOccurrences.map((meal) => ({
    ...meal,
    recipeId: '52982',
  }));
  const text = formatShoppingShare(snapshot, info);
  expect(text).toContain('Selected meals (2)');
  expect(text.split('Original source warning, preserved in full.')).toHaveLength(2);
  expect(text).toContain('30 September 2026');
  expect(text).toContain('8 October 2026');
});

test('incomplete selections and pending projections never yield a misleading partial export', () => {
  const snapshot = shoppingShareFixture();
  snapshot.status = 'pending';
  expect(() => formatShoppingShare(snapshot, info)).toThrow('not_current');
  snapshot.status = 'current';
  snapshot.selectedOccurrences = snapshot.selectedOccurrences.slice(0, 1);
  expect(() => formatShoppingShare(snapshot, info)).toThrow('incomplete_selection');
  const duplicate = shoppingShareFixture();
  duplicate.scope = { ...duplicate.scope, occurrenceIds: ['meal-first', 'meal-first'] };
  expect(() => formatShoppingShare(duplicate, info)).toThrow('incomplete_selection');
});

test('unknown recipes retain dated selections and an explicit unavailable-source warning', () => {
  const text = formatShoppingShare(shoppingShareFixture(), () => null);
  expect(text).toContain('Unavailable recipe (52839)');
  expect(text).toContain('Unavailable recipe (52982)');
  expect(text).toContain('The recipe is unavailable in this catalogue.');
});

test('UTF-8 size is bounded without cutting a source note or silently truncating the list', () => {
  expect(shoppingShareByteLength('🍋العربية')).toBe(Buffer.byteLength('🍋العربية'));
  expect(() => assertShoppingShareSize('é'.repeat(SHOPPING_SHARE_MAX_BYTES / 2 + 1))).toThrow(
    'too_large',
  );
  expect(() =>
    formatShoppingShare(shoppingShareFixture(), () => ({
      ...info('52839'),
      title: 'Test',
      sourceNotes: ['a'.repeat(SHOPPING_SHARE_MAX_BYTES)],
    })),
  ).toThrow('too_large');
});

test('recipe credits retain supplied collection and publisher URLs once per recipe', () => {
  const snapshot = shoppingShareFixture();
  snapshot.selectedOccurrences = snapshot.selectedOccurrences.map((meal) => ({
    ...meal,
    recipeId: '52839',
  }));
  const recipe = getRecipe('52839')!;
  const text = formatShoppingShare(snapshot, info);
  expect(text).toContain('Recipe credits');
  expect(text).toContain(`TheMealDB — ${recipe.recipePage}`);
  expect(text.split(recipe.recipePage)).toHaveLength(2);
  expect(recipe.originalSourceUrl).toBeTruthy();
  expect(text).toContain(recipe.originalSourceUrl!);
});

test('invalid, credential-bearing and missing credit links never produce invented replacements', () => {
  const text = formatShoppingShare(shoppingShareFixture(), (id) => ({
    ...info(id),
    recipePage: 'javascript:synthetic-unsafe-link',
    originalSourceUrl: id === '52839' ? 'https://user:secret@publisher.test/private' : null,
  }));
  expect(text).toContain('Recipe collection link unavailable.');
  expect(text).toContain('Original publisher link unavailable.');
  expect(text).toContain('Original publisher link not supplied.');
  expect(text).not.toContain('javascript:');
  expect(text).not.toContain('user:secret');
  expect(text).not.toContain('publisher.test/private');
  expect(text).not.toContain('https://');
});

test('exact selected versions retain separate credits, original warnings and unchanged quantities without internal identities', () => {
  const value = contentShoppingShareFixture();
  const original = JSON.stringify(value);
  const text = formatContentShoppingShare(value);
  expect(text).toContain('Original pasta (selected version 1)');
  expect(text).toContain('Revised pasta (selected version 2)');
  expect(text).toContain('Recipe author — https://author.test/pasta');
  expect(text).toContain('TheMealDB — https://www.themealdb.com/meal/52839');
  expect(text).toContain(
    'Inherited unresolved source — Original pasta: Keep this original warning exactly.',
  );
  expect(text).toContain('Retained source — inherited unresolved: Original pasta');
  expect(text).toContain('[ ] Pasta — 475 g');
  expect(text).toContain('[x] Salt — Amount not supplied');
  expect(text).toContain('Changed — review');
  expect(text).toContain('This amount needs recipe-source review.');
  expect(text).not.toContain('meal-first');
  expect(text).not.toContain('revisionId');
  expect(text).not.toContain('a0000000-0000');
  expect(text).not.toContain('a'.repeat(64));
  expect(JSON.stringify(value)).toBe(original);
});

test.each([
  'missing',
  'extra',
  'duplicate',
  'wrong_ref',
  'wrong_occurrence',
  'wrong_notice',
] as const)(
  'exact share rejects %s metadata rather than falling back to packaged content',
  (problem) => {
    const value = contentShoppingShareFixture();
    if (value.share.kind !== 'ready') throw new Error('fixture');
    const recipes = [...value.share.recipes];
    if (problem === 'missing') recipes.pop();
    if (problem === 'extra')
      recipes.push({
        ...recipes[0]!,
        contentRef: {
          ...recipes[0]!.contentRef,
          revisionId: 'a0000000-0000-4000-8000-000000000003',
        },
      });
    if (problem === 'duplicate') recipes.push(recipes[0]!);
    if (problem === 'wrong_ref')
      recipes[0] = {
        ...recipes[0]!,
        contentRef: { ...recipes[0]!.contentRef, contentFingerprint: 'c'.repeat(64) },
      };
    value.share = { kind: 'ready', recipes };
    if (problem === 'wrong_occurrence')
      value.selected = value.selected.map((row, index) =>
        index === 0
          ? {
              ...row,
              occurrence: {
                ...row.occurrence,
                placement: { ...row.occurrence.placement, actualDate: '2026-10-02' },
              },
            }
          : row,
      );
    if (problem === 'wrong_notice')
      value.notices = value.notices.map((row) => ({
        ...row,
        contentRef: { ...row.contentRef, contentFingerprint: 'd'.repeat(64) },
      }));
    expect(() => formatContentShoppingShare(value)).toThrow('incomplete_selection');
  },
);

test('content sharing never emits unsafe authored credit links and refuses an over-limit complete export', () => {
  const value = contentShoppingShareFixture();
  if (value.share.kind !== 'ready') throw new Error('fixture');
  value.share = {
    ...value.share,
    recipes: value.share.recipes.map((recipe, index) =>
      index === 1
        ? {
            ...recipe,
            credits: [{ label: 'Supplied author', url: 'https://name:password@private.test/path' }],
          }
        : recipe,
    ),
  };
  const text = formatContentShoppingShare(value);
  expect(text).toContain('Supplied author — link unavailable.');
  expect(text).not.toContain('password');
  value.share = {
    ...value.share,
    recipes: value.share.recipes.map((recipe, index) =>
      index === 1
        ? { ...recipe, credits: [{ label: 'é'.repeat(SHOPPING_SHARE_MAX_BYTES), url: null }] }
        : recipe,
    ),
  };
  expect(() => formatContentShoppingShare(value)).toThrow('too_large');
  value.share = { kind: 'unavailable', reason: 'too_large' };
  expect(() => formatContentShoppingShare(value)).toThrow('too_large');
});
