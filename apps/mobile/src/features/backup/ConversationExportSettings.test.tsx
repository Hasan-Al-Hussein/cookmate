import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { catalogue } from '@cookmate/catalogue';
import { createConversationExportSnapshot, formatConversationExportText } from '@cookmate/domain';
import type { CookMateQueries } from '@cookmate/domain';
import { ConversationExportSettings } from './ConversationExportSettings';
import { ActionButton } from '../../components/Controls';
import type { BackupTransfer } from './backupTransferTypes';

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('./backupTransfer', () => ({ createBackupTransfer: jest.fn() }));
const mockWorkspace = jest.fn();
jest.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => mockWorkspace() }));

const stamp = '2026-10-01T09:00:00.000Z';
function fixture(empty = false) {
  return createConversationExportSnapshot({
    exportedAt: stamp,
    catalogue: catalogue.identity,
    header: {
      conversationId: 'synthetic-conversation',
      generation: 1,
      revision: 2,
      composerDraft: 'EXCLUDED UNSENT DRAFT',
      nextSequence: 2,
    },
    messages: empty
      ? []
      : [
          {
            messageId: 'synthetic-message',
            conversationId: 'synthetic-conversation',
            generation: 1,
            sequence: 1,
            role: 'user',
            text: 'A private synthetic cooking question',
            status: 'complete',
            createdAt: stamp,
            referenceSets: [],
          },
        ],
  });
}
const read = jest.fn<ReturnType<NonNullable<CookMateQueries['readConversationExport']>>, []>();
let transfer: jest.Mocked<BackupTransfer>;
beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'web');
  read.mockReset().mockResolvedValue({ kind: 'ready', value: fixture(), revision: 2 });
  mockWorkspace.mockReturnValue({
    availability: { kind: 'ready', services: { queries: { readConversationExport: read } } },
  });
  transfer = {
    exportFile: jest.fn().mockResolvedValue('download_requested'),
    copyText: jest.fn().mockResolvedValue(undefined),
    pickFile: jest.fn(),
    dispose: jest.fn(),
  };
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
async function prepare() {
  fireEvent.press(screen.getByRole('button', { name: 'Preview conversation export' }));
  return screen.findByText('Review this export');
}

test('default-off export reads nothing until asked, previews scope before transfer and excludes the draft', async () => {
  render(<ConversationExportSettings createTransfer={() => transfer} />);
  expect(read).not.toHaveBeenCalled();
  expect(transfer.exportFile).not.toHaveBeenCalled();
  await prepare();
  expect(transfer.exportFile).not.toHaveBeenCalled();
  expect(screen.getByText(/separate from cooking backups and cloud sync/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Read transcript preview' }));
  expect(screen.getByLabelText('Conversation transcript preview').props.value).toBe(
    formatConversationExportText(fixture()),
  );
  expect(screen.getByLabelText('Conversation transcript preview').props.value).not.toContain(
    'EXCLUDED UNSENT DRAFT',
  );
  fireEvent.press(screen.getByRole('button', { name: 'Download transcript' }));
  expect(await screen.findByText(/Download requested/)).toBeTruthy();
  expect(transfer.exportFile).toHaveBeenCalledWith(formatConversationExportText(fixture()));
});

test('empty or oversized conversation offers no partial file', async () => {
  read.mockResolvedValueOnce({ kind: 'ready', value: fixture(true), revision: 2 });
  render(<ConversationExportSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Preview conversation export' }));
  expect(await screen.findByText(/No saved messages to export/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Download transcript' })).toBeNull();
  read.mockResolvedValueOnce({
    kind: 'failed',
    error: {
      code: 'too_large',
      messageKey: 'conversation_export.byte_limit',
      retry: 'after_correction',
    },
  });
  fireEvent.press(screen.getByRole('button', { name: 'Preview conversation export' }));
  expect(await screen.findByText(/No partial transcript was created/)).toBeTruthy();
  expect(transfer.exportFile).not.toHaveBeenCalled();
});

test('clipboard denial keeps the prepared copy and does not claim success', async () => {
  jest.mocked(transfer.copyText!).mockRejectedValueOnce(new Error('Synthetic denied clipboard'));
  render(<ConversationExportSettings createTransfer={() => transfer} />);
  await prepare();
  fireEvent.press(screen.getByRole('button', { name: 'Copy transcript' }));
  expect(await screen.findByText(/did not confirm copying/)).toBeTruthy();
  expect(screen.getByText('Review this export')).toBeTruthy();
  expect(screen.queryByText(/Transcript copied/)).toBeNull();
});

test('a workspace switch discards old prepared private content and ignores a late read', async () => {
  let finish!: (
    result: Awaited<ReturnType<NonNullable<CookMateQueries['readConversationExport']>>>,
  ) => void;
  read.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<ConversationExportSettings createTransfer={() => transfer} />);
  fireEvent.press(screen.getByRole('button', { name: 'Preview conversation export' }));
  mockWorkspace.mockReturnValue({
    availability: { kind: 'ready', services: { queries: { readConversationExport: jest.fn() } } },
  });
  view.rerender(<ConversationExportSettings createTransfer={() => transfer} />);
  await act(async () => {
    finish({ kind: 'ready', value: fixture(), revision: 2 });
  });
  expect(screen.queryByText('Review this export')).toBeNull();
  expect(transfer.exportFile).not.toHaveBeenCalled();
});

test('native share closure is not represented as saved delivery', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  transfer.exportFile.mockResolvedValue('share_sheet_closed');
  render(<ConversationExportSettings createTransfer={() => transfer} />);
  await prepare();
  fireEvent.press(screen.getByRole('button', { name: 'Save or share transcript' }));
  expect(
    await screen.findByText(/cannot tell whether you saved, shared or cancelled/),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Copy transcript' })).toBeNull();
});

test('queued callbacks from the previous owner cannot transfer that owner’s prepared transcript', async () => {
  const view = render(<ConversationExportSettings createTransfer={() => transfer} />);
  await prepare();
  const previousDownload = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.label === 'Download transcript')!.props.onPress;
  const previousCopy = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((button) => button.props.label === 'Copy transcript')!.props.onPress;
  mockWorkspace.mockReturnValue({
    availability: { kind: 'ready', services: { queries: { readConversationExport: jest.fn() } } },
  });
  view.rerender(<ConversationExportSettings createTransfer={() => transfer} />);
  await act(async () => {
    previousDownload();
    previousCopy();
  });
  expect(transfer.exportFile).not.toHaveBeenCalled();
  expect(transfer.copyText).not.toHaveBeenCalled();
  expect(screen.queryByText('Review this export')).toBeNull();
});
