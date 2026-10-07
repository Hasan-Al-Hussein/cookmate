import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  defaultRecentlyViewed,
  type RecentlyViewedController,
  type RecentlyViewedSnapshot,
} from './recentlyViewed';

interface RecentlyViewedContext extends RecentlyViewedSnapshot {
  refresh: RecentlyViewedController['refresh'];
  setEnabled: RecentlyViewedController['setEnabled'];
  recordOpen: RecentlyViewedController['recordOpen'];
  clear: RecentlyViewedController['clear'];
}
const Context = createContext<RecentlyViewedContext>({
  ...defaultRecentlyViewed,
  hydrated: true,
  saving: false,
  error: null,
  refresh: async () => {},
  setEnabled: async () => false,
  recordOpen: async () => false,
  clear: async () => false,
});

/** Composition owns controller retirement/drain; provider remounts never create another writer. */
export function RecentlyViewedProvider({
  controller,
  children,
}: {
  controller: RecentlyViewedController;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    void controller.hydrate();
  }, [controller]);
  const value = useMemo(
    () => ({
      ...snapshot,
      refresh: controller.refresh,
      setEnabled: controller.setEnabled,
      recordOpen: controller.recordOpen,
      clear: controller.clear,
    }),
    [snapshot, controller],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useRecentlyViewed = () => useContext(Context);
