import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { AppPreferencesProvider, useAppPreferences } from './AppPreferencesProvider';
import {
  defaultAppPreferences,
  encodeAppPreferences,
  type AppPreferencesStore,
} from './preferences';

jest.mock('./preferenceStorage', () => ({
  appPreferencesStore: { read: jest.fn(async () => null), write: jest.fn(async () => {}) },
}));

let observed: ReturnType<typeof useAppPreferences>;
function Probe() {
  observed = useAppPreferences();
  return null;
}

afterEach(cleanup);

test('isolated components receive safe defaults without pretending changes were saved', async () => {
  render(<Probe />);
  expect(observed.preferences).toEqual(defaultAppPreferences);
  expect(observed.hydrated).toBe(true);
  expect(await observed.setPreference('theme', 'dark')).toBe(false);
});

test('exposes pending hydration before replacing all settings with the stored snapshot', async () => {
  let finishRead!: (value: string) => void;
  const store: AppPreferencesStore = {
    read: () => new Promise((resolve) => (finishRead = resolve)),
    write: jest.fn(async () => {}),
  };
  render(
    <AppPreferencesProvider store={store}>
      <Probe />
    </AppPreferencesProvider>,
  );
  expect(observed.hydrated).toBe(false);
  await act(async () => {
    finishRead(encodeAppPreferences({ theme: 'dark', locale: 'en', motion: 'reduced' }));
  });
  expect(observed.hydrated).toBe(true);
  expect(observed.preferences.theme).toBe('dark');
  expect(observed.preferences.motion).toBe('reduced');
});

test('a provider remount shares the serialized writer and does not reopen a stale snapshot', async () => {
  let finishWrite!: () => void;
  const store: AppPreferencesStore = {
    read: jest.fn(async () => null),
    write: jest.fn(() => new Promise<void>((resolve) => (finishWrite = resolve))),
  };
  const tree = () => (
    <AppPreferencesProvider store={store}>
      <Probe />
    </AppPreferencesProvider>
  );
  const first = render(tree());
  await waitFor(() => expect(observed.hydrated).toBe(true));
  let saving!: Promise<boolean>;
  act(() => {
    saving = observed.setPreference('theme', 'dark');
  });
  await waitFor(() => expect(store.write).toHaveBeenCalledTimes(1));
  first.unmount();
  render(tree());
  expect(observed.preferences.theme).toBe('system');
  await act(async () => {
    finishWrite();
    expect(await saving).toBe(true);
  });
  expect(observed.preferences.theme).toBe('dark');
  expect(store.read).toHaveBeenCalledTimes(1);
});
