import { StrictMode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react-native';
import type {
  Immutable,
  ManualShoppingItem,
  PersonalChange,
  PersonalReceipt,
  RepositoryResult,
} from '@cookmate/domain';
import type { ContentWorkspaceHost, ContentWorkspaceState } from '../content/contentWorkspaceHost';
import type { ContentShoppingSnapshot } from '../../data/contentWorkspaceQueries';
import { IconButton } from '../../components/Icon';
import { ActionButton } from '../../components/Controls';
import { PurchaseRow } from '../shopping/PurchaseRow';
import { ShoppingScreen } from '../shopping/ShoppingScreen';
import ManualShoppingScreen from './ManualShoppingScreen';
import { usePersonalPorts } from './PersonalUI';

type ManualHost = Pick<
  ContentWorkspaceHost,
  'manual' | 'readInstallationId' | 'getSnapshot' | 'subscribe'
> & { queries: Pick<ContentWorkspaceHost['queries'], 'readShopping'> };
const mockPush = jest.fn(),
  mockConfirm = jest.fn(),
  mockBegin = jest.fn();
const mockStorage = new Map<string, string>();
let mockId = 0,
  mockWriteGate: Promise<void> | null = null;
let mockRuntime: { host: ManualHost } | null = null;
let mockParams: { create?: string; item?: string } = {};
let mockShopping: ContentShoppingSnapshot;
let mockShoppingRevision = 4;
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => `a0000000-0000-4000-8000-${String(++mockId).padStart(12, '0')}`,
}));
jest.mock('../../hooks/useUnsavedDraft', () => ({ useUnsavedDraft: jest.fn() }));
jest.mock('../../components/confirmAction', () => ({
  confirmAction: (value: unknown) => mockConfirm(value),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../content/ordinaryContentRuntimeContext', () => ({
  useOrdinaryContentRuntime: () => mockRuntime,
}));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    workspaceKey: 'legacy',
    availability: { kind: 'ready', services: {} },
    registerFocusFallback: () => () => undefined,
  }),
}));
jest.mock('../content/useOrdinaryWorkspace', () => ({
  useOrdinaryWorkspaceActions: () => ({
    mode: 'content',
    scopeKey: mockRuntime?.host.getSnapshot().scopeKey ?? 'gone',
    actions: { blocked: false, begin: mockBegin, restoreAfterRemoval: jest.fn() },
    clock: { dateContext: () => ({ localDate: '2026-10-01' }) },
    restoreScreenFocus: jest.fn(),
    registerFocusFallback: () => () => undefined,
  }),
  useOrdinaryShoppingQuery: () => ({
    mode: 'content',
    state: { kind: 'ready', revision: mockShoppingRevision, value: mockShopping },
    retry: jest.fn(),
  }),
}));
jest.mock('./manualReferenceStorage', () => {
  const { createPersonalReferenceStore } =
    jest.requireActual<typeof import('./personalReferences')>('./personalReferences');
  return {
    manualReferenceStore: createPersonalReferenceStore({
      read: async (key) => mockStorage.get(`content-manual:${key}`) ?? null,
      write: async (key, value) => {
        if (mockWriteGate) await mockWriteGate;
        mockStorage.set(`content-manual:${key}`, value);
      },
    }),
  };
});
const installation = 'e0000000-0000-4000-8000-000000000001',
  itemId = 'b0000000-0000-4000-8000-000000000001',
  timestamp = '2026-10-01T08:00:00.000Z';
