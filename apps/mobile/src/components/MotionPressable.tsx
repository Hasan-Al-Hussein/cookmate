import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  type PressableProps,
  type View,
} from 'react-native';
import { motionTokens } from '../design/motion';
import { useMotionPolicy } from '../design/MotionPolicy';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Immediate presses; only a transform is animated, never the command or its result. */
export const MotionPressable = forwardRef<View, PressableProps>(function MotionPressable(
  { style, children, onPressIn, onPressOut, disabled, ...props },
  ref,
) {
  const reduced = useMotionPolicy();
  const [pressed, setPressed] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const resolvedStyle = typeof style === 'function' ? style({ pressed }) : style;
  const transform = StyleSheet.flatten(resolvedStyle)?.transform;
  // RN also accepts transform strings. Keep those intact instead of trying to parse
  // them or replacing their geometry with a decorative scale.
  const stringTransform = typeof transform === 'string';
  const animate = useCallback(
    (down: boolean) => {
      scale.stopAnimation();
      if (reduced || disabled || stringTransform) {
        scale.setValue(1);
        return;
      }
      Animated.timing(scale, {
        toValue: down ? motionTokens.scale.press : 1,
        duration: down ? motionTokens.duration.pressIn : motionTokens.duration.pressOut,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }).start();
    },
    [disabled, reduced, scale, stringTransform],
  );
  useEffect(() => {
    if (reduced || disabled) setPressed(false);
    if (reduced || disabled || stringTransform) {
      scale.stopAnimation();
      scale.setValue(1);
    }
    return () => scale.stopAnimation();
  }, [disabled, reduced, scale, stringTransform]);
  return (
    <AnimatedPressable
      {...props}
      ref={ref}
      disabled={disabled}
      onPressIn={(event) => {
        setPressed(true);
        animate(true);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        animate(false);
        onPressOut?.(event);
      }}
      style={[
        resolvedStyle,
        { transform: stringTransform ? transform : [...(transform ?? []), { scale }] },
      ]}
    >
      {typeof children === 'function' ? children({ pressed }) : children}
    </AnimatedPressable>
  );
});
