import type { AccountReplicationScope, AccountSnapshotOptions } from '@cookmate/account-sync';
import type { CatalogueIdentity } from '@cookmate/contracts';
import {
  createContentAccountBootstrap,
  type ContentAccountBootstrap,
} from '../../data/contentAccountServices';
import { exact, uuid, revision } from '../../data/accountReplicationRecords';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlConnection,
} from '../../data/sql';
import { privateContentAccountDatabaseName } from './privateContentConfig';
import type { PrivateContentLifecycleController } from './privateContentController';
import { PrivateContentCleanupError } from './privateContentRuntime';

export interface ContentAccountBootstrapHandle {
  readonly kind: 'account_bootstrap';
  readonly services: ContentAccountBootstrap;
  close(): Promise<void>;
}

/** A first-account review borrows the existing controller's closed-workspace lease for its
 * entire lifetime. It exposes only existing approval/capture/journal services. Reviewed staging
 * performs the first binding; close must finish before the ordinary bound runtime can open.
 */
export function openContentAccountBootstrap(options: {
  controller: Pick<PrivateContentLifecycleController, 'whileClosed'>;
  installationId: string;
  catalogue: Readonly<CatalogueIdentity>;
  scope: Readonly<AccountReplicationScope>;
  currentScope(): AccountReplicationScope | null;
  /** Verify the existing preparation marker inside this supplied lease, without reacquiring it. */
  verifyPrepared(assertClosed: () => void): Promise<{ binding: string | null }>;
  openConnection(name: string): Promise<SqlConnection>;
  getLocalSettings(): AccountSnapshotOptions;
  now(): string;
  newId(): string;
  sha256(text: string): Promise<string>;
}): Promise<ContentAccountBootstrapHandle> {
  if (
    !exact(options.scope, ['ownerId', 'authGeneration']) ||
    !uuid(options.scope.ownerId) ||
    !revision(options.scope.authGeneration) ||
    !uuid(options.installationId)
  )
    return Promise.reject(new Error('Invalid account bootstrap scope.'));
  const scope = Object.freeze({ ...options.scope });
  const {
    installationId,
    currentScope,
    verifyPrepared,
    openConnection,
    getLocalSettings,
    now,
    newId,
    sha256,
  } = options;
  const catalogue = Object.freeze({ ...options.catalogue });
  const whileClosed = options.controller.whileClosed.bind(options.controller);
  const name = privateContentAccountDatabaseName(installationId, scope.ownerId);
  let resolveReady!: (handle: ContentAccountBootstrapHandle) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<ContentAccountBootstrapHandle>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let retired = false;
  let service: ContentAccountBootstrap | undefined;
  let reader: SerializedReader | undefined, writer: SerializedWriter | undefined;
  const connections = new Set<SqlConnection>();
  const completed = whileClosed(async (assertClosed) => {
    const check = () => {
      assertClosed();
      const current = currentScope();
      if (
        retired ||
        current?.ownerId !== scope.ownerId ||
        current.authGeneration !== scope.authGeneration
      )
        throw new Error('Account bootstrap owner changed.');
    };
    async function open() {
      check();
      const connection = await openConnection(name);
      if (connections.has(connection))
        throw new Error('Account bootstrap connections must be distinct.');
      connections.add(connection);
      const tracked: SqlConnection = {
        all: connection.all.bind(connection),
        exec: connection.exec.bind(connection),
        prepare: connection.prepare.bind(connection),
        async close() {
          await connection.close();
          connections.delete(connection);
        },
      };
      check();
      await configureConnection(tracked);
      check();
      return tracked;
    }
    try {
      check();
      const prepared = await verifyPrepared(assertClosed);
      check();
      if (prepared.binding !== null)
        throw new Error('Account bootstrap requires an unbound prepared copy.');
      const queue = new SqlTransactionQueue();
      writer = new SerializedWriter(await open(), queue);
      const read = await open();
      await read.exec('PRAGMA query_only=ON');
      check();
      reader = new SerializedReader(read, queue);
      service = await createContentAccountBootstrap({
        reader,
        writer,
        installationId,
        catalogue,
        scope,
        currentScope: () => {
          check();
          return scope;
        },
        getLocalSettings,
        now,
        newId,
        sha256,
      });
      check();
      resolveReady(
        Object.freeze({
          kind: 'account_bootstrap' as const,
          services: service,
          close() {
            retired = true;
            service?.close();
            release();
            return completed;
          },
        }),
      );
      await released;
    } finally {
      retired = true;
      service?.close();
      const failures: unknown[] = [];
      // Drain the one shared transaction queue before retrying raw handles that failed to close.
      for (const owner of [writer, reader]) {
        try {
          await owner?.close();
        } catch (error) {
          failures.push(error);
        }
      }
      for (const connection of connections) {
        try {
          await connection.close();
          connections.delete(connection);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new PrivateContentCleanupError(failures);
    }
  });
  // A post-publication failure is returned by close; an opening failure rejects ready.
  void completed.catch(rejectReady);
  return ready;
}
