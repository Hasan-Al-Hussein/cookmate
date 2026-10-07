import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { DateContext } from '@cookmate/contracts';
import { CommandPreparationError, createCommandPreparer } from '@cookmate/domain';
import type {
  CommandPlatform,
  AssistantPersistencePort,
  CookMateServices,
  RepositoryResult,
  StoreChange,
  StoreInitializationResult,
} from '@cookmate/domain';
import { recoverInterruptedAssistantWork } from './assistantRecovery';
import { createCatalogueRepository } from './catalogueRepository';
import { clearConversationCommandHandler } from './clearConversationCommand';
import { CommandFault, createCommandExecutor, registerReadyIntent } from './commandExecutor';
import { createDirectActionReviewer } from './directActionReview';
import { createDirectRecoveryRepository } from './directRecoveryRepository';
import {
  createAssistantActionRepository,
  createAssistantCommandHooks,
} from './assistantActionRepository';
import { createAssistantContextRepository } from './assistantContextRepository';
import { createAssistantTurnRepository } from './assistantTurnRepository';
import { createConversationRepository } from './conversationRepository';
import { favouriteCommandHandlers } from './favouriteCommands';
import { initializeDatabase } from './initialize';
import { createPlanCommandHandlers } from './planCommands';
import { preferenceCommandHandlers } from './preferenceCommands';
import { freezeResult, readSnapshot } from './query';
import { createShoppingCommandHandlers } from './shoppingCommands';
import { createShoppingRepository } from './shoppingRepository';
import { createStateRepositories, readReceiptInSnapshot } from './stateRepositories';
import { configureConnection, SerializedReader, SerializedWriter, StorageFault } from './sql';
import type { SqlConnection } from './sql';
import { isAppId, requireConversationRecord } from './conversationRecords';
import { createAssistantRecoveryGate } from './recoveryGate';

export interface LocalStoreOptions {
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

/** Local facade composition. Its ready result is runtime availability, not native acceptance evidence. */
export async function createLocalStore(
  options: LocalStoreOptions,
): Promise<StoreInitializationResult> {
  let writeConnection: SqlConnection | undefined;
  let readConnection: SqlConnection | undefined;
  let writer: SerializedWriter | undefined;
  let reader: SerializedReader | undefined;
  let recoveryGate: ReturnType<typeof createAssistantRecoveryGate> | undefined;
  try {
    writeConnection = await options.openConnection('write');
    await configureConnection(writeConnection);
    writer = new SerializedWriter(writeConnection);
    await initializeDatabase(
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
    );
    await recoverInterruptedAssistantWork(writer, catalogueBoundary);
    readConnection = await options.openConnection('read');
    if (readConnection === writeConnection)
      throw new StorageFault('storage_failure', 'Read and write connections must be distinct');
    await configureConnection(readConnection);
    await readConnection.exec('PRAGMA query_only=ON');
    reader = new SerializedReader(readConnection);
    const ownedWriter = writer;
    const ownedReader = reader;
    const ownedRecoveryGate = (recoveryGate = createAssistantRecoveryGate({
      writer: ownedWriter,
      catalogue: catalogueBoundary,
      platform: options.platform,
    }));
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
    const prepare = createCommandPreparer(options.platform, catalogueBoundary);
    const review = createDirectActionReviewer(ownedReader, {
      ...projection,
      catalogue: catalogueBoundary,
      platform: options.platform,
    });
    const listeners = new Set<(change: StoreChange) => void>();
    const pending = new Set<Promise<unknown>>();
    let closing = false;
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
      closing ? Promise.resolve({ kind: 'failed', error: unavailable }) : track(operation);
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
    const executor = createCommandExecutor({
      assistantHooks: createAssistantCommandHooks({
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
        ...clearConversationCommandHandler,
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
    const services: CookMateServices = {
      assistant: (runtime) => {
        if (closing) throw new StorageFault('storage_failure', 'Store is closing');
        if (typeof runtime?.connectionGeneration !== 'function')
          throw new TypeError('Assistant connection authority is required');
        if (connectionBinding && connectionBinding !== runtime.connectionGeneration)
          throw new TypeError('Assistant connection authority is already bound');
        if (assistantPort) return assistantPort;
        connectionBinding = runtime.connectionGeneration;
        const common = {
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
          }),
        };
        assistantPort = Object.freeze(
          Object.fromEntries(
            Object.entries(port).map(([name, method]) => [
              name,
              (...args: unknown[]) => {
                if (closing)
                  return name === 'executeIntentSlot'
                    ? Promise.reject(new StorageFault('storage_failure', 'Store is closing'))
                    : Promise.resolve({ kind: 'failed', error: unavailable });
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
                { trackDirectRecovery: true },
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
          closing
            ? Promise.resolve({
                kind: 'failed',
                operationId: command.operationId,
                error: unavailable,
              })
            : track(() => executor.execute(command)),
        acknowledgeDirectRecovery: (id) => query(() => recovery.acknowledgeDirectRecovery(id)),
      }),
      close: () => {
        if (!closePromise) {
          closing = true;
          closePromise = (async () => {
            await Promise.allSettled([...pending]);
            listeners.clear();
            ownedRecoveryGate.close();
            const closed = await Promise.allSettled([ownedReader.close(), ownedWriter.close()]);
            const failed = closed.find((item) => item.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
          })();
        }
        return closePromise;
      },
    };
    return { kind: 'ready', services: Object.freeze(services) };
  } catch (error) {
    recoveryGate?.close();
    const cleanup = [
      writer ? writer.close() : writeConnection?.close(),
      reader
        ? reader.close()
        : readConnection !== writeConnection
          ? readConnection?.close()
          : undefined,
    ];
    await Promise.allSettled(cleanup.filter((item): item is Promise<void> => item !== undefined));
    return {
      kind: 'failed',
      error: {
        code: error instanceof StorageFault ? error.code : 'storage_failure',
        messageKey: 'storage.open_failed',
        retry: 'after_correction',
      },
    };
  }
}
