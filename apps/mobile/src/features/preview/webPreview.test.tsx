import { AssistantEntryProvider, useAssistantEntry } from '../assistant/AssistantEntryState';
import {
  cleanup,
  fireEvent,
  render as renderNative,
  screen,
  within,
} from '@testing-library/react-native';
import { Alert, Modal, Platform, Pressable } from 'react-native';
import type { OperationReceipt } from '@cookmate/contracts';
import { AppText } from '../../components/Typography';
import { PreviewFrame } from '../../components/PreviewFrame.web';
import { confirmAction } from '../../components/confirmAction.web';
import AssistantScreen from '../assistant/AssistantScreen.web';
import { createNativeAssistant } from '../assistant/nativeAssistant.web';
import { ConnectionSettings } from '../settings/ConnectionSettings.web';
import { Preferences } from '../settings/Preferences';
import SettingsScreen from '../settings/SettingsScreen';
import { FilterSheet } from '../discover/FilterSheet';
import { ActionConfirmation, receiptMessage } from '../workspace/WorkspaceFeedback';
import DiagnosticRoute from '../../../app/foundation-probe.web';
import { useUnsavedDraft } from '../../hooks/useUnsavedDraft';

function render(ui: Parameters<typeof renderNative>[0]) {
  return renderNative(ui, { wrapper: AssistantEntryProvider });
}

const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockDispatch = jest.fn();
const mockConfirm = jest.fn<boolean, [string?]>();
const mockBegin = jest.fn();
const mockRestore = jest.fn();
const mockRegisterFocus = jest.fn(() => () => undefined);
let mockBlocked = false;
let mockActionKind = 'idle';
let mockSection = '';
let mockRemove: ((event: { data: { action: unknown } }) => void) | undefined;
const originalConfirm = Object.getOwnPropertyDescriptor(globalThis, 'confirm');

