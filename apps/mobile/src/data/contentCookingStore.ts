import type { CommandPlatform, CookingChange, PersonalChange, StoreChange } from '@cookmate/domain';
import type { DateContext } from '@cookmate/contracts';
import { catalogue } from '@cookmate/catalogue';
import { readBinding } from './accountReplicationRecords';
import { verifyAccountContentHistorySchema } from './accountContentHistoryMigration';
import { createAdoptedContentReader } from './adoptedContentReader';
import { createContentAdoptionService, type ContentAdoptionAccess } from './contentAdoption';
import { createContentDirectCommands } from './contentDirectCommands';
import { createContentCookingSessions } from './contentCookingSessions';
import { createContentCookingHistory } from './contentCookingHistory';
import { createContentCookingHistoryReader } from './contentCookingHistoryRead';
import { createContentCookingHistoryClear } from './contentCookingHistoryClear';
import { createContentPersonalNotes } from './contentPersonalNotes';
import { createContentManualShopping } from './contentManualShopping';
import { createContentCollections } from './contentCollections';
import { createContentWorkspaceQueries } from './contentWorkspaceQueries';
import { createPortableContentBackupReader } from './portableContentBackup';
import { createPortableContentBackupInspector } from './portableContentInspection';
import { createPortableContentRestoreService } from './portableContentRestore';
import {
  createContentAccountServices,
  type ContentAccountServicesOptions,
} from './contentAccountServices';
import type { openContentReleaseStore } from './contentReleaseStore';
import { isAppId, isRevision } from './conversationRecords';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  StorageFault,
  type SqlConnection,
} from './sql';

export type ContentCookingStoreChange =
  | { kind: 'store'; value: StoreChange }
  | { kind: 'cooking'; value: CookingChange }
  | { kind: 'personal'; value: PersonalChange }
  | { kind: 'restore'; value: StoreChange; personal: boolean; cookingHistory: boolean }
  | { kind: 'account'; value: StoreChange; personal: boolean; cookingHistory: boolean }
  | { kind: 'adoption'; storeRevision: number };

interface Options {
  /** Only an already deliberately migrated, independently backed-up private workspace. */
  schemaVersion: 8;
  installationId: string;
  /** Each call transfers one distinct connection to this store, including on failed opening. */
  openConnection(mode: 'read' | 'write'): Promise<SqlConnection>;
  /** Shared verified content store; its lifecycle remains with the host. */
  contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReading' | 'withVerifiedAdoption' | 'withVerifiedReferenceInspection'
  >;
  platform: CommandPlatform;
  now(): string;
  dateContext(): DateContext;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
}

/**
 * Private content-aware cooking composition, not the default CookMateServices facade.
 * Never creates/migrates a database, activates a release or opens account/network services.
 * The host must still supply content-aware UI and separate account/AI services.
 */
