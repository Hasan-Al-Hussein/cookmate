import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { catalogue, getRecipe } from '@cookmate/catalogue';
import { createPortableBackup } from '@cookmate/domain';
import type {
  Immutable,
  PortableBackupEnvelope,
  PortableBackupInput,
  RepositoryResult,
  CookMateQueries,
} from '@cookmate/domain';
import { BackupSettings } from './BackupSettings';
import type { BackupTransfer } from './backupTransferTypes';

const { createHash } = require('node:crypto') as {
  createHash(algorithm: 'sha256'): { update(text: string): { digest(encoding: 'hex'): string } };
};

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, text: string) =>
    require('node:crypto').createHash('sha256').update(text).digest('hex'),
}));
jest.mock('./backupTransfer', () => ({ createBackupTransfer: jest.fn() }));
jest.mock('./restoreReferenceStorage', () => ({
  restoreReferenceStore: { load: async () => [], remember: jest.fn(), forget: jest.fn() },
}));
const mockWorkspace = jest.fn();
jest.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => mockWorkspace() }));

const timestamp = '2026-09-30T08:00:00.000Z';
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const readBackup = jest.fn<
  ReturnType<CookMateQueries['readPortableBackup']>,
  Parameters<CookMateQueries['readPortableBackup']>
>();
let transfer: jest.Mocked<BackupTransfer>;

