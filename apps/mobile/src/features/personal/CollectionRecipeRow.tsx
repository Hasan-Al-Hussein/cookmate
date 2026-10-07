import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { getRecipe } from '@cookmate/catalogue';
import { canonicalContentJson, type ReadingLookup } from '@cookmate/catalogue/content';
import { RecipePhoto } from '../../components/RecipePhoto';
import { ActionButton } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useOptionalOrdinaryCatalogue } from '../content/OrdinaryCatalogue';
import { ExactRecipePhoto } from '../workspace/ExactRecipePhoto';
import { usePersonalStyles } from './PersonalUI';

export function CollectionRecipeRow({
  recipeId,
  mode,
  isCurrent,
  onRemove,
  disabled = false,
  labelOnly = false,
}: {
  recipeId: string;
  mode: 'bundled' | 'content';
  isCurrent(): boolean;
  onRemove?: () => void;
  disabled?: boolean;
  labelOnly?: boolean;
}) {
  const styles = usePersonalStyles(),
    router = useRouter(),
    catalogue = useOptionalOrdinaryCatalogue();
  const reader = catalogue?.reader,
    snapshot = catalogue?.state;
  const mounted = useRef(true),
    latest = useRef({ recipeId, reader, snapshot, isCurrent });
  latest.current = { recipeId, reader, snapshot, isCurrent };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const owns = useCallback(() => {
    if (
      !mounted.current ||
      !isCurrent() ||
      latest.current.recipeId !== recipeId ||
      latest.current.reader !== reader ||
      latest.current.snapshot !== snapshot ||
      latest.current.isCurrent !== isCurrent
    )
      return false;
    if (mode === 'bundled') return true;
    try {
      return (
        !!reader &&
        snapshot?.kind === 'ready' &&
        snapshot.mode === 'content' &&
        reader.getSnapshot() === snapshot
      );
    } catch {
      return false;
    }
  }, [recipeId, reader, snapshot, isCurrent, mode]);
  const [loaded, setLoaded] = useState<{
    reader: typeof reader;
    snapshot: typeof snapshot;
    recipeId: string;
    lookup: ReadingLookup | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if (mode !== 'content' || !reader || !owns()) return;
    void reader
      .readSavedIdentity(recipeId)
      .then((lookup) => {
        if (active && owns() && (lookup.kind !== 'readable' || lookup.recipe.recipeId === recipeId))
          setLoaded({ reader, snapshot, recipeId, lookup });
      })
      .catch(() => {
        if (active && owns()) setLoaded({ reader, snapshot, recipeId, lookup: null });
      });
    return () => {
      active = false;
    };
  }, [recipeId, mode, reader, snapshot, owns]);
  const exact =
    loaded?.reader === reader &&
    loaded?.snapshot === snapshot &&
    loaded?.recipeId === recipeId &&
    owns() &&
    loaded.lookup?.kind === 'readable'
      ? loaded.lookup.recipe
      : null;
  const bundled = mode === 'bundled' ? getRecipe(recipeId) : undefined;
  const pending =
    mode === 'content' &&
    owns() &&
    (loaded?.reader !== reader || loaded?.snapshot !== snapshot || loaded?.recipeId !== recipeId);
  const title =
    exact?.title ??
    bundled?.title ??
    (pending ? 'Loading saved recipe…' : `Unavailable recipe · ${recipeId}`);
  if (labelOnly) return <AppText role="support">{title}</AppText>;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        {(exact || bundled) && (
          <View style={styles.photo}>
            {exact ? (
              <ExactRecipePhoto contentRef={exact.contentRef} compact aspectRatio={1} />
            ) : (
              <RecipePhoto recipeId={recipeId} title={title} compact aspectRatio={1} />
            )}
          </View>
        )}
        <AppText role="section" style={styles.text}>
          {title}
        </AppText>
      </View>
      <View style={styles.actions}>
        {(exact || bundled) && (
          <ActionButton
            label={`View ${title}`}
            variant="quiet"
            onPress={() => {
              if (!owns()) return;
              router.push({
                pathname: '/recipe/[id]',
                params: {
                  id: recipeId,
                  ...(exact ? { contentRef: canonicalContentJson(exact.contentRef, 1024) } : {}),
                },
              });
            }}
          />
        )}
        {onRemove && (
          <ActionButton
            label={`Remove ${exact?.title ?? bundled?.title ?? recipeId} from collection`}
            variant="quiet"
            disabled={disabled}
            onPress={() => {
              if (mounted.current && isCurrent() && !disabled) onRemove();
            }}
          />
        )}
      </View>
    </View>
  );
}
