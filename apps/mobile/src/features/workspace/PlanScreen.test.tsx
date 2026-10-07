import type { ReactNode, Ref } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Modal, type ScrollView } from 'react-native';
import type { PlanOccurrence } from '@cookmate/contracts';
import type { PlanSnapshot } from '@cookmate/domain';
import { getRecipe } from '@cookmate/catalogue';
import { PlanScreen } from './PlanScreen';
import { ActionButton } from '../../components/Controls';
import type { QueryState } from './WorkspaceProvider';
import type { PlanningPreferencesSnapshot } from '../planning-preferences/planningPreferences';

const mockPush = jest.fn();
const mockBegin = jest.fn();
const mockFocus = jest.fn((_target: unknown) => true);
const mockScrollTo = jest.fn();
const mockInner = {};
const mockMeasuredDays: string[] = [];
const mockParams: Record<string, string> = {};
const mockActions = { blocked: false, begin: mockBegin, restoreAfterRemoval: jest.fn() };
let mockSnapshot: PlanSnapshot;
let mockQueryState: QueryState<PlanSnapshot> | null = null;
const mockQueryKey = jest.fn();
let mockPlanning: PlanningPreferencesSnapshot;
let mockToday = '2026-09-30';
jest.mock('../planning-preferences/PlanningPreferencesProvider', () => ({
  usePlanningPreferences: () => mockPlanning,
}));
let mockReduced = true;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: jest.fn(),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => mockReduced }));
jest.mock('../../components/focusTarget', () => ({
  focusTarget: (target: unknown) => mockFocus(target),
}));
jest.mock('../../components/Page', () => ({
  Page: ({ children, scrollRef }: { children: ReactNode; scrollRef: Ref<ScrollView> }) => {
    const { View } = require('react-native');
    require('react').useImperativeHandle(scrollRef, () => ({
      scrollTo: mockScrollTo,
      getInnerViewNode: () => mockInner,
    }));
    return <View>{children}</View>;
  },
  PageHeader: () => null,
}));
jest.mock('./WorkspaceFeedback', () => ({
  WorkspaceFeedback: () => null,
  QueryFeedback: () => null,
}));
jest.mock('../shopping/ShoppingScreen', () => ({ ShoppingScreen: () => null }));
jest.mock('./WorkspaceProvider', () => ({
  useWorkspace: () => ({
    actions: mockActions,
    restoreScreenFocus: jest.fn(),
    clock: { dateContext: () => ({ localDate: mockToday }) },
  }),
  useWorkspaceQuery: (key: string) => {
    mockQueryKey(key);
    return {
      state: mockQueryState ?? { kind: 'ready', value: mockSnapshot, revision: 1 },
      retry: jest.fn(),
    };
  },
}));

const dinner: PlanOccurrence = {
  occurrenceId: 'dinner-occurrence',
  recipeId: '52819',
  revision: 1,
  createdAt: '2026-09-30T08:00:00Z',
  updatedAt: '2026-09-30T08:00:00Z',
  placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
};
const dateLabel = 'Wednesday 30 September 2026';
const optionsLabel = `Meal options for Dinner on ${dateLabel}`;
function showPlan() {
  return render(<PlanScreen />);
}
function measureHeadings() {
  for (const heading of screen.getAllByRole('header')) {
    let native = heading;
    while (typeof native.instance?.measureLayout !== 'function' && native.parent)
      native = native.parent;
    expect(typeof native.instance?.measureLayout).toBe('function');
    native.instance.measureLayout = jest.fn(
      (relative: unknown, success: (x: number, y: number) => void) => {
        expect(relative).toBe(mockInner);
        mockMeasuredDays.push(heading.props.accessibilityLabel);
        success(0, 640);
      },
    );
  }
}
function dismissMenu() {
  fireEvent(screen.UNSAFE_getByType(Modal), 'dismiss');
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockMeasuredDays.length = 0;
  mockReduced = true;
  mockActions.blocked = false;
  mockToday = '2026-09-30';
  mockQueryState = null;
  mockPlanning = {
    preferences: { weekStart: 'monday', defaultMealSlot: 'dinner' },
    hydrated: true,
    saving: false,
    error: null,
  };
  Object.keys(mockParams).forEach((key) => delete mockParams[key]);
  mockSnapshot = {
    startDate: '2026-09-28',
    endDate: '2026-10-04',
    occurrences: [dinner],
    shoppingScope: {
      scopeId: 'scope',
      revision: 1,
      occurrenceIds: [dinner.occurrenceId, 'outside-week'],
    },
  };
});

