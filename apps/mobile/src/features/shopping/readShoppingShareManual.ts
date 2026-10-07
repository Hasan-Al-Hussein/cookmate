import {
  personalLimits,
  type PersonalService,
  type Immutable,
  type ManualShoppingItem,
  type ManualShoppingPage,
  type RepositoryResult,
} from '@cookmate/domain';
import { ShoppingShareError } from './shoppingShareText';

/** Sharing is complete or fails; a paginated prefix must never masquerade as the full list. */
export async function readShoppingShareManual(
  service: Pick<PersonalService, 'readManualShopping'>,
  assertCurrent?: () => void,
) {
  return (await readCompleteManualShopping(service, assertCurrent)).value.items;
}

/** A unified checklist needs the same complete, revision-consistent read as sharing. */
export async function readCompleteManualShopping(
  service: Pick<PersonalService, 'readManualShopping'>,
  assertCurrent: () => void = () => undefined,
): Promise<Extract<RepositoryResult<Immutable<ManualShoppingPage>>, { kind: 'ready' }>> {
  const read = service.readManualShopping.bind(service);
  assertCurrent();
  const items: Immutable<ManualShoppingItem>[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let epoch: number | undefined;
  let revision: number | undefined;
  let total: number | undefined;
  for (
    let page = 0;
    page < Math.ceil(personalLimits.manualItems / personalLimits.pageSize);
    page++
  ) {
    assertCurrent();
    const result = await read({
      limit: personalLimits.pageSize,
      ...(cursor ? { cursor } : {}),
    });
    assertCurrent();
    if (result.kind !== 'ready') throw new ShoppingShareError('incomplete_selection');
    const value = result.value;
    epoch ??= value.epoch;
    revision ??= result.revision;
    total ??= value.total;
    if (
      value.epoch !== epoch ||
      result.revision !== revision ||
      value.total !== total ||
      total > personalLimits.manualItems ||
      value.items.length > personalLimits.pageSize ||
      value.items.some((item) => seen.has(item.itemId) || item.deleted || item.name === null)
    )
      throw new ShoppingShareError('incomplete_selection');
    for (const item of value.items) {
      if (seen.has(item.itemId)) throw new ShoppingShareError('incomplete_selection');
      seen.add(item.itemId);
      items.push(item);
    }
    if (!value.nextCursor) {
      if (items.length !== total) throw new ShoppingShareError('incomplete_selection');
      return { ...result, value: { ...value, items, nextCursor: null } };
    }
    if (!value.items.length || cursors.has(value.nextCursor))
      throw new ShoppingShareError('incomplete_selection');
    cursors.add(value.nextCursor);
    cursor = value.nextCursor;
  }
  throw new ShoppingShareError('incomplete_selection');
}
