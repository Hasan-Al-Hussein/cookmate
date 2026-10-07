/** @jest-environment jsdom */
import { act, type ComponentProps, type ReactNode } from 'react';
import { Pressable, type AccessibilityState } from 'react-native';
import { controlStateProps } from './controlStateProps.web';
import { ActionButton, SegmentControl } from './Controls';
import { BottomNavigation } from './BottomNavigation';
import { PurchaseRow } from '../features/shopping/PurchaseRow';

// Render the installed RN Web components so assertions inspect their emitted DOM attributes.
jest.mock('react-native', () => jest.requireActual('react-native-web/dist/cjs'));
jest.mock('./controlStateProps', () => jest.requireActual('./controlStateProps.web'));
jest.mock('expo-router', () => ({ Tabs: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

// React DOM is installed for the preview; its optional declaration package is not required here.
const { createRoot } = require('react-dom/client') as {
  createRoot(container: HTMLElement): { render(node: ReactNode): void; unmount(): void };
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const unexpectedFetch = jest.fn(() => {
  throw new Error('Control state regression must not use the network');
});
const originalActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  'IS_REACT_ACT_ENVIRONMENT',
);

beforeAll(() => {
  // Jest reads enumerable globals during teardown; this DOM fixture must not load native fetch.
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: unexpectedFetch,
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});
afterAll(() => {
  if (originalActEnvironment)
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  else delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function show(node: ReactNode) {
  act(() => root.render(node));
}
function control(role: string, index = 0): HTMLElement {
  const element = container.querySelectorAll<HTMLElement>(`[role="${role}"]`)[index];
  expect(element).toBeDefined();
  return element!;
}

test('native helper preserves the exact accessibilityState object and no web aliases', () => {
  const native = jest.requireActual<typeof import('./controlStateProps')>('./controlStateProps');
  const state: AccessibilityState = {
    checked: 'mixed',
    selected: false,
    expanded: true,
    busy: false,
    disabled: true,
  };
  const props = native.controlStateProps(state, 'checkbox');
  expect(props).toEqual({ accessibilityState: state });
  expect(props.accessibilityState).toBe(state);
});

test('web mapping preserves false and mixed values and limits state to the matching roles', () => {
  expect(controlStateProps({}, 'button')).toEqual({});
  expect(controlStateProps({ checked: true, selected: false }, 'button')).toEqual({
    'aria-pressed': false,
  });
  expect(controlStateProps({ checked: true, selected: false }, 'tab')).toEqual({
    'aria-selected': false,
  });
  expect(controlStateProps({ checked: 'mixed', selected: true }, 'checkbox')).toEqual({
    'aria-checked': 'mixed',
  });
  expect(controlStateProps({ expanded: false, busy: false, disabled: false }, 'button')).toEqual({
    'aria-expanded': false,
    'aria-busy': false,
    'aria-disabled': false,
  });
  show(
    <Pressable
      accessibilityRole="checkbox"
      {...controlStateProps({ checked: 'mixed' }, 'checkbox')}
    />,
  );
  expect(control('checkbox').getAttribute('aria-checked')).toBe('mixed');
  show(<Pressable accessibilityRole="radio" {...controlStateProps({ checked: false }, 'radio')} />);
  expect(control('radio').getAttribute('aria-checked')).toBe('false');
  show(<Pressable accessibilityRole="radio" {...controlStateProps({ checked: true }, 'radio')} />);
  expect(control('radio').getAttribute('aria-checked')).toBe('true');
});

test('purchase checkbox exposes committed false and true states while disabled blocks clicks', () => {
  const toggle = jest.fn();
  const row = (purchased: boolean, unavailable = false) => (
    <PurchaseRow
      name="Basil"
      amount="6 leaves"
      purchased={purchased}
      changed={false}
      unavailable={unavailable}
      onToggle={toggle}
    />
  );
  show(row(false));
  expect(control('checkbox').getAttribute('aria-checked')).toBe('false');
  act(() => control('checkbox').click());
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(control('checkbox').getAttribute('aria-checked')).toBe('false');
  show(row(true));
  expect(control('checkbox').getAttribute('aria-checked')).toBe('true');
  show(row(true, true));
  expect(control('checkbox').getAttribute('aria-disabled')).toBe('true');
  act(() => control('checkbox').click());
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(control('checkbox').hasAttribute('aria-selected')).toBe(false);
});

test('segment tabs expose both selected and unselected states and retain disabled behavior', () => {
  const change = jest.fn();
  const tabs = (value: string, disabled = false) => (
    <SegmentControl
      value={value}
      disabled={disabled}
      onChange={change}
      options={[
        { value: 'ingredients', label: 'Ingredients' },
        { value: 'source', label: 'Source' },
      ]}
    />
  );
  show(tabs('ingredients'));
  expect(control('tab', 0).getAttribute('aria-selected')).toBe('true');
  expect(control('tab', 1).getAttribute('aria-selected')).toBe('false');
  act(() => control('tab', 1).click());
  expect(change).toHaveBeenCalledWith('source');
  show(tabs('source', true));
  expect(control('tab', 0).getAttribute('aria-selected')).toBe('false');
  expect(control('tab', 1).getAttribute('aria-selected')).toBe('true');
  expect(control('tab', 1).getAttribute('aria-disabled')).toBe('true');
  act(() => control('tab', 0).click());
  expect(change).toHaveBeenCalledTimes(1);
  expect(control('tab').hasAttribute('aria-pressed')).toBe(false);
});

test('ActionButton maps expansion, toggle selection and checkbox roles without inventing ordinary-button state', () => {
  show(<ActionButton label="Sources" accessibilityState={{ expanded: false }} />);
  expect(control('button').getAttribute('aria-expanded')).toBe('false');
  expect(control('button').hasAttribute('aria-pressed')).toBe(false);
  show(<ActionButton label="Sources" accessibilityState={{ expanded: true }} />);
  expect(control('button').getAttribute('aria-expanded')).toBe('true');
  show(<ActionButton label="Save recipe" accessibilityState={{ selected: false }} />);
  expect(control('button').getAttribute('aria-pressed')).toBe('false');
  show(<ActionButton label="Saved recipe" accessibilityState={{ selected: true }} />);
  expect(control('button').getAttribute('aria-pressed')).toBe('true');
  expect(control('button').hasAttribute('aria-selected')).toBe(false);
  show(
    <ActionButton
      label="Carry statement"
      accessibilityRole="checkbox"
      accessibilityState={{ checked: false }}
    />,
  );
  expect(control('checkbox').getAttribute('aria-checked')).toBe('false');
  show(
    <ActionButton
      label="Remove statement"
      accessibilityRole="checkbox"
      accessibilityState={{ checked: true }}
    />,
  );
  expect(control('checkbox').getAttribute('aria-checked')).toBe('true');
  expect(control('checkbox').hasAttribute('aria-pressed')).toBe(false);
});

test('ActionButton uses final busy and disabled state for both DOM and blocked interaction', () => {
  const press = jest.fn();
  show(
    <ActionButton
      label="Save"
      onPress={press}
      busy
      accessibilityState={{ busy: false, disabled: false }}
    />,
  );
  expect(control('button').getAttribute('aria-busy')).toBe('true');
  expect(control('button').getAttribute('aria-disabled')).toBe('true');
  act(() => control('button').click());
  expect(press).not.toHaveBeenCalled();
  show(<ActionButton label="Save" onPress={press} />);
  expect(control('button').getAttribute('aria-busy')).toBe('false');
  expect(control('button').getAttribute('aria-disabled')).not.toBe('true');
  act(() => control('button').click());
  expect(press).toHaveBeenCalledTimes(1);
  show(<ActionButton label="Save" onPress={press} disabled />);
  expect(control('button').getAttribute('aria-disabled')).toBe('true');
  act(() => control('button').click());
  expect(press).toHaveBeenCalledTimes(1);
});

test('bottom navigation emits explicit selected states as the active route changes', () => {
  const navigate = jest.fn();
  const props = (index: number) =>
    ({
      state: {
        index,
        routes: [
          { key: 'discover', name: 'index' },
          { key: 'plan', name: 'plan' },
        ],
      },
      descriptors: {
        discover: { options: { title: 'Discover' } },
        plan: { options: { title: 'Plan' } },
      },
      navigation: { emit: jest.fn(() => ({ defaultPrevented: false })), navigate },
    }) as unknown as ComponentProps<typeof BottomNavigation>;
  show(<BottomNavigation {...props(0)} />);
  expect(control('tab', 0).getAttribute('aria-selected')).toBe('true');
  expect(control('tab', 1).getAttribute('aria-selected')).toBe('false');
  act(() => control('tab', 1).click());
  expect(navigate).toHaveBeenCalledWith('plan', undefined);
  show(<BottomNavigation {...props(1)} />);
  expect(control('tab', 0).getAttribute('aria-selected')).toBe('false');
  expect(control('tab', 1).getAttribute('aria-selected')).toBe('true');
});
