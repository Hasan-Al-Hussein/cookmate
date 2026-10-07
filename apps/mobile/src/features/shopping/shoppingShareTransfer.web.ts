import {
  assertShoppingShareSize,
  shoppingShareFilename,
  ShoppingShareError,
  type ShoppingShareTransfer,
} from './shoppingShareText';

export function createShoppingShareTransfer(): ShoppingShareTransfer {
  let disposed = false;
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  const release = (url: string) => {
    clearTimeout(downloads.get(url));
    downloads.delete(url);
    URL.revokeObjectURL(url);
  };
  return {
    async share(text) {
      assertShoppingShareSize(text);
      if (disposed || typeof document === 'undefined') throw new ShoppingShareError('unavailable');
      let url: string | null = null;
      const anchor = document.createElement('a');
      try {
        url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        anchor.href = url;
        anchor.download = shoppingShareFilename();
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        const ownUrl = url;
        downloads.set(
          ownUrl,
          setTimeout(() => release(ownUrl), 1000),
        );
        return 'download_requested';
      } catch {
        if (url) release(url);
        throw new ShoppingShareError('share_failed');
      } finally {
        anchor.remove();
      }
    },
    dispose() {
      disposed = true;
      for (const url of downloads.keys()) release(url);
    },
  };
}
