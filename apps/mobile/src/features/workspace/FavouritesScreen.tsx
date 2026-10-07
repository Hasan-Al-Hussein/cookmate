import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getRecipe, type CatalogueRecipe } from '@cookmate/catalogue';
import { Page, PageHeader, usePageStyles } from '../../components/Page';
import { ActionButton, Notice, SegmentControl, useControlStyles } from '../../components/Controls';
import { AppText, EditorialAccent } from '../../components/Typography';
import { AppIcon } from '../../components/Icon';
import { RecipeCard } from '../../components/RecipeCard';
import { SavedRecipeRow } from './SavedRecipeRow';
import { recipeSearch } from '../discover/DiscoverState';
import { useFavourites } from './FavouritesState';
import { QueryFeedback, WorkspaceFeedback } from './WorkspaceFeedback';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { usePersonalPorts } from '../personal/PersonalUI';
import { sortSavedRecipes } from '../personal/sortSavedRecipes';
import { useOrdinaryWorkspaceActions } from '../content/useOrdinaryWorkspace';
import { contentFavouritesList } from './ordinaryFavouritesModel';
import { ContentFavouriteCard } from './ContentFavouriteCard';
import type { ContentFavouriteEntry } from '../../data/contentWorkspaceQueries';

export function EmptyFavourites() {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.empty}>
      <View style={styles.heart}>
        <AppIcon name="heart" size={32} color={t.color.brandText} />
      </View>
      <AppText role="section" style={styles.centered}>
        Keep your next good idea here.
      </AppText>
      <AppText color="inkSecondary" style={styles.centered}>
        Tap a recipe’s heart to save it for another day.
      </AppText>
    </View>
  );
}

export function FavouritesScreen() {
  const { scopeKey } = useOrdinaryWorkspaceActions();
  return <FavouritesList key={scopeKey} />;
}

