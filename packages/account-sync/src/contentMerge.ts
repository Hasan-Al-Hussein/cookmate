import {
  catalogueMatches,
  validateRecipeContentRef,
  type RecipeContentRef,
} from '@cookmate/contracts';
import type { Immutable } from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../domain/src/portableBackupContent';
import {
  canonicalAccountContentSnapshot,
  normalizeAccountContentSnapshot,
  type AccountContentCookingHistory,
  type AccountContentHistoryRecord,
  type AccountContentSnapshot,
} from './contentSnapshot';
import { mergeCoreData } from './merge';
import { mergeExpandedData } from './expandedMerge';
import { createMerger, equal } from './mergeEngine';
import { exact } from './validationPrimitives';
import {
  AccountSnapshotError,
  type AccountConflictValue,
  type AccountMergeConflict,
  type AccountMergeNotice,
  type AccountMergeResolutions,
  type AccountPlanOccurrence,
  type AccountSnapshotV2,
} from './types';

/** Private merge only; this is not an account writer or scope-approval authority. */
export interface AccountContentMergeInput {
  base: AccountContentSnapshot;
  local: AccountContentSnapshot;
  account: AccountContentSnapshot;
  contentScope: { schemaVersion: 3; historyIncluded: boolean };
  resolutions?: AccountMergeResolutions;
  reviewPersonalRemovals?: boolean;
}
export interface AccountContentPlanOccurrence extends AccountPlanOccurrence {
  contentRef: RecipeContentRef;
}
export type AccountContentConflictValue =
  | Exclude<AccountConflictValue, AccountPlanOccurrence | AccountPlanOccurrence[]>
  | AccountContentPlanOccurrence
  | AccountContentPlanOccurrence[];
export interface AccountContentMergeConflict extends Omit<
  AccountMergeConflict,
  'base' | 'local' | 'account'
> {
  base: AccountContentConflictValue;
  local: AccountContentConflictValue;
  account: AccountContentConflictValue;
}
export type AccountContentMergeResult =
  | { status: 'merged'; snapshot: Immutable<AccountContentSnapshot>; notices: AccountMergeNotice[] }
  | {
      status: 'needs_review';
      conflicts: AccountContentMergeConflict[];
      notices: AccountMergeNotice[];
    }
  | { status: 'incompatible_catalogue' };

