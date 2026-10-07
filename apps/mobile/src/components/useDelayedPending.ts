import { useEffect, useState } from 'react';
import { motionTokens } from '../design/motion';

/** Delays only presentation; the operation, disabled state and errors stay immediate. */
export function useDelayedPending(pending: boolean) {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!pending) {
      setElapsed(false);
      return;
    }
    const timeout = setTimeout(() => setElapsed(true), motionTokens.delay.pending);
    return () => clearTimeout(timeout);
  }, [pending]);
  return pending && elapsed;
}
