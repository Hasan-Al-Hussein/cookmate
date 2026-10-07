import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { useWorkspace } from '../features/workspace/WorkspaceProvider';
import { useReducedMotion } from '../hooks/useNativeLayout';
import { motionTokens } from '../design/motion';

if (Platform.OS !== 'web') void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const startupStatusDeadlineMs = 4000;
const LaunchContext = createContext<(reduced: boolean) => void>(() => undefined);

/** Owns the native splash before account, preferences, and workspace gates can withhold children. */
export function BootstrapLaunchCoordinator({ children }: { children: ReactNode }) {
  const released = useRef(false);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [laidOut, setLaidOut] = useState(false);
  const [deadlineReached, setDeadlineReached] = useState(false);
  const release = useCallback((reduced: boolean) => {
    if (Platform.OS === 'web' || released.current) return;
    released.current = true;
    if (deadline.current !== null) clearTimeout(deadline.current);
    try {
      SplashScreen.setOptions({
        fade: !reduced,
        duration: reduced ? 0 : motionTokens.duration.launchExit,
      });
    } catch {
      // Optional native animation configuration must never prevent dismissal.
    }
    void SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (Platform.OS === 'web' || released.current) return;
    // This deadline belongs to bootstrap, so gate and motion changes cannot restart it.
    deadline.current = setTimeout(() => setDeadlineReached(true), startupStatusDeadlineMs);
    return () => {
      if (deadline.current !== null) clearTimeout(deadline.current);
    };
  }, []);
  useEffect(() => {
    // Before preferences/OS motion policy is available, a static dismissal is always safe.
    if (laidOut && deadlineReached) release(true);
  }, [laidOut, deadlineReached, release]);
  const onLayout = useCallback(() => setLaidOut(true), []);
  return (
    <LaunchContext.Provider value={release}>
      <View style={{ flex: 1 }} onLayout={onLayout} testID="launch-bootstrap-surface">
        {children}
      </View>
    </LaunchContext.Provider>
  );
}

/** Recovery must be laid out before dismissal, even when it precedes every app provider. */
export function LaunchRecoverySurface({
  recoveryReady,
  ...props
}: ViewProps & { recoveryReady: boolean }) {
  const release = useContext(LaunchContext);
  return (
    <View
      {...props}
      key={recoveryReady ? 'recovery' : 'opening'}
      onLayout={(event) => {
        props.onLayout?.(event);
        if (recoveryReady) release(true);
      }}
    />
  );
}

/** Readiness reports a rendered app surface; it never starts another splash lifetime. */
export function LaunchCoordinator({
  children,
  fontSettled,
}: {
  children: ReactNode;
  fontSettled: boolean;
}) {
  const { availability } = useWorkspace();
  const reduced = useReducedMotion();
  const release = useContext(LaunchContext);
  const [laidOut, setLaidOut] = useState(false);
  const onLayout = useCallback(() => setLaidOut(true), []);
  useEffect(() => {
    if (!laidOut) return;
    if (availability.kind === 'failed' || (fontSettled && availability.kind === 'ready'))
      release(reduced);
  }, [laidOut, fontSettled, availability.kind, reduced, release]);
  return (
    <View style={{ flex: 1 }} onLayout={onLayout} testID="launch-application-surface">
      {children}
    </View>
  );
}
