import { getRecipePhotoTreatment, type CatalogueRecipe } from '@cookmate/catalogue';

/** Keep photo warnings/credits on their existing presentation path. */
export function getRecipeSourceNotices(recipe: CatalogueRecipe) {
  const treatment = getRecipePhotoTreatment(recipe.recipeId);
  const seen = new Set<string>();
  return recipe.annotations.filter((note) => {
    if (
      note.kind !== 'source_gap' ||
      note.annotationId === treatment?.warningAnnotationId ||
      note.annotationId === treatment?.creditAnnotationId ||
      seen.has(note.annotationId)
    )
      return false;
    seen.add(note.annotationId);
    return true;
  });
}
