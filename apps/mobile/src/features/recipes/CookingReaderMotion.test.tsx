import { Animated, Modal, Platform, StyleSheet, Text } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { getRecipe } from '@cookmate/catalogue';
import { CookingReader } from './CookingReader';

type Completion = (result: { finished: boolean }) => void;
type Transition = { finish: Completion; stop: jest.Mock };
let transitions: Transition[] = [];
const mockMove = jest.fn(() => true);
const mockFocus = jest.fn(() => true);
jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => false }));
jest.mock('../../components/focusTarget', () => ({ focusTarget: () => mockFocus() }));
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ availability: { kind: 'ready', services: { cooking: {} } } }),
}));
// Persistence has separate real-hook coverage; here only deliberate navigation may request a save.
jest.mock('../cooking/useCookingProgress', () => ({
  useCookingProgress: () => ({ ready: true, view: null, move: mockMove }),
}));
jest.mock('../cooking/KeepAwakeControl', () => ({ KeepAwakeControl: () => null }));
jest.mock('../cooking/CookingCompletion', () => ({ CookingCompletion: () => null }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

const recipe = getRecipe('52819')!;
const ingredientText = 'Exact retained ingredient content';
const fullText = 'Exact retained full instruction content';

beforeEach(() => {
  jest.useFakeTimers();
  jest.replaceProperty(Platform, 'OS', 'web');
  transitions = [];
  mockMove.mockClear();
  mockFocus.mockClear();
  jest
    .spyOn(Animated, 'timing')
    .mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() }));
  jest.spyOn(Animated, 'parallel').mockImplementation(() => {
    let completion: Completion | undefined;
    const transition = {
      finish: (result: { finished: boolean }) => completion?.(result),
      stop: jest.fn(() => completion?.({ finished: false })),
    };
    transitions.push(transition);
    return {
      start: jest.fn((callback?: Completion) => {
        completion = callback;
      }),
      stop: transition.stop,
      reset: jest.fn(),
    };
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function finish(transition: Transition) {
  act(() => transition.finish({ finished: true }));
}
function latestTransition() {
  return transitions[transitions.length - 1]!;
}
function setup() {
  const onClose = jest.fn();
  const onDismiss = jest.fn();
  const content = (visible: boolean) => (
    <CookingReader
      recipe={recipe}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      ingredients={<Text>{ingredientText}</Text>}
      ingredientNotes={null}
      sourceNotes={null}
      fullInstructions={<Text>{fullText}</Text>}
    />
  );
  const view = render(content(true));
  const modal = screen.UNSAFE_getByType(Modal);
  fireEvent(modal, 'show');
  finish(latestTransition());
  // Leave the reader on one known original procedural anchor across each composition test.
  const start = screen.queryByRole('button', { name: 'Start cooking' });
  if (start) fireEvent.press(start);
  expect(screen.getByText('Cooking passage 1 of 4')).toBeTruthy();
  mockMove.mockClear();
  return {
    ...view,
    modal,
    onClose,
    onDismiss,
    requested: (visible: boolean) => view.rerender(content(visible)),
  };
}
function openIngredients() {
  fireEvent.press(screen.getByRole('button', { name: 'Open ingredients sheet' }));
  const countBeforeLayout = transitions.length;
  fireEvent(screen.getByRole('header', { name: 'Ingredients' }), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 100, height: 30 } },
  });
  expect(transitions).toHaveLength(countBeforeLayout + 1);
  finish(latestTransition());
  expect(screen.getByText(ingredientText)).toBeTruthy();
}

test('ingredient peek retains an inert exit, removes it, and reopens without changing the passage', () => {
  const view = setup();
  openIngredients();
  const ingredientHeading = screen.getByRole('header', { name: 'Ingredients' });
  fireEvent.press(screen.getByRole('button', { name: 'Close ingredients sheet' }));
  const exit = latestTransition();
  const focusBeforeLateLayout = mockFocus.mock.calls.length;
  fireEvent(ingredientHeading, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 100, height: 30 } },
  });
  expect(mockFocus).toHaveBeenCalledTimes(focusBeforeLateLayout);
  expect(latestTransition()).toBe(exit);
  expect(screen.queryByText(ingredientText)).toBeNull();
  expect(screen.getByText(ingredientText, { includeHiddenElements: true })).toBeTruthy();
  expect(screen.queryByText('Cooking passage 1 of 4')).toBeNull();
  expect(view.modal.props.visible).toBe(true);
  expect(mockMove).not.toHaveBeenCalled();
  finish(exit);
  expect(screen.queryByText(ingredientText, { includeHiddenElements: true })).toBeNull();
  expect(screen.getByText(recipe.instructions[1]!.rawText)).toBeTruthy();
  expect(screen.getByText('Cooking passage 1 of 4')).toBeTruthy();
  expect(view.onDismiss).not.toHaveBeenCalled();

  openIngredients();
  fireEvent(view.modal, 'requestClose');
  expect(view.onClose).not.toHaveBeenCalled();
  finish(latestTransition());
  expect(screen.getByText('Cooking passage 1 of 4')).toBeTruthy();
  expect(mockMove).not.toHaveBeenCalled();
});