type SavedItem = { recipeId: string } & (
  | { kind: 'bundled'; recipe: CatalogueRecipe }
  | { kind: 'content'; entry: ContentFavouriteEntry }
);
function FavouritesList() {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();
  const controlStyles = useControlStyles();

  const { state, retry, contentState } = useFavourites();
  const router = useRouter();
  const { columns } = useNativeLayout();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sort, setSort] = useState<'recent' | 'alphabetical'>('recent');
  const personal = usePersonalPorts();
  const searchField = useRef<TextInput>(null);
  useEffect(() => {
    if (searchOpen) searchField.current?.focus();
  }, [searchOpen]);
  const entries = state.kind === 'ready' ? state.value : state.previous;
  const contentEntries =
    contentState?.kind === 'ready' ? contentState.value : contentState?.previous;
  const recipes: SavedItem[] = contentState
    ? (contentEntries ?? []).map((entry) => ({
        kind: 'content',
        recipeId: entry.favourite.recipeId,
        entry,
      }))
    : sortSavedRecipes(entries ?? [], sort)
        .map((entry) => getRecipe(entry.recipeId))
        .filter((recipe): recipe is CatalogueRecipe => !!recipe)
        .map((recipe) => ({ kind: 'bundled', recipeId: recipe.recipeId, recipe }));
  const smallCollection = recipes.length <= 2;
  const displayColumns = smallCollection ? 1 : columns;
  const list = useRef<FlatList<SavedItem>>(null);
  const scrollOffset = useRef(0);
  const pendingOffset = useRef<number | null>(null);
  const previousColumns = useRef(displayColumns);
  const viewportHeight = useRef(0);
  const cancelScrollRestore = () => {
    pendingOffset.current = null;
  };
  useLayoutEffect(() => {
    if (previousColumns.current !== displayColumns) {
      // FlatList requires a remount when numColumns changes; retain its reading position.
      pendingOffset.current = scrollOffset.current;
      previousColumns.current = displayColumns;
    }
  }, [displayColumns]);
  const search = useMemo(() => {
    if (contentState) {
      try {
        return {
          ids: new Set(
            contentFavouritesList(contentEntries ?? [], sort, query).map(
              (entry) => entry.favourite.recipeId,
            ),
          ),
          failed: false,
        };
      } catch {
        return { ids: null, failed: true };
      }
    }
    if (!query.trim()) return { ids: null, failed: false };
    try {
      return {
        ids: new Set(recipeSearch.search({ query }).matches.map((match) => match.recipeId)),
        failed: false,
      };
    } catch {
      return { ids: null, failed: true };
    }
  }, [query, contentState, contentEntries, sort]);
  if (contentState && !search.failed) {
    const order = new Map([...(search.ids ?? [])].map((id, index) => [id, index]));
    recipes.sort(
      (a, b) => (order.get(a.recipeId) ?? Infinity) - (order.get(b.recipeId) ?? Infinity),
    );
  }
  const visibleRecipes = search.failed
    ? []
    : search.ids
      ? recipes.filter((recipe) => search.ids!.has(recipe.recipeId))
      : recipes;
  const showSearch = searchOpen || !!query || recipes.length >= 6;
  return (
    <Page scroll={false}>
      <FlatList
        ref={list}
        key={displayColumns}
        data={visibleRecipes}
        numColumns={displayColumns}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(recipe) => recipe.recipeId}
        initialNumToRender={6}
        maxToRenderPerBatch={8}
        windowSize={7}
        onLayout={(event) => {
          viewportHeight.current = event.nativeEvent.layout.height;
        }}
        onScroll={(event) => {
          if (pendingOffset.current === null)
            scrollOffset.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        onScrollBeginDrag={cancelScrollRestore}
        onTouchStart={cancelScrollRestore}
        {...(Platform.OS === 'web'
          ? {
              // RN Web does not emit ScrollView's native drag-begin event.
              onWheel: cancelScrollRestore,
              onPointerDown: cancelScrollRestore,
              onKeyDown: cancelScrollRestore,
            }
          : {})}
        onContentSizeChange={(_width, height) => {
          if (pendingOffset.current === null) return;
          const offset = Math.min(
            pendingOffset.current,
            Math.max(0, height - viewportHeight.current),
          );
          // Virtualized content can first measure only its initial batch. Advance into
          // that batch, but keep the target until later measurements can reach it.
          if (offset === pendingOffset.current) pendingOffset.current = null;
          scrollOffset.current = offset;
          list.current?.scrollToOffset({ offset, animated: false });
        }}
        contentContainerStyle={pageStyles.content}
        ListHeaderComponent={
          <View style={pageStyles.section}>
            <PageHeader title="Favourites" />
            <WorkspaceFeedback />
            <AppText role="title">
              Good ideas,{'\n'}
              <EditorialAccent>kept close.</EditorialAccent>
            </AppText>
            {state.kind === 'ready' && state.value.length > 0 && (
              <AppText role="support" color="inkSecondary">
                {state.value.length} saved {state.value.length === 1 ? 'recipe' : 'recipes'} for
                another day.
              </AppText>
            )}
            <QueryFeedback state={state} retry={retry} noun="favourites" />
            <View style={styles.toolbar}>
              {(recipes.length > 0 || query.length > 0) &&
                (showSearch ? (
                  <TextInput
                    ref={searchField}
                    accessibilityLabel="Search saved recipes"
                    placeholder="Search saved recipes"
                    placeholderTextColor={t.color.inkSecondary}
                    value={query}
                    onChangeText={setQuery}
                    autoCorrect={false}
                    style={[controlStyles.field, styles.searchField]}
                  />
                ) : (
                  <ActionButton
                    label="Search saved recipes"
                    variant="quiet"
                    style={styles.searchButton}
                    onPress={() => setSearchOpen(true)}
                  />
                ))}
              {(personal || contentState) && (
                <ActionButton
                  label="Collections"
                  accessibilityLabel="Your collections"
                  variant="quiet"
                  onPress={() => router.push('/collections')}
                />
              )}
            </View>
            {!!query && (
              <ActionButton
                label="Clear saved search"
                variant="quiet"
                style={styles.clearSearch}
                onPress={() => setQuery('')}
              />
            )}
            {recipes.length > 1 && (
              <SegmentControl
                value={sort}
                options={[
                  { value: 'recent', label: 'Recently saved' },
                  { value: 'alphabetical', label: 'Alphabetical' },
                ]}
                onChange={setSort}
              />
            )}
            {!contentState && entries && recipes.length !== entries.length && (
              <Notice title="A saved recipe is unavailable" tone="caution">
                Its reference is retained. The other saved recipes are shown below.
              </Notice>
            )}
            {state.kind === 'ready' && state.value.length === 0 && <EmptyFavourites />}
            {search.failed && (
              <Notice title="Couldn’t search saved recipes" tone="error">
                Your text is kept. Shorten your search or clear it and try again.
              </Notice>
            )}
            {state.kind === 'ready' &&
              recipes.length > 0 &&
              !!query.trim() &&
              !search.failed &&
              visibleRecipes.length === 0 && (
                <Notice title="No saved recipes match">
                  Try another dish, ingredient or cuisine, or clear your search. Your saved recipes
                  are still here.
                </Notice>
              )}
          </View>
        }
        renderItem={({ item }) => (
          <View
            style={{
              width: `${100 / displayColumns}%`,
              paddingHorizontal: t.space.xxs,
              paddingBottom: t.space.lg,
            }}
          >
            {item.kind === 'content' ? (
              <ContentFavouriteCard
                entry={item.entry}
                small={smallCollection}
                enabled={state.kind === 'ready'}
              />
            ) : smallCollection ? (
              <SavedRecipeRow recipe={item.recipe} />
            ) : (
              <RecipeCard recipe={item.recipe} favouriteCollection presentation="editorial" />
            )}
          </View>
        )}
        ListFooterComponent={
          <ActionButton
            label="Explore recipes"
            variant="quiet"
            onPress={() => router.navigate('/')}
          />
        }
      />
    </Page>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: t.space.xs },
    searchField: { flexGrow: 1, flexShrink: 1, flexBasis: 190, minWidth: 0 },
    searchButton: { flexGrow: 1, flexShrink: 1 },
    clearSearch: { alignSelf: 'flex-start' },
    empty: {
      alignItems: 'center',
      gap: t.space.md,
      paddingVertical: t.space.xxl,
      paddingHorizontal: t.space.sm,
    },
    heart: {
      width: 76,
      height: 76,
      borderRadius: 38,
      backgroundColor: t.color.selection,
      alignItems: 'center',
      justifyContent: 'center',
    },
    centered: { textAlign: 'center' },
  });
