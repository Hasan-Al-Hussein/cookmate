import { Share } from 'react-native';
import {
  assertShoppingShareSize,
  ShoppingShareError,
  type ShoppingShareTransfer,
} from './shoppingShareText';

export function createShoppingShareTransfer(): ShoppingShareTransfer {
  let disposed = false;
  return {
    async share(text) {
      assertShoppingShareSize(text);
      if (disposed) throw new ShoppingShareError('unavailable');
      try {
        const result = await Share.share(
          { title: 'CookMate shopping list', message: text },
          { dialogTitle: 'Share your shopping list' },
        );
        return result.action === Share.dismissedAction ? 'cancelled' : 'sheet_closed';
      } catch {
        throw new ShoppingShareError('share_failed');
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
