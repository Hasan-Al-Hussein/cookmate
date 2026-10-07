import type {
  AccountConflictValue,
  AccountPurchaseMark,
  AccountSnapshot,
  AccountSyncState,
} from '@cookmate/account-sync';
import {
  buildShoppingProjection,
  type ShoppingProjectionOptions,
  type ProjectedShoppingGroup,
} from '@cookmate/domain';
// Structural presentation contract kept in this pure module for Node-only consumers.
export interface AccountPurchaseDescription {
  name: string;
  quantity: string;
}
export type AccountPurchaseDescriptions = Readonly<
  Record<string, { local?: AccountPurchaseDescription; account?: AccountPurchaseDescription }>
>;

function purchase(value: AccountConflictValue): AccountPurchaseMark | null {
  return value && typeof value === 'object' && !Array.isArray(value) && 'groupKey' in value
    ? { ...value }
    : null;
}

async function project(snapshot: AccountSnapshot | null, options: ShoppingProjectionOptions) {
  try {
    if (!snapshot) return new Map<string, ProjectedShoppingGroup>();
    const selected = new Set(snapshot.shopping.selectedOccurrenceIds);
    const occurrences = snapshot.plan
      .filter((item) => selected.has(item.occurrenceId))
      .map((item) => ({
        ...item,
        placement: { ...item.placement },
        // Display-only adaptation: account snapshots have no local command revision.
        revision: 0,
      }));
    if (
      selected.size !== snapshot.shopping.selectedOccurrenceIds.length ||
      occurrences.length !== selected.size
    )
      return new Map<string, ProjectedShoppingGroup>();
    const groups = await buildShoppingProjection(occurrences, options);
    return new Map(groups.map((group) => [group.groupKey, group]));
  } catch {
    // Missing recipes or unverified projection inputs cannot identify a purchase for approval.
    return new Map<string, ProjectedShoppingGroup>();
  }
}

function describe(
  mark: AccountPurchaseMark | null,
  groups: ReadonlyMap<string, ProjectedShoppingGroup>,
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

/** The caller must discard results when its active review changes while projection is pending. */
export async function buildAccountPurchaseDescriptions(
  review: Extract<AccountSyncState, { kind: 'review' }>,
  options: ShoppingProjectionOptions,
): Promise<AccountPurchaseDescriptions> {
  // Capture comparison IDs and marks before hashing yields, keeping results bound to this review.
  const conflicts = review.conflicts
    .filter(
      (item) =>
        item.kind === 'purchase_state' ||
        (item.kind === 'delete_edit' && item.path.startsWith('shopping/purchaseMarks/')),
    )
    .map((item) => ({ id: item.id, local: purchase(item.local), account: purchase(item.account) }));
  if (!conflicts.length) return {};
  const [local, account] = await Promise.all([
    project(review.local, options),
    project(review.account, options),
  ]);
  return Object.fromEntries(
    conflicts.flatMap((conflict) => {
      const deviceDescription = describe(conflict.local, local);
      const accountDescription = describe(conflict.account, account);
      return deviceDescription || accountDescription
        ? [
            [
              conflict.id,
              {
                ...(deviceDescription ? { local: deviceDescription } : {}),
                ...(accountDescription ? { account: accountDescription } : {}),
              },
            ],
          ]
        : [];
    }),
  );
}