async function exampleBackup(otherCatalogue = false, expanded = false, includeHistory = false) {
  const occurrenceId = '93173aaf-e3a2-4080-b316-8c3fe33f43c9';
  const input: PortableBackupInput = {
    ...(expanded ? { schemaVersion: 2 as const, databaseSchemaVersion: 5 as const } : {}),
    createdAt: timestamp,
    catalogue: otherCatalogue
      ? { version: 'other-catalogue', fingerprint: 'e'.repeat(64) }
      : catalogue.identity,
    sourceRevision: 2,
    data: {
      ...(expanded
        ? {
            personal: {
              notes: [
                {
                  noteId: 'c0000000-0000-4000-8000-000000000001',
                  recipeId: '52835',
                  text: 'Private recipe note fixture',
                  deleted: false,
                  revision: 1,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ],
              collections: [
                {
                  collectionId: 'd0000000-0000-4000-8000-000000000001',
                  name: 'Private collection fixture',
                  deleted: false,
                  revision: 1,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ],
              memberships: [
                {
                  collectionId: 'd0000000-0000-4000-8000-000000000001',
                  recipeId: '52835',
                  present: true,
                  revision: 1,
                  updatedAt: timestamp,
                },
              ],
              manualItems: [
                {
                  kind: 'manual' as const,
                  itemId: 'e0000000-0000-4000-8000-000000000001',
                  name: 'Private shopping fixture',
                  amountText: 'two',
                  unitText: 'bags',
                  category: 'other' as const,
                  purchased: true,
                  deleted: false,
                  revision: 1,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ],
            },
          }
        : {}),
      ...(includeHistory
        ? {
            cookingHistory: {
              entries: [
                {
                  eventId: 'f0000000-0000-4000-8000-000000000001',
                  recipeId: '52835',
                  recipeTitle: getRecipe('52835')!.title,
                  photoKey: getRecipe('52835')!.photoKey,
                  catalogue: catalogue.identity,
                  contentFingerprint: 'a'.repeat(64),
                  readerVersion: 1 as const,
                  cookedOn: '2026-09-29',
                  timeZone: 'Asia/Dubai',
                  recordedAt: timestamp,
                  note: 'Private cooking note fixture',
                  historyEpoch: 0,
                  revision: 1,
                },
              ],
            },
          }
        : {}),
      favourites: [
        { recipeId: '52835', saved: true, revision: 1, savedAt: timestamp, updatedAt: timestamp },
      ],
      occurrences: [
        {
          occurrenceId,
          recipeId: otherCatalogue ? '999999' : '52835',
          placement: { actualDate: '2026-10-07', mealKey: 'dinner' },
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      shopping: {
        scope: {
          scopeId: 'b98a60ce-a30a-4d48-bcd0-fd6c5be2a9ed',
          revision: 1,
          occurrenceIds: [occurrenceId],
        },
        projectionRevision: 0,
        projectionStatus: 'pending',
        purchaseMarks: [],
      },
      preferences: {
        snapshot: {
          revision: 1,
          lastRemovalRevision: null,
          items: [
            {
              preferenceId: '4cc35ac2-b4b7-4f17-a114-0f839033da86',
              type: 'cuisine',
              value: 'Private synthetic preference',
              revision: 1,
            },
          ],
        },
        removals: [],
      },
    },
  };
  return createPortableBackup(input, sha256);
}
function enableExpanded() {
  const current = mockWorkspace();
  mockWorkspace.mockReturnValue({
    ...current,
    availability: {
      ...current.availability,
      services: { ...current.availability.services, personal: {} },
    },
  });
}

beforeEach(() => {
  readBackup.mockReset();
  mockWorkspace.mockReturnValue({
    availability: {
      kind: 'ready',
      services: { queries: { catalogue: catalogue.identity, readPortableBackup: readBackup } },
    },
  });
  transfer = {
    exportFile: jest
      .fn<ReturnType<BackupTransfer['exportFile']>, Parameters<BackupTransfer['exportFile']>>()
      .mockResolvedValue('download_requested'),
    pickFile: jest
      .fn<ReturnType<BackupTransfer['pickFile']>, []>()
      .mockResolvedValue({ kind: 'cancelled' }),
    dispose: jest.fn(),
  };
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('discloses plaintext scope without reading or offering a file before a deliberate tap', () => {
  const factory = jest.fn(() => transfer);
  render(<BackupSettings createTransfer={factory} />);
  expect(screen.getByText('This file is not encrypted')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'What is included?' }));
  expect(screen.getByText(/Chat history, unsent drafts, AI actions, credentials/)).toBeTruthy();
  expect(screen.getByText('Restoring is not available yet')).toBeTruthy();
  expect(readBackup).not.toHaveBeenCalled();
  expect(factory).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
});

test('an export read failure offers no file and reports the unchanged workspace', async () => {
  readBackup.mockResolvedValue({
    kind: 'failed',
    error: { code: 'storage_failure', messageKey: 'synthetic.read_failed', retry: 'never' },
  });
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Export plain-text backup' }));
  expect(await screen.findByText(/No backup file was offered/)).toBeTruthy();
  expect(transfer.exportFile).not.toHaveBeenCalled();
  expect(screen.queryByText('Contents offered for export')).toBeNull();
});

test('native share completion does not claim a saved file', async () => {
  const backup = await exampleBackup();
  readBackup.mockResolvedValue({ kind: 'ready', value: backup, revision: 2 });
  transfer.exportFile.mockResolvedValue('share_sheet_closed');
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Export plain-text backup' }));
  expect(
    await screen.findByText(/cannot tell whether you saved, shared or cancelled/),
  ).toBeTruthy();
  expect(transfer.exportFile).toHaveBeenCalledWith(JSON.stringify(backup));
  expect(screen.getByLabelText('Saved favourite recipes: 1')).toBeTruthy();
});

test('a cancelled chooser changes no data and leaves no inspection', async () => {
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('tab', { name: 'Inspect' }));
  fireEvent.press(screen.getByRole('button', { name: 'Inspect backup file' }));
  expect(await screen.findByText('No file selected. Your workspace is unchanged.')).toBeTruthy();
  expect(readBackup).not.toHaveBeenCalled();
  expect(screen.queryByText('Backup inspection')).toBeNull();
});

test('corrupt files produce no success counts or restore action', async () => {
  transfer.pickFile.mockResolvedValue({ kind: 'selected', serialized: '{bad JSON' });
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('tab', { name: 'Inspect' }));
  fireEvent.press(screen.getByRole('button', { name: 'Inspect backup file' }));
  expect(await screen.findByText(/This file is not readable JSON/)).toBeTruthy();
  expect(screen.queryByText('Backup inspection')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
});

test('valid inspection shows safe counts, dates and unresolved references without exposing preference values', async () => {
  transfer.pickFile.mockResolvedValue({
    kind: 'selected',
    serialized: JSON.stringify(await exampleBackup(true)),
  });
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('tab', { name: 'Inspect' }));
  fireEvent.press(screen.getByRole('button', { name: 'Inspect backup file' }));
  expect(await screen.findByText('Backup inspection')).toBeTruthy();
  expect(screen.getByLabelText('Planned meals: 1')).toBeTruthy();
  expect(screen.getByLabelText('Saved cooking preferences: 1')).toBeTruthy();
  expect(screen.getByText(/Selected shopping meals:.*Oct.*2026/)).toBeTruthy();
  expect(screen.getByText('Different recipe catalogue')).toBeTruthy();
  expect(screen.getByText('Recipe ID 999999')).toBeTruthy();
  expect(screen.getByText('Exact trusted archive references: unavailable')).toBeTruthy();
  expect(screen.getByText(/Reference inspection does not authorize restore/)).toBeTruthy();
  expect(screen.queryByText('Private synthetic preference')).toBeNull();
  expect(readBackup).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Close inspection' }));
  expect(screen.queryByText('Backup inspection')).toBeNull();
});

test('leaving while a snapshot is loading prevents a late file offer', async () => {
  const backup = await exampleBackup();
  let finish!: (result: RepositoryResult<Immutable<PortableBackupEnvelope>>) => void;
  readBackup.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const mounted = render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Export plain-text backup' }));
  await waitFor(() => expect(readBackup).toHaveBeenCalledTimes(1));
  mounted.unmount();
  await act(async () => {
    finish({ kind: 'ready', value: backup, revision: 2 });
  });
  expect(transfer.exportFile).not.toHaveBeenCalled();
});

test('leaving a pending file chooser disposes the adapter and ignores its late result', async () => {
  let finish!: (result: Awaited<ReturnType<BackupTransfer['pickFile']>>) => void;
  transfer.pickFile.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const mounted = render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('tab', { name: 'Inspect' }));
  fireEvent.press(screen.getByRole('button', { name: 'Inspect backup file' }));
  mounted.unmount();
  expect(transfer.dispose).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ kind: 'selected', serialized: '{bad JSON' });
  });
  expect(readBackup).not.toHaveBeenCalled();
});

