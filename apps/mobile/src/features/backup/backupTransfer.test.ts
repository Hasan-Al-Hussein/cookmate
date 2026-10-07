import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { PORTABLE_BACKUP_MAX_BYTES } from '@cookmate/domain';
import { createBackupTransfer } from './backupTransfer';

interface MockFileData {
  exists: boolean;
  size: number;
  text: jest.Mock;
  deleted: boolean;
  written?: string;
}
const mockFiles = new Map<string, MockFileData>();
jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///cookmate-cache/' } },
  File: class {
    uri: string;
    constructor(base: string | { uri: string }, name?: string) {
      this.uri = `${typeof base === 'string' ? base : base.uri}${name ?? ''}`;
    }
    get exists() {
      return mockFiles.get(this.uri)?.exists ?? false;
    }
    get size() {
      return mockFiles.get(this.uri)?.size ?? 0;
    }
    create() {
      mockFiles.set(this.uri, { exists: true, size: 0, text: jest.fn(), deleted: false });
    }
    write(value: string) {
      mockFiles.get(this.uri)!.written = value;
    }
    text() {
      return mockFiles.get(this.uri)!.text();
    }
    delete() {
      const entry = mockFiles.get(this.uri)!;
      entry.deleted = true;
      entry.exists = false;
    }
  },
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
const pick = jest.mocked(DocumentPicker.getDocumentAsync);
const share = jest.mocked(Sharing.shareAsync);

function prepareFile(uri = 'file:///cookmate-cache/DocumentPicker/synthetic.json', size = 2) {
  const entry: MockFileData = {
    exists: true,
    size,
    text: jest.fn(async () => '{}'),
    deleted: false,
  };
  mockFiles.set(uri, entry);
  pick.mockResolvedValue({
    canceled: false,
    assets: [{ uri, name: 'synthetic.json', size, lastModified: 0 }],
  });
  return entry;
}
beforeEach(() => {
  mockFiles.clear();
  pick.mockReset();
  share.mockReset().mockResolvedValue(undefined);
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(true);
});

test('native export shares an app-owned cache copy and removes it when the sheet closes', async () => {
  const transfer = createBackupTransfer();
  expect(await transfer.exportFile('{}')).toBe('share_sheet_closed');
  expect(share).toHaveBeenCalledWith(
    expect.stringMatching(/^file:\/\/\/cookmate-cache\/CookMate-backup-/),
    expect.objectContaining({ mimeType: 'application/json', UTI: 'public.json' }),
  );
  const file = [...mockFiles.values()][0]!;
  expect(file.written).toBe('{}');
  expect(file.deleted).toBe(true);
});

test('unavailable sharing creates no temporary file and offers no success', async () => {
  jest.mocked(Sharing.isAvailableAsync).mockResolvedValue(false);
  await expect(createBackupTransfer().exportFile('{}')).rejects.toMatchObject({
    reason: 'unavailable',
  });
  expect(mockFiles.size).toBe(0);
  expect(share).not.toHaveBeenCalled();
});

test('native conversation transfer shares plain text and removes only its owned cache copy', async () => {
  await createBackupTransfer('conversation').exportFile('Synthetic readable transcript');
  expect(share).toHaveBeenCalledWith(
    expect.stringMatching(/CookMate-conversation-.*\.txt$/),
    expect.objectContaining({ mimeType: 'text/plain', UTI: 'public.utf8-plain-text' }),
  );
  const file = [...mockFiles.values()][0]!;
  expect(file.written).toBe('Synthetic readable transcript');
  expect(file.deleted).toBe(true);
});

test('native chooser cancellation creates no readable selection', async () => {
  pick.mockResolvedValue({ canceled: true, assets: null });
  expect(await createBackupTransfer().pickFile()).toEqual({ kind: 'cancelled' });
  expect(mockFiles.size).toBe(0);
});

test('an oversized picked copy is rejected before reading and is removed', async () => {
  const file = prepareFile(undefined, PORTABLE_BACKUP_MAX_BYTES + 1);
  await expect(createBackupTransfer().pickFile()).rejects.toMatchObject({ reason: 'too_large' });
  expect(file.text).not.toHaveBeenCalled();
  expect(file.deleted).toBe(true);
});

test('a cache copy is removed after reading but an original outside cache is never deleted', async () => {
  const copy = prepareFile();
  expect(await createBackupTransfer().pickFile()).toEqual({ kind: 'selected', serialized: '{}' });
  expect(copy.deleted).toBe(true);
  expect(pick).toHaveBeenCalledWith(
    expect.objectContaining({ copyToCacheDirectory: true, multiple: false }),
  );
  const original = prepareFile('file:///user-documents/synthetic.json');
  expect(await createBackupTransfer().pickFile()).toEqual({ kind: 'selected', serialized: '{}' });
  expect(original.deleted).toBe(false);
});

test('disposing while the native picker is open suppresses selection and cleans its returned cache copy', async () => {
  const copy = prepareFile();
  let finish!: (value: DocumentPicker.DocumentPickerResult) => void;
  pick.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const transfer = createBackupTransfer();
  const selecting = transfer.pickFile();
  transfer.dispose();
  finish({
    canceled: false,
    assets: [
      {
        uri: 'file:///cookmate-cache/DocumentPicker/synthetic.json',
        name: 'synthetic.json',
        size: 2,
        lastModified: 0,
      },
    ],
  });
  expect(await selecting).toEqual({ kind: 'cancelled' });
  expect(copy.text).not.toHaveBeenCalled();
  expect(copy.deleted).toBe(true);
});
