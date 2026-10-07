import type { ReactNode } from 'react';
import { useIsFocused } from 'expo-router';
import { MotionScope } from '../design/MotionPolicy';

export function FocusedMotion({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  return <MotionScope active={focused}>{children}</MotionScope>;
}
