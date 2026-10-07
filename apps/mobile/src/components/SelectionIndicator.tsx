import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { useMotionPolicy } from '../design/MotionPolicy';
import { motionTokens } from '../design/motion';

/** Decorative only: the control's value, contrast and accessibility update immediately. */
export function SelectionIndicator({
  selected,
  children,
  style,
}: {
  selected: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useMotionPolicy();
  const progress = useRef(new Animated.Value(selected ? 1 : 0)).current;
  const previous = useRef(selected);
  useLayoutEffect(() => {
    progress.stopAnimation();
    if (reduced || previous.current === selected) {
      progress.setValue(selected ? 1 : 0);
    } else {
      Animated.timing(progress, {
        toValue: selected ? 1 : 0,
        duration: motionTokens.duration.micro,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }).start();
    }
    previous.current = selected;
    return () => progress.stopAnimation();
  }, [progress, reduced, selected]);
  return (
    <Animated.View
      testID="selection-indicator"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { scaleX: progress.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
