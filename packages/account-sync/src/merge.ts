import { catalogueMatches } from '@cookmate/contracts';
import type {
  AccountMergeInput,
  AccountMergeNotice,
  AccountMergeResult,
  AccountPlanOccurrence,
  AccountPreference,
  AccountSnapshot,
  AccountSnapshotV1,
} from './types';
import { AccountSnapshotError } from './types';
import { normalizeAccountSnapshot } from './validation';

import { equal, stableMetadata, createMerger, mergeRows } from './mergeEngine';
import type { Merger } from './mergeEngine';
import { mergeExpandedData } from './expandedMerge';
const slot = (item: AccountPlanOccurrence) =>
  JSON.stringify([item.placement.actualDate, item.placement.mealKey]);
const preferenceValue = (item: AccountPreference) => JSON.stringify([item.type, item.value]);
const occurrenceValue = (item: AccountPlanOccurrence | null) =>
  item === null
    ? null
    : {
        occurrenceId: item.occurrenceId,
        recipeId: item.recipeId,
        placement: item.placement,
      };
const occurrenceEqual = (left: AccountPlanOccurrence | null, right: AccountPlanOccurrence | null) =>
  equal(occurrenceValue(left), occurrenceValue(right));
interface CollisionOptions<T extends AccountPlanOccurrence | AccountPreference> {
  base: readonly T[];
  local: readonly T[];
  account: readonly T[];
  id: (item: T) => string;
  group: (item: T) => string;
  canDeduplicate: (items: T[]) => boolean;
  kind: 'slot_collision' | 'preference_collision';
  notice: 'deduplicated_occurrence' | 'deduplicated_preference';
  path: string;
}

function repairCollisions<T extends AccountPlanOccurrence | AccountPreference>(
  initial: T[],
  options: CollisionOptions<T>,
  merger: Merger,
  notices: AccountMergeNotice[],
): { items: T[]; remapped: Map<string, string> } {
  let items = initial;
  const remapped = new Map<string, string>();
  const baseIds = new Set(options.base.map(options.id));
  const localIds = new Set(options.local.map(options.id));
  const accountIds = new Set(options.account.map(options.id));
  while (true) {
    const groups = new Map<string, T[]>();
    for (const item of items) {
      const group = options.group(item);
      const entries = groups.get(group) ?? [];
      entries.push(item);
      groups.set(group, entries);
    }
    const collision = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .find(([, entries]) => entries.length > 1);
    if (!collision) return { items, remapped };
    const [group, entries] = collision;
    const ids = new Set(entries.map(options.id));
    const independentNew = entries.every((item) => {
      const id = options.id(item);
      return !baseIds.has(id) && localIds.has(id) !== accountIds.has(id);
    });
    if (independentNew && options.canDeduplicate(entries)) {
      const keeper = [...entries].sort((a, b) => (options.id(a) < options.id(b) ? -1 : 1))[0]!;
      items = items.filter(
        (item) => !ids.has(options.id(item)) || options.id(item) === options.id(keeper),
      );
      for (const item of entries)
        if (options.id(item) !== options.id(keeper)) {
          remapped.set(options.id(item), options.id(keeper));
          notices.push({
            kind: options.notice,
            fromId: options.id(item),
            toId: options.id(keeper),
          });
        }
      continue;
    }
    // Review all affected identities, including their other placements. Choosing a side must
    // not silently delete a meal which that side kept at a different date/slot.
    const affected = (source: readonly T[]) => source.filter((item) => ids.has(options.id(item)));
    const beforeCount = merger.conflicts.length;
    const chosen = merger.choose(
      options.kind,
      `${options.path}/${group}`,
      affected(options.base) as AccountPlanOccurrence[] | AccountPreference[],
      affected(options.local) as AccountPlanOccurrence[] | AccountPreference[],
      affected(options.account) as AccountPlanOccurrence[] | AccountPreference[],
    ) as T[];
    if (merger.conflicts.length > beforeCount) return { items, remapped };
    items = [...items.filter((item) => !ids.has(options.id(item))), ...chosen];
  }
}

