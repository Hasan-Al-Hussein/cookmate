/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import type { PlanSnapshot, ShoppingSnapshot } from '@cookmate/domain';
import { PlanScreen } from '../workspace/PlanScreen';

const mockBegin = jest.fn();
const mockExecute = jest.fn();
const mockPersonal = {
  readManualShopping: jest.fn(async () => ({
    kind: 'ready',
    revision: 1,
    value: { epoch: 1, total: 0, items: [], nextCursor: null },
  })),
  subscribe: () => () => undefined,
  execute: mockExecute,
};
const mockPlan: PlanSnapshot = {
  startDate: '2026-09-28',
  endDate: '2026-10-04',
  occurrences: [],
  shoppingScope: { scopeId: 'scope', revision: 1, occurrenceIds: [] },
};
const mockShopping: ShoppingSnapshot = {
  scope: { scopeId: 'scope', revision: 1, occurrenceIds: [] },
  selectedOccurrences: [],
  groups: ['Butter', 'Salt'].map((displayName) => ({
    groupKey: displayName.toLowerCase(),
    displayName,
    quantityLabel: '10 g',
    contributions: [],
    demandFingerprint: displayName,
    purchased: false,
    changed: false,
    revision: 1,
  })),
  projectionRevision: 1,
  status: 'current',
};
const mockWorkspace = {
  availability: {
    kind: 'ready',
    services: { personal: mockPersonal, queries: { readInstallationId: jest.fn() } },
  },
  actions: { blocked: false, begin: mockBegin, restoreAfterRemoval: jest.fn() },
  actionState: { kind: 'idle' },
  recoveryState: { kind: 'ready', page: { entries: [], nextAfterSequence: null } },
  registerFocusFallback: () => () => undefined,
  restoreScreenFocus: jest.fn(),
  clock: { dateContext: () => ({ localDate: '2026-09-30' }) },
};
jest.mock('react-native', () => jest.requireActual('react-native-web/dist/cjs'));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native-web/dist/cjs').View,
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
jest.mock('../../components/controlStateProps', () =>
  jest.requireActual('../../components/controlStateProps.web'),
);
jest.mock('../../components/focusTarget', () =>
  jest.requireActual('../../components/focusTarget.web'),
);
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => mockWorkspace,
  useWorkspaceQuery: (key: string) => ({
    state: { kind: 'ready', value: key === 'shopping' ? mockShopping : mockPlan, revision: 1 },
    retry: jest.fn(),
  }),
}));
jest.mock('../personal/usePersonalOperations', () => ({
  // This read-only focus fixture does not exercise the separately tested durable writer.
  usePersonalOperations: () => ({ ready: true, busy: false, references: [], perform: jest.fn() }),
}));

const { createRoot } = require('react-dom/client') as {
  createRoot(container: HTMLElement): { render(node: ReactNode): void; unmount(): void };
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
const unexpectedFetch = jest.fn(() => {
  throw new Error('Shopping focus regression must not use the network');
});
beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: unexpectedFetch,
  });
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockShopping.groups = mockShopping.groups.map((group) => ({ ...group, purchased: false }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  act(() => jest.runOnlyPendingTimers());
  container.remove();
  jest.useRealTimers();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});
afterAll(() => {
  if (originalActEnvironment)
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  if (originalFetch && 'value' in originalFetch)
    Object.defineProperty(globalThis, 'fetch', originalFetch);
  else if (!originalFetch) delete (globalThis as { fetch?: unknown }).fetch;
  // Jest disposes this file's isolated jsdom realm after afterAll. Restoring
  // Expo's lazy native accessor here makes teardown load native modules after
  // their mocks are gone. Keep the network-denying value until realm disposal.
});
function control(role: string, label: string) {
  const node = [...container.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
  );
  expect(node).toBeDefined();
  return node!;
}
function input() {
  const node = container.querySelector<HTMLInputElement>(
    'input[aria-label="Find a shopping item"]',
  );
  expect(node).not.toBeNull();
  return node!;
}
async function showShopping() {
  await act(async () => root.render(<PlanScreen />));
  await act(async () => control('tab', 'Shopping').click());
  expect(mockPersonal.readManualShopping).toHaveBeenCalledTimes(1);
}
function scrollWhileFocused(node: HTMLInputElement) {
  const scroller = [...container.querySelectorAll<HTMLElement>('div')].find(
    (element) => element.contains(node) && getComputedStyle(element).overflowY === 'auto',
  );
  expect(scroller).toBeDefined();
  act(() => {
    scroller!.scrollTop += 40;
    scroller!.dispatchEvent(new Event('scroll'));
    jest.advanceTimersByTime(100);
  });
  expect(input()).toBe(node);
  expect(node.isConnected).toBe(true);
  expect(document.activeElement).toBe(node);
}

test('Plan to Shopping keeps the same focused input through scroll, typing, filtering and clear', async () => {
  await showShopping();
  const original = input();
  act(() => original.focus());
  expect(document.activeElement).toBe(original);
  scrollWhileFocused(original);
  for (let length = 1; length <= 'butter'.length; length++) {
    const value = 'butter'.slice(0, length);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        original,
        value,
      );
      original.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input()).toBe(original);
    expect(original.value).toBe(value);
    expect(document.activeElement).toBe(original);
    scrollWhileFocused(original);
  }
  expect(container.querySelector('[aria-label="Purchased Butter, 10 g"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Purchased Salt, 10 g"]')).toBeNull();
  act(() => control('button', 'Clear shopping search').click());
  expect(input()).toBe(original);
  expect(original.value).toBe('');
  expect(document.activeElement).toBe(original);
  expect(container.querySelector('[aria-label="Purchased Salt, 10 g"]')).not.toBeNull();
  expect(mockPersonal.readManualShopping).toHaveBeenCalledTimes(1);
  expect(mockBegin).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
});

test('a filtered purchase keeps the focused DOM checkbox and accepts a keyboard undo', async () => {
  await showShopping();
  act(() => control('tab', 'To buy 2').click());
  const row = control('checkbox', 'Purchased Butter, 10 g');
  act(() => {
    row.focus();
    row.click();
  });
  expect(mockBegin).toHaveBeenLastCalledWith(
    { kind: 'setPurchased', groupKey: 'butter', purchased: true },
    expect.objectContaining({ observedDemandFingerprint: 'Butter' }),
  );
  mockShopping.groups = mockShopping.groups.map((group) =>
    group.groupKey === 'butter' ? { ...group, purchased: true, revision: 2 } : group,
  );
  await act(async () => root.render(<PlanScreen />));
  expect(control('checkbox', 'Purchased Butter, 10 g')).toBe(row);
  expect(document.activeElement).toBe(row);
  expect(row.getAttribute('aria-checked')).toBe('true');
  expect(row.getAttribute('aria-disabled')).not.toBe('true');
  expect(control('tab', 'To buy 1')).toBeDefined();
  act(() => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    row.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  expect(mockBegin).toHaveBeenLastCalledWith(
    { kind: 'setPurchased', groupKey: 'butter', purchased: false },
    expect.objectContaining({ observedDemandFingerprint: 'Butter' }),
  );
  act(() => control('tab', 'To buy 1').click());
  expect(row.isConnected).toBe(false);
  expect(control('checkbox', 'Purchased Salt, 10 g')).toBeDefined();
});
