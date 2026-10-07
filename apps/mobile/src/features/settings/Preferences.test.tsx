import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { PreferenceSnapshot, PreferenceType } from '@cookmate/contracts';
import type { ConfirmationOptions } from '../../components/confirmAction';
import { Preferences } from './Preferences';
import { ActionButton } from '../../components/Controls';

const mockBegin = jest.fn();
const mockConfirm = jest.fn<void, [ConfirmationOptions]>();
const mockActions = { blocked: false, begin: mockBegin, restoreAfterRemoval: jest.fn() };
let mockSnapshot: PreferenceSnapshot = { revision: 0, lastRemovalRevision: null, items: [] };
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    actions: mockActions,
    actionState: { kind: 'idle' },
    restoreScreenFocus: jest.fn(),
  }),
  useWorkspaceQuery: () => ({ state: { kind: 'ready', value: mockSnapshot }, retry: jest.fn() }),
}));
jest.mock('../../components/confirmAction', () => ({
  confirmAction: (options: ConfirmationOptions) => mockConfirm(options),
}));
jest.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

beforeEach(() => {
  mockSnapshot = { revision: 0, lastRemovalRevision: null, items: [] };
  mockActions.blocked = false;
  mockBegin.mockClear();
  mockConfirm.mockClear();
});
afterEach(cleanup);

test('an empty-state example opens a blank typed draft without saving a suggested preference', () => {
  render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'An ingredient to avoid' }));
  expect(
    screen.getByRole('radio', { name: 'Ingredient I avoid' }).props.accessibilityState.checked,
  ).toBe(true);
  expect(screen.getByText('Which ingredient would you rather avoid?')).toBeTruthy();
  expect(screen.getByLabelText('Preference value').props.value).toBe('');
  expect(screen.getByRole('button', { name: 'Save preference' })).toBeDisabled();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('a source cuisine suggestion preserves its exact label and only saves on explicit approval', () => {
  render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'A cuisine I enjoy' }));
  fireEvent.changeText(screen.getByLabelText('Preference value'), 'ital');
  fireEvent.press(screen.getByRole('button', { name: 'Use Italian' }));
  expect(screen.getByLabelText('Preference value').props.value).toBe('Italian');
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Save preference' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
    { observedPreferenceRevision: 0 },
  );
});

test('changing preference type keeps the draft text until a source ingredient is deliberately chosen', () => {
  render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'Add a saved preference' }));
  fireEvent.changeText(screen.getByLabelText('Preference value'), 'my own wording');
  fireEvent.press(screen.getByRole('radio', { name: 'Ingredient I like' }));
  expect(screen.getByLabelText('Preference value').props.value).toBe('my own wording');
  fireEvent.changeText(screen.getByLabelText('Preference value'), 'garl');
  fireEvent.press(screen.getByRole('button', { name: 'Use Garlic' }));
  expect(screen.getByLabelText('Preference value').props.value).toBe('Garlic');
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Save preference' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'savePreference', type: 'ingredient_like', explicitValue: 'Garlic' },
    { observedPreferenceRevision: 0 },
  );
});

test.each<[PreferenceType, string, string]>([
  ['cuisine', 'Cuisine', 'Which cuisine do you enjoy?'],
  ['ingredient_like', 'Ingredient I like', 'Which ingredient do you enjoy?'],
  ['ingredient_avoid', 'Ingredient I avoid', 'Which ingredient would you rather avoid?'],
  ['dietary_style', 'Dietary style', 'How would you describe your eating style?'],
])('%s retains custom Unicode wording and its original command contract', (type, label, prompt) => {
  render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'Add a saved preference' }));
  fireEvent.press(screen.getByRole('radio', { name: label }));
  expect(screen.getByText(prompt)).toBeTruthy();
  const custom = '  أفضل طعامي بهذه الطريقة 🌿  ';
  fireEvent.changeText(screen.getByLabelText('Preference value'), custom);
  if (type === 'dietary_style') {
    expect(screen.queryByText('From the recipe collection')).toBeNull();
    expect(
      screen.getByText(/Recipe categories are not verified dietary classifications/),
    ).toBeTruthy();
  } else
    expect(
      screen.getByText('No matching source label. You can save your own wording.'),
    ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Save preference' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'savePreference', type, explicitValue: custom },
    { observedPreferenceRevision: 0 },
  );
});

test('cancelling an edited preference protects the changed draft until discard is confirmed', () => {
  mockSnapshot = {
    revision: 5,
    lastRemovalRevision: null,
    items: [{ preferenceId: 'saved-cuisine', type: 'cuisine', value: 'Italian', revision: 5 }],
  };
  render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'Edit Cuisine: Italian' }));
  fireEvent.changeText(screen.getByLabelText('Preference value'), 'new unsaved wording');
  const oldSave = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((node) => node.props.label === 'Save preference')!.props.onPress as () => void;
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(mockConfirm).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Discard preference draft?',
      cancelLabel: 'Keep editing',
    }),
  );
  expect(screen.getByLabelText('Preference value').props.value).toBe('new unsaved wording');
  expect(mockSnapshot.items[0]!.value).toBe('Italian');
  act(() => mockConfirm.mock.calls[0]![0].onConfirm());
  expect(screen.queryByLabelText('Preference value')).toBeNull();
  act(oldSave);
  expect(mockBegin).not.toHaveBeenCalled();
});

test('a newer saved-preference revision keeps the draft but prevents stale saving', () => {
  const view = render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'A cuisine I enjoy' }));
  fireEvent.changeText(screen.getByLabelText('Preference value'), 'Italian');
  mockSnapshot = { revision: 1, lastRemovalRevision: 1, items: [] };
  view.rerender(<Preferences />);
  expect(screen.getByText('Saved preferences changed')).toBeTruthy();
  expect(screen.getByLabelText('Preference value').props.value).toBe('Italian');
  expect(screen.getByRole('button', { name: 'Save preference' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Save preference' }));
  expect(mockBegin).not.toHaveBeenCalled();
});

test('pending operations disable new entry points and source choices', () => {
  const view = render(<Preferences />);
  fireEvent.press(screen.getByRole('button', { name: 'A cuisine I enjoy' }));
  fireEvent.changeText(screen.getByLabelText('Preference value'), 'ital');
  mockActions.blocked = true;
  view.rerender(<Preferences />);
  expect(screen.getByRole('button', { name: 'A cuisine I enjoy' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Use Italian' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: 'Ingredient I avoid' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Use Italian' }));
  expect(screen.getByLabelText('Preference value').props.value).toBe('ital');
  expect(mockBegin).not.toHaveBeenCalled();
});
