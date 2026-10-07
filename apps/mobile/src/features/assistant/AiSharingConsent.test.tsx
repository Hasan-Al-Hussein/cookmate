import { fireEvent, render } from '@testing-library/react-native';
import { AiSharingConsent } from './AiSharingConsent';
import type { AiConsentState } from './aiConsent';

const mockDecide = jest.fn();
const mockRetry = jest.fn();
const mockSend = jest.fn();
let mockConsent: AiConsentState | undefined;
jest.mock('./useAssistant', () => ({
  useAssistant: () => ({
    assistant: { aiConsent: { decide: mockDecide, retry: mockRetry }, send: mockSend },
    state: { aiConsent: mockConsent },
  }),
}));

test('the explicit choice names Gemini and its data scope; granting never sends a message', () => {
  mockConsent = { status: 'required' };
  const screen = render(<AiSharingConsent compact />);
  expect(screen.getByText(/relevant conversation context/)).toBeTruthy();
  expect(screen.getByText(/human reviewers may see them/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Allow this data to be sent to Gemini' }));
  expect(mockDecide).toHaveBeenCalledWith(true);
  expect(mockSend).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Keep AI sharing off' }));
  expect(mockDecide).toHaveBeenLastCalledWith(false);
});

test('accepted consent is quiet in chat but remains withdrawable in Settings', () => {
  mockConsent = { status: 'allowed', acceptedAt: '2026-09-30T12:00:00.000Z' };
  const screen = render(<AiSharingConsent compact />);
  expect(screen.queryByText('AI data sharing')).toBeNull();
  screen.rerender(<AiSharingConsent />);
  fireEvent.press(screen.getByRole('button', { name: 'Stop sharing with AI' }));
  expect(mockDecide).toHaveBeenCalledWith(false);
});

test('unconfirmed storage offers recovery without a misleading saved or allowed state', () => {
  mockConsent = { status: 'error' };
  const screen = render(<AiSharingConsent />);
  expect(screen.getByText(/an earlier choice may still be stored/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Allow this data to be sent to Gemini' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Retry saving or reading choice' }));
  expect(mockRetry).toHaveBeenCalledTimes(1);
});

test('an unavailable browser controller never presents a functional consent claim', () => {
  mockConsent = undefined;
  const screen = render(<AiSharingConsent />);
  expect(screen.queryByText('AI data sharing')).toBeNull();
});
