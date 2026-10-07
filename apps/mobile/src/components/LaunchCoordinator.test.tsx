import { Platform, Text } from 'react-native';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import * as SplashScreen from 'expo-splash-screen';
import {
  BootstrapLaunchCoordinator,
  LaunchCoordinator,
  LaunchRecoverySurface,
} from './LaunchCoordinator';
import { motionTokens } from '../design/motion';

let mockAvailability: 'opening' | 'ready' | 'failed' = 'opening';
let mockReduced = true;
jest.mock('../features/workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({ availability: { kind: mockAvailability } }),
}));
jest.mock('../hooks/useNativeLayout', () => ({ useReducedMotion: () => mockReduced }));
jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn(async () => true),
  setOptions: jest.fn(),
  hideAsync: jest.fn(async () => undefined),
}));

const originalPlatform = Platform.OS;
const layout = { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } };

beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.clearAllMocks();
  mockAvailability = 'opening';
  mockReduced = true;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
});

function app(fontSettled = true) {
  return (
    <BootstrapLaunchCoordinator>
      <LaunchCoordinator fontSettled={fontSettled}>
        <Text>Rendered cooking screen</Text>
      </LaunchCoordinator>
    </BootstrapLaunchCoordinator>
  );
}

test('ready content releases on its first layout without waiting for a branding timer', () => {
  mockAvailability = 'ready';
  mockReduced = false;
  const view = render(app());
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  fireEvent(view.getByTestId('launch-application-surface'), 'layout', layout);
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  expect(SplashScreen.setOptions).toHaveBeenLastCalledWith({
    fade: true,
    duration: motionTokens.duration.launchExit,
  });
  expect(jest.getTimerCount()).toBe(0);
});

test('a gate can withhold the entire app shell without stranding the native splash', () => {
  const view = render(
    <BootstrapLaunchCoordinator>
      <Text>Opening account settings…</Text>
    </BootstrapLaunchCoordinator>,
  );
  fireEvent(view.getByTestId('launch-bootstrap-surface'), 'layout', layout);
  act(() => jest.advanceTimersByTime(3999));
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  expect(SplashScreen.setOptions).toHaveBeenLastCalledWith({ fade: false, duration: 0 });
  expect(view.getByText('Opening account settings…')).toBeTruthy();
});

test('an expired startup deadline still waits for a rendered surface', () => {
  const view = render(
    <BootstrapLaunchCoordinator>
      <Text>Opening CookMate…</Text>
    </BootstrapLaunchCoordinator>,
  );
  act(() => jest.advanceTimersByTime(4000));
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  fireEvent(view.getByTestId('launch-bootstrap-surface'), 'layout', layout);
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
});

test('pre-provider recovery releases immediately only after its recovery layout', () => {
  const tree = (failed: boolean) => (
    <BootstrapLaunchCoordinator>
      <LaunchRecoverySurface recoveryReady={failed} testID="account-status">
        <Text>
          {failed ? 'Account settings need recovery. Retry.' : 'Opening account settings…'}
        </Text>
      </LaunchRecoverySurface>
    </BootstrapLaunchCoordinator>
  );
  const view = render(tree(false));
  fireEvent(view.getByTestId('account-status'), 'layout', layout);
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  view.rerender(tree(true));
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  fireEvent(view.getByTestId('account-status'), 'layout', layout);
  expect(view.getByText('Account settings need recovery. Retry.')).toBeTruthy();
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  expect(SplashScreen.setOptions).toHaveBeenLastCalledWith({ fade: false, duration: 0 });
  expect(jest.getTimerCount()).toBe(0);
});

test('workspace recovery does not wait for unresolved fonts', () => {
  mockAvailability = 'failed';
  const view = render(app(false));
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  fireEvent(view.getByTestId('launch-application-surface'), 'layout', layout);
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
});

test('a late font result uses the current reduced-motion policy and releases only once', () => {
  mockAvailability = 'ready';
  mockReduced = false;
  const view = render(app(false));
  fireEvent(view.getByTestId('launch-application-surface'), 'layout', layout);
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  mockReduced = true;
  view.rerender(app(true));
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  expect(SplashScreen.setOptions).toHaveBeenLastCalledWith({ fade: false, duration: 0 });
  mockAvailability = 'opening';
  mockReduced = false;
  view.rerender(app());
  mockAvailability = 'ready';
  view.rerender(app());
  act(() => jest.advanceTimersByTime(4000));
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
});

test('slow startup has one absolute deadline across gate and motion changes', () => {
  const view = render(app(false));
  fireEvent(view.getByTestId('launch-bootstrap-surface'), 'layout', layout);
  fireEvent(view.getByTestId('launch-application-surface'), 'layout', layout);
  act(() => jest.advanceTimersByTime(3000));
  mockReduced = false;
  view.rerender(app());
  act(() => jest.advanceTimersByTime(999));
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
  expect(SplashScreen.setOptions).toHaveBeenLastCalledWith({ fade: false, duration: 0 });
  mockAvailability = 'ready';
  view.rerender(app());
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
});

test('unmount cancels the pending safety deadline', () => {
  const view = render(app(false));
  expect(jest.getTimerCount()).toBe(1);
  view.unmount();
  expect(jest.getTimerCount()).toBe(0);
  act(() => jest.advanceTimersByTime(4000));
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
});

test('web presentation does not start native splash work or a startup timer', () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  mockAvailability = 'ready';
  const view = render(app());
  fireEvent(view.getByTestId('launch-bootstrap-surface'), 'layout', layout);
  fireEvent(view.getByTestId('launch-application-surface'), 'layout', layout);
  expect(jest.getTimerCount()).toBe(0);
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
  expect(SplashScreen.setOptions).not.toHaveBeenCalled();
});
