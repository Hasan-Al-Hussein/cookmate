import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getRecipe } from '@cookmate/catalogue';
import { getPlanWeek, type Immutable, type ShoppingSnapshot } from '@cookmate/domain';
import { ActionButton } from '../../components/Controls';
import { FocusedSheet } from '../../components/FocusedSheet';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText } from '../../components/Typography';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import type { ContentPlanOccurrence } from '../../data/contentWorkspaceQueries';
import { ExactRecipePhoto } from '../workspace/ExactRecipePhoto';
import { recipeReferenceKey, type ShoppingRecipeNotes } from './ordinaryShoppingModel';
export type { ShoppingRecipeNotes } from './ordinaryShoppingModel';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import { usePlanningPreferences } from '../planning-preferences/PlanningPreferencesProvider';

// Only reviewed annotation identities get shorter copy. Unknown notes stay complete.
export const sourceNoteSummaries: Readonly<Record<string, string>> = {
  '52982-ingredient-method-conflict': 'Carbonara: the ingredient list and method conflict.',
  '52835-alternative-garnish': 'Alfredo: chives or parsley are alternatives; you do not need both.',
};
export type ShoppingEvidence =
  | { kind: 'notes' }
  | { kind: 'scope' }
  | { kind: 'ingredient'; groupKey: string }
  | null;