test('outer exit retains full instructions and an opaque underlay until native dismissal', () => {
  const view = setup();
  fireEvent.press(screen.getByRole('button', { name: 'Full instructions' }));
  const surface = screen
    .UNSAFE_getAllByType(Animated.View)
    .find((node) => node.props.pointerEvents === 'auto')!;
  let underlay = surface.parent;
  while (underlay && !StyleSheet.flatten(underlay.props.style)?.backgroundColor)
    underlay = underlay.parent;
  expect(underlay).not.toBeNull();
  const underlayStyle = StyleSheet.flatten(underlay!.props.style);
  expect(underlayStyle.backgroundColor).toBeTruthy();
  expect(underlayStyle.opacity).toBeUndefined();
  expect(underlayStyle.transform).toBeUndefined();
  view.requested(false);
  expect(view.modal.props.visible).toBe(true);
  expect(screen.getByText(fullText, { includeHiddenElements: true })).toBeTruthy();
  expect(screen.queryByText(fullText)).toBeNull();
  expect(surface.props.inert).toBe(true);
  expect(surface.props.pointerEvents).toBe('none');
  expect(StyleSheet.flatten(underlay!.props.style)).toEqual(underlayStyle);
  const focusBeforeLateShow = mockFocus.mock.calls.length;
  fireEvent(view.modal, 'show');
  expect(mockFocus).toHaveBeenCalledTimes(focusBeforeLateShow);
  fireEvent(view.modal, 'requestClose');
  expect(view.onClose).not.toHaveBeenCalled();
  expect(view.onDismiss).not.toHaveBeenCalled();
  finish(latestTransition());
  expect(view.modal.props.visible).toBe(false);
  expect(screen.queryByText(fullText, { includeHiddenElements: true })).toBeNull();
  expect(view.onDismiss).not.toHaveBeenCalled();
  fireEvent(view.modal, 'dismiss');
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
  view.requested(true);
  fireEvent(view.modal, 'show');
  finish(latestTransition());
  expect(screen.getByText('Cooking passage 1 of 4')).toBeTruthy();
  expect(screen.queryByText(fullText)).toBeNull();
  expect(mockMove).not.toHaveBeenCalled();
});

test('reopening the reader during nested exit preserves its ingredient layer and ignores stale completions', () => {
  const view = setup();
  openIngredients();
  const beforeClosing = transitions.length;
  view.requested(false);
  expect(transitions).toHaveLength(beforeClosing + 2);
  const exits = transitions.slice(beforeClosing);
  view.requested(true);
  const reopened = transitions.slice(beforeClosing + 2);
  expect(reopened).toHaveLength(2);
  for (const exit of exits) {
    expect(exit.stop).toHaveBeenCalled();
    finish(exit);
  }
  expect(view.modal.props.visible).toBe(true);
  expect(screen.getByText(ingredientText)).toBeTruthy();
  for (const entry of reopened) finish(entry);
  fireEvent.press(screen.getByRole('button', { name: 'Close ingredients sheet' }));
  finish(latestTransition());
  expect(screen.queryByText(ingredientText, { includeHiddenElements: true })).toBeNull();
  expect(screen.getByText('Cooking passage 1 of 4')).toBeTruthy();
  expect(view.onDismiss).not.toHaveBeenCalled();
  expect(mockMove).not.toHaveBeenCalled();
});

test('nested removal cannot restore focus inside a concurrently closing outer reader', () => {
  const view = setup();
  let frame: ReturnType<typeof screen.getByRole> | null = screen.getByRole('button', {
    name: 'Open ingredients sheet',
  });
  while (frame && !frame.props.onLayout) frame = frame.parent;
  expect(frame).not.toBeNull();
  openIngredients();
  fireEvent.press(screen.getByRole('button', { name: 'Close ingredients sheet' }));
  const innerExit = latestTransition();
  view.requested(false);
  const outerExit = latestTransition();
  expect(outerExit).not.toBe(innerExit);
  const focusBeforeRemoval = mockFocus.mock.calls.length;
  finish(innerExit);
  expect(view.modal.props.visible).toBe(true);
  fireEvent(frame!, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 428, height: 740 } },
  });
  expect(mockFocus).toHaveBeenCalledTimes(focusBeforeRemoval);
  finish(outerExit);
  fireEvent(view.modal, 'dismiss');
  expect(view.onDismiss).toHaveBeenCalledTimes(1);
  expect(mockMove).not.toHaveBeenCalled();
});
