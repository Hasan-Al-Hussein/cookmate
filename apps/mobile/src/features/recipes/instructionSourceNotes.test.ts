import { getRecipe, type CatalogueRecipe } from '@cookmate/catalogue';
import {
  getPassageSourceNotes,
  getUnplacedInstructionNotes,
  getInstructionNotesNeedingMappingReview,
} from './instructionSourceNotes';

test('salt guidance follows the cited instruction row, not the heading or another section', () => {
  const recipe = getRecipe('53262')!;
  expect(
    recipe.instructions
      .filter((passage) => getPassageSourceNotes(recipe, passage).length > 0)
      .map((passage) => passage.sequence),
  ).toEqual([2]);
  expect(getPassageSourceNotes(recipe, recipe.instructions[1]!)[0]?.annotationId).toBe(
    '53262-instruction-only-salt',
  );
  expect(getUnplacedInstructionNotes(recipe)).toEqual([]);
});

test('the reviewed ingredient-method conflict remains visible for every cited passage', () => {
  const recipe = getRecipe('52982')!;
  expect(
    recipe.instructions
      .filter((passage) => getPassageSourceNotes(recipe, passage).length > 0)
      .map((passage) => passage.sequence),
  ).toEqual([4, 6, 8, 10, 12]);
  expect(getUnplacedInstructionNotes(recipe)).toEqual([]);
});

test('similar Alfredo records retain their own salt, pepper and garnish evidence', () => {
  const recipe = getRecipe('52835')!;
  expect(
    recipe.instructions.map((passage) =>
      getPassageSourceNotes(recipe, passage).map((note) => note.annotationId),
    ),
  ).toEqual([
    [],
    ['52835-instruction-only-salt', '52835-instruction-only-black-pepper'],
    ['52835-instruction-only-salt'],
    ['52835-alternative-garnish'],
  ]);
  const other = getRecipe('53064')!;
  const otherNotes = other.instructions.flatMap((passage) => getPassageSourceNotes(other, passage));
  expect(otherNotes.every((note) => note.recipeId === other.recipeId)).toBe(true);
  expect(otherNotes.some((note) => note.kind === 'missing_measure')).toBe(false);
});

test('photo warnings stay out of passage notices even when they cite instruction rows', () => {
  for (const recipeId of ['53230', '53389', '53318']) {
    const recipe = getRecipe(recipeId)!;
    const notes = [
      ...getUnplacedInstructionNotes(recipe),
      ...recipe.instructions.flatMap((passage) => getPassageSourceNotes(recipe, passage)),
    ];
    expect(notes.some((note) => note.annotationId === `${recipeId}-photo-uncertainty`)).toBe(false);
  }
});

test('unresolvable warning evidence stays visible without guessing a passage or erasing text', () => {
  const original = getRecipe('53076')!;
  const warning = original.annotations.find((note) => note.kind === 'limited_instructions')!;
  const changed: CatalogueRecipe = {
    ...original,
    annotations: [{ ...warning, evidence: [{ sheet: 'Instructions', row: 999999, column: 'D' }] }],
  };
  expect(getPassageSourceNotes(changed, changed.instructions[0]!)).toEqual([]);
  expect(getUnplacedInstructionNotes(changed).map((note) => note.note)).toEqual([warning.note]);
  expect(original.instructions[0]!.rawText).toBe('Make and enjoy');
  expect(getPassageSourceNotes(original, original.instructions[0]!)).toEqual([warning]);
});

test('an ingredient row with the same row number cannot falsely attach a warning to instructions', () => {
  const original = getRecipe('53076')!;
  const warning = original.annotations[0]!;
  const changed: CatalogueRecipe = {
    ...original,
    annotations: [{ ...warning, evidence: [{ sheet: 'Ingredients', row: 149, column: 'D' }] }],
  };
  expect(getPassageSourceNotes(changed, changed.instructions[0]!)).toEqual([]);
  expect(getUnplacedInstructionNotes(changed)).toHaveLength(1);
});

test('different explicit columns keep a same-sheet, same-row warning unplaced and visible', () => {
  const original = getRecipe('53076')!;
  const warning = original.annotations[0]!;
  const changed: CatalogueRecipe = {
    ...original,
    annotations: [{ ...warning, evidence: [{ sheet: 'Instructions', row: 149, column: 'C' }] }],
  };
  expect(original.instructions[0]!.source).toEqual({
    sheet: 'Instructions',
    row: 149,
    column: 'D',
  });
  expect(getPassageSourceNotes(changed, changed.instructions[0]!)).toEqual([]);
  expect(getUnplacedInstructionNotes(changed).map((note) => note.note)).toEqual([warning.note]);
});

test('row-level evidence without an explicit column still resolves to the cited passage', () => {
  const original = getRecipe('53076')!;
  const warning = original.annotations[0]!;
  const changed: CatalogueRecipe = {
    ...original,
    annotations: [{ ...warning, evidence: [{ sheet: 'Instructions', row: 149 }] }],
  };
  expect(getPassageSourceNotes(changed, changed.instructions[0]!).map((note) => note.note)).toEqual(
    [warning.note],
  );
  expect(getUnplacedInstructionNotes(changed)).toEqual([]);
});

test('partially unresolved evidence keeps the whole warning visible without duplicating it beside a known passage', () => {
  const original = getRecipe('53076')!;
  const warning = original.annotations[0]!;
  const changed: CatalogueRecipe = {
    ...original,
    annotations: [
      {
        ...warning,
        evidence: [...warning.evidence, { sheet: 'Instructions', row: 999999, column: 'D' }],
      },
    ],
  };
  expect(getPassageSourceNotes(changed, changed.instructions[0]!)).toEqual([]);
  expect(getUnplacedInstructionNotes(changed).map((note) => note.note)).toEqual([warning.note]);
  expect(getInstructionNotesNeedingMappingReview(changed)).toEqual(changed.annotations);
});

test('ambiguous row-only evidence stays general and flagged instead of attaching to two passages', () => {
  const original = getRecipe('53076')!;
  const warning = original.annotations[0]!;
  const changed: CatalogueRecipe = {
    ...original,
    instructions: [
      original.instructions[0]!,
      {
        ...original.instructions[0]!,
        sequence: 2,
        source: { sheet: 'Instructions', row: 149, column: 'E' },
      },
    ],
    annotations: [{ ...warning, evidence: [{ sheet: 'Instructions', row: 149 }] }],
  };
  expect(
    changed.instructions.flatMap((passage) => getPassageSourceNotes(changed, passage)),
  ).toEqual([]);
  expect(getUnplacedInstructionNotes(changed)).toEqual(changed.annotations);
  expect(getInstructionNotesNeedingMappingReview(changed)).toEqual(changed.annotations);
});

test('missing mapping is flagged but legitimate ingredient-wide guidance is not', () => {
  const original = getRecipe('53076')!;
  // Defensive rendering of malformed external evidence; never a valid catalogue fixture.
  const missing = {
    ...original,
    annotations: [{ ...original.annotations[0]!, evidence: [] }],
  } as unknown as CatalogueRecipe;
  expect(getInstructionNotesNeedingMappingReview(missing)).toEqual(missing.annotations);
  const general: CatalogueRecipe = {
    ...original,
    annotations: [
      { ...original.annotations[0]!, evidence: [{ sheet: 'Ingredients', row: 149, column: 'D' }] },
    ],
  };
  expect(getUnplacedInstructionNotes(general)).toEqual(general.annotations);
  expect(getInstructionNotesNeedingMappingReview(general)).toEqual([]);
});
