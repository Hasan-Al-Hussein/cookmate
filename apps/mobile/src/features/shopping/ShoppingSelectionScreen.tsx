import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getRecipe, getRecipePhotoTreatment } from '@cookmate/catalogue';
import type { PlanOccurrence } from '@cookmate/contracts';
import { getPlanWeek, isSupportedPlanDate, type Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { Page, PageHeader, usePageStyles } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { AppIcon, IconButton } from '../../components/Icon';
import { RecipePhoto } from '../../components/RecipePhoto';
import { controlStateProps } from '../../components/controlStateProps';
import {
  useOrdinaryWorkspaceActions,
  useOrdinaryPlanQuery,
  useOrdinaryShoppingQuery,
} from '../content/useOrdinaryWorkspace';
import { selectionPlan, shoppingSelection, shoppingContentEntries } from './ordinaryShoppingModel';
import type { ContentPlanOccurrence } from '../../data/contentWorkspaceQueries';
import { ExactRecipePhoto } from '../workspace/ExactRecipePhoto';
import { QueryFeedback, WorkspaceFeedback, occurrenceLabel } from '../workspace/WorkspaceFeedback';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import { useActionFocus } from '../../hooks/useActionFocus';
import { useUnsavedDraft } from '../../hooks/useUnsavedDraft';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { usePlanningPreferences } from '../planning-preferences/PlanningPreferencesProvider';

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));
const mealOrder = { breakfast: 0, lunch: 1, dinner: 2 };

export default function ShoppingSelectionScreen() {
  const { scopeKey } = useOrdinaryWorkspaceActions();
  return <ScopedShoppingSelection key={scopeKey} />;
}

