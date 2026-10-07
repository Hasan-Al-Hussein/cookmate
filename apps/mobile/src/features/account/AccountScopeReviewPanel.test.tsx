import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { AccountScopeApprovalReview } from '../../data/accountScopeApproval';
import { AccountScopeReviewPanel } from './AccountScopeReviewPanel';
import type { AccountScopeReviewPanelProps } from './AccountScopeReviewPanel';
import { Platform } from 'react-native';

jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));
jest.mock('../../components/focusTarget', () => ({ focusTarget: jest.fn(() => true) }));
afterEach(cleanup);

test('web Space toggles once without scrolling; repeat, busy and Enter do not use this fallback', () => {
  const nativeOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    const input = props();
    const view = render(<AccountScopeReviewPanel {...input} />);
    const preventDefault = jest.fn();
    const press = (key: string, repeat = false) =>
      fireEvent(screen.getByRole('checkbox'), 'keyDown', { key, repeat, preventDefault });
    press(' ');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    press(' ', true);
    expect(screen.getByRole('checkbox')).toBeChecked();
    press('Enter');
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(preventDefault).toHaveBeenCalledTimes(2);
    press('Spacebar');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    view.rerender(<AccountScopeReviewPanel {...input} busy />);
    press(' ');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(input.onApprove).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: nativeOS });
  }
});

const review = (changes: Partial<AccountScopeApprovalReview> = {}): AccountScopeApprovalReview => ({
  reviewId: 'review-a',
  ownerId: 'owner-a',
  historyIncluded: false,
  previousApprovalDigest: null,
  counts: { notes: 2, collections: 1, memberships: 3, manualItems: 4, cookingHistory: 5 },
  ...changes,
});
const props = (): AccountScopeReviewPanelProps => ({
  review: review(),
  onApprove: jest.fn(),
  onCancel: jest.fn(),
});

test('first review shows exact saved counts, history off and clear scope boundaries without auto-approval', () => {
  const input = props();
  render(<AccountScopeReviewPanel {...input} />);
  for (const label of [
    'Recipe notes: 2',
    'Collections: 1',
    'Recipes in collections: 3',
    'Manual shopping items: 4',
  ])
    expect(screen.getByLabelText(label)).toBeTruthy();
  expect(
    screen.getByRole('checkbox', { name: 'Include cooking history, 5 saved entries' }),
  ).not.toBeChecked();
  expect(screen.getByText(/does not confirm a cloud backup/)).toBeTruthy();
  expect(screen.getByText(/Assistant conversations and drafts, passwords/)).toBeTruthy();
  expect(screen.getByText(/do not share anything with a household/)).toBeTruthy();
  expect(input.onApprove).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Save sync choices' }));
  expect(input.onApprove).toHaveBeenCalledWith(false);
  expect(screen.queryByText('Synced')).toBeNull();
});

test('history opt-in is an unsaved explicit choice and cancellation grants no approval', () => {
  const input = props();
  render(<AccountScopeReviewPanel {...input} />);
  fireEvent.press(screen.getByRole('checkbox'));
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(input.onApprove).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
  expect(input.onCancel).toHaveBeenCalledTimes(1);
  expect(input.onApprove).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Save sync choices' }));
  expect(input.onApprove).toHaveBeenCalledWith(true);
});

test('a fresh review or different owner discards the previous unsaved history choice', () => {
  const input = props();
  const view = render(<AccountScopeReviewPanel {...input} />);
  fireEvent.press(screen.getByRole('checkbox'));
  view.rerender(<AccountScopeReviewPanel {...input} review={review({ reviewId: 'review-b' })} />);
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  fireEvent.press(screen.getByRole('checkbox'));
  view.rerender(
    <AccountScopeReviewPanel
      {...input}
      review={review({ ownerId: 'owner-b', reviewId: 'review-c' })}
    />,
  );
  expect(screen.getByRole('checkbox')).not.toBeChecked();
});

test('an existing history choice is shown and switching it off does not promise cloud deletion', () => {
  const input = props();
  render(
    <AccountScopeReviewPanel
      {...input}
      review={review({ historyIncluded: true, previousApprovalDigest: 'prior-digest' })}
    />,
  );
  expect(screen.getByText('Review sync choices')).toBeTruthy();
  expect(screen.getByRole('checkbox')).toBeChecked();
  fireEvent.press(screen.getByRole('checkbox'));
  expect(
    screen.getByText(
      /Clearing local history reaches the account only through a later confirmed history sync/,
    ),
  ).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Save sync choices' }));
  expect(input.onApprove).toHaveBeenCalledWith(false);
});

test('busy state prevents changes, repeated approval and cancellation', () => {
  const input = props();
  render(<AccountScopeReviewPanel {...input} busy />);
  for (const target of [screen.getByRole('checkbox'), ...screen.getAllByRole('button')]) {
    expect(target).toBeDisabled();
    fireEvent.press(target);
  }
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(input.onApprove).not.toHaveBeenCalled();
  expect(input.onCancel).not.toHaveBeenCalled();
});

test('zero counts remain truthful and a single history entry uses the singular label', () => {
  render(
    <AccountScopeReviewPanel
      {...props()}
      review={review({
        counts: { notes: 0, collections: 0, memberships: 0, manualItems: 0, cookingHistory: 1 },
      })}
    />,
  );
  expect(screen.getByLabelText('Recipe notes: 0')).toBeTruthy();
  expect(
    screen.getByRole('checkbox', { name: 'Include cooking history, 1 saved entry' }),
  ).not.toBeChecked();
});
