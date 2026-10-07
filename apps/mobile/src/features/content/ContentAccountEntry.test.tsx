import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { Pressable as MockPressable, Text as MockText } from 'react-native';
import { ContentAccountEntry } from './ContentAccountEntry';
import { useContentAccount, type BrowserContentAccountRoot } from './contentAccountContext';
import type { ContentAccountViewSnapshot } from './createContentAccountRuntime';

const mockReplace = jest.fn();
const mockRouter = { replace: mockReplace };
let mockPathname = '/account';
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, usePathname: () => mockPathname }));

jest.mock('./ContentAccountScreen', () => ({
  ContentAccountScreen: () => <MockText>Initial account review</MockText>,
}));
jest.mock('../../components/Page', () => ({
  Page: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../components/ThemeTransition', () => ({
  ThemeTransition: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../design/MotionPolicy', () => ({
  MotionPolicyProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../design/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useThemeMode: () => 'light',
  useThemedStyles: () => ({}),
}));
jest.mock('../app-preferences/AppPreferencesProvider', () => ({
  AppPreferencesProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../components/Typography', () => ({
  AppText: ({ children }: { children: React.ReactNode }) => <MockText>{children}</MockText>,
}));
jest.mock('../../components/Controls', () => ({
  Notice: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <>
      <MockText>{title}</MockText>
      {children}
    </>
  ),
  ActionButton: ({ label, onPress }: { label: string; onPress(): void }) => (
    <MockPressable accessibilityRole="button" onPress={onPress}>
      <MockText>{label}</MockText>
    </MockPressable>
  ),
}));
jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Body() {
  const { reopen, completeCallback, startSignIn } = useContentAccount();
  return (
    <>
      <MockText>Saved cooking</MockText>
      <MockPressable onPress={reopen}>
        <MockText>Reopen</MockText>
      </MockPressable>
      <MockPressable onPress={completeCallback}>
        <MockText>Finish sign-in</MockText>
      </MockPressable>
      <MockPressable onPress={() => startSignIn('google')}>
        <MockText>Renew sign-in</MockText>
      </MockPressable>
    </>
  );
}
function fixture() {
  let view: ContentAccountViewSnapshot = {
    workspace: { kind: 'guest' },
    workspaceGeneration: 1,
    viewGeneration: 1,
  };
  const listeners = new Set<() => void>();
  const state = { phase: 'ready', startupSettled: true };
  const closed = jest.fn(async (): Promise<void> => undefined);
  const callback = jest.fn(async (_href: string): Promise<void> => undefined);
  const signIn = jest.fn(async (): Promise<string | null> => null);
  const open = jest.fn(async () => ({
    kind: 'ready',
    services: { kind: 'content_workspace', access: 'guest', runtime: {}, close: closed },
  }));
  // Component wiring fixture only; real SQLite authority/composition has its separate suite.
  const root = {
    runtime: {
      completeCallback: callback,
      signIn,
      initialize: jest.fn(async () => undefined),
      foreground: jest.fn(async () => undefined),
      preferencesStore: () => ({}),
      subscribe: () => () => undefined,
      getSnapshot: () => state,
    },
    view: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: () => view,
    },
    opener: () => open,
  } as unknown as BrowserContentAccountRoot;
  return {
    root,
    open,
    closed,
    callback,
    signIn,
    renew() {
      view = { ...view, viewGeneration: view.viewGeneration + 1 };
      for (const listener of listeners) listener();
    },
  };
}
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeEach(() => {
  mockPathname = '/account';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      location: {
        href: 'https://fixture.example/auth/callback?code=controlled',
        assign: jest.fn(),
      },
      history: { state: null, replaceState: jest.fn() },
    },
  });
});
afterEach(() => {
  cleanup();
  mockReplace.mockClear();
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('OAuth completion survives its workspace switch once, but never navigates a retired entry', async () => {
  const f = fixture(),
    gate = deferred();
  f.callback.mockImplementationOnce(() => gate.promise);
  const screen = render(<ContentAccountEntry root={f.root} renderWorkspace={() => <Body />} />);
  await act(async () => {});
  fireEvent.press(screen.getByText('Finish sign-in'));
  await act(async () => f.renew());
  fireEvent.press(screen.getByText('Finish sign-in'));
  expect(f.callback).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve());
  expect(mockReplace).toHaveBeenCalledTimes(1);
  expect(mockReplace).toHaveBeenCalledWith('/account');
  screen.unmount();
  mockReplace.mockClear();
  const retired = fixture(),
    pending = deferred();
  retired.callback.mockImplementationOnce(() => pending.promise);
  const next = render(<ContentAccountEntry root={retired.root} renderWorkspace={() => <Body />} />);
  await act(async () => {});
  fireEvent.press(next.getByText('Finish sign-in'));
  next.unmount();
  await act(async () => pending.resolve());
  expect(mockReplace).not.toHaveBeenCalled();
});

test('same-owner access renewal hides old UI and awaits wrapped close before replacement', async () => {
  const f = fixture(),
    gate = deferred();
  f.closed.mockImplementationOnce(() => gate.promise);
  const screen = render(<ContentAccountEntry root={f.root} renderWorkspace={() => <Body />} />);
  await act(async () => {});
  expect(screen.getByText('Saved cooking')).toBeTruthy();
  await act(async () => f.renew());
  expect(screen.queryByText('Saved cooking')).toBeNull();
  expect(f.closed).toHaveBeenCalledTimes(1);
  expect(f.open).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve());
  expect(f.open).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Saved cooking')).toBeTruthy();
});
test('a replaced account root cannot navigate from the prior delayed callback', async () => {
  const first = fixture(),
    second = fixture(),
    gate = deferred();
  first.callback.mockImplementationOnce(() => gate.promise);
  const screen = render(<ContentAccountEntry root={first.root} renderWorkspace={() => <Body />} />);
  await act(async () => {});
  fireEvent.press(screen.getByText('Finish sign-in'));
  screen.rerender(<ContentAccountEntry root={second.root} renderWorkspace={() => <Body />} />);
  await act(async () => gate.resolve());
  expect(mockReplace).not.toHaveBeenCalled();
  expect(first.closed).toHaveBeenCalledTimes(1);
  expect(second.open).toHaveBeenCalledTimes(1);
});
test('OAuth renewal redirects once after the awaiting workspace view is replaced', async () => {
  const f = fixture(),
    gate = deferred();
  f.signIn.mockImplementationOnce(async () => {
    await gate.promise;
    return 'https://provider.example/controlled';
  });
  const screen = render(<ContentAccountEntry root={f.root} renderWorkspace={() => <Body />} />);
  await act(async () => {});
  fireEvent.press(screen.getByText('Renew sign-in'));
  await act(async () => f.renew());
  fireEvent.press(screen.getByText('Renew sign-in'));
  expect(f.signIn).toHaveBeenCalledTimes(1);
  await act(async () => gate.resolve());
  expect(window.location.assign).toHaveBeenCalledTimes(1);
  expect(window.location.assign).toHaveBeenCalledWith('https://provider.example/controlled');
});
test.each(['root', 'navigation', 'unmount'] as const)(
  'OAuth renewal never redirects after %s cancellation',
  async (cancel) => {
    const f = fixture(),
      gate = deferred();
    f.signIn.mockImplementationOnce(async () => {
      await gate.promise;
      return 'https://provider.example/controlled';
    });
    const screen = render(<ContentAccountEntry root={f.root} renderWorkspace={() => <Body />} />);
    await act(async () => {});
    fireEvent.press(screen.getByText('Renew sign-in'));
    if (cancel === 'root')
      screen.rerender(
        <ContentAccountEntry root={fixture().root} renderWorkspace={() => <Body />} />,
      );
    else if (cancel === 'navigation') {
      mockPathname = '/settings';
      screen.rerender(<ContentAccountEntry root={f.root} renderWorkspace={() => <Body />} />);
    } else screen.unmount();
    await act(async () => gate.resolve());
    expect(window.location.assign).not.toHaveBeenCalled();
  },
);
test('deliberate bootstrap reopen uses one close/open, without a premature extra sync', async () => {
  const f = fixture();
  const screen = render(<ContentAccountEntry root={f.root} renderWorkspace={() => <Body />} />);
  await act(async () => {});
  await act(async () => fireEvent.press(screen.getByText('Reopen')));
  expect(f.closed).toHaveBeenCalledTimes(1);
  expect(f.open).toHaveBeenCalledTimes(2);
});
test('failed close keeps retry from opening another workspace', async () => {
  const f = fixture();
  f.closed.mockRejectedValueOnce(new Error('Unconfirmed close'));
  const screen = render(<ContentAccountEntry root={f.root} renderWorkspace={() => <Body />} />);
  await act(async () => {});
  await act(async () => f.renew());
  expect(screen.getByText('This workspace needs recovery')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByText('Retry opening workspace')));
  expect(f.open).toHaveBeenCalledTimes(1);
});
test('late open after unmount is closed without rendering its saved data', async () => {
  const f = fixture(),
    gate = deferred();
  f.open.mockImplementationOnce(async () => {
    await gate.promise;
    return {
      kind: 'ready',
      services: { kind: 'content_workspace', access: 'guest', runtime: {}, close: f.closed },
    };
  });
  const screen = render(<ContentAccountEntry root={f.root} renderWorkspace={() => <Body />} />);
  await act(async () => {});
  screen.unmount();
  await act(async () => gate.resolve());
  expect(f.closed).toHaveBeenCalledTimes(1);
});
