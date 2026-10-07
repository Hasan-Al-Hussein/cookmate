import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { ContentFavouriteEntry } from '../../data/contentWorkspaceQueries';
import { useOptionalOrdinaryCatalogue } from '../content/OrdinaryCatalogue';
import { RecipeCardFrame } from '../../components/RecipeCard';
import { SavedRecipeRowFrame } from './SavedRecipeRow';
import { ExactRecipePhoto } from './ExactRecipePhoto';
import { FavouriteButton } from './FavouritesState';
import { Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { favouriteTitle } from './ordinaryFavouritesModel';

export function ContentFavouriteCard({
  entry,
  small,
  enabled,
}: {
  entry: ContentFavouriteEntry;
  small: boolean;
  enabled: boolean;
}) {
  const catalogue = useOptionalOrdinaryCatalogue();
  const router = useRouter();
  const mounted = useRef(true);
  const snapshot = catalogue?.state;
  const reader = catalogue?.reader;
  const render = { entry, enabled, snapshot, reader };
  const latest = useRef(render);
  latest.current = render;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => {
    if (
      !mounted.current ||
      latest.current !== render ||
      !enabled ||
      !reader ||
      snapshot?.kind !== 'ready'
    )
      return false;
    try {
      if (reader.getSnapshot() !== snapshot) return false;
      void snapshot.identity;
      return true;
    } catch {
      return false;
    }
  };
  const { content, favourite } = entry;
  const title = favouriteTitle(entry);
  if (content.kind !== 'readable')
    return (
      <Notice
        title={
          content.reason === 'withdrawn' ? 'Saved recipe withdrawn' : 'Saved recipe unavailable'
        }
        tone="caution"
      >
        <AppText>{title}</AppText>
        <AppText role="support">
          Its saved reference is kept. You can remove it from Favourites without changing your
          planned meals.
        </AppText>
        <FavouriteButton
          recipeId={favourite.recipeId}
          title={title}
          restoreOnUnsave
          canSave={false}
        />
      </Notice>
    );
  const open = () => {
    if (current())
      router.push({
        pathname: '/recipe/[id]',
        params: {
          id: favourite.recipeId,
          contentRef: canonicalContentJson(content.contentRef, 1024),
        },
      });
  };
  const plan = () => {
    if (current() && content.state === 'current')
      router.push({
        pathname: '/plan-edit',
        params: {
          recipeId: favourite.recipeId,
          contentRef: canonicalContentJson(content.contentRef, 1024),
        },
      });
  };
  const status = content.state === 'archived' ? { status: 'Archived · saved recipe' } : {};
  const label = `Open ${title}, ${content.cuisine}${content.photoNeedsReview ? '. Photo needs review; see source notes' : ''}`;
  const save = (
    <FavouriteButton
      recipeId={favourite.recipeId}
      title={title}
      compact
      inline={small}
      restoreOnUnsave
      canSave={content.state === 'current'}
    />
  );
  const photo = (
    <ExactRecipePhoto
      contentRef={content.contentRef}
      aspectRatio={small ? 1 : 1.2}
      {...(!small ? { borderRadius: 0 } : {})}
    />
  );
  return small ? (
    <SavedRecipeRowFrame
      title={title}
      cuisine={content.cuisine}
      photo={photo}
      save={save}
      onOpen={open}
      accessibilityLabel={label}
      {...status}
      {...(content.state === 'current' ? { onPlan: plan } : {})}
    />
  ) : (
    <RecipeCardFrame
      title={title}
      cuisine={content.cuisine}
      photo={photo}
      save={save}
      onOpen={open}
      accessibilityLabel={label}
      presentation="editorial"
      {...status}
    />
  );
}
