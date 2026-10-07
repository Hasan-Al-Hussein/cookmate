import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import { useAppPreferences } from '../features/app-preferences/AppPreferencesProvider';

const MotionContext = createContext(true);
/** One live OS/lifecycle subscription for the app, not one for every button. */
export function MotionPolicyProvider({ children }: { children: ReactNode }) {
  const { preferences } = useAppPreferences();
  const [systemReduced, setSystemReduced] = useState(true);
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    let mounted = true;
    let changed = false;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted && !changed) setSystemReduced(value);
      })
      .catch(() => undefined);
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      changed = true;
      setSystemReduced(value);
    });
    const lifecycle = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => {
      mounted = false;
      motion.remove();
      lifecycle.remove();
    };
  }, []);
  return (
    <MotionContext.Provider value={!active || systemReduced || preferences.motion === 'reduced'}>
      {children}
    </MotionContext.Provider>
  );
}
export function useMotionPolicy() {
  return useContext(MotionContext);
}

/** One boundary per retained route stops its decorative work while it is offscreen. */
export function MotionScope({ active, children }: { active: boolean; children: ReactNode }) {
  const reduced = useMotionPolicy();
  return <MotionContext.Provider value={reduced || !active}>{children}</MotionContext.Provider>;
}
