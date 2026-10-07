import {
  canonicalContentJson,
  validateRecipeContentRef,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { Immutable, PlanSnapshot } from '@cookmate/domain';
import type {
  ContentPlanOccurrence,
  ContentPlanSnapshot,
} from '../../data/contentWorkspaceQueries';
import type { QueryState } from './WorkspaceProvider';

export type PlanDisplayOccurrence = PlanSnapshot['occurrences'][number] & {
  readonly content?: Immutable<ContentPlanOccurrence>;
};
export type PlanDisplaySnapshot = Omit<PlanSnapshot, 'occurrences'> & {
  readonly occurrences: readonly PlanDisplayOccurrence[];
};
type PlanQuery =
  | { mode: 'bundled'; state: QueryState<PlanSnapshot> }
  | { mode: 'content'; state: QueryState<Immutable<ContentPlanSnapshot>> };

/** Display convenience only. The exact saved pin remains attached to each content occurrence. */
export function planSnapshotForDisplay(query: PlanQuery): PlanDisplaySnapshot | undefined {
  if (query.mode === 'content') {
    const value = query.state.kind === 'ready' ? query.state.value : query.state.previous;
    return (
      value && {
        ...value,
        occurrences: value.occurrences.map((entry) => ({ ...entry.occurrence, content: entry })),
      }
    );
  }
  return query.state.kind === 'ready' ? query.state.value : query.state.previous;
}

export function samePlanContentRef(
  left: Readonly<RecipeContentRef>,
  right: Readonly<RecipeContentRef>,
) {
  return (
    left.recipeId === right.recipeId &&
    left.revisionId === right.revisionId &&
    left.contentFingerprint === right.contentFingerprint
  );
}

export function planRouteContentRef(
  raw: unknown,
  recipeId: unknown,
): Readonly<RecipeContentRef> | null {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    canonicalContentJson(value, 1024);
    return validateRecipeContentRef(value) && value.recipeId === recipeId
      ? Object.freeze(value)
      : null;
  } catch {
    return null;
  }
}
