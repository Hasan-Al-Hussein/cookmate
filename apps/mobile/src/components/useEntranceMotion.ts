import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { useMotionPolicy } from '../design/MotionPolicy';
import { motionTokens } from '../design/motion';

/** A shown surface enters without delaying focus or retaining dismissed review authority. */
export function useEntranceMotion(visible: boolean) {
  const reduced = useMotionPolicy();
  const progress = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!visible || reduced) {
      progress.stopAnimation();
      progress.setValue(1);
    }
    return () => progress.stopAnimation();
  }, [progress, reduced, visible]);

  const reveal = useCallback(() => {
    progress.stopAnimation();
    if (!visible || reduced) {
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: motionTokens.duration.sheet,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    }).start();
  }, [progress, reduced, visible]);

  const style = useMemo(
    () => ({
      opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }),
      transform: [
        {
          translateY: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [motionTokens.distance.contentEnter, 0],
          }),
        },
      ],
    }),
    [progress],
  );
  return { reveal, style };
}
