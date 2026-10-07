import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createWebStorageLease } from '../data/webStorageLease';
import { designTokens as t } from '../design/tokens';
import { BrandMark } from './BrandMark';
import { focusTarget } from './focusTarget';

type Lease = ReturnType<typeof createWebStorageLease>;
type StorageWindow = Window & { __cookmateWebStorageLeaseV1?: Lease };
const serverLease = createWebStorageLease(undefined);

function documentLease(): Lease {
  if (typeof window === 'undefined') return serverLease;
  const owner = window as StorageWindow;
  // Expo retains OPFS handles after SQL connections close. This must outlive React
  // remounts and Fast Refresh; only unloading the document releases its ownership.
  return (owner.__cookmateWebStorageLeaseV1 ??= createWebStorageLease(window.navigator.locks));
}

export function BrowserStorageGate({ children }: { children: ReactNode }) {
  const [lease] = useState(documentLease);
  const [retried, setRetried] = useState(false);
  const retryControl = useRef<View>(null);
  const restoreRetryFocus = useRef(false);
  const state = useSyncExternalStore(lease.subscribe, lease.getSnapshot, serverLease.getSnapshot);
  useEffect(() => {
    void lease.acquire();
  }, [lease]);
  useEffect(() => {
    if (state.status === 'checking' || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    const element = retryControl.current as unknown as HTMLElement | null;
    const doc = element?.ownerDocument;
    if (doc && (doc.activeElement === doc.body || doc.activeElement === element))
      focusTarget(retryControl.current);
  }, [state.status]);
  if (state.status === 'owned') return <>{children}</>;
  const checking = state.status === 'checking';
  const elsewhere = state.status === 'elsewhere';
  return (
    <ScrollView style={styles.canvas} contentContainerStyle={styles.layout}>
      <View style={styles.content}>
        <BrandMark width={56} height={56} color={t.color.brand} />
        <Text accessibilityRole="header" style={styles.heading}>
          {checking
            ? 'Opening CookMate…'
            : elsewhere
              ? 'CookMate is open in another tab'
              : 'This preview cannot open storage safely'}
        </Text>
        <Text style={styles.body} aria-live="polite">
          {checking
            ? 'Checking access to your saved cooking.'
            : elsewhere
              ? 'Use the other CookMate tab, or close it before continuing here. Only one browser preview can use your saved cooking at a time.'
              : 'Browser storage coordination is unavailable. Try reloading this page in a supported browser.'}
        </Text>
        {(!checking || retried) && (
          <>
            <Text style={styles.support}>Your saved data has not been cleared or replaced.</Text>
            <Pressable
              ref={retryControl}
              accessibilityRole="button"
              disabled={checking}
              accessibilityState={{ disabled: checking, busy: checking }}
              aria-busy={checking}
              onPress={() => {
                if (elsewhere) {
                  const element = retryControl.current as unknown as HTMLElement | null;
                  restoreRetryFocus.current =
                    !!element && element.ownerDocument?.activeElement === element;
                  setRetried(true);
                  void lease.acquire();
                } else window.location.reload();
              }}
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            >
              <Text style={styles.buttonText}>
                {checking
                  ? 'Checking this tab…'
                  : elsewhere
                    ? 'Try this tab again'
                    : 'Reload preview'}
              </Text>
            </Pressable>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  canvas: { flex: 1, backgroundColor: t.color.canvas },
  layout: { flexGrow: 1, justifyContent: 'center', padding: t.space.lg },
  content: { width: '100%', maxWidth: 440, alignSelf: 'center', gap: t.space.md },
  heading: { ...t.type.section, color: t.color.ink },
  body: { ...t.type.body, color: t.color.ink },
  support: { ...t.type.support, color: t.color.inkSecondary },
  button: {
    minHeight: t.control.buttonMinHeight,
    padding: t.space.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.color.brand,
    borderRadius: t.radius.control,
  },
  pressed: { backgroundColor: t.color.brandPressed },
  buttonText: { ...t.type.control, color: t.color.onBrand, textAlign: 'center' },
});