const recoveryKey = `content-manual:cookmate.personal-recovery.${installation}`;
const ready = <T,>(value: T): RepositoryResult<T> => ({ kind: 'ready', revision: 4, value });
const failure = {
  code: 'storage_failure' as const,
  messageKey: 'fixture.failure',
  retry: 'never' as const,
};
const port = <Fn extends (...args: never[]) => unknown>() =>
  jest.fn<ReturnType<Fn>, Parameters<Fn>>();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function original(): Immutable<ManualShoppingItem> {
  return {
    kind: 'manual',
    itemId,
    name: 'Private lemons',
    amountText: '2',
    unitText: 'bags',
    category: 'produce',
    purchased: false,
    deleted: false,
    revision: 4,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockStorage.clear();
  mockId = 0;
  mockWriteGate = null;
  mockRuntime = null;
  mockParams = {};
  mockShoppingRevision = 4;
  mockShopping = {
    kind: 'current',
    snapshot: {
      scope: { scopeId: 'scope', revision: 1, occurrenceIds: [] },
      selectedOccurrences: [],
      projectionRevision: 1,
      status: 'current',
      groups: [
        {
          groupKey: 'recipe-lemons',
          displayName: 'Lemons',
          quantityLabel: '3 pieces',
          contributions: [],
          demandFingerprint: 'exact',
          purchased: false,
          changed: false,
          revision: 1,
        },
      ],
    },
    selected: [],
    notices: [],
    share: { kind: 'ready', recipes: [] },
  };
});
afterEach(cleanup);
/** Controlled UI host; durable SQLite admission and signed delivery are tested separately. */
function fixture(initial: readonly Immutable<ManualShoppingItem>[] = [original()]) {
  let items = [...initial],
    revision = 4;
  let state: ContentWorkspaceState = {
    status: 'ready',
    scopeKey: 'content:1',
    pending: null,
    cleanupPending: 0,
  };
  const listeners = new Set<() => void>(),
    changes = new Set<(change: PersonalChange) => void>(),
    receipts = new Map<string, Immutable<PersonalReceipt>>();
  const manual = {
    readState: port<ManualHost['manual']['readState']>(),
    readManualShopping: port<ManualHost['manual']['readManualShopping']>(),
    execute: port<ManualHost['manual']['execute']>(),
    readReceipt: port<ManualHost['manual']['readReceipt']>(),
    resolveOperation: port<ManualHost['manual']['resolveOperation']>(),
    subscribe: (listener: (change: PersonalChange) => void) => {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
  } satisfies ManualHost['manual'];
  manual.readState.mockImplementation(async () => ({
    kind: 'ready',
    revision,
    value: { revision, epoch: 1 },
  }));
  manual.readManualShopping.mockImplementation(async () => ({
    kind: 'ready',
    revision,
    value: { epoch: 1, total: items.length, items: [...items], nextCursor: null },
  }));
  manual.readReceipt.mockImplementation(async (id) => ready(receipts.get(id) ?? null));
  manual.resolveOperation.mockImplementation(async (id) =>
    ready(
      receipts.get(id) ?? {
        operationId: id,
        commandKind: null,
        outcome: 'cancelled',
        entityId: null,
        revision,
        epoch: 1,
        committedAt: timestamp,
        affectedMemberships: 0,
      },
    ),
  );
  const commit = (command: Parameters<ManualHost['manual']['execute']>[0], notify = true) => {
    revision++;
    mockShoppingRevision = revision;
    if (command.kind === 'addManualItem')
      items.push({
        kind: 'manual',
        itemId: command.itemId,
        ...command.fields,
        purchased: false,
        deleted: false,
        revision,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    else if (command.kind === 'deleteManualItem')
      items = items.filter((item) => item.itemId !== command.itemId);
    else
      items = items.map((item) =>
        item.itemId !== command.itemId
          ? item
          : command.kind === 'setManualPurchased'
            ? { ...item, purchased: command.purchased, revision }
            : { ...item, ...command.fields, purchased: false, revision },
      );
    const receipt: Immutable<PersonalReceipt> = {
      operationId: command.operationId,
      commandKind: command.kind,
      outcome: 'committed',
      entityId: command.itemId,
      revision,
      epoch: 1,
      committedAt: timestamp,
      affectedMemberships: 0,
    };
    receipts.set(command.operationId, receipt);
    if (notify)
      changes.forEach((listener) =>
        listener({ revision, notes: false, collections: false, manualShopping: true }),
      );
    return ready(receipt);
  };
  manual.execute.mockImplementation(async (command) => commit(command));
  const host = {
    manual,
    queries: {
      readShopping: async () => ({ kind: 'ready' as const, revision, value: mockShopping }),
    },
    readInstallationId: port<ManualHost['readInstallationId']>(),
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies ManualHost;
  host.readInstallationId.mockResolvedValue({ kind: 'ready', revision: 4, value: installation });
  mockRuntime = { host };
  return {
    host,
    manual,
    receipts,
    commit,
    notify: () =>
      changes.forEach((listener) =>
        listener({ revision, notes: false, collections: false, manualShopping: true }),
      ),
    retire: () => {
      state = { status: 'revoked', scopeKey: 'content:2', pending: null, cleanupPending: 0 };
      listeners.forEach((listener) => listener());
    },
    render: () => render(<ManualShoppingScreen />),
  };
}
function callback(label: string) {
  return screen.UNSAFE_getAllByType(ActionButton).find((node) => node.props.label === label)!.props
    .onPress as () => void;
}
async function openAdd(name: string) {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  fireEvent.changeText(screen.getByLabelText('Item name'), name);
}
async function checkReceipt(resolve = false) {
  const name = resolve ? 'Resolve unconfirmed personal change' : 'Check personal change receipt';
  await waitFor(() => expect(screen.getByRole('button', { name })).toBeEnabled());
  fireEvent.press(screen.getByRole('button', { name }));
}
function refs() {
  return JSON.parse(mockStorage.get(recoveryKey) ?? '{"operations":[]}').operations as {
    operationId: string;
  }[];
}

test('content manual list uses the existing add/edit/purchase/delete engine with exact raw fields', async () => {
  const f = fixture([]);
  f.render();
  await openAdd('  Private lemons  ');
  fireEvent.changeText(screen.getByLabelText('Amount · optional'), '2 1/2');
  fireEvent.changeText(screen.getByLabelText('Unit · optional'), ' bags ');
  fireEvent.press(screen.getByText('Save manual item'));
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Save manual item' })).toBeNull(),
  );
  expect(f.manual.execute.mock.calls[0]![0]).toMatchObject({
    kind: 'addManualItem',
    fields: { name: '  Private lemons  ', amountText: '2 1/2', unitText: ' bags ' },
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit   Private lemons  ' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Edit   Private lemons  ' }));
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Edited lemons');
  fireEvent.press(screen.getByText('Save manual item'));
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Save manual item' })).toBeNull(),
  );
  fireEvent.press(screen.getByRole('checkbox'));
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
  fireEvent.press(screen.getByRole('button', { name: 'Delete Edited lemons' }));
  fireEvent.press(screen.getByText('Confirm delete manual item'));
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(4));
  await screen.findByText(/Your own list is empty/);
  const general = renderHook(() => usePersonalPorts());
  expect(general.result.current).toBeNull();
  general.unmount();
  expect(refs()).toHaveLength(0);
});

