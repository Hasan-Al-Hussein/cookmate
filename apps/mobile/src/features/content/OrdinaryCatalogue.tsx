import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { ContentHash } from '@cookmate/catalogue/content';
import { nativeCommandPlatform } from '../../domain/commandPlatform';
import type { ContentWorkspaceHost } from './contentWorkspaceHost';
import {
  createBundledOrdinaryCatalogue,
  createContentOrdinaryCatalogue,
  type OrdinaryCatalogueController,
  type OrdinaryCatalogueState,
} from './ordinaryCatalogueState';

interface ContextValue {
  state: OrdinaryCatalogueState;
  /** Null only while the provider is opening; a ready state always has this owned reader. */
  reader: OrdinaryCatalogueController | null;
}
const Context = createContext<ContextValue | null>(null);
const opening: OrdinaryCatalogueState = Object.freeze({
  kind: 'loading',
  scopeKey: 'catalogue:opening',
});
const openingSnapshot = () => opening;
const openingSubscription = () => () => undefined;

/** Borrows a controller from its workspace owner; this provider never closes host/storage handles. */
export function OrdinaryCatalogueProvider({
  controller,
  children,
}: {
  controller: OrdinaryCatalogueController | null;
  children: ReactNode;
}) {
  const state = useSyncExternalStore(
    controller?.subscribe ?? openingSubscription,
    controller?.getSnapshot ?? openingSnapshot,
    controller?.getSnapshot ?? openingSnapshot,
  );
  return <Context.Provider value={{ state, reader: controller }}>{children}</Context.Provider>;
}

function OwnedCatalogue({
  create,
  children,
}: {
  create(): OrdinaryCatalogueController;
  children: ReactNode;
}) {
  const [owned, setOwned] = useState<{
    factory: typeof create;
    controller: OrdinaryCatalogueController;
  } | null>(null);
  useEffect(() => {
    const controller = create();
    setOwned({ factory: create, controller });
    return () => controller.close();
  }, [create]);
  // A changed owner/factory hides its old snapshot in this render, before effect cleanup.
  return (
    <OrdinaryCatalogueProvider controller={owned?.factory === create ? owned.controller : null}>
      {children}
    </OrdinaryCatalogueProvider>
  );
}

/** Default ordinary catalogue; no publication configuration or storage migration is required. */
export function BundledOrdinaryCatalogueProvider({
  children,
  scopeKey = 'bundled',
  sha256 = nativeCommandPlatform.sha256,
}: {
  children: ReactNode;
  scopeKey?: string;
  sha256?: ContentHash;
}) {
  const create = useCallback(
    () => createBundledOrdinaryCatalogue({ scopeKey, sha256 }),
    [scopeKey, sha256],
  );
  return <OwnedCatalogue create={create}>{children}</OwnedCatalogue>;
}

/** Same read interface with a real workspace host; the caller retains responsibility for host.close(). */
export function ContentOrdinaryCatalogueProvider({
  host,
  children,
}: {
  host: Pick<
    ContentWorkspaceHost,
    'content' | 'getSnapshot' | 'subscribe' | 'onPhotoCleanupFailure'
  >;
  children: ReactNode;
}) {
  const create = useCallback(() => createContentOrdinaryCatalogue(host), [host]);
  return <OwnedCatalogue create={create}>{children}</OwnedCatalogue>;
}

export function useOrdinaryCatalogue(): ContextValue {
  const context = useContext(Context);
  if (!context) throw new Error('OrdinaryCatalogueProvider is missing');
  return context;
}

/** Allows unchanged standalone/legacy callers to retain their existing bundled path. */
export const useOptionalOrdinaryCatalogue = () => useContext(Context);
