import { createContext, useContext } from 'react';
import type { AccountRuntime, AccountRuntimeSnapshot } from './accountRuntime';
import type { FirstRunWelcome } from './firstRunWelcome';
import type { createPlanningPreferencesController } from '../planning-preferences/planningPreferences';
import type { RecentlyViewedController } from '../recently-viewed/recentlyViewed';

export interface AccountContextValue {
  runtime: AccountRuntime;
  state: AccountRuntimeSnapshot;
  availability: { apple: boolean; google: boolean };
  configured: boolean;
  welcome?: FirstRunWelcome;
  planningPreferences?: () => ReturnType<typeof createPlanningPreferencesController>;
  recentlyViewed?: () => RecentlyViewedController;
}
export const AccountContext = createContext<AccountContextValue | null>(null);
export function useOptionalAccount() {
  return useContext(AccountContext);
}
export function useAccount() {
  const value = useOptionalAccount();
  if (!value) throw new Error('Account provider missing');
  return value;
}