function ScopedShoppingSelection() {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();

  const { clock, actions, actionState, mode } = useOrdinaryWorkspaceActions();
  const { preferences } = usePlanningPreferences();
  const router = useRouter();
  const params = useLocalSearchParams<{ date?: string }>();
  const { enlarged } = useNativeLayout();
  const [date, setDate] = useState(() =>
    typeof params.date === 'string' && isSupportedPlanDate(params.date)
      ? params.date
      : clock.dateContext().localDate,
  );
  const week = getPlanWeek(date, preferences.weekStart);
  const rangeKey = `${week.startDate}:${week.endDate}`;
  const currentRange = useRef(rangeKey);
  currentRange.current = rangeKey;
  const planSource = useOrdinaryPlanQuery(`selection:${rangeKey}`, week.startDate, week.endDate);
  const shoppingSource = useOrdinaryShoppingQuery('selection-scope');
  const planState = useMemo(() => selectionPlan(planSource), [planSource.mode, planSource.state]);
  const shoppingState = useMemo(
    () => shoppingSelection(shoppingSource),
    [shoppingSource.mode, shoppingSource.state],
  );
  const plan = { state: planState, retry: planSource.retry };
  const displayedRange = planState.kind === 'ready' ? planState.value : planState.previous;
  const displayedWeek = displayedRange
    ? { ...week, startDate: displayedRange.startDate, endDate: displayedRange.endDate }
    : week;
  const shopping = { state: shoppingState, retry: shoppingSource.retry };
  const savedContent = useRef(new Map<string, ContentPlanOccurrence>());
  const observedContent = [
    ...(shoppingContentEntries(shoppingSource) ?? []),
    ...(planSource.mode === 'content' && planSource.state.kind === 'ready'
      ? planSource.state.value.occurrences
      : []),
  ];
  const contentLookup = new Map(savedContent.current);
  observedContent.forEach((entry) => contentLookup.set(entry.occurrence.occurrenceId, entry));
  useEffect(() => {
    savedContent.current = contentLookup;
  });
  const rowTitle = (entry: Immutable<PlanOccurrence>) => {
    const saved = contentLookup.get(entry.occurrenceId);
    return mode === 'content'
      ? saved?.content.kind === 'readable'
        ? saved.content.title
        : `Recipe ${entry.recipeId} · saved version unavailable`
      : (getRecipe(entry.recipeId)?.title ?? 'Unavailable recipe');
  };
  const rowLabel = (entry: Immutable<PlanOccurrence>) =>
    mode === 'bundled'
      ? occurrenceLabel(entry)
      : `${rowTitle(entry)} · ${formatPlanDate(entry.placement.actualDate)} · ${mealLabel(entry.placement.mealKey)}`;
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const baseline = useRef<{ revision: number; ids: readonly string[] } | null>(null);
  const focus = useActionFocus();
  const known = useRef(new Map<string, Immutable<PlanOccurrence>>());
  const [submitted, setSubmitted] = useState<readonly string[] | null>(null);
  const [lastSaved, setLastSaved] = useState<readonly string[] | null>(null);
  const committedAwaitingRead = useRef<readonly string[] | null>(null);
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (
      actionState.kind !== 'receipt' ||
      !submitted ||
      actionState.review.input.kind !== 'setShoppingSelection' ||
      !sameIds(submitted, actionState.review.input.occurrenceIds)
    )
      return;
    if (baseline.current) baseline.current = { ...baseline.current, ids: submitted };
    committedAwaitingRead.current = submitted;
    setLastSaved(submitted);
    setSubmitted(null);
  }, [actionState, submitted]);
  useEffect(() => {
    if (shopping.state.kind === 'ready') {
      baseline.current ??= {
        revision: shopping.state.value.scope.revision,
        ids: shopping.state.value.scope.occurrenceIds,
      };
      if (
        committedAwaitingRead.current &&
        sameIds(committedAwaitingRead.current, shopping.state.value.scope.occurrenceIds)
      ) {
        baseline.current = {
          revision: shopping.state.value.scope.revision,
          ids: shopping.state.value.scope.occurrenceIds,
        };
        committedAwaitingRead.current = null;
        setDraft((value) => value && new Set(value));
      }
      shopping.state.value.selectedOccurrences.forEach((entry) =>
        known.current.set(entry.occurrenceId, entry),
      );
      setDraft(
        (value) =>
          value ??
          new Set(shopping.state.kind === 'ready' ? shopping.state.value.scope.occurrenceIds : []),
      );
    }
  }, [shopping.state, lastSaved]);
  useEffect(() => {
    if (plan.state.kind !== 'ready') return;
    const snapshot = plan.state.value;
    setStaleIds((previous) => {
      const next = new Set(previous);
      known.current.forEach((entry) => {
        if (
          entry.placement.actualDate >= snapshot.startDate &&
          entry.placement.actualDate <= snapshot.endDate &&
          !snapshot.occurrences.some((current) => current.occurrenceId === entry.occurrenceId)
        )
          next.add(entry.occurrenceId);
      });
      snapshot.occurrences.forEach((entry) => next.delete(entry.occurrenceId));
      return next;
    });
    snapshot.occurrences.forEach((entry) => known.current.set(entry.occurrenceId, entry));
  }, [plan.state]);
  const current = plan.state.kind === 'ready' ? plan.state.value.occurrences : [];
  const lookup = new Map(known.current);
  if (shopping.state.kind === 'ready')
    shopping.state.value.selectedOccurrences.forEach((entry) =>
      lookup.set(entry.occurrenceId, entry),
    );
  current.forEach((entry) => lookup.set(entry.occurrenceId, entry));
  const rows = [
    ...current,
    ...[...(draft ?? [])]
      .filter((id) => !current.some((entry) => entry.occurrenceId === id))
      .map((id) => lookup.get(id))
      .filter((entry): entry is Immutable<PlanOccurrence> => !!entry),
  ];
  const outsideWeek = (entry: Immutable<PlanOccurrence>) =>
    entry.placement.actualDate < displayedWeek.startDate ||
    entry.placement.actualDate > displayedWeek.endDate;
  const datedRows = [...rows].sort(
    (a, b) =>
      Number(outsideWeek(a)) - Number(outsideWeek(b)) ||
      a.placement.actualDate.localeCompare(b.placement.actualDate) ||
      mealOrder[a.placement.mealKey] - mealOrder[b.placement.mealKey],
  );
  const scopeChanged =
    shopping.state.kind === 'ready' &&
    baseline.current !== null &&
    shopping.state.value.scope.revision !== baseline.current.revision;
  const hasStaleDraft = [...(draft ?? [])].some((id) => staleIds.has(id));
  const ready =
    !hasStaleDraft &&
    !scopeChanged &&
    !!draft &&
    plan.state.kind === 'ready' &&
    shopping.state.kind === 'ready' &&
    !!actions &&
    !actions.blocked;
  const saved = !!draft && !!lastSaved && sameIds([...draft], lastSaved);
  const pendingThisDraft =
    !!submitted &&
    !!draft &&
    sameIds([...draft], submitted) &&
    ['preparing', 'applying', 'uncertain'].includes(actionState.kind);
  const dirty =
    !!draft &&
    !!baseline.current &&
    (draft.size !== baseline.current.ids.length ||
      baseline.current.ids.some((id) => !draft.has(id)));
  const selectedThisWeek = datedRows.filter(
    (entry) => !outsideWeek(entry) && draft?.has(entry.occurrenceId),
  ).length;
  const selectedOutsideWeek = (draft?.size ?? 0) - selectedThisWeek;
  useUnsavedDraft(dirty && !pendingThisDraft, 'Discard shopping selections?');
  return (
    <Page bottomInset scroll={false}>
      <FlatList
        style={styles.list}
        data={datedRows}
        keyExtractor={(entry) => entry.occurrenceId}
        contentContainerStyle={[pageStyles.content, styles.listContent]}
        initialNumToRender={10}
        maxToRenderPerBatch={12}
        windowSize={7}
        ListHeaderComponent={
          <View style={[pageStyles.section, styles.listHeader]}>
            <PageHeader back title="Choose shopping meals" />
            <WorkspaceFeedback />
            <AppText role="support" color="inkSecondary">
              Choose the dated meals you want to shop for. Other weeks stay selected.
            </AppText>
            {saved && (
              <ActionButton label="Return to your plan" onPress={() => router.navigate('/plan')} />
            )}
            <View style={styles.weekNavigation}>
              <IconButton
                label="Previous week"
                name="chevronLeft"
                disabled={!week.previousWeek}
                onPress={() => week.previousWeek && setDate(week.previousWeek)}
              />
              <AppText role="bodyStrong" style={styles.weekRange}>
                {formatPlanDate(displayedWeek.startDate, true)} –{' '}
                {formatPlanDate(displayedWeek.endDate)}
              </AppText>
              <IconButton
                label="Next week"
                name="chevronRight"
                disabled={!week.nextWeek}
                onPress={() => week.nextWeek && setDate(week.nextWeek)}
              />
            </View>
            <View style={styles.draftActions}>
              <AppText role="support" accessibilityLiveRegion="polite">
                {selectedThisWeek} selected this week · {selectedOutsideWeek} outside this week
              </AppText>
              <ActionButton
                label="Clear this week"
                variant="quiet"
                disabled={!ready || selectedThisWeek === 0}
                onPress={() => {
                  if (!ready || currentRange.current !== rangeKey) return;
                  setDraft((value) => {
                    const next = new Set(value);
                    datedRows
                      .filter((entry) => !outsideWeek(entry))
                      .forEach((entry) => next.delete(entry.occurrenceId));
                    return next;
                  });
                }}
              />
            </View>
            <QueryFeedback {...plan} noun="available meals" />
            <QueryFeedback {...shopping} noun="selected meals" />
            {hasStaleDraft && (
              <Notice title="A draft meal changed or moved" tone="caution">
                Remove the marked meal from this draft, then find its current slot before selecting
                it again.
              </Notice>
            )}
            {scopeChanged && (
              <Notice title="Saved shopping selections changed" tone="caution">
                <AppText role="support">
                  Your draft is still here. Load the latest saved selections before making another
                  change.
                </AppText>
                <ActionButton
                  label="Replace draft with saved selections"
                  onPress={() => {
                    if (shopping.state.kind !== 'ready') return;
                    baseline.current = {
                      revision: shopping.state.value.scope.revision,
                      ids: shopping.state.value.scope.occurrenceIds,
                    };
                    committedAwaitingRead.current = null;
                    setDraft(new Set(shopping.state.value.scope.occurrenceIds));
                  }}
                />
              </Notice>
            )}
          </View>
        }
        ListEmptyComponent={
          plan.state.kind === 'ready' && shopping.state.kind === 'ready' ? (
            <Notice title="No planned meals in this week">
              Browse another week or add a meal to your plan.
            </Notice>
          ) : null
        }
        renderItem={({ item, index }) => {
          const recipe = mode === 'bundled' ? getRecipe(item.recipeId) : undefined;
          const saved = contentLookup.get(item.occurrenceId);
          const selected = draft?.has(item.occurrenceId) ?? false;
          const outside = outsideWeek(item);
          const previous = datedRows[index - 1];
          const startsDate =
            !previous || previous.placement.actualDate !== item.placement.actualDate;
          return (
            <View style={styles.mealGroup}>
              {outside && (!previous || !outsideWeek(previous)) && (
                <AppText role="section" accessibilityRole="header" style={styles.outsideHeading}>
                  Selected from other weeks
                </AppText>
              )}
              {startsDate && (
                <AppText role="bodyStrong" accessibilityRole="header" style={styles.dateHeading}>
                  {formatPlanDate(item.placement.actualDate)}
                </AppText>
              )}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={rowLabel(item)}
                accessibilityHint={
                  mode === 'bundled' && getRecipePhotoTreatment(item.recipeId)?.warningAnnotationId
                    ? 'Supplied photo association needs review. See recipe source notes.'
                    : undefined
                }
                {...controlStateProps(
                  {
                    checked: selected,
                    disabled: !ready,
                  },
                  'checkbox',
                )}
                disabled={!ready}
                onPress={() =>
                  setDraft((value) => {
                    const next = new Set(value);
                    if (next.has(item.occurrenceId)) next.delete(item.occurrenceId);
                    else next.add(item.occurrenceId);
                    return next;
                  })
                }
                style={({ pressed }) => [
                  styles.mealRow,
                  selected && styles.selectedRow,
                  pressed && styles.pressed,
                ]}
              >
                <View style={[styles.checkbox, selected && styles.checked]}>
                  {selected && <AppIcon name="check" size={16} color={t.color.onBrand} />}
                </View>
                <View style={[styles.mealContent, enlarged && styles.stacked]}>
                  {saved?.content.kind === 'readable' && (
                    <View style={styles.thumbnail}>
                      <ExactRecipePhoto
                        contentRef={saved.contentRef}
                        compact
                        aspectRatio={1}
                        borderRadius={t.radius.small}
                      />
                    </View>
                  )}
                  {recipe && (
                    <View style={styles.thumbnail}>
                      <RecipePhoto
                        recipeId={recipe.recipeId}
                        title={recipe.title}
                        aspectRatio={1}
                        compact
                        borderRadius={t.radius.small}
                      />
                    </View>
                  )}
                  <View style={styles.mealCopy}>
                    <AppText role="bodyStrong">{rowTitle(item)}</AppText>
                    <AppText role="support" color="inkSecondary">
                      {formatPlanDate(item.placement.actualDate)} ·{' '}
                      {mealLabel(item.placement.mealKey)}
                    </AppText>
                    {!current.some((entry) => entry.occurrenceId === item.occurrenceId) && (
                      <AppText role="support" color="inkSecondary">
                        {outside ? 'Selected outside this week' : 'Retained draft meal'} · current
                        details checked on review
                      </AppText>
                    )}
                  </View>
                </View>
              </Pressable>
              {staleIds.has(item.occurrenceId) && draft?.has(item.occurrenceId) && (
                <ActionButton
                  variant="secondary"
                  label={`Remove changed draft meal: ${rowLabel(item)}`}
                  onPress={() =>
                    setDraft((value) => {
                      const next = new Set(value);
                      next.delete(item.occurrenceId);
                      return next;
                    })
                  }
                />
              )}
            </View>
          );
        }}
      />
      <View style={styles.reviewFooter}>
        <ActionButton
          ref={focus.ref}
          label={`Review ${draft?.size ?? 0} selected meal${draft?.size === 1 ? '' : 's'}`}
          disabled={!ready}
          onPress={() => {
            if (!draft) return;
            setSubmitted([...draft]);
            void actions?.begin(
              { kind: 'setShoppingSelection', occurrenceIds: [...draft] },
              {
                confirm: true,
                observedSelectionRevision: baseline.current!.revision,
                restoreFocus: focus.restoreFocus,
              },
            );
          }}
        />
      </View>
    </Page>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    list: { flex: 1 },
    listContent: { gap: 0 },
    listHeader: { paddingBottom: t.space.sm },
    weekNavigation: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
    weekRange: { flex: 1, textAlign: 'center' },
    mealGroup: { gap: t.space.xs, marginBottom: t.space.xs },
    dateHeading: { paddingTop: t.space.md, paddingBottom: t.space.xs },
    outsideHeading: { paddingTop: t.space.lg },
    mealRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.sm,
      minHeight: t.control.minimumTarget,
      padding: t.space.md,
      borderRadius: t.radius.card,
      backgroundColor: t.color.surface,
    },
    selectedRow: { backgroundColor: t.color.selection },
    checkbox: {
      width: t.control.checkbox,
      height: t.control.checkbox,
      borderRadius: 7,
      borderWidth: 1.5,
      borderColor: t.color.inkSecondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checked: { borderColor: t.color.brand, backgroundColor: t.color.brand },
    mealContent: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.sm,
    },
    thumbnail: { width: t.layout.largeThumbnail, flexShrink: 0 },
    mealCopy: { flex: 1, minWidth: 0, gap: t.space.xxs },
    stacked: { flexDirection: 'column', alignItems: 'stretch' },
    draftActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      gap: t.space.xs,
    },
    reviewFooter: {
      paddingHorizontal: t.space.gutter,
      paddingVertical: t.space.sm,
      backgroundColor: t.color.canvas,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
    },
    pressed: { opacity: 0.7 },
  });
