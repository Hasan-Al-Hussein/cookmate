/** @jest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import * as Native from 'react-native';
import { focusTarget } from './focusTarget.web';
import { PageHeader } from './Page';
import { useActionFocus } from '../hooks/useActionFocus';
import { ActionConfirmation } from '../features/workspace/WorkspaceFeedback';
import { Preferences } from '../features/settings/Preferences';
import { FilterSheet } from '../features/discover/FilterSheet';

const mockFallback = jest.fn();
let mockRegisteredFallback: (() => void) | undefined;
const mockRegisterFallback = jest.fn((callback: () => void) => {
  mockRegisteredFallback = callback;
  return () => undefined;
});
const mockRestoreAfterRemoval = jest.fn();
let mockActionKind = 'idle';
let mockFocusNode: HTMLElement | null = null;

// Native renderer refs are component instances. Supply the DOM ref that RN Web owns.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const React = jest.requireActual('react');
  const exports = Object.defineProperties({}, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(exports, 'findNodeHandle', {
    configurable: true,
    enumerable: true,
    value: jest.fn(),
    writable: true,
  });
  Object.defineProperty(exports, 'View', {
    configurable: true,
    enumerable: true,
    value: React.forwardRef((props: Record<string, unknown>, ref: unknown) => {
      React.useImperativeHandle(ref, () => mockFocusNode);
      return React.createElement(actual.View, props);
    }),
  });
  return exports;
});

jest.mock('./focusTarget', () => jest.requireActual('./focusTarget.web'));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../features/workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    assistant: null,
    actions: { blocked: false, restoreAfterRemoval: mockRestoreAfterRemoval },
    actionState: {
      kind: mockActionKind,
      refreshed: false,
      review: {
        guard: { kind: 'none' },
        input: { kind: 'setFavourite', recipeId: '52839', saved: true },
        payload: { kind: 'setFavourite', recipeId: '52839', saved: true },
        consequences: { kind: 'favourite', recipeId: '52839', saved: true },
      },
    },
    restoreScreenFocus: mockFallback,
    registerFocusFallback: mockRegisterFallback,
  }),
  useWorkspaceQuery: () => ({
    state: { kind: 'ready', value: { revision: 0, lastRemovalRevision: null, items: [] } },
    retry: jest.fn(),
  }),
}));

function connectedElement(tag = 'div') {
  const element = document.createElement(tag);
  document.body.appendChild(element);
  return element;
}
function viewRef(element: HTMLElement): Native.View {
  return element as unknown as Native.View;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActionKind = 'idle';
  mockFocusNode = null;
  mockRegisteredFallback = undefined;
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  jest.restoreAllMocks();
});

test('web headings become programmatically focusable without entering the tab order', () => {
  const heading = connectedElement();
  heading.setAttribute('role', 'heading');
  const focus = jest.spyOn(heading, 'focus');
  expect(focusTarget(viewRef(heading))).toBe(true);
  expect(document.activeElement).toBe(heading);
  expect(heading.getAttribute('tabindex')).toBe('-1');
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  connectedElement('button').focus();
  expect(heading.hasAttribute('tabindex')).toBe(false);
});

test.each(['0', '-1'])('web focus preserves an existing tabindex of %s', (tabIndex) => {
  const button = connectedElement();
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', tabIndex);
  expect(focusTarget(viewRef(button))).toBe(true);
  expect(button.getAttribute('tabindex')).toBe(tabIndex);
  expect(document.activeElement).toBe(button);
});

test('missing, detached, unsupported and failed targets never report successful focus', () => {
  expect(focusTarget(null)).toBe(false);
  const detached = document.createElement('div');
  const detachedFocus = jest.spyOn(detached, 'focus');
  expect(focusTarget(viewRef(detached))).toBe(false);
  expect(detachedFocus).not.toHaveBeenCalled();
  expect(focusTarget({ isConnected: true } as unknown as Native.View)).toBe(false);
  const failed = connectedElement();
  jest.spyOn(failed, 'focus').mockImplementation(() => undefined);
  expect(focusTarget(viewRef(failed))).toBe(false);
  expect(failed.hasAttribute('tabindex')).toBe(false);
  jest.spyOn(failed, 'focus').mockImplementation(() => {
    throw new Error('Unavailable');
  });
  expect(focusTarget(viewRef(failed))).toBe(false);
  expect(failed.hasAttribute('tabindex')).toBe(false);
});

test('temporary heading cleanup preserves a later explicit tabindex change', () => {
  const heading = connectedElement();
  expect(focusTarget(viewRef(heading))).toBe(true);
  heading.setAttribute('tabindex', '0');
  connectedElement('button').focus();
  expect(heading.getAttribute('tabindex')).toBe('0');
});

test('native focus retains the handle and accessibility request, with no request for a missing handle', () => {
  const native = jest.requireActual<typeof import('./focusTarget')>('./focusTarget');
  const resolve = jest.mocked(Native.findNodeHandle).mockReturnValue(42);
  const announce = jest
    .spyOn(Native.AccessibilityInfo, 'setAccessibilityFocus')
    .mockImplementation(() => undefined);
  const target = {} as Native.View;
  expect(native.focusTarget(target)).toBe(true);
  expect(resolve).toHaveBeenCalledWith(target);
  expect(announce).toHaveBeenCalledWith(42);
  resolve.mockReturnValue(null);
  expect(native.focusTarget(target)).toBe(false);
  expect(native.focusTarget(null)).toBe(false);
  expect(announce).toHaveBeenCalledTimes(1);
});

test.each(['confirmation', 'preferences', 'filters'] as const)(
  '%s modal onShow focuses its real heading without native node lookup',
  async (kind) => {
    jest.mocked(Native.findNodeHandle).mockImplementation(() => {
      throw new Error('Unsupported on web');
    });
    const heading = connectedElement();
    mockFocusNode = heading;
    mockActionKind = kind === 'confirmation' ? 'confirmation' : 'idle';
    render(
      kind === 'confirmation' ? (
        <ActionConfirmation />
      ) : kind === 'preferences' ? (
        <Preferences />
      ) : (
        <FilterSheet
          visible
          criteria={{}}
          onApply={jest.fn()}
          onClose={jest.fn()}
          onDismiss={jest.fn()}
        />
      ),
    );
    if (kind === 'preferences')
      fireEvent.press(screen.getByRole('button', { name: 'Add a saved preference' }));
    // Await FilterSheet's reduced-motion initialization before triggering the real callback.
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent(screen.UNSAFE_getByType(Native.Modal), 'show');
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(Native.findNodeHandle).not.toHaveBeenCalled();
  },
);

test('restoration preserves the live-invoker guard and uses screen fallback if DOM focus fails', () => {
  const invoker = connectedElement('button');
  const elsewhere = connectedElement('button');
  const { result } = renderHook(useActionFocus);
  result.current.ref.current = viewRef(invoker);
  const restore = result.current.restoreFocus;
  elsewhere.focus();
  expect(restore(true)).toBe(false);
  expect(document.activeElement).toBe(elsewhere);
  expect(restore()).toBe(true);
  expect(document.activeElement).toBe(invoker);
  expect(mockFallback).not.toHaveBeenCalled();
  invoker.remove();
  restore();
  expect(mockFallback).toHaveBeenCalledTimes(1);
});

test('registered screen fallback focuses its heading through the web helper', () => {
  const heading = connectedElement();
  mockFocusNode = heading;
  render(<PageHeader title="Plan" />);
  expect(mockRegisteredFallback).toBeDefined();
  mockRegisteredFallback!();
  expect(document.activeElement).toBe(heading);
});
