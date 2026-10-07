import { createContext, useContext } from 'react';
import type { PrivateContentRuntime } from './privateContentRuntime';

/** Borrowed capability only. This context does not create, close or reopen a workspace. */
export const OrdinaryContentRuntimeContext = createContext<PrivateContentRuntime | null>(null);
export const useOrdinaryContentRuntime = () => useContext(OrdinaryContentRuntimeContext);
