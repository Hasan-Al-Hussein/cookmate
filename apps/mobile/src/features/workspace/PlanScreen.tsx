import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getRecipe, getRecipePhotoTreatment } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { getPlanWeek, isSupportedPlanDate, shiftPlanDate } from '@cookmate/domain';
import { Page, PageHeader } from '../../components/Page';
import { ActionButton, Notice, SegmentControl } from '../../components/Controls';
import { AppIcon, IconButton, type IconName } from '../../components/Icon';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText } from '../../components/Typography';
import { controlStateProps } from '../../components/controlStateProps';
import { useOrdinaryPlanQuery, useOrdinaryWorkspaceActions } from '../content/useOrdinaryWorkspace';
import { QueryFeedback, WorkspaceFeedback } from './WorkspaceFeedback';
import { formatPlanDate, mealLabel } from './runtimeClock';
import { ShoppingScreen } from '../shopping/ShoppingScreen';
import { useActionFocus } from '../../hooks/useActionFocus';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { ContentFade } from '../../components/ContentFade';
import { FocusedSheet } from '../../components/FocusedSheet';
import { focusTarget } from '../../components/focusTarget';
import { useMotionPolicy } from '../../design/MotionPolicy';
import { SelectionIndicator } from '../../components/SelectionIndicator';
import { ExactRecipePhoto } from './ExactRecipePhoto';
import { planSnapshotForDisplay, type PlanDisplayOccurrence } from './ordinaryPlanModel';
import { usePlanningPreferences } from '../planning-preferences/PlanningPreferencesProvider';

export const meals = ['breakfast', 'lunch', 'dinner'] as const;
const mealIcons: Record<(typeof meals)[number], IconName> = {
  breakfast: 'coffee',
  lunch: 'sun',
  dinner: 'moon',
};

