import { getRecipePhotoTreatment, type CatalogueRecipe } from '@cookmate/catalogue';

export type SourceInstruction = CatalogueRecipe['instructions'][number];
type SourceNote = CatalogueRecipe['annotations'][number];

function instructionNotes(recipe: CatalogueRecipe) {
  const photo = getRecipePhotoTreatment(recipe.recipeId);
  return recipe.annotations.filter(
    (note) =>
      note.kind !== 'missing_measure' &&
      note.annotationId !== photo?.warningAnnotationId &&
      note.annotationId !== photo?.creditAnnotationId,
  );
}

function matchesPassageSource(locator: SourceInstruction['source'], passage: SourceInstruction) {
  return (
    locator.sheet === 'Instructions' &&
    locator.sheet === passage.source.sheet &&
    locator.row === passage.source.row &&
    (locator.column === undefined ||
      passage.source.column === undefined ||
      locator.column === passage.source.column)
  );
}

function citesPassage(note: SourceNote, passage: SourceInstruction) {
  return note.evidence.some((locator) => matchesPassageSource(locator, passage));
}

function needsMappingReview(recipe: CatalogueRecipe, note: SourceNote) {
  return (
    !note.evidence.length ||
    note.evidence.some(
      (locator) =>
        locator.sheet === 'Instructions' &&
        recipe.instructions.filter((passage) => matchesPassageSource(locator, passage)).length !==
          1,
    )
  );
}

/** Use reviewed worksheet evidence, never keyword guesses or cosmetic section numbers. */
export function getPassageSourceNotes(recipe: CatalogueRecipe, passage: SourceInstruction) {
  return instructionNotes(recipe).filter(
    (note) => !needsMappingReview(recipe, note) && citesPassage(note, passage),
  );
}

/** Unmapped guidance stays visible: absence of a usable locator is not evidence of safety. */
export function getUnplacedInstructionNotes(recipe: CatalogueRecipe) {
  return instructionNotes(recipe).filter(
    (note) =>
      needsMappingReview(recipe, note) ||
      !recipe.instructions.some((passage) => citesPassage(note, passage)),
  );
}

/** General ingredient/recipe evidence is legitimate; only missing/ambiguous mapping is flagged. */
export function getInstructionNotesNeedingMappingReview(recipe: CatalogueRecipe) {
  return instructionNotes(recipe).filter((note) => needsMappingReview(recipe, note));
}
