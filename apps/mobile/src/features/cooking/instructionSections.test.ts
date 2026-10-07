import { catalogue, getRecipe } from '@cookmate/catalogue';
import { instructionSections, sectionForPassage } from './instructionSections';

test('every original passage in every supplied recipe occurs exactly once and in source order', () => {
  for (const recipe of catalogue.recipes) {
    const sections = instructionSections(recipe);
    expect(sections.flat()).toEqual(recipe.instructions);
    sections.forEach((section, index) =>
      section.forEach((passage) => {
        expect(sectionForPassage(sections, passage.sequence)).toBe(index);
      }),
    );
    expect(sectionForPassage(sections, -1)).toBeNull();
  }
});

test('preamble and source headings keep their existing grouping', () => {
  const recipe = getRecipe('53320');
  if (!recipe) throw new Error('Expected catalogue recipe');
  const sections = instructionSections(recipe);
  const firstHeading = recipe.instructions.findIndex(
    (passage) => passage.presentation === 'heading',
  );
  expect(firstHeading).toBeGreaterThan(0);
  expect(sections[0]).toEqual(recipe.instructions.slice(0, firstHeading));
  expect(sections[1]?.[0]?.presentation).toBe('heading');
});
