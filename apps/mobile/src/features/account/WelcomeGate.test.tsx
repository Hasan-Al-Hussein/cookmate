import { useEffect } from 'react';
import { Text } from 'react-native';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { createFirstRunWelcome } from './firstRunWelcome';
import { WelcomeGate } from './WelcomeGate';

const mockAccount = jest.fn();
const mockWorkspace = jest.fn();
const mockPath = jest.fn();
const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockSignIn = jest.fn(async () => null);
jest.mock('./accountContext', () => ({ useAccount: () => mockAccount() }));
jest.mock('../workspace/WorkspaceProvider', () => ({ useWorkspace: () => mockWorkspace() }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => mockPath(),
}));
jest.mock('../../design/MotionPolicy', () => ({ useMotionPolicy: () => true }));
jest.mock('../../components/focusTarget', () => ({ focusTarget: jest.fn() }));
jest.mock('../../components/Page', () => ({ Page: require('react-native').View }));
const state = {
  startupSettled: true,
  error: null,
  workspace: { kind: 'guest' },
  checkingSession: false,
  identity: null,
  deletion: null,
  busy: false,
};
async function setup(saveDecision = async () => undefined) {
  const welcome = await createFirstRunWelcome({
    hasPriorEvidence: async () => false,
    saveDecision,
  });
  welcome.observeGuestStore('created');
  mockAccount.mockReturnValue({
    welcome,
    runtime: { signIn: mockSignIn },
    state,
    configured: true,
    availability: { apple: true, google: true },
  });
  mockWorkspace.mockReturnValue({
    availability: { kind: 'ready' },
    recoveryState: { kind: 'ready', page: { entries: [], nextAfterSequence: null } },
  });
  mockPath.mockReturnValue('/');
  return welcome;
}
beforeEach(() => jest.clearAllMocks());
afterEach(cleanup);
test('continuing as guest dismisses welcome without remounting the app', async () => {
  const welcome = await setup();
  let mounts = 0;
  function App() {
    useEffect(() => {
      mounts++;
    }, []);
    return <Text>Existing app tree</Text>;
  }
  render(
    <WelcomeGate>
      <App />
    </WelcomeGate>,
  );
  await act(async () => fireEvent.press(screen.getByRole('button', { name: 'Continue as guest' })));
  expect(welcome.getSnapshot()).toBe(false);
  expect(mounts).toBe(1);
  expect(mockReplace).toHaveBeenCalledWith('/');
  expect(mockSignIn).not.toHaveBeenCalled();
});
test.each(['/auth/callback', '/account/callback', '/settings', '/recipe/53064'])(
  'never covers a deep link or recovery destination: %s',
  async (path) => {
    await setup();
    mockPath.mockReturnValue(path);
    render(
      <WelcomeGate>
        <Text>Existing app tree</Text>
      </WelcomeGate>,
    );
    expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull();
  },
);
test('Privacy opens its real section without consuming the welcome decision', async () => {
  const welcome = await setup();
  render(
    <WelcomeGate>
      <Text>App</Text>
    </WelcomeGate>,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Privacy & data' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/settings', params: { section: 'privacy' } });
  expect(welcome.getSnapshot()).toBe(true);
});
test('provider flow starts once without waiting for optional welcome persistence', async () => {
  let release!: () => void;
  await setup(
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
  );
  render(
    <WelcomeGate>
      <Text>App</Text>
    </WelcomeGate>,
  );
  fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(mockPush).toHaveBeenCalledWith('/account');
  expect(mockSignIn).toHaveBeenCalledTimes(1);
  await act(async () => {
    release();
  });
  expect(mockSignIn).toHaveBeenCalledTimes(1);
});
test('pending recovery and authenticated state bypass welcome', async () => {
  for (const override of [
    { ...state, startupSettled: false },
    { ...state, error: 'storage' },
    { ...state, checkingSession: true },
    { ...state, identity: { ownerId: 'a' } },
    { ...state, deletion: { kind: 'unconfirmed' } },
    { ...state, earlierDeletions: [{ ownerId: 'a' }] },
  ]) {
    await setup();
    mockAccount.mockReturnValue({ ...mockAccount(), state: override });
    const view = render(
      <WelcomeGate>
        <Text>App</Text>
      </WelcomeGate>,
    );
    expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull();
    view.unmount();
  }
  await setup();
  mockWorkspace.mockReturnValue({
    availability: { kind: 'ready' },
    recoveryState: { kind: 'loading' },
  });
  render(
    <WelcomeGate>
      <Text>App</Text>
    </WelcomeGate>,
  );
  expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull();
});

test('authentication through another route permanently retires this launch offer', async () => {
  const welcome = await setup();
  mockPath.mockReturnValue('/account');
  mockAccount.mockReturnValue({
    ...mockAccount(),
    state: { ...state, identity: { ownerId: 'a' }, workspace: { kind: 'account' } },
  });
  const view = render(
    <WelcomeGate>
      <Text>App</Text>
    </WelcomeGate>,
  );
  expect(welcome.getSnapshot()).toBe(false);
  mockPath.mockReturnValue('/');
  mockAccount.mockReturnValue({ ...mockAccount(), state });
  view.rerender(
    <WelcomeGate>
      <Text>App</Text>
    </WelcomeGate>,
  );
  expect(screen.queryByRole('button', { name: 'Continue as guest' })).toBeNull();
});
