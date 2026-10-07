import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ContentOrdinaryCatalogueProvider, OrdinaryCatalogueProvider } from './OrdinaryCatalogue';
import type { ContentWorkspaceHost } from './contentWorkspaceHost';
import {
  createOrdinaryContentWorkspace,
  type OrdinaryContentWorkspaceState,
} from './ordinaryContentWorkspace';

const unavailable: OrdinaryContentWorkspaceState = Object.freeze({
  kind: 'unavailable',
  status: 'updating',
});
const emptySnapshot = () => unavailable;
const emptySubscribe = () => () => undefined;
const Context = createContext<OrdinaryContentWorkspaceState | null>(null);
const FocusContext = createContext<{
  registerFocusFallback(focus: () => void): () => void;
  restoreScreenFocus(): void;
}>({
  registerFocusFallback:
    (_focus: () => void): (() => void) =>
    () =>
      undefined,
  restoreScreenFocus: () => undefined,
});

/** Borrows one runtime host for catalogue, exact queries, reviewed actions and recovery. */
export function OrdinaryContentWorkspaceProvider({
  host,
  children,
}: {
  host: ContentWorkspaceHost;
  children: ReactNode;
}) {
  const latest = useRef(host);
  const focus = useRef<(() => void) | null>(null);
  const registerFocusFallback = useCallback((next: () => void) => {
    focus.current = next;
    return () => {
      if (focus.current === next) focus.current = null;
    };
  }, []);
  const restoreScreenFocus = useCallback(() => focus.current?.(), []);
  const focusValue = useMemo(
    () => ({ registerFocusFallback, restoreScreenFocus }),
    [registerFocusFallback, restoreScreenFocus],
  );
  latest.current = host;
  const cleanupFailed = useRef(false);
  const [failedHost, setFailedHost] = useState<ContentWorkspaceHost | null>(null);
  const [owned, setOwned] = useState<{
    host: ContentWorkspaceHost;
    adapter: ReturnType<typeof createOrdinaryContentWorkspace>;
  } | null>(null);
  useEffect(() => {
    if (cleanupFailed.current) {
      setFailedHost(host);
      return;
    }
    try {
      const adapter = createOrdinaryContentWorkspace(host, {
        isCurrent: () => latest.current === host,
        getFocusScope: () => focus.current,
      });
      setOwned({ host, adapter });
      return () => {
        try {
          adapter.close();
        } catch {
          cleanupFailed.current = true;
        }
      };
    } catch {
      // An unconfirmed partial cleanup cannot authorize another UI owner here.
      cleanupFailed.current = true;
      setFailedHost(host);
    }
  }, [host]);
  const adapter = owned?.host === host ? owned.adapter : null;
  const state = useSyncExternalStore(
    adapter?.subscribe ?? emptySubscribe,
    adapter?.getSnapshot ?? emptySnapshot,
    adapter?.getSnapshot ?? emptySnapshot,
  );
  return (
    <FocusContext.Provider value={focusValue}>
      <Context.Provider
        value={failedHost === host ? { kind: 'unavailable', status: 'failed' } : state}
      >
        {adapter &&
        failedHost !== host &&
        !(state.kind === 'unavailable' && state.status === 'failed') ? (
          <ContentOrdinaryCatalogueProvider host={host}>
            {children}
          </ContentOrdinaryCatalogueProvider>
        ) : (
          <OrdinaryCatalogueProvider controller={null}>{children}</OrdinaryCatalogueProvider>
        )}
      </Context.Provider>
    </FocusContext.Provider>
  );
}

export const useOptionalOrdinaryContentWorkspace = () => useContext(Context);
export const useContentWorkspaceFocus = () => useContext(FocusContext);
