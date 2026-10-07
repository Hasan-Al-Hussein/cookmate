import * as SQLite from 'expo-sqlite';
import type { SqlConnection } from './sql';
import { createNativeSqlConnection } from './nativeAdapter';

/** Transfers a distinct connection to the store factory, which owns configuration and cleanup. */
export async function openNativeConnection(databaseName: string): Promise<SqlConnection> {
  const database = await SQLite.openDatabaseAsync(databaseName, { useNewConnection: true });
  return createNativeSqlConnection(database);
}
