import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import { useTheme } from '../design/ThemeProvider';
import { useMotionPolicy } from '../design/MotionPolicy';
import { motionTokens } from '../design/motion';

/** Keep the same screen tree, focus and draft while the new palette settles. */
export function ThemeTransition({ children }: { children: ReactNode }) {
  const t = useTheme();
  const reduced = useMotionPolicy();
  const previous = useRef(t);
  const opacity = useRef(new Animated.Value(1)).current;
  useLayoutEffect(() => {
    const changed = previous.current !== t;
    previous.current = t;
    opacity.stopAnimation();
    opacity.setValue(1);
    if (changed && !reduced) {
      opacity.setValue(0.78);
      Animated.timing(opacity, {
        toValue: 1,
        duration: motionTokens.duration.content,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }).start();
    }
    return () => {
      opacity.stopAnimation();
      opacity.setValue(1);
    };
  }, [t, reduced, opacity]);
  return (
    <View style={{ flex: 1, backgroundColor: t.color.canvas }}>
      <Animated.View style={{ flex: 1, opacity }}>{children}</Animated.View>
    </View>
  );
}
