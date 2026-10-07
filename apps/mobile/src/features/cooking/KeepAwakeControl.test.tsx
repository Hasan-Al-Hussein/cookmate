import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake, isAvailableAsync } from 'expo-keep-awake';
import { KeepAwakeControl } from './KeepAwakeControl';
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(),
  deactivateKeepAwake: jest.fn(),
  isAvailableAsync: jest.fn(),
}));
const activate = jest.mocked(activateKeepAwakeAsync);
const deactivate = jest.mocked(deactivateKeepAwake);
const available = jest.mocked(isAvailableAsync);
const initialPlatform = Platform.OS;
const initialState = AppState.currentState;
let change: ((state: AppStateStatus) => void) | undefined;
const remove = jest.fn();
beforeEach(() => {
  Platform.OS = 'ios';
  AppState.currentState = 'active';
  activate.mockReset().mockResolvedValue();
  deactivate.mockReset().mockResolvedValue();
  available.mockReset().mockResolvedValue(true);
  remove.mockClear();
  change = undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    change = listener;
    return { remove };
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  Platform.OS = initialPlatform;
  AppState.currentState = initialState;
});

test('off by default, acquires only on explicit choice, and releases on close', async () => {
  const view = render(<KeepAwakeControl visible />);
  await act(async () => {});
  expect(activate).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Keep screen awake' })));
  expect(screen.getByText('Screen stays awake while this cooking view is active.')).toBeTruthy();
  view.rerender(<KeepAwakeControl visible={false} />);
  await act(async () => {});
  expect(deactivate).toHaveBeenCalledWith(activate.mock.calls[0]?.[0]);
  view.rerender(<KeepAwakeControl visible />);
  expect(screen.getByRole('button', { name: 'Keep screen awake' })).toBeTruthy();
});

test('late activation cannot release a newer foreground lease or leak after unmount', async () => {
  let finishOld: (() => void) | undefined;
  activate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishOld = resolve;
      }),
  );
  const view = render(<KeepAwakeControl visible />);
  await act(async () => {});
  fireEvent.press(screen.getByRole('button', { name: 'Keep screen awake' }));
  act(() => change?.('background'));
  await act(async () => change?.('active'));
  expect(activate).toHaveBeenCalledTimes(2);
  const first = activate.mock.calls[0]?.[0];
  const second = activate.mock.calls[1]?.[0];
  expect(first).not.toBe(second);
  await act(async () => finishOld?.());
  expect(deactivate).toHaveBeenCalledWith(first);
  expect(deactivate).not.toHaveBeenCalledWith(second);
  view.unmount();
  expect(deactivate).toHaveBeenCalledWith(second);
  expect(remove).toHaveBeenCalled();
});

test('an unavailable or failed native control never claims the screen is held awake', async () => {
  activate.mockRejectedValueOnce(new Error('unavailable'));
  render(<KeepAwakeControl visible />);
  await act(async () => {});
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Keep screen awake' })));
  expect(screen.queryByText('Screen stays awake while this cooking view is active.')).toBeNull();
  expect(
    screen.getByText(
      'Couldn’t keep the screen awake. Your normal screen-lock settings still apply.',
    ),
  ).toBeTruthy();
});

test('browser does not request or imply a native screen lock', async () => {
  Platform.OS = 'web';
  render(<KeepAwakeControl visible />);
  await act(async () => {});
  expect(available).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).toBeNull();
});
