import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getRecipe } from '@cookmate/catalogue';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import { isSupportedPlanDate, SEARCH_QUERY_MAX_LENGTH } from '@cookmate/domain';
import type { MealKey } from '@cookmate/contracts';
import { Page, PageHeader, usePageStyles } from '../../components/Page';
import { ActionButton, Notice, SegmentControl, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { AppIcon } from '../../components/Icon';
import {
  OrdinaryRecipePhoto,
  ordinaryPhotoNeedsReview,
  type OrdinaryRecipe,
} from '../../components/OrdinaryRecipePhoto';
import { controlStateProps } from '../../components/controlStateProps';
import { FocusedSheet } from '../../components/FocusedSheet';
import { focusTarget } from '../../components/focusTarget';
import { useDiscoverCatalogue } from '../discover/DiscoverState';
import { useOrdinaryPlanQuery, useOrdinaryWorkspaceActions } from '../content/useOrdinaryWorkspace';
import { QueryFeedback, WorkspaceFeedback } from './WorkspaceFeedback';
import { formatPlanDate, mealLabel } from './runtimeClock';
import { useActionFocus } from '../../hooks/useActionFocus';
import { useUnsavedDraft } from '../../hooks/useUnsavedDraft';
import { MealDateSelector } from './MealDateSelector';
import { usePlanningPreferences } from '../planning-preferences/PlanningPreferencesProvider';
import { ExactRecipePhoto, useExactPlanRecipe } from './ExactRecipePhoto';
import {
  planRouteContentRef,
  planSnapshotForDisplay,
  samePlanContentRef,
} from './ordinaryPlanModel';

const mealOptions = (['breakfast', 'lunch', 'dinner'] as const).map((value) => ({
  value,
  label: mealLabel(value),
}));
export default function PlanEditorScreen() {
  const { mode, scopeKey } = useOrdinaryWorkspaceActions();
  return <PlanEditor key={`${mode}:${scopeKey}`} />;
}

function PlanEditor() {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();
  const controlStyles = useControlStyles();

  const params = useLocalSearchParams<{
    recipeId?: string;
    occurrenceId?: string;
    date?: string;
    meal?: string;
    contentRef?: string;
  }>();
  const { clock, actions, actionState, mode, scopeKey } = useOrdinaryWorkspaceActions();
  const { preferences, hydrated, error: planningError } = usePlanningPreferences();
  const explicitMeal =
    params.meal === 'breakfast' || params.meal === 'lunch' || params.meal === 'dinner'
      ? params.meal
      : null;
  const editingOccurrence = typeof params.occurrenceId === 'string';
  const catalogue = useDiscoverCatalogue().ready;
  const sourceCatalogue =
    catalogue &&
    (mode === 'bundled' || (catalogue.mode === 'content' && catalogue.scopeKey === scopeKey))
      ? catalogue
      : null;
  const router = useRouter();
  const [recipeId, setRecipeId] = useState(
    typeof params.recipeId === 'string' ? params.recipeId : '',
  );
  const [date, setDate] = useState(
    typeof params.date === 'string' ? params.date : clock.dateContext().localDate,
  );
  const [meal, setMeal] = useState<MealKey>(
    () =>
      explicitMeal ??
      (!editingOccurrence && hydrated && !planningError ? preferences.defaultMealSlot : 'dinner'),
  );
  const defaultResolved = useRef(
    !!explicitMeal || editingOccurrence || (hydrated && !planningError),
  );
  const [defaultPending, setDefaultPending] = useState(!defaultResolved.current);
  const [query, setQuery] = useState('');
  const [pickedCurrent, setPickedCurrent] = useState(false);
  const [choosingRecipe, setChoosingRecipe] = useState(() =>
    mode === 'content' ? !recipeId : !getRecipe(recipeId),
  );
  const recipePickerTrigger = useRef<View>(null);
  const recipeSearchInput = useRef<TextInput>(null);
  const closeRecipePicker = () => {
    Keyboard.dismiss();
    setChoosingRecipe(false);
  };
  const focus = useActionFocus();
  const [baseline, setBaseline] = useState({ recipeId, date, meal });
  useEffect(() => {
    if (!hydrated || planningError || defaultResolved.current) return;
    defaultResolved.current = true;
    setDefaultPending(false);
    if (explicitMeal || editingOccurrence) return;
    setMeal(preferences.defaultMealSlot);
    setBaseline((previous) => ({ ...previous, meal: preferences.defaultMealSlot }));
  }, [hydrated, planningError, preferences.defaultMealSlot, explicitMeal, editingOccurrence]);
  function chooseMeal(value: MealKey) {
    defaultResolved.current = true;
    setDefaultPending(false);
    setMeal(value);
  }
  const [submitted, setSubmitted] = useState<typeof baseline | null>(null);
  const [lastSaved, setLastSaved] = useState<typeof baseline | null>(null);
  const occurrenceId = typeof params.occurrenceId === 'string' ? params.occurrenceId : undefined;
  const [savedSource, setSavedSource] = useState(() => ({
    date: typeof params.date === 'string' && isSupportedPlanDate(params.date) ? params.date : null,
    recipeId: typeof params.recipeId === 'string' ? params.recipeId : '',
    ref: planRouteContentRef(params.contentRef, params.recipeId),
  }));
  const submittedRef = useRef<Readonly<RecipeContentRef> | null>(null);
  const validDate = isSupportedPlanDate(date);
  const destinationDate = validDate ? date : clock.dateContext().localDate;
  const destination = useOrdinaryPlanQuery(
    `meal-destination:${destinationDate}`,
    destinationDate,
    destinationDate,
  );
  const sourceDate = savedSource.date ?? clock.dateContext().localDate;
  const sourceQuery = useOrdinaryPlanQuery(
    `meal-source:${occurrenceId ?? 'new'}:${sourceDate}`,
    sourceDate,
    sourceDate,
  );
  const source =
    mode === 'content' && occurrenceId && sourceQuery.state.kind === 'ready'
      ? planSnapshotForDisplay(sourceQuery)?.occurrences.find(
          (entry) => entry.occurrenceId === occurrenceId,
        )
      : undefined;
  const sourceValid =
    mode !== 'content' ||
    !occurrenceId ||
    (!!savedSource.date &&
      !!savedSource.ref &&
      source?.recipeId === savedSource.recipeId &&
      !!source.content &&
      samePlanContentRef(source.content.contentRef, savedSource.ref));
  const pinned = sourceValid && source?.recipeId === recipeId ? source.content : undefined;
  const exactReading = useExactPlanRecipe(pinned?.contentRef ?? null);
  let currentRecipe: OrdinaryRecipe | undefined;
  try {
    currentRecipe = sourceCatalogue?.current(recipeId);
  } catch {
    /* Retired catalogue cannot supply a new choice. */
  }
  const sourceUnavailable = mode === 'content' && !!occurrenceId && !sourceValid;
  const recipe = sourceUnavailable
    ? undefined
    : pinned
      ? exactReading.lookup?.kind === 'readable'
        ? exactReading.lookup.recipe
        : undefined
      : currentRecipe;
  const title = sourceUnavailable
    ? 'Saved meal unavailable'
    : pinned
      ? pinned.content.kind === 'readable'
        ? pinned.content.title
        : 'Saved recipe unavailable'
      : recipe?.title;
  const hasRecipe = !!pinned || !!recipe;
  const selectedRef =
    pinned?.contentRef ?? (recipe && 'contentRef' in recipe ? recipe.contentRef : null);
  const initialRef =
    params.contentRef === undefined
      ? null
      : planRouteContentRef(params.contentRef, params.recipeId);
  const initialCurrentMatches =
    mode !== 'content' ||
    !!occurrenceId ||
    pickedCurrent ||
    params.contentRef === undefined ||
    (!!initialRef &&
      !!currentRecipe &&
      'contentRef' in currentRecipe &&
      samePlanContentRef(currentRecipe.contentRef, initialRef));
  const occupied =
    validDate && destination.state.kind === 'ready'
      ? planSnapshotForDisplay(destination)?.occurrences.find(
          (entry) =>
            entry.placement.actualDate === date &&
            entry.placement.mealKey === meal &&
            entry.occurrenceId !== occurrenceId,
        )
      : undefined;
  const sameIdDifferentVersion =
    mode === 'content' &&
    !occurrenceId &&
    !!occupied?.content &&
    occupied.recipeId === recipeId &&
    !!selectedRef &&
    !samePlanContentRef(occupied.content.contentRef, selectedRef);
  const canReview =
    !defaultPending &&
    hasRecipe &&
    validDate &&
    destination.state.kind === 'ready' &&
    sourceValid &&
    initialCurrentMatches &&
    !sameIdDifferentVersion &&
    !!actions &&
    !actions.blocked &&
    (mode !== 'content' || !!sourceCatalogue);
  const results = useMemo(() => {
    if (query.length > SEARCH_QUERY_MAX_LENGTH) return { recipes: [], failed: true };
    try {
      return {
        recipes: query.trim()
          ? (sourceCatalogue
              ?.search({ query })
              .matches.map((entry) => sourceCatalogue.current(entry.recipeId))
              .filter((entry): entry is OrdinaryRecipe => !!entry) ?? [])
          : (sourceCatalogue?.recipes ?? []),
        failed: false,
      };
    } catch {
      return { recipes: [], failed: true };
    }
  }, [query, sourceCatalogue]);
  const reviewedInput = 'review' in actionState ? actionState.review?.input : undefined;
  const matchesSubmission =
    submitted &&
    reviewedInput?.kind === 'placeRecipe' &&
    reviewedInput.occurrenceId === occurrenceId &&
    reviewedInput.recipeId === submitted.recipeId &&
    reviewedInput.placement.actualDate === submitted.date &&
    reviewedInput.placement.mealKey === submitted.meal;
  useEffect(() => {
    if (actionState.kind !== 'receipt' || !matchesSubmission || !submitted) return;
    setBaseline(submitted);
    setLastSaved(submitted);
    if (mode === 'content' && occurrenceId && submittedRef.current)
      setSavedSource({
        date: submitted.date,
        recipeId: submitted.recipeId,
        ref: submittedRef.current,
      });
    setSubmitted(null);
  }, [actionState, matchesSubmission, submitted, mode, occurrenceId]);
  const live = useRef(true);
  const latest = useRef({ canReview, sourceCatalogue, recipeId, date, meal, selectedRef });
  latest.current = { canReview, sourceCatalogue, recipeId, date, meal, selectedRef };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!sourceCatalogue) setChoosingRecipe(false);
  }, [sourceCatalogue]);
  const currentDraft = () => {
    if (
      !live.current ||
      !latest.current.canReview ||
      latest.current.recipeId !== recipeId ||
      latest.current.date !== date ||
      latest.current.meal !== meal ||
      latest.current.sourceCatalogue !== sourceCatalogue
    )
      return false;
    try {
      const current = sourceCatalogue?.current(recipeId);
      // A current choice must still be the displayed version when review starts.
      if (mode === 'content' && !pinned) {
        return (
          !!current &&
          'contentRef' in current &&
          !!selectedRef &&
          samePlanContentRef(current.contentRef, selectedRef)
        );
      }
      return true;
    } catch {
      return false;
    }
  };
  const sameDraft = (other: typeof baseline | null) =>
    !!other && recipeId === other.recipeId && date === other.date && meal === other.meal;
  const savedThisEdit = sameDraft(lastSaved);
  const pendingThisEdit =
    matchesSubmission &&
    sameDraft(submitted) &&
    ['preparing', 'applying', 'uncertain'].includes(actionState.kind);
  useUnsavedDraft(!pendingThisEdit && !sameDraft(baseline), 'Discard meal changes?');
  return (
    <Page bottomInset scroll={false}>
      <KeyboardAvoidingView style={pageStyles.fill} behavior="padding">
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={pageStyles.content}>
          <PageHeader back title={occurrenceId ? 'Edit your meal' : 'Plan a meal'} />
          <WorkspaceFeedback />
          {savedThisEdit && (
            <View style={pageStyles.section}>
              <AppText role="bodyStrong">
                Saved for {formatPlanDate(date, true)} · {mealLabel(meal)}
              </AppText>
              <ActionButton
                label="View day"
                onPress={() => router.navigate({ pathname: '/plan', params: { date } })}
              />
              <ActionButton
                label="Choose shopping meals"
                variant="quiet"
                onPress={() => router.push({ pathname: '/shopping-meals', params: { date } })}
              />
            </View>
          )}
          <View style={styles.selectedRecipe}>
            {hasRecipe && (
              <View style={styles.thumbnail}>
                {pinned ? (
                  <ExactRecipePhoto compact contentRef={pinned.contentRef} aspectRatio={1} />
                ) : recipe ? (
                  <OrdinaryRecipePhoto compact recipe={recipe} aspectRatio={1} />
                ) : null}
              </View>
            )}
            <View style={styles.summary}>
              <AppText role="label" color="inkSecondary">
                Your meal
              </AppText>
              <AppText role="section">{title ?? 'Choose a recipe'}</AppText>
              {recipe && (
                <AppText role="support" color="inkSecondary">
                  {recipe.cuisine} · {recipe.category}
                </AppText>
              )}
              {pinned && (
                <AppText role="support" color="inkSecondary">
                  This meal keeps its saved recipe version. Recipe updates are reviewed separately.
                </AppText>
              )}
              {!hasRecipe && !sourceUnavailable && (
                <AppText role="support" color="inkSecondary">
                  Pick a recipe, then review when to add it to your plan.
                </AppText>
              )}
            </View>
          </View>
          <ActionButton
            ref={recipePickerTrigger}
            label={hasRecipe ? 'Change recipe' : 'Choose a recipe'}
            variant={hasRecipe ? 'quiet' : 'secondary'}
            disabled={!sourceCatalogue || sourceUnavailable}
            accessibilityState={{ expanded: choosingRecipe && !!sourceCatalogue }}
            onPress={() => {
              if (
                live.current &&
                latest.current.sourceCatalogue === sourceCatalogue &&
                sourceCatalogue &&
                !sourceUnavailable
              )
                setChoosingRecipe(true);
            }}
          />
          {mode === 'content' && !sourceCatalogue && (
            <Notice title="Recipes unavailable">
              The verified recipe catalogue is not available. Your meal has not changed.
            </Notice>
          )}
          {sourceUnavailable &&
            (sourceQuery.state.kind === 'ready' ? (
              <Notice title="Saved meal changed">
                Return to your plan and open this meal again before reviewing changes.
              </Notice>
            ) : (
              <QueryFeedback {...sourceQuery} noun="saved meal" />
            ))}
          {!initialCurrentMatches && (
            <Notice title="Recipe version changed">
              Choose the recipe again to review its current version.
            </Notice>
          )}
          {sameIdDifferentVersion && (
            <Notice title="A different version is already planned">
              Open the saved meal to move or edit it. Recipe updates are reviewed separately.
            </Notice>
          )}
          <View style={styles.dateSection}>
            <MealDateSelector
              value={date}
              onChange={setDate}
              today={clock.dateContext().localDate}
              getToday={() => clock.dateContext().localDate}
            />
          </View>
          <AppText role="label">Which meal?</AppText>
          <SegmentControl value={meal} onChange={chooseMeal} options={mealOptions} />
          {defaultPending && (
            <AppText role="support" color={planningError ? 'error' : 'inkSecondary'}>
              {planningError
                ? 'Your saved default meal slot could not be confirmed. Choose a slot for this meal to continue.'
                : 'Loading your default meal slot… You can choose a slot now.'}
            </AppText>
          )}
          {validDate && <QueryFeedback {...destination} noun="destination meal" />}
          {occupied && (
            <View style={styles.destinationNote}>
              <AppText role="support">
                {mealLabel(meal)} already has{' '}
                {occupied.content
                  ? occupied.content.content.kind === 'readable'
                    ? occupied.content.content.title
                    : 'an unavailable saved recipe'
                  : (getRecipe(occupied.recipeId)?.title ?? 'an unavailable recipe')}
                . Review the replacement and its shopping changes before confirming.
              </AppText>
            </View>
          )}
          <ActionButton
            label={occupied ? 'Review replacement' : 'Review meal'}
            ref={focus.ref}
            disabled={!canReview}
            onPress={() => {
              if (!currentDraft()) return;
              submittedRef.current = selectedRef;
              setSubmitted({ recipeId, date, meal });
              void actions?.begin(
                {
                  kind: 'placeRecipe',
                  recipeId,
                  placement: { actualDate: date, mealKey: meal },
                  ...(occurrenceId ? { occurrenceId } : {}),
                },
                { confirm: true, restoreFocus: focus.restoreFocus },
              );
            }}
          />
          {!occupied && (
            <AppText role="support" color="inkSecondary">
              Review the dated meal before saving. Shopping inclusion is chosen separately.
            </AppText>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      <FocusedSheet
        visible={choosingRecipe && !!sourceCatalogue}
        title="Choose a recipe"
        closeLabel="Cancel"
        onClose={closeRecipePicker}
        onDismiss={() => {
          if (live.current) focusTarget(recipePickerTrigger.current);
        }}
        onShow={() => {
          if (live.current && latest.current.sourceCatalogue) recipeSearchInput.current?.focus();
        }}
        scroll={false}
      >
        <View style={styles.pickerSearch}>
          <AppText role="support" color="inkSecondary">
            {validDate ? formatPlanDate(date) : date} · {mealLabel(meal)}
          </AppText>
          {hasRecipe && (
            <AppText role="support" color="inkSecondary">
              Currently selected: {title}
            </AppText>
          )}
          <TextInput
            ref={recipeSearchInput}
            value={query}
            onChangeText={setQuery}
            accessibilityLabel="Find a recipe for this meal"
            placeholder="Dish, ingredient or cuisine"
            autoCorrect={false}
            style={controlStyles.field}
          />
        </View>
        <FlatList
          style={pageStyles.fill}
          data={choosingRecipe ? results.recipes : []}
          keyExtractor={(item) => item.recipeId}
          initialNumToRender={8}
          maxToRenderPerBatch={10}
          windowSize={7}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={pageStyles.content}
          ListHeaderComponent={
            results.failed ? (
              <Notice title="Couldn’t search recipes" tone="error">
                Shorten or change the search and try again. Your meal choices are still here.
              </Notice>
            ) : null
          }
          renderItem={({ item }) => {
            const differentPinnedVersion =
              mode === 'content' &&
              !!source?.content &&
              source.recipeId === item.recipeId &&
              'contentRef' in item &&
              !samePlanContentRef(source.content.contentRef, item.contentRef);
            const selected =
              item.recipeId === recipeId &&
              (mode !== 'content' ||
                ('contentRef' in item &&
                  !!selectedRef &&
                  samePlanContentRef(item.contentRef, selectedRef)));
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.title} · ${item.cuisine}`}
                accessibilityHint={
                  differentPinnedVersion
                    ? 'This meal keeps its saved version. Recipe updates are reviewed separately.'
                    : ordinaryPhotoNeedsReview(item)
                      ? 'Supplied photo association needs review. See the recipe source notes.'
                      : undefined
                }
                disabled={differentPinnedVersion}
                {...controlStateProps({ selected, disabled: differentPinnedVersion }, 'button')}
                onPress={() => {
                  if (
                    !live.current ||
                    latest.current.sourceCatalogue !== sourceCatalogue ||
                    !sourceCatalogue ||
                    differentPinnedVersion
                  )
                    return;
                  try {
                    const current = sourceCatalogue.current(item.recipeId);
                    if (
                      !current ||
                      (mode === 'content' &&
                        (!('contentRef' in item) ||
                          !('contentRef' in current) ||
                          !samePlanContentRef(current.contentRef, item.contentRef)))
                    )
                      return;
                  } catch {
                    return;
                  }
                  setPickedCurrent(true);
                  setRecipeId(item.recipeId);
                  closeRecipePicker();
                }}
                style={({ pressed }) => [
                  styles.recipeRow,
                  selected && styles.selectedRow,
                  pressed && styles.pressed,
                ]}
              >
                <View style={styles.pickerThumbnail}>
                  <OrdinaryRecipePhoto compact recipe={item} aspectRatio={1} />
                </View>
                <View style={styles.summary}>
                  <AppText role="bodyStrong">{item.title}</AppText>
                  <AppText role="support" color="inkSecondary">
                    {item.cuisine}
                  </AppText>
                  {differentPinnedVersion && (
                    <AppText role="support" color="inkSecondary">
                      A newer version. This meal keeps its saved version.
                    </AppText>
                  )}
                </View>
                <AppIcon name={selected ? 'check' : 'plus'} color={t.color.brandText} />
              </Pressable>
            );
          }}
          ListEmptyComponent={
            choosingRecipe && !results.failed ? (
              <Notice title="No matching recipes">Try another dish or ingredient.</Notice>
            ) : null
          }
        />
      </FocusedSheet>
    </Page>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    selectedRecipe: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
    },
    thumbnail: { width: t.layout.largeThumbnail, flexShrink: 0 },
    pickerThumbnail: { width: t.layout.thumbnail, flexShrink: 0 },
    pickerSearch: {
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
      padding: t.space.gutter,
      paddingBottom: 0,
      gap: t.space.sm,
    },
    summary: { flex: 1, gap: t.space.xxs },
    dateSection: {
      gap: t.space.xs,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      padding: t.space.md,
    },
    destinationNote: {
      padding: t.space.sm,
      backgroundColor: t.color.selection,
      borderRadius: t.radius.small,
    },
    recipeRow: {
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      padding: t.space.sm,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
    },
    selectedRow: { backgroundColor: t.color.selection },
    pressed: { opacity: 0.75 },
  });
