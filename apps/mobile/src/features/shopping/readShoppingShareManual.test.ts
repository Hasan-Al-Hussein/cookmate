import type {
  ManualShoppingItem,
  ManualShoppingPage,
  PersonalService,
  RepositoryResult,
} from '@cookmate/domain';
import { readShoppingShareManual } from './readShoppingShareManual';
import { formatShoppingShare } from './shoppingShareText';
import { shoppingShareFixture } from './shoppingShare.test-support';

export const shareManualItem = (id: string): ManualShoppingItem => ({
  kind: 'manual',
  itemId: id,
  name: 'Kitchen towels',
  amountText: null,
  unitText: null,
  category: 'other',
  purchased: false,
  deleted: false,
  revision: 1,
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
});
const page = (
  ids: string[],
  nextCursor: string | null,
  total: number,
  revision = 1,
): RepositoryResult<ManualShoppingPage> => ({
  kind: 'ready',
  revision,
  value: { epoch: 1, items: ids.map(shareManualItem), nextCursor, total },
});
function fixture() {
  return {
    readManualShopping: jest.fn<
      ReturnType<PersonalService['readManualShopping']>,
      Parameters<PersonalService['readManualShopping']>
    >(),
  };
}
test('share reads beyond the first page and retains order and source amounts', async () => {
  const service = fixture();
  service.readManualShopping
    .mockResolvedValueOnce(
      page(
        Array.from({ length: 50 }, (_, i) => String(i)),
        'next',
        51,
      ),
    )
    .mockResolvedValueOnce(page(['last'], null, 51));
  const items = await readShoppingShareManual(service);
  expect(items).toHaveLength(51);
  expect(items[50]!.itemId).toBe('last');
  const text = formatShoppingShare(shoppingShareFixture(), () => null, [
    items[0]!,
    { ...items[50]!, amountText: '2', unitText: 'packs', purchased: true },
  ]);
  expect(text).toContain('To buy 3 · Purchased 2');
  expect(text).toContain('[ ] Kitchen towels — Amount not specified');
  expect(text).toContain('[x] Kitchen towels — 2 packs');
  expect(text).toContain('[ ] Pasta — 475 g');
  expect(text).not.toContain('createdAt');
});
test.each(['changed', 'truncated', 'empty_cursor', 'duplicate', 'same_cursor'])(
  'incomplete %s pages never produce a shareable list',
  async (reason) => {
    const service = fixture();
    service.readManualShopping.mockResolvedValueOnce(page(['one'], 'next', 2));
    const second =
      reason === 'changed'
        ? page(['two'], null, 2, 2)
        : reason === 'truncated'
          ? page([], null, 2)
          : reason === 'empty_cursor'
            ? page([], 'new', 2)
            : reason === 'duplicate'
              ? page(['one'], null, 2)
              : page(['two'], 'next', 2);
    service.readManualShopping.mockResolvedValueOnce(second);
    await expect(readShoppingShareManual(service)).rejects.toThrow('incomplete_selection');
    expect(service.readManualShopping).toHaveBeenCalledTimes(2);
  },
);
test('manual output shares only visible item fields, never notes or identifiers', () => {
  const item = { ...shareManualItem('private-id'), privateNote: 'do not share me' };
  const text = formatShoppingShare(shoppingShareFixture(), () => null, [item]);
  expect(text).not.toContain('private-id');
  expect(text).not.toContain('do not share me');
  expect(() =>
    formatShoppingShare(shoppingShareFixture(), () => null, [{ ...item, deleted: true }]),
  ).toThrow('incomplete_selection');
});

test('owner guard stops pagination before any next-page payload is read', async () => {
  const service = fixture();
  let current = true;
  service.readManualShopping.mockImplementationOnce(async () => {
    current = false;
    return page(['one'], 'next', 2);
  });
  await expect(
    readShoppingShareManual(service, () => {
      if (!current) throw new Error('retired');
    }),
  ).rejects.toThrow('retired');
  expect(service.readManualShopping).toHaveBeenCalledTimes(1);
});
