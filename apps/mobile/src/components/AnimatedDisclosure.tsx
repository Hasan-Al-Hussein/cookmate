import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { motionTokens } from '../design/motion';
import { useMotionPolicy } from '../design/MotionPolicy';

/** Reveal at natural height; collapse removes content and its actions immediately. */
export function AnimatedDisclosure({
  expanded,
  children,
  style,
  testID,
}: {
  expanded: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reduced = useMotionPolicy();
  const progress = useRef(new Animated.Value(1)).current;
  const previous = useRef(expanded);
  const settle = useCallback(() => {
    progress.stopAnimation();
    progress.setValue(1);
  }, [progress]);

  useEffect(() => {
    const opening = expanded && !previous.current;
    previous.current = expanded;
    settle();
    if (opening && !reduced) {
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: motionTokens.duration.disclosure,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }).start();
    }
    return settle;
  }, [expanded, reduced, progress, settle]);

  if (!expanded) return null;
  return (
    <Animated.View
      testID={testID}
      style={[
        style,
        {
          opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }),
          transform: [
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [motionTokens.distance.micro, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
