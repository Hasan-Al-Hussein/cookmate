import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateRecipe } from '@cookmate/contracts';
import type { Recipe, SourceReference } from '@cookmate/contracts';
import {
  catalogue,
  catalogueBoundary,
  createCatalogue,
  getRecipe,
  getRecipePhotoTreatment,
} from '../src/index';
import prepared from '../generated/catalogue.json';
import provenance from '../generated/provenance.json';
import reviewedNotes from '../reviewed-annotations.json';
import approvedAdditions from '../review/approved-additions.v2.json';

function fixture(): Recipe {
  const value: unknown = JSON.parse(JSON.stringify(getRecipe('53064')));
  assert.ok(validateRecipe(value));
  return value;
}

test('all source records validate and preserve unknowns, repeats, headings and distinct Alfredo IDs', () => {
  assert.equal(catalogue.recipes.length, 100);
  assert.equal(
    catalogue.recipes.reduce((sum, recipe) => sum + recipe.ingredients.length, 0),
    960,
  );
  assert.equal(
    catalogue.recipes.reduce((sum, recipe) => sum + recipe.instructions.length, 0),
    706,
  );
  assert.equal(
    catalogue.recipes
      .flatMap((recipe) => recipe.instructions)
      .filter((passage) => passage.presentation === 'heading').length,
    124,
  );
  assert.equal(
    catalogue.recipes
      .flatMap((recipe) => recipe.ingredients)
      .filter((entry) => entry.rawMeasure === null).length,
    6,
  );
  for (const recipe of catalogue.recipes) assert.ok(validateRecipe(recipe), recipe.recipeId);
  assert.equal(getRecipe('53064')?.title, 'Fettuccine Alfredo');
  assert.equal(getRecipe('52835')?.title, 'Fettucine alfredo');
  assert.equal(getRecipe('Fettuccine Alfredo'), undefined);
  assert.equal(getRecipe('53076')?.instructions[0]?.rawText, 'Make and enjoy');
});

test('source membership is recipe-specific and rejects malformed discriminated citations', () => {
  assert.ok(catalogueBoundary.hasSource({ recipeId: '53064', section: 'recipe' }));
  assert.ok(catalogueBoundary.hasSource({ recipeId: '53064', section: 'ingredient', position: 6 }));
  assert.equal(
    catalogueBoundary.hasSource({ recipeId: '53150', section: 'ingredient', position: 6 }),
    false,
  );
  assert.ok(
    catalogueBoundary.hasSource({ recipeId: '53262', section: 'instruction', position: 2 }),
  );
  assert.equal(
    catalogueBoundary.hasSource({ recipeId: '53076', section: 'instruction', position: 2 }),
    false,
  );
  for (const reference of [
    { recipeId: '99999', section: 'recipe' },
    { recipeId: '53064', section: 'recipe', position: 1 },
    { recipeId: '53064', section: 'ingredient', position: 0 },
    { recipeId: '53064', section: 'ingredient', position: 1.5 },
    { recipeId: '53064', section: 'ingredient', position: '1' },
    { recipeId: '53064', section: 'ingredient' },
    { recipeId: '53064', section: 'annotation', annotationId: 'invented' },
    { recipeId: '53064', section: 'unknown' },
    null,
  ])
    assert.equal(catalogueBoundary.hasSource(reference as SourceReference), false);
});

test('annotation IDs resolve only under their owning recipe', () => {
  const recipe = fixture();
  recipe.annotations = [
    {
      annotationId: 'fixture-note',
      recipeId: recipe.recipeId,
      kind: 'source_gap',
      note: 'Synthetic test notice.',
      evidence: [{ sheet: 'Recipes', row: 51 }],
      ruleVersion: 'fixture-v1',
    },
  ];
  const secondRecipe = JSON.parse(JSON.stringify(getRecipe('52835'))) as Recipe;
  const local = createCatalogue({ identity: catalogue.identity, recipes: [recipe, secondRecipe] });
  assert.ok(
    local.boundary.hasSource({
      recipeId: '53064',
      section: 'annotation',
      annotationId: 'fixture-note',
    }),
  );
  assert.equal(
    local.boundary.hasSource({
      recipeId: '52835',
      section: 'annotation',
      annotationId: 'fixture-note',
    }),
    false,
  );
});

