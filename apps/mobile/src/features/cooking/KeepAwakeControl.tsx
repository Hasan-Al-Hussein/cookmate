import { useEffect, useId, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake, isAvailableAsync } from 'expo-keep-awake';
import { ActionButton } from '../../components/Controls';
import { AppText } from '../../components/Typography';

/** Explicit, temporary native preference. Each foreground lease owns a different tag. */
export function KeepAwakeControl({ visible }: { visible: boolean }) {
  const id = useId();
  const sequence = useRef(0);
  const [available, setAvailable] = useState(false);
  const [requested, setRequested] = useState(false);
  const [held, setHeld] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!visible || Platform.OS === 'web') return;
    let cancelled = false;
    void isAvailableAsync()
      .then((value) => {
        if (!cancelled) setAvailable(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible]);
  useEffect(() => {
    if (!visible) {
      setRequested(false);
      return;
    }
    if (Platform.OS === 'web') return;
    setForeground(AppState.currentState === 'active');
    const subscription = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => subscription.remove();
  }, [visible]);
  useEffect(() => {
    setHeld(false);
    if (!available || !visible || !requested || !foreground) return;
    const tag = `CookMateCooking:${id}:${++sequence.current}`;
    let retired = false;
    let acquired = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void deactivateKeepAwake(tag).catch(() => {
        if (alive.current)
          setError(
            'Screen-sleep control could not be released. Close and reopen CookMate if the screen stays awake.',
          );
      });
    };
    void activateKeepAwakeAsync(tag)
      .then(() => {
        acquired = true;
        if (retired) release();
        else if (alive.current) setHeld(true);
      })
      .catch(() => {
        // A rejected native acknowledgement can still need best-effort cleanup.
        release();
        if (!retired && alive.current) {
          setRequested(false);
          setError('Couldn’t keep the screen awake. Your normal screen-lock settings still apply.');
        }
      });
    return () => {
      retired = true;
      if (acquired) release();
    };
  }, [available, visible, requested, foreground, id]);
  if (!visible || Platform.OS === 'web' || !available) return null;
  return (
    <View>
      <ActionButton
        label={requested ? 'Allow screen to sleep' : 'Keep screen awake'}
        variant="quiet"
        accessibilityState={{ selected: requested }}
        onPress={() => {
          setError(null);
          setRequested((value) => !value);
        }}
      />
      {held && (
        <AppText role="support">Screen stays awake while this cooking view is active.</AppText>
      )}
      {error && (
        <AppText role="support" color="error" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      )}
    </View>
  );
}
