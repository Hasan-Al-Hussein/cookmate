import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import type { AccountRuntimeSnapshot } from './accountRuntime';
import type { AccountProviderName } from './authTypes';
import AccountScreen from './AccountScreen';
import { AccountScopeReviewPanel } from './AccountScopeReviewPanel';
import { SignedInAccountPanel } from './AccountPanels';
import { ActionButton } from '../../components/Controls';
import { focusTarget } from '../../components/focusTarget';
import type { View } from 'react-native';

const mockAccount = jest.fn();
const mockWorkspace = jest.fn();
const mockSignIn = jest.fn(async (_provider: AccountProviderName, _web: boolean) => null);
const mockCheck = jest.fn();
const mockConfirm = jest.fn();
const mockEarlier = jest.fn();
const mockReviewScope = jest.fn();
const mockApproveScope = jest.fn();
const mockCancelScope = jest.fn();
const mockScrollTo = jest.fn();
jest.mock('./accountContext', () => ({ useAccount: () => mockAccount() }));
jest.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => mockWorkspace() }));
jest.mock('../../domain/commandPlatform', () => ({ nativeCommandPlatform: { sha256: jest.fn() } }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), navigate: jest.fn() }),
}));
jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));
jest.mock('../../components/focusTarget', () => ({ focusTarget: jest.fn(() => true) }));
jest.mock('../../components/Page', () => {
  const { useImperativeHandle } = require('react');
  const { View } = require('react-native');
  return {
    Page: ({ children, scrollRef, onScroll }: any) => {
      useImperativeHandle(scrollRef, () => ({ scrollTo: mockScrollTo }), []);
      return (
        <View testID="account-page" onScroll={onScroll}>
          {children}
        </View>
      );
    },
    PageHeader: () => null,
  };
});
const pendingState: AccountRuntimeSnapshot = {
  phase: 'ready',
  workspace: { kind: 'account', ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  workspaceKey: 'account:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  identity: null,
  checkingSession: false,
  busy: false,
  error: null,
  sync: { kind: 'local' },
  deletion: { kind: 'unconfirmed' },
};
function setup(state = pendingState, configured = true) {
  mockAccount.mockReturnValue({
    state,
    configured,
    availability: { apple: true, google: true },
    runtime: {
      signIn: mockSignIn,
      checkDeletion: mockCheck,
      confirmDeletion: mockConfirm,
      checkEarlierDeletion: mockEarlier,
      reviewSyncScope: mockReviewScope,
      approveSyncScope: mockApproveScope,
      cancelSyncScopeReview: mockCancelScope,
      syncNow: jest.fn(),
    },
  });
  mockWorkspace.mockReturnValue({ availability: { kind: 'ready' }, retryOpen: jest.fn() });
}
beforeEach(() => {
  jest.clearAllMocks();
  setup();
});
afterEach(cleanup);

const signedState = (changes: Partial<AccountRuntimeSnapshot> = {}): AccountRuntimeSnapshot => ({
  ...pendingState,
  identity: {
    ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    provider: 'google',
    email: null,
    displayName: null,
  },
  deletion: null,
  expandedScopeAvailable: true,
  scopeReview: null,
  ...changes,
});
const scopeReview = {
  reviewId: 'review-1',
  ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  counts: { notes: 1, collections: 2, memberships: 3, manualItems: 4, cookingHistory: 5 },
  historyIncluded: false,
  previousApprovalDigest: null,
};

test('signed-in capability exposes an explicit scope review without starting it automatically', () => {
  setup(signedState());
  render(<AccountScreen />);
  expect(mockReviewScope).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Sync choices' }));
  expect(mockReviewScope).toHaveBeenCalledTimes(1);
  expect(mockApproveScope).not.toHaveBeenCalled();
});

test('the issued scope review dispatches the chosen history flag and never claims cloud success', () => {
  setup(signedState({ scopeReview: { kind: 'review', review: scopeReview } }));
  render(<AccountScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Save sync choices' }));
  expect(mockApproveScope).toHaveBeenCalledWith(scopeReview, false);
  expect(screen.queryByText('Synced')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
});

test('a retained approval callback remains bound to its original rendered review', () => {
  setup(signedState({ scopeReview: { kind: 'review', review: scopeReview } }));
  const view = render(<AccountScreen />);
  const earlierApproval = screen.UNSAFE_getByType(AccountScopeReviewPanel).props.onApprove;
  const current = { ...scopeReview, reviewId: 'review-2' };
  setup(signedState({ scopeReview: { kind: 'review', review: current } }));
  view.rerender(<AccountScreen />);
  earlierApproval(true);
  expect(mockApproveScope).toHaveBeenLastCalledWith(scopeReview, true);
  fireEvent.press(screen.getByRole('button', { name: 'Save sync choices' }));
  expect(mockApproveScope).toHaveBeenLastCalledWith(current, false);
});

test.each(['status', 'settings'] as const)(
  'scope review restores the %s invoker before the delayed coordinator result',
  (entry) => {
    jest.useFakeTimers();
    try {
      const account = signedState({
        sync: { kind: 'failed', reason: 'scope_review_required', pending: false },
      });
      setup(account);
      const view = render(<AccountScreen />);
      fireEvent.scroll(screen.getByTestId('account-page'), {
        nativeEvent: { contentOffset: { x: 0, y: 620 } },
      });
      fireEvent.press(
        screen.getByRole('button', {
          name: entry === 'status' ? 'Review sync choices' : 'Sync choices',
        }),
      );
      setup({ ...account, scopeReview: { kind: 'review', review: scopeReview } });
      view.rerender(<AccountScreen />);
      act(() => jest.runOnlyPendingTimers());
      expect(mockScrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
      fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      setup({ ...account, sync: { kind: 'local' } });
      view.rerender(<AccountScreen />);
      const panel = screen.UNSAFE_getByType(SignedInAccountPanel).props;
      const statusControl = screen
        .UNSAFE_getAllByType(ActionButton)
        .find((button) => button.props.label === 'Sync now')!;
      expect(statusControl.props.ref === panel.scopeReviewButtonRef).toBe(true);
      const statusTarget = { entry: 'status' } as unknown as View;
      const settingsTarget = { entry: 'settings' } as unknown as View;
      panel.scopeReviewButtonRef.current = statusTarget;
      panel.scopeButtonRef.current = settingsTarget;
      act(() => jest.runOnlyPendingTimers());
      expect(mockScrollTo).toHaveBeenLastCalledWith({ y: 620, animated: false });
      expect(focusTarget).toHaveBeenLastCalledWith(
        entry === 'status' ? statusTarget : settingsTarget,
      );
      const focusCalls = jest.mocked(focusTarget).mock.calls.length;
      // The coordinator returns after focus has already been restored to Sync now.
      setup(account);
      view.rerender(<AccountScreen />);
      const resolvedStatusControl = screen
        .UNSAFE_getAllByType(ActionButton)
        .find((button) => button.props.label === 'Review sync choices');
      expect(resolvedStatusControl === statusControl).toBe(true);
      act(() => jest.runOnlyPendingTimers());
      expect(focusTarget).toHaveBeenCalledTimes(focusCalls);
    } finally {
      jest.useRealTimers();
    }
  },
);

test('loading approval exposes no cancel or apparent usable approval control', () => {
  setup(signedState({ busy: true, scopeReview: { kind: 'loading' } }));
  render(<AccountScreen />);
  expect(screen.getByText('Checking sync choices…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save sync choices' })).toBeNull();
});

test('stale review offers a new review, while pending work routes back to account recovery', () => {
  setup(signedState({ scopeReview: { kind: 'failed', reason: 'local_changed' } }));
  const view = render(<AccountScreen />);
  expect(screen.getByText(/Review the current counts/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Review sync choices again' }));
  expect(mockReviewScope).toHaveBeenCalledTimes(1);
  setup(signedState({ scopeReview: { kind: 'failed', reason: 'operation_pending' } }));
  view.rerender(<AccountScreen />);
  expect(screen.queryByRole('button', { name: 'Review sync choices again' })).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Back to account' }));
  expect(mockCancelScope).toHaveBeenCalledTimes(1);
  expect(mockApproveScope).not.toHaveBeenCalled();
});

test('an old owner’s review is never displayed in the current signed-in account', () => {
  setup(
    signedState({
      scopeReview: {
        kind: 'review',
        review: { ...scopeReview, ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
    }),
  );
  render(<AccountScreen />);
  expect(screen.queryByRole('button', { name: 'Save sync choices' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Sync choices' })).toBeTruthy();
});

test('signed-out pending deletion offers explicit recovery sign-in without resending', () => {
  render(<AccountScreen />);
  expect(screen.getByText(/Signing in does not send it automatically/)).toBeTruthy();
  expect(mockSignIn).not.toHaveBeenCalled();
  fireEvent.press(
    screen.getByRole('button', { name: 'Continue with Google to recover this request' }),
  );
  expect(mockSignIn.mock.calls[0]?.[0]).toBe('google');
  expect(mockConfirm).not.toHaveBeenCalled();
});

test('status recovery remains available when the cooking database cannot open', () => {
  mockWorkspace.mockReturnValue({ availability: { kind: 'failed', error: { retry: 'never' } } });
  render(<AccountScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Check deletion again' }));
  expect(mockCheck).toHaveBeenCalledTimes(1);
  expect(mockConfirm).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Continue with Apple to recover this request' }),
  ).toBeDisabled();
});

test('unconfigured recovery keeps its explanation and never invents provider availability', () => {
  setup(pendingState, false);
  render(<AccountScreen />);
  expect(screen.getByText(/Account sign-in is not configured in this build/)).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Continue with Google to recover this request' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete my CookMate cloud account' })).toBeNull();
});

test('a renewed-sign-in request remains separate from an explicit deletion retry', () => {
  setup({
    ...pendingState,
    identity: {
      ownerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      provider: 'google',
      email: null,
      displayName: null,
    },
    deletion: { kind: 'unconfirmed', reason: 'recent_sign_in_required' },
  });
  render(<AccountScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Continue with Google to renew sign-in' }));
  expect(mockSignIn).toHaveBeenCalledTimes(1);
  expect(mockConfirm).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Retry the same deletion request' }));
  expect(mockConfirm).toHaveBeenCalledTimes(1);
});

test('an earlier account request has a separate status-only action', () => {
  const earlierOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  setup({
    ...pendingState,
    earlierDeletions: [
      {
        ownerId: earlierOwner,
        operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        status: 'unconfirmed',
      },
    ],
  });
  render(<AccountScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Check earlier deletion request 1' }));
  expect(mockEarlier).toHaveBeenCalledWith(earlierOwner);
  expect(mockConfirm).not.toHaveBeenCalled();
  expect(mockSignIn).not.toHaveBeenCalled();
  expect(mockCheck).not.toHaveBeenCalled();
});
