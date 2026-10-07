import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { motionTokens } from '../design/motion';
import { useMotionPolicy } from '../design/MotionPolicy';

/** The caller supplies committed state; a press or restored selection never starts this accent. */
export function CommittedSelectionAccent({
  selected,
  enabled = true,
  hasSnapshot = true,
  children,
  style,
}: {
  selected: boolean;
  enabled?: boolean;
  hasSnapshot?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const reduced = useMotionPolicy();
  const scale = useRef(new Animated.Value(1)).current;
  const previous = useRef({ selected, hasSnapshot: hasSnapshot && enabled });
  const settle = useCallback(() => {
    scale.stopAnimation();
    scale.setValue(1);
  }, [scale]);

  useEffect(() => {
    const newlySelected =
      hasSnapshot && previous.current.hasSnapshot && selected && !previous.current.selected;
    // Retained data can preserve a confirmed baseline, but cannot establish one during recovery.
    previous.current = {
      selected,
      hasSnapshot: hasSnapshot && (enabled || previous.current.hasSnapshot),
    };
    settle();
    if (newlySelected && enabled && !reduced) {
      scale.setValue(motionTokens.scale.iconPeak);
      Animated.timing(scale, {
        toValue: 1,
        duration: motionTokens.duration.micro,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }).start();
    }
    return settle;
  }, [selected, enabled, hasSnapshot, reduced, scale, settle]);

  return <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>;
}
