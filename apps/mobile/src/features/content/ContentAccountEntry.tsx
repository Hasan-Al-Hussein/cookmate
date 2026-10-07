import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useThemeMode } from '../../design/ThemeProvider';
import { MotionPolicyProvider } from '../../design/MotionPolicy';
import { ThemeTransition } from '../../components/ThemeTransition';
import { ActionButton, Notice } from '../../components/Controls';
import { Page } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { AppPreferencesProvider } from '../app-preferences/AppPreferencesProvider';
import { ContentAccountContext, type BrowserContentAccountRoot } from './contentAccountContext';
import type { ContentAccountWorkspaceHandle } from './contentAccountWorkspaceOpener';
import type { PrivateContentRuntime } from './privateContentRuntime';
import { ContentAccountScreen } from './ContentAccountScreen';
import type { AccountProviderName } from '../account/authTypes';

/** A wrapped handle must finish closing before its replacement may be opened. */
export function ContentAccountEntry({
  root,
  renderWorkspace,
}: {
  root: BrowserContentAccountRoot;
  renderWorkspace(runtime: PrivateContentRuntime): ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const route = useRef({ pathname, generation: 0 });
  if (route.current.pathname !== pathname)
    route.current = { pathname, generation: route.current.generation + 1 };
  const live = useRef(true),
    currentRoot = useRef(root);
  currentRoot.current = root;
  const pendingSignIn = useRef<{ root: BrowserContentAccountRoot; generation: number } | null>(
    null,
  );
  const [redirectError, setRedirectError] = useState<{
    root: BrowserContentAccountRoot;
    route: number;
  } | null>(null);
  const callback = useRef<BrowserContentAccountRoot | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, [root]);
  const startSignIn = useCallback(
    (provider: AccountProviderName) => {
      const generation = route.current.generation;
      if (
        !live.current ||
        currentRoot.current !== root ||
        (pendingSignIn.current?.root === root && pendingSignIn.current.generation === generation)
      )
        return;
      const request = { root, generation };
      pendingSignIn.current = request;
      setRedirectError(null);
      const current = () =>
        live.current &&
        currentRoot.current === root &&
        route.current.generation === generation &&
        pendingSignIn.current === request;
      // Authentication renewal retires the workspace view, but does not cancel this explicit request.
      void root.runtime
        .signIn(provider, true)
        .then((url) => {
          if (url && current()) window.location.assign(url);
        })
        .catch(() => {
          if (current()) setRedirectError({ root, route: generation });
        })
        .finally(() => {
          if (pendingSignIn.current === request) pendingSignIn.current = null;
        });
    },
    [root],
  );
  const completeCallback = useCallback(() => {
    if (!live.current || currentRoot.current !== root || callback.current === root) return;
    callback.current = root;
    const href = window.location.href;
    window.history.replaceState(window.history.state, '', '/auth/callback');
    void root.runtime.completeCallback(href).finally(() => {
      if (live.current && currentRoot.current === root) router.replace('/account');
    });
  }, [root, router]);
  const state = useSyncExternalStore(
    root.runtime.subscribe,
    root.runtime.getSnapshot,
    root.runtime.getSnapshot,
  );
  const view = useSyncExternalStore(
    root.view.subscribe,
    root.view.getSnapshot,
    root.view.getSnapshot,
  );
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<{
    root: BrowserContentAccountRoot;
    generation: number;
    attempt: number;
    handle: ContentAccountWorkspaceHandle;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const queue = useRef(Promise.resolve());
  const initialized = useRef<BrowserContentAccountRoot | null>(null);
  const reopen = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (initialized.current === root) return;
    initialized.current = root;
    void root.runtime.initialize();
  }, [root]);
  useEffect(() => {
    const foreground = () => {
      void root.runtime.foreground();
    };
    const subscription = AppState.addEventListener('change', (value) => {
      if (value === 'active') foreground();
    });
    window.addEventListener('online', foreground);
    return () => {
      subscription.remove();
      window.removeEventListener('online', foreground);
    };
  }, [root]);
  useEffect(() => {
    if (state.phase !== 'ready' || !state.startupSettled) return;
    let active = true;
    let release!: () => void;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    setFailed(false);
    const lifetime = queue.current.then(async () => {
      if (!active) return;
      const result = await root.opener(view.workspace)();
      if (result.kind !== 'ready') {
        if (active) setFailed(true);
        return;
      }
      try {
        if (active) {
          setOpened({ root, generation: view.viewGeneration, attempt, handle: result.services });
          await ended;
        }
      } finally {
        await result.services.close();
      }
    });
    // Rejected cleanup keeps this queue blocked; retry cannot start another writer.
    queue.current = lifetime;
    void lifetime.catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
      release();
    };
  }, [root, view.viewGeneration, view.workspace, state.phase, state.startupSettled, attempt]);
  const handle =
    opened?.root === root &&
    opened.generation === view.viewGeneration &&
    opened.attempt === attempt &&
    state.phase === 'ready'
      ? opened.handle
      : null;
  const opening = !handle || state.phase !== 'ready';
  const preferences = root.runtime.preferencesStore();
  return (
    <ContentAccountContext.Provider
      value={{
        root,
        state,
        handle,
        reopen,
        opening,
        completeCallback,
        startSignIn,
        signInRedirectFailed:
          redirectError?.root === root && redirectError.route === route.current.generation,
      }}
    >
      <AppPreferencesProvider store={preferences}>
        <ThemeProvider>
          <MotionPolicyProvider>
            <SelectedAppearance>
              {failed || state.phase === 'failed' ? (
                <Page>
                  <Notice title="This workspace needs recovery" tone="caution">
                    <AppText>
                      The selected workspace could not be opened. Your saved data has not been reset
                      or replaced.
                    </AppText>
                  </Notice>
                  <ActionButton
                    label="Retry opening workspace"
                    onPress={() => {
                      if (state.phase === 'failed') void root.runtime.initialize();
                      else reopen();
                    }}
                  />
                </Page>
              ) : handle?.kind === 'content_workspace' ? (
                renderWorkspace(handle.runtime)
              ) : handle?.kind === 'account_bootstrap' ? (
                <ContentAccountScreen />
              ) : (
                <Page>
                  <AppText>Opening your saved cooking…</AppText>
                </Page>
              )}
            </SelectedAppearance>
          </MotionPolicyProvider>
        </ThemeProvider>
      </AppPreferencesProvider>
    </ContentAccountContext.Provider>
  );
}

function SelectedAppearance({ children }: { children: ReactNode }) {
  const mode = useThemeMode();
  return (
    <>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <ThemeTransition>{children}</ThemeTransition>
    </>
  );
}
