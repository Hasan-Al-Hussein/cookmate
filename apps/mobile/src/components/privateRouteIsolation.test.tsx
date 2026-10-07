import { cleanup, render } from '@testing-library/react-native';
import RootLayout from '../../app/_layout';

// Root isolation does not perform signature verification; its actual implementation has separate Node coverage.
jest.mock('@cookmate/catalogue/content-trust', () => ({ createContentTrustVerifier: jest.fn() }));

let mockPath = '/private-content';
const mockOrdinaryAccount = jest.fn();
const mockOrdinaryStore = jest.fn();
jest.mock('expo-router', () => ({
  usePathname: () => mockPath,
  Stack: () => null,
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
}));
jest.mock('../features/account/AccountProvider', () => ({
  AccountProvider: () => {
    mockOrdinaryAccount();
    const { Text } = jest.requireActual('react-native');
    return <Text>Ordinary account branch</Text>;
  },
  useAccount: jest.fn(),
}));
jest.mock('../features/workspace/WorkspaceProvider', () => ({
  WorkspaceProvider: () => {
    mockOrdinaryStore();
    return null;
  },
  useWorkspace: jest.fn(),
}));
jest.mock('../features/content/PrivateContentApplication', () => ({
  PrivateContentApplication: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Independent private branch</Text>;
  },
}));
jest.mock('../features/assistant/nativeAssistant', () => ({ createNativeAssistant: jest.fn() }));
jest.mock('../components/LaunchCoordinator', () => ({
  BootstrapLaunchCoordinator: ({ children }: { children: React.ReactNode }) => children,
  LaunchCoordinator: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});
test.each(['/private-content', '/private-content/unknown'])(
  'reserved route %s never mounts ordinary account or cooking provider',
  (path) => {
    mockPath = path;
    const view = render(<RootLayout />);
    expect(view.getByText('Independent private branch')).toBeTruthy();
    expect(mockOrdinaryAccount).not.toHaveBeenCalled();
    expect(mockOrdinaryStore).not.toHaveBeenCalled();
  },
);
test.each(['/', '/assistant', '/private-content-other'])(
  'ordinary route %s keeps the existing account branch',
  (path) => {
    mockPath = path;
    const view = render(<RootLayout />);
    expect(view.getByText('Ordinary account branch')).toBeTruthy();
    expect(view.queryByText('Independent private branch')).toBeNull();
  },
);
