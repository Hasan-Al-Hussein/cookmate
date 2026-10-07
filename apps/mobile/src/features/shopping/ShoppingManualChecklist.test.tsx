import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import type { ManualShoppingItem, PersonalService, ShoppingSnapshot } from '@cookmate/domain';
import type { usePersonalOperations } from '../personal/usePersonalOperations';
import { ShoppingScreen } from './ShoppingScreen';

const mockDirect = jest.fn();
const mockPush = jest.fn();
const mockPerform = jest.fn(async (dispatch: (id: string) => Promise<unknown>) => {
  await dispatch('test-manual-operation');
  return true;
});
const mockOperation: ReturnType<typeof usePersonalOperations> = {
  ready: true,
  busy: false,
  error: null,
  storageError: null,
  receipt: null,
  references: [],
  perform: mockPerform,
  recover: jest.fn(),
};
const mockManual = {
  readManualShopping: jest.fn(),
  subscribe: jest.fn(() => () => undefined),
  execute: jest.fn().mockResolvedValue({ kind: 'ready' }),
} as unknown as jest.Mocked<PersonalService>;
const mockServices = { personal: mockManual, queries: { readInstallationId: jest.fn() } };
const mockSnapshot: ShoppingSnapshot = {
  scope: { scopeId: 'scope', revision: 1, occurrenceIds: [] },
  selectedOccurrences: [],
  groups: [],
  projectionRevision: 1,
  status: 'current',
};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
jest.mock('../personal/usePersonalOperations', () => ({
  // This test checks UI dispatch composition. Durable receipt/recovery is exercised by personalFlow.
  usePersonalOperations: () => mockOperation,
}));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    availability: {
      kind: 'ready',
      services: mockServices,
    },
    actions: { blocked: false, begin: mockDirect, restoreAfterRemoval: jest.fn() },
    restoreScreenFocus: jest.fn(),
    clock: { dateContext: () => ({ localDate: '2026-09-30' }) },
  }),
  useWorkspaceQuery: () => ({
    state: { kind: 'ready', value: mockSnapshot, revision: 1 },
    retry: jest.fn(),
  }),
}));

beforeEach(() => {
  Object.assign(mockOperation, {
    ready: true,
    busy: false,
    error: null,
    storageError: null,
    receipt: null,
    references: [],
  });
  mockPerform.mockImplementation(async (dispatch) => {
    await dispatch('test-manual-operation');
    return true;
  });
  mockSnapshot.groups = [];
  mockManual.readManualShopping.mockReset();
  mockManual.execute.mockReset().mockImplementation(async (command) => ({
    kind: 'ready',
    revision: 9,
    value: {
      operationId: command.operationId,
      commandKind: command.kind,
      outcome: 'committed',
      entityId: null,
      revision: 9,
      epoch: 2,
      committedAt: '2026-10-01T00:00:00Z',
      affectedMemberships: 0,
    },
  }));
});

afterEach(() => jest.restoreAllMocks());

test.each(['committed', 'no_op'] as const)(
  'manual %s save/reference cleanup and delayed reload keep the last confirmed row without transient feedback or early success',
  async (outcome) => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const item: ManualShoppingItem = {
      kind: 'manual',
      itemId: 'own-salt',
      name: 'Salt',
      amountText: 'one box',
      unitText: null,
      category: 'other',
      purchased: false,
      deleted: false,
      revision: 8,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };
    const initial = {
      kind: 'ready' as const,
      revision: 8,
      value: { epoch: 2, total: 1, items: [item], nextCursor: null },
    };
    mockManual.readManualShopping.mockResolvedValueOnce(initial);
    let finishRead!: (value: typeof initial) => void;
    mockManual.readManualShopping.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    let finishSave!: () => void;
    mockPerform.mockImplementation(async (dispatch) => {
      mockOperation.busy = true;
      mockOperation.ready = false;
      mockOperation.references = [
        { operationId: 'test-manual-operation', createdAt: item.createdAt },
      ];
      await dispatch('test-manual-operation');
      await new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      return true;
    });
    const view = render(<ShoppingScreen header={null} />);
    await screen.findByRole('tab', { name: 'To buy 1' });
    fireEvent.press(screen.getByRole('tab', { name: 'To buy 1' }));
    const row = screen.getByRole('checkbox');
    fireEvent.press(row);
    await waitFor(() => expect(mockManual.execute).toHaveBeenCalledTimes(1));
    expect(row).toBeDisabled();
    expect(row).not.toBeChecked();
    expect(screen.queryByText('Checking your local change…')).toBeNull();
    expect(screen.queryByText('Unconfirmed personal change')).toBeNull();
    expect(screen.queryByText('Purchase changes are temporarily unavailable.')).toBeNull();
    expect(announce).not.toHaveBeenCalled();
    mockOperation.receipt = {
      operationId: 'test-manual-operation',
      commandKind: 'setManualPurchased',
      outcome,
      entityId: item.itemId,
      revision: 9,
      epoch: 2,
      committedAt: item.updatedAt,
      affectedMemberships: 0,
    };
    view.rerender(<ShoppingScreen header={null} />);
    expect(announce).not.toHaveBeenCalled();
    expect(screen.queryByText('Local change saved')).toBeNull();
    await act(async () => {
      mockOperation.references = [];
      mockOperation.busy = false;
      mockOperation.ready = true;
      finishSave();
    });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Salt marked purchased.');
    expect(screen.getByRole('checkbox') === row).toBe(true);
    expect(row).toBeDisabled();
    expect(row).not.toBeChecked();
    expect(screen.getByRole('tab', { name: 'To buy 1' })).toBeTruthy();
    expect(screen.queryByText('Loading your own items…')).toBeNull();
    expect(screen.queryByText('Updating your own items…')).toBeNull();
    expect(screen.getByText('Choose meals to make your list')).toBeTruthy();
    await act(async () =>
      finishRead({
        ...initial,
        revision: 9,
        value: { ...initial.value, items: [{ ...item, purchased: true, revision: 9 }] },
      }),
    );
    expect(screen.getByRole('checkbox') === row).toBe(true);
    expect(row).toBeChecked();
    expect(row).not.toBeDisabled();
    expect(screen.getByRole('tab', { name: 'To buy 0' })).toBeTruthy();
    expect(announce).toHaveBeenCalledTimes(1);
  },
);