test('same-mounted recovered creation loads current rows without notifications and never duplicates it', async () => {
  const f = fixture([]);
  f.manual.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  f.render();
  await openAdd('New apples');
  fireEvent.press(screen.getByText('Save manual item'));
  await checkReceipt();
  await waitFor(() => expect(f.manual.readReceipt).toHaveBeenCalledTimes(1));
  await screen.findByText('Local change saved');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Save manual item' })).toBeNull(),
  );
  await screen.findByText('New apples');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).toBeEnabled(),
  );
  expect(f.manual.execute).toHaveBeenCalledTimes(1);
});

test('recovered edit keeps newer draft and requires explicit current revision review', async () => {
  const f = fixture();
  f.manual.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  f.render();
  await waitFor(() => expect(screen.getByText('Edit Private lemons')).toBeEnabled());
  fireEvent.press(screen.getByText('Edit Private lemons'));
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Submitted lemons');
  fireEvent.press(screen.getByText('Save manual item'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check personal change receipt' })).toBeEnabled(),
  );
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Newer private draft');
  await checkReceipt();
  await waitFor(() => expect(screen.getByText('Use current list for this draft')).toBeEnabled());
  expect(screen.getByLabelText('Item name').props.value).toBe('Newer private draft');
  expect(screen.getByText('Save manual item')).toBeDisabled();
  fireEvent.press(screen.getByText('Use current list for this draft'));
  fireEvent.press(screen.getByText('Save manual item'));
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(2));
  expect(f.manual.execute.mock.calls[1]![0]).toMatchObject({
    kind: 'editManualItem',
    itemId,
    expectedRevision: 5,
    fields: { name: 'Newer private draft' },
  });
});

test('retirement during metadata remember preserves reference and blocks retained save callback', async () => {
  const f = fixture([]);
  f.render();
  await openAdd('Retired private name');
  const save = callback('Save manual item'),
    gate = deferred<void>();
  mockWriteGate = gate.promise;
  act(() => save());
  await act(async () => {
    f.retire();
    gate.resolve();
    await gate.promise;
  });
  await waitFor(() => expect(refs()).toHaveLength(1));
  await act(async () => save());
  expect(f.manual.execute).not.toHaveBeenCalled();
  expect(screen.queryByDisplayValue('Retired private name')).toBeNull();
  expect(mockStorage.get(recoveryKey)).not.toContain('Retired private');
});

