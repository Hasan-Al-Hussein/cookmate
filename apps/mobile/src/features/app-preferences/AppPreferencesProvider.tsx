import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  createAppPreferencesController,
  defaultAppPreferences,
  type AppPreferencesController,
  type AppPreferencesSnapshot,
  type AppPreferencesStore,
  type SetAppPreference,
} from './preferences';
import { appPreferencesStore } from './preferenceStorage';

export type { AppPreferences, AppPreferencesStore } from './preferences';

interface AppPreferencesContext extends AppPreferencesSnapshot {
  setPreference: SetAppPreference;
  replacePreferences: AppPreferencesController['replacePreferences'];
}

const Context = createContext<AppPreferencesContext>({
  preferences: defaultAppPreferences,
  hydrated: true,
  error: null,
  // Components rendered alone have safe defaults but cannot falsely report a persisted change.
  setPreference: async () => false,
  replacePreferences: async () => false,
});

// A remount must not start a second writer while a previous preference save is still pending.
const controllers = new WeakMap<AppPreferencesStore, AppPreferencesController>();

function controllerFor(store: AppPreferencesStore) {
  let controller = controllers.get(store);
  if (!controller) {
    controller = createAppPreferencesController(store);
    controllers.set(store, controller);
  }
  return controller;
}

export function AppPreferencesProvider({
  children,
  store = appPreferencesStore,
}: {
  children: ReactNode;
  store?: AppPreferencesStore;
}) {
  const controller = useMemo(() => controllerFor(store), [store]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.hydrate();
    return store.subscribe?.(() => {
      void controller.refresh();
    });
  }, [controller, store]);
  const value = useMemo(
    () => ({
      ...snapshot,
      setPreference: controller.setPreference,
      replacePreferences: controller.replacePreferences,
    }),
    [snapshot, controller],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAppPreferences() {
  return useContext(Context);
}
