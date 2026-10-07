import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Appearance,
  AppState,
  Text,
  TextInput,
  View,
  type AppStateStatus,
  type ColorSchemeName,
} from 'react-native';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import {
  AppPreferencesProvider,
  useAppPreferences,
} from '../features/app-preferences/AppPreferencesProvider';
import {
  defaultAppPreferences,
  encodeAppPreferences,
  type AppPreferences,
  type AppPreferencesStore,
} from '../features/app-preferences/preferences';
import { MotionPolicyProvider, useMotionPolicy } from './MotionPolicy';
import {
  darkTokens,
  ThemeProvider,
  useThemeMode,
  useThemedStyles,
  type ThemeTokens,
} from './ThemeProvider';
import { designTokens } from './tokens';

jest.mock('../features/app-preferences/preferenceStorage', () => ({
  appPreferencesStore: { read: jest.fn(async () => null), write: jest.fn(async () => {}) },
}));
// RN's Jest preset substitutes a constant light value. Exercise the installed hook's
// real useSyncExternalStore subscription while mocking only the native appearance boundary.
jest.unmock('react-native/Libraries/Utilities/useColorScheme');

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function memoryStore(preferences: AppPreferences = defaultAppPreferences): AppPreferencesStore {
  let stored = encodeAppPreferences(preferences);
  return {
    read: async () => stored,
    write: jest.fn(async (value: string) => {
      stored = value;
    }),
  };
}

let preferences: ReturnType<typeof useAppPreferences>;
const originalAppState = AppState.currentState;

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  AppState.currentState = originalAppState;
});

function PreferenceProbe() {
  preferences = useAppPreferences();
  return null;
}

function MotionProbe({ label = 'Motion' }: { label?: string }) {
  const reduced = useMotionPolicy();
  return <Text>{`${label}: ${reduced ? 'reduced' : 'ordinary'}`}</Text>;
}

function motionEnvironment(initial: Promise<boolean> = Promise.resolve(false)) {
  const motionListeners = new Set<(reduced: boolean) => void>();
  const lifecycleListeners = new Set<(state: AppStateStatus) => void>();
  const motionRemovals: jest.Mock[] = [];
  const lifecycleRemovals: jest.Mock[] = [];
  AppState.currentState = 'active';
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValue(initial);
  const subscribeMotion = (event: string, listener: (reduced: boolean) => void) => {
    if (event !== 'reduceMotionChanged')
      throw new Error(`Unexpected accessibility event: ${event}`);
    motionListeners.add(listener);
    const remove = jest.fn(() => {
      motionListeners.delete(listener);
    });
    motionRemovals.push(remove);
    return { remove };
  };
  // Jest infers only RN's final announcementFinished overload. This boundary implements
  // the boolean reduceMotionChanged overload and the subscription's public cleanup method.
  const addMotion = jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockImplementation(subscribeMotion as unknown as typeof AccessibilityInfo.addEventListener);
  const addLifecycle = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((event, callback) => {
      if (event !== 'change') throw new Error(`Unexpected lifecycle event: ${event}`);
      const listener = callback as (state: AppStateStatus) => void;
      lifecycleListeners.add(listener);
      const remove = jest.fn(() => {
        lifecycleListeners.delete(listener);
      });
      lifecycleRemovals.push(remove);
      return { remove };
    });
  return {
    addMotion,
    addLifecycle,
    motionRemovals,
    lifecycleRemovals,
    motionListeners,
    lifecycleListeners,
    changeMotion: (reduced: boolean) => motionListeners.forEach((listener) => listener(reduced)),
    changeLifecycle: (state: AppStateStatus) => {
      AppState.currentState = state;
      lifecycleListeners.forEach((listener) => listener(state));
    },
  };
}

function motionTree(store: AppPreferencesStore) {
  return (
    <AppPreferencesProvider store={store}>
      <MotionPolicyProvider>
        <PreferenceProbe />
        <MotionProbe />
        <MotionProbe label="Another consumer" />
      </MotionPolicyProvider>
    </AppPreferencesProvider>
  );
}

test('a live OS reduced-motion event wins over a stale initial asynchronous answer', async () => {
  const initial = deferred<boolean>();
  const environment = motionEnvironment(initial.promise);
  const view = render(motionTree(memoryStore()));
  expect(view.getByText('Motion: reduced')).toBeTruthy();
  act(() => environment.changeMotion(true));
  await act(async () => {
    initial.resolve(false);
  });
  expect(view.getByText('Motion: reduced')).toBeTruthy();
  act(() => environment.changeMotion(false));
  expect(view.getByText('Motion: ordinary')).toBeTruthy();
});

test('in-app reduction cannot override OS reduction and backgrounding suppresses ordinary motion', async () => {
  const environment = motionEnvironment();
  const view = render(motionTree(memoryStore()));
  await act(async () => {});
  expect(view.getByText('Motion: ordinary')).toBeTruthy();

  await act(async () => {
    expect(await preferences.setPreference('motion', 'reduced')).toBe(true);
  });
  act(() => environment.changeMotion(false));
  expect(view.getByText('Motion: reduced')).toBeTruthy();
  await act(async () => {
    expect(await preferences.setPreference('motion', 'system')).toBe(true);
  });
  expect(view.getByText('Motion: ordinary')).toBeTruthy();

  act(() => environment.changeLifecycle('inactive'));
  expect(view.getByText('Motion: reduced')).toBeTruthy();
  act(() => environment.changeLifecycle('background'));
  expect(view.getByText('Motion: reduced')).toBeTruthy();
  act(() => environment.changeLifecycle('active'));
  expect(view.getByText('Motion: ordinary')).toBeTruthy();

  act(() => environment.changeMotion(true));
  await act(async () => {
    expect(await preferences.setPreference('motion', 'system')).toBe(true);
  });
  act(() => environment.changeLifecycle('background'));
  act(() => environment.changeLifecycle('active'));
  expect(view.getByText('Motion: reduced')).toBeTruthy();
});

