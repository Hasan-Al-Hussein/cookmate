import { useState } from 'react';
import { ActivityIndicator, Animated, TextInput } from 'react-native';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { ActionButton } from './Controls';
import { ContentFade } from './ContentFade';
import { useDelayedPending } from './useDelayedPending';
import { useEntranceMotion } from './useEntranceMotion';
import { motionTokens } from '../design/motion';

let mockReduced = false;
let mockBlur: (() => void) | undefined;
jest.mock('../design/MotionPolicy', () => ({ useMotionPolicy: () => mockReduced }));
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => () => void) =>
    jest.requireActual('react').useEffect(() => {
      mockBlur = callback();
      return mockBlur;
    }, [callback]),
}));
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Animated, 'timing').mockReturnValue({
    start: jest.fn(),
    stop: jest.fn(),
    reset: jest.fn(),
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
  mockReduced = false;
  mockBlur = undefined;
});

test('fast pending work never shows a spinner; a new operation gets its own delay', () => {
  const view = renderHook<boolean, { pending: boolean }>(
    ({ pending }) => useDelayedPending(pending),
    {
      initialProps: { pending: true },
    },
  );
  act(() => jest.advanceTimersByTime(motionTokens.delay.pending - 1));
  expect(view.result.current).toBe(false);
  view.rerender({ pending: false });
  act(() => jest.advanceTimersByTime(500));
  expect(view.result.current).toBe(false);
  view.rerender({ pending: true });
  expect(view.result.current).toBe(false);
  act(() => jest.advanceTimersByTime(motionTokens.delay.pending));
  expect(view.result.current).toBe(true);
  view.rerender({ pending: false });
  expect(view.result.current).toBe(false);
});

test('pending presentation cancels its timer on unmount', () => {
  const view = renderHook(() => useDelayedPending(true));
  expect(jest.getTimerCount()).toBe(1);
  view.unmount();
  expect(jest.getTimerCount()).toBe(0);
});

test('busy semantics and duplicate-press blocking are immediate while its marker is delayed', () => {
  const command = jest.fn();
  const view = render(<ActionButton label="Save" busy onPress={command} />);
  const button = screen.getByRole('button', { name: 'Save' });
  expect(button).toBeDisabled();
  expect(button.props.accessibilityState.busy).toBe(true);
  fireEvent.press(button);
  expect(command).not.toHaveBeenCalled();
  expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();
  act(() => jest.advanceTimersByTime(motionTokens.delay.pending));
  expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  mockReduced = true;
  view.rerender(<ActionButton label="Save" busy onPress={command} />);
  expect(screen.UNSAFE_queryByType(ActivityIndicator)).toBeNull();
  expect(
    screen.getByTestId('static-pending-indicator', { includeHiddenElements: true }),
  ).toBeTruthy();
  view.rerender(<ActionButton label="Save" onPress={command} />);
  expect(
    screen.queryByTestId('static-pending-indicator', { includeHiddenElements: true }),
  ).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  expect(command).toHaveBeenCalledTimes(1);
});

test('sheet animation begins only when shown and does not wait to run other work', () => {
  const view = renderHook<ReturnType<typeof useEntranceMotion>, { visible: boolean }>(
    ({ visible }) => useEntranceMotion(visible),
    {
      initialProps: { visible: true },
    },
  );
  const animate = jest.mocked(Animated.timing);
  expect(animate).not.toHaveBeenCalled();
  const focus = jest.fn();
  act(() => {
    view.result.current.reveal();
    focus();
  });
  expect(animate).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalledTimes(1);
  const value = animate.mock.calls[0]![0] as Animated.Value;
  const stop = jest.spyOn(value, 'stopAnimation');
  const set = jest.spyOn(value, 'setValue');
  view.rerender({ visible: false });
  expect(stop).toHaveBeenCalled();
  expect(set).toHaveBeenLastCalledWith(1);
  act(() => view.result.current.reveal());
  expect(animate).toHaveBeenCalledTimes(1);
  view.rerender({ visible: true });
  act(() => view.result.current.reveal());
  expect(animate).toHaveBeenCalledTimes(2);
  stop.mockClear();
  view.unmount();
  expect(stop).toHaveBeenCalled();
});

test('reduced/background policy interrupts a sheet and never replays it on resume', () => {
  const view = renderHook(() => useEntranceMotion(true));
  act(() => view.result.current.reveal());
  const animate = jest.mocked(Animated.timing);
  const value = animate.mock.calls[0]![0] as Animated.Value;
  const set = jest.spyOn(value, 'setValue');
  mockReduced = true;
  view.rerender({});
  expect(set).toHaveBeenLastCalledWith(1);
  act(() => view.result.current.reveal());
  expect(animate).toHaveBeenCalledTimes(1);
  mockReduced = false;
  view.rerender({});
  expect(animate).toHaveBeenCalledTimes(1);
});

function Draft() {
  const [value, setValue] = useState('');
  return <TextInput accessibilityLabel="Retained draft" value={value} onChangeText={setValue} />;
}

test('content fade preserves child state, skips initial entry and stops on blur', () => {
  const tree = (selection: string) => (
    <ContentFade selection={selection}>
      <Draft />
    </ContentFade>
  );
  const view = render(tree('Monday'));
  const animate = jest.mocked(Animated.timing);
  expect(animate).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Retained draft'), 'Keep this');
  view.rerender(tree('Tuesday'));
  expect(animate).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Retained draft').props.value).toBe('Keep this');
  const value = animate.mock.calls[0]![0] as Animated.Value;
  const set = jest.spyOn(value, 'setValue');
  act(() => mockBlur?.());
  expect(set).toHaveBeenLastCalledWith(1);
  view.rerender(tree('Wednesday'));
  expect(animate).toHaveBeenCalledTimes(1);
});

test('content changes stay immediate under reduced motion and do not replay on preference change', () => {
  const tree = (selection: string) => (
    <ContentFade selection={selection}>
      <Draft />
    </ContentFade>
  );
  const view = render(tree('Monday'));
  mockReduced = true;
  view.rerender(tree('Tuesday'));
  expect(Animated.timing).not.toHaveBeenCalled();
  mockReduced = false;
  view.rerender(tree('Tuesday'));
  expect(Animated.timing).not.toHaveBeenCalled();
});
