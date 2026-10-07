import { useSyncExternalStore } from 'react';
import { Dimensions } from 'react-native';
import { designTokens as t } from '../design';
import { useMotionPolicy } from '../design/MotionPolicy';

export function recipeColumns(width: number, fontScale: number): 1 | 2 {
  const available = Math.min(width, t.layout.screenMaxWidth);
  return (available - 2 * t.layout.phoneGutter - t.layout.columnGap) / 2 >=
    t.layout.recipeColumnMinWidth && fontScale <= t.layout.recipeGridMaxFontScale
    ? 2
    : 1;
}

interface NativeLayout {
  width: number;
  fontScale: number;
  columns: 1 | 2;
  enlarged: boolean;
}

// Match RN Web's server dimensions without reading a browser/native global during SSR.
const serverLayout: NativeLayout = { width: 0, fontScale: 1, columns: 1, enlarged: false };
let currentLayout = serverLayout;
let notifiedLayout = serverLayout;
const listeners = new Set<() => void>();
let subscription: ReturnType<typeof Dimensions.addEventListener> | undefined;

function getLayout(): NativeLayout {
  const { width, fontScale } = Dimensions.get('window');
  if (width !== currentLayout.width || fontScale !== currentLayout.fontScale) {
    currentLayout = {
      width,
      fontScale,
      columns: recipeColumns(width, fontScale),
      enlarged: fontScale > 1.15,
    };
  }
  return currentLayout;
}

function subscribeLayout(listener: () => void) {
  listeners.add(listener);
  if (!subscription) {
    notifiedLayout = getLayout();
    subscription = Dimensions.addEventListener('change', () => {
      const next = getLayout();
      if (next === notifiedLayout) return;
      notifiedLayout = next;
      [...listeners].forEach((notify) => notify());
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      subscription?.remove();
      subscription = undefined;
    }
  };
}

const getServerLayout = () => serverLayout;

/** Height-only keyboard/viewport changes do not invalidate card layout or recipe photos. */
export function useNativeLayout() {
  return useSyncExternalStore(subscribeLayout, getLayout, getServerLayout);
}

export function useReducedMotion() {
  return useMotionPolicy();
}
