import { getRecipe } from '@cookmate/catalogue';
import type { Favourite, Immutable } from '@cookmate/domain';
/** Uses actual persisted savedAt, with deterministic identity ties. Never mutates query data. */
export function sortSavedRecipes(
  entries: readonly Immutable<Favourite>[],
  order: 'recent' | 'alphabetical',
): Immutable<Favourite>[] {
  return [...entries].sort((a, b) =>
    order === 'recent'
      ? b.savedAt.localeCompare(a.savedAt) || a.recipeId.localeCompare(b.recipeId)
      : (getRecipe(a.recipeId)?.title ?? a.recipeId).localeCompare(
          getRecipe(b.recipeId)?.title ?? b.recipeId,
        ) || a.recipeId.localeCompare(b.recipeId),
  );
}