function PlannedMeal({
  occurrence,
  selectedForShopping,
  disabled,
}: {
  occurrence: PlanDisplayOccurrence;
  selectedForShopping: boolean;
  disabled: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  const { actions } = useOrdinaryWorkspaceActions();
  const { enlarged } = useNativeLayout();
  const focus = useActionFocus();
  const router = useRouter();
  const [menuState, setMenuState] = useState<'open' | 'closing' | null>(null);
  const menuOpen = menuState === 'open';
  const pendingAction = useRef<{
    kind: 'edit' | 'remove';
    occurrence: PlanDisplayOccurrence;
  } | null>(null);
  const recipe = occurrence.content ? undefined : getRecipe(occurrence.recipeId);
  const exact = occurrence.content;
  const title = exact
    ? exact.content.kind === 'readable'
      ? exact.content.title
      : 'Saved recipe unavailable'
    : recipe?.title;
  const readable = exact ? exact.content.kind === 'readable' : !!recipe;
  const needsPhotoReview =
    !exact && !!getRecipePhotoTreatment(occurrence.recipeId)?.warningAnnotationId;
  const live = useRef(true);
  const latest = useRef({ occurrence, disabled });
  latest.current = { occurrence, disabled };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () =>
    live.current && latest.current.occurrence === occurrence && !latest.current.disabled;
  const { actualDate: day, mealKey: meal } = occurrence.placement;
  function closeMenu() {
    pendingAction.current = null;
    setMenuState('closing');
  }
  function finishDismissal() {
    const action = pendingAction.current;
    pendingAction.current = null;
    setMenuState(null);
    if (action && (!current() || action.occurrence !== occurrence)) return;
    if (action?.kind === 'edit') {
      router.push({
        pathname: '/plan-edit',
        params: {
          occurrenceId: occurrence.occurrenceId,
          recipeId: occurrence.recipeId,
          date: day,
          meal,
          ...(exact ? { contentRef: canonicalContentJson(exact.contentRef) } : {}),
        },
      });
    } else if (action?.kind === 'remove') {
      void actions?.begin(
        { kind: 'removePlan', occurrenceId: occurrence.occurrenceId },
        {
          confirm: true,
          restoreFocus: focus.restoreFocus,
          restoreAfterCommitRemoval: true,
        },
      );
    } else if (live.current) {
      focus.restoreFocus();
    }
  }
  return (
    <View style={styles.slot}>
      <View style={styles.mealRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title ?? 'Unavailable recipe'}
          accessibilityHint={
            needsPhotoReview
              ? 'Supplied photo association needs review. See recipe source notes.'
              : undefined
          }
          {...controlStateProps({ disabled: !readable || disabled }, 'button')}
          disabled={!readable || disabled}
          onPress={() => {
            if (current() && readable)
              router.push({
                pathname: '/recipe/[id]',
                params: {
                  id: occurrence.recipeId,
                  ...(exact ? { contentRef: canonicalContentJson(exact.contentRef) } : {}),
                },
              });
          }}
          style={({ pressed }) => [
            styles.recipeLink,
            enlarged && styles.stacked,
            pressed && styles.pressed,
          ]}
        >
          {(recipe || (exact && readable)) && (
            <View style={styles.thumbnail}>
              {exact ? (
                <ExactRecipePhoto
                  contentRef={exact.contentRef}
                  aspectRatio={1}
                  compact
                  borderRadius={t.radius.small}
                />
              ) : (
                recipe && (
                  <RecipePhoto
                    recipeId={recipe.recipeId}
                    title={recipe.title}
                    aspectRatio={1}
                    compact
                    borderRadius={t.radius.small}
                  />
                )
              )}
            </View>
          )}
          <View style={styles.mealText}>
            <AppText role="label" color="inkSecondary">
              {mealLabel(meal)}
            </AppText>
            <AppText role="bodyStrong">{title ?? 'Unavailable recipe'}</AppText>
            {exact?.content.kind === 'readable' && exact.content.state !== 'current' && (
              <AppText role="support" color="inkSecondary">
                Saved recipe version
              </AppText>
            )}
            {exact?.content.kind === 'unavailable' && (
              <AppText role="support" color="inkSecondary">
                The dated meal is retained. Its recipe version cannot be opened here.
              </AppText>
            )}
            <AppText role="support" color="inkSecondary">
              {selectedForShopping ? 'Included in shopping' : 'Not included'}
            </AppText>
          </View>
        </Pressable>
        <IconButton
          ref={focus.ref}
          name="more"
          tone="quiet"
          label={`Meal options for ${mealLabel(meal)} on ${formatPlanDate(day)}`}
          accessibilityState={{ expanded: menuOpen }}
          disabled={disabled}
          onPress={() => {
            if (current()) setMenuState('open');
          }}
        />
      </View>
      {menuState !== null && (
        <FocusedSheet
          visible={menuOpen}
          title={`${mealLabel(meal)} options`}
          onClose={closeMenu}
          onDismiss={finishDismissal}
        >
          <View style={styles.menuSummary}>
            <AppText role="support" color="inkSecondary">
              {formatPlanDate(day)}
            </AppText>
            <AppText role="section">{title ?? 'Unavailable recipe'}</AppText>
            <AppText role="support" color="inkSecondary">
              {selectedForShopping ? 'Included in shopping' : 'Not included in shopping'}
            </AppText>
            {needsPhotoReview && (
              <AppText role="support" color="caution">
                Supplied photo association needs review. See recipe source notes.
              </AppText>
            )}
          </View>
          <View style={styles.mealMenu}>
            <ActionButton
              variant="secondary"
              label={`Edit ${meal}`}
              disabled={disabled}
              onPress={() => {
                if (!current()) return;
                pendingAction.current = { kind: 'edit', occurrence };
                setMenuState('closing');
              }}
            />
            <AppText role="support" color="inkSecondary">
              Change the recipe, or move this meal to another date or meal slot.
            </AppText>
          </View>
          <View style={styles.removeMenu}>
            <ActionButton
              variant="quiet"
              label={`Remove ${meal}`}
              disabled={disabled}
              onPress={() => {
                if (!current()) return;
                pendingAction.current = { kind: 'remove', occurrence };
                setMenuState('closing');
              }}
            />
            <AppText role="support" color="inkSecondary">
              Review the meal and shopping changes before removing it.
            </AppText>
          </View>
        </FocusedSheet>
      )}
    </View>
  );
}

export function PlanScreen() {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useMotionPolicy();
  const scroll = useRef<ScrollView>(null);
  const headings = useRef(new Map<string, View>());
  const pendingJump = useRef<{ day: string } | null>(null);
  const jumpFrame = useRef<number | null>(null);
  const attemptJump = useCallback(() => {
    const request = pendingJump.current;
    const heading = request && headings.current.get(request.day);
    const content = scroll.current?.getInnerViewNode();
    if (!request || !heading || !content) return;
    heading.measureLayout(
      content,
      (_x, y) => {
        if (pendingJump.current !== request || headings.current.get(request.day) !== heading)
          return;
        pendingJump.current = null;
        scroll.current?.scrollTo({ y: Math.max(0, y - t.space.sm), animated: !reducedMotion });
        focusTarget(heading);
      },
      () => undefined,
    );
  }, [reducedMotion, t.space.sm]);
  function requestJump(day: string) {
    pendingJump.current = { day };
    if (jumpFrame.current !== null) cancelAnimationFrame(jumpFrame.current);
    jumpFrame.current = requestAnimationFrame(attemptJump);
  }
  useEffect(
    () => () => {
      if (jumpFrame.current !== null) cancelAnimationFrame(jumpFrame.current);
      pendingJump.current = null;
    },
    [],
  );

  const { clock, actions, scopeKey } = useOrdinaryWorkspaceActions();
  const { preferences } = usePlanningPreferences();
  const params = useLocalSearchParams<{ date?: string }>();
  const { enlarged } = useNativeLayout();
  const [date, setDate] = useState(() =>
    typeof params.date === 'string' && isSupportedPlanDate(params.date)
      ? params.date
      : clock.dateContext().localDate,
  );
  useEffect(() => {
    if (typeof params.date === 'string' && isSupportedPlanDate(params.date)) setDate(params.date);
  }, [params.date]);
  const [section, setSection] = useState<'plan' | 'shopping'>('plan');
  const [fullWeek, setFullWeek] = useState(false);
  const week = getPlanWeek(date, preferences.weekStart);
  const query = useOrdinaryPlanQuery(
    `plan:${week.startDate}:${week.endDate}`,
    week.startDate,
    week.endDate,
  );
  const snapshot = planSnapshotForDisplay(query);
  const ready = query.state.kind === 'ready' && !!actions && !actions.blocked;
  // A retained snapshot keeps its actual date range while a different week is unconfirmed.
  const displayedWeek = snapshot
    ? {
        ...week,
        startDate: snapshot.startDate,
        endDate: snapshot.endDate,
        days: Array.from({ length: 7 }, (_, offset) =>
          shiftPlanDate(snapshot.startDate, offset),
        ).filter((day): day is string => day !== null && day <= snapshot.endDate),
      }
    : week;
  const selectedDay = displayedWeek.days.includes(date) ? date : displayedWeek.startDate;
  const today = clock.dateContext().localDate;
  const displayedDays = fullWeek ? displayedWeek.days : [selectedDay];
  useEffect(() => {
    if (!pendingJump.current) return;
    const frame = requestAnimationFrame(attemptJump);
    return () => cancelAnimationFrame(frame);
  }, [selectedDay, fullWeek, snapshot, section, attemptJump]);
  const router = useRouter();
  const header = (
    <>
      <PageHeader title="Your plan" />
      <WorkspaceFeedback checklist={section === 'shopping'} />
      <SegmentControl
        value={section}
        onChange={setSection}
        options={[
          { value: 'plan', label: 'Meal plan' },
          { value: 'shopping', label: 'Shopping' },
        ]}
      />
    </>
  );
  if (section === 'shopping') return <ShoppingScreen header={header} weekDate={date} />;
  return (
    <Page scrollRef={scroll}>
      {header}
      <View style={styles.weekNavigation}>
        <IconButton
          name="chevronLeft"
          label="Previous week"
          disabled={!displayedWeek.previousWeek}
          onPress={() => displayedWeek.previousWeek && setDate(displayedWeek.previousWeek)}
        />
        <AppText role="bodyStrong" style={styles.weekRange}>
          {formatPlanDate(displayedWeek.startDate, true)} – {formatPlanDate(displayedWeek.endDate)}
        </AppText>
        <IconButton
          name="chevronRight"
          label="Next week"
          disabled={!displayedWeek.nextWeek}
          onPress={() => displayedWeek.nextWeek && setDate(displayedWeek.nextWeek)}
        />
      </View>
      <View style={[styles.viewActions, enlarged && styles.stacked]}>
        <ActionButton
          variant="quiet"
          label="Today"
          onPress={() => {
            const currentDay = clock.dateContext().localDate;
            setDate(currentDay);
            requestJump(currentDay);
          }}
        />
        <ActionButton
          variant="quiet"
          label={fullWeek ? 'View selected day' : 'View full week'}
          onPress={() => {
            setFullWeek((value) => !value);
            requestJump(selectedDay);
          }}
        />
      </View>
      <QueryFeedback {...query} noun="meal plan" />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.dayStrip}
      >
        {displayedWeek.days.map((day) => {
          const selected = day === selectedDay;
          const occurrences =
            snapshot?.occurrences.filter((entry) => entry.placement.actualDate === day) ?? [];
          return (
            <Pressable
              key={day}
              accessibilityRole="button"
              accessibilityLabel={`${formatPlanDate(day)}${day === today ? ', today' : ''}${occurrences.length ? `, ${occurrences.length} planned ${occurrences.length === 1 ? 'meal' : 'meals'}` : ''}`}
              accessibilityHint={
                occurrences.length
                  ? `${occurrences.map((entry) => mealLabel(entry.placement.mealKey)).join(', ')} planned`
                  : 'No meals planned'
              }
              {...controlStateProps({ selected }, 'button')}
              onPress={() => {
                setDate(day);
                requestJump(day);
              }}
              style={({ pressed }) => [
                styles.day,
                enlarged && styles.largeDay,
                day === today && styles.today,
                selected && styles.selectedDay,
                pressed && styles.pressed,
              ]}
            >
              <AppText role="support" color={selected ? 'onBrand' : 'inkSecondary'}>
                {formatPlanDate(day, true).split(' ')[0]}
              </AppText>
              <View style={styles.dayNumber}>
                <AppText role="bodyStrong" color={selected ? 'onBrand' : 'ink'}>
                  {Number(day.slice(8))}
                </AppText>
                <SelectionIndicator selected={selected}>
                  <AppIcon name="check" size={12} color={t.color.onBrand} />
                </SelectionIndicator>
              </View>
              {day === today && (
                <AppText role="support" color={selected ? 'onBrand' : 'brand'}>
                  Today
                </AppText>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
      {fullWeek && (
        <View style={styles.weekOrientation}>
          <AppText role="support" color="inkSecondary" style={styles.weekOrientationText}>
            {formatPlanDate(displayedWeek.startDate).split(' ')[0]} to{' '}
            {formatPlanDate(displayedWeek.endDate).split(' ')[0]} · selected{' '}
            {formatPlanDate(selectedDay, true)}
          </AppText>
          <ActionButton
            variant="quiet"
            label="Jump to selected day"
            onPress={() => requestJump(selectedDay)}
          />
        </View>
      )}
      <ContentFade selection={displayedDays.join(',')} style={styles.days}>
        {snapshot &&
          displayedDays.map((day) => (
            <View key={day} style={styles.dayMeals}>
              <View
                ref={(node) => {
                  if (node) headings.current.set(day, node);
                  else headings.current.delete(day);
                }}
                accessible
                accessibilityRole="header"
                accessibilityLabel={formatPlanDate(day)}
                onLayout={attemptJump}
              >
                <AppText role="section">{formatPlanDate(day)}</AppText>
              </View>
              <AppText role="support" color="inkSecondary">
                {snapshot.occurrences.filter((entry) => entry.placement.actualDate === day).length}{' '}
                {snapshot.occurrences.filter((entry) => entry.placement.actualDate === day)
                  .length === 1
                  ? 'meal planned'
                  : 'meals planned'}
              </AppText>
              {meals.map((meal) => {
                const occurrence = snapshot.occurrences.find(
                  (entry) => entry.placement.actualDate === day && entry.placement.mealKey === meal,
                );
                return occurrence ? (
                  <PlannedMeal
                    key={`${scopeKey}:${occurrence.occurrenceId}`}
                    occurrence={occurrence}
                    selectedForShopping={snapshot.shoppingScope.occurrenceIds.includes(
                      occurrence.occurrenceId,
                    )}
                    disabled={!ready}
                  />
                ) : (
                  <View
                    key={meal}
                    style={[styles.slot, styles.emptySlot, enlarged && styles.stacked]}
                  >
                    <View style={styles.mealSymbol}>
                      <AppIcon name={mealIcons[meal]} color={t.color.brandText} />
                    </View>
                    <View style={styles.mealText}>
                      <AppText role="bodyStrong">{mealLabel(meal)}</AppText>
                      <AppText role="support" color="inkSecondary">
                        Choose a recipe.
                      </AppText>
                    </View>
                    <ActionButton
                      variant="quiet"
                      label={`Add ${meal}`}
                      accessibilityLabel={`Plan ${meal}`}
                      disabled={!ready}
                      onPress={() =>
                        router.push({ pathname: '/plan-edit', params: { date: day, meal } })
                      }
                    />
                  </View>
                );
              })}
            </View>
          ))}
      </ContentFade>
      {query.state.kind === 'ready' && query.state.value.occurrences.length === 0 && (
        <Notice title="This week is open">
          Choose a meal slot to start your plan. Shopping selections stay saved when you browse
          another week.
        </Notice>
      )}
      <View style={styles.shoppingEntry}>
        <View style={styles.shoppingHeading}>
          <AppIcon name="shopping" color={t.color.brandText} />
          <AppText role="section" style={styles.shoppingTitle}>
            Your shopping list
          </AppText>
        </View>
        <AppText role="support" color="inkSecondary">
          Choose which dated meals to shop for, including meals from other weeks.
        </AppText>
        <ActionButton
          label="Choose meals for shopping"
          disabled={!ready}
          onPress={() =>
            router.push({ pathname: '/shopping-meals', params: { date: selectedDay } })
          }
        />
      </View>
    </Page>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    weekNavigation: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
    weekRange: { flex: 1, textAlign: 'center' },
    viewActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      gap: t.space.xs,
      marginTop: -t.space.md,
    },
    dayStrip: { gap: t.space.xxs, paddingVertical: t.space.xxs },
    dayNumber: { flexDirection: 'row', alignItems: 'center', gap: t.space.xxs },
    weekOrientation: { gap: t.space.xs, alignItems: 'flex-start' },
    weekOrientationText: { flexShrink: 1 },
    day: {
      minWidth: t.control.minimumTarget,
      minHeight: 72,
      paddingHorizontal: t.space.xs,
      paddingVertical: t.space.sm,
      borderRadius: t.radius.control,
      backgroundColor: t.color.surface,
      borderWidth: 1,
      borderColor: 'transparent',
      alignItems: 'center',
      gap: t.space.xxs,
    },
    largeDay: { minWidth: 72 },
    today: { borderColor: t.color.brand },
    selectedDay: { backgroundColor: t.color.brand, borderColor: t.color.brand },
    days: { gap: t.space.lg },
    dayMeals: { gap: t.space.sm },
    slot: {
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      padding: t.space.sm,
      gap: t.space.sm,
    },
    mealRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.xxs },
    recipeLink: {
      flex: 1,
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.sm,
    },
    thumbnail: { width: t.layout.largeThumbnail, flexShrink: 0 },
    mealText: { flex: 1, minWidth: 0, gap: t.space.xxs },
    menuSummary: { gap: t.space.xs },
    mealMenu: { gap: t.space.xs },
    removeMenu: {
      gap: t.space.xs,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      paddingTop: t.space.md,
    },
    emptySlot: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    mealSymbol: {
      width: t.control.minimumTarget,
      height: t.control.minimumTarget,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.selection,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stacked: { flexDirection: 'column', alignItems: 'stretch' },
    pressed: { opacity: 0.7 },
    shoppingEntry: {
      gap: t.space.sm,
      backgroundColor: t.color.surfaceMuted,
      borderRadius: t.radius.card,
      padding: t.space.md,
    },
    shoppingHeading: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    shoppingTitle: { flex: 1, minWidth: 0 },
  });
