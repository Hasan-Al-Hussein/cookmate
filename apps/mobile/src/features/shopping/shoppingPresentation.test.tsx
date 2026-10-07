import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Modal } from 'react-native';
import type { ShoppingSnapshot } from '@cookmate/domain';
import type { QueryState } from '../workspace/WorkspaceProvider';
import { ShoppingScreen } from './ShoppingScreen';

const mockBegin = jest.fn();
const mockPush = jest.fn();
const mockRestoreScreenFocus = jest.fn();
const mockFocusLabels: string[] = [];
let mockOnFocus: (() => void | (() => void)) | undefined;
let mockSnapshot: ShoppingSnapshot;
let mockQueryOverride: QueryState<ShoppingSnapshot> | null = null;
let mockBlocked = false;
const mockServices = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    mockOnFocus = callback;
    require('react').useEffect(callback, [callback]);
  },
}));
jest.mock('../../components/focusTarget', () => ({
  focusTarget: (target: { props?: { accessibilityLabel?: string } } | null) => {
    if (!target) return false;
    mockFocusLabels.push(target.props?.accessibilityLabel ?? 'Unnamed focus target');
    return true;
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    availability: { kind: 'ready', services: mockServices },
    actions: { blocked: mockBlocked, begin: mockBegin, restoreAfterRemoval: jest.fn() },
    restoreScreenFocus: mockRestoreScreenFocus,
    clock: { dateContext: () => ({ localDate: '2026-09-30' }) },
  }),
  useWorkspaceQuery: () => ({
    state: mockQueryOverride ?? { kind: 'ready', value: mockSnapshot, revision: 1 },
    retry: jest.fn(),
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockFocusLabels.length = 0;
  mockOnFocus = undefined;
  mockQueryOverride = null;
  mockBlocked = false;
  mockSnapshot = {
    scope: { scopeId: 'scope', revision: 1, occurrenceIds: ['meal-a', 'meal-b'] },
    selectedOccurrences: [
      {
        occurrenceId: 'meal-a',
        recipeId: '52839',
        revision: 1,
        createdAt: '2026-09-30T08:00:00Z',
        updatedAt: '2026-09-30T08:00:00Z',
        placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
      },
      {
        occurrenceId: 'meal-b',
        recipeId: '52839',
        revision: 1,
        createdAt: '2026-09-30T08:00:00Z',
        updatedAt: '2026-09-30T08:00:00Z',
        placement: { actualDate: '2026-10-08', mealKey: 'lunch' },
      },
    ],
    projectionRevision: 1,
    status: 'current',
    groups: [
      {
        groupKey: 'salt-grams',
        displayName: 'Salt',
        quantityLabel: '10 g',
        contributions: [],
        demandFingerprint: 'a',
        purchased: false,
        changed: true,
        revision: 1,
      },
      {
        groupKey: 'salt-unknown',
        displayName: 'Salt',
        quantityLabel: 'Amount not supplied',
        contributions: [],
        demandFingerprint: 'b',
        purchased: true,
        changed: false,
        revision: 1,
      },
    ],
  };
});

test('an in-flight recipe purchase and healthy reload add no row or header feedback, while read failures remain visible', () => {
  const view = render(<ShoppingScreen header={null} />);
  fireEvent.press(screen.getByRole('tab', { name: 'To buy 1' }));
  const row = screen.getByRole('checkbox');
  fireEvent.press(row);
  mockBlocked = true;
  view.rerender(<ShoppingScreen header={null} />);
  expect(screen.getByRole('checkbox') === row).toBe(true);
  expect(row).toBeDisabled();
  expect(row).not.toBeChecked();
  expect(screen.queryByText('Purchase changes are temporarily unavailable.')).toBeNull();
  mockQueryOverride = { kind: 'loading', previous: mockSnapshot };
  view.rerender(<ShoppingScreen header={null} />);
  expect(screen.getByRole('checkbox') === row).toBe(true);
  expect(screen.getByRole('tab', { name: 'To buy 1' })).toBeTruthy();
  expect(screen.queryByText('Loading shopping list…')).toBeNull();
  expect(screen.queryByText(/The previous view is shown below/)).toBeNull();
  mockQueryOverride = {
    kind: 'failed',
    previous: mockSnapshot,
    error: { code: 'storage_failure', messageKey: 'test', retry: 'never' },
  };
  view.rerender(<ShoppingScreen header={null} />);
  expect(screen.getByText('Couldn’t load shopping list')).toBeTruthy();
  expect(screen.getByText(/The previous view is shown below/)).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'To buy 1' })).toBeNull();
  expect(row).toBeDisabled();
});