test('reviewed runtime notes preserve source amounts, missing measures and the alternative garnish', () => {
  const annotations = catalogue.recipes.flatMap((recipe) => recipe.annotations);
  for (const annotation of annotations) {
    assert.ok(
      catalogueBoundary.hasSource({
        recipeId: annotation.recipeId,
        section: 'annotation',
        annotationId: annotation.annotationId,
      }),
    );
    if (annotation.kind === 'missing_measure') {
      const position = Number(annotation.annotationId.split('-').at(-1));
      const ingredient = getRecipe(annotation.recipeId)?.ingredients.find(
        (entry) => entry.position === position,
      );
      assert.equal(ingredient?.rawMeasure, null);
      assert.ok(annotation.note.includes(ingredient!.rawName));
    }
  }
  assert.ok(getRecipe('53076')?.annotations.some((note) => note.kind === 'limited_instructions'));
  assert.ok(
    getRecipe('53262')?.annotations.some(
      (note) => note.kind === 'instruction_only_ingredient' && note.note.includes('1½ tsp'),
    ),
  );
  const otherAlfredo = getRecipe('52835')!;
  assert.ok(
    otherAlfredo.annotations.some(
      (note) => note.kind === 'instruction_only_ingredient' && note.note.includes('2 tsp'),
    ),
  );
  assert.ok(
    otherAlfredo.annotations.some(
      (note) => note.annotationId === '52835-alternative-garnish' && note.kind === 'source_gap',
    ),
  );
  assert.equal(otherAlfredo.ingredients.length, 7);
  assert.ok(otherAlfredo.ingredients.some((ingredient) => ingredient.rawName === 'Parsley'));
  assert.equal(
    otherAlfredo.annotations.some(
      (note) => note.kind === 'instruction_only_ingredient' && /chives|parsley/i.test(note.note),
    ),
    false,
  );
});

test('photo uncertainty has explicit source notes without image-inferred ingredient demand', () => {
  for (const recipeId of ['53230', '53208']) {
    const treatment = getRecipePhotoTreatment(recipeId)!;
    assert.equal(treatment.preserveFullFrame, true);
    const note = getRecipe(recipeId)?.annotations.find(
      (item) => item.annotationId === treatment.warningAnnotationId,
    );
    assert.equal(note?.kind, 'source_gap');
    assert.match(note!.note, /may not match/);
  }
  assert.equal(getRecipe('53208')?.category, 'Vegetarian');
  assert.equal(
    getRecipe('53208')?.ingredients.some((item) => /prawn|shrimp/i.test(item.rawName)),
    false,
  );
  const salt = getRecipe('53230')!.annotations.find(
    (item) => item.kind === 'instruction_only_ingredient',
  );
  assert.match(salt!.note, /large pinch of salt/);
  assert.ok(
    salt!.evidence.some((locator) => locator.sheet === 'Instructions' && locator.row === 499),
  );
  assert.equal(getRecipe('53230')?.ingredients.length, 10);
  assert.equal(
    getRecipePhotoTreatment('53262')?.creditAnnotationId,
    '53262-image-credit-distinction',
  );
  assert.equal(getRecipePhotoTreatment('53262')?.warningAnnotationId, null);
  assert.equal(getRecipePhotoTreatment('53064')?.preserveFullFrame, false);
  assert.equal(getRecipePhotoTreatment('missing'), undefined);
  assert.equal(Object.isFrozen(getRecipePhotoTreatment('53208')), true);
});

test('invalid joins, duplicate identities and reordered passages fail before publication', () => {
  const duplicate = fixture();
  assert.throws(
    () => createCatalogue({ identity: catalogue.identity, recipes: [duplicate, duplicate] }),
    /Duplicate recipe/,
  );
  const wrongOwner = fixture();
  wrongOwner.ingredients[0].recipeId = '52835';
  assert.throws(
    () => createCatalogue({ identity: catalogue.identity, recipes: [wrongOwner] }),
    /ownership/,
  );
  const wrongOrder = fixture();
  wrongOrder.instructions[0].sequence = 2;
  assert.throws(
    () => createCatalogue({ identity: catalogue.identity, recipes: [wrongOrder] }),
    /order/,
  );
  assert.throws(
    () => createCatalogue({ identity: catalogue.identity, recipes: [{}] }),
    /Invalid prepared recipe/,
  );
});

test('callers cannot change source data or boundary membership after construction', () => {
  const source = fixture();
  const local = createCatalogue({ identity: catalogue.identity, recipes: [source] });
  source.title = 'Changed caller copy';
  assert.equal(local.getRecipe('53064')?.title, 'Fettuccine Alfredo');
  assert.ok(Object.isFrozen(local.getRecipe('53064')?.ingredients[0]));
  assert.equal('add' in local.boundary.recipeIds, false);
  assert.deepEqual([...local.boundary.recipeIds], ['53064']);
  local.boundary.recipeIds.forEach((_value, _key, ids) => assert.equal('add' in ids, false));
  assert.throws(() => Set.prototype.add.call(local.boundary.recipeIds, '99999'));
  assert.equal(local.boundary.recipeIds.valueOf(), local.boundary.recipeIds);
});

test('prepared identity covers source provenance and every runtime record', () => {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : value;
  const serialized = JSON.stringify(canonical({ provenance, recipes: prepared.recipes })) + '\n';
  assert.equal(
    createHash('sha256').update(serialized).digest('hex'),
    catalogue.identity.fingerprint,
  );
});