test('week preference changes keep the selected civil date and retained snapshot range until the new query arrives', () => {
  const before = JSON.stringify(mockSnapshot);
  const view = showPlan();
  fireEvent.press(screen.getByRole('button', { name: 'View full week' }));
  expect(mockQueryKey).toHaveBeenLastCalledWith('plan:2026-09-28:2026-10-04');
  mockPlanning = {
    ...mockPlanning,
    preferences: { ...mockPlanning.preferences, weekStart: 'sunday' },
  };
  mockQueryState = { kind: 'loading', previous: mockSnapshot };
  view.rerender(<PlanScreen />);
  expect(mockQueryKey).toHaveBeenLastCalledWith('plan:2026-09-27:2026-10-03');
  expect(screen.getAllByRole('header').map((node) => node.props.accessibilityLabel)).toEqual([
    'Monday 28 September 2026',
    'Tuesday 29 September 2026',
    dateLabel,
    'Thursday 1 October 2026',
    'Friday 2 October 2026',
    'Saturday 3 October 2026',
    'Sunday 4 October 2026',
  ]);
  expect(
    screen.getByRole('button', { name: `${dateLabel}, today, 1 planned meal` }),
  ).toBeSelected();
  expect(screen.getByRole('button', { name: optionsLabel })).toBeDisabled();
  expect(JSON.stringify(mockSnapshot)).toBe(before);
  mockSnapshot = { ...mockSnapshot, startDate: '2026-09-27', endDate: '2026-10-03' };
  mockQueryState = null;
  view.rerender(<PlanScreen />);
  expect(screen.getAllByRole('header')[0]!.props.accessibilityLabel).toBe(
    'Sunday 27 September 2026',
  );
  expect(
    screen.getByRole('button', { name: `${dateLabel}, today, 1 planned meal` }),
  ).toBeSelected();
  expect(mockSnapshot.shoppingScope.occurrenceIds).toEqual([dinner.occurrenceId, 'outside-week']);
  expect(mockBegin).not.toHaveBeenCalled();
});

test('partial first weeks with the same start have distinct query keys and correct displayed endpoints', () => {
  mockParams.date = '1900-01-01';
  mockSnapshot = {
    ...mockSnapshot,
    startDate: '1900-01-01',
    endDate: '1900-01-07',
    occurrences: [],
  };
  const view = showPlan();
  expect(mockQueryKey).toHaveBeenLastCalledWith('plan:1900-01-01:1900-01-07');
  mockPlanning = {
    ...mockPlanning,
    preferences: { ...mockPlanning.preferences, weekStart: 'sunday' },
  };
  mockSnapshot = { ...mockSnapshot, endDate: '1900-01-06' };
  view.rerender(<PlanScreen />);
  expect(mockQueryKey).toHaveBeenLastCalledWith('plan:1900-01-01:1900-01-06');
  expect(screen.getByRole('button', { name: 'Monday 1 January 1900' })).toBeSelected();
  expect(screen.queryByRole('button', { name: 'Sunday 7 January 1900' })).toBeNull();
});

test('Today uses a fresh local clock after midnight without changing selection until pressed', () => {
  const view = showPlan();
  mockToday = '2026-10-01';
  view.rerender(<PlanScreen />);
  expect(screen.getByRole('button', { name: `${dateLabel}, 1 planned meal` })).toBeSelected();
  fireEvent.press(
    screen.UNSAFE_getAllByType(ActionButton).find((node) => node.props.label === 'Today')!,
  );
  expect(screen.getByRole('button', { name: 'Thursday 1 October 2026, today' })).toBeSelected();
  expect(mockBegin).not.toHaveBeenCalled();
});
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

