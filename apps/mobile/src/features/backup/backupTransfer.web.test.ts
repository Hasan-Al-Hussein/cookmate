/** @jest-environment jsdom */
import { PORTABLE_BACKUP_MAX_BYTES } from '@cookmate/domain';
import { createBackupTransfer } from './backupTransfer.web';
import type { BackupTransfer } from './backupTransferTypes';

const createUrl = jest.fn(() => 'blob:synthetic-backup');
const revokeUrl = jest.fn();
const originalTextEncoder = Object.getOwnPropertyDescriptor(globalThis, 'TextEncoder');
let originalCreateUrl: PropertyDescriptor | undefined;
let originalRevokeUrl: PropertyDescriptor | undefined;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
let transfer: BackupTransfer;

beforeAll(() => {
  // Expo's preset installs a lazy native URL polyfill; jsdom omits its standard encoder.
  // Initialize the genuine encoder before accessing URL, leaving URL behavior unmocked.
  if (typeof globalThis.TextEncoder === 'undefined')
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      writable: true,
      value: require('node:util').TextEncoder,
    });
  originalCreateUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  originalRevokeUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
});
beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '';
  createUrl.mockClear();
  revokeUrl.mockClear();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
  transfer = createBackupTransfer();
});
afterEach(() => {
  transfer.dispose();
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});
afterAll(() => {
  if (originalCreateUrl) Object.defineProperty(URL, 'createObjectURL', originalCreateUrl);
  else delete (URL as unknown as Record<string, unknown>).createObjectURL;
  if (originalRevokeUrl) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeUrl);
  else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  if (originalTextEncoder) Object.defineProperty(globalThis, 'TextEncoder', originalTextEncoder);
  else delete (globalThis as { TextEncoder?: unknown }).TextEncoder;
});

function input() {
  return document.querySelector('input')!;
}
function selectedFile(serialized: string, size?: number) {
  const file = new File([serialized], 'synthetic-backup.json', { type: 'application/json' });
  const text = jest.fn(async () => serialized);
  Object.defineProperty(file, 'text', { value: text });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return { file, text };
}
function choose(files: File[]) {
  Object.defineProperty(input(), 'files', { configurable: true, value: files });
  input().dispatchEvent(new Event('change'));
}

test('a deliberate download uses a safe filename and revokes its URL after handoff', async () => {
  expect(createUrl).not.toHaveBeenCalled();
  let filename = '';
  jest.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filename = this.download;
    expect(this.href).toBe('blob:synthetic-backup');
  });
  expect(await transfer.exportFile('{"synthetic":true}')).toBe('download_requested');
  expect(filename).toMatch(/^CookMate-backup-\d{8}T\d{9}Z\.json$/);
  expect(createUrl.mock.calls).toHaveLength(1);
  expect(document.querySelector('a')).toBeNull();
  expect(revokeUrl).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1000);
  expect(revokeUrl).toHaveBeenCalledWith('blob:synthetic-backup');
});

test('disposing a download releases its pending URL without waiting for the timer', async () => {
  await transfer.exportFile('{}');
  transfer.dispose();
  expect(revokeUrl).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1000);
  expect(revokeUrl).toHaveBeenCalledTimes(1);
});

test('conversation export uses a readable text filename and MIME type, never a backup label', async () => {
  transfer = createBackupTransfer('conversation');
  let filename = '';
  jest.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    filename = this.download;
  });
  await transfer.exportFile('CookMate conversation transcript\nSynthetic message');
  expect(filename).toMatch(/^CookMate-conversation-\d{8}T\d{9}Z\.txt$/);
  expect((createUrl.mock.calls[0] as unknown as [Blob])[0].type).toBe('text/plain;charset=utf-8');
});

test('a cancelled chooser removes its element and focus listener', async () => {
  const removeListener = jest.spyOn(window, 'removeEventListener');
  const chosen = transfer.pickFile();
  expect(input().multiple).toBe(false);
  input().dispatchEvent(new Event('cancel'));
  expect(await chosen).toEqual({ kind: 'cancelled' });
  expect(document.querySelector('input')).toBeNull();
  expect(removeListener).toHaveBeenCalledWith('focus', expect.any(Function));
});

test('files over 8 MiB and multiple files are rejected before reading contents', async () => {
  const oversized = selectedFile('{}', PORTABLE_BACKUP_MAX_BYTES + 1);
  const first = transfer.pickFile();
  choose([oversized.file]);
  await expect(first).rejects.toMatchObject({ reason: 'too_large' });
  expect(oversized.text).not.toHaveBeenCalled();
  const a = selectedFile('{}');
  const b = selectedFile('{}');
  const second = transfer.pickFile();
  choose([a.file, b.file]);
  await expect(second).rejects.toMatchObject({ reason: 'read_failed' });
  expect(a.text).not.toHaveBeenCalled();
  expect(document.querySelector('input')).toBeNull();
});

test('the actual UTF-8 byte count is bounded even when file metadata underreports it', async () => {
  const fixture = selectedFile('é'.repeat(PORTABLE_BACKUP_MAX_BYTES / 2 + 1), 1);
  const chosen = transfer.pickFile();
  choose([fixture.file]);
  await expect(chosen).rejects.toMatchObject({ reason: 'too_large' });
  expect(document.querySelector('input')).toBeNull();
});

test('selection reads one file and releases chooser resources', async () => {
  const fixture = selectedFile('{"synthetic":true}');
  const chosen = transfer.pickFile();
  choose([fixture.file]);
  expect(await chosen).toEqual({ kind: 'selected', serialized: '{"synthetic":true}' });
  expect(fixture.text).toHaveBeenCalledTimes(1);
  expect(document.querySelector('input')).toBeNull();
});

test('disposing an in-flight read cancels it and ignores late private contents', async () => {
  const file = new File(['{}'], 'synthetic-backup.json');
  let finish!: (value: string) => void;
  Object.defineProperty(file, 'text', {
    value: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  const chosen = transfer.pickFile();
  choose([file]);
  transfer.dispose();
  expect(await chosen).toEqual({ kind: 'cancelled' });
  finish('synthetic private contents');
  await Promise.resolve();
  expect(document.querySelector('input')).toBeNull();
});

test('clipboard fallback writes exact JSON only on an explicit invocation and waits for confirmation', async () => {
  let finish!: () => void;
  const writeText = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  expect(writeText).not.toHaveBeenCalled();
  let finished = false;
  const copying = transfer.copyText!('{"exact":"العربية"}').then(() => {
    finished = true;
  });
  expect(writeText).toHaveBeenCalledWith('{"exact":"العربية"}');
  expect(finished).toBe(false);
  finish();
  await copying;
  expect(finished).toBe(true);
  expect(createUrl).not.toHaveBeenCalled();
});

test('clipboard denial and unsupported access never resolve as successful copies', async () => {
  const denied = new Error('Synthetic permission denial');
  const writeText = jest.fn().mockRejectedValue(denied);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await expect(transfer.copyText!('{}')).rejects.toBe(denied);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  await expect(transfer.copyText!('{}')).rejects.toMatchObject({ reason: 'unavailable' });
});

test('oversized or disposed clipboard attempts are rejected before changing the clipboard', async () => {
  const writeText = jest.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await expect(
    transfer.copyText!('é'.repeat(PORTABLE_BACKUP_MAX_BYTES / 2 + 1)),
  ).rejects.toMatchObject({ reason: 'too_large' });
  transfer.dispose();
  await expect(transfer.copyText!('{}')).rejects.toMatchObject({ reason: 'unavailable' });
  expect(writeText).not.toHaveBeenCalled();
});
