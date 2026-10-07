import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { DateContext } from '@cookmate/contracts';
import { CommandPreparationError, createCommandPreparer } from '@cookmate/domain';
import type {
  CommandPlatform,
  CookingMutationResult,
  PersonalMutationResult,
  DirectActionReview,
  Immutable,
  AssistantPersistencePort,
  CookMateServices,
  RepositoryResult,
  StoreChange,
} from '@cookmate/domain';
import { recoverInterruptedAssistantWork } from './assistantRecovery';
import { createCatalogueRepository } from './catalogueRepository';
import { createClearConversationCommandHandler } from './clearConversationCommand';
import { requireReviewedConversationClear } from './conversationClearScope';
import { CommandFault, createCommandExecutor, registerReadyIntent } from './commandExecutor';
import { createDirectActionReviewer } from './directActionReview';
import { createDirectRecoveryRepository } from './directRecoveryRepository';
import { createAssistantAttemptRecovery } from './assistantAttemptRecovery';
import {
  createAssistantActionRepository,
  createAssistantCommandHooks,
} from './assistantActionRepository';
import { createAssistantContextRepository } from './assistantContextRepository';
import { createAssistantTurnRepository } from './assistantTurnRepository';
import { createConversationRepository } from './conversationRepository';
import { createConversationExportReader } from './conversationExport';
import { favouriteCommandHandlers } from './favouriteCommands';
import { initializeDatabase } from './initialize';
import { createPlanCommandHandlers } from './planCommands';
import { preferenceCommandHandlers } from './preferenceCommands';
import { freezeResult, readSnapshot } from './query';
import { createShoppingCommandHandlers } from './shoppingCommands';
import { createShoppingRepository } from './shoppingRepository';
import { createStateRepositories, readReceiptInSnapshot } from './stateRepositories';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  StorageFault,
} from './sql';
import type { SqlConnection, SqlSession } from './sql';
import { isAppId, requireConversationRecord } from './conversationRecords';
import { createAssistantRecoveryGate } from './recoveryGate';
import { createPortableBackupReader } from './portableBackup';
import { createPortableRestoreService } from './portableRestore';
import { readRestoreEpoch } from './restoreEpoch';
import { createCookingRepository } from './cookingRepository';
import { createPersonalRepository } from './personalRepository';
import { createAccountReplicationRepository } from './accountReplication';
import { createAccountScopeApprovalService } from './accountScopeApproval';
import { AccountReplicationError } from '@cookmate/account-sync';
import type {
  AccountReplicationScope,
  AccountSnapshotOptions,
  AccountReplicationRepository,
} from '@cookmate/account-sync';
import type { LocalCookMateServices, LocalStoreInitializationResult } from './localServices';
import { requiresWebStorageReload } from './webStorageFailure';

export interface LocalStoreOptions {
  /** Explicit rollout only, after an independently verified backup. Never enabled by default. */
  enablePortableRestore?: boolean;
  /** Independent opt-in rollout: the default v3 facade never migrates to v4. */
  enableCooking?: boolean;
  /** Private organization remains opt-in until the schema5/UI slice is verified. */
  enablePersonal?: boolean;
  /** Explicit schema6 rollout; requires the personal/cooking/restore chain. */
  enableAccountHistory?: boolean;
  /** Explicit app-owned identity. No tokens belong in the local database. */
  accountReplication?: {
    currentScope(): AccountReplicationScope | null;
    getLocalSettings(): AccountSnapshotOptions;
    enableExpandedScope?: boolean;
  };
  /** Must return a newly owned connection for each call; the factory configures/query-isolates it. */
  openConnection(mode: 'read' | 'write'): Promise<SqlConnection>;
  platform: CommandPlatform;
  now(): string;
  dateContext(): DateContext;
}
const unavailable = {
  code: 'storage_failure' as const,
  messageKey: 'storage.closed',
  retry: 'after_correction' as const,
};
const restoreBusy = {
  code: 'stale_context' as const,
  messageKey: 'restore.store_busy',
  retry: 'after_correction' as const,
};