test('many consumers share one subscription pair and unmount removes both while the initial read is pending', async () => {
  const initial = deferred<boolean>();
  const environment = motionEnvironment(initial.promise);
  const store = memoryStore();
  const view = render(motionTree(store));
  await act(async () => {});
  view.rerender(motionTree(store));
  expect(environment.addMotion).toHaveBeenCalledTimes(1);
  expect(environment.addLifecycle).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(environment.motionRemovals[0]).toHaveBeenCalledTimes(1);
  expect(environment.lifecycleRemovals[0]).toHaveBeenCalledTimes(1);
  expect(environment.motionListeners.size).toBe(0);
  expect(environment.lifecycleListeners.size).toBe(0);
  await act(async () => {
    initial.resolve(false);
  });
  expect(environment.addMotion).toHaveBeenCalledTimes(1);
  expect(environment.addLifecycle).toHaveBeenCalledTimes(1);
});

test('an unavailable initial OS motion query stays conservative until a genuine change arrives', async () => {
  const environment = motionEnvironment(Promise.reject(new Error('Synthetic native failure')));
  const view = render(motionTree(memoryStore()));
  await act(async () => {});
  expect(view.getByText('Motion: reduced')).toBeTruthy();
  act(() => environment.changeMotion(false));
  expect(view.getByText('Motion: ordinary')).toBeTruthy();
});

function appearanceEnvironment(initial: ColorSchemeName) {
  let current = initial;
  const listeners = new Set<Parameters<typeof Appearance.addChangeListener>[0]>();
  jest.spyOn(Appearance, 'getColorScheme').mockImplementation(() => current);
  jest.spyOn(Appearance, 'addChangeListener').mockImplementation((listener) => {
    listeners.add(listener);
    return {
      remove: () => {
        listeners.delete(listener);
      },
    };
  });
  return {
    listeners,
    change(next: ColorSchemeName) {
      current = next;
      listeners.forEach((listener) => listener({ colorScheme: next }));
    },
  };
}

const readerStyles = (tokens: ThemeTokens) => ({
  reader: { backgroundColor: tokens.color.canvas },
});

function StatefulReader({ onMount, onUnmount }: { onMount(): void; onUnmount(): void }) {
  const [draft, setDraft] = useState('Unsent cooking question');
  const mode = useThemeMode();
  const styles = useThemedStyles(readerStyles);
  useEffect(() => {
    onMount();
    return onUnmount;
  }, [onMount, onUnmount]);
  return (
    <View testID="reader-surface" style={styles.reader}>
      <Text>{`Theme: ${mode}`}</Text>
      <TextInput accessibilityLabel="Unsent question" value={draft} onChangeText={setDraft} />
    </View>
  );
}

test('a late persisted theme updates the palette without remounting or replacing an edited draft', async () => {
  appearanceEnvironment('light');
  const stored = deferred<string | null>();
  const store: AppPreferencesStore = { read: () => stored.promise, write: jest.fn(async () => {}) };
  const mounted = jest.fn();
  const unmounted = jest.fn();
  const view = render(
    <AppPreferencesProvider store={store}>
      <ThemeProvider>
        <PreferenceProbe />
        <StatefulReader onMount={mounted} onUnmount={unmounted} />
      </ThemeProvider>
    </AppPreferencesProvider>,
  );
  fireEvent.changeText(view.getByLabelText('Unsent question'), 'Keep this exact draft');
  await act(async () => {
    stored.resolve(encodeAppPreferences({ ...defaultAppPreferences, theme: 'dark' }));
  });
  expect(view.getByText('Theme: dark')).toBeTruthy();
  expect(view.getByTestId('reader-surface')).toHaveStyle({
    backgroundColor: darkTokens.color.canvas,
  });
  expect(view.getByDisplayValue('Keep this exact draft')).toBeTruthy();
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
  expect(store.write).not.toHaveBeenCalled();
});

test('system palette changes stay live, explicit choices take precedence, and returning to System preserves state', async () => {
  const environment = appearanceEnvironment('light');
  const mounted = jest.fn();
  const unmounted = jest.fn();
  const view = render(
    <AppPreferencesProvider store={memoryStore()}>
      <ThemeProvider>
        <PreferenceProbe />
        <StatefulReader onMount={mounted} onUnmount={unmounted} />
      </ThemeProvider>
    </AppPreferencesProvider>,
  );
  await act(async () => {});
  expect(environment.listeners.size).toBe(1);
  fireEvent.changeText(view.getByLabelText('Unsent question'), 'Still composing');
  act(() => environment.change('dark'));
  expect(view.getByText('Theme: dark')).toBeTruthy();
  expect(view.getByTestId('reader-surface')).toHaveStyle({
    backgroundColor: darkTokens.color.canvas,
  });
  await act(async () => {
    expect(await preferences.setPreference('theme', 'light')).toBe(true);
  });
  expect(view.getByText('Theme: light')).toBeTruthy();
  act(() => environment.change('light'));
  act(() => environment.change('dark'));
  expect(view.getByText('Theme: light')).toBeTruthy();
  expect(view.getByTestId('reader-surface')).toHaveStyle({
    backgroundColor: designTokens.color.canvas,
  });
  await act(async () => {
    expect(await preferences.setPreference('theme', 'system')).toBe(true);
  });
  expect(view.getByText('Theme: dark')).toBeTruthy();
  expect(view.getByDisplayValue('Still composing')).toBeTruthy();
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});
