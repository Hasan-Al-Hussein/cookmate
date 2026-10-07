import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import PlanEditorScreen from '../features/workspace/PlanEditorScreen';
import { Preferences } from '../features/settings/Preferences';

const mockBegin = jest.fn();
const mockActions = { blocked: false, begin: mockBegin, restoreAfterRemoval: jest.fn() };
const mockWorkspace = {
  actions: mockActions,
  assistant: null,
  actionState: { kind: 'idle' },
  availability: { kind: 'ready' },
  recoveryState: { kind: 'ready', page: { entries: [], nextAfterSequence: null } },
  clock: { dateContext: () => ({ localDate: '2026-09-29' }) },
  registerFocusFallback: () => () => undefined,
  restoreScreenFocus: jest.fn(),
};
jest.mock('../features/workspace/WorkspaceProvider', () => ({
  useWorkspace: () => mockWorkspace,
  useWorkspaceQuery: () => ({
    state: {
      kind: 'ready',
      value: { revision: 0, lastRemovalRevision: null, items: [], occurrences: [] },
    },
    retry: jest.fn(),
  }),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ recipeId: '52839', date: '2026-09-29', meal: 'dinner' }),
  useRouter: () => ({ canGoBack: () => true, back: jest.fn(), replace: jest.fn() }),
  useNavigation: () => ({ dispatch: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));

afterEach(cleanup);

test('native meal date help follows invalid-to-valid recovery without invoking a disabled command', () => {
  render(<PlanEditorScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  const label = 'Meal date in YYYY-MM-DD format';
  fireEvent.changeText(screen.getByLabelText(label), '2026-02-30');
  const invalidHelp = 'Enter a valid date between 1900-01-01 and 2100-12-31.';
  const invalidInput = screen.getByLabelText(label);
  expect(invalidInput.props.accessibilityHint).toBe(invalidHelp);
  expect(invalidInput.props['aria-invalid']).toBeUndefined();
  expect(invalidInput.props.accessibilityState?.invalid).toBeUndefined();
  const helpId = screen.getByText(invalidHelp).props.nativeID;
  expect(typeof helpId).toBe('string');
  expect(helpId).not.toBe('');
  const review = screen.getByRole('button', { name: 'Review meal' });
  expect(review).toBeDisabled();
  fireEvent.press(review);
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText(label), '2028-02-29');
  const validHelp = 'Use YYYY-MM-DD. Dates from 1900 to 2100 are supported.';
  expect(screen.getByLabelText(label).props.accessibilityHint).toBe(validHelp);
  expect(screen.getByText(validHelp).props.nativeID).toBe(helpId);
  expect(screen.getByRole('button', { name: 'Review meal' })).not.toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Review meal' }));
  expect(mockBegin).toHaveBeenCalledTimes(1);
  expect(mockBegin).toHaveBeenCalledWith(
    {
      kind: 'placeRecipe',
      recipeId: '52839',
      placement: { actualDate: '2028-02-29', mealKey: 'dinner' },
    },
    expect.objectContaining({ confirm: true }),
  );
});

test.each([
  ['whitespace', ' \t\n', ' Italian ', 'Enter at least one non-space character.'],
  ['overlimit code points', '🍋'.repeat(257), '🍋'.repeat(256), 'Use 256 characters or fewer.'],
] as const)(
  'native preference help explains %s and permits only the recovered value',
  (_scenario, invalidValue, validValue, errorHelp) => {
    render(<Preferences />);
    fireEvent.press(screen.getByRole('button', { name: 'Add a saved preference' }));
    expect(screen.getByLabelText('Preference value').props.accessibilityHint).toContain(
      'Enter at least one non-space character.',
    );
    fireEvent.changeText(screen.getByLabelText('Preference value'), invalidValue);
    const invalidInput = screen.getByLabelText('Preference value');
    const hint = invalidInput.props.accessibilityHint as string;
    expect(hint).toContain(`${[...invalidValue].length} / 256 characters.`);
    expect(hint).toContain(errorHelp);
    const helpId = screen.getByText(hint).props.nativeID;
    expect(typeof helpId).toBe('string');
    expect(invalidInput.props['aria-describedby']).toBeUndefined();
    expect(invalidInput.props.accessibilityState?.invalid).toBeUndefined();
    const save = screen.getByRole('button', { name: 'Save preference' });
    expect(save).toBeDisabled();
    fireEvent.press(save);
    expect(mockBegin).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByLabelText('Preference value'), validValue);
    const recoveredHint = screen.getByLabelText('Preference value').props
      .accessibilityHint as string;
    expect(recoveredHint).toBe(
      `${[...validValue].length} / 256 characters. This value is saved only when you select Save preference.`,
    );
    expect(screen.getByText(recoveredHint).props.nativeID).toBe(helpId);
    expect(screen.getByRole('button', { name: 'Save preference' })).not.toBeDisabled();
    fireEvent.press(screen.getByRole('button', { name: 'Save preference' }));
    expect(mockBegin).toHaveBeenCalledTimes(1);
    expect(mockBegin).toHaveBeenCalledWith(
      { kind: 'savePreference', type: 'cuisine', explicitValue: validValue },
      { observedPreferenceRevision: 0 },
    );
  },
);
