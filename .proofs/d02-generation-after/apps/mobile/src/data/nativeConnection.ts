import * as SQLite from 'expo-sqlite';
import type { SqlConnection } from './sql';
import { configureConnection } from './sql';
import { createNativeSqlConnection } from './nativeAdapter';

/** Every adapter instance owns a distinct connection and initializes it before any BEGIN. */
export async function openNativeConnection(
  databaseName: string,
  mode: 'read' | 'write',
): Promise<SqlConnection> {
  const database = await SQLite.openDatabaseAsync(databaseName, { useNewConnection: true });
  const connection = createNativeSqlConnection(database);
  try {
    await configureConnection(connection);
    if (mode === 'read') await connection.exec('PRAGMA query_only = ON');
  } catch (error) {
    await connection.close();
    throw error;
  }
  return connection;
}
