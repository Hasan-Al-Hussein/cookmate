import { useCallback, useEffect, useRef } from 'react';
import type { View } from 'react-native';
import { focusTarget } from '../components/focusTarget';
import { useOrdinaryWorkspaceActions } from '../features/content/useOrdinaryWorkspace';

export function useActionFocus() {
  const ref = useRef<View>(null);
  const { restoreScreenFocus, actions } = useOrdinaryWorkspaceActions();
  const restoreFocus = useCallback(
    (onlyIfMissing = false) => {
      if (onlyIfMissing && ref.current) return false;
      if (!focusTarget(ref.current)) restoreScreenFocus();
      return true;
    },
    [restoreScreenFocus],
  );
  useEffect(() => () => actions?.restoreAfterRemoval(restoreFocus), [actions, restoreFocus]);
  return { ref, restoreFocus };
}
