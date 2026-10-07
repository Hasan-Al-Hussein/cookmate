/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
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
// Exercise installed RN Web inputs/text/modal and the app helpers selected by Metro for web.
jest.mock('react-native', () => jest.requireActual('react-native-web/dist/cjs'));
jest.mock('./fieldHelpProps', () => jest.requireActual('./fieldHelpProps.web'));
jest.mock('./controlStateProps', () => jest.requireActual('./controlStateProps.web'));
jest.mock('./focusTarget', () => jest.requireActual('./focusTarget.web'));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native-web/dist/cjs').View,
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ recipeId: '52839', date: '2026-09-29', meal: 'dinner' }),
  useRouter: () => ({ canGoBack: () => true, back: jest.fn(), replace: jest.fn() }),
  useNavigation: () => ({ dispatch: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));

const { createRoot } = require('react-dom/client') as {
  createRoot(container: HTMLElement): { render(node: ReactNode): void; unmount(): void };
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);
const unexpectedFetch = jest.fn(() => {
  throw new Error('Field help regression must not use the network');
});
beforeAll(() => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: unexpectedFetch,
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });
});
beforeEach(() => {
  jest.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  act(() => {
    jest.runOnlyPendingTimers();
  });
  container.remove();
  jest.useRealTimers();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});
afterAll(() => {
  if (originalActEnvironment)
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
function field(label: string) {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `input[aria-label="${label}"], textarea[aria-label="${label}"]`,
  );
  expect(input).not.toBeNull();
  return input!;
}
function description(input: HTMLElement, invalid: boolean) {
  expect(input.getAttribute('aria-invalid')).toBe(String(invalid));
  const id = input.getAttribute('aria-describedby');
  expect(id).toBeTruthy();
  const target = document.getElementById(id!);
  expect(target).not.toBeNull();
  expect(target!.textContent).not.toBe('');
  expect(target!.closest('[hidden], [aria-hidden="true"]')).toBeNull();
  expect(getComputedStyle(target!).display).not.toBe('none');
  return target!;
}
function button(label: string) {
  const node = [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(node).toBeDefined();
  return node!;
}
function enter(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('web meal date describes visible invalid help then clears aria-invalid on valid recovery', () => {
  act(() => root.render(<PlanEditorScreen />));
  act(() => button('Enter date manually').click());
  const input = field('Meal date in YYYY-MM-DD format');
  const target = description(input, false);
  enter(input, '2026-02-30');
  expect(description(input, true)).toBe(target);
  expect(target.textContent).toBe('Enter a valid date between 1900-01-01 and 2100-12-31.');
  expect(button('Review meal').getAttribute('aria-disabled')).toBe('true');
  act(() => button('Review meal').click());
  expect(mockBegin).not.toHaveBeenCalled();
  enter(input, '2028-02-29');
  expect(description(input, false)).toBe(target);
  expect(target.textContent).toBe('Use YYYY-MM-DD. Dates from 1900 to 2100 are supported.');
  expect(button('Review meal').getAttribute('aria-disabled')).not.toBe('true');
  act(() => button('Review meal').click());
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
  'web preference describes %s and recovers without dispatching a disabled save',
  (_scenario, invalidValue, validValue, errorHelp) => {
    act(() => root.render(<Preferences />));
    act(() => button('Add a saved preference').click());
    const input = field('Preference value');
    const target = description(input, true);
    expect(target.textContent).toContain('Enter at least one non-space character.');
    enter(input, invalidValue);
    expect(description(input, true)).toBe(target);
    expect(target.textContent).toContain(`${[...invalidValue].length} / 256 characters.`);
    expect(target.textContent).toContain(errorHelp);
    expect(button('Save preference').getAttribute('aria-disabled')).toBe('true');
    act(() => button('Save preference').click());
    expect(mockBegin).not.toHaveBeenCalled();
    enter(input, validValue);
    expect(description(input, false)).toBe(target);
    expect(target.textContent).toBe(
      `${[...validValue].length} / 256 characters. This value is saved only when you select Save preference.`,
    );
    expect(button('Save preference').getAttribute('aria-disabled')).not.toBe('true');
    act(() => button('Save preference').click());
    expect(mockBegin).toHaveBeenCalledTimes(1);
    expect(mockBegin).toHaveBeenCalledWith(
      { kind: 'savePreference', type: 'cuisine', explicitValue: validValue },
      { observedPreferenceRevision: 0 },
    );
  },
);