export async function openContentCookingStore(options: Options) {
  // Own authority/dependency functions before the first await; retaining the caller's
  // mutable options object must not allow a revoked workspace to be re-authorized.
  const {
    schemaVersion,
    installationId,
    getAccess,
    assertAccess,
    openConnection,
    now,
    dateContext,
  } = options;
  const platform = Object.freeze({
    newId: options.platform.newId,
    sha256: options.platform.sha256,
  });
  const contentStore = Object.freeze({
    withVerifiedReading: options.contentStore.withVerifiedReading,
    withVerifiedAdoption: options.contentStore.withVerifiedAdoption,
    withVerifiedReferenceInspection: options.contentStore.withVerifiedReferenceInspection,
  });
  const access = getAccess();
  if (
    schemaVersion !== 8 ||
    !isAppId(installationId) ||
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !isRevision(access.authGeneration)
  )
    throw new StorageFault('incompatible_version', 'Content cooking workspace is not admitted');
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  let closed = false;
  function check(): undefined {
    const live = getAccess();
    if (
      closed ||
      !live ||
      live.ownerId !== scope.ownerId ||
      live.authGeneration !== scope.authGeneration ||
      assertAccess(scope) !== undefined
    )
      throw new StorageFault('storage_failure', 'Content cooking workspace access changed');
    return undefined;
  }
  const connections = new Set<SqlConnection>();
  let reader: SerializedReader | undefined;
  let writer: SerializedWriter | undefined;
  try {
    check();
    const write = await openConnection('write');
    connections.add(write);
    check();
    await configureConnection(write);
    check();
    const read = await openConnection('read');
    if (connections.has(read))
      throw new StorageFault('storage_failure', 'Content cooking connections must be distinct');
    connections.add(read);
    check();
    await configureConnection(read);
    await read.exec('PRAGMA query_only=ON');
    check();
    const queue = new SqlTransactionQueue();
    writer = new SerializedWriter(write, queue);
    reader = new SerializedReader(read, queue);
    await reader.transaction(
      async (session) => {
        check();
        await verifyAccountContentHistorySchema(session);
        check();
        const [row] = await session.all<{ id: string | null }>(
          "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
        );
        if (row?.id !== installationId || (await readBinding(session)) !== scope.ownerId)
          throw new StorageFault('storage_failure', 'Content cooking workspace binding differs');
        check();
      },
      { kind: 'read_only' },
    );
    check();
    const listeners = new Set<(change: ContentCookingStoreChange) => void>();
    const notify = (change: ContentCookingStoreChange) => {
      for (const listener of listeners) {
        try {
          check();
        } catch {
          return;
        }
        try {
          listener(change);
        } catch {
          /* A view callback cannot invalidate a saved receipt. */
        }
      }
    };
    const common = {
      reader,
      writer,
      installationId,
      contentStore,
      sha256: platform.sha256,
      now,
      getAccess: () => (closed ? null : getAccess()),
      assertAccess: () => check(),
    };
    const content = createAdoptedContentReader(common);
    const queries = createContentWorkspaceQueries(common);
    const adoption = createContentAdoptionService({
      ...common,
      cookingSchemaVersion: 8,
      newId: platform.newId,
    });
    const commands = createContentDirectCommands({
      ...common,
      commandSchemaVersion: 8,
      platform,
      dateContext,
      onCommitted: (value) => notify({ kind: 'store', value }),
    });
    const cookingOptions = {
      ...common,
      cookingSchemaVersion: 8 as const,
      onCommitted: (value: CookingChange) => notify({ kind: 'cooking', value }),
    };
    const sessions = createContentCookingSessions(cookingOptions);
    const cooked = createContentCookingHistory({
      ...cookingOptions,
      dateContext,
    });
    const history = createContentCookingHistoryReader(common);
    const clearHistory = createContentCookingHistoryClear({
      ...cookingOptions,
      newId: platform.newId,
    });
    const notes = createContentPersonalNotes({
      ...common,
      platform,
      onCommitted: (value: PersonalChange) => notify({ kind: 'personal', value }),
    });
    const manual = createContentManualShopping({
      ...common,
      platform,
      onCommitted: (value: PersonalChange) => notify({ kind: 'personal', value }),
    });
    const collections = createContentCollections({
      ...common,
      platform,
      onCommitted: (value: PersonalChange) => notify({ kind: 'personal', value }),
    });
    const backupReader = createPortableContentBackupReader({
      ...common,
      catalogue: catalogue.identity,
    });
    const backupInspector = createPortableContentBackupInspector(common);
    let restore: ReturnType<typeof createPortableContentRestoreService> | undefined;
    let restoreChange: Extract<ContentCookingStoreChange, { kind: 'restore' }> | undefined;
    let account: Awaited<ReturnType<typeof createContentAccountServices>> | undefined;
    let accountConnecting = false;
    let accountChange: Extract<ContentCookingStoreChange, { kind: 'account' }> | undefined;
    const ownedReader = reader,
      ownedWriter = writer;
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      installationId,
      scope,
      content,
      queries,
      commands,
      sessions,
      cooked,
      history,
      clearHistory,
      notes,
      manual,
      collections,
      backup: Object.freeze({
        capture: backupReader.capture,
        inspect: backupInspector.inspect,
      }),
      /** The transferred store has one host. Only that host supplies exclusive admission. */
      connectRestore(acquireExclusive: () => (() => void) | null) {
        check();
        if (restore) throw new StorageFault('storage_failure', 'Restore host already connected');
        restore = createPortableContentRestoreService({
          ...common,
          cookingSchemaVersion: 8,
          catalogue: catalogue.identity,
          newId: platform.newId,
          acquireExclusive,
          onCommitted: (value, expanded) => {
            // The engine reports a proved commit while the host still excludes other work.
            // Flush after that host reservation ends so refresh callbacks can read safely.
            restoreChange = {
              kind: 'restore',
              value,
              personal: expanded?.personal ?? false,
              cookingHistory: expanded?.cookingHistory ?? false,
            };
          },
        });
        return Object.freeze({
          service: restore,
          flushCommitted() {
            check();
            const change = restoreChange;
            restoreChange = undefined;
            if (change) notify(change);
            check();
          },
        });
      },
      /** Only for an already owner-bound installation; never binds the active guest in place. */
      async connectAccount(
        input: Pick<ContentAccountServicesOptions, 'getLocalSettings' | 'acquireExclusive'>,
      ) {
        check();
        if (scope.ownerId === null || accountConnecting)
          throw new StorageFault(
            'storage_failure',
            'Account owner is unavailable or already connected',
          );
        accountConnecting = true;
        const accountScope = Object.freeze({
          ownerId: scope.ownerId,
          authGeneration: scope.authGeneration,
        });
        const created = await createContentAccountServices({
          reader: ownedReader,
          writer: ownedWriter,
          installationId,
          catalogue: catalogue.identity,
          scope: accountScope,
          currentScope: () => {
            check();
            return accountScope;
          },
          getLocalSettings: input.getLocalSettings,
          acquireExclusive: input.acquireExclusive,
          now,
          newId: platform.newId,
          sha256: platform.sha256,
          contentStore,
          onCommitted: (value, expanded) => {
            accountChange = {
              kind: 'account',
              value,
              personal: expanded.personalRevision !== undefined,
              cookingHistory: expanded.historyRevision !== undefined,
            };
          },
        });
        try {
          check();
        } catch (error) {
          created.close();
          throw error;
        }
        account = created;
        return Object.freeze({
          service: account,
          flushCommitted() {
            check();
            const change = accountChange;
            accountChange = undefined;
            if (change) notify(change);
            check();
          },
        });
      },
      adoption: Object.freeze({
        readReleaseContext: adoption.readReleaseContext,
        readMealChoices: adoption.readMealChoices,
        review: adoption.review,
        recover: adoption.recover,
        async adopt(review: Parameters<typeof adoption.adopt>[0]) {
          const receipt = await adoption.adopt(review);
          check();
          notify({ kind: 'adoption', storeRevision: receipt.storeRevision });
          check();
          return receipt;
        },
      }),
      subscribe(listener: (change: ContentCookingStoreChange) => void) {
        check();
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close(): Promise<void> {
        if (closePromise) return closePromise;
        closed = true;
        listeners.clear();
        restoreChange = undefined;
        restore?.close();
        accountChange = undefined;
        account?.close();
        for (const service of [
          content,
          queries,
          commands,
          sessions,
          cooked,
          history,
          clearHistory,
          notes,
          manual,
          collections,
          backupReader,
          backupInspector,
        ])
          service.close();
        closePromise = (async () => {
          const failures: unknown[] = [];
          for (const handle of [ownedReader, ownedWriter]) {
            try {
              await handle.close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length) throw new AggregateError(failures, 'Content cooking cleanup failed');
        })();
        return closePromise;
      },
    });
  } catch (error) {
    closed = true;
    const failures: unknown[] = [];
    for (const connection of connections) {
      try {
        await connection.close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], 'Content cooking opening and cleanup failed');
    throw error;
  }
}