function mergeFavourites(
  base: Pick<AccountSnapshot, 'favourites'>,
  local: Pick<AccountSnapshot, 'favourites'>,
  account: Pick<AccountSnapshot, 'favourites'>,
) {
  const before = new Map(base.favourites.map((item) => [item.recipeId, item]));
  const device = new Map(local.favourites.map((item) => [item.recipeId, item]));
  const server = new Map(account.favourites.map((item) => [item.recipeId, item]));
  return [...new Set([...before.keys(), ...device.keys(), ...server.keys()])]
    .sort()
    .flatMap((id) => {
      const wasSaved = before.has(id),
        locallySaved = device.has(id),
        accountSaved = server.has(id);
      const saved =
        locallySaved === accountSaved
          ? locallySaved
          : locallySaved === wasSaved
            ? accountSaved
            : locallySaved;
      if (!saved) return [];
      const original = before.get(id),
        a = device.get(id),
        b = server.get(id);
      if (!a || !b) return [(a ?? b)!];
      if (original && equal(a, original)) return [b];
      if (original && equal(b, original)) return [a];
      return [stableMetadata(a, b)];
    });
}

function mergeSelections(
  base: Pick<AccountSnapshot, 'shopping'>,
  local: Pick<AccountSnapshot, 'shopping'>,
  account: Pick<AccountSnapshot, 'shopping'>,
  plan: AccountPlanOccurrence[],
  remapped: ReadonlyMap<string, string>,
) {
  const mapId = (id: string): string => remapped.get(id) ?? id;
  const before = new Set(base.shopping.selectedOccurrenceIds.map(mapId));
  const device = new Set(local.shopping.selectedOccurrenceIds.map(mapId));
  const server = new Set(account.shopping.selectedOccurrenceIds.map(mapId));
  return plan
    .filter((item) => {
      const id = item.occurrenceId,
        b = before.has(id),
        l = device.has(id),
        a = server.has(id);
      return l === a ? l : l === b ? a : l;
    })
    .map((item) => item.occurrenceId);
}

/** Three-way comparison against the last server-acknowledged base. No revision or time is a conflict clock. */
export function mergeAccountSnapshots(input: AccountMergeInput): AccountMergeResult {
  const base = normalizeAccountSnapshot(input.base);
  const local = normalizeAccountSnapshot(input.local);
  const account = normalizeAccountSnapshot(input.account);
  if (
    (input.reviewPersonalRemovals !== undefined &&
      typeof input.reviewPersonalRemovals !== 'boolean') ||
    (input.reviewPersonalRemovals && !input.expandedScope)
  )
    throw new AccountSnapshotError('invalid_structure');
  if (!input.expandedScope && [base, local, account].some((value) => value.schemaVersion === 2))
    throw new AccountSnapshotError('scope_review_required');
  if (input.expandedScope && typeof input.expandedScope.historyIncluded !== 'boolean')
    throw new AccountSnapshotError('invalid_structure');
  if (
    !catalogueMatches(base.catalogue, local.catalogue) ||
    !catalogueMatches(base.catalogue, account.catalogue)
  )
    return { status: 'incompatible_catalogue' };
  const merger = createMerger(input);
  const notices: AccountMergeNotice[] = [];
  const expanded = input.expandedScope
    ? mergeExpandedData(
        base,
        local,
        account,
        input.expandedScope.historyIncluded,
        merger,
        input.reviewPersonalRemovals,
      )
    : null;
  const core = mergeCoreData(base, local, account, merger, notices);
  merger.finish();
  if (core === null) return { status: 'needs_review', conflicts: merger.conflicts, notices };
  const snapshot: AccountSnapshot = expanded
    ? { ...core, schemaVersion: 2, ...expanded }
    : { ...core, schemaVersion: 1 };
  return { status: 'merged', snapshot: normalizeAccountSnapshot(snapshot), notices };
}

export type CoreMergeSnapshot<T extends AccountPlanOccurrence> = Omit<
  AccountSnapshotV1,
  'schemaVersion' | 'plan'
> & { plan: T[] };