test('browser fallback prepares exact JSON without automatically rendering, copying or downloading it', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const backup = await exampleBackup();
  readBackup.mockResolvedValue({ kind: 'ready', value: backup, revision: 2 });
  transfer.copyText = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
  render(<BackupSettings createTransfer={() => transfer} />);
  expect(readBackup).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Prepare backup text' }));
  expect(await screen.findByText('Prepared backup text')).toBeTruthy();
  expect(screen.queryByLabelText('Prepared backup JSON')).toBeNull();
  expect(transfer.exportFile).not.toHaveBeenCalled();
  expect(transfer.copyText).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Show backup JSON' }));
  const contents = screen.getByLabelText('Prepared backup JSON');
  expect(contents.props.value).toBe(JSON.stringify(backup));
  expect(contents.props.editable).toBe(false);
  expect(screen.getByText(/This is the complete unencrypted JSON/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Hide backup JSON' }));
  expect(screen.queryByLabelText('Prepared backup JSON')).toBeNull();
});

test('a failed browser download keeps the exact prepared snapshot available for explicit copy', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const backup = await exampleBackup();
  readBackup.mockResolvedValue({ kind: 'ready', value: backup, revision: 2 });
  transfer.exportFile.mockRejectedValue(new Error('Synthetic embedded browser failure'));
  let finish!: () => void;
  transfer.copyText = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Export plain-text backup' }));
  expect(await screen.findByText('Prepared backup text')).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy backup JSON' })).not.toBeDisabled(),
  );
  expect(transfer.copyText).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Copy backup JSON' }));
  expect(transfer.copyText).toHaveBeenCalledWith(JSON.stringify(backup));
  expect(transfer.exportFile).toHaveBeenCalledWith(JSON.stringify(backup));
  expect(readBackup).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Copied to the clipboard/)).toBeNull();
  await act(async () => finish());
  expect(screen.getByText(/Copying alone is not a saved backup/)).toBeTruthy();
});