export function ShoppingEvidenceSheets({
  evidence,
  snapshot,
  notes,
  contentEntries,
  week,
  canChangeMeals,
  onClose,
  onReturnFocus,
  onRecipeNavigation,
}: {
  evidence: ShoppingEvidence;
  snapshot: Immutable<ShoppingSnapshot> | undefined;
  notes: ShoppingRecipeNotes[];
  contentEntries?: readonly ContentPlanOccurrence[] | undefined;
  week: ReturnType<typeof getPlanWeek>;
  canChangeMeals: boolean;
  onClose(): void;
  onReturnFocus(): void;
  onRecipeNavigation(): void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const { preferences } = usePlanningPreferences();
  const live = useRef(true);
  const latest = useRef({
    snapshot,
    contentEntries,
    weekStart: week.startDate,
    weekEnd: week.endDate,
  });
  latest.current = { snapshot, contentEntries, weekStart: week.startDate, weekEnd: week.endDate };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () =>
    live.current &&
    latest.current.snapshot === snapshot &&
    latest.current.contentEntries === contentEntries &&
    latest.current.weekStart === week.startDate &&
    latest.current.weekEnd === week.endDate;
  const destination = useRef<
    | { recipeId: string; contentRef?: RecipeContentRef }
    | { changeMeals: true; startDate: string; endDate: string }
    | null
  >(null);
  const contentMode = contentEntries !== undefined;
  const byOccurrence = new Map(
    contentEntries?.map((entry) => [entry.occurrence.occurrenceId, entry]),
  );
  const referenceFor = (occurrenceId: string) => byOccurrence.get(occurrenceId)?.contentRef;
  const titleFor = (recipeId: string, occurrenceId: string) => {
    const saved = byOccurrence.get(occurrenceId);
    return contentMode
      ? saved?.content.kind === 'readable'
        ? saved.content.title
        : `Recipe ${recipeId} · saved version unavailable`
      : (getRecipe(recipeId)?.title ?? recipeId);
  };
  const group =
    evidence?.kind === 'ingredient'
      ? snapshot?.groups.find((entry) => entry.groupKey === evidence.groupKey)
      : undefined;
  const contributionKey = (entry: { recipeId: string; occurrenceId: string }) => {
    const ref = referenceFor(entry.occurrenceId);
    return ref ? recipeReferenceKey(ref) : entry.recipeId;
  };
  const recipes = [
    ...new Map(
      group?.contributions.map((entry) => [
        contributionKey(entry),
        {
          key: contributionKey(entry),
          recipeId: entry.recipeId,
          contentRef: referenceFor(entry.occurrenceId),
          title: titleFor(entry.recipeId, entry.occurrenceId),
        },
      ]) ?? [],
    ).values(),
  ];
  const meals = [...(snapshot?.selectedOccurrences ?? [])].sort(
    (a, b) =>
      a.placement.actualDate.localeCompare(b.placement.actualDate) ||
      ['breakfast', 'lunch', 'dinner'].indexOf(a.placement.mealKey) -
        ['breakfast', 'lunch', 'dinner'].indexOf(b.placement.mealKey),
  );
  function openRecipe(recipeId: string, contentRef?: RecipeContentRef) {
    if (!current()) return;
    if (contentMode && !contentRef) return;
    destination.current = { recipeId, ...(contentRef ? { contentRef } : {}) };
    onClose();
  }
  return (
    <FocusedSheet
      visible={evidence !== null}
      title={
        evidence?.kind === 'notes'
          ? 'Recipe source notes'
          : evidence?.kind === 'scope'
            ? 'Selected shopping meals'
            : `Sources for ${group?.displayName ?? 'ingredient'}`
      }
      onClose={onClose}
      onDismiss={() => {
        if (!current()) return;
        const next = destination.current;
        destination.current = null;
        if (!next) return onReturnFocus();
        if ('recipeId' in next) {
          onRecipeNavigation();
          router.push({
            pathname: '/recipe/[id]',
            params: {
              id: next.recipeId,
              section: 'source',
              ...(next.contentRef ? { contentRef: recipeReferenceKey(next.contentRef) } : {}),
            },
          });
        } else if (next.startDate === week.startDate && next.endDate === week.endDate)
          router.push({ pathname: '/shopping-meals', params: { date: next.startDate } });
      }}
    >
      {evidence?.kind === 'notes' &&
        notes.map((recipe) => (
          <View
            key={recipe.contentRef ? recipeReferenceKey(recipe.contentRef) : recipe.recipeId}
            style={styles.section}
          >
            <AppText role="section">{recipe.title}</AppText>
            {recipe.notes.map((note) => (
              <AppText key={note.annotationId}>{note.note}</AppText>
            ))}
            <ActionButton
              label="Open recipe source"
              accessibilityLabel={`Open source notes for ${recipe.title}`}
              variant="quiet"
              onPress={() => openRecipe(recipe.recipeId, recipe.contentRef)}
            />
          </View>
        ))}
      {evidence?.kind === 'scope' && (
        <View style={styles.section}>
          <AppText role="support" color="inkSecondary">
            Displayed week: {formatPlanDate(week.startDate, true)} – {formatPlanDate(week.endDate)}.
            Changing weeks keeps all saved selections.
          </AppText>
          <ActionButton
            label="Change meals"
            disabled={!canChangeMeals}
            onPress={() => {
              if (!current() || !canChangeMeals) return;
              destination.current = {
                changeMeals: true,
                startDate: week.startDate,
                endDate: week.endDate,
              };
              onClose();
            }}
          />
          {meals.map((meal, index) => {
            const recipe = contentMode ? undefined : getRecipe(meal.recipeId);
            const saved = byOccurrence.get(meal.occurrenceId);
            const mealWeek = getPlanWeek(meal.placement.actualDate, preferences.weekStart);
            const outside =
              meal.placement.actualDate < week.startDate ||
              meal.placement.actualDate > week.endDate;
            const previous = meals[index - 1];
            return (
              <View key={meal.occurrenceId} style={styles.section}>
                {(!previous ||
                  getPlanWeek(previous.placement.actualDate, preferences.weekStart).startDate !==
                    mealWeek.startDate) && (
                  <AppText role="bodyStrong" accessibilityRole="header">
                    {formatPlanDate(mealWeek.startDate, true)} – {formatPlanDate(mealWeek.endDate)}
                  </AppText>
                )}
                <View style={styles.meal}>
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
                  <View style={styles.copy}>
                    <AppText role="bodyStrong">
                      {titleFor(meal.recipeId, meal.occurrenceId)}
                    </AppText>
                    <AppText role="support" color="inkSecondary">
                      {formatPlanDate(meal.placement.actualDate)} ·{' '}
                      {mealLabel(meal.placement.mealKey)}
                    </AppText>
                    {outside && (
                      <AppText role="support" color="brand">
                        Outside displayed week
                      </AppText>
                    )}
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      )}
      {evidence?.kind === 'ingredient' && (
        <View style={styles.section}>
          {!group && <AppText>This ingredient is no longer in the current list.</AppText>}
          {group && !recipes.length && (
            <AppText>No recipe contributions are available for this item.</AppText>
          )}
          {recipes.map((recipe) => (
            <View key={recipe.key} style={styles.section}>
              <AppText role="section">{recipe.title}</AppText>
              {group?.contributions
                .filter((entry) => contributionKey(entry) === recipe.key)
                .map((entry) => {
                  const occurrence = snapshot?.selectedOccurrences.find(
                    (meal) => meal.occurrenceId === entry.occurrenceId,
                  );
                  return (
                    <View key={entry.contributionId} style={styles.contribution}>
                      <AppText>
                        {entry.rawName} ·{' '}
                        {entry.rawMeasure?.trim() ? entry.rawMeasure : 'Amount not supplied'}
                      </AppText>
                      {occurrence && (
                        <AppText role="support" color="inkSecondary">
                          {formatPlanDate(occurrence.placement.actualDate, true)} ·{' '}
                          {mealLabel(occurrence.placement.mealKey)}
                        </AppText>
                      )}
                      {entry.quantity.kind === 'review_source' && (
                        <AppText role="support" color="caution">
                          This contribution needs source review before shopping.
                        </AppText>
                      )}
                    </View>
                  );
                })}
              <ActionButton
                label="Open recipe source"
                variant="quiet"
                disabled={contentMode && !recipe.contentRef}
                onPress={() => openRecipe(recipe.recipeId, recipe.contentRef)}
              />
            </View>
          ))}
        </View>
      )}
    </FocusedSheet>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.sm },
    contribution: {
      gap: t.space.xs,
      paddingVertical: t.space.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    meal: {
      flexDirection: 'row',
      gap: t.space.sm,
      alignItems: 'flex-start',
      paddingVertical: t.space.sm,
    },
    thumbnail: { width: t.layout.thumbnail, flexShrink: 0 },
    copy: { flex: 1, minWidth: 0, gap: t.space.xxs },
  });
