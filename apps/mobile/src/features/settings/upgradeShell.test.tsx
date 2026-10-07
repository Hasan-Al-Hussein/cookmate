import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { BottomNavigation } from '../../components/BottomNavigation';
import { PageHeader } from '../../components/Page';
import AccountScreen from '../account/AccountScreen';
import { AppearanceSettings } from './AppearanceSettings';
import SettingsScreen from './SettingsScreen';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockRetry = jest.fn();
const mockPersist = jest.fn();
let mockSection: string | undefined;
let mockHydrated = true;
let mockPreferenceError: string | null = null;
let mockFontScale = 1;
let mockAvailability:
  | { kind: 'ready'; services: Record<string, never> }
  | { kind: 'opening' }
  | {
      kind: 'failed';
      error: { retry: 'never' | 'after_correction' };
    } = { kind: 'ready', services: {} };
const mockPreferences = { theme: 'system', motion: 'system', locale: 'en' };
jest.mock('../account/accountContext', () => ({
  useOptionalAccount: () => null,
  useAccount: () => ({
    runtime: {},
    configured: false,
    availability: { google: false, apple: false },
    state: {
      busy: false,
      checkingSession: false,
      error: null,
      deletion: null,
      identity: null,
      workspace: { kind: 'guest' },
      sync: { kind: 'local' },
    },
  }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    navigate: mockNavigate,
    setParams: mockSetParams,
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({ section: mockSection }),
  useFocusEffect: () => undefined,
}));
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../../hooks/useNativeLayout', () => ({
  useNativeLayout: () => ({ width: 428, fontScale: mockFontScale }),
}));
jest.mock('../app-preferences/AppPreferencesProvider', () => ({
  useAppPreferences: () => ({
    preferences: mockPreferences,
    hydrated: mockHydrated,
    error: mockPreferenceError,
    setPreference: mockPersist,
  }),
}));
jest.mock('../../design/ThemeProvider', () => {
  const { designTokens } = jest.requireActual('../../design/tokens');
  return {
    useTheme: () => designTokens,
    useThemeMode: () => 'light',
    useThemedStyles: (factory: (tokens: unknown) => unknown) => factory(designTokens),
  };
});
jest.mock('../workspace/WorkspaceProvider', () => ({
  useWorkspace: () => ({
    availability: mockAvailability,
    retryOpen: mockRetry,
    registerFocusFallback: () => () => undefined,
    actions: null,
  }),
}));
jest.mock('../workspace/WorkspaceFeedback', () => ({ WorkspaceFeedback: () => null }));
jest.mock('../assistant/useAssistant', () => ({
  useAssistant: () => ({ assistant: null, state: null }),
}));
jest.mock('./Preferences', () => ({ Preferences: () => null }));
jest.mock('./ConnectionSettings', () => ({ ConnectionSettings: () => null }));

