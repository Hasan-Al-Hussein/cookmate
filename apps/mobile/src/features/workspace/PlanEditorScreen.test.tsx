import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { getRecipe } from '@cookmate/catalogue';
import { SEARCH_QUERY_MAX_LENGTH } from '@cookmate/domain';
import { Modal } from 'react-native';
import PlanEditorScreen from './PlanEditorScreen';
import type { PlanningPreferencesSnapshot } from '../planning-preferences/planningPreferences';

let mockPlanning: PlanningPreferencesSnapshot;
let mockToday = '2026-09-29';
jest.mock('../planning-preferences/PlanningPreferencesProvider', () => ({
  usePlanningPreferences: () => mockPlanning,
}));

const mockParams: Record<string, string> = {};
const mockBegin = jest.fn();
const mockPreventRemove = jest.fn();
const mockWorkspace = {
  actions: { blocked: false, begin: mockBegin, restoreAfterRemoval: jest.fn() },
  assistant: null,
  actionState: { kind: 'idle' },
  availability: { kind: 'ready' },
  recoveryState: { kind: 'ready', page: { entries: [], nextAfterSequence: null } },
  clock: { dateContext: () => ({ localDate: mockToday }) },
  registerFocusFallback: () => () => undefined,
  restoreScreenFocus: jest.fn(),
};
jest.mock('./WorkspaceProvider', () => ({
  useWorkspace: () => mockWorkspace,
  useWorkspaceQuery: () => ({
    state: { kind: 'ready', value: { occurrences: [] } },
    retry: jest.fn(),
  }),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ canGoBack: () => true, back: jest.fn(), replace: jest.fn() }),
  useNavigation: () => ({ dispatch: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (...args: unknown[]) => mockPreventRemove(...args),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));

beforeEach(() => {
  jest.useFakeTimers();
  mockToday = '2026-09-29';
  mockPlanning = {
    preferences: { weekStart: 'monday', defaultMealSlot: 'dinner' },
    hydrated: true,
    saving: false,
    error: null,
  };
  Object.keys(mockParams).forEach((key) => delete mockParams[key]);
  Object.assign(mockParams, { recipeId: '52839', date: '2026-09-29', meal: 'dinner' });
});

test('an unconstrained new meal waits for hydration and applies its default once', () => {
  delete mockParams.meal;
  mockPlanning = { ...mockPlanning, hydrated: false };
  const view = render(<PlanEditorScreen />);
  expect(screen.getByRole('button', { name: 'Review meal' })).toBeDisabled();
  mockPlanning = {
    ...mockPlanning,
    hydrated: true,
    preferences: { weekStart: 'sunday', defaultMealSlot: 'breakfast' },
  };
  view.rerender(<PlanEditorScreen />);
  expect(screen.getByRole('tab', { name: 'Breakfast' })).toBeSelected();
  expect(screen.getByRole('button', { name: 'Review meal' })).toBeEnabled();
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
  mockPlanning = {
    ...mockPlanning,
    preferences: { weekStart: 'monday', defaultMealSlot: 'lunch' },
  };
  view.rerender(<PlanEditorScreen />);
  expect(screen.getByRole('tab', { name: 'Breakfast' })).toBeSelected();
  expect(screen.getByText('Tuesday 29 September 2026')).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('a user-selected meal slot before hydration wins over a late default', () => {
  delete mockParams.meal;
  mockPlanning = { ...mockPlanning, hydrated: false };
  const view = render(<PlanEditorScreen />);
  fireEvent.press(screen.getByRole('tab', { name: 'Lunch' }));
  mockPlanning = {
    ...mockPlanning,
    hydrated: true,
    preferences: { weekStart: 'sunday', defaultMealSlot: 'breakfast' },
  };
  view.rerender(<PlanEditorScreen />);
  expect(screen.getByRole('tab', { name: 'Lunch' })).toBeSelected();
  fireEvent.press(screen.getByRole('button', { name: 'Review meal' }));
  expect(mockBegin).toHaveBeenCalledWith(
    expect.objectContaining({ placement: { actualDate: '2026-09-29', mealKey: 'lunch' } }),
    expect.anything(),
  );
});

test('a failed preference read never silently reviews fallback Dinner and a deliberate slot survives recovery', () => {
  delete mockParams.meal;
  mockPlanning = { ...mockPlanning, hydrated: false };
  const view = render(<PlanEditorScreen />);
  mockPlanning = { ...mockPlanning, hydrated: true, error: 'Saved defaults unavailable' };
  view.rerender(<PlanEditorScreen />);
  expect(
    screen.getByText(
      'Your saved default meal slot could not be confirmed. Choose a slot for this meal to continue.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Review meal' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Review meal' }));
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('tab', { name: 'Lunch' }));
  expect(screen.getByRole('button', { name: 'Review meal' })).toBeEnabled();
  mockPlanning = {
    ...mockPlanning,
    error: null,
    preferences: { weekStart: 'sunday', defaultMealSlot: 'breakfast' },
  };
  view.rerender(<PlanEditorScreen />);
  expect(screen.getByRole('tab', { name: 'Lunch' })).toBeSelected();
  fireEvent.press(screen.getByRole('button', { name: 'Review meal' }));
  expect(mockBegin).toHaveBeenCalledWith(
    expect.objectContaining({ placement: { actualDate: '2026-09-29', mealKey: 'lunch' } }),
    expect.anything(),
  );
});

test('a saved-default read failure does not block an explicitly routed existing meal', () => {
  mockParams.occurrenceId = 'retained-meal';
  mockPlanning = { ...mockPlanning, error: 'Saved defaults unavailable' };
  render(<PlanEditorScreen />);
  expect(screen.getByRole('tab', { name: 'Dinner' })).toBeSelected();
  expect(screen.getByRole('button', { name: 'Review meal' })).toBeEnabled();
});

test.each([false, true])(
  'an explicit routed slot keeps priority over preferences (existing occurrence %s)',
  (existing) => {
    if (existing) mockParams.occurrenceId = 'retained-meal';
    mockPlanning = {
      ...mockPlanning,
      preferences: { weekStart: 'sunday', defaultMealSlot: 'breakfast' },
    };
    render(<PlanEditorScreen />);
    expect(screen.getByRole('tab', { name: 'Dinner' })).toBeSelected();
    expect(screen.getByText('Tuesday 29 September 2026')).toBeTruthy();
  },
);

test('Today uses the new local date only after explicit activation and keeps a manually entered draft otherwise', () => {
  render(<PlanEditorScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  fireEvent.changeText(screen.getByLabelText('Meal date in YYYY-MM-DD format'), '2028-02-29');
  mockToday = '2026-09-30';
  expect(screen.getByDisplayValue('2028-02-29')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Today' }));
  expect(screen.getByDisplayValue('2026-09-30')).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

test('cancelling the focused recipe picker preserves edited date, slot, recipe and search', () => {
  render(<PlanEditorScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Enter date manually' }));
  fireEvent.changeText(screen.getByLabelText('Meal date in YYYY-MM-DD format'), '2026-10-02');
  fireEvent.press(screen.getByRole('tab', { name: 'Lunch' }));
  fireEvent.press(screen.getByRole('button', { name: 'Change recipe' }));
  fireEvent.changeText(screen.getByLabelText('Find a recipe for this meal'), 'Fettuccine Alfredo');
  expect(screen.getByText('Friday 2 October 2026 · Lunch')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Fettuccine Alfredo ·/ })).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent(
    screen
      .UNSAFE_getAllByType(Modal)
      .find((sheet) => sheet.props.accessibilityLabel === 'Choose a recipe')!,
    'dismiss',
  );
  expect(screen.queryByLabelText('Find a recipe for this meal')).toBeNull();
  expect(screen.getByDisplayValue('2026-10-02')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Lunch' })).toBeSelected();
  expect(screen.getByText(getRecipe('52839')!.title)).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(true);
  fireEvent.press(screen.getByRole('button', { name: 'Change recipe' }));
  expect(screen.getByDisplayValue('Fettuccine Alfredo')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.press(screen.getByRole('button', { name: 'Review meal' }));
  expect(mockBegin).toHaveBeenCalledWith(
    {
      kind: 'placeRecipe',
      recipeId: '52839',
      placement: { actualDate: '2026-10-02', mealKey: 'lunch' },
    },
    expect.objectContaining({ confirm: true }),
  );
});

test('choosing a replacement only changes the draft until the exact existing occurrence is reviewed', () => {
  mockParams.occurrenceId = 'existing-meal';
  render(<PlanEditorScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Change recipe' }));
  fireEvent.changeText(screen.getByLabelText('Find a recipe for this meal'), 'Fettuccine Alfredo');
  fireEvent.press(screen.getByRole('button', { name: /Fettuccine Alfredo ·/ }));
  expect(screen.queryByLabelText('Find a recipe for this meal')).toBeNull();
  expect(screen.getByText('Fettuccine Alfredo')).toBeTruthy();
  expect(screen.getByText('Tuesday 29 September 2026')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Dinner' })).toBeSelected();
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Review meal' }));
  expect(mockBegin).toHaveBeenCalledWith(
    {
      kind: 'placeRecipe',
      occurrenceId: 'existing-meal',
      recipeId: '53064',
      placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
    },
    expect.objectContaining({ confirm: true }),
  );
});

test('an empty dated slot opens the picker, and cancelling leaves a usable unsaved meal form', () => {
  delete mockParams.recipeId;
  mockParams.meal = 'breakfast';
  render(<PlanEditorScreen />);
  expect(screen.getByLabelText('Find a recipe for this meal')).toBeTruthy();
  expect(screen.getByText('Tuesday 29 September 2026 · Breakfast')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent(
    screen
      .UNSAFE_getAllByType(Modal)
      .find((sheet) => sheet.props.accessibilityLabel === 'Choose a recipe')!,
    'dismiss',
  );
  expect(screen.getByRole('button', { name: 'Choose a recipe' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Review meal' })).toBeDisabled();
  expect(screen.getByRole('tab', { name: 'Breakfast' })).toBeSelected();
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Choose a recipe' }));
  fireEvent.changeText(
    screen.getByLabelText('Find a recipe for this meal'),
    'Chilli prawn linguine',
  );
  fireEvent.press(screen.getByRole('button', { name: /Chilli prawn linguine ·/ }));
  expect(screen.getByRole('button', { name: 'Review meal' })).toBeEnabled();
  expect(screen.getByRole('tab', { name: 'Breakfast' })).toBeSelected();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('search failure and no matches retain the selected meal and recover without a command', () => {
  render(<PlanEditorScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Change recipe' }));
  const search = screen.getByLabelText('Find a recipe for this meal');
  fireEvent.changeText(search, 'x'.repeat(SEARCH_QUERY_MAX_LENGTH + 1));
  expect(screen.getByText('Couldn’t search recipes')).toBeTruthy();
  fireEvent.changeText(search, 'no-such-recipe-zzzz');
  expect(screen.queryByText('Couldn’t search recipes')).toBeNull();
  expect(screen.getByText('No matching recipes')).toBeTruthy();
  fireEvent.changeText(search, 'Chilli prawn linguine');
  expect(screen.queryByText('No matching recipes')).toBeNull();
  expect(screen.getByRole('button', { name: /Chilli prawn linguine ·/ })).toBeSelected();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText(getRecipe('52839')!.title)).toBeTruthy();
  expect(mockPreventRemove.mock.calls.at(-1)?.[0]).toBe(false);
  expect(mockBegin).not.toHaveBeenCalled();
});