test('every packaged photo preserves original bytes and has a literal native asset mapping', async () => {
  const assetModule = await readFile(new URL('../src/photo-assets.ts', import.meta.url), 'utf8');
  for (const asset of provenance.assets) {
    const bytes = await readFile(new URL('../' + asset.packagedPath, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.recipeId);
    assert.ok(assetModule.includes(`'${asset.recipeId}': require('../${asset.packagedPath}')`));
    assert.equal(getRecipe(asset.recipeId)?.photoKey, asset.photoKey);
  }
});

test('v2 adds only three source gaps with exact reviewed text, owners and individual evidence cells', () => {
  assert.equal(catalogue.identity.version, 'cookmate-2026-09-28.v2');
  assert.equal(reviewedNotes.length, 20);
  assert.deepEqual(reviewedNotes.slice(17), approvedAdditions);
  assert.deepEqual(
    reviewedNotes.slice(0, 17).map((note) => note.annotationId),
    [
      '53262-instruction-only-salt',
      '53150-instruction-only-salt',
      '53064-instruction-only-salt',
      '52835-instruction-only-salt',
      '52835-instruction-only-black-pepper',
      '52835-alternative-garnish',
      '53076-limited-instructions',
      '53262-image-credit-distinction',
      '53138-missing-measure-7',
      '53064-missing-measure-6',
      '52957-missing-measure-4',
      '52957-missing-measure-6',
      '52957-missing-measure-7',
      '52957-missing-measure-8',
      '53230-photo-uncertainty',
      '53208-photo-uncertainty',
      '53230-instruction-only-salt',
    ],
  );
  const locators = (sheet: string, rows: number[], columns: string[] = ['D']) =>
    rows.flatMap((row) => columns.map((column) => ({ sheet, row, column })));
  const expectedEvidence = [
    [...locators('Recipes', [12], ['F', 'I']), ...locators('Instructions', [43, 44, 48, 49])],
    [
      ...locators('Recipes', [101], ['F', 'I']),
      ...locators('Ingredients', [914, 915, 916, 917, 918, 919, 920, 921, 922]),
      ...locators('Instructions', [667, 673]),
    ],
    [
      ...locators('Ingredients', [799, 800, 801, 802, 803, 804], ['D', 'E']),
      ...locators('Instructions', [566, 568, 570, 572, 574]),
    ],
  ];
  for (const [index, note] of approvedAdditions.entries()) {
    assert.equal(note.kind, 'source_gap');
    assert.equal(note.ruleVersion, 'reviewed-source-gaps-v1');
    assert.deepEqual(note.evidence, expectedEvidence[index]);
    assert.deepEqual(
      getRecipe(note.recipeId)?.annotations.find((item) => item.annotationId === note.annotationId),
      note,
    );
    for (const recipe of catalogue.recipes) {
      assert.equal(
        catalogueBoundary.hasSource({
          recipeId: recipe.recipeId,
          section: 'annotation',
          annotationId: note.annotationId,
        }),
        recipe.recipeId === note.recipeId,
      );
    }
  }
  assert.equal(reviewedNotes.filter((note) => note.kind === 'source_gap').length, 7);
  assert.equal(
    reviewedNotes.filter((note) => note.kind === 'instruction_only_ingredient').length,
    6,
  );
  assert.equal(reviewedNotes.filter((note) => note.kind === 'missing_measure').length, 6);
  assert.equal(reviewedNotes.filter((note) => note.kind === 'limited_instructions').length, 1);
});

test('both added photo warnings retain full frames and are separate from the Carbonara content note', () => {
  for (const recipeId of ['53389', '53318']) {
    const treatment = getRecipePhotoTreatment(recipeId)!;
    assert.equal(treatment.preserveFullFrame, true);
    assert.equal(treatment.warningAnnotationId, `${recipeId}-photo-uncertainty`);
    assert.equal(treatment.creditAnnotationId, null);
    assert.match(
      getRecipe(recipeId)!.annotations.find(
        (note) => note.annotationId === treatment.warningAnnotationId,
      )!.note,
      /may show a different preparation/,
    );
  }
  assert.equal(provenance.photoTreatment.exceptions.length, 5);
  assert.equal(
    provenance.photoTreatment.exceptions.filter((entry) => entry.warningAnnotationId !== null)
      .length,
    4,
  );
  assert.equal(
    provenance.photoTreatment.exceptions.filter((entry) => entry.creditAnnotationId !== null)
      .length,
    1,
  );
  assert.equal(getRecipePhotoTreatment('52982')?.warningAnnotationId, null);
  assert.deepEqual(
    getRecipe('52982')?.annotations.map((note) => note.annotationId),
    ['52982-ingredient-method-conflict'],
  );
});
