import type { CommandPlatform } from '@cookmate/domain';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { isAppId } from '../../data/conversationRecords';
import { readBinding } from '../../data/accountReplicationRecords';
import type { InitialIdentifiers } from '../../data/initialize';
import {
  configureConnection,
  runBound,
  SerializedWriter,
  type RecoveryImpact,
  type SqlConnection,
  type SqlSession,
} from '../../data/sql';
import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseNamingPolicy,
} from '../account/workspaceSelection';
import {
  completePreparedContentSchema,
  preparePrivateContentWorkspace,
} from './preparePrivateContentWorkspace';
import {
  ownPrivateContentConfiguration,
  privateContentAccountDatabaseName,
  privateContentDatabaseNames,
  type PrivateContentConfiguration,
} from './privateContentConfig';
import { PrivateContentCleanupError } from './privateContentRuntime';

export const CONTENT_ACCOUNT_MARKER_KEY = 'account-workspace:content-identity';
const markerBytes = 2048;
type AccountMarker = InitialIdentifiers & {
  version: 1;
  origin: string;
  databaseName: string;
  ownerId: string;
  copyGuest: boolean;
  phase: 'copied' | 'ready';
};
export class ContentAccountWorkspaceError extends Error {
  constructor(readonly reason: 'identity' | 'unowned' | 'schema' | 'busy' | 'guest_recovery') {
    super(`Content account workspace: ${reason}`);
  }
}
const fail = (reason: ConstructorParameters<typeof ContentAccountWorkspaceError>[0]): never => {
  throw new ContentAccountWorkspaceError(reason);
};
async function version(session: SqlSession) {
  return (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version;
}
async function empty(session: SqlSession) {
  return !(
    await session.all(
      "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' UNION ALL SELECT 1 FROM sqlite_temp_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
    )
  ).length;
}
function idsValid(ids: InitialIdentifiers) {
  const values = [ids.installationId, ids.shoppingScopeId, ids.conversationId];
  return values.every(isAppId) && new Set(values).size === values.length;
}
function encode(marker: AccountMarker) {
  return canonicalContentJson(marker, markerBytes);
}
async function readMarker(
  session: SqlSession,
  config: Readonly<PrivateContentConfiguration>,
  ownerId: string,
) {
  const [row] = await session.all<{ value: string | null }>(
    "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END value FROM app_metadata WHERE key=?",
    [markerBytes, CONTENT_ACCOUNT_MARKER_KEY],
  );
  if (!row) return fail('unowned');
  let marker: AccountMarker;
  try {
    marker = JSON.parse(row.value ?? '') as AccountMarker;
    if (
      !marker ||
      typeof marker !== 'object' ||
      Array.isArray(marker) ||
      Object.keys(marker).sort().join(',') !==
        'conversationId,copyGuest,databaseName,installationId,origin,ownerId,phase,shoppingScopeId,version' ||
      marker.version !== 1 ||
      !idsValid(marker) ||
      marker.ownerId !== ownerId ||
      marker.origin !== config.origin ||
      marker.installationId !== config.installationId ||
      marker.databaseName !== privateContentAccountDatabaseName(config.installationId, ownerId) ||
      typeof marker.copyGuest !== 'boolean' ||
      !['copied', 'ready'].includes(marker.phase) ||
      encode(marker) !== row.value
    )
      throw new Error();
  } catch {
    return fail('identity');
  }
  const [installation] = await session.all<{ value: string }>(
    "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END value FROM app_metadata WHERE key='installation_id'",
  );
  if (installation?.value !== config.installationId) return fail('identity');
  const binding = await readBinding(session);
  if ((marker.phase === 'copied' && binding !== null) || (binding !== null && binding !== ownerId))
    return fail('identity');
  return Object.freeze(marker);
}

/** Selection filenames remain logical and installation-specific. Physical aliases are a separate port. */
export function contentAccountWorkspaceNaming(
  installationId: string,
): WorkspaceDatabaseNamingPolicy {
  const { cooking } = privateContentDatabaseNames(installationId);
  return Object.freeze({
    guestDatabase: cooking,
    accountDatabaseName: (ownerId: string) =>
      privateContentAccountDatabaseName(installationId, ownerId),
  });
}
export function contentAccountManifestKey(installationId: string) {
  privateContentDatabaseNames(installationId);
  return `cookmate.content-workspaces.v1.${installationId}`;
}

export interface ContentAccountWorkspacePorts {
  config: Readonly<PrivateContentConfiguration>;
  platform: Pick<CommandPlatform, 'newId' | 'sha256'>;
  assertClosed(): void;
  /** Includes guest publication/receipt-reference holds; the clone must not strand pending guest work. */
  assertGuestRecoverySettled(assertClosed: () => void): Promise<void>;
  openConnection(name: string): Promise<SqlConnection>;
  /** Atomically copies an independently stamped image. The source itself must NEVER be stamped.
   * Destination is already verified empty and the close barrier remains held. A failed backup
   * leaves either the empty destination or the complete image with this exact marker.
   */
  cloneGuestWithMarker(
    sourceName: string,
    destinationName: string,
    marker: { key: string; value: string },
    assertClosed: () => void,
  ): Promise<void>;
  deleteDatabase(name: string, assertClosed: () => void): Promise<void>;
  /** Idempotent preferences/draft copy only; do not copy guest operation-reference authority. */
  copyGuestPrivateState(ownerId: string): Promise<void>;
  removePrivateState(ownerId: string): Promise<void>;
}

/** One adapter per configured lifecycle, called only by its durable selection and close barrier.
 * It prepares private copies; initial ownership/consent is still committed by the existing journal.
 */
export function createContentAccountWorkspaceAdapter(
  input: ContentAccountWorkspacePorts,
): WorkspaceDatabaseAdapter & {
  verify(ownerId: string): Promise<{ binding: string | null }>;
} {
  const config = ownPrivateContentConfiguration(input.config);
  const {
    openConnection,
    assertClosed,
    assertGuestRecoverySettled,
    cloneGuestWithMarker,
    deleteDatabase,
    copyGuestPrivateState,
    removePrivateState,
  } = input;
  const { newId, sha256 } = input.platform;
  let busy = false;
  let cleanupFailure: PrivateContentCleanupError | undefined;
  function check() {
    if (cleanupFailure) throw cleanupFailure;
    assertClosed();
  }
  const hash = async (text: string) => {
    check();
    const result = await sha256(text);
    check();
    if (typeof result !== 'string' || result.length !== 64 || !/^[0-9a-f]{64}$/.test(result))
      return fail('identity');
    return result;
  };
  async function connection<T>(name: string, work: (db: SqlConnection) => Promise<T>): Promise<T> {
    check();
    const db = await openConnection(name);
    let primary: unknown;
    try {
      check();
      await configureConnection(db);
      check();
      return await work(db);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try {
        await db.close();
      } catch (error) {
        cleanupFailure = new PrivateContentCleanupError(
          primary === undefined ? [error] : [primary, error],
        );
        throw cleanupFailure;
      }
    }
  }
  async function serial<T>(ownerId: string, work: (name: string) => Promise<T>) {
    const name = privateContentAccountDatabaseName(config.installationId, ownerId);
    check();
    if (busy) return fail('busy');
    busy = true;
    try {
      return await work(name);
    } catch (error) {
      if (error instanceof PrivateContentCleanupError) cleanupFailure = error;
      throw error;
    } finally {
      busy = false;
    }
  }
  async function inspect(
    db: SqlSession,
    ownerId: string,
    copyGuest?: boolean,
  ): Promise<
    { current: 0; marker: null } | { current: 6 | 7 | 8; marker: Readonly<AccountMarker> }
  > {
    check();
    const current = await version(db);
    check();
    if (current === 0 && (await empty(db))) return { current: 0 as const, marker: null };
    if (current !== 6 && current !== 7 && current !== 8) return fail('schema');
    const marker = await readMarker(db, config, ownerId);
    check();
    if (copyGuest !== undefined && marker.copyGuest !== copyGuest) return fail('identity');
    return { current, marker };
  }
  async function verify(ownerId: string) {
    return serial(ownerId, async (name) =>
      connection(name, async (db) => {
        const state = await inspect(db, ownerId);
        if (state.current !== 8 || state.marker?.phase !== 'ready') return fail('identity');
        return { binding: await readBinding(db) };
      }),
    );
  }
  return Object.freeze({
    verify,
    prepare: (ownerId: string, copyGuest: boolean) =>
      serial(ownerId, async (name) => {
        let state = await connection(name, (db) => inspect(db, ownerId, copyGuest));
        if (state.marker?.phase === 'ready') {
          if (state.current !== 8) return fail('schema');
          return;
        }
        if (!state.marker && copyGuest) {
          await assertGuestRecoverySettled(check);
          check();
          const guestName = privateContentDatabaseNames(config.installationId).cooking;
          await connection(guestName, async (db) => {
            if ((await version(db)) !== 8) return fail('schema');
          });
          const prepared = await preparePrivateContentWorkspace({
            config,
            openConnection,
            platform: { newId, sha256: hash },
          });
          check();
          if (prepared.kind !== 'already_prepared') return fail('schema');
          const ids = await connection(guestName, async (db) => {
            if ((await readBinding(db)) !== null) return fail('identity');
            if (
              (
                await db.all(
                  "SELECT 1 FROM pending_intent WHERE phase NOT IN ('settled','cancelled') UNION ALL SELECT 1 FROM assistant_intent_context WHERE lifecycle='awaiting_response' UNION ALL SELECT 1 FROM direct_command_recovery LIMIT 1",
                )
              ).length
            )
              return fail('guest_recovery');
            const [saved] = await db.all<{ value: string | null }>(
              "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=2048 THEN value END value FROM app_metadata WHERE key='private-content:preparation'",
            );
            const source = JSON.parse(saved?.value ?? 'null') as InitialIdentifiers | null;
            const ids = {
              installationId: source?.installationId!,
              shoppingScopeId: source?.shoppingScopeId!,
              conversationId: source?.conversationId!,
            };
            if (!idsValid(ids)) return fail('identity');
            return ids;
          });
          const marker: AccountMarker = {
            version: 1,
            ...ids,
            origin: config.origin,
            databaseName: name,
            ownerId,
            copyGuest: true,
            phase: 'copied',
          };
          // A complete clone carries the marker in the same SQLite backup commit.
          check();
          await cloneGuestWithMarker(
            guestName,
            name,
            {
              key: CONTENT_ACCOUNT_MARKER_KEY,
              value: encode(marker),
            },
            check,
          );
          check();
          state = await connection(name, (db) => inspect(db, ownerId, true));
          if (state.current !== 8 || !state.marker || encode(state.marker) !== encode(marker))
            return fail('identity');
        }
        const marker: AccountMarker = state.marker ?? {
          version: 1,
          installationId: config.installationId,
          shoppingScopeId: newId(),
          conversationId: newId(),
          origin: config.origin,
          databaseName: name,
          ownerId,
          copyGuest: false,
          phase: 'copied',
        };
        if (!idsValid(marker)) return fail('identity');
        await connection(name, async (db) => {
          class PreparedWriter extends SerializedWriter {
            override transaction<T>(
              work: (session: SqlSession) => Promise<T>,
              impact?: RecoveryImpact,
              commit?: () => undefined,
            ) {
              return super.transaction(
                async (session) => {
                  const before = await inspect(session, ownerId, copyGuest);
                  if (before.marker && encode(before.marker) !== encode(marker))
                    return fail('identity');
                  if (!before.marker && (copyGuest || before.current !== 0)) return fail('unowned');
                  const result = await work(session);
                  check();
                  const afterVersion = await version(session);
                  if (before.current === 0 && afterVersion !== 0) {
                    if (afterVersion !== 6) return fail('schema');
                    await runBound(session, 'INSERT INTO app_metadata(key,value) VALUES (?,?)', [
                      CONTENT_ACCOUNT_MARKER_KEY,
                      encode(marker),
                    ]);
                  }
                  const after = await inspect(session, ownerId, copyGuest);
                  if (!after.marker || encode(after.marker) !== encode(marker))
                    return fail('identity');
                  return result;
                },
                impact,
                () => {
                  check();
                  commit?.();
                  check();
                  return undefined;
                },
              );
            }
          }
          const writer = new PreparedWriter(db);
          // Every transaction is awaited; the connection helper owns the one close.
          await completePreparedContentSchema(
            writer,
            {
              installationId: marker.installationId,
              shoppingScopeId: marker.shoppingScopeId,
              conversationId: marker.conversationId,
            },
            hash,
            state.current,
          );
        });
        if (copyGuest) {
          await copyGuestPrivateState(ownerId);
          check();
        }
        await connection(name, async (db) => {
          const writer = new SerializedWriter(db);
          await writer.transaction(
            async (session) => {
              const before = await inspect(session, ownerId, copyGuest);
              if (
                before.current !== 8 ||
                !before.marker ||
                encode(before.marker) !== encode(marker)
              )
                return fail('identity');
              await runBound(session, 'UPDATE app_metadata SET value=? WHERE key=? AND value=?', [
                encode({ ...marker, phase: 'ready' }),
                CONTENT_ACCOUNT_MARKER_KEY,
                encode(marker),
              ]);
              const after = await inspect(session, ownerId, copyGuest);
              if (after.marker?.phase !== 'ready') return fail('identity');
            },
            { kind: 'none' },
            () => {
              check();
              return undefined;
            },
          );
        });
      }),
    remove: (ownerId: string) =>
      serial(ownerId, async (name) => {
        await connection(name, async (db) => {
          const state = await inspect(db, ownerId);
          if (state.marker && (state.current !== 8 || state.marker.phase !== 'ready'))
            return fail('identity');
        });
        check();
        await deleteDatabase(name, check);
        check();
        await removePrivateState(ownerId);
        check();
      }),
  });
}