test.each(['mismatched', 'cancelled', 'uncertain'] as const)(
  'manual %s result never announces a confirmed purchase',
  async (state) => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const item: ManualShoppingItem = {
      kind: 'manual',
      itemId: 'own-salt',
      name: 'Salt',
      amountText: 'one box',
      unitText: null,
      category: 'other',
      purchased: false,
      deleted: false,
      revision: 8,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };
    mockManual.readManualShopping.mockResolvedValue({
      kind: 'ready',
      revision: 8,
      value: { epoch: 2, total: 1, items: [item], nextCursor: null },
    });
    mockPerform.mockImplementation(async (dispatch) => {
      await dispatch('test-manual-operation');
      mockOperation.receipt = {
        operationId: state === 'mismatched' ? 'another-operation' : 'test-manual-operation',
        commandKind: 'setManualPurchased',
        outcome: state === 'cancelled' ? 'cancelled' : 'committed',
        entityId: item.itemId,
        revision: 9,
        epoch: 2,
        committedAt: item.updatedAt,
        affectedMemberships: 0,
      };
      if (state === 'uncertain') {
        mockOperation.error = 'Recovery cleanup is unconfirmed.';
        mockOperation.references = [
          { operationId: 'test-manual-operation', createdAt: item.createdAt },
        ];
      }
      return false;
    });
    render(<ShoppingScreen header={null} />);
    const row = await screen.findByRole('checkbox');
    await act(async () => fireEvent.press(row));
    expect(mockManual.execute).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
    expect(row).not.toBeChecked();
    if (state === 'cancelled') expect(screen.getByText('Earlier request cancelled')).toBeTruthy();
    if (state === 'uncertain') expect(screen.getByText('Unconfirmed personal change')).toBeTruthy();
  },
);

test('search reaches manual page two and dispatches its own item/epoch/revision, never a recipe purchase', async () => {
  const items: ManualShoppingItem[] = Array.from({ length: 51 }, (_, index) => ({
    kind: 'manual',
    itemId: `manual-${index}`,
    name: index === 50 ? 'Kitchen towels' : `Own item ${index}`,
    amountText: index === 50 ? 'two large' : null,
    unitText: null,
    category: 'other',
    purchased: false,
    deleted: false,
    revision: 8,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  }));
  mockManual.readManualShopping.mockImplementation(async (input) => ({
    kind: 'ready',
    revision: 7,
    value: {
      epoch: 2,
      total: 51,
      items: input?.cursor ? items.slice(50) : items.slice(0, 50),
      nextCursor: input?.cursor ? null : 'last-page',
    },
  }));
  render(<ShoppingScreen header={null} />);
  fireEvent.changeText(screen.getByLabelText('Find a shopping item'), 'towels');
  const target = await screen.findByRole('checkbox', {
    name: 'Purchased Kitchen towels, two large',
  });
  expect(mockManual.readManualShopping.mock.calls.slice(0, 2)).toEqual([
    [{ limit: 50 }],
    [{ limit: 50, cursor: 'last-page' }],
  ]);
  fireEvent.press(target);
  await waitFor(() =>
    expect(mockManual.execute).toHaveBeenCalledWith({
      kind: 'setManualPurchased',
      operationId: 'test-manual-operation',
      expectedEpoch: 2,
      itemId: 'manual-50',
      expectedRevision: 8,
      purchased: true,
    }),
  );
  expect(mockDirect).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/manual-shopping', params: { create: '1' } });
});

