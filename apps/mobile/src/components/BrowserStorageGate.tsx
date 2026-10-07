import type { ReactNode } from 'react';

/** Native SQLite ownership remains with the account/workspace runtime. */
export function BrowserStorageGate({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
