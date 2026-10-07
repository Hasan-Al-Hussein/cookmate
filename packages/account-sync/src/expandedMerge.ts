import type {
  AccountSnapshot,
  AccountPersonalData,
  AccountCollectionSubtree,
  AccountCookingHistory,
  AccountCookingHistoryEntry,
  AccountConflictKind,
} from './types';
import { AccountSnapshotError } from './types';
import { equal, mergeRows } from './mergeEngine';
import type { Merger } from './mergeEngine';

const emptyPersonal = (): AccountPersonalData => ({
  notes: [],
  collections: [],
  memberships: [],
  manualItems: [],
});
const personal = (snapshot: AccountSnapshot) =>
  snapshot.schemaVersion === 2 ? snapshot.personal : emptyPersonal();
const history = (snapshot: AccountSnapshot) =>
  snapshot.schemaVersion === 2 ? snapshot.cookingHistory : undefined;
type PersonalRow = AccountPersonalData[keyof AccountPersonalData][number];
function content(row: PersonalRow | null) {
  if (row === null) return null;
  const { updatedAt: _updatedAt, ...value } = row;
  if ('createdAt' in value) {
    const { createdAt: _createdAt, ...rest } = value;
    return rest;
  }
  return value;
}
const equivalent = (left: PersonalRow | null, right: PersonalRow | null) =>
  equal(content(left), content(right));

/** Absence is not a deletion in v2: only an explicit redacted tombstone removes a record. */
function withBase<T>(base: readonly T[], branch: readonly T[], key: (item: T) => string): T[] {
  const map = new Map(base.map((item) => [key(item), item]));
  for (const item of branch) map.set(key(item), item);
  return [...map.values()];
}
function rows<T extends PersonalRow>(
  base: readonly T[],
  local: readonly T[],
  account: readonly T[],
  key: (item: T) => string,
  kind: AccountConflictKind,
  path: string,
  merger: Merger,
  reviewRemovals: boolean,
) {
  return mergeRows(
    base,
    withBase(base, local, key),
    withBase(base, account, key),
    key,
    kind,
    path,
    merger,
    equivalent,
    (item) => ('deleted' in item ? item.deleted : !item.present),
    reviewRemovals,
  );
}

function mergeCollections(
  base: AccountPersonalData,
  local: AccountPersonalData,
  account: AccountPersonalData,
  merger: Merger,
  reviewRemovals: boolean,
) {
  const trees = (value: AccountPersonalData) => {
    const members = new Map<string, typeof value.memberships>();
    for (const item of value.memberships) {
      const list = members.get(item.collectionId) ?? [];
      list.push(item);
      members.set(item.collectionId, list);
    }
    return new Map(
      value.collections.map((collection) => [
        collection.collectionId,
        { collection, memberships: members.get(collection.collectionId) ?? [] },
      ]),
    );
  };
  const [before, device, server] = [trees(base), trees(local), trees(account)] as const;
  const result: Pick<AccountPersonalData, 'collections' | 'memberships'> = {
    collections: [],
    memberships: [],
  };
  const subtreeContent = (tree: AccountCollectionSubtree | null) =>
    tree === null
      ? null
      : { collection: content(tree.collection), memberships: tree.memberships.map(content) };
  const complete = (
    base: AccountCollectionSubtree | null,
    branch: AccountCollectionSubtree | undefined,
  ): AccountCollectionSubtree | null => {
    if (!branch) return base;
    const memberships = withBase(
      base?.memberships ?? [],
      branch.memberships,
      (item) => item.recipeId,
    )
      .map((item) =>
        branch.collection.deleted && item.present
          ? { ...item, present: false, updatedAt: branch.collection.updatedAt }
          : item,
      )
      .sort((a, b) => (a.recipeId < b.recipeId ? -1 : a.recipeId > b.recipeId ? 1 : 0));
    return { ...branch, memberships };
  };
  for (const id of [...new Set([...before.keys(), ...device.keys(), ...server.keys()])].sort()) {
    const b = before.get(id) ?? null,
      l = complete(b, device.get(id)),
      a = complete(b, server.get(id));
    const deletedAgainstEdit =
      (reviewRemovals &&
        l !== null &&
        a !== null &&
        l.collection.deleted !== a.collection.deleted) ||
      (l?.collection.deleted &&
        !a?.collection.deleted &&
        !equal(subtreeContent(a), subtreeContent(b))) ||
      (a?.collection.deleted &&
        !l?.collection.deleted &&
        !equal(subtreeContent(l), subtreeContent(b)));
    if (deletedAgainstEdit) {
      const chosen = merger.choose(
        'collection_subtree',
        `personal/collections/${id}/subtree`,
        b,
        l,
        a,
      );
      if (chosen) {
        result.collections.push(chosen.collection);
        result.memberships.push(...chosen.memberships);
      }
      continue;
    }
    const collections = rows(
      b ? [b.collection] : [],
      l ? [l.collection] : [],
      a ? [a.collection] : [],
      (item) => item.collectionId,
      'collection_edit',
      'personal/collections',
      merger,
      reviewRemovals,
    );
    const memberships = rows(
      b?.memberships ?? [],
      l?.memberships ?? [],
      a?.memberships ?? [],
      (item) => `${item.collectionId}/${item.recipeId}`,
      'membership_edit',
      'personal/memberships',
      merger,
      reviewRemovals,
    );
    result.collections.push(...collections);
    result.memberships.push(...memberships);
  }
  return result;
}

