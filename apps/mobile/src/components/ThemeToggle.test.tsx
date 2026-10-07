import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '../design/ThemeProvider';
import { AppPreferencesProvider } from '../features/app-preferences/AppPreferencesProvider';
import {
  encodeAppPreferences,
  type AppPreferencesStore,
} from '../features/app-preferences/preferences';
import { ThemeToggle } from './ThemeToggle';

jest.mock('../features/app-preferences/preferenceStorage', () => ({ appPreferencesStore: {} }));
afterEach(cleanup);

const light = encodeAppPreferences({ theme: 'light', locale: 'en', motion: 'reduced' });
function mount(store: AppPreferencesStore, onError = jest.fn()) {
  render(
    <AppPreferencesProvider store={store}>
      <ThemeProvider>
        <ThemeToggle onError={onError} />
      </ThemeProvider>
    </AppPreferencesProvider>,
  );
  return onError;
}

test('shortcut persists the theme and offers the inverse action, keeping other preferences', async () => {
  const write = jest.fn(async (_value: string) => {});
  mount({ read: async () => light, write });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeEnabled(),
  );
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Switch to dark mode' })),
  );
  expect(JSON.parse(write.mock.calls.at(-1)![0])).toEqual({
    schemaVersion: 1,
    preferences: { theme: 'dark', locale: 'en', motion: 'reduced' },
  });
  expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeEnabled();
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Switch to light mode' })),
  );
  expect(JSON.parse(write.mock.calls.at(-1)![0])).toEqual(JSON.parse(light));
});

test('failed saving retains the theme and reports failure instead of claiming success', async () => {
  const onError = mount({
    read: async () => light,
    write: async () => {
      throw new Error('unavailable');
    },
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeEnabled(),
  );
  await act(async () =>
    fireEvent.press(screen.getByRole('button', { name: 'Switch to dark mode' })),
  );
  expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeEnabled();
  expect(onError).toHaveBeenLastCalledWith('Theme could not be saved. Please try again.');
});