test('pending and failed manual reads cannot produce whole-list totals or an all-purchased claim', async () => {
  mockSnapshot.groups = [
    {
      groupKey: 'salt',
      displayName: 'Salt',
      quantityLabel: '10 g',
      contributions: [],
      demandFingerprint: 'salt-current',
      purchased: true,
      changed: false,
      revision: 1,
    },
  ];
  let rejectRead!: (error: Error) => void;
  mockManual.readManualShopping.mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectRead = reject;
    }),
  );
  render(<ShoppingScreen header={null} />);
  fireEvent.press(screen.getByRole('tab', { name: 'To buy' }));
  expect(screen.queryByRole('tab', { name: 'To buy 0' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'Purchased' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'All' })).toBeTruthy();
  expect(screen.queryByText('Everything on this list is purchased')).toBeNull();
  expect(screen.getByText('No items in this loaded view')).toBeTruthy();
  await act(async () => rejectRead(new Error('Synthetic unavailable manual store')));
  expect(await screen.findByText('Manual items need attention')).toBeTruthy();
  expect(screen.queryByText('Everything on this list is purchased')).toBeNull();
  expect(screen.queryByRole('tab', { name: 'All 1' })).toBeNull();
  fireEvent.changeText(screen.getByLabelText('Find a shopping item'), 'towels');
  expect(
    screen.getByText('0 matching items in the loaded list · manual items not current'),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Clear shopping search' }));
  mockManual.readManualShopping.mockResolvedValueOnce({
    kind: 'ready',
    revision: 7,
    value: { epoch: 2, total: 0, items: [], nextCursor: null },
  });
  fireEvent.press(screen.getByRole('button', { name: 'Retry manual items' }));
  expect(await screen.findByRole('tab', { name: 'To buy 0' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Purchased 1' })).toBeTruthy();
  expect(screen.getByText('Everything on this list is purchased')).toBeTruthy();
  expect(mockDirect).not.toHaveBeenCalled();
  expect(mockManual.execute).not.toHaveBeenCalled();
});

test('a manual row remains available for undo in To buy and each command uses the latest saved revision', async () => {
  let item: ManualShoppingItem = {
    kind: 'manual',
    itemId: 'own-salt',
    name: 'Salt',
    amountText: 'one box',
    unitText: null,
    category: 'other',
    purchased: false,
    deleted: false,
    revision: 8,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  mockManual.readManualShopping.mockImplementation(async () => ({
    kind: 'ready',
    revision: item.revision,
    value: { epoch: 2, total: 1, items: [item], nextCursor: null },
  }));
  mockManual.execute.mockImplementation(async (command) => {
    if (command.kind === 'setManualPurchased')
      item = { ...item, purchased: command.purchased, revision: item.revision + 1 };
    return {
      kind: 'ready',
      revision: item.revision,
      value: {
        operationId: command.operationId,
        outcome: 'committed',
        commandKind: 'setManualPurchased',
        entityId: item.itemId,
        revision: item.revision,
        epoch: 2,
        committedAt: '2026-10-01T00:00:00Z',
        affectedMemberships: 0,
      },
    };
  });
  render(<ShoppingScreen header={null} />);
  await screen.findByRole('tab', { name: 'To buy 1' });
  fireEvent.press(screen.getByRole('tab', { name: 'To buy 1' }));
  const first = screen.getByRole('checkbox', { name: 'Purchased Salt, one box' });
  fireEvent.press(first);
  await waitFor(() => {
    expect(screen.getByRole('checkbox', { name: 'Purchased Salt, one box' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Purchased Salt, one box' })).not.toBeDisabled();
  });
  expect(screen.getByRole('checkbox', { name: 'Purchased Salt, one box' }) === first).toBe(true);
  expect(first).toBeChecked();
  expect(screen.getByRole('tab', { name: 'To buy 0' })).toBeTruthy();
  expect(mockManual.execute).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'setManualPurchased',
      itemId: 'own-salt',
      expectedEpoch: 2,
      expectedRevision: 8,
      purchased: true,
    }),
  );
  fireEvent.press(first);
  await waitFor(() => expect(first).not.toBeChecked());
  expect(mockManual.execute).toHaveBeenLastCalledWith(
    expect.objectContaining({
      kind: 'setManualPurchased',
      itemId: 'own-salt',
      expectedEpoch: 2,
      expectedRevision: 9,
      purchased: false,
    }),
  );
  expect(mockDirect).not.toHaveBeenCalled();
});
