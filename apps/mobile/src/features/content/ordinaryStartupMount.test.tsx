import { Platform } from 'react-native';
import { cleanup, render } from '@testing-library/react-native';
import RootLayout from '../../../app/_layout';

let mockPath = '/';
jest.mock('expo-router', () => ({ usePathname: () => mockPath }));
jest.mock('@cookmate/catalogue/content-trust', () => ({ createContentTrustVerifier: jest.fn() }));
jest.mock('../../components/LaunchCoordinator', () => ({
  BootstrapLaunchCoordinator: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../../components/BrowserStorageGate', () => ({
  BrowserStorageGate: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../account/AccountProvider', () => ({
  AccountProvider: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Legacy account opener</Text>;
  },
}));
jest.mock('../workspace/WorkspaceProvider', () => ({}));
jest.mock('../workspace/FavouritesState', () => ({}));
jest.mock('../workspace/WorkspaceFeedback', () => ({}));
jest.mock('../assistant/nativeAssistant', () => ({}));
jest.mock('../account/WelcomeGate', () => ({}));
jest.mock('./OrdinaryCatalogue', () => ({}));
jest.mock('../../components/ApplicationNavigator', () => ({}));
jest.mock('./PrivateContentApplication', () => ({
  PrivateContentApplication: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Private review opener</Text>;
  },
}));
jest.mock('./OrdinaryContentApplication', () => ({
  OrdinaryContentApplication: ({ config }: { config: { installationId: string } }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{`Content installation ${config.installationId}`}</Text>;
  },
  UnavailableContentApplication: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Selected configuration refused</Text>;
  },
}));
const initialEnvironment = process.env.EXPO_PUBLIC_COOKMATE_CONTENT_WORKSPACE;
const initialLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const config = JSON.stringify({
  version: 1,
  origin: 'http://127.0.0.1:18081',
  installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  releaseId: 'test',
  trustKeys: [{ keyId: 'test', publicKeyHex: 'a'.repeat(64) }],
});
beforeEach(() => {
  mockPath = '/';
  jest.replaceProperty(Platform, 'OS', 'web');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'http://127.0.0.1:18081' },
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  if (initialEnvironment === undefined) delete process.env.EXPO_PUBLIC_COOKMATE_CONTENT_WORKSPACE;
  else process.env.EXPO_PUBLIC_COOKMATE_CONTENT_WORKSPACE = initialEnvironment;
  if (initialLocation) Object.defineProperty(globalThis, 'location', initialLocation);
  else Reflect.deleteProperty(globalThis, 'location');
});
test.each(['/', '/recipe/52819', '/plan', '/account', '/auth/callback', '/private-content'])(
  'configured normal startup selects one content owner before account effects on %s',
  (path) => {
    mockPath = path;
    process.env.EXPO_PUBLIC_COOKMATE_CONTENT_WORKSPACE = config;
    const view = render(<RootLayout />);
    expect(
      view.getByText('Content installation aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    ).toBeTruthy();
    expect(view.queryByText('Legacy account opener')).toBeNull();
    expect(view.queryByText('Private review opener')).toBeNull();
  },
);
test.each(['{', '{}', 'false'])(
  'invalid explicit operator configuration stays closed: %s',
  (value) => {
    process.env.EXPO_PUBLIC_COOKMATE_CONTENT_WORKSPACE = value;
    const view = render(<RootLayout />);
    expect(view.getByText('Selected configuration refused')).toBeTruthy();
    expect(view.queryByText('Legacy account opener')).toBeNull();
  },
);
test('unconfigured legacy and private review entries retain their original owners', () => {
  delete process.env.EXPO_PUBLIC_COOKMATE_CONTENT_WORKSPACE;
  const view = render(<RootLayout />);
  expect(view.getByText('Legacy account opener')).toBeTruthy();
  mockPath = '/private-content';
  view.rerender(<RootLayout />);
  expect(view.getByText('Private review opener')).toBeTruthy();
  expect(view.queryByText('Legacy account opener')).toBeNull();
});