test('healthy reload keeps the last confirmed empty-meal guidance in place and blocks its action', () => {
  mockSnapshot = {
    ...mockSnapshot,
    scope: { ...mockSnapshot.scope, occurrenceIds: [] },
    selectedOccurrences: [],
  };
  const view = render(<ShoppingScreen header={null} />);
  const guidance = screen.getByText('Choose meals to make your list');
  mockQueryOverride = { kind: 'loading', previous: mockSnapshot };
  view.rerender(<ShoppingScreen header={null} />);
  expect(screen.getByText('Choose meals to make your list') === guidance).toBe(true);
  expect(screen.getByRole('button', { name: 'Choose shopping meals' })).toBeDisabled();
});

test('shopping reports actual groups and cross-week selections without hiding changed or missing amounts', () => {
  render(<ShoppingScreen header={null} weekDate="2026-09-30" />);
  expect(screen.getByText('To buy 1')).toBeTruthy();
  expect(screen.getByText('Purchased 1')).toBeTruthy();
  expect(screen.getByText('2 meals selected · 1 outside this week')).toBeTruthy();
  expect(screen.getByText('Changed — review')).toBeTruthy();
  expect(screen.getByText('Amount not supplied')).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Show 2 selected meals' }));
  expect(screen.getByText('Outside displayed week')).toBeTruthy();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('source disclosure never purchases; purchase uses the observed demand and rows retain order', () => {
  const view = render(<ShoppingScreen header={null} weekDate="2026-09-30" />);
  fireEvent.press(screen.getAllByRole('button', { name: 'Show sources for Salt' })[0]!);
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  fireEvent.press(screen.getByRole('checkbox', { name: 'Purchased Salt, 10 g, changed, review' }));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'setPurchased', groupKey: 'salt-grams', purchased: true },
    expect.objectContaining({ observedDemandFingerprint: 'a' }),
  );
  mockSnapshot = {
    ...mockSnapshot,
    groups: mockSnapshot.groups.map((group) =>
      group.groupKey === 'salt-grams' ? { ...group, purchased: true } : group,
    ),
  };
  view.rerender(<ShoppingScreen header={null} weekDate="2026-09-30" />);
  expect(screen.getByText('To buy 0')).toBeTruthy();
  expect(screen.getByText('Purchased 2')).toBeTruthy();
  expect(screen.getAllByRole('checkbox').map((row) => row.props.accessibilityLabel)).toEqual([
    'Purchased Salt, 10 g, changed, review',
    'Purchased Salt, Amount not supplied',
  ]);
});

