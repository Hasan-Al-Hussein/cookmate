import { Share } from 'react-native';
import { createShoppingShareTransfer } from './shoppingShareTransfer';
import { SHOPPING_SHARE_MAX_BYTES } from './shoppingShareText';

afterEach(() => jest.restoreAllMocks());

test('native sharing offers exactly the reviewed text and distinguishes an explicit dismissal', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction });
  const transfer = createShoppingShareTransfer();
  expect(share).not.toHaveBeenCalled();
  expect(await transfer.share('CookMate shopping list\n[ ] Pasta — 475 g')).toBe('cancelled');
  expect(share).toHaveBeenCalledWith(
    { title: 'CookMate shopping list', message: 'CookMate shopping list\n[ ] Pasta — 475 g' },
    { dialogTitle: 'Share your shopping list' },
  );
  share.mockResolvedValue({ action: Share.sharedAction });
  expect(await transfer.share('reviewed text')).toBe('sheet_closed');
});

test('oversized content and disposed adapters never open native sharing', async () => {
  const share = jest.spyOn(Share, 'share');
  const transfer = createShoppingShareTransfer();
  await expect(transfer.share('é'.repeat(SHOPPING_SHARE_MAX_BYTES))).rejects.toMatchObject({
    reason: 'too_large',
  });
  transfer.dispose();
  await expect(transfer.share('reviewed text')).rejects.toMatchObject({ reason: 'unavailable' });
  expect(share).not.toHaveBeenCalled();
});
