import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { usePathname, useRouter } from 'expo-router';
import { Platform, StyleSheet, View } from 'react-native';
import { Page } from '../../components/Page';
import { focusTarget } from '../../components/focusTarget';
import { useTheme } from '../../design/ThemeProvider';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { useAccount } from './accountContext';
import type { AccountProviderName } from './authTypes';
import { WelcomeAccountPanel } from './WelcomeAccountPanel';

const noSubscription = () => () => undefined;
const hidden = () => false;
export function WelcomeGate({ children }: { children: ReactNode }) {
  const { runtime, state, configured, availability: providers, welcome } = useAccount();
  const { availability, recoveryState } = useWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const theme = useTheme();
  const welcomeFocus = useRef<View>(null);
  const currentPath = useRef(pathname);
  currentPath.current = pathname;
  const offered = useSyncExternalStore(
    welcome?.subscribe ?? noSubscription,
    welcome?.getSnapshot ?? hidden,
    hidden,
  );
  const visible =
    offered &&
    pathname === '/' &&
    state.startupSettled === true &&
    !state.error &&
    !state.checkingSession &&
    !state.identity &&
    state.workspace.kind === 'guest' &&
    !state.deletion &&
    !state.earlierDeletions?.length &&
    availability.kind === 'ready' &&
    recoveryState.kind === 'ready' &&
    recoveryState.page.entries.length === 0 &&
    recoveryState.page.nextAfterSequence === null;
  useEffect(() => {
    if (
      offered &&
      (state.identity ||
        state.workspace.kind === 'account' ||
        state.error ||
        state.deletion ||
        state.earlierDeletions?.length)
    )
      void welcome?.dismiss();
  }, [
    offered,
    welcome,
    state.identity,
    state.workspace.kind,
    state.error,
    state.deletion,
    state.earlierDeletions,
  ]);
  useEffect(() => {
    if (!visible) return;
    const previous = Platform.OS === 'web' ? document.activeElement : null;
    focusTarget(welcomeFocus.current);
    return () => {
      if (
        Platform.OS === 'web' &&
        currentPath.current === '/' &&
        previous instanceof HTMLElement &&
        previous.isConnected
      )
        previous.focus({ preventScroll: true });
    };
  }, [visible]);
  const login = (provider: AccountProviderName) => {
    // The committed new database already prevents repeat onboarding. Optional preference
    // persistence must never hold or later resurrect an authentication intent.
    void welcome?.dismiss();
    router.push('/account');
    void runtime.signIn(provider, Platform.OS === 'web').then((url) => {
      if (url && Platform.OS === 'web') window.location.assign(url);
    });
  };
  return (
    <View style={styles.root}>
      <View
        style={styles.root}
        pointerEvents={visible ? 'none' : 'auto'}
        {...(Platform.OS === 'web' ? { inert: visible, 'aria-hidden': visible } : {})}
        accessibilityElementsHidden={visible}
        importantForAccessibility={visible ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {visible && (
        <View
          ref={welcomeFocus}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.color.canvas }]}
          accessibilityViewIsModal
          {...(Platform.OS === 'web'
            ? { role: 'dialog' as const, 'aria-modal': true, tabIndex: -1 }
            : {})}
          accessibilityLabel="Welcome to CookMate"
        >
          <Page bottomInset>
            <WelcomeAccountPanel
              appleAvailable={providers.apple}
              googleAvailable={providers.google}
              busy={state.busy}
              error={null}
              availabilityNotice={
                configured
                  ? null
                  : 'Sign-in and cloud sync are not configured in this build. Continue as guest to use CookMate on this device.'
              }
              onApple={() => login('apple')}
              onGoogle={() => login('google')}
              onContinueGuest={() => {
                void welcome?.dismiss();
                router.replace('/');
              }}
              onPrivacy={() =>
                router.push({ pathname: '/settings', params: { section: 'privacy' } })
              }
            />
          </Page>
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 } });