test('retirement after dispatch hides item and unknown outcome retains operation ID', async () => {
  const f = fixture(),
    gate = deferred<Awaited<ReturnType<ManualHost['manual']['execute']>>>();
  f.manual.execute.mockImplementation(async () => gate.promise);
  f.render();
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeEnabled());
  fireEvent.press(screen.getByRole('checkbox'));
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(1));
  await act(async () => {
    f.retire();
    gate.resolve(f.commit(f.manual.execute.mock.calls[0]![0]));
    await gate.promise;
  });
  expect(refs()).toHaveLength(1);
  expect(screen.queryByText('Private lemons')).toBeNull();
  expect(screen.queryByText('Local change saved')).toBeNull();
});

test('manual recovery does not consume note namespace and rejects unrelated receipt', async () => {
  const f = fixture(),
    op = 'f0000000-0000-4000-8000-000000000001';
  mockStorage.set(
    `content-notes:cookmate.personal-recovery.${installation}`,
    JSON.stringify({
      schemaVersion: 1,
      installationId: installation,
      operations: [{ operationId: op, createdAt: timestamp }],
    }),
  );
  const view = f.render();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).toBeEnabled(),
  );
  expect(screen.queryByText('Unconfirmed personal change')).toBeNull();
  view.unmount();
  mockStorage.set(
    recoveryKey,
    JSON.stringify({
      schemaVersion: 1,
      installationId: installation,
      operations: [{ operationId: op, createdAt: timestamp }],
    }),
  );
  f.manual.readReceipt.mockResolvedValue(
    ready({
      operationId: op,
      commandKind: 'saveNote',
      outcome: 'committed',
      entityId: null,
      revision: 4,
      epoch: 1,
      committedAt: timestamp,
      affectedMemberships: 0,
    }),
  );
  f.render();
  await checkReceipt();
  await screen.findByText('The receipt does not match this operation. No success is claimed.');
  expect(refs()).toHaveLength(1);
});

test('ordinary content checklist searches manual rows, toggles exact manual identity, and mounts complete sharing review', async () => {
  const f = fixture();
  render(<ShoppingScreen header={null} />);
  await screen.findByText('Private lemons');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).toBeEnabled(),
  );
  fireEvent.changeText(screen.getByLabelText('Find a shopping item'), 'lemons');
  expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  expect(screen.getByText('2 matching items')).toBeTruthy();
  const manual = screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' });
  fireEvent.press(manual);
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(1));
  expect(f.manual.execute.mock.calls[0]![0]).toMatchObject({
    kind: 'setManualPurchased',
    itemId,
    expectedRevision: 4,
    purchased: true,
  });
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }),
    ).toBeChecked(),
  );
  expect(mockBegin).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Share list' }));
  await screen.findByText(/Your own items \(1\)/);
  expect(screen.getByText(/\[x\] Private lemons — 2 bags/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Close preview' }));
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/manual-shopping', params: { create: '1' } });
});

test('same-mounted checklist purchase recovery refreshes revision before the next toggle', async () => {
  const f = fixture();
  f.manual.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  render(<ShoppingScreen header={null} />);
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }),
    ).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }));
  await checkReceipt();
  await waitFor(() => expect(f.manual.readReceipt).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(refs()).toHaveLength(0));
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' })).toBeChecked();
  fireEvent.press(screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }));
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(2));
  expect(f.manual.execute.mock.calls[1]![0]).toMatchObject({
    expectedRevision: 5,
    purchased: false,
  });
});

test('retained checklist toggle and edit callbacks cannot act after owner retirement', async () => {
  const f = fixture();
  render(<ShoppingScreen header={null} />);
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }),
    ).toBeEnabled(),
  );
  const toggle = screen
    .UNSAFE_getAllByType(PurchaseRow)
    .find((node) => node.props.name === 'Private lemons')!.props.onToggle as () => void;
  const edit = screen
    .UNSAFE_getAllByType(IconButton)
    .find((node) => node.props.label === 'Edit manual item Private lemons')!.props
    .onPress as () => void;
  act(() => f.retire());
  await act(async () => {
    toggle();
    edit();
  });
  expect(f.manual.execute).not.toHaveBeenCalled();
  expect(mockPush).not.toHaveBeenCalled();
  expect(screen.queryByText('Private lemons')).toBeNull();
});

