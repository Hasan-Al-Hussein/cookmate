import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  canonicalContentJson,
  type ReadingLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { AppText } from '../../components/Typography';
import { RecipePhoto } from '../../components/RecipePhoto';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { ContentRecipePhoto } from '../content/ContentRecipePhoto';
import { useOptionalOrdinaryCatalogue } from '../content/OrdinaryCatalogue';
import type {
  OrdinaryCatalogueController,
  OrdinaryCatalogueState,
} from '../content/ordinaryCatalogueState';
import { useRecentlyViewed } from './RecentlyViewedProvider';

/** A small exact-reference continuation, only mounted after the existing progress read is empty. */
export function RecentlyViewedRow() {
  const recent = useRecentlyViewed();
  const catalogue = useOptionalOrdinaryCatalogue();
  const styles = useThemedStyles(createStyles);
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setFocused(false);
      void recent
        .refresh()
        .then(() => {
          if (active) setFocused(true);
        })
        .catch(() => {
          /* Storage error remains available in privacy settings. */
        });
      return () => {
        active = false;
        setFocused(false);
      };
    }, [recent.refresh]),
  );
  if (!focused || !recent.hydrated || recent.error || !recent.entries.length) return null;
  const snapshot = catalogue?.state;
  const reader = catalogue?.reader;
  return (
    <View style={styles.section}>
      <AppText role="bodyStrong" accessibilityRole="header">
        Recently viewed
      </AppText>
      {reader && snapshot?.kind === 'ready' ? (
        recent.entries
          .slice(0, 3)
          .map((entry) => (
            <RecentRecipe
              key={canonicalContentJson(entry.ref, 1024)}
              contentRef={entry.ref}
              reader={reader}
              snapshot={snapshot}
            />
          ))
      ) : (
        <AppText role="support" color="inkSecondary">
          Your recent recipe versions cannot be checked while the recipe collection is unavailable.
        </AppText>
      )}
    </View>
  );
}

function RecentRecipe({
  contentRef,
  reader,
  snapshot,
}: {
  contentRef: Readonly<RecipeContentRef>;
  reader: OrdinaryCatalogueController;
  snapshot: Extract<OrdinaryCatalogueState, { kind: 'ready' }>;
}) {
  const t = useTheme(),
    styles = useThemedStyles(createStyles),
    router = useRouter();
  const key = canonicalContentJson(contentRef, 1024);
  const active = useRef(true);
  const latest = useRef({ reader, snapshot, key });
  latest.current = { reader, snapshot, key };
  const [result, setResult] = useState<{
    reader: OrdinaryCatalogueController;
    snapshot: typeof snapshot;
    key: string;
    lookup: ReadingLookup | null;
  } | null>(null);
  const current = useCallback(() => {
    if (
      !active.current ||
      latest.current.reader !== reader ||
      latest.current.snapshot !== snapshot ||
      latest.current.key !== key
    )
      return false;
    try {
      if (reader.getSnapshot() !== snapshot) return false;
      void snapshot.identity;
      return true;
    } catch {
      return false;
    }
  }, [reader, snapshot, key]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    if (!current()) return;
    void reader
      .readExact(contentRef)
      .then((lookup) => {
        if (live && current()) setResult({ reader, snapshot, key, lookup });
      })
      .catch(() => {
        if (live && current()) setResult({ reader, snapshot, key, lookup: null });
      });
    return () => {
      live = false;
    };
  }, [reader, snapshot, key, current, contentRef]);
  const readPhoto = useCallback<OrdinaryCatalogueController['readPhoto']>(
    async (ref, assetId, signal) => {
      if (!current() || canonicalContentJson(ref, 1024) !== key)
        throw new Error('Recent recipe changed');
      const value = await reader.readPhoto(ref, assetId, signal);
      if (!current()) throw new Error('Recent recipe changed');
      return value;
    },
    [reader, current, key],
  );
  const matching =
    result?.reader === reader && result?.snapshot === snapshot && result?.key === key && current();
  const lookup = result && matching ? result.lookup : null;
  const recipe =
    lookup?.kind === 'readable' && canonicalContentJson(lookup.recipe.contentRef, 1024) === key
      ? lookup.recipe
      : null;
  if (!recipe || lookup?.kind !== 'readable')
    return (
      <AppText role="support" color="inkSecondary">
        {!matching
          ? 'Checking a recently viewed recipe…'
          : lookup?.kind === 'withdrawn'
            ? 'A recently viewed recipe has been withdrawn.'
            : 'A recently viewed recipe version is unavailable.'}
      </AppText>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open recently viewed ${recipe.title}${lookup.state === 'archived' ? ', archived recipe' : lookup.state === 'historical' ? ', saved version' : ''}`}
      onPress={() => {
        if (current())
          router.push({
            pathname: '/recipe/[id]',
            params: { id: contentRef.recipeId, contentRef: key },
          });
      }}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.photo}>
        {snapshot.photoMode === 'bundled' ? (
          <RecipePhoto
            recipeId={recipe.recipeId}
            title={recipe.title}
            aspectRatio={1}
            compact
            borderRadius={t.radius.small}
          />
        ) : reader.onPhotoCleanupFailure ? (
          <ContentRecipePhoto
            recipe={recipe}
            content={{ readPhoto }}
            scopeKey={snapshot.scopeKey}
            onCleanupFailure={reader.onPhotoCleanupFailure}
            aspectRatio={1}
            compact
            borderRadius={t.radius.small}
          />
        ) : null}
      </View>
      <View style={styles.copy}>
        <AppText role="bodyStrong" numberOfLines={2}>
          {recipe.title}
        </AppText>
        {lookup.state !== 'current' && (
          <AppText role="support" color="inkSecondary">
            {lookup.state === 'archived' ? 'Archived recipe' : 'Previously opened version'}
          </AppText>
        )}
      </View>
    </Pressable>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm, minHeight: 56 },
    photo: { width: 56, flexShrink: 0 },
    copy: { flex: 1, minWidth: 0 },
    pressed: { opacity: 0.7 },
  });