function invalid(): never {
  throw new AccountSnapshotError('invalid_structure');
}
function ownInput(input: unknown): AccountContentMergeInput {
  let value: unknown;
  try {
    // Three independently capped snapshots plus bounded review choices; no getters execute.
    value = JSON.parse(canonicalPortableContentJson(input));
  } catch (error) {
    throw new AccountSnapshotError(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_structure',
    );
  }
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'contentScope'))
    throw new AccountSnapshotError('scope_review_required');
  if (
    !exact(value, [
      'base',
      'local',
      'account',
      'contentScope',
      ...(Object.hasOwn(value, 'resolutions') ? ['resolutions'] : []),
      ...(Object.hasOwn(value, 'reviewPersonalRemovals') ? ['reviewPersonalRemovals'] : []),
    ]) ||
    !exact(value.contentScope, ['schemaVersion', 'historyIncluded']) ||
    value.contentScope.schemaVersion !== 3 ||
    typeof value.contentScope.historyIncluded !== 'boolean' ||
    (Object.hasOwn(value, 'reviewPersonalRemovals') &&
      typeof value.reviewPersonalRemovals !== 'boolean')
  )
    invalid();
  // Each branch is strictly normalized at the account byte cap, and then detached for shared helpers.
  const own = (branch: unknown): AccountContentSnapshot =>
    JSON.parse(canonicalAccountContentSnapshot(branch)) as AccountContentSnapshot;
  const base = own(value.base),
    local = own(value.local),
    account = own(value.account);
  if (value.contentScope.historyIncluded && !local.cookingHistory)
    throw new AccountSnapshotError('scope_review_required');
  const result: AccountContentMergeInput = {
    base,
    local,
    account,
    contentScope: { schemaVersion: 3, historyIncluded: value.contentScope.historyIncluded },
    ...(Object.hasOwn(value, 'reviewPersonalRemovals')
      ? { reviewPersonalRemovals: value.reviewPersonalRemovals as boolean }
      : {}),
  };
  if (Object.hasOwn(value, 'resolutions')) {
    const resolutions = value.resolutions;
    if (
      !resolutions ||
      typeof resolutions !== 'object' ||
      Array.isArray(resolutions) ||
      Object.values(resolutions).some((choice) => choice !== 'local' && choice !== 'account')
    )
      throw new AccountSnapshotError('invalid_resolution');
    result.resolutions = resolutions as AccountMergeResolutions;
  }
  return result;
}
function joined(
  value: AccountContentSnapshot,
): AccountSnapshotV2 & { plan: AccountContentPlanOccurrence[] } {
  const { planReferences, cookingHistory: _history, ...core } = value;
  const refs = new Map(planReferences.map((item) => [item.occurrenceId, item.contentRef]));
  return {
    ...core,
    schemaVersion: 2,
    plan: value.plan.map((item) => ({ ...item, contentRef: refs.get(item.occurrenceId)! })),
  };
}
function occurrenceValue(value: AccountContentPlanOccurrence | null) {
  if (value === null) return null;
  return {
    occurrenceId: value.occurrenceId,
    recipeId: value.recipeId,
    placement: value.placement,
    contentRef: value.contentRef,
  };
}
function mergeHistory(
  base: AccountContentCookingHistory | undefined,
  local: AccountContentCookingHistory,
  account: AccountContentCookingHistory | undefined,
): AccountContentCookingHistory {
  const removedEventIds = [
    ...new Set([
      ...(base?.removedEventIds ?? []),
      ...local.removedEventIds,
      ...(account?.removedEventIds ?? []),
    ]),
  ];
  const removed = new Set(removedEventIds),
    entries = new Map<string, AccountContentHistoryRecord>();
  for (const branch of [base, local, account]) {
    for (const record of branch?.entries ?? []) {
      const previous = entries.get(record.entry.eventId);
      if (previous && !equal(previous, record))
        throw new AccountSnapshotError('history_identity_collision');
      entries.set(record.entry.eventId, record);
    }
  }
  return {
    entries: [...entries.values()].filter((item) => !removed.has(item.entry.eventId)),
    removedEventIds,
  };
}
function contentConflictValue(value: AccountConflictValue): value is AccountContentConflictValue {
  if (Array.isArray(value)) return value.every(contentConflictValue);
  if (value && typeof value === 'object' && 'occurrenceId' in value)
    return (
      'contentRef' in value &&
      validateRecipeContentRef(value.contentRef) &&
      value.contentRef.recipeId === value.recipeId
    );
  return true;
}
function contentConflict(value: AccountMergeConflict): AccountContentMergeConflict {
  if (
    !contentConflictValue(value.base) ||
    !contentConflictValue(value.local) ||
    !contentConflictValue(value.account)
  )
    invalid();
  return { ...value, base: value.base, local: value.local, account: value.account };
}

/** Same reviewed core/personal merge, with exact plan versions and immutable mixed history. */
export function mergeAccountContentSnapshots(
  rawInput: Immutable<AccountContentMergeInput>,
): AccountContentMergeResult {
  const input = ownInput(rawInput),
    { base, local, account } = input;
  const merger = createMerger(input);
  if (
    !catalogueMatches(base.catalogue, local.catalogue) ||
    !catalogueMatches(base.catalogue, account.catalogue)
  ) {
    merger.finish();
    return { status: 'incompatible_catalogue' };
  }
  const b = joined(base),
    l = joined(local),
    a = joined(account),
    notices: AccountMergeNotice[] = [];
  const expanded = mergeExpandedData(b, l, a, false, merger, input.reviewPersonalRemovals);
  const cookingHistory = input.contentScope.historyIncluded
    ? mergeHistory(base.cookingHistory, local.cookingHistory!, account.cookingHistory)
    : account.cookingHistory;
  const core = mergeCoreData<AccountContentPlanOccurrence>(b, l, a, merger, notices, {
    equivalent: (left, right) => equal(occurrenceValue(left), occurrenceValue(right)),
    canDeduplicate: (items) => items.every((item) => equal(item.contentRef, items[0]!.contentRef)),
  });
  merger.finish();
  if (core === null)
    return { status: 'needs_review', conflicts: merger.conflicts.map(contentConflict), notices };
  const planReferences = core.plan.map((item) => ({
    occurrenceId: item.occurrenceId,
    contentRef: item.contentRef,
  }));
  return {
    status: 'merged',
    notices,
    snapshot: normalizeAccountContentSnapshot({
      ...core,
      schemaVersion: 3,
      plan: core.plan.map(({ contentRef: _ref, ...item }) => item),
      planReferences,
      personal: expanded.personal,
      ...(cookingHistory === undefined ? {} : { cookingHistory }),
    }),
  };
}
