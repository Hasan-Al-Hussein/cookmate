import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { WelcomeAccountPanel, type WelcomeAccountPanelProps } from './WelcomeAccountPanel';

jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));
afterEach(cleanup);

function props(): WelcomeAccountPanelProps {
  return {
    appleAvailable: false,
    googleAvailable: false,
    busy: false,
    availabilityNotice: null,
    error: null,
    onApple: jest.fn(),
    onGoogle: jest.fn(),
    onContinueGuest: jest.fn(),
    onPrivacy: jest.fn(),
  };
}

test('unavailable providers cannot dispatch and do not obstruct guest or privacy entry', () => {
  const callbacks = props();
  render(<WelcomeAccountPanel {...callbacks} />);
  for (const name of ['Apple', 'Google']) {
    const button = screen.getByRole('button', { name: `Continue with ${name}` });
    expect(button).toBeDisabled();
    fireEvent.press(button);
  }
  expect(callbacks.onApple).not.toHaveBeenCalled();
  expect(callbacks.onGoogle).not.toHaveBeenCalled();
  expect(screen.getByText(/Apple and Google sign-in are unavailable/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Continue as guest' }));
  fireEvent.press(screen.getByRole('button', { name: 'Privacy & data' }));
  expect(callbacks.onContinueGuest).toHaveBeenCalledTimes(1);
  expect(callbacks.onPrivacy).toHaveBeenCalledTimes(1);
});

test('availability changes enable only the configured provider', () => {
  const callbacks = props();
  const view = render(<WelcomeAccountPanel {...callbacks} appleAvailable />);
  fireEvent.press(screen.getByRole('button', { name: 'Continue with Apple' }));
  expect(callbacks.onApple).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  view.rerender(<WelcomeAccountPanel {...callbacks} googleAvailable />);
  expect(screen.getByRole('button', { name: 'Continue with Apple' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(callbacks.onGoogle).toHaveBeenCalledTimes(1);
});

test('pending sign-in prevents duplicate requests while keeping guest and privacy usable', () => {
  const callbacks = props();
  render(<WelcomeAccountPanel {...callbacks} appleAvailable googleAvailable busy />);
  for (const name of ['Apple', 'Google']) {
    const button = screen.getByRole('button', { name: `Continue with ${name}` });
    expect(button).toBeDisabled();
    fireEvent.press(button);
  }
  expect(callbacks.onApple).not.toHaveBeenCalled();
  expect(callbacks.onGoogle).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Continue as guest' }));
  fireEvent.press(screen.getByRole('button', { name: 'Privacy & data' }));
  expect(callbacks.onContinueGuest).toHaveBeenCalledTimes(1);
  expect(callbacks.onPrivacy).toHaveBeenCalledTimes(1);
});

test('a sign-in failure preserves the guest choice and supplied environment explanation', () => {
  const callbacks = props();
  render(
    <WelcomeAccountPanel
      {...callbacks}
      availabilityNotice="Cloud sign-in is not configured in this build."
      error="The sign-in service could not be reached."
    />,
  );
  expect(screen.getByText('Cloud sign-in is not configured in this build.')).toBeTruthy();
  expect(screen.getByText('The sign-in service could not be reached.')).toBeTruthy();
  expect(screen.getByText(/Signing in does not enable AI sharing/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Continue as guest' }));
  expect(callbacks.onContinueGuest).toHaveBeenCalledTimes(1);
});