// Run the shared controls with the browser confirmation implementation and injected local state.
jest.mock('../../components/confirmAction', () =>
  jest.requireActual('../../components/confirmAction.web'),
);
jest.mock('../../components/PreviewFrame', () =>
  jest.requireActual('../../components/PreviewFrame.web'),
);
jest.mock('../settings/ConnectionSettings', () =>
  jest.requireActual('../settings/ConnectionSettings.web'),
);
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ section: mockSection }),
  useNavigation: () => ({ dispatch: mockDispatch }),
  useRouter: () => ({
    push: mockPush,
    navigate: mockNavigate,
    setParams: mockSetParams,
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (_dirty: boolean, callback: typeof mockRemove) => {
    mockRemove = callback;
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    assistant: null,
    actions: { blocked: mockBlocked, begin: mockBegin, restoreAfterRemoval: mockRestore },
    actionState: {
      kind: mockActionKind,
      review: {
        guard: { kind: 'none' },
        input: { kind: 'setFavourite', recipeId: '52839', saved: true },
        payload: { kind: 'setFavourite', recipeId: '52839', saved: true },
        consequences: { kind: 'favourite', recipeId: '52839', saved: true },
      },
      refreshed: false,
    },
    availability: { kind: 'ready', services: {} },
    recoveryState: { kind: 'ready', page: { entries: [], nextAfterSequence: null } },
    registerFocusFallback: mockRegisterFocus,
    restoreScreenFocus: mockRestore,
  }),
  useWorkspaceQuery: () => ({
    state: {
      kind: 'ready',
      value: { revision: 0, lastRemovalRevision: null, items: [] },
      revision: 0,
    },
    retry: jest.fn(),
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirm.mockReturnValue(false);
  mockBlocked = false;
  mockActionKind = 'idle';
  mockSection = '';
  mockRemove = undefined;
  Object.defineProperty(globalThis, 'confirm', {
    configurable: true,
    writable: true,
    value: mockConfirm,
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
afterAll(() => {
  if (originalConfirm) Object.defineProperty(globalThis, 'confirm', originalConfirm);
  else delete (globalThis as { confirm?: unknown }).confirm;
});

test('web preview identifies its scope and allows a draft without a live conversation or sending', () => {
  expect(createNativeAssistant).toBeUndefined();
  render(
    <PreviewFrame>
      <AssistantScreen />
    </PreviewFrame>,
  );
  expect(
    screen.getByText('CookMate web preview · Browser-local data · AI unavailable'),
  ).toBeTruthy();
  expect(screen.getByText('Chat is unavailable in this preview.')).toBeTruthy();
  expect(screen.queryByText('Opening your conversation…')).toBeNull();
  expect(screen.queryByLabelText('Draft question')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Show example conversation' })).toBeNull();
  expect(screen.queryByText('Why is browser data separate?')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Prepare a question' }));
  expect(screen.getByText('Draft only in this preview. Sending is unavailable.')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Draft question'), 'Keep this draft');
  expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Learn more' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/settings', params: { section: 'privacy' } });
  expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('a new search entry has one editable question and adds it to a draft only deliberately', () => {
  function SearchEntry() {
    const entry = useAssistantEntry();
    return (
      <>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Test search handoff"
          onPress={() => entry.openSearch({ query: 'pasta' })}
        />
        <AssistantScreen />
      </>
    );
  }
  render(<SearchEntry />);
  fireEvent.press(screen.getByRole('button', { name: 'Test search handoff' }));
  expect(screen.getByLabelText('Suggested question from your search')).toBeTruthy();
  expect(screen.queryByLabelText('Draft question')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Prepare a question' })).toBeNull();
  fireEvent.changeText(
    screen.getByLabelText('Suggested question from your search'),
    'Can I use this pasta?',
  );
  fireEvent.press(screen.getByRole('button', { name: 'Add question to draft' }));
  expect(screen.queryByLabelText('Suggested question from your search')).toBeNull();
  expect(screen.getByDisplayValue('Can I use this pasta?')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('Help opens an isolated example and returns without changing an existing browser draft', () => {
  const view = render(<AssistantScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Prepare a question' }));
  fireEvent.changeText(screen.getByLabelText('Draft question'), 'My real unsent question');
  mockSection = 'help';
  view.rerender(<SettingsScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Assistant preview' }));
  expect(mockSetParams).toHaveBeenCalledWith({ section: 'assistant-preview' });
  mockSection = 'assistant-preview';
  view.rerender(<SettingsScreen />);
  expect(screen.getByText('Example only')).toBeTruthy();
  expect(screen.getByText(/A sample conversation, not a live AI response/)).toBeTruthy();
  expect(screen.queryByDisplayValue('My real unsent question')).toBeNull();
  expect(screen.queryByLabelText('Draft question')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'View recipe: Chilli prawn linguine' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/recipe/[id]', params: { id: '52839' } });
  fireEvent.press(screen.getByRole('button', { name: 'Source: Chilli prawn linguine' }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe/[id]',
    params: { id: '52839', section: 'source' },
  });
  expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Back to Help' }));
  expect(mockSetParams).toHaveBeenCalledWith({ section: 'help' });
  view.rerender(<AssistantScreen />);
  expect(screen.getByDisplayValue('My real unsent question')).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('web connection and foundation probe show their limits without native controls', () => {
  const view = render(<ConnectionSettings />);
  expect(screen.getByText('Pairing is unavailable in this web preview')).toBeTruthy();
  expect(screen.queryByLabelText('One-time laptop pairing code')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Pair this iPhone' })).toBeNull();
  view.unmount();
  render(<DiagnosticRoute />);
  expect(screen.getByText('Native checks are unavailable in this web preview')).toBeTruthy();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
});

test('native frame keeps its original children without a preview banner', () => {
  const { PreviewFrame: NativeFrame } = jest.requireActual<
    typeof import('../../components/PreviewFrame')
  >('../../components/PreviewFrame');
  render(
    <NativeFrame>
      <AppText>Native content</AppText>
    </NativeFrame>,
  );
  expect(screen.getByText('Native content')).toBeTruthy();
  expect(screen.queryByText(/CookMate web preview/)).toBeNull();
});

test('browser confirmation dispatches a guarded navigation action only after acceptance', () => {
  function Draft() {
    useUnsavedDraft(true, 'Discard meal draft?');
    return <AppText>Unsaved meal</AppText>;
  }
  const action = { type: 'GO_BACK' };
  render(<Draft />);
  mockRemove!({ data: { action } });
  expect(mockConfirm).toHaveBeenCalledWith(
    'Discard meal draft?\n\nYour unconfirmed choices will be discarded.',
  );
  expect(mockDispatch).not.toHaveBeenCalled();
  mockConfirm.mockReturnValue(true);
  mockRemove!({ data: { action } });
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledWith(action);
});

test('browser Cancel retains a preference draft and OK discards it without saving', () => {
  render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'Add a saved preference' }));
  expect(within(screen.UNSAFE_getByType(Modal)).getByText(/CookMate web preview/)).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('Preference value'), 'Italian');
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(mockConfirm).toHaveBeenCalledWith(
    'Discard preference draft?\n\nYour saved preferences will stay unchanged.',
  );
  expect(screen.getByDisplayValue('Italian')).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
  mockConfirm.mockReturnValue(true);
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('Preference value')).toBeNull();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('filter and action review modal content retains the browser preview identity', async () => {
  const view = render(
    <FilterSheet
      visible
      criteria={{}}
      onApply={jest.fn()}
      onClose={jest.fn()}
      onDismiss={jest.fn()}
    />,
  );
  expect(
    await within(screen.UNSAFE_getByType(Modal)).findByText(/CookMate web preview/),
  ).toBeTruthy();
  view.unmount();
  mockActionKind = 'confirmation';
  render(<ActionConfirmation />);
  expect(within(screen.UNSAFE_getByType(Modal)).getByText(/CookMate web preview/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save recipe' })).toBeTruthy();
});

test.each(['about', 'privacy'])(
  'browser settings %s describes site storage and separate phone data',
  (section) => {
    jest.replaceProperty(Platform, 'OS', 'web');
    mockSection = section;
    render(<SettingsScreen />);
    expect(screen.getByText('Data & privacy')).toBeTruthy();
    expect(screen.getByText('Why is browser data separate?')).toBeTruthy();
    expect(
      screen.getByText(/Your browser and iPhone each keep their own local cooking copy/),
    ).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Data and privacy details' }));
    expect(screen.getByText('Saved in this browser')).toBeTruthy();
    expect(
      screen.getByText(/Different CookMate accounts use separate local workspaces/),
    ).toBeTruthy();
    expect(screen.getByText(/Clearing site data, browser storage cleanup/)).toBeTruthy();
    expect(screen.queryByText('Saved on this iPhone')).toBeNull();
  },
);

test.each([
  ['web', 'Change saved in this browser.'],
  ['ios', 'Change saved on this iPhone.'],
] as const)('%s receipts describe the actual storage surface', (platform, message) => {
  jest.replaceProperty(Platform, 'OS', platform);
  const receipt: OperationReceipt = {
    schemaVersion: 1,
    operationId: 'preview-test-operation',
    userIntentId: 'preview-test-intent',
    payloadFingerprint: 'a'.repeat(64),
    outcome: 'committed',
    committedAt: '2026-09-28T04:30:00Z',
    effects: [{ kind: 'favourite', entityId: '52839', revision: 1, saved: true }],
    shoppingProjection: 'unchanged',
  };
  expect(receiptMessage(receipt)).toBe(message);
  expect(receiptMessage({ ...receipt, outcome: 'no_op', effects: [] })).toBe(
    'Already up to date. No change was needed.',
  );
});

test('closing a pending preference result uses truthful confirmation and does not repeat the save', () => {
  const view = render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'Add a saved preference' }));
  fireEvent.changeText(screen.getByLabelText('Preference value'), 'Italian');
  fireEvent.press(screen.getByRole('button', { name: 'Save preference' }));
  expect(mockBegin).toHaveBeenCalledTimes(1);
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
    { observedPreferenceRevision: 0 },
  );
  mockBlocked = true;
  mockActionKind = 'uncertain';
  view.rerender(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'Close editor' }));
  expect(mockConfirm).toHaveBeenCalledWith(
    'Close while the result is pending?\n\nClosing only leaves this editor. The preference may already be saved or may still finish saving. Check its result in Settings.',
  );
  expect(screen.getByDisplayValue('Italian')).toBeTruthy();
  mockConfirm.mockReturnValue(true);
  fireEvent.press(screen.getByRole('button', { name: 'Close editor' }));
  expect(screen.queryByLabelText('Preference value')).toBeNull();
  expect(mockBegin).toHaveBeenCalledTimes(1);
});

test('missing browser confirmation never authorizes a destructive action', () => {
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: undefined });
  const confirm = jest.fn();
  confirmAction({
    title: 'Discard?',
    message: 'Unsaved work will be discarded.',
    cancelLabel: 'Keep editing',
    confirmLabel: 'Discard changes',
    destructive: true,
    onConfirm: confirm,
  });
  expect(confirm).not.toHaveBeenCalled();
});

test('native confirmation keeps the existing labels, styles and explicit callback', () => {
  const native = jest.requireActual<typeof import('../../components/confirmAction')>(
    '../../components/confirmAction',
  );
  const onConfirm = jest.fn();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  try {
    native.confirmAction({
      title: 'Discard?',
      message: 'Saved work stays unchanged.',
      cancelLabel: 'Keep editing',
      confirmLabel: 'Discard draft',
      destructive: true,
      onConfirm,
    });
    expect(alert).toHaveBeenCalledWith('Discard?', 'Saved work stays unchanged.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard draft', style: 'destructive', onPress: onConfirm },
    ]);
    expect(onConfirm).not.toHaveBeenCalled();
    alert.mock.calls[0]![2]![1]!.onPress!();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(mockConfirm).not.toHaveBeenCalled();
  } finally {
    alert.mockRestore();
  }
});