test('one real count preserves empty slots without presenting three meals as a target', () => {
  showPlan();
  expect(screen.getByText('1 meal planned')).toBeTruthy();
  expect(screen.queryByText(/of 3|\/3|Planned slots/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Plan breakfast' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Plan lunch' })).toBeEnabled();
  expect(
    screen.getByRole('button', { name: `${dateLabel}, today, 1 planned meal` }),
  ).toBeSelected();
  fireEvent.press(screen.getByRole('button', { name: 'Thursday 1 October 2026' }));
  expect(screen.getByRole('button', { name: 'Thursday 1 October 2026' })).toBeSelected();
  expect(
    screen.getByRole('button', { name: `${dateLabel}, today, 1 planned meal` }),
  ).not.toBeSelected();
  expect(screen.getByText('0 meals planned')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Plan dinner' })).toBeEnabled();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('week mode preserves chronological order and the selected date; explicit jump uses the same scroll view', () => {
  showPlan();
  fireEvent.press(screen.getByRole('button', { name: 'View full week' }));
  expect(screen.getAllByRole('header').map((heading) => heading.props.accessibilityLabel)).toEqual([
    'Monday 28 September 2026',
    'Tuesday 29 September 2026',
    dateLabel,
    'Thursday 1 October 2026',
    'Friday 2 October 2026',
    'Saturday 3 October 2026',
    'Sunday 4 October 2026',
  ]);
  measureHeadings();
  act(() => jest.runOnlyPendingTimers());
  expect(mockMeasuredDays.at(-1)).toBe(dateLabel);
  expect(mockScrollTo).toHaveBeenLastCalledWith({ y: expect.any(Number), animated: false });
  mockScrollTo.mockClear();
  fireEvent.press(screen.getByRole('button', { name: 'Jump to selected day' }));
  act(() => jest.runOnlyPendingTimers());
  expect(mockScrollTo).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole('button', { name: 'View selected day' }));
  expect(screen.getByRole('header', { name: dateLabel })).toBeTruthy();
  expect(
    screen.getByRole('button', { name: `${dateLabel}, today, 1 planned meal` }),
  ).toBeSelected();
  expect(mockSnapshot.shoppingScope.occurrenceIds).toEqual([dinner.occurrenceId, 'outside-week']);
  expect(mockBegin).not.toHaveBeenCalled();
});

test('Today waits for the matching week before scrolling and respects the motion setting', () => {
  mockParams.date = '2026-10-06';
  mockSnapshot = {
    ...mockSnapshot,
    startDate: '2026-10-05',
    endDate: '2026-10-11',
    occurrences: [],
  };
  mockReduced = false;
  const view = showPlan();
  fireEvent.press(screen.getByRole('button', { name: 'Today' }));
  act(() => jest.runOnlyPendingTimers());
  expect(mockScrollTo).not.toHaveBeenCalled();
  mockSnapshot = {
    ...mockSnapshot,
    startDate: '2026-09-28',
    endDate: '2026-10-04',
    occurrences: [dinner],
  };
  view.rerender(<PlanScreen />);
  measureHeadings();
  act(() => jest.runOnlyPendingTimers());
  expect(mockMeasuredDays.at(-1)).toBe(dateLabel);
  expect(mockScrollTo).toHaveBeenLastCalledWith({ y: expect.any(Number), animated: true });
  expect(mockBegin).not.toHaveBeenCalled();
});

test('dismissal returns focus to the exact meal options without a write or navigation', () => {
  showPlan();
  fireEvent.press(screen.getByRole('button', { name: optionsLabel }));
  expect(screen.getByRole('header', { name: 'Dinner options' })).toBeTruthy();
  expect(screen.getAllByText(getRecipe(dinner.recipeId)!.title)).toHaveLength(2);
  mockFocus.mockClear();
  fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(mockFocus).not.toHaveBeenCalled();
  dismissMenu();
  expect(mockFocus).toHaveBeenCalledTimes(1);
  expect(mockFocus.mock.calls[0]?.[0]).toMatchObject({
    props: { accessibilityLabel: optionsLabel },
  });
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockBegin).not.toHaveBeenCalled();
});

test.each(['edit', 'remove'] as const)(
  '%s waits for sheet dismissal and preserves the exact occurrence',
  (action) => {
    showPlan();
    fireEvent.press(screen.getByRole('button', { name: optionsLabel }));
    fireEvent.press(
      screen.getByRole('button', { name: `${action === 'edit' ? 'Edit' : 'Remove'} dinner` }),
    );
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockBegin).not.toHaveBeenCalled();
    dismissMenu();
    if (action === 'edit') {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/plan-edit',
        params: {
          occurrenceId: dinner.occurrenceId,
          recipeId: dinner.recipeId,
          date: dinner.placement.actualDate,
          meal: 'dinner',
        },
      });
      expect(mockBegin).not.toHaveBeenCalled();
    } else {
      expect(mockBegin).toHaveBeenCalledWith(
        { kind: 'removePlan', occurrenceId: dinner.occurrenceId },
        expect.objectContaining({
          confirm: true,
          restoreAfterCommitRemoval: true,
          restoreFocus: expect.any(Function),
        }),
      );
      expect(mockPush).not.toHaveBeenCalled();
    }
  },
);

test('the action sheet keeps the source-photo concern visible', () => {
  mockSnapshot = { ...mockSnapshot, occurrences: [{ ...dinner, recipeId: '53389' }] };
  showPlan();
  fireEvent.press(screen.getByRole('button', { name: optionsLabel }));
  expect(
    screen.getByText('Supplied photo association needs review. See recipe source notes.'),
  ).toBeTruthy();
});