test('discarded form does not retain mutation authority or unsaved text on reopening', async () => {
  const f = fixture();
  f.render();
  await waitFor(() => expect(screen.getByText('Edit Private lemons')).toBeEnabled());
  fireEvent.press(screen.getByText('Edit Private lemons'));
  fireEvent.changeText(screen.getByLabelText('Item name'), 'Discard this');
  const save = callback('Save manual item');
  fireEvent.press(screen.getByText('Cancel manual item changes'));
  act(() => mockConfirm.mock.calls[0]![0].onConfirm());
  await act(async () => save());
  expect(f.manual.execute).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Save manual item' })).toBeNull(),
  );
  // The sheet retires its fields before its dismiss animation releases the list.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit Private lemons' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Edit Private lemons' }));
  expect(screen.getByLabelText('Item name').props.value).toBe('Private lemons');
});

test('remounted manual recovery reads the retained receipt without replaying the command', async () => {
  const f = fixture([]);
  f.manual.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  const view = f.render();
  await openAdd('Retained apples');
  fireEvent.press(screen.getByText('Save manual item'));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check personal change receipt' })).toBeEnabled(),
  );
  expect(refs()).toHaveLength(1);
  view.unmount();
  f.render();
  await checkReceipt();
  await waitFor(() => expect(refs()).toHaveLength(0));
  await screen.findByText('Retained apples');
  expect(f.manual.execute).toHaveBeenCalledTimes(1);
  expect(f.manual.readReceipt).toHaveBeenCalledTimes(1);
});

test('recovered deletion closes its exact confirmation without a second dispatch', async () => {
  const f = fixture();
  f.manual.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  f.render();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Delete Private lemons' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Delete Private lemons' }));
  fireEvent.press(screen.getByRole('button', { name: 'Confirm delete manual item' }));
  await checkReceipt();
  await waitFor(() => expect(f.manual.readReceipt).toHaveBeenCalledTimes(1));
  await screen.findByText('Local change saved');
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Confirm delete manual item' })).toBeNull(),
  );
  await screen.findByText(/Your own list is empty/);
  expect(f.manual.execute).toHaveBeenCalledTimes(1);
  expect(refs()).toHaveLength(0);
});

test('a subscription superseding receipt refresh still enables the newest confirmed rows', async () => {
  const f = fixture();
  f.manual.execute.mockImplementationOnce(async (command) => {
    f.commit(command, false);
    return { kind: 'uncertain', operationId: command.operationId, error: failure };
  });
  render(<ShoppingScreen header={null} />);
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }),
    ).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Check personal change receipt' })).toBeEnabled(),
  );
  const delayed = deferred<Awaited<ReturnType<ManualHost['manual']['readManualShopping']>>>();
  f.manual.readManualShopping.mockImplementationOnce(() => delayed.promise);
  fireEvent.press(screen.getByRole('button', { name: 'Check personal change receipt' }));
  await waitFor(() => expect(f.manual.readManualShopping).toHaveBeenCalledTimes(2));
  act(() => f.notify());
  await waitFor(() =>
    expect(
      screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' })).toBeChecked();
  await act(async () =>
    delayed.resolve(ready({ epoch: 1, total: 1, items: [original()], nextCursor: null })),
  );
  expect(screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' })).toBeChecked();
  fireEvent.press(screen.getByRole('checkbox', { name: 'Purchased Private lemons, 2 bags' }));
  await waitFor(() => expect(f.manual.execute).toHaveBeenCalledTimes(2));
  expect(f.manual.execute.mock.calls[1]![0]).toMatchObject({
    expectedRevision: 5,
    purchased: false,
  });
});

test('effect replay restores scope before child operation hydration and remains usable', async () => {
  const f = fixture([]);
  render(
    <StrictMode>
      <ManualShoppingScreen />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  await screen.findByLabelText('Item name');
  fireEvent.press(screen.getByRole('button', { name: 'Cancel manual item changes' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Add manual item' })).toBeEnabled(),
  );
  fireEvent.press(screen.getByRole('button', { name: 'Add manual item' }));
  await screen.findByLabelText('Item name');
  expect(f.manual.execute).not.toHaveBeenCalled();
  expect(refs()).toHaveLength(0);
});
