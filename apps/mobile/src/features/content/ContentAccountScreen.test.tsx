import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { catalogue } from '@cookmate/catalogue';
import type { AccountContentSnapshot } from '../../../../../packages/account-sync/src/contentSnapshot';
import { ActionButton } from '../../components/Controls';
import { AccountScopeReviewPanel } from '../account/AccountScopeReviewPanel';
import type { ContentAccountContextValue } from './contentAccountContext';
import type { ContentAccountViewSnapshot } from './createContentAccountRuntime';
import type { ContentWorkspaceState } from './contentWorkspaceHost';
import { ContentAccountScreen } from './ContentAccountScreen';

const mockRouter = { replace: jest.fn(), navigate: jest.fn() };
const mockFocus: { stop?: () => void } = {};
const mockFocusUse = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: (callback: () => () => void) => {
    mockFocusUse();
    jest.requireActual('react').useEffect(() => {
      const stop = callback();
      mockFocus.stop = stop;
      return () => {
        stop();
        delete mockFocus.stop;
      };
    }, [callback]);
  },
}));
jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));
jest.mock('./contentAccountPurchaseDescriptions', () => ({
  buildContentAccountPurchaseDescriptions: jest.fn(async () => ({})),
}));
jest.mock('./contentAccountContext', () => ({ useContentAccount: () => mockData.context }));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

type State = ContentAccountContextValue['state'];
type Runtime = ContentAccountContextValue['root']['runtime'];
const owner = '10000000-0000-4000-8000-000000000001';
function port<F extends (...args: never[]) => unknown>() {
  return jest.fn<ReturnType<F>, Parameters<F>>();
}
function initialState(): State {
  return {
    startupSettled: true,
    phase: 'ready',
    workspace: { kind: 'account', ownerId: owner },
    workspaceKey: `account:${owner}`,
    identity: {
      ownerId: owner,
      email: 'cook@example.test',
      displayName: 'A cook',
      provider: 'google',
    },
    checkingSession: false,
    busy: false,
    error: null,
    sync: { kind: 'local' },
    expandedScopeAvailable: true,
    scopeReview: null,
    earlierDeletions: [],
    deletion: null,
  };
}
// Controlled UI/lifecycle ports. These do not claim service, authentication or signed-content proof.
function fixture(kind: 'content_workspace' | 'account_bootstrap' = 'content_workspace') {
  let state = initialState();
  let view: ContentAccountViewSnapshot = {
    workspace: state.workspace,
    workspaceGeneration: 0,
    viewGeneration: 0,
  };
  let hostState: ContentWorkspaceState = {
    status: 'ready',
    scopeKey: 'owned-host:0',
    pending: null,
    cleanupPending: 0,
  };
  const viewListeners = new Set<() => void>(),
    hostListeners = new Set<() => void>();
  const runtime = {
    getSnapshot: () => state,
    signIn: port<Runtime['signIn']>().mockResolvedValue(null),
    signOut: port<Runtime['signOut']>().mockResolvedValue(undefined),
    syncNow: port<Runtime['syncNow']>(),
    dispatch: port<Runtime['dispatch']>(),
    reviewSyncScope: port<Runtime['reviewSyncScope']>().mockResolvedValue(undefined),
    approveSyncScope: port<Runtime['approveSyncScope']>().mockResolvedValue(undefined),
    cancelSyncScopeReview: port<Runtime['cancelSyncScopeReview']>(),
    reviewDeletion: port<Runtime['reviewDeletion']>().mockResolvedValue(undefined),
    confirmDeletion: port<Runtime['confirmDeletion']>().mockResolvedValue(undefined),
    checkDeletion: port<Runtime['checkDeletion']>().mockResolvedValue(undefined),
    cancelDeletion: port<Runtime['cancelDeletion']>(),
    checkEarlierDeletion: port<Runtime['checkEarlierDeletion']>().mockResolvedValue(undefined),
  };
  const root = {
    runtime,
    configured: true,
    rollout: true,
    availability: { apple: false, google: true },
    view: {
      getSnapshot: () => view,
      subscribe(listener: () => void) {
        viewListeners.add(listener);
        return () => {
          viewListeners.delete(listener);
        };
      },
    },
  };
  const host = {
    getSnapshot: () => hostState,
    subscribe(listener: () => void) {
      hostListeners.add(listener);
      return () => {
        hostListeners.delete(listener);
      };
    },
    content: { readExact: jest.fn() },
  };
  const context = {
    root,
    get state() {
      return state;
    },
    handle:
      kind === 'content_workspace'
        ? { kind: 'content_workspace' as const, runtime: { host } }
        : { kind: 'account_bootstrap' as const },
    opening: false,
    reopen: jest.fn(),
    completeCallback: jest.fn(),
    startSignIn: jest.fn(),
    signInRedirectFailed: false,
  };
  return {
    context,
    runtime,
    setState(next: State) {
      state = next;
    },
    renew() {
      view = { ...view, viewGeneration: view.viewGeneration + 1 };
      viewListeners.forEach((listener) => listener());
    },
    revokeHost() {
      hostState = { ...hostState, status: 'revoked', scopeKey: 'owned-host:1' };
      hostListeners.forEach((listener) => listener());
    },
  };
}
let mockData = fixture();
function press(label: string) {
  const button = screen
    .UNSAFE_getAllByType(ActionButton)
    .find((item) => item.props.label === label);
  if (!button) throw new Error(`Missing ${label}`);
  return button.props.onPress as () => void;
}
beforeEach(() => {
  mockData = fixture();
});
afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

