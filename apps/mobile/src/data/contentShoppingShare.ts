import {
  canonicalContentJson,
  ContentValidationError,
  validateRecipeContentRef,
  type AuthoredContentProvenance,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
  type RetainedSourceNotice,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import { freezeResult } from './query';
import { byteLength } from './contentReleaseStoreSchema';
import { REVISION_SHOPPING_LIMITS } from './revisionShoppingProjection';

export type ContentShoppingShareRecipe = Pick<
  ReadingRecipe,
  'contentRef' | 'contentKind' | 'title' | 'recipePage' | 'originalSourceUrl'
> & {
  credits: AuthoredContentProvenance['credits'];
  retainedSources: (Pick<RetainedSourceNotice, 'ref' | 'disposition'> &
    Pick<
      RetainedSourceNotice['document']['recipe'],
      'title' | 'recipePage' | 'originalSourceUrl'
    >)[];
};
export type ContentShoppingShare =
  | { kind: 'ready'; recipes: readonly Immutable<ContentShoppingShareRecipe>[] }
  | { kind: 'unavailable'; reason: 'too_large' };

/** Called only inside the existing verified reservation; references alone do not authorize source data. */
export function buildContentShoppingShare(
  refs: readonly Immutable<RecipeContentRef>[],
  lookupExact: (ref: RecipeContentRef) => ReadingLookup,
): Immutable<ContentShoppingShare> {
  if (refs.length > REVISION_SHOPPING_LIMITS.occurrences)
    throw new ContentValidationError('shopping_share_selection');
  const seen = new Set<string>();
  const recipes: Immutable<ContentShoppingShareRecipe>[] = [];
  // Include the envelope and array punctuation in the same source-metadata byte budget.
  let bytes = byteLength('{"kind":"ready","recipes":[]}');
  try {
    for (const ref of refs) {
      if (!validateRecipeContentRef(ref))
        throw new ContentValidationError('shopping_share_reference');
      const key = canonicalContentJson(ref, 1024);
      if (seen.has(key)) continue;
      seen.add(key);
      const reading = lookupExact(ref);
      if (
        reading.kind !== 'readable' ||
        canonicalContentJson(reading.recipe.contentRef, 1024) !== key
      )
        throw new ContentValidationError('shopping_share_source_unavailable');
      const recipe = reading.recipe;
      const projected = {
        contentRef: recipe.contentRef,
        contentKind: recipe.contentKind,
        title: recipe.title,
        recipePage: recipe.recipePage,
        originalSourceUrl: recipe.originalSourceUrl,
        credits:
          recipe.provenance.kind === 'authored'
            ? recipe.provenance.credits.map(({ label, url }) => ({ label, url }))
            : [],
        retainedSources: recipe.retainedSources.map(
          ({ ref: sourceRef, disposition, document }) => ({
            ref: sourceRef,
            disposition,
            title: document.recipe.title,
            recipePage: document.recipe.recipePage,
            originalSourceUrl: document.recipe.originalSourceUrl,
          }),
        ),
      };
      const remaining = REVISION_SHOPPING_LIMITS.sourceBytes - bytes - (recipes.length ? 1 : 0);
      if (remaining <= 0) return Object.freeze({ kind: 'unavailable', reason: 'too_large' });
      const encoded = canonicalContentJson(projected, remaining);
      bytes += byteLength(encoded) + (recipes.length ? 1 : 0);
      recipes.push(freezeResult(JSON.parse(encoded) as ContentShoppingShareRecipe));
    }
  } catch (error) {
    if (error instanceof ContentValidationError && ['json_size', 'json_bound'].includes(error.code))
      return Object.freeze({ kind: 'unavailable', reason: 'too_large' });
    throw error;
  }
  return Object.freeze({ kind: 'ready', recipes: Object.freeze(recipes) });
}