test.each(['to_buy', 'purchased'] as const)(
  '%s keeps the same checkbox after a committed toggle and allows an exact second toggle',
  (filter) => {
    const initial = filter === 'purchased';
    mockSnapshot.groups = [
      { ...mockSnapshot.groups[0]!, purchased: initial },
      { ...mockSnapshot.groups[1]!, purchased: initial },
    ];
    const view = render(<ShoppingScreen header={null} weekDate="2026-09-30" />);
    const label = initial ? 'Purchased' : 'To buy';
    fireEvent.press(screen.getByRole('tab', { name: `${label} 2` }));
    const before = screen.getAllByRole('checkbox');
    const first = before[0]!;
    fireEvent.press(first);
    expect(mockBegin).toHaveBeenLastCalledWith(
      { kind: 'setPurchased', groupKey: 'salt-grams', purchased: !initial },
      expect.objectContaining({ observedDemandFingerprint: 'a' }),
    );
    mockSnapshot = {
      ...mockSnapshot,
      groups: [
        { ...mockSnapshot.groups[0]!, purchased: !initial, revision: 2 },
        mockSnapshot.groups[1]!,
      ],
    };
    view.rerender(<ShoppingScreen header={null} weekDate="2026-09-30" />);
    expect(screen.getAllByRole('checkbox')[0] === before[0]).toBe(true);
    expect(screen.getAllByRole('checkbox')[1] === before[1]).toBe(true);
    expect(first.props.accessibilityState.checked).toBe(!initial);
    expect(first).not.toBeDisabled();
    expect(screen.getByRole('tab', { name: `${label} 1` })).toBeTruthy();
    expect(
      screen.getByText(`Changed items stay here. Tap ${label} again to refresh.`),
    ).toBeTruthy();
    fireEvent.press(first);
    expect(mockBegin).toHaveBeenLastCalledWith(
      { kind: 'setPurchased', groupKey: 'salt-grams', purchased: initial },
      expect.objectContaining({ observedDemandFingerprint: 'a' }),
    );
    fireEvent.press(screen.getByRole('tab', { name: `${label} 1` }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getAllByRole('checkbox')[0] === before[1]).toBe(true);
  },
);

test('ingredient conflicts remain visible with the checklist before any source disclosure is opened', () => {
  mockSnapshot = {
    ...mockSnapshot,
    selectedOccurrences: [{ ...mockSnapshot.selectedOccurrences[0]!, recipeId: '52982' }],
    scope: { scopeId: 'scope', revision: 1, occurrenceIds: ['meal-a'] },
    groups: [
      {
        ...mockSnapshot.groups[0]!,
        displayName: 'Spaghetti',
        quantityLabel: '320 g',
        contributions: [
          {
            contributionId: 'carbonara-pasta',
            occurrenceId: 'meal-a',
            recipeId: '52982',
            source: { recipeId: '52982', section: 'ingredient', position: 1 },
            rawName: 'Spaghetti',
            rawMeasure: '320g',
            quantity: { kind: 'exact', numerator: '320', denominator: '1', unit: 'g' },
          },
        ],
      },
    ],
  };
  render(<ShoppingScreen header={null} weekDate="2026-09-30" />);
  expect(screen.getByText(/ingredient list and method conflict/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Show sources for Spaghetti' })).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Read 1 recipe note' }));
  expect(
    screen.getByText(/the list gives 320g spaghetti, 6 egg yolks and 150g bacon/),
  ).toBeTruthy();
  expect(screen.getByText('Recipe source notes')).toBeTruthy();
  const modal = screen.UNSAFE_getAllByType(Modal).find((node) => node.props.visible)!;
  fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(mockFocusLabels).toEqual([]);
  fireEvent(modal, 'dismiss');
  expect(mockFocusLabels).toEqual(['Read 1 recipe note']);
  act(() => {
    mockOnFocus?.();
  });
  expect(mockFocusLabels).toEqual(['Read 1 recipe note']);
  expect(
    screen.queryByText(/the list gives 320g spaghetti, 6 egg yolks and 150g bacon/),
  ).toBeNull();
  expect(screen.getByText(/ingredient list and method conflict/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Read 1 recipe note' })).not.toBeExpanded();
  expect(mockBegin).not.toHaveBeenCalled();
});

test.each(['notes', 'contributions'] as const)(
  'returning from %s recipe source focuses its exact trigger once and keeps checklist state',
  async (origin) => {
    mockSnapshot = {
      ...mockSnapshot,
      selectedOccurrences: [{ ...mockSnapshot.selectedOccurrences[0]!, recipeId: '52982' }],
      scope: { scopeId: 'scope', revision: 1, occurrenceIds: ['meal-a'] },
      groups: [
        {
          ...mockSnapshot.groups[0]!,
          displayName: 'Spaghetti',
          quantityLabel: '320 g',
          contributions: [
            {
              contributionId: 'carbonara-pasta',
              occurrenceId: 'meal-a',
              recipeId: '52982',
              source: { recipeId: '52982', section: 'ingredient', position: 1 },
              rawName: 'Spaghetti',
              rawMeasure: '320g',
              quantity: { kind: 'exact', numerator: '320', denominator: '1', unit: 'g' },
            },
          ],
        },
      ],
    };
    render(<ShoppingScreen header={null} weekDate="2026-09-30" />);
    fireEvent.changeText(screen.getByLabelText('Find a shopping item'), 'Spaghetti');
    const trigger = origin === 'notes' ? 'Read 1 recipe note' : 'Show sources for Spaghetti';
    fireEvent.press(screen.getByRole('button', { name: trigger }));
    const modal = screen.UNSAFE_getAllByType(Modal).find((node) => node.props.visible)!;
    fireEvent.press(
      screen.getByRole('button', {
        name:
          origin === 'notes'
            ? 'Open source notes for Spaghetti alla Carbonara'
            : 'Open recipe source',
      }),
    );
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockFocusLabels).toEqual([]);
    fireEvent(modal, 'dismiss');
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/recipe/[id]',
      params: { id: '52982', section: 'source' },
    });
    expect(mockFocusLabels).toEqual([]);
    act(() => {
      mockOnFocus?.();
    });
    await waitFor(() => expect(mockFocusLabels).toEqual([trigger]));
    expect(screen.getByLabelText('Find a shopping item')).toHaveProp('value', 'Spaghetti');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByText('1 meal selected')).toBeTruthy();
    act(() => {
      mockOnFocus?.();
    });
    expect(mockFocusLabels).toEqual([trigger]);
    expect(mockRestoreScreenFocus).not.toHaveBeenCalled();
    expect(mockBegin).not.toHaveBeenCalled();
  },
);

