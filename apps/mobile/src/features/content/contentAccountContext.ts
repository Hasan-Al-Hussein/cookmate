import { createContext, useContext } from 'react';
import type { createBrowserContentAccountRuntime } from './createBrowserContentAccountRuntime';
import type { ContentAccountWorkspaceHandle } from './contentAccountWorkspaceOpener';
import type { AccountProviderName } from '../account/authTypes';

export type BrowserContentAccountRoot = ReturnType<typeof createBrowserContentAccountRuntime>;
export interface ContentAccountContextValue {
  root: BrowserContentAccountRoot;
  state: ReturnType<BrowserContentAccountRoot['runtime']['getSnapshot']>;
  handle: ContentAccountWorkspaceHandle | null;
  reopen(): void;
  opening: boolean;
  /** Owned by the entry lifetime so a successful workspace switch does not repeat OAuth. */
  completeCallback(): void;
  startSignIn(provider: AccountProviderName): void;
  signInRedirectFailed: boolean;
}
export const ContentAccountContext = createContext<ContentAccountContextValue | null>(null);
export const useOptionalContentAccount = () => useContext(ContentAccountContext);
export function useContentAccount() {
  const value = useOptionalContentAccount();
  if (!value) throw new Error('Configured account workspace is not mounted.');
  return value;
}
