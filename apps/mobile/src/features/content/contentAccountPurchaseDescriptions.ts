import type { AccountPurchaseMark } from '@cookmate/account-sync';
import { catalogueMatches } from '@cookmate/contracts';
import {
  canonicalContentJson,
  validateRecipeContentRef,
  type ReadingLookup,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import type {
  AccountContentConflictValue,
  AccountContentMergeResult,
} from '../../../../../packages/account-sync/src/contentMerge';
import type { AccountContentSnapshot } from '../../../../../packages/account-sync/src/contentSnapshot';
import type { createAdoptedContentReader } from '../../data/adoptedContentReader';
import { freezeResult } from '../../data/query';
import {
  buildRevisionShoppingProjection,
  REVISION_SHOPPING_LIMITS,
  type PinnedShoppingOccurrence,
  type RevisionShoppingGroup,
} from '../../data/revisionShoppingProjection';
import type {
  AccountPurchaseDescription,
  AccountPurchaseDescriptions,
} from '../account/accountPurchaseDescriptions';

export interface ContentAccountPurchaseReview {
  readonly comparison: Immutable<{
    local: AccountContentSnapshot;
    account: AccountContentSnapshot | null;
  }>;
  readonly merge: Immutable<AccountContentMergeResult>;
}
export interface ContentAccountPurchaseDescriptionOptions {
  readExact: ReturnType<typeof createAdoptedContentReader>['readExact'];
  sha256(text: string): Promise<string>;
}
type ExactResult = Awaited<ReturnType<ContentAccountPurchaseDescriptionOptions['readExact']>>;
type Selected = {
  catalogue: AccountContentSnapshot['catalogue'];
  items: PinnedShoppingOccurrence[];
};

function purchase(value: Immutable<AccountContentConflictValue>): AccountPurchaseMark | null {
  return value && typeof value === 'object' && !Array.isArray(value) && 'groupKey' in value
    ? { ...value }
    : null;
}
/** Own only projection inputs; personal notes and unrelated recipe bodies are never copied. */
function selected(snapshot: Immutable<AccountContentSnapshot> | null): Selected | null {
  if (
    !snapshot ||
    snapshot.shopping.selectedOccurrenceIds.length > REVISION_SHOPPING_LIMITS.occurrences
  )
    return null;
  const ids = new Set(snapshot.shopping.selectedOccurrenceIds);
  if (ids.size !== snapshot.shopping.selectedOccurrenceIds.length) return null;
  const plan = snapshot.plan.filter((item) => ids.has(item.occurrenceId));
  const references = snapshot.planReferences.filter((item) => ids.has(item.occurrenceId));
  const pins = new Map(references.map((item) => [item.occurrenceId, item.contentRef]));
  if (
    plan.length !== ids.size ||
    new Set(plan.map((item) => item.occurrenceId)).size !== ids.size ||
    references.length !== ids.size ||
    pins.size !== ids.size
  )
    return null;
  const items: PinnedShoppingOccurrence[] = [];
  for (const item of plan) {
    const ref = pins.get(item.occurrenceId);
    if (!ref || !validateRecipeContentRef(ref) || ref.recipeId !== item.recipeId) return null;
    items.push({
      occurrence: { ...item, placement: { ...item.placement }, revision: 0 },
      contentRef: { ...ref },
    });
  }
  return freezeResult({ catalogue: { ...snapshot.catalogue }, items });
}
function describe(
  mark: AccountPurchaseMark | null,
  groups: ReadonlyMap<string, Immutable<RevisionShoppingGroup>>,
): AccountPurchaseDescription | undefined {
  if (!mark) return undefined;
  const group = groups.get(mark.groupKey);
  if (
    !group ||
    group.groupingVersion !== mark.groupingVersion ||
    group.demandFingerprint !== mark.demandFingerprint
  )
    return undefined;
  return { name: group.displayName, quantity: group.quantityLabel };
}

/** Display only. Caller must discard results after review, owner or workspace/adoption changes. */
export async function buildContentAccountPurchaseDescriptions(
  review: ContentAccountPurchaseReview,
  options: ContentAccountPurchaseDescriptionOptions,
): Promise<AccountPurchaseDescriptions> {
  if (review.merge.status !== 'needs_review') return {};
  const conflicts = review.merge.conflicts
    .filter(
      (item) =>
        item.kind === 'purchase_state' ||
        (item.kind === 'delete_edit' && item.path.startsWith('shopping/purchaseMarks/')),
    )
    .map((item) => ({ id: item.id, local: purchase(item.local), account: purchase(item.account) }));
  if (!conflicts.length) return {};
  // All reviewed-side identities are captured before the first reader/hash await.
  const local = selected(review.comparison.local),
    account = selected(review.comparison.account);
  const refs = new Map(
    [...(local?.items ?? []), ...(account?.items ?? [])].map((item) => [
      canonicalContentJson(item.contentRef),
      item.contentRef,
    ]),
  );
  const resolved = new Map<string, ExactResult>();
  let workspace: string | undefined;
  for (const [key, ref] of refs) {
    let result: ExactResult;
    try {
      result = await options.readExact(ref);
    } catch {
      continue;
    }
    const current = canonicalContentJson({
      installationId: result.installationId,
      ownerId: result.ownerId,
      head: result.head,
      adoptionRevision: result.adoptionRevision,
      identity: result.identity,
    });
    // Independently successful reads must still belong to the same owner/adoption snapshot.
    if (workspace !== undefined && workspace !== current) return {};
    workspace = current;
    resolved.set(key, result);
  }
  async function project(value: Selected | null) {
    if (!value) return new Map<string, Immutable<RevisionShoppingGroup>>();
    try {
      const projected = await buildRevisionShoppingProjection(value.items, {
        lookupExact(ref): ReadingLookup {
          const result = resolved.get(canonicalContentJson(ref));
          return result && catalogueMatches(result.identity, value.catalogue)
            ? result.value
            : { kind: 'missing' };
        },
        sha256: options.sha256,
      });
      return new Map(projected.groups.map((group) => [group.groupKey, group]));
    } catch {
      return new Map<string, Immutable<RevisionShoppingGroup>>();
    }
  }
  const [localGroups, accountGroups] = await Promise.all([project(local), project(account)]);
  return freezeResult(
    Object.fromEntries(
      conflicts.flatMap((conflict) => {
        const localDescription = describe(conflict.local, localGroups),
          accountDescription = describe(conflict.account, accountGroups);
        return localDescription || accountDescription
          ? [
              [
                conflict.id,
                {
                  ...(localDescription ? { local: localDescription } : {}),
                  ...(accountDescription ? { account: accountDescription } : {}),
                },
              ],
            ]
          : [];
      }),
    ),
  );
}