test('clipboard rejection leaves manual read-only fallback available without claiming copy success', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const backup = await exampleBackup();
  readBackup.mockResolvedValue({ kind: 'ready', value: backup, revision: 2 });
  transfer.copyText = jest
    .fn<Promise<void>, [string]>()
    .mockRejectedValue(new Error('Synthetic clipboard denial'));
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Prepare backup text' }));
  await screen.findByText('Prepared backup text');
  fireEvent.press(screen.getByRole('button', { name: 'Copy backup JSON' }));
  expect(await screen.findByText(/Clipboard access could not be confirmed/)).toBeTruthy();
  expect(screen.queryByText(/Copied to the clipboard/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Show backup JSON' }));
  expect(screen.getByLabelText('Prepared backup JSON').props.value).toBe(JSON.stringify(backup));
});

test('discarding prepared text removes the exposed snapshot and a new visit starts empty', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  readBackup.mockResolvedValue({ kind: 'ready', value: await exampleBackup(), revision: 2 });
  const mounted = render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Prepare backup text' }));
  await screen.findByText('Prepared backup text');
  fireEvent.press(screen.getByRole('button', { name: 'Show backup JSON' }));
  fireEvent.press(screen.getByRole('button', { name: 'Discard prepared text' }));
  expect(screen.queryByLabelText('Prepared backup JSON')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy backup JSON' })).toBeNull();
  mounted.unmount();
  render(<BackupSettings createTransfer={() => transfer} />);
  expect(screen.queryByText('Prepared backup text')).toBeNull();
  expect(readBackup).toHaveBeenCalledTimes(1);
});

test('an available restore port adds a separate flow while ordinary inspection stays read-only', async () => {
  const restore = {
    review: jest.fn(),
    prepare: jest.fn(),
    execute: jest.fn(),
    readReceipt: jest.fn(),
    readArchive: jest.fn(),
  };
  mockWorkspace.mockReturnValue({
    availability: {
      kind: 'ready',
      services: {
        queries: {
          catalogue: catalogue.identity,
          readPortableBackup: readBackup,
          readInstallationId: async () => ({
            kind: 'ready',
            value: 'a0000000-0000-4000-8000-000000000001',
            revision: 1,
          }),
        },
        portableRestore: restore,
      },
    },
  });
  transfer.pickFile.mockResolvedValue({
    kind: 'selected',
    serialized: JSON.stringify(await exampleBackup()),
  });
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('tab', { name: 'Restore' }));
  expect(screen.getByText('Restore from a backup')).toBeTruthy();
  expect(screen.queryByText('Restoring is not available yet')).toBeNull();
  fireEvent.press(screen.getByRole('tab', { name: 'Inspect' }));
  fireEvent.press(screen.getByRole('button', { name: 'Inspect backup file' }));
  await screen.findByText('Backup inspection');
  expect(restore.review).not.toHaveBeenCalled();
  expect(restore.prepare).not.toHaveBeenCalled();
  expect(restore.execute).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Replace local cooking data' })).toBeNull();
});

test('format-2 history is off by default and choosing it never reads or exports automatically', async () => {
  enableExpanded();
  readBackup.mockResolvedValue({
    kind: 'ready',
    value: await exampleBackup(false, true),
    revision: 2,
  });
  render(<BackupSettings createTransfer={() => transfer} />);
  const option = screen.getByRole('checkbox', {
    name: 'Include cooking history in the next export',
  });
  expect(option).not.toBeChecked();
  fireEvent.press(screen.getByRole('button', { name: 'What is included?' }));
  expect(screen.getByText(/also exports private recipe notes/)).toBeTruthy();
  expect(readBackup).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Export plain-text backup' }));
  await screen.findByText('Contents offered for export');
  expect(readBackup).toHaveBeenCalledWith({ includeCookingHistory: false });
  expect(screen.getByLabelText('Private recipe notes: 1')).toBeTruthy();
  expect(screen.getByLabelText('Manual shopping items: 1')).toBeTruthy();
  expect(screen.getByText('Cooking history and its private notes are not included.')).toBeTruthy();
});

