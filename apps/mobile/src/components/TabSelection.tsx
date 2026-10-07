import { useLayoutEffect, useRef } from 'react';
import { Animated, Easing, I18nManager, Platform, StyleSheet } from 'react-native';
import { useMotionPolicy } from '../design/MotionPolicy';
import { motionTokens } from '../design/motion';
import { useTheme } from '../design/ThemeProvider';
import { useNativeLayout } from '../hooks/useNativeLayout';

export type TabPosition = { x: number; y: number };
const CAPSULE_WIDTH = 44;

/** A single decorative capsule moves; hit targets, labels and selected semantics update now. */
export function TabSelection({
  position,
  selectionKey,
}: {
  position: TabPosition | undefined;
  selectionKey: string;
}) {
  const t = useTheme();
  const reduced = useMotionPolicy();
  const { width, fontScale } = useNativeLayout();
  // Hidden screens can retain old onLayout coordinates across a viewport resize.
  // Admit only decoration that fits; the real tab targets/selected semantics remain unchanged.
  const admitted =
    position &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x + CAPSULE_WIDTH <= width
      ? position
      : undefined;
  const x = useRef(new Animated.Value(position?.x ?? 0)).current;
  const y = useRef(new Animated.Value(position?.y ?? 0)).current;
  const previous = useRef<
    | {
        position: TabPosition;
        selectionKey: string;
        width: number;
        fontScale: number;
      }
    | undefined
  >(undefined);
  useLayoutEffect(() => {
    x.stopAnimation();
    y.stopAnimation();
    if (!admitted) {
      previous.current = undefined;
      return;
    }
    const from = previous.current;
    previous.current = { position: admitted, selectionKey, width, fontScale };
    // Animate a committed tab change only. Layout corrections must never sweep offscreen.
    if (
      reduced ||
      !from ||
      from.selectionKey === selectionKey ||
      from.width !== width ||
      from.fontScale !== fontScale ||
      Math.abs(admitted.y - from.position.y) > 1
    ) {
      x.setValue(admitted.x);
      y.setValue(admitted.y);
      return;
    }
    Animated.parallel([
      Animated.timing(x, {
        toValue: admitted.x,
        duration: motionTokens.duration.content,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }),
      Animated.timing(y, {
        toValue: admitted.y,
        duration: motionTokens.duration.content,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }),
    ]).start();
    return () => {
      x.stopAnimation();
      y.stopAnimation();
    };
  }, [admitted?.x, admitted?.y, selectionKey, width, fontScale, reduced, x, y]);
  if (!admitted) return null;
  return (
    <Animated.View
      testID="tab-selection"
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.capsule,
        // onLayout x is physical. Keep a physical-left origin when Yoga swaps RTL edges.
        I18nManager.isRTL ? { end: 0 } : { start: 0 },
        { backgroundColor: t.color.selection, transform: [{ translateX: x }, { translateY: y }] },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  capsule: { position: 'absolute', top: 0, width: CAPSULE_WIDTH, height: 30, borderRadius: 999 },
});
