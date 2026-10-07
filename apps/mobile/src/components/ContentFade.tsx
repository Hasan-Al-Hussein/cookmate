import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useMotionPolicy } from '../design/MotionPolicy';
import { motionTokens } from '../design/motion';

/** A changed selection fades in place; children and their state are never remounted for motion. */
export function ContentFade({
  selection,
  children,
  style,
}: {
  selection: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useMotionPolicy();
  const opacity = useRef(new Animated.Value(1)).current;
  const previous = useRef(selection);
  const focused = useRef(false);
  const settle = useCallback(() => {
    opacity.stopAnimation();
    opacity.setValue(1);
  }, [opacity]);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
        settle();
      };
    }, [settle]),
  );
  useEffect(() => {
    const changed = previous.current !== selection;
    previous.current = selection;
    settle();
    if (changed && !reduced && focused.current) {
      opacity.setValue(0.7);
      Animated.timing(opacity, {
        toValue: 1,
        duration: motionTokens.duration.fade,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }).start();
    }
    return settle;
  }, [selection, reduced, opacity, settle]);
  return <Animated.View style={[style, { opacity }]}>{children}</Animated.View>;
}
