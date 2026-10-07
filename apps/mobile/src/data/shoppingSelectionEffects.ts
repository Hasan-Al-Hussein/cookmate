import type { PlanOccurrence } from '@cookmate/contracts';
import { buildShoppingProjection, reconcilePurchaseState } from '@cookmate/domain';
import type {
  DirectActionConsequences,
  Immutable,
  ShoppingProjectionOptions,
  ShoppingProjectionRecipe,
} from '@cookmate/domain';
import type { ShoppingLedger } from './shoppingRepository';

type ShoppingEffects = Extract<
  DirectActionConsequences,
  { kind: 'shopping_selection' }
>['shoppingEffects'];

/** Read-only consequences use the same demand and checkbox rules as the transactional rebuild. */
export async function shoppingSelectionEffects(
  before: ShoppingLedger,
  afterOccurrences: readonly Immutable<PlanOccurrence>[],
  options: ShoppingProjectionOptions<ShoppingProjectionRecipe>,
): Promise<ShoppingEffects> {
  const next = await buildShoppingProjection(afterOccurrences, options);
  const previous = new Map(before.groups.map((group) => [group.groupKey, group]));
  const active = new Map(before.snapshot.groups.map((group) => [group.groupKey, group]));
  const oldContributionIds = new Set(
    before.snapshot.groups.flatMap((group) =>
      group.contributions.map((item) => item.contributionId),
    ),
  );
  const newKeys = new Set(next.map((group) => group.groupKey));
  let checkedMarksRequiringReview = 0;
  let checkedMarksRemoved = 0;
  const added: ShoppingEffects['added'][number][] = [];
  const removed: ShoppingEffects['removed'][number][] = [];
  const demandChanged: ShoppingEffects['demandChanged'][number][] = [];
  const unchanged: ShoppingEffects['unchanged'][number][] = [];
  for (const group of next) {
    const old = previous.get(group.groupKey);
    const beforeGroup = active.get(group.groupKey);
    const state = reconcilePurchaseState(
      group,
      old
        ? {
            demandFingerprint: old.demandFingerprint,
            purchased: old.purchased === 1,
            changed: old.changed === 1,
            revision: old.revision!,
            active: old.projectionRevision === before.snapshot.projectionRevision,
          }
        : undefined,
      group.contributions.some((item) => oldContributionIds.has(item.contributionId)),
    );
    const effect = {
      groupKey: group.groupKey,
      displayName: group.displayName,
      before: beforeGroup
        ? {
            quantityLabel: beforeGroup.quantityLabel,
            purchased: beforeGroup.purchased,
            changed: beforeGroup.changed,
          }
        : null,
      after: {
        quantityLabel: group.quantityLabel,
        purchased: state.purchased,
        changed: state.changed,
      },
    };
    if (!beforeGroup) added.push(effect);
    else if (beforeGroup.demandFingerprint === group.demandFingerprint) unchanged.push(effect);
    else demandChanged.push(effect);
    if (beforeGroup?.purchased && !state.purchased && state.changed) checkedMarksRequiringReview++;
  }
  for (const group of before.snapshot.groups) {
    if (newKeys.has(group.groupKey)) continue;
    removed.push({
      groupKey: group.groupKey,
      displayName: group.displayName,
      before: {
        quantityLabel: group.quantityLabel,
        purchased: group.purchased,
        changed: group.changed,
      },
      after: null,
    });
    if (group.purchased) checkedMarksRemoved++;
  }
  return {
    added,
    removed,
    demandChanged,
    unchanged,
    checkedMarksRequiringReview,
    checkedMarksRemoved,
  };
}
