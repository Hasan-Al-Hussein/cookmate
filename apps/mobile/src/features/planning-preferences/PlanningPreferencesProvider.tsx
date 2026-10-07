import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  defaultPlanningPreferences,
  type PlanningPreferencesController,
  type PlanningPreferencesSnapshot,
  type SetPlanningPreference,
} from './planningPreferences';

interface PlanningPreferencesContext extends PlanningPreferencesSnapshot {
  setPreference: SetPlanningPreference;
}

const Context = createContext<PlanningPreferencesContext>({
  preferences: defaultPlanningPreferences,
  hydrated: true,
  saving: false,
  error: null,
  // Isolated legacy presentation tests receive defaults, never a false persisted receipt.
  setPreference: async () => false,
});

/** The root owns the stable controller and its dispose/drain lifecycle, including remounts. */
export function PlanningPreferencesProvider({
  controller,
  children,
}: {
  controller: PlanningPreferencesController;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.hydrate();
  }, [controller]);
  const value = useMemo(
    () => ({ ...snapshot, setPreference: controller.setPreference }),
    [snapshot, controller],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePlanningPreferences() {
  return useContext(Context);
}
