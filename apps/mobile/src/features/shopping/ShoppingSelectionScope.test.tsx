import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { PlanOccurrence } from '@cookmate/contracts';
import type { PlanSnapshot, ShoppingSnapshot } from '@cookmate/domain';
import ShoppingSelectionScreen from './ShoppingSelectionScreen';
import { ActionButton } from '../../components/Controls';
import type { QueryState } from '../workspace/WorkspaceProvider';
import type { PlanningPreferencesSnapshot } from '../planning-preferences/planningPreferences';

let mockPlanning: PlanningPreferencesSnapshot;
const mockQueryKey = jest.fn();
jest.mock('../planning-preferences/PlanningPreferencesProvider', () => ({
  usePlanningPreferences: () => mockPlanning,
}));

const mockBegin = jest.fn();
const mockDirty = jest.fn();
const mockBack = jest.fn();
const mockParams = { date: '2026-09-30' };
const meal = (id: string, date: string): PlanOccurrence => ({
  occurrenceId: id,
  recipeId: '52839',
  placement: { actualDate: date, mealKey: 'dinner' },
  revision: 1,
  createdAt: '2026-09-30T08:00:00Z',
  updatedAt: '2026-09-30T08:00:00Z',
});
const mockMeals = [meal('this-week', '2026-09-30'), meal('next-week', '2026-10-08')];
const mockShopping: ShoppingSnapshot = {
  scope: {
    scopeId: 'scope',
    revision: 4,
    occurrenceIds: mockMeals.map((entry) => entry.occurrenceId),
  },
  selectedOccurrences: mockMeals,
  projectionRevision: 4,
  status: 'current',
  groups: [],
};
const mockPlans: Record<string, PlanSnapshot> = {
  'selection:2026-09-28:2026-10-04': {
    startDate: '2026-09-28',
    endDate: '2026-10-04',
    occurrences: [mockMeals[0]!],
    shoppingScope: mockShopping.scope,
  },
  'selection:2026-10-05:2026-10-11': {
    startDate: '2026-10-05',
    endDate: '2026-10-11',
    occurrences: [mockMeals[1]!],
    shoppingScope: mockShopping.scope,
  },
};
const mockQueryStates: Record<string, QueryState<PlanSnapshot>> = Object.fromEntries(
  Object.entries(mockPlans).map(([key, value]) => [key, { kind: 'ready', value, revision: 4 }]),
);
const mockShoppingState = { kind: 'ready', value: mockShopping, revision: 4 };
const mockRegister = jest.fn(() => () => undefined);
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    navigate: jest.fn(),
    canGoBack: () => true,
    back: mockBack,
  }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('../../hooks/useUnsavedDraft', () => ({
  useUnsavedDraft: (...args: unknown[]) => mockDirty(...args),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
jest.mock('../workspace/WorkspaceFeedback', () => ({
  QueryFeedback: () => null,
  WorkspaceFeedback: () => null,
  occurrenceLabel: (entry: PlanOccurrence) => `${entry.occurrenceId} dinner`,
}));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    actions: { begin: mockBegin, blocked: false, restoreAfterRemoval: jest.fn() },
    clock: { dateContext: () => ({ localDate: '2026-09-30' }) },
    actionState: { kind: 'idle' },
    registerFocusFallback: mockRegister,
    restoreScreenFocus: jest.fn(),
  }),
  useWorkspaceQuery: (key: string) => {
    mockQueryKey(key);
    return {
      state: key === 'selection-scope' ? mockShoppingState : mockQueryStates[key],
      retry: jest.fn(),
    };
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockPlanning = {
    preferences: { weekStart: 'monday', defaultMealSlot: 'dinner' },
    hydrated: true,
    saving: false,
    error: null,
  };
});

test('Clear this week preserves outside-week choices and switching weeks never submits the draft', async () => {
  const before = JSON.stringify(mockShopping);
  render(<ShoppingSelectionScreen />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Clear this week' })).toBeEnabled(),
  );
  expect(screen.getByText('1 selected this week · 1 outside this week')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Clear this week' }));
  expect(screen.getByText('0 selected this week · 1 outside this week')).toBeTruthy();
  expect(screen.getByRole('checkbox', { name: 'next-week dinner' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'this-week dinner' })).not.toBeChecked();
  fireEvent.press(screen.getByRole('button', { name: 'Next week' }));
  expect(screen.getByText('1 selected this week · 0 outside this week')).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
  expect(mockDirty.mock.calls.at(-1)?.[0]).toBe(true);
  fireEvent.press(screen.getByRole('button', { name: 'Review 1 selected meal' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'setShoppingSelection', occurrenceIds: ['next-week'] },
    expect.objectContaining({ confirm: true, observedSelectionRevision: 4 }),
  );
  expect(JSON.stringify(mockShopping)).toBe(before);
});

test('changing the week preference preserves all selection IDs and fences a retained Clear this week callback', async () => {
  const before = JSON.stringify(mockShopping);
  const view = render(<ShoppingSelectionScreen />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Clear this week' })).toBeEnabled(),
  );
  const clearOldWeek = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((node) => node.props.label === 'Clear this week')!.props.onPress;
  const previous = mockPlans['selection:2026-09-28:2026-10-04']!;
  mockQueryStates['selection:2026-09-27:2026-10-03'] = { kind: 'loading', previous };
  mockPlanning = {
    ...mockPlanning,
    preferences: { ...mockPlanning.preferences, weekStart: 'sunday' },
  };
  view.rerender(<ShoppingSelectionScreen />);
  expect(mockQueryKey).toHaveBeenCalledWith('selection:2026-09-27:2026-10-03');
  expect(screen.getByText('Mon 28 Sep – Sunday 4 October 2026')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Clear this week' })).toBeDisabled();
  act(clearOldWeek);
  expect(screen.getByRole('checkbox', { name: 'this-week dinner' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'next-week dinner' })).toBeChecked();
  mockQueryStates['selection:2026-09-27:2026-10-03'] = {
    kind: 'ready',
    revision: 4,
    value: { ...previous, startDate: '2026-09-27', endDate: '2026-10-03' },
  };
  view.rerender(<ShoppingSelectionScreen />);
  expect(screen.getByText('Sun 27 Sep – Saturday 3 October 2026')).toBeTruthy();
  expect(screen.getByText('1 selected this week · 1 outside this week')).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
  expect(JSON.stringify(mockShopping)).toBe(before);
  fireEvent.press(screen.getByRole('button', { name: 'Clear this week' }));
  fireEvent.press(screen.getByRole('button', { name: 'Review 1 selected meal' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'setShoppingSelection', occurrenceIds: ['next-week'] },
    expect.objectContaining({ observedSelectionRevision: 4 }),
  );
});
