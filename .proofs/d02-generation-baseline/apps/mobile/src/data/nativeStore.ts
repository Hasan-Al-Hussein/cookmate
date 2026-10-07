import type { DateContext } from '@cookmate/contracts';
import { nativeCommandPlatform } from '../domain/commandPlatform';
import { createLocalStore } from './localStore';
import { openNativeConnection } from './nativeConnection';

/** The app supplies its one runtime date authority; SQL and command identity stay private. */
export function openCookMateStore(options: {
  now(): string;
  dateContext(): DateContext;
  databaseName?: string;
}) {
  return createLocalStore({
    ...options,
    platform: nativeCommandPlatform,
    openConnection: (mode) => openNativeConnection(options.databaseName ?? 'cookmate.db', mode),
  });
}
