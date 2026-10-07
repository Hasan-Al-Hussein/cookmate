import type { CatalogueRecipe, Immutable } from '@cookmate/catalogue';
import { getRecipePhotoTreatment } from '@cookmate/catalogue';
import type { ReadingRecipe } from '@cookmate/catalogue/content';
import { useOptionalOrdinaryCatalogue } from '../features/content/OrdinaryCatalogue';
import { ContentRecipePhoto } from '../features/content/ContentRecipePhoto';
import { RecipePhoto, RecipePhotoFrame } from './RecipePhoto';

export type OrdinaryRecipe = CatalogueRecipe | Immutable<ReadingRecipe>;

export function ordinaryPhotoNeedsReview(recipe: OrdinaryRecipe) {
  if (!('contentRef' in recipe))
    return !!getRecipePhotoTreatment(recipe.recipeId)?.warningAnnotationId;
  const photo = recipe.media.find((item) => item.photoKey === recipe.photoKey);
  return (
    (recipe.provenance.kind === 'imported' &&
      !!recipe.provenance.photoTreatment.warningAnnotationId) ||
    recipe.retainedSources.some(
      (source) =>
        source.document.media.some(
          (item) => item.assetId === photo?.assetId && item.sha256 === photo?.sha256,
        ) && !!source.document.provenance.photoTreatment.warningAnnotationId,
    )
  );
}

/** A content-backed card never looks up an image by bundled recipe ID. */
export function OrdinaryRecipePhoto({
  recipe,
  ...frame
}: {
  recipe: OrdinaryRecipe;
  aspectRatio?: number;
  borderRadius?: number;
  compact?: boolean;
}) {
  const context = useOptionalOrdinaryCatalogue();
  let matchesCurrent = false;
  if (context?.state.kind === 'ready') {
    try {
      const current = context.state.current(recipe.recipeId);
      matchesCurrent =
        !!current &&
        (!('contentRef' in recipe) ||
          (current.contentRef.recipeId === recipe.contentRef.recipeId &&
            current.contentRef.revisionId === recipe.contentRef.revisionId &&
            current.contentRef.contentFingerprint === recipe.contentRef.contentFingerprint));
    } catch {
      /* A revoked snapshot must not supply a photograph. */
    }
  }
  if (
    (!context && !('contentRef' in recipe)) ||
    (matchesCurrent && context?.state.kind === 'ready' && context.state.photoMode === 'bundled')
  )
    return <RecipePhoto recipeId={recipe.recipeId} title={recipe.title} {...frame} />;
  if (
    matchesCurrent &&
    context?.state.kind === 'ready' &&
    context.state.photoMode === 'verified' &&
    context.reader?.onPhotoCleanupFailure &&
    'contentRef' in recipe
  )
    return (
      <ContentRecipePhoto
        recipe={recipe}
        content={context.reader}
        scopeKey={context.state.scopeKey}
        onCleanupFailure={context.reader.onPhotoCleanupFailure}
        {...frame}
      />
    );
  return (
    <RecipePhotoFrame
      imageKey="ordinary-unavailable"
      source={undefined}
      title={recipe.title}
      loading={context?.state.kind === 'loading'}
      {...frame}
    />
  );
}
