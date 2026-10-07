/** @jest-environment jsdom */
import { createShoppingShareTransfer } from './shoppingShareTransfer.web';
import { SHOPPING_SHARE_MAX_BYTES } from './shoppingShareText';

const originalTextEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
let originalCreate: PropertyDescriptor | undefined;
let originalRevoke: PropertyDescriptor | undefined;
const createUrl = jest.fn(() => 'blob:synthetic-shopping');
const revokeUrl = jest.fn();
beforeAll(() => {
  // Expo's preset replaces URL lazily; jsdom needs the standard encoder before first access.
  if (typeof globalThis.TextEncoder === 'undefined')
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      writable: true,
      value: require('node:util').TextEncoder,
    });
  originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
});
beforeEach(() => {
  jest.useFakeTimers();
  createUrl.mockClear();
  revokeUrl.mockClear();
});
afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
afterAll(() => {
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  if (originalTextEncoder) Object.defineProperty(globalThis, 'TextEncoder', originalTextEncoder);
  else delete (globalThis as { TextEncoder?: unknown }).TextEncoder;
});

test('browser export downloads text with a safe filename and releases its URL', async () => {
  let filename = '';
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filename = this.download;
  });
  const transfer = createShoppingShareTransfer();
  expect(createUrl).not.toHaveBeenCalled();
  expect(await transfer.share('reviewed shopping text')).toBe('download_requested');
  expect(filename).toMatch(/^CookMate-shopping-\d{8}T\d{9}Z\.txt$/);
  expect(document.querySelector('a')).toBeNull();
  transfer.dispose();
  expect(revokeUrl).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1000);
  expect(revokeUrl).toHaveBeenCalledTimes(1);
});

test('oversized text is rejected before any Blob URL or download action', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  await expect(
    createShoppingShareTransfer().share('x'.repeat(SHOPPING_SHARE_MAX_BYTES + 1)),
  ).rejects.toMatchObject({ reason: 'too_large' });
  expect(createUrl).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});
