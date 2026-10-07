import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState, Platform, Pressable, Text } from 'react-native';
import { createNativeAccountRuntime } from './nativeAccountRuntime';
import { subscribeNativeAppleRevocation } from './nativeAuth';
import { AccountContext } from './accountContext';
import { LaunchRecoverySurface } from '../../components/LaunchCoordinator';
export { useAccount } from './accountContext';
let previousLifetime: Promise<void> = Promise.resolve();

export function AccountProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Awaited<ReturnType<typeof createNativeAccountRuntime>> | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let owned: Awaited<ReturnType<typeof createNativeAccountRuntime>> | null = null;
    let release!: () => void;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifetime = previousLifetime.then(async () => {
      if (!active) return;
      owned = await createNativeAccountRuntime();
      if (!active) {
        await owned.runtime.dispose();
        return;
      }
      setValue(owned);
      await owned.runtime.initialize();
      await ended;
      await owned.runtime.dispose();
    });
    previousLifetime = lifetime;
    void lifetime.catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
      release();
    };
  }, []);
  if (!value || failed)
    return (
      <LaunchRecoverySurface
        recoveryReady={failed}
        style={{
          flex: 1,
          backgroundColor: '#FFFCF8',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}
      >
        <Text style={{ color: '#214B3C', fontSize: 18 }}>
          {failed
            ? 'CookMate could not open account settings. Your saved cooking data has not been reset. Restart the app to retry.'
            : 'Opening CookMate…'}
        </Text>
      </LaunchRecoverySurface>
    );
  return <AccountState value={value}>{children}</AccountState>;
}

function AccountState({
  value,
  children,
}: {
  value: Awaited<ReturnType<typeof createNativeAccountRuntime>>;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(
    value.runtime.subscribe,
    value.runtime.getSnapshot,
    value.runtime.getSnapshot,
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (Platform.OS !== 'web') void value.runtime.setAppActive(status === 'active');
      if (status === 'active') void value.runtime.foreground();
    });
    if (Platform.OS !== 'web') void value.runtime.setAppActive(AppState.currentState === 'active');
    const online = () => {
      void value.runtime.foreground();
    };
    if (Platform.OS === 'web') window.addEventListener('online', online);
    let removed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeNativeAppleRevocation(online)
      .then((remove) => {
        if (removed) remove();
        else unsubscribe = remove;
      })
      .catch(() => undefined);
    return () => {
      subscription.remove();
      removed = true;
      unsubscribe?.();
      if (Platform.OS === 'web') window.removeEventListener('online', online);
    };
  }, [value.runtime]);
  if (state.phase !== 'ready')
    return (
      <LaunchRecoverySurface
        recoveryReady={state.phase === 'failed'}
        style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#FFFCF8' }}
      >
        <Text>
          {state.phase === 'failed'
            ? 'Your local workspace needs recovery. CookMate has not replaced your saved data.'
            : 'Opening your saved cooking…'}
        </Text>
        {Platform.OS === 'web' && state.error === 'web_restart_required' && (
          <Text>
            Close the other CookMate previews, then reload this page to recover browser storage.
          </Text>
        )}
        {state.phase === 'failed' && (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              if (Platform.OS === 'web' && state.error === 'web_restart_required')
                window.location.reload();
              else void value.runtime.initialize();
            }}
            style={{ padding: 16 }}
          >
            <Text>
              {Platform.OS === 'web' && state.error === 'web_restart_required'
                ? 'Reload preview'
                : 'Retry opening CookMate'}
            </Text>
          </Pressable>
        )}
      </LaunchRecoverySurface>
    );
  return <AccountContext.Provider value={{ ...value, state }}>{children}</AccountContext.Provider>;
}