/** Shared core policy; callers retain their validated plan row extensions through review. */
export function mergeCoreData<T extends AccountPlanOccurrence>(
  base: CoreMergeSnapshot<T>,
  local: CoreMergeSnapshot<T>,
  account: CoreMergeSnapshot<T>,
  merger: Merger,
  notices: AccountMergeNotice[],
  planPolicy: {
    equivalent: (left: T | null, right: T | null) => boolean;
    canDeduplicate: (items: T[]) => boolean;
  } = {
    equivalent: occurrenceEqual,
    canDeduplicate: (items) => items.every((item) => item.recipeId === items[0]!.recipeId),
  },
) {
  const planRows = mergeRows(
    base.plan,
    local.plan,
    account.plan,
    (item) => item.occurrenceId,
    'occurrence_edit',
    'plan',
    merger,
    planPolicy.equivalent,
  );
  const preferenceRows = mergeRows(
    base.preferences,
    local.preferences,
    account.preferences,
    (item) => item.preferenceId,
    'preference_edit',
    'preferences',
    merger,
  );
  const setting = <T extends string | null>(path: string, b: T, l: T, a: T): T =>
    equal(l, a) ? l : equal(l, b) ? a : equal(a, b) ? l : merger.choose('setting', path, b, l, a);
  const purchaseMarks = mergeRows(
    base.shopping.purchaseMarks,
    local.shopping.purchaseMarks,
    account.shopping.purchaseMarks,
    (item) => item.groupKey,
    'purchase_state',
    'shopping/purchaseMarks',
    merger,
  );
  const appPreferences = {
    theme: setting(
      'appPreferences/theme',
      base.appPreferences.theme,
      local.appPreferences.theme,
      account.appPreferences.theme,
    ),
    motion: setting(
      'appPreferences/motion',
      base.appPreferences.motion,
      local.appPreferences.motion,
      account.appPreferences.motion,
    ),
    locale: setting(
      'appPreferences/locale',
      base.appPreferences.locale,
      local.appPreferences.locale,
      account.appPreferences.locale,
    ),
  };
  const profile = {
    displayName: setting(
      'profile/displayName',
      base.profile.displayName,
      local.profile.displayName,
      account.profile.displayName,
    ),
  };
  // Resolve each identity before inspecting relationships. Provisional base rows
  // can occupy slots/values that neither chosen branch will retain; presenting
  // those as collisions would manufacture conflicts and invalidate real decisions.
  if (merger.conflicts.length > 0) {
    return null;
  }
  const plan = repairCollisions(
    planRows,
    {
      base: base.plan,
      local: local.plan,
      account: account.plan,
      id: (item) => item.occurrenceId,
      group: slot,
      canDeduplicate: planPolicy.canDeduplicate,
      kind: 'slot_collision',
      notice: 'deduplicated_occurrence',
      path: 'plan/slots',
    },
    merger,
    notices,
  );
  const preferences = repairCollisions(
    preferenceRows,
    {
      base: base.preferences,
      local: local.preferences,
      account: account.preferences,
      id: (item) => item.preferenceId,
      group: preferenceValue,
      canDeduplicate: () => true,
      kind: 'preference_collision',
      notice: 'deduplicated_preference',
      path: 'preferences/values',
    },
    merger,
    notices,
  );
  if (merger.conflicts.length > 0) return null;
  const core = {
    format: base.format,
    catalogue: base.catalogue,
    favourites: mergeFavourites(base, local, account),
    plan: plan.items,
    preferences: preferences.items,
    shopping: {
      selectedOccurrenceIds: mergeSelections(base, local, account, plan.items, plan.remapped),
      purchaseMarks,
    },
    appPreferences,
    profile,
  };
  for (const mark of purchaseMarks)
    if (mark.purchased)
      notices.push({
        kind: 'purchase_requires_reprojection',
        fromId: mark.groupKey,
        toId: mark.groupKey,
      });
  // Applying this candidate must reproject shopping and compare each exact demand fingerprint.
  // This pure merge cannot establish actual ingredients from a catalogue identity alone.
  return core;
}
