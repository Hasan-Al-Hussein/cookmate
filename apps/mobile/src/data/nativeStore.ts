import type { DateContext } from '@cookmate/contracts';
import { nativeCommandPlatform } from '../domain/commandPlatform';
import { createLocalStore } from './localStore';
import type { LocalStoreOptions } from './localStore';
import { openNativeConnection } from './nativeConnection';

/** The app supplies its one runtime date authority; SQL and command identity stay private. */
export function openCookMateStore(options: {
  now(): string;
  dateContext(): DateContext;
  databaseName?: string;
  enableAccountHistory?: boolean;
  accountReplication?: NonNullable<LocalStoreOptions['accountReplication']>;
}) {
  return createLocalStore({
    ...options,
    // Additive local migrations preserve existing meals, selections and purchase marks.
    enablePortableRestore: true,
    enableCooking: true,
    enablePersonal: true,
    platform: nativeCommandPlatform,
    openConnection: () => openNativeConnection(options.databaseName ?? 'cookmate.db'),
  });
}
