import * as SQLite from 'expo-sqlite';
import { openCookMateStore } from '../../data/nativeStore';
import { WebStorageRestartError } from '../../data/webStorageFailure';
import { runtimeClock } from '../workspace/runtimeClock';
import {
  accountDatabaseName,
  GUEST_DATABASE_NAME,
  type WorkspaceDatabaseAdapter,
} from './workspaceSelection';

const markerKey = 'account-workspace:identity';
const bindingKey = 'account-replication:owner';
async function metadata(database: SQLite.SQLiteDatabase, key: string): Promise<string | null> {
  const table = await database.getFirstAsync<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='app_metadata'",
  );
  return table
    ? ((
        await database.getFirstAsync<{ value: string }>(
          'SELECT value FROM app_metadata WHERE key=?',
          key,
        )
      )?.value ?? null)
    : null;
}
function marker(ownerId: string, copyGuest: boolean, phase: 'copied' | 'ready' = 'ready') {
  return JSON.stringify({ schemaVersion: 1, ownerId, copyGuest, phase });
}
export async function verifyAccountWorkspace(ownerId: string) {
  const database = await SQLite.openDatabaseAsync(accountDatabaseName(ownerId), {
    useNewConnection: true,
  });
  try {
    const saved = await metadata(database, markerKey);
    if (saved !== marker(ownerId, true) && saved !== marker(ownerId, false))
      throw new Error('Account workspace identity could not be verified');
  } finally {
    await database.closeAsync();
  }
}

/** Called only inside WorkspaceProvider's drained close-before-open barrier. */
export function createWorkspaceDatabaseAdapter(options: {
  assertClosed(): void;
  copyGuestPrivateState(ownerId: string): Promise<void>;
  removePrivateState(ownerId: string): Promise<void>;
}): WorkspaceDatabaseAdapter {
  return {
    async prepare(ownerId, copyGuest) {
      options.assertClosed();
      const name = accountDatabaseName(ownerId);
      let destination = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
      try {
        const saved = await metadata(destination, markerKey);
        if (saved !== null) {
          if (saved === marker(ownerId, copyGuest)) return;
          if (saved !== marker(ownerId, copyGuest, 'copied'))
            throw new Error('Workspace preparation changed');
        }
        if ((await metadata(destination, bindingKey)) !== null)
          throw new Error('Unconfirmed existing account workspace');
        if (copyGuest && saved === null) {
          const source = await SQLite.openDatabaseAsync(GUEST_DATABASE_NAME, {
            useNewConnection: true,
          });
          try {
            if (
              (await metadata(source, bindingKey)) !== null ||
              (await metadata(source, markerKey)) !== null
            )
              throw new Error('Guest workspace is already account-owned');
            await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
          } finally {
            await source.closeAsync();
          }
        }
      } finally {
        await destination.closeAsync();
      }
      // Initialize/verify using the actual application migrations, never an invented extra schema.
      const initialized = await openCookMateStore({ ...runtimeClock, databaseName: name });
      if (initialized.kind !== 'ready') {
        if (initialized.error.messageKey === 'storage.web_restart_required')
          throw new WebStorageRestartError();
        throw new Error('Account workspace could not be prepared');
      }
      await initialized.services.close();
      destination = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
      try {
        await destination.runAsync(
          'INSERT INTO app_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING',
          markerKey,
          marker(ownerId, copyGuest, 'copied'),
        );
        if ((await metadata(destination, markerKey)) !== marker(ownerId, copyGuest, 'copied'))
          throw new Error('Account copy preparation could not be confirmed');
      } finally {
        await destination.closeAsync();
      }
      if (copyGuest) await options.copyGuestPrivateState(ownerId);
      options.assertClosed();
      destination = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
      try {
        await destination.runAsync(
          'UPDATE app_metadata SET value=? WHERE key=? AND value=?',
          marker(ownerId, copyGuest),
          markerKey,
          marker(ownerId, copyGuest, 'copied'),
        );
        if ((await metadata(destination, markerKey)) !== marker(ownerId, copyGuest))
          throw new Error('Account copy readiness could not be confirmed');
      } finally {
        await destination.closeAsync();
      }
    },
    async remove(ownerId) {
      options.assertClosed();
      // Identity and the durable removal intent constrain every target; no directory deletion.
      const name = accountDatabaseName(ownerId);
      // Opening the exact derived target makes a previously completed delete retryable.
      // A fresh empty database is immediately closed/deleted; no application facade sees it.
      const existing = await SQLite.openDatabaseAsync(name, { useNewConnection: true });
      try {
        const saved = await metadata(existing, markerKey);
        const tables = await existing.getAllAsync<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        );
        if (tables.length && saved !== marker(ownerId, true) && saved !== marker(ownerId, false))
          throw new Error('Removal target identity could not be verified');
      } finally {
        await existing.closeAsync();
      }
      await SQLite.deleteDatabaseAsync(name);
      await options.removePrivateState(ownerId);
    },
  };
}