test('ingredient sources preserve every contribution and amount warning with one recipe link', () => {
  mockSnapshot = {
    ...mockSnapshot,
    groups: [
      {
        ...mockSnapshot.groups[0]!,
        contributions: mockSnapshot.selectedOccurrences.map((meal, index) => ({
          contributionId: `salt-${index}`,
          occurrenceId: meal.occurrenceId,
          recipeId: meal.recipeId,
          source: { recipeId: meal.recipeId, section: 'ingredient', position: index + 1 },
          rawName: 'Salt',
          rawMeasure: index === 0 ? '2 tsp' : null,
          quantity: { kind: index === 0 ? 'review_source' : 'unknown' },
        })),
      },
    ],
  };
  render(<ShoppingScreen header={null} weekDate="2026-09-30" />);
  expect(screen.getByText('This amount needs recipe-source review.')).toBeTruthy();
  const sourceButton = screen.getByRole('button', { name: 'Show sources for Salt' });
  expect(sourceButton).toBeTruthy();
  fireEvent.press(sourceButton);
  expect(screen.getByText('Salt · 2 tsp')).toBeTruthy();
  expect(screen.getByText('Salt · Amount not supplied')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Open recipe source' })).toHaveLength(1);
  const modal = screen.UNSAFE_getAllByType(Modal).find((node) => node.props.visible)!;
  fireEvent.press(screen.getByRole('button', { name: 'Open recipe source' }));
  expect(mockPush).not.toHaveBeenCalled();
  fireEvent(modal, 'dismiss');
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/recipe/[id]',
    params: { id: '52839', section: 'source' },
  });
  expect(screen.queryByText('Salt · 2 tsp')).toBeNull();
  expect(screen.getByText('This amount needs recipe-source review.')).toBeTruthy();
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(mockBegin).not.toHaveBeenCalled();
});

test('local find and status filtering preserve separate same-name purchase identities', () => {
  render(<ShoppingScreen header={null} weekDate="2026-09-30" />);
  fireEvent.changeText(screen.getByLabelText('Find a shopping item'), ' SALT ');
  expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  fireEvent.press(screen.getByRole('tab', { name: 'Purchased 1' }));
  expect(screen.getAllByRole('checkbox')).toHaveLength(1);
  expect(screen.getByRole('checkbox')).toHaveProp(
    'accessibilityLabel',
    'Purchased Salt, Amount not supplied',
  );
  fireEvent.press(screen.getByRole('checkbox'));
  expect(mockBegin).toHaveBeenCalledWith(
    { kind: 'setPurchased', groupKey: 'salt-unknown', purchased: false },
    expect.objectContaining({ observedDemandFingerprint: 'b' }),
  );
  fireEvent.changeText(screen.getByLabelText('Find a shopping item'), 'missing ingredient');
  expect(screen.getByText('No matching items')).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Clear shopping search' }));
  expect(screen.getByRole('tab', { name: 'Purchased 1' })).toBeSelected();
});

test('focusing, typing and clearing retain the same shopping input instance', () => {
  render(<ShoppingScreen header={null} weekDate="2026-09-30" />);
  const input = screen.getByLabelText('Find a shopping item');
  fireEvent(input, 'focus');
  expect(screen.getByLabelText('Find a shopping item')).toBe(input);
  fireEvent.changeText(input, 'salt');
  expect(screen.getByLabelText('Find a shopping item')).toBe(input);
  expect(input).toHaveProp('value', 'salt');
  fireEvent.press(screen.getByRole('button', { name: 'Clear shopping search' }));
  expect(screen.getByLabelText('Find a shopping item')).toBe(input);
  expect(input).toHaveProp('value', '');
  fireEvent(input, 'blur');
  expect(screen.getByLabelText('Find a shopping item')).toBe(input);
});