function mergeHistory(
  base: AccountCookingHistory | undefined,
  local: AccountCookingHistory,
  account: AccountCookingHistory | undefined,
): AccountCookingHistory {
  const removedEventIds = [
    ...new Set([
      ...(base?.removedEventIds ?? []),
      ...local.removedEventIds,
      ...(account?.removedEventIds ?? []),
    ]),
  ];
  const removed = new Set(removedEventIds);
  const entries = new Map<string, AccountCookingHistoryEntry>();
  for (const entry of [...(base?.entries ?? []), ...local.entries, ...(account?.entries ?? [])]) {
    const previous = entries.get(entry.eventId);
    if (previous && !equal(previous, entry))
      throw new AccountSnapshotError('history_identity_collision');
    entries.set(entry.eventId, entry);
  }
  return {
    entries: [...entries.values()].filter((entry) => !removed.has(entry.eventId)),
    removedEventIds,
  };
}

export function mergeExpandedData(
  baseSnapshot: AccountSnapshot,
  localSnapshot: AccountSnapshot,
  accountSnapshot: AccountSnapshot,
  historyIncluded: boolean,
  merger: Merger,
  reviewRemovals = false,
): { personal: AccountPersonalData; cookingHistory?: AccountCookingHistory } {
  if (localSnapshot.schemaVersion !== 2 || (historyIncluded && !localSnapshot.cookingHistory))
    throw new AccountSnapshotError('scope_review_required');
  const base = personal(baseSnapshot),
    local = personal(localSnapshot),
    account = personal(accountSnapshot);
  const collections = mergeCollections(base, local, account, merger, reviewRemovals);
  const cookingHistory = historyIncluded
    ? mergeHistory(history(baseSnapshot), localSnapshot.cookingHistory!, history(accountSnapshot))
    : history(accountSnapshot);
  return {
    personal: {
      notes: rows(
        base.notes,
        local.notes,
        account.notes,
        (item) => item.recipeId,
        'note_edit',
        'personal/notes',
        merger,
        reviewRemovals,
      ),
      ...collections,
      manualItems: rows(
        base.manualItems,
        local.manualItems,
        account.manualItems,
        (item) => item.itemId,
        'manual_item_edit',
        'personal/manualItems',
        merger,
        reviewRemovals,
      ),
    },
    ...(cookingHistory === undefined ? {} : { cookingHistory }),
  };
}