beforeEach(() => {
  mockSection = undefined;
  mockHydrated = true;
  mockPreferenceError = null;
  mockFontScale = 1;
  mockAvailability = { kind: 'ready', services: {} };
  mockPersist.mockReset().mockResolvedValue(true);
  mockPush.mockClear();
  mockNavigate.mockClear();
  mockSetParams.mockClear();
  mockRetry.mockClear();
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('main headers open the focused Account destination', () => {
  render(<PageHeader title="Favourites" />);
  fireEvent.press(screen.getByRole('button', { name: 'Account' }));
  expect(mockPush).toHaveBeenCalledWith('/account');
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
});

test('Settings offers real appearance and guest-account entries without unfinished controls', () => {
  render(<SettingsScreen />);
  fireEvent.press(screen.getByRole('button', { name: 'Appearance & accessibility' }));
  expect(mockSetParams).toHaveBeenCalledWith({ section: 'appearance' });
  fireEvent.press(screen.getByRole('button', { name: 'Account & sync' }));
  expect(mockPush).toHaveBeenCalledWith('/account');
  fireEvent.press(screen.getByRole('button', { name: 'Backup & restore' }));
  expect(mockSetParams).toHaveBeenCalledWith({ section: 'backup' });
  expect(screen.getByRole('button', { name: 'Saved preferences' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'AI connection' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Language' })).toBeNull();
});

test('Settings subsection back retains the Settings tab and clears only the section', () => {
  mockSection = 'appearance';
  render(<SettingsScreen />);
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeTruthy();
  fireEvent.press(screen.getByRole('button', { name: 'Back' }));
  expect(mockSetParams).toHaveBeenCalledWith({ section: '' });
  expect(mockNavigate).not.toHaveBeenCalled();
});

test('unknown Settings sections fall back to the usable settings menu', () => {
  mockSection = 'unsupported-future-section';
  render(<SettingsScreen />);
  expect(screen.getByRole('button', { name: 'Appearance & accessibility' })).toBeTruthy();
});

test('theme and motion choices use their actual persisted settings commands', async () => {
  render(<AppearanceSettings />);
  await act(async () => fireEvent.press(screen.getByRole('radio', { name: 'Dark' })));
  expect(mockPersist).toHaveBeenNthCalledWith(1, 'theme', 'dark');
  await act(async () => fireEvent.press(screen.getByRole('radio', { name: 'Reduced' })));
  expect(mockPersist).toHaveBeenNthCalledWith(2, 'motion', 'reduced');
});

test('an unresolved preference save disables overlapping choices and reports failure', async () => {
  let finish!: (saved: boolean) => void;
  mockPersist.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  render(<AppearanceSettings />);
  fireEvent.press(screen.getByRole('radio', { name: 'Dark' }));
  expect(screen.getByRole('radio', { name: 'Light' })).toBeDisabled();
  fireEvent.press(screen.getByRole('radio', { name: 'Light' }));
  expect(mockPersist).toHaveBeenCalledTimes(1);
  await act(async () => finish(false));
  expect(screen.getByText('App preferences could not be saved or restored')).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'System' }).props.accessibilityState.checked).toBe(true);
  expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeDisabled();
});

test('preference hydration does not allow a default value to overwrite stored choices', () => {
  mockHydrated = false;
  render(<AppearanceSettings />);
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeDisabled();
  fireEvent.press(screen.getByRole('radio', { name: 'Dark' }));
  expect(mockPersist).not.toHaveBeenCalled();
});

test('Guest Account reports confirmed browser storage without inventing cloud identity', () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  render(<AccountScreen />);
  expect(screen.getByText('Keep your cooking with you')).toBeTruthy();
  expect(screen.getByText(/Sign-in and cloud sync are not configured/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Continue with Apple' })).toBeDisabled();
  fireEvent.press(screen.getByRole('button', { name: 'Local backup' }));
  expect(mockNavigate).toHaveBeenCalledWith({
    pathname: '/settings',
    params: { section: 'backup' },
  });
});

test('Guest Account never describes an unconfirmed workspace as loaded', () => {
  mockAvailability = { kind: 'failed', error: { retry: 'after_correction' } };
  render(<AccountScreen />);
  expect(screen.getByText('Your local work needs recovery')).toBeTruthy();
  expect(screen.queryByText(/Your saved workspace is open/)).toBeNull();
  fireEvent.press(screen.getByRole('button', { name: 'Retry local storage' }));
  expect(mockRetry).toHaveBeenCalledTimes(1);
});

test('five peer tabs retain prompt selected state and respect prevented navigation', () => {
  const routeNames = ['index', 'favourites', 'plan', 'assistant', 'settings'];
  const titles = ['Discover', 'Favourites', 'Plan', 'Assistant', 'Settings'];
  const navigate = jest.fn();
  const emit = jest.fn().mockReturnValue({ defaultPrevented: false });
  const props = {
    state: { index: 0, routes: routeNames.map((name) => ({ key: name, name })) },
    descriptors: Object.fromEntries(
      routeNames.map((name, index) => [name, { options: { title: titles[index] } }]),
    ),
    navigation: { emit, navigate },
  } as unknown as ComponentProps<typeof BottomNavigation>;
  const view = render(<BottomNavigation {...props} />);
  expect(screen.getAllByRole('tab')).toHaveLength(5);
  fireEvent.press(screen.getByRole('tab', { name: 'Discover' }));
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('tab', { name: 'Settings' }));
  expect(navigate).toHaveBeenCalledWith('settings', undefined);
  emit.mockReturnValue({ defaultPrevented: true });
  fireEvent.press(screen.getByRole('tab', { name: 'Plan' }));
  expect(navigate).toHaveBeenCalledTimes(1);
  mockFontScale = 2;
  view.rerender(<BottomNavigation {...props} />);
  for (const title of titles) expect(screen.getByRole('tab', { name: title })).toBeTruthy();
});
