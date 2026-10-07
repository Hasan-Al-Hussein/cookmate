import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { SEARCH_QUERY_MAX_LENGTH, type SearchCriteria } from '@cookmate/domain';
import { ActionButton, Notice, useControlStyles } from '../../components/Controls';
import { focusTarget } from '../../components/focusTarget';
import { RecipeCard } from '../../components/RecipeCard';
import type { OrdinaryRecipe } from '../../components/OrdinaryRecipePhoto';
import { SelectionIndicator } from '../../components/SelectionIndicator';
import { AppText } from '../../components/Typography';
import { AppIcon, IconButton } from '../../components/Icon';
import { controlStateProps } from '../../components/controlStateProps';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { FilterSheet } from './FilterSheet';
import { DiscoverHero } from './DiscoverHero';
import { RecipePick, pickRecipeId } from './RecipePick';
import { ContinueCooking } from './ContinueCooking';
import { ContentContinueCooking } from './ContentContinueCooking';
import { RecentlyViewedRow } from '../recently-viewed/RecentlyViewedRow';
import { useDiscoverCatalogue, useDiscoverState } from './DiscoverState';
import { WorkspaceFeedback } from '../workspace/WorkspaceFeedback';
import { AssistantInvitation } from '../assistant/AssistantPresentation';
import { searchContextLabel, useAssistantEntry } from '../assistant/AssistantEntryState';

// A source-backed editorial sequence, never a popularity or personalized ranking.
const openingIds = ['52819', '53150', '53064', '52835', '53307', '52957'];