/** Local facade composition. Its ready result is runtime availability, not native acceptance evidence. */
export async function createLocalStore(
  options: LocalStoreOptions,
): Promise<LocalStoreInitializationResult> {
  let writeConnection: SqlConnection | undefined;
  let readConnection: SqlConnection | undefined;
  let writer: SerializedWriter | undefined;
  let reader: SerializedReader | undefined;
  let recoveryGate: ReturnType<typeof createAssistantRecoveryGate> | undefined;
  const transactionQueue = new SqlTransactionQueue();
  try {
    if (options.accountReplication && !options.enablePortableRestore)
      throw new StorageFault(
        'storage_failure',
        'Account replication requires the verified backup rollout',
      );
    writeConnection = await options.openConnection('write');
    await configureConnection(writeConnection);
    writer = new SerializedWriter(writeConnection, transactionQueue);
    let openingSchemaCookie: number | undefined;
    const initialization = await initializeDatabase(
      writer,
      {
        identity: catalogue.identity,
        recipes: catalogue.recipes,
        recipeSources: catalogueProvenance.recipeSources,
      },
      {
        installationId: options.platform.newId(),
        shoppingScopeId: options.platform.newId(),
        conversationId: options.platform.newId(),
      },
      {
        enablePortableRestore: options.enablePortableRestore === true,
        enableCooking: options.enableCooking === true,
        enablePersonal: options.enablePersonal === true,
        enableAccountHistory: options.enableAccountHistory === true,
        onValidatedSchemaCookie: (cookie) => {
          openingSchemaCookie = cookie;
        },
      },
    );
    if (openingSchemaCookie === undefined)
      throw new StorageFault('storage_failure', 'Opening schema identity was not captured');
    const ownedWriter = writer;
    const ownedRecoveryGate = (recoveryGate = createAssistantRecoveryGate({
      writer: ownedWriter,
      catalogue: catalogueBoundary,
      platform: options.platform,
      openingSchemaCookie,
    }));
    await recoverInterruptedAssistantWork(writer, catalogueBoundary);
    readConnection = await options.openConnection('read');
    if (readConnection === writeConnection)
      throw new StorageFault('storage_failure', 'Read and write connections must be distinct');
    await configureConnection(readConnection);
    await readConnection.exec('PRAGMA query_only=ON');
    reader = new SerializedReader(readConnection, transactionQueue);
    const ownedReader = reader;
    const recovery = createDirectRecoveryRepository(
      ownedWriter,
      catalogueBoundary,
      options.platform,
    );
    const recipes = new Map(catalogue.recipes.map((recipe) => [recipe.recipeId, recipe]));
    const projection = {
      readRecipe: (id: string) => recipes.get(id),
      sha256: options.platform.sha256,
    };
    const catalogueQueries = createCatalogueRepository(ownedReader);
    const stateQueries = createStateRepositories(ownedReader, catalogueBoundary);
    const shoppingQueries = createShoppingRepository(ownedReader, projection);
    const readPortableBackup = createPortableBackupReader(ownedReader, {
      catalogue: catalogue.identity,
      sha256: options.platform.sha256,
      now: options.now,
    });
    const readConversationExport = createConversationExportReader(ownedReader, {
      catalogue: catalogueBoundary,
      now: options.now,
    });
    const prepare = createCommandPreparer(options.platform, catalogueBoundary);
    let restoreGeneration = 0;
    const directReviews = new WeakMap<object, { generation: number; epoch: number }>();
    const review = createDirectActionReviewer(ownedReader, {
      ...projection,
      catalogue: catalogueBoundary,
      platform: options.platform,
      ...(options.enablePortableRestore || options.accountReplication
        ? {
            onReviewed: async (session: SqlSession, reviewed: Immutable<DirectActionReview>) => {
              directReviews.set(reviewed, {
                generation: restoreGeneration,
                epoch: await readRestoreEpoch(session),
              });
            },
          }
        : {}),
    });
    const listeners = new Set<(change: StoreChange) => void>();
    const pending = new Set<Promise<unknown>>();
    let closing = false;
    let restoring = false;
    let closePromise: Promise<void> | undefined;
    let connectionBinding: (() => number) | undefined;
    let assistantPort: AssistantPersistencePort | undefined;
    const connectionGeneration = () => connectionBinding?.() ?? 0;
    const track = <Value>(operation: () => Promise<Value>): Promise<Value> => {
      const promise = operation();
      pending.add(promise);
      void promise.finally(() => pending.delete(promise)).catch(() => undefined);
      return promise;
    };
    const query = <Value>(
      operation: () => Promise<RepositoryResult<Value>>,
    ): Promise<RepositoryResult<Value>> =>
      closing || restoring
        ? Promise.resolve({ kind: 'failed', error: closing ? unavailable : restoreBusy })
        : track(operation);
    const notify = (change: StoreChange) => {
      const recovery = ownedRecoveryGate.unchangedCertificate();
      const owned = freezeResult({
        revision: change.revision,
        collections: [...change.collections],
        ...(recovery ? { recovery } : {}),
        ...(change.conversationChange ? { conversationChange: change.conversationChange } : {}),
      });
      for (const listener of [...listeners]) {
        try {
          listener(owned);
        } catch {
          /* One consumer cannot block another or undo a commit. */
        }
      }
    };
    const attempts = createAssistantAttemptRecovery();
    const acquireExclusive = () => {
      if (closing || restoring || pending.size > 0) return null;
      restoring = true;
      assistantPort?.invalidateActionContinuationReview();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        restoring = false;
      };
    };
    const executor = createCommandExecutor({
      assistantHooks: createAssistantCommandHooks({
        attempts,
        catalogue: catalogueBoundary,
        platform: options.platform,
        dateContext: options.dateContext,
        connectionGeneration,
      }),
      writer: ownedWriter,
      catalogue: catalogueBoundary,
      platform: options.platform,
      handlers: {
        ...favouriteCommandHandlers,
        ...preferenceCommandHandlers,
        ...createClearConversationCommandHandler({ ...projection, catalogue: catalogueBoundary }),
        ...createPlanCommandHandlers(projection),
        ...createShoppingCommandHandlers(projection),
      },
      now: options.now,
      dateContext: options.dateContext,
      onCommitted: notify,
      readReceipt: (id) =>
        readSnapshot(ownedReader, (session) =>
          readReceiptInSnapshot(session, id, catalogueBoundary),
        ),
    });
    const restore = options.enablePortableRestore
      ? createPortableRestoreService({
          ...projection,
          reader: ownedReader,
          writer: ownedWriter,
          catalogue: catalogue.identity,
          knownRecipeIds: catalogueBoundary.recipeIds,
          platform: options.platform,
          now: options.now,
          acquireExclusive,
          onCommitted: (change, expanded) => {
            restoreGeneration++;
            notify(change);
            if (expanded?.personal) personal?.notifyRestored(change.revision);
            if (expanded?.cookingHistory) cooking?.notifyRestored(change.revision);
          },
        })
      : undefined;
    const cooking = options.enableCooking
      ? createCookingRepository({
          reader: ownedReader,
          writer: ownedWriter,
          platform: options.platform,
          catalogue: catalogue.identity,
          readRecipe: projection.readRecipe,
          now: options.now,
          dateContext: options.dateContext,
          onCommitted: (change) => notify({ revision: change.revision, collections: [] }),
        })
      : undefined;
    const cookingMutation = <Value>(
      operation: () => Promise<CookingMutationResult<Value>>,
    ): Promise<CookingMutationResult<Value>> =>
      closing || restoring
        ? Promise.resolve({ kind: 'failed', error: closing ? unavailable : restoreBusy })
        : track(operation);
    const personal = options.enablePersonal
      ? createPersonalRepository({
          reader: ownedReader,
          writer: ownedWriter,
          platform: options.platform,
          recipeIds: catalogueBoundary.recipeIds,
          now: options.now,
          onCommitted: (change) => notify({ revision: change.revision, collections: [] }),
        })
      : undefined;
    const personalMutation = (
      operation: () => Promise<PersonalMutationResult>,
    ): Promise<PersonalMutationResult> =>
      closing || restoring
        ? Promise.resolve({ kind: 'failed', error: closing ? unavailable : restoreBusy })
        : track(operation);
    const accountReplication = options.accountReplication
      ? createAccountReplicationRepository({
          ...projection,
          ...options.accountReplication,
          reader: ownedReader,
          writer: ownedWriter,
          catalogue: catalogue.identity,
          knownRecipeIds: catalogueBoundary.recipeIds,
          now: options.now,
          acquireExclusive,
          onCommitted: (change, expanded) => {
            restoreGeneration++;
            notify(change);
            if (expanded?.personalRevision !== undefined)
              personal?.notifyRestored(expanded.personalRevision);
            if (expanded?.historyRevision !== undefined)
              cooking?.notifyRestored(expanded.historyRevision);
          },
        })
      : undefined;
    const accountOperation = <Value>(operation: () => Promise<Value>): Promise<Value> =>
      closing || restoring
        ? Promise.reject(new AccountReplicationError(closing ? 'account_changed' : 'store_busy'))
        : track(operation);
    const accountScopeApproval =
      options.enableAccountHistory && options.accountReplication
        ? createAccountScopeApprovalService({
            reader: ownedReader,
            writer: ownedWriter,
            currentScope: options.accountReplication.currentScope,
            now: options.now,
            newId: options.platform.newId,
            sha256: options.platform.sha256,
          })
        : undefined;
    const services: LocalCookMateServices = {
      ...(accountScopeApproval
        ? {
            accountScopeApproval: {
              read: (scope) => accountOperation(() => accountScopeApproval.read(scope)),
              review: (scope) => accountOperation(() => accountScopeApproval.review(scope)),
              approve: (scope, review, choice) =>
                accountOperation(() => accountScopeApproval.approve(scope, review, choice)),
            },
          }
        : {}),
      ...(accountReplication
        ? {
            accountReplication: Object.freeze<AccountReplicationRepository>({
              inspect: (scope) => accountOperation(() => accountReplication.inspect(scope)),
              stage: (scope, input) =>
                accountOperation(() => accountReplication.stage(scope, input)),
              recordAcknowledgement: (scope, input) =>
                accountOperation(() => accountReplication.recordAcknowledgement(scope, input)),
              apply: (scope, input) =>
                accountOperation(() => accountReplication.apply(scope, input)),
              readApplyReceipt: (scope, id) =>
                accountOperation(() => accountReplication.readApplyReceipt(scope, id)),
              acknowledgeSettings: (scope, expected) =>
                accountOperation(() => accountReplication.acknowledgeSettings(scope, expected)),
              readInitialGuestCapture: (scope) =>
                accountOperation(() => accountReplication.readInitialGuestCapture(scope)),
              discardRejected: (scope, input) =>
                accountOperation(() => accountReplication.discardRejected(scope, input)),
            }),
          }
        : {}),
      ...(personal
        ? {
            personal: Object.freeze<NonNullable<CookMateServices['personal']>>({
              readRecipePersonal: (id) => query(() => personal.readRecipePersonal(id)),
              readCollections: () => query(personal.readCollections),
              readCollection: (id, input) => query(() => personal.readCollection(id, input)),
              readManualShopping: (input) => query(() => personal.readManualShopping(input)),
              execute: (command) => personalMutation(() => personal.execute(command)),
              reviewDeleteCollection: (id) => query(() => personal.reviewDeleteCollection(id)),
              deleteCollection: (review, id) =>
                personalMutation(() => personal.deleteCollection(review, id)),
              readReceipt: (id) => query(() => personal.readReceipt(id)),
              resolveOperation: (id) => personalMutation(() => personal.resolveOperation(id)),
              subscribe: (listener) => (closing ? () => undefined : personal.subscribe(listener)),
            }),
          }
        : {}),
      ...(cooking
        ? {
            cooking: Object.freeze<NonNullable<CookMateServices['cooking']>>({
              readResumeSession: () => query(cooking.readResumeSession),
              readSession: (recipeId) => query(() => cooking.readSession(recipeId)),
              saveSession: (input) => cookingMutation(() => cooking.saveSession(input)),
              dismissSession: (input) => cookingMutation(() => cooking.dismissSession(input)),
              readHistory: (input) => query(() => cooking.readHistory(input)),
              saveCooked: (input) => cookingMutation(() => cooking.saveCooked(input)),
              readCookedReceipt: (id) => query(() => cooking.readCookedReceipt(id)),
              resolveCookedOperation: (id) =>
                cookingMutation(() => cooking.resolveCookedOperation(id)),
              reviewClearHistory: () => query(cooking.reviewClearHistory),
              clearHistory: (review, id) => cookingMutation(() => cooking.clearHistory(review, id)),
              resolveClearHistoryOperation: (id) =>
                cookingMutation(() => cooking.resolveClearHistoryOperation(id)),
              readClearHistoryReceipt: (id) => query(() => cooking.readClearHistoryReceipt(id)),
              subscribe: (listener) => (closing ? () => undefined : cooking.subscribe(listener)),
            }),
          }
        : {}),
      ...(restore
        ? {
            portableRestore: Object.freeze<NonNullable<CookMateServices['portableRestore']>>({
              review: (serialized) => query(() => restore.review(serialized)),
              prepare: (review) => query(() => restore.prepare(review)),
              execute: (prepared) =>
                closing || restoring
                  ? Promise.resolve({
                      kind: 'failed' as const,
                      error: closing ? unavailable : restoreBusy,
                    })
                  : track(() => restore.execute(prepared)),
              readReceipt: (id) => query(() => restore.readReceipt(id)),
              readArchive: (id, archive) => query(() => restore.readArchive(id, archive)),
            }),
          }
        : {}),
      assistant: (runtime) => {
        if (closing) throw new StorageFault('storage_failure', 'Store is closing');
        if (typeof runtime?.connectionGeneration !== 'function')
          throw new TypeError('Assistant connection authority is required');
        if (connectionBinding && connectionBinding !== runtime.connectionGeneration)
          throw new TypeError('Assistant connection authority is already bound');
        if (assistantPort) return assistantPort;
        connectionBinding = runtime.connectionGeneration;
        const common = {
          attempts,
          reader: ownedReader,
          writer: ownedWriter,
          catalogue: catalogueBoundary,
          platform: options.platform,
          now: options.now,
          dateContext: options.dateContext,
          connectionGeneration,
          onCommitted: notify,
        };
        const port: AssistantPersistencePort = {
          refreshRecoveryGate: ownedRecoveryGate.refreshRecoveryGate,
          ...createConversationRepository(ownedReader, catalogueBoundary),
          ...createAssistantContextRepository(common),
          ...createAssistantTurnRepository(common),
          ...createAssistantActionRepository({
            ...common,
            executeCommand: (command) => executor.execute(command),
            readHistoricalReceipt: executor.readHistoricalReceipt,
            executeContinuation: (command, admission) =>
              executor.executeAssistantContinuation(command, admission),
          }),
        };
        assistantPort = Object.freeze(
          Object.fromEntries(
            Object.entries(port).map(([name, method]) => [
              name,
              (...args: unknown[]) => {
                if (name === 'invalidateActionContinuationReview')
                  return port.invalidateActionContinuationReview();
                if (closing || restoring)
                  return name === 'executeIntentSlot' || name === 'confirmActionContinuation'
                    ? Promise.reject(new StorageFault('storage_failure', 'Store is closing'))
                    : Promise.resolve({
                        kind: 'failed',
                        error: closing ? unavailable : restoreBusy,
                      });
                return track(() => (method as (...values: unknown[]) => Promise<unknown>)(...args));
              },
            ]),
          ) as unknown as AssistantPersistencePort,
        );
        return assistantPort;
      },
      queries: Object.freeze<CookMateServices['queries']>({
        catalogue: catalogue.identity,
        readInstallationId: () =>
          query(() =>
            readSnapshot(ownedReader, async (session) => {
              const rows = await session.all<{ value: string }>(
                "SELECT value FROM app_metadata WHERE key='installation_id'",
              );
              requireConversationRecord(rows.length === 1 && isAppId(rows[0]?.value));
              return rows[0]!.value;
            }),
          ),
        readRecipe: (id: string) => query(() => catalogueQueries.readRecipe(id)),
        readFavourites: () => query(stateQueries.readFavourites),
        readPlan: (start: string, end: string) => query(() => stateQueries.readPlan(start, end)),
        readShopping: () => query(shoppingQueries.readShopping),
        readPreferences: () => query(stateQueries.readPreferences),
        readPortableBackup: (input) => query(() => readPortableBackup(input)),
        readConversationExport: () => query(readConversationExport),
        readReceipt: (id: string) => query(() => stateQueries.readReceipt(id)),
        readDirectRecovery: (input) => query(() => recovery.readDirectRecovery(input)),
        subscribe: (listener: (change: StoreChange) => void) => {
          if (closing) return () => undefined;
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        subscribeRecoveryInvalidation: (listener) =>
          closing ? () => undefined : ownedRecoveryGate.subscribeRecoveryInvalidation(listener),
      }),
      commands: Object.freeze<CookMateServices['commands']>({
        reviewDirect: (input) => query(() => review(input)),
        prepareDirect: (review) =>
          query(async () => {
            try {
              const authority = directReviews.get(review);
              if (
                (options.enablePortableRestore || options.accountReplication) &&
                (!authority || authority.generation !== restoreGeneration)
              )
                throw new CommandPreparationError({
                  code: 'stale_context',
                  messageKey: 'restore.direct_review_required',
                  retry: 'after_correction',
                });
              const owned = JSON.parse(JSON.stringify(review)) as typeof review;
              const guard = owned.guard;
              if (
                !guard ||
                (owned.payload.kind === 'setShoppingSelection'
                  ? guard.kind !== 'shopping_selection' ||
                    Object.keys(guard).length !== 3 ||
                    !Number.isSafeInteger(guard.planRevision) ||
                    guard.planRevision < 0 ||
                    guard.shoppingScopeRevision !== owned.payload.expectedShoppingScopeRevision
                  : guard.kind !== 'none' || Object.keys(guard).length !== 1)
              )
                throw new CommandPreparationError({
                  code: 'invalid_input',
                  messageKey: 'command.review_guard_required',
                  retry: 'after_correction',
                });
              if (owned.payload.kind === 'clearConversation') {
                const payload = owned.payload;
                await ownedReader.transaction((session) =>
                  requireReviewedConversationClear(session, payload, {
                    ...projection,
                    catalogue: catalogueBoundary,
                  }),
                );
              }
              const command = await prepare(owned.payload);
              await registerReadyIntent(
                ownedWriter,
                {
                  userIntentId: command.userIntentId,
                  revision: command.intentRevision,
                  phase: 'ready',
                  slots: [{ slotId: options.platform.newId(), command }],
                },
                catalogueBoundary,
                options.platform,
                guard,
                {
                  trackDirectRecovery: true,
                  ...(authority ? { expectedRestoreEpoch: authority.epoch } : {}),
                },
              );
              return readSnapshot(ownedReader, async () => command);
            } catch (error) {
              return {
                kind: 'failed',
                error:
                  error instanceof CommandPreparationError || error instanceof CommandFault
                    ? error.detail
                    : {
                        code: 'storage_failure',
                        messageKey: 'command.preparation_failed',
                        retry: 'after_correction',
                      },
              };
            }
          }),
        execute: (command) =>
          closing || restoring
            ? Promise.resolve({
                kind: 'failed',
                operationId: command.operationId,
                error: closing ? unavailable : restoreBusy,
              })
            : track(() => executor.execute(command)),
        acknowledgeDirectRecovery: (id) => query(() => recovery.acknowledgeDirectRecovery(id)),
      }),
      close: () => {
        if (!closePromise) {
          closing = true;
          assistantPort?.invalidateActionContinuationReview();
          closePromise = (async () => {
            await Promise.allSettled([...pending]);
            listeners.clear();
            cooking?.close();
            personal?.close();
            ownedRecoveryGate.close();
            const closed = await Promise.allSettled([ownedReader.close(), ownedWriter.close()]);
            const failed = closed.find((item) => item.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
          })();
        }
        return closePromise;
      },
    };
    return { kind: 'ready', services: Object.freeze(services), initialization };
  } catch (error) {
    // Defer every release so a synchronous close failure cannot skip another owned handle.
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => recoveryGate?.close()),
      Promise.resolve().then(() => (writer ? writer.close() : writeConnection?.close())),
      Promise.resolve().then(() =>
        reader
          ? reader.close()
          : readConnection !== writeConnection
            ? readConnection?.close()
            : undefined,
      ),
    ]);
    if (cleanup.some((item) => item.status === 'rejected')) {
      return {
        kind: 'failed',
        error: { code: 'storage_failure', messageKey: 'storage.cleanup_failed', retry: 'never' },
      };
    }
    return {
      kind: 'failed',
      error: {
        code: error instanceof StorageFault ? error.code : 'storage_failure',
        messageKey: requiresWebStorageReload(error)
          ? 'storage.web_restart_required'
          : 'storage.open_failed',
        retry: requiresWebStorageReload(error) ? 'never' : 'after_correction',
      },
    };
  }
}
