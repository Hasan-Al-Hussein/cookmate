import * as SQLite from 'expo-sqlite';
import { createNativeSqlConnection } from '../../data/nativeAdapter';
import { CONTENT_ACCOUNT_MARKER_KEY } from './contentAccountWorkspaces';
import { privateContentAccountBrowserName } from './privateContentBrowserConnection';
import {
  privateContentAccountDatabaseName,
  privateContentDatabaseNames,
} from './privateContentConfig';
import { PrivateContentCleanupError } from './privateContentRuntime';

const maximumCloneBytes = 64 * 1024 * 1024;

/** Platform ports for the configured lifecycle. No migration, identity binding, login or UI mount. */
export function createContentAccountNativeStorage(options: {
  installationId: string;
  browser: boolean;
  sha256(text: string): Promise<string>;
  assertClosed(): void;
}) {
  const { installationId, browser, sha256, assertClosed } = options;
  const guest = privateContentDatabaseNames(installationId);
  const prefix = `cookmate-review-${installationId}-account-`;
  let cleanupFailure: PrivateContentCleanupError | undefined;
  function checkClosed(lease: () => void) {
    if (cleanupFailure) throw cleanupFailure;
    lease();
  }
  function ownerFor(name: string) {
    if (!name.startsWith(prefix) || !name.endsWith('.db')) throw new Error('Unknown account file');
    const owner = name.slice(prefix.length, -3);
    if (privateContentAccountDatabaseName(installationId, owner) !== name)
      throw new Error('Unknown account file');
    return owner;
  }
  async function physical(name: string) {
    if (name === guest.cooking) return browser ? `cmr-${installationId}-c.db` : name;
    if (name === guest.content) return browser ? `cmr-${installationId}-r.db` : name;
    const owner = ownerFor(name);
    return browser ? privateContentAccountBrowserName(installationId, owner, sha256) : name;
  }
  async function closeAll(
    databases: readonly (SQLite.SQLiteDatabase | undefined)[],
    primary?: unknown,
  ) {
    const failures: unknown[] = [];
    for (const db of databases) {
      try {
        await db?.closeAsync();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      cleanupFailure = new PrivateContentCleanupError(
        primary === undefined ? failures : [primary, ...failures],
      );
      throw cleanupFailure;
    }
  }
  return Object.freeze({
    async openConnection(name: string) {
      const resolved = await physical(name);
      // The active runtime, unlike preparation/removal, may own this connection.
      if (cleanupFailure) throw cleanupFailure;
      return createNativeSqlConnection(
        await SQLite.openDatabaseAsync(resolved, { useNewConnection: true }),
      );
    },
    async cloneGuestWithMarker(
      sourceName: string,
      destinationName: string,
      marker: { key: string; value: string },
      lease = assertClosed,
    ) {
      const check = () => checkClosed(lease);
      check();
      const owner = ownerFor(destinationName);
      if (
        sourceName !== guest.cooking ||
        marker.key !== CONTENT_ACCOUNT_MARKER_KEY ||
        marker.value.length > 2048
      )
        throw new Error('Invalid account copy');
      const stamp = JSON.parse(marker.value) as Record<string, unknown>;
      if (
        stamp.installationId !== installationId ||
        stamp.ownerId !== owner ||
        stamp.databaseName !== destinationName ||
        stamp.copyGuest !== true ||
        stamp.phase !== 'copied'
      )
        throw new Error('Invalid account copy identity');
      // Own caller strings before any platform await.
      const markerValue = marker.value;
      const sourcePath = await physical(sourceName),
        destinationPath = await physical(destinationName);
      check();
      let source: SQLite.SQLiteDatabase | undefined,
        copy: SQLite.SQLiteDatabase | undefined,
        destination: SQLite.SQLiteDatabase | undefined,
        primary: unknown;
      try {
        source = await SQLite.openDatabaseAsync(sourcePath, { useNewConnection: true });
        check();
        const pages = await source.getFirstAsync<{ page_count: number }>('PRAGMA page_count');
        const pageSize = await source.getFirstAsync<{ page_size: number }>('PRAGMA page_size');
        check();
        const size = (pages?.page_count ?? NaN) * (pageSize?.page_size ?? NaN);
        if (!Number.isSafeInteger(size) || size <= 0 || size > maximumCloneBytes)
          throw new Error('Guest copy exceeds the supported memory bound');
        const sourcePageSize = pageSize!.page_size;
        if (
          !Number.isInteger(sourcePageSize) ||
          sourcePageSize < 512 ||
          sourcePageSize > 65536 ||
          (sourcePageSize & (sourcePageSize - 1)) !== 0
        )
          throw new Error('Unsupported guest page size');
        copy = await SQLite.openDatabaseAsync(':memory:', { useNewConnection: true });
        check();
        await copy.execAsync(`PRAGMA page_size=${sourcePageSize}`);
        check();
        await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: copy });
        check();
        const schema = await copy.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
        const identity = await copy.getFirstAsync<{ value: string }>(
          "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END value FROM app_metadata WHERE key='installation_id'",
        );
        const account = await copy.getFirstAsync(
          "SELECT 1 FROM app_metadata WHERE key LIKE 'account-replication:%' OR key=?",
          CONTENT_ACCOUNT_MARKER_KEY,
        );
        if (schema?.user_version !== 8 || identity?.value !== installationId || account)
          throw new Error('Guest copy identity changed');
        await copy.runAsync(
          'INSERT INTO app_metadata(key,value) VALUES (?,?)',
          CONTENT_ACCOUNT_MARKER_KEY,
          markerValue,
        );
        check();
        destination = await SQLite.openDatabaseAsync(destinationPath, { useNewConnection: true });
        check();
        const existing = await destination.getFirstAsync(
          "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
        );
        const targetVersion = await destination.getFirstAsync<{ user_version: number }>(
          'PRAGMA user_version',
        );
        if (existing || targetVersion?.user_version !== 0)
          throw new Error('Account copy destination is not empty');
        check();
        // SQLite commits the marked image as one backup; the real guest is never modified.
        await SQLite.backupDatabaseAsync({ sourceDatabase: copy, destDatabase: destination });
        check();
        const saved = await destination.getFirstAsync<{ value: string }>(
          "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=2048 THEN value END value FROM app_metadata WHERE key=?",
          CONTENT_ACCOUNT_MARKER_KEY,
        );
        if (saved?.value !== markerValue) throw new Error('Account copy was not confirmed');
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        await closeAll([destination, copy, source], primary);
      }
    },
    async deleteDatabase(name: string, lease = assertClosed) {
      const check = () => checkClosed(lease);
      ownerFor(name);
      check();
      const resolved = await physical(name);
      check();
      await SQLite.deleteDatabaseAsync(resolved);
      check();
    },
  });
}
