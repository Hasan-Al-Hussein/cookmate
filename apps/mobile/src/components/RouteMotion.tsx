import type { ReactNode } from 'react';
import { FocusedMotion } from './FocusedMotion';

/** iOS owns push/back gestures and transitions through the native stack. */
export function RouteMotion({ children }: { children: ReactNode; root: boolean }) {
  return <FocusedMotion>{children}</FocusedMotion>;
}
