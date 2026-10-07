import type { Immutable, ManualShoppingItem, ShoppingGroup } from '@cookmate/domain';

export type ShoppingFilter = 'to_buy' | 'purchased' | 'all';
export type ChecklistRow =
  | { kind: 'recipe'; key: string; group: Immutable<ShoppingGroup> }
  | { kind: 'manual'; key: string; item: Immutable<ManualShoppingItem> };

const searchable = (value: string) => value.normalize('NFKC').toLocaleLowerCase();

/** Display filtering never substitutes a label or row index for a stored purchase target. */
export function shoppingChecklist(
  groups: readonly Immutable<ShoppingGroup>[],
  manual: readonly Immutable<ManualShoppingItem>[],
  filter: ShoppingFilter,
  search: string,
  retainedKeys?: ReadonlySet<string>,
): ChecklistRow[] {
  const terms = searchable(search).trim().split(/\s+/).filter(Boolean);
  const matches = (key: string, purchased: boolean, text: string) =>
    (filter === 'all' || purchased === (filter === 'purchased') || retainedKeys?.has(key)) &&
    terms.every((term) => searchable(text).includes(term));
  return [
    ...groups
      .filter((group) =>
        matches(
          `recipe:${group.groupKey}`,
          group.purchased,
          [group.displayName, ...group.contributions.map((part) => part.rawName)].join(' '),
        ),
      )
      .map((group): ChecklistRow => ({ kind: 'recipe', key: `recipe:${group.groupKey}`, group })),
    ...manual
      .filter(
        (item) =>
          !item.deleted &&
          matches(`manual:${item.itemId}`, item.purchased, item.name ?? 'Unavailable item'),
      )
      .map((item): ChecklistRow => ({ kind: 'manual', key: `manual:${item.itemId}`, item })),
  ];
}
