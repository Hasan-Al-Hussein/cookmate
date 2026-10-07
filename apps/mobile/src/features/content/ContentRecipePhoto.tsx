import { useEffect, useState } from 'react';
import { useIsFocused } from 'expo-router';
import type { Immutable } from '@cookmate/catalogue';
import { canonicalContentJson, type ReadingRecipe } from '@cookmate/catalogue/content';
import type { OrdinaryCatalogueController } from './ordinaryCatalogueState';
import { RecipePhotoFrame } from '../../components/RecipePhoto';
import { createContentPhotoResource } from './contentPhotoResource';
import { ContentPhotoCleanupError, type ContentPhotoResource } from './contentPhotoResourceTypes';

interface Props {
  recipe: Immutable<ReadingRecipe>;
  content: Pick<OrdinaryCatalogueController, 'readPhoto'>;
  /** Changes when the selected workspace, adopted head or withdrawal policy changes. */
  scopeKey: string;
  /** Recorded media from this exact revision. Omit for primary; null means no recorded photo. */
  assetId?: string | null;
  aspectRatio?: number;
  borderRadius?: number;
  compact?: boolean;
  /** Host retains this resource for a later cleanup retry; it must not discard the capability. */
  onCleanupFailure(resource: ContentPhotoResource): void;
}

/** Never substitutes a bundled photograph when the exact published photograph is unavailable. */
export function ContentRecipePhoto(props: Props) {
  const focused = useIsFocused();
  const photo = props.recipe.media.find((item) =>
    props.assetId === undefined
      ? item.photoKey === props.recipe.photoKey
      : item.assetId === props.assetId,
  );
  return (
    <Photo
      key={canonicalContentJson([
        props.scopeKey,
        props.recipe.contentRef,
        photo?.assetId ?? null,
        focused,
      ])}
      {...props}
      assetId={photo?.assetId ?? null}
      focused={focused}
    />
  );
}

function Photo({
  recipe,
  content,
  assetId,
  onCleanupFailure,
  focused,
  ...frame
}: Props & { assetId: string | null; focused: boolean }) {
  const [state, setState] = useState<{ uri?: string; loading: boolean }>({ loading: !!assetId });
  const readPhoto = content.readPhoto;
  useEffect(() => {
    let active = true;
    const request = new AbortController();
    let owned: ContentPhotoResource | undefined;
    if (!assetId || !focused) return;
    setState({ loading: true });
    void readPhoto(recipe.contentRef, assetId, request.signal)
      .then((result) => {
        if (!active) return;
        if (
          canonicalContentJson(result.value.contentRef) !==
            canonicalContentJson(recipe.contentRef) ||
          result.value.assetId !== assetId
        )
          throw new Error('Recipe photo identity differs');
        owned = createContentPhotoResource(result.value);
        setState({ uri: owned.uri, loading: false });
      })
      .catch((error: unknown) => {
        if (error instanceof ContentPhotoCleanupError) {
          owned = error.resource;
          onCleanupFailure(owned);
        }
        if (active) setState({ loading: false });
      });
    return () => {
      active = false;
      request.abort();
      if (owned && !owned.release()) onCleanupFailure(owned);
    };
  }, [readPhoto, recipe.contentRef, assetId, onCleanupFailure, focused]);
  const media = recipe.media.find((item) => item.assetId === assetId);
  const treatments = recipe.retainedSources
    .filter((source) =>
      source.document.media.some(
        (item) => item.assetId === media?.assetId && item.sha256 === media?.sha256,
      ),
    )
    .map((source) => source.document.provenance.photoTreatment);
  if (recipe.provenance.kind === 'imported') treatments.push(recipe.provenance.photoTreatment);
  return (
    <RecipePhotoFrame
      imageKey={state.uri ?? 'unavailable'}
      source={state.uri ? { uri: state.uri } : undefined}
      title={recipe.title}
      loading={state.loading}
      needsReview={treatments.some((treatment) => !!treatment.warningAnnotationId)}
      preserveFullFrame={treatments.some((treatment) => treatment.preserveFullFrame)}
      {...frame}
    />
  );
}