test('unconfigured guest gives local-only notice and never creates a sync claim', () => {
  const state = mockData.context.state;
  mockData.setState({
    ...state,
    workspace: { kind: 'guest' },
    workspaceKey: 'guest',
    identity: null,
  });
  mockData.context.root.configured = false;
  mockData.context.root.rollout = false;
  mockData.context.root.availability.google = false;
  render(<ContentAccountScreen />);
  expect(screen.getByText(/Sign-in and cloud sync are not configured/)).toBeTruthy();
  expect(screen.queryByText('Synced')).toBeNull();
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  expect(mockData.runtime.syncNow).not.toHaveBeenCalled();
});

test('bootstrap cannot keep an unbound local account copy, but explicit removal remains available', () => {
  mockData = fixture('account_bootstrap');
  render(<ContentAccountScreen />);
  expect(mockFocusUse).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
  expect(screen.getByRole('button', { name: 'Keep on this device' })).toBeDisabled();
  expect(screen.getByText(/not yet bound to the account/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Keep on this device' }));
  expect(mockData.runtime.signOut).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Remove account data from this device' }));
  expect(mockData.runtime.signOut).toHaveBeenCalledWith(true);
});

test('bound local copy uses the existing keep action and stale host callback cannot repeat it', () => {
  render(<ContentAccountScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
  const keep = press('Keep on this device');
  act(keep);
  expect(mockData.runtime.signOut).toHaveBeenCalledWith(false);
  act(() => mockData.revokeHost());
  act(keep);
  expect(mockData.runtime.signOut).toHaveBeenCalledTimes(1);
});

test('scope approval forwards the exact issued object and defaults history off', () => {
  const issued = {
    reviewId: '20000000-0000-4000-8000-000000000001',
    ownerId: owner,
    installationId: '30000000-0000-4000-8000-000000000001',
    scopeVersion: 3 as const,
    counts: { notes: 1, collections: 2, memberships: 3, manualItems: 4, cookingHistory: 5 },
    historyIncluded: false,
    previousApprovalDigest: null,
  };
  mockData.setState({ ...mockData.context.state, scopeReview: { kind: 'review', review: issued } });
  render(<ContentAccountScreen />);
  expect(screen.getByRole('checkbox').props.accessibilityState.checked).toBe(false);
  const approve = screen.UNSAFE_getByType(AccountScopeReviewPanel).props.onApprove;
  fireEvent.press(screen.getByRole('button', { name: 'Save sync choices' }));
  expect(mockData.runtime.approveSyncScope).toHaveBeenCalledWith(issued, false);
  expect(mockData.runtime.approveSyncScope.mock.calls[0]?.[0]).toBe(issued);
  mockData.setState({
    ...mockData.context.state,
    scopeReview: { kind: 'review', review: { ...issued } },
  });
  act(() => approve(true));
  expect(mockData.runtime.approveSyncScope).toHaveBeenCalledTimes(1);
});

test('unconfirmed deletion checks and retries the original request as distinct deliberate actions', () => {
  mockData.setState({ ...mockData.context.state, deletion: { kind: 'unconfirmed' } });
  render(<ContentAccountScreen />);
  expect(screen.getByText(/Being signed out is not proof of deletion/)).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Check deletion again' }));
  expect(mockData.runtime.checkDeletion).toHaveBeenCalledTimes(1);
  expect(mockData.runtime.confirmDeletion).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('button', { name: 'Retry the same deletion request' }));
  expect(mockData.runtime.confirmDeletion).toHaveBeenCalledTimes(1);
});

test('reopen review uses only the entry close/open callback', () => {
  mockData = fixture('account_bootstrap');
  mockData.setState({
    ...mockData.context.state,
    sync: {
      kind: 'review',
      phase: 'reopen',
      initial: true,
      reason: 'binding_staged',
      operationId: 'operation',
      requestFingerprint: 'a'.repeat(64),
      canConfirm: false,
    },
  });
  render(<ContentAccountScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Reopen account workspace' }));
  expect(mockData.context.reopen).toHaveBeenCalledTimes(1);
  expect(mockData.runtime.dispatch).not.toHaveBeenCalled();
  expect(mockData.runtime.syncNow).not.toHaveBeenCalled();
});

test('same-owner auth generation renewal retires retained sync and navigation callbacks', () => {
  render(<ContentAccountScreen />);
  const sync = press('Sync now'),
    back = press('Back to CookMate');
  act(() => mockData.renew());
  act(sync);
  act(back);
  expect(mockData.runtime.syncNow).not.toHaveBeenCalled();
  expect(mockRouter.replace).not.toHaveBeenCalled();
});

test('review notes disappear on owner replacement and old choice cannot dispatch', () => {
  const local: AccountContentSnapshot = {
    format: 'cookmate-account-snapshot',
    schemaVersion: 3,
    catalogue: catalogue.identity,
    favourites: [],
    preferences: [],
    plan: [],
    planReferences: [],
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
    shopping: { selectedOccurrenceIds: [], purchaseMarks: [] },
    appPreferences: { theme: 'system', locale: 'system', motion: 'system' },
    profile: { displayName: null },
  };
  mockData.setState({
    ...mockData.context.state,
    sync: {
      kind: 'review',
      phase: 'push',
      initial: false,
      canConfirm: false,
      review: {
        operationId: 'operation',
        initialImportRequired: false,
        comparison: { local, account: local },
        removalReview: null,
        merge: {
          status: 'needs_review',
          notices: [],
          conflicts: [
            {
              id: 'note',
              kind: 'note_edit',
              path: 'personal/notes/one',
              base: null,
              local: {
                noteId: 'note-id',
                recipeId: '90001',
                text: 'Owner private note',
                deleted: false,
                createdAt: '2026-10-02T00:00:00.000Z',
                updatedAt: '2026-10-02T00:00:00.000Z',
              },
              account: null,
            },
          ],
        },
      },
    },
  });
  const view = render(<ContentAccountScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Review differences' }));
  expect(screen.getByText('Owner private note')).toBeTruthy();
  const old = press('Keep this device');
  mockData.setState({
    ...mockData.context.state,
    identity: null,
    workspace: { kind: 'guest' },
    workspaceKey: 'guest',
    sync: { kind: 'local' },
  });
  view.rerender(<ContentAccountScreen />);
  expect(screen.queryByText('Owner private note')).toBeNull();
  act(old);
  expect(mockData.runtime.dispatch).not.toHaveBeenCalled();
});

test('blur retires a retained deletion callback without claiming it was cancelled', () => {
  mockData.setState({ ...mockData.context.state, deletion: { kind: 'unconfirmed' } });
  render(<ContentAccountScreen />);
  const retry = press('Retry the same deletion request');
  act(() => mockFocus.stop?.());
  act(retry);
  expect(mockData.runtime.confirmDeletion).not.toHaveBeenCalled();
  expect(screen.queryByText(/request was cancelled/i)).toBeNull();
});
