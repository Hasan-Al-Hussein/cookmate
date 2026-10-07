import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Animated } from 'react-native';
import { useEntranceMotion } from './useEntranceMotion';

/** Used only after a real persisted receipt; never adds a timer to command completion. */
export function ReceiptMotion({ children }: { children: ReactNode }) {
  const { reveal, style } = useEntranceMotion(true);
  const shown = useRef(false);
  useLayoutEffect(() => {
    if (shown.current) return;
    shown.current = true;
    reveal();
  }, [reveal]);
  return <Animated.View style={style}>{children}</Animated.View>;
}
