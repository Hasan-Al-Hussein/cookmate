import { canonicalContentJson, type RecipeContentRef } from '@cookmate/catalogue/content';
import { getRecipe } from '@cookmate/catalogue';
import type { PlanOccurrence, ShoppingScope } from '@cookmate/contracts';
import type { Immutable, PlanSnapshot, ShoppingSnapshot } from '@cookmate/domain';
import type { ContentPlanOccurrence } from '../../data/contentWorkspaceQueries';
import type { QueryState } from '../workspace/WorkspaceProvider';
import type {
  useOrdinaryPlanQuery,
  useOrdinaryShoppingQuery,
} from '../content/useOrdinaryWorkspace';
import { getRecipeSourceNotices } from '../recipes/sourceNotices';

export const recipeReferenceKey = (ref: RecipeContentRef) => canonicalContentJson(ref, 1024);
export type ShoppingRecipeNotes = {
  recipeId: string;
  title: string;
  contentRef?: RecipeContentRef;
  notes: ReturnType<typeof getRecipeSourceNotices>;
};
export type SelectedMeals = {
  scope: Immutable<ShoppingScope>;
  selectedOccurrences: readonly Immutable<PlanOccurrence>[];
};

function mapState<A, B>(state: QueryState<A>, convert: (value: A) => B): QueryState<B> {
  if (state.kind === 'ready') return { ...state, value: convert(state.value) };
  const previous = state.previous === undefined ? {} : { previous: convert(state.previous) };
  return state.kind === 'loading'
    ? { kind: 'loading', ...previous }
    : { kind: 'failed', error: state.error, ...previous };
}
export function selectionPlan(
  query: ReturnType<typeof useOrdinaryPlanQuery>,
): QueryState<PlanSnapshot> {
  return query.mode === 'bundled'
    ? query.state
    : mapState(query.state, (value) => ({
        ...value,
        occurrences: value.occurrences.map((entry) => entry.occurrence),
      }));
}
export function shoppingSelection(
  query: ReturnType<typeof useOrdinaryShoppingQuery>,
): QueryState<SelectedMeals> {
  return query.mode === 'bundled'
    ? query.state
    : mapState(query.state, (value) => ({
        scope: value.kind === 'current' ? value.snapshot.scope : value.scope,
        selectedOccurrences: value.selected.map((entry) => entry.occurrence),
      }));
}
export function shoppingPresentation(
  query: ReturnType<typeof useOrdinaryShoppingQuery>,
): QueryState<ShoppingSnapshot> {
  if (query.mode === 'bundled') return query.state;
  const state = query.state;
  if (state.kind === 'ready')
    return state.value.kind === 'current'
      ? { ...state, value: state.value.snapshot }
      : {
          kind: 'failed',
          error: {
            code: 'storage_failure',
            messageKey: 'content.shopping_unavailable',
            retry: 'after_correction',
          },
        };
  // An unavailable exact revision is never represented by an empty or partial ingredient list.
  const previous = state.previous?.kind === 'current' ? { previous: state.previous.snapshot } : {};
  return state.kind === 'loading'
    ? { kind: 'loading', ...previous }
    : { kind: 'failed', error: state.error, ...previous };
}
export function shoppingContentEntries(
  query: ReturnType<typeof useOrdinaryShoppingQuery>,
): readonly ContentPlanOccurrence[] | undefined {
  if (query.mode === 'bundled') return undefined;
  const value = query.state.kind === 'ready' ? query.state.value : query.state.previous;
  return value?.selected ?? [];
}
export function shoppingNotes(
  query: ReturnType<typeof useOrdinaryShoppingQuery>,
): ShoppingRecipeNotes[] {
  if (query.mode === 'bundled') {
    const value = query.state.kind === 'ready' ? query.state.value : query.state.previous;
    return [...new Set(value?.selectedOccurrences.map((meal) => meal.recipeId) ?? [])].flatMap(
      (recipeId) => {
        const recipe = getRecipe(recipeId);
        const notes = recipe ? getRecipeSourceNotices(recipe) : [];
        return recipe && notes.length ? [{ recipeId, title: recipe.title, notes }] : [];
      },
    );
  }
  const value = query.state.kind === 'ready' ? query.state.value : query.state.previous;
  if (value?.kind !== 'current') return [];
  const grouped = new Map<string, ShoppingRecipeNotes>();
  for (const notice of value.notices) {
    const key = recipeReferenceKey(notice.contentRef);
    const row = value.selected.find((entry) => recipeReferenceKey(entry.contentRef) === key);
    const current: ShoppingRecipeNotes = grouped.get(key) ?? {
      recipeId: notice.contentRef.recipeId,
      contentRef: notice.contentRef,
      title:
        row?.content.kind === 'readable'
          ? row.content.title
          : `Recipe ${notice.contentRef.recipeId}`,
      notes: [],
    };
    const seen = new Set(current.notes.map((note) => note.annotationId));
    for (const note of notice.annotations)
      if (!seen.has(note.annotationId)) {
        current.notes.push(note);
        seen.add(note.annotationId);
      }
    if (current.notes.length) grouped.set(key, current);
  }
  return [...grouped.values()];
}
