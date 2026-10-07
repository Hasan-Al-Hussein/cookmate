import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { I18nManager, View } from 'react-native';
import { useIsFocused } from 'expo-router';
import { MotionScope, useMotionPolicy } from '../design/MotionPolicy';
import { motionTokens } from '../design/motion';

/** The installed native-stack web fallback hides/shows screens without animating them. */
export function RouteMotion({ children, root }: { children: ReactNode; root: boolean }) {
  const focused = useIsFocused();
  const reduced = useMotionPolicy();
  const surface = useRef<View>(null);
  const visited = useRef(false);
  const previousFocus = useRef(false);
  useLayoutEffect(() => {
    const entered = focused && !previousFocus.current;
    previousFocus.current = focused;
    if (!entered) return;
    const returning = visited.current;
    visited.current = true;
    if (reduced || (root && !returning)) return;
    const element = surface.current as unknown as HTMLElement | null;
    if (!element?.animate) return;
    const direction = I18nManager.isRTL ? -1 : 1;
    const distance =
      direction *
      (returning
        ? -motionTokens.distance.contentEnter
        : motionTokens.distance.maximumDecorativeShift);
    const animation = element.animate(
      [
        { opacity: 0.72, transform: `translateX(${distance}px)` },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: motionTokens.duration.pageFallback, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
    // Reduced motion, blur, rapid navigation and unmount reveal the real final surface.
    return () => animation.cancel();
  }, [focused, reduced, root]);
  return (
    <View ref={surface} style={{ flex: 1, minHeight: 0 }} testID="route-motion">
      <MotionScope active={focused}>{children}</MotionScope>
    </View>
  );
}
