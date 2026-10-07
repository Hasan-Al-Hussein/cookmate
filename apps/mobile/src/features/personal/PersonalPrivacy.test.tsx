import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { PersonalPrivacy } from './PersonalPrivacy';

afterEach(cleanup);

test('keeps privacy concise and reveals every backup and storage caveat on request', () => {
  render(<PersonalPrivacy />);
  const summary = 'Private to this workspace.';
  const details = () => screen.getByRole('button', { name: 'Privacy & storage details' });
  expect(screen.getByText(summary)).toBeTruthy();
  expect(details().props.accessibilityState.expanded).toBe(false);
  expect(screen.queryByText(/older core backups exclude/)).toBeNull();

  fireEvent.press(details());
  expect(details().props.accessibilityState.expanded).toBe(true);
  expect(screen.getByText(/not automatically sent to the assistant/)).toBeTruthy();
  expect(screen.getByText(/unencrypted data; older core backups exclude/)).toBeTruthy();
  expect(screen.getByText(/Review the backup’s contents before saving or sharing/)).toBeTruthy();
  expect(
    screen.getByText(/does not erase retained restore archives or files saved elsewhere/),
  ).toBeTruthy();
  expect(screen.getByText(/Clearing app or browser storage can remove local work/)).toBeTruthy();

  fireEvent.press(details());
  expect(details().props.accessibilityState.expanded).toBe(false);
  expect(screen.queryByText(/older core backups exclude/)).toBeNull();
  expect(screen.getByText(summary)).toBeTruthy();
});