export default function DiscoverScreen() {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const controlStyles = useControlStyles();

  const router = useRouter();
  const assistantEntry = useAssistantEntry();
  const { criteria, setCriteria, scrollOffset, setScrollOffset } = useDiscoverState();
  const source = useDiscoverCatalogue();
  const catalogue = source.ready;
  const catalogueUnavailable = !catalogue;
  const { columns } = useNativeLayout();
  const [filterScope, setFilterScope] = useState<string | null>(null);
  const filterSession = useRef<object | null>(null);
  const liveCatalogueScope = useRef(catalogue?.scopeKey ?? null);
  liveCatalogueScope.current = catalogue?.scopeKey ?? null;
  const filtersOpen = !!catalogue && filterScope === catalogue.scopeKey;
  const renderedFilterSession = filterSession.current;
  function closeFilters() {
    filterSession.current = null;
    setFilterScope(null);
  }
  useEffect(closeFilters, [catalogue?.scopeKey]);
  const [queryFocused, setQueryFocused] = useState(false);
  const [retryRevision, setRetryRevision] = useState(0);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const filtersButton = useRef<View>(null);
  const moreFiltersButton = useRef<View>(null);
  const filterOpener = useRef<View | null>(null);
  const list = useRef<FlatList<OrdinaryRecipe>>(null);
  const restoreOffset = useRef(scrollOffset.current);
  const active = !!(
    criteria.query?.trim() ||
    criteria.category ||
    criteria.cuisine ||
    criteria.ingredients?.length
  );
  const outcome = useMemo(() => {
    try {
      return { result: catalogue?.search(criteria), failed: false };
    } catch {
      return { result: undefined, failed: true };
    }
  }, [criteria, retryRevision, catalogue?.search]);
  const recipes = useMemo(
    () =>
      !catalogue
        ? []
        : active
          ? (outcome.result?.matches ?? [])
              .map((match) => catalogue.current(match.recipeId))
              .filter((recipe): recipe is OrdinaryRecipe => !!recipe)
          : [
              ...openingIds
                .map((id) => catalogue.current(id))
                .filter((recipe): recipe is OrdinaryRecipe => !!recipe),
              ...catalogue.recipes.filter((recipe) => !openingIds.includes(recipe.recipeId)),
            ],
    [active, outcome.result, catalogue?.current, catalogue?.recipes],
  );
  const suggestions = outcome.result?.suggestions ?? [];
  const pickedRecipe = !outcome.failed
    ? recipes.find((recipe) => recipe.recipeId === pickedId)
    : undefined;
  useEffect(() => {
    if (!outcome.failed && pickedId && !recipes.some((recipe) => recipe.recipeId === pickedId))
      setPickedId(null);
  }, [pickedId, recipes, outcome.failed]);
  function chooseRecipe() {
    if (outcome.failed || !catalogue) return;
    setPickedId(
      pickRecipeId(
        recipes.map((recipe) => recipe.recipeId),
        pickedId ?? undefined,
      ),
    );
  }
  const listRecipes = useMemo(
    () => (active ? recipes : recipes.slice(columns)),
    [active, recipes, columns],
  );
  const showHero = !active && !queryFocused && !catalogueUnavailable;
  function openAssistant() {
    if (active) assistantEntry.openSearch(criteria);
    else assistantEntry.clearSearch();
    router.navigate({ pathname: '/assistant', params: { recipeId: '' } });
  }
  const queryTooLong = (criteria.query?.length ?? 0) > SEARCH_QUERY_MAX_LENGTH;
  const filterCount =
    Number(!!criteria.category) + Number(!!criteria.cuisine) + (criteria.ingredients?.length ?? 0);
  useEffect(() => {
    if (queryFocused || !active || outcome.failed || catalogueUnavailable) return;
    const timer = setTimeout(
      () =>
        AccessibilityInfo.announceForAccessibility(`${recipes.length} recipes match your search.`),
      500,
    );
    return () => clearTimeout(timer);
  }, [active, outcome.failed, queryFocused, recipes.length, catalogueUnavailable]);
  function changeCriteria(next: SearchCriteria) {
    setCriteria(next);
    setScrollOffset(0);
    restoreOffset.current = 0;
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }
  function restoreFilterFocus() {
    focusTarget(filterOpener.current ?? filtersButton.current);
  }
  function openFilters(opener: View | null) {
    if (!catalogue) return;
    filterOpener.current = opener;
    filterSession.current = {};
    setFilterScope(catalogue.scopeKey);
  }
  const header = (
    <View style={styles.header}>
      <View style={styles.masthead}>
        <DiscoverHero expanded={showHero} />
      </View>
      <View style={[styles.searchPill, showHero && styles.overlappingSearch]}>
        <AppIcon name="search" size={21} />
        <TextInput
          style={[controlStyles.field, styles.searchInput]}
          accessibilityLabel="Search recipes by dish, ingredient or cuisine"
          placeholder="Dish, ingredient or cuisine"
          placeholderTextColor={t.color.inkSecondary}
          value={criteria.query ?? ''}
          onChangeText={(query) => changeCriteria({ ...criteria, query })}
          onFocus={() => setQueryFocused(true)}
          onBlur={() => setQueryFocused(false)}
          returnKeyType="search"
          autoCorrect={false}
          onSubmitEditing={() => setQueryFocused(false)}
        />
        {!!criteria.query && (
          <IconButton
            name="close"
            label="Clear search"
            tone="quiet"
            onPress={() => changeCriteria({ ...criteria, query: '' })}
          />
        )}
        <View style={styles.filterControl}>
          <IconButton
            ref={filtersButton}
            name="filter"
            label="Filters"
            accessibilityHint={`${filterCount} active filters`}
            tone="brand"
            disabled={catalogueUnavailable}
            onPress={() => openFilters(filtersButton.current)}
          />
          {filterCount > 0 && (
            <View pointerEvents="none" style={styles.filterBadge}>
              <AppText role="support" style={styles.filterBadgeText}>
                {filterCount}
              </AppText>
            </View>
          )}
        </View>
      </View>
      <WorkspaceFeedback />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.shortcuts}
        keyboardShouldPersistTaps="handled"
      >
        {[
          'All',
          ...['Pasta', 'Seafood', 'Vegetarian'].filter((category) =>
            catalogue?.facets.categories.includes(category),
          ),
        ].map((category) => {
          const selected = category === 'All' ? !criteria.category : criteria.category === category;
          return (
            <Pressable
              key={category}
              accessibilityRole="button"
              accessibilityLabel={category === 'All' ? 'All categories' : `${category} category`}
              {...controlStateProps({ selected, disabled: catalogueUnavailable }, 'button')}
              disabled={catalogueUnavailable}
              onPress={() =>
                changeCriteria({ ...criteria, category: category === 'All' ? '' : category })
              }
              style={[styles.shortcut, selected && styles.shortcutSelected]}
            >
              <SelectionIndicator selected={selected}>
                <AppIcon name="check" size={14} color={t.color.onBrand} />
              </SelectionIndicator>
              <AppText role="support" color={selected ? 'onBrand' : 'ink'}>
                {category}
              </AppText>
            </Pressable>
          );
        })}
        <IconButton
          ref={moreFiltersButton}
          name="more"
          label="More filters"
          tone="quiet"
          disabled={catalogueUnavailable}
          onPress={() => openFilters(moreFiltersButton.current)}
        />
      </ScrollView>
      {!active && !queryFocused && catalogue?.mode === 'bundled' && (
        <ContinueCooking fallback={<RecentlyViewedRow />} />
      )}
      <ContentContinueCooking fallback={!active && !queryFocused ? <RecentlyViewedRow /> : null} />
      <View style={styles.resultsHeading}>
        <View style={styles.resultsCopy}>
          <AppText role="section" accessibilityRole="header" style={styles.sectionTitle}>
            {active ? 'Search results' : 'Explore recipes'}
          </AppText>
          {!outcome.failed && !catalogueUnavailable && (
            <AppText role="support" color="inkSecondary">
              {recipes.length} {recipes.length === 1 ? 'recipe' : 'recipes'}
            </AppText>
          )}
        </View>
        <ActionButton
          label="Pick a recipe"
          variant="quiet"
          disabled={outcome.failed || catalogueUnavailable || recipes.length === 0}
          onPress={chooseRecipe}
        />
      </View>
      {catalogueUnavailable && (
        <Notice
          title={source.status === 'loading' ? 'Loading recipes…' : 'Recipes are unavailable'}
          tone={source.status === 'loading' ? 'neutral' : 'caution'}
        >
          <AppText>
            {source.status === 'loading'
              ? 'Reading the catalogue for this workspace.'
              : 'The recipe catalogue for this workspace could not be read. Your search is still here.'}
          </AppText>
          {source.status === 'failed' && source.retry && (
            <ActionButton label="Retry recipe catalogue" onPress={source.retry} />
          )}
        </Notice>
      )}
      {pickedRecipe && (
        <RecipePick
          recipe={pickedRecipe}
          count={recipes.length}
          onAnother={chooseRecipe}
          onDismiss={() => setPickedId(null)}
        />
      )}
      {active && (
        <View style={styles.criteria}>
          {!outcome.failed && !!criteria.ingredients?.length && (
            <AppText role="support" color="inkSecondary">
              Recipes containing all selected ingredients. Other ingredients may still be needed.
            </AppText>
          )}
          {(['category', 'cuisine'] as const).map((key) =>
            criteria[key] ? (
              <ActionButton
                key={key}
                variant="secondary"
                label={`${criteria[key]} ×`}
                accessibilityLabel={`Remove ${key} filter: ${criteria[key]}`}
                onPress={() => changeCriteria({ ...criteria, [key]: '' })}
              />
            ) : null,
          )}
          {criteria.ingredients?.map((ingredient) => (
            <ActionButton
              key={ingredient}
              variant="secondary"
              label={`${ingredient} ×`}
              accessibilityLabel={`Remove ingredient filter: ${ingredient}`}
              onPress={() =>
                changeCriteria({
                  ...criteria,
                  ingredients: criteria.ingredients?.filter((value) => value !== ingredient) ?? [],
                })
              }
            />
          ))}
          <ActionButton
            label="Clear all criteria"
            variant="quiet"
            onPress={() => changeCriteria({})}
          />
        </View>
      )}
      {outcome.failed && (
        <Notice title="Couldn’t search recipes" tone="error">
          <AppText>
            {queryTooLong
              ? `Your text is still here. Search supports up to ${SEARCH_QUERY_MAX_LENGTH.toLocaleString('en-US')} characters. Shorten your search or clear criteria, then try again.`
              : 'Your search is still here. Try the search again.'}
          </AppText>
          <ActionButton
            label="Retry search"
            onPress={() => setRetryRevision((value) => value + 1)}
          />
        </Notice>
      )}
      {catalogueUnavailable ? null : active ? (
        <AssistantInvitation searchLabel={searchContextLabel(criteria)} onPress={openAssistant} />
      ) : !outcome.failed ? (
        <>
          <View style={styles.openingRecipes}>
            {recipes.slice(0, columns).map((recipe) => (
              <View
                key={recipe.recipeId}
                style={[styles.openingRecipe, { width: `${100 / columns}%` }]}
              >
                <RecipeCard recipe={recipe} presentation="editorial" />
              </View>
            ))}
          </View>
          <AssistantInvitation onPress={openAssistant} />
          <AppText role="section" accessibilityRole="header" style={styles.sectionTitle}>
            More to try
          </AppText>
        </>
      ) : null}
    </View>
  );
  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <View style={styles.root} accessibilityElementsHidden={filtersOpen}>
        <FlatList
          ref={list}
          key={`columns-${columns}`}
          data={outcome.failed ? [] : listRecipes}
          numColumns={columns}
          keyExtractor={(recipe) => recipe.recipeId}
          renderItem={({ item }) => (
            <View style={[styles.item, { width: `${100 / columns}%` }]}>
              <RecipeCard recipe={item} presentation="editorial" />
            </View>
          )}
          contentContainerStyle={styles.list}
          ListHeaderComponent={header}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          keyboardDismissMode={
            // RN Web also dismisses on automatic scrolls caused by focus or layout changes.
            Platform.OS === 'web' ? 'none' : 'on-drag'
          }
          initialNumToRender={6}
          maxToRenderPerBatch={8}
          windowSize={7}
          removeClippedSubviews={false}
          scrollEventThrottle={200}
          onScroll={(event) => {
            restoreOffset.current = event.nativeEvent.contentOffset.y;
            setScrollOffset(restoreOffset.current);
          }}
          onLayout={() => {
            if (restoreOffset.current > 0)
              list.current?.scrollToOffset({ offset: restoreOffset.current, animated: false });
          }}
          ListEmptyComponent={
            !outcome.failed && !catalogueUnavailable && recipes.length === 0 ? (
              <View style={styles.header}>
                <Notice title="No recipes match these filters.">
                  Try a different word or remove a filter. Your search hasn’t been changed.
                </Notice>
                {suggestions.length > 0 && (
                  <View style={styles.search}>
                    <AppText role="section">Possible matches</AppText>
                    <AppText role="support">
                      These may match a different spelling. They are separate suggestions.
                    </AppText>
                    {suggestions.map((match) => {
                      const recipe = catalogue?.current(match.recipeId);
                      return recipe ? (
                        <RecipeCard
                          key={recipe.recipeId}
                          recipe={recipe}
                          presentation="editorial"
                        />
                      ) : null;
                    })}
                  </View>
                )}
              </View>
            ) : null
          }
          ListFooterComponent={
            <AppText role="support" color="inkSecondary" style={styles.footer}>
              {catalogue?.mode === 'content'
                ? 'Recipe and photo credits are shown with each recipe. Original imported sources remain available.'
                : catalogue
                  ? 'Recipes and supplied photographs from TheMealDB collection.'
                  : ''}
            </AppText>
          }
        />
      </View>
      <FilterSheet
        visible={filtersOpen && !catalogueUnavailable}
        criteria={criteria}
        onApply={(next) => {
          if (
            !filtersOpen ||
            !renderedFilterSession ||
            filterSession.current !== renderedFilterSession ||
            liveCatalogueScope.current !== filterScope
          )
            return;
          changeCriteria(next);
          closeFilters();
        }}
        onClose={closeFilters}
        onDismiss={restoreFilterFocus}
      />
    </SafeAreaView>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.color.canvas },
    list: {
      width: '100%',
      maxWidth: t.layout.screenMaxWidth,
      alignSelf: 'center',
      paddingHorizontal: t.space.gutter - t.space.sm / 2,
      paddingBottom: t.space.xl,
    },
    header: {
      paddingHorizontal: t.space.sm / 2,
      gap: t.space.gutter,
      paddingBottom: t.space.md,
    },
    masthead: { marginHorizontal: -t.space.gutter },
    overlappingSearch: { marginTop: -34 },
    search: { gap: t.space.xs },
    searchPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.xs,
      borderRadius: t.radius.pill,
      paddingLeft: t.space.md,
      paddingRight: t.space.xxs,
      paddingVertical: t.space.xxs,
      minHeight: 56,
      backgroundColor: t.color.surface,
      borderWidth: 1,
      borderColor: t.color.divider,
      boxShadow: '0px 5px 18px rgba(58, 32, 22, 0.12)',
      elevation: 2,
    },
    searchInput: {
      borderWidth: 0,
      flex: 1,
      minWidth: 0,
      paddingHorizontal: 0,
      backgroundColor: 'transparent',
      fontSize: 15,
      minHeight: 48,
    },
    filterControl: { position: 'relative' },
    filterBadge: {
      position: 'absolute',
      right: -2,
      top: -3,
      minWidth: 20,
      minHeight: 20,
      borderRadius: 10,
      backgroundColor: t.color.selection,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: t.color.surface,
    },
    filterBadgeText: {
      fontSize: 11,
      lineHeight: 16,
      color: t.color.brandText,
      paddingHorizontal: 3,
    },
    shortcuts: { flexDirection: 'row', gap: t.space.xs, alignItems: 'center' },
    shortcut: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.xxs,
      minHeight: t.control.minimumTarget,
      justifyContent: 'center',
      paddingHorizontal: t.space.md,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.surfaceMuted,
    },
    shortcutSelected: { backgroundColor: t.color.brand },
    sectionTitle: { fontSize: 26, lineHeight: 32 },
    resultsHeading: {
      paddingTop: t.space.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.space.xs,
    },
    resultsCopy: { flex: 1, minWidth: 150, gap: t.space.xxs },
    criteria: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs, alignItems: 'center' },
    item: { paddingHorizontal: t.space.sm / 2, paddingBottom: t.space.lg },
    openingRecipes: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -t.space.sm / 2 },
    openingRecipe: { paddingHorizontal: t.space.sm / 2, paddingBottom: t.space.md },
    footer: { padding: t.space.sm / 2, paddingTop: t.space.md },
  });
