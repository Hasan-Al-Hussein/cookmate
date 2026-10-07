/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import DiscoverScreen from './DiscoverScreen';
import { DiscoverProvider } from './DiscoverState';
import { AssistantEntryProvider } from '../assistant/AssistantEntryState';

let mockWidth = 353;
jest.mock('react-native', () => jest.requireActual('react-native-web/dist/cjs'));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: jest.requireActual('react-native-web/dist/cjs').View,
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: {} }));
// Resolve the app's platform helpers as Metro does when rendering the real web modal.
jest.mock('../../components/focusTarget', () =>
  jest.requireActual('../../components/focusTarget.web'),
);
jest.mock('../../components/controlStateProps', () =>
  jest.requireActual('../../components/controlStateProps.web'),
);
jest.mock('../../hooks/useNativeLayout', () => {
  const actual = jest.requireActual('../../hooks/useNativeLayout');
  return {
    ...actual,
    useNativeLayout: () => ({
      width: mockWidth,
      fontScale: 1,
      enlarged: false,
      columns: actual.recipeColumns(mockWidth, 1),
    }),
    useReducedMotion: () => true,
  };
});

const { createRoot } = require('react-dom/client') as {
  createRoot(container: HTMLElement): { render(node: ReactNode): void; unmount(): void };
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const unexpectedFetch = jest.fn(() => {
  throw new Error('Search focus regression must not use the network');
});
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);
beforeAll(() => {
  // This isolated DOM fixture needs no network; do not initialize Expo's native fetch at teardown.
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

function input() {
  const node = container.querySelector<HTMLInputElement>(
    'input[aria-label="Search recipes by dish, ingredient or cuisine"]',
  );
  expect(node).not.toBeNull();
  return node!;
}
function show(width: number) {
  mockWidth = width;
  act(() =>
    root.render(
      <DiscoverProvider>
        <AssistantEntryProvider>
          <DiscoverScreen />
        </AssistantEntryProvider>
      </DiscoverProvider>,
    ),
  );
}
function enter(node: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.each([353, 436])(
  'Discover keeps one focused input through edits and intro changes at %ipx',
  (width) => {
    show(width);
    const original = input();
    expect(container.textContent).toContain('Find your');
    act(() => original.focus());
    expect(container.textContent).not.toContain('Find your');
    expect(input()).toBe(original);
    expect(document.activeElement === original).toBe(true);
    for (let length = 1; length <= 'alfredo'.length; length += 1) {
      enter(original, 'alfredo'.slice(0, length));
      expect(input()).toBe(original);
      expect(original.isConnected).toBe(true);
      expect(document.activeElement === original).toBe(true);
      expect(original.value).toBe('alfredo'.slice(0, length));
    }
    expect(
      container.querySelector('[aria-label="Open Fettuccine Alfredo, Italian"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Open Fettucine alfredo, Italian"]'),
    ).not.toBeNull();
    enter(original, '');
    expect(document.activeElement === original).toBe(true);
    act(() => original.blur());
    expect(container.textContent).toContain('Find your');
    expect(input()).toBe(original);
  },
);

test.each([353, 436])(
  'a non-drag list scroll does not dismiss Discover search at %ipx',
  (width) => {
    show(width);
    const original = input();
    act(() => original.focus());
    const scroller = [...container.querySelectorAll<HTMLElement>('div')].find(
      (node) => node.contains(original) && getComputedStyle(node).overflowY === 'auto',
    );
    expect(scroller).toBeDefined();
    act(() => {
      scroller!.scrollTop = 40;
      scroller!.dispatchEvent(new Event('scroll'));
      jest.advanceTimersByTime(100);
    });
    expect(input()).toBe(original);
    expect(original.isConnected).toBe(true);
    expect(document.activeElement === original).toBe(true);
    expect(container.textContent).not.toContain('Find your');
    enter(original, 'alfredo');
    expect(input().value).toBe('alfredo');
    expect(document.activeElement === original).toBe(true);
  },
);

function control(scope: ParentNode, role: string, label: string) {
  const node = [...scope.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(
    (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
  );
  expect(node).toBeDefined();
  return node!;
}
function filterDialog() {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  expect(dialog).not.toBeNull();
  return dialog!;
}
function ingredientInput() {
  const node = filterDialog().querySelector<HTMLInputElement>(
    'input[aria-label="Find an ingredient filter"]',
  );
  expect(node).not.toBeNull();
  return node!;
}
function showIngredientFilters(width: number) {
  show(width);
  act(() => control(container, 'button', 'Filters').click());
  act(() => control(filterDialog(), 'tab', 'Ingredients').click());
}

test.each([
  ['Filters', 'Cancel'],
  ['More filters', 'Cancel'],
  ['More filters', 'Apply filters'],
])('closing %s with %s restores its actual opener', (openerLabel, closeLabel) => {
  show(390);
  const opener = control(container, 'button', openerLabel);
  act(() => opener.click());
  act(() => control(filterDialog(), 'button', closeLabel).click());
  act(() => jest.advanceTimersByTime(500));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
function enterIngredient(node: HTMLInputElement, value: string) {
  // Do not let synthetic input events conceal a lost-focus regression.
  expect(document.activeElement === node).toBe(true);
  enter(node, value);
  expect(ingredientInput()).toBe(node);
  expect(node.isConnected).toBe(true);
  expect(document.activeElement === node).toBe(true);
  expect(node.value).toBe(value);
}

test.each([327, 436])(
  'FilterSheet keeps the same focused ingredient input while typing at %ipx',
  (width) => {
    showIngredientFilters(width);
    const original = ingredientInput();
    act(() => original.focus());
    for (let length = 1; length <= 'basil'.length; length += 1)
      enterIngredient(original, 'basil'.slice(0, length));
    const matches = [...filterDialog().querySelectorAll('[role="checkbox"]')];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((node) => node.textContent?.toLowerCase().includes('basil'))).toBe(true);
    expect(container.querySelector('[aria-label^="Remove ingredient filter:"]')).toBeNull();
  },
);

test.each([327, 436])(
  'a non-drag list scroll preserves FilterSheet ingredient focus and typing at %ipx',
  (width) => {
    showIngredientFilters(width);
    const original = ingredientInput();
    act(() => original.focus());
    expect(document.activeElement === original).toBe(true);
    const scroller = [...filterDialog().querySelectorAll<HTMLElement>('div')].find(
      (node) => node.contains(original) && getComputedStyle(node).overflowY === 'auto',
    );
    expect(scroller).toBeDefined();
    act(() => {
      scroller!.scrollTop = 40;
      scroller!.dispatchEvent(new Event('scroll'));
      jest.advanceTimersByTime(100);
    });
    expect(ingredientInput()).toBe(original);
    expect(original.isConnected).toBe(true);
    for (let length = 1; length <= 'basil'.length; length += 1)
      enterIngredient(original, 'basil'.slice(0, length));
    expect(container.querySelector('[aria-label^="Remove ingredient filter:"]')).toBeNull();
  },
);

test('FilterSheet ingredient selections stay draft until Apply and Cancel discards selection changes', () => {
  showIngredientFilters(327);
  const original = ingredientInput();
  act(() => original.focus());
  enterIngredient(original, 'basil');
  const choice = filterDialog().querySelector<HTMLElement>('[role="checkbox"]');
  expect(choice).not.toBeNull();
  const label = choice!.textContent!.replace(/^[✓○]/, '').trim();
  act(() => choice!.click());
  expect(choice!.getAttribute('aria-checked')).toBe('true');
  expect(container.querySelector('[aria-label^="Remove ingredient filter:"]')).toBeNull();
  act(() => control(filterDialog(), 'button', 'Cancel').click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[aria-label^="Remove ingredient filter:"]')).toBeNull();
  act(() => control(container, 'button', 'Filters').click());
  const reopenedChoice = [
    ...filterDialog().querySelectorAll<HTMLElement>('[role="checkbox"]'),
  ].find((node) => node.textContent?.replace(/^[✓○]/, '').trim() === label);
  expect(reopenedChoice).toBeDefined();
  expect(reopenedChoice!.getAttribute('aria-checked')).toBe('false');
  act(() => reopenedChoice!.click());
  act(() => control(filterDialog(), 'button', 'Apply filters').click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(control(container, 'button', `Remove ingredient filter: ${label}`)).toBeDefined();
});