test('history opt-in applies once and resets before another export attempt', async () => {
  enableExpanded();
  const included = await exampleBackup(false, true, true);
  const excluded = await exampleBackup(false, true);
  readBackup
    .mockResolvedValueOnce({ kind: 'ready', value: included, revision: 2 })
    .mockResolvedValueOnce({ kind: 'ready', value: excluded, revision: 2 });
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(
    screen.getByRole('checkbox', { name: 'Include cooking history in the next export' }),
  );
  expect(readBackup).not.toHaveBeenCalled();
  expect(transfer.exportFile).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Export plain-text backup' }));
  await screen.findByLabelText('Cooking history entries: 1');
  expect(readBackup).toHaveBeenNthCalledWith(1, { includeCookingHistory: true });
  expect(screen.queryByText('Private cooking note fixture')).toBeNull();
  expect(
    screen.getByRole('checkbox', { name: 'Include cooking history in the next export' }),
  ).not.toBeChecked();
  fireEvent.press(screen.getByRole('button', { name: 'Export plain-text backup' }));
  await waitFor(() => expect(transfer.exportFile).toHaveBeenCalledTimes(2));
  expect(readBackup).toHaveBeenNthCalledWith(2, { includeCookingHistory: false });
  expect(transfer.exportFile).toHaveBeenNthCalledWith(1, JSON.stringify(included));
  expect(transfer.exportFile).toHaveBeenNthCalledWith(2, JSON.stringify(excluded));
});

test('failed export and leaving the screen do not retain history opt-in', async () => {
  enableExpanded();
  readBackup.mockResolvedValue({
    kind: 'failed',
    error: { code: 'storage_failure', messageKey: 'fixture', retry: 'never' },
  });
  const mounted = render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(
    screen.getByRole('checkbox', { name: 'Include cooking history in the next export' }),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Export plain-text backup' }));
  await screen.findByText(/No backup file was offered/);
  expect(
    screen.getByRole('checkbox', { name: 'Include cooking history in the next export' }),
  ).not.toBeChecked();
  fireEvent.press(
    screen.getByRole('checkbox', { name: 'Include cooking history in the next export' }),
  );
  mounted.unmount();
  render(<BackupSettings createTransfer={() => transfer} />);
  expect(
    screen.getByRole('checkbox', { name: 'Include cooking history in the next export' }),
  ).not.toBeChecked();
  expect(transfer.exportFile).not.toHaveBeenCalled();
});

test('format-2 inspection shows exact private-scope counts without displaying private field values', async () => {
  transfer.pickFile.mockResolvedValue({
    kind: 'selected',
    serialized: JSON.stringify(await exampleBackup(false, true, true)),
  });
  render(<BackupSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('tab', { name: 'Inspect' }));
  fireEvent.press(screen.getByRole('button', { name: 'Inspect backup file' }));
  await screen.findByText('Backup inspection');
  expect(screen.getByLabelText('Personal collections: 1')).toBeTruthy();
  expect(screen.getByLabelText('Collection memberships: 1')).toBeTruthy();
  expect(screen.getByLabelText('Purchased manual items: 1')).toBeTruthy();
  expect(screen.getByLabelText('Cooking history entries: 1')).toBeTruthy();
  for (const value of [
    'Private recipe note fixture',
    'Private cooking note fixture',
    'Private collection fixture',
    'Private shopping fixture',
  ])
    expect(screen.queryByText(value)).toBeNull();
  expect(readBackup).not.toHaveBeenCalled();
});
