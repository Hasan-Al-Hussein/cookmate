import { useSyncExternalStore } from 'react';
import { useWorkspace } from '../workspace/WorkspaceProvider';
const emptySubscribe = () => () => undefined;
const emptySnapshot = () => null;
export function useAssistant() {
  const { assistant } = useWorkspace();
  const state = useSyncExternalStore(
    assistant?.subscribe ?? emptySubscribe,
    assistant?.getSnapshot ?? emptySnapshot,
  );
  return { assistant, state };
}
