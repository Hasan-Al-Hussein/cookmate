import { createAssistantAttemptRecovery } from '../../../../apps/mobile/src/data/assistantAttemptRecovery';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type {
  AssistantTurnRequest,
  CommandPayload,
  CommandResult,
  MemoryUpdate,
  ProposalResponse,
} from '@cookmate/contracts';
import type {
  AssistantActionContinuationReview,
  AuthorizedActionPlan,
  Immutable,
  RepositoryResult,
  StoreChange,
} from '../../src/index';
import { createCommandPreparer } from '../../src/prepareCommand';
import { prepareAuthorizedActionPlan } from '../../../../apps/mobile/src/assistant-core/actions';
import type { ReplacementConfirmation } from '../../../../apps/mobile/src/assistant-core/actions';
import {
  createAssistantActionRepository,
  createAssistantCommandHooks,
} from '../../../../apps/mobile/src/data/assistantActionRepository';
import { createAssistantContextRepository } from '../../../../apps/mobile/src/data/assistantContextRepository';
import { createAssistantTurnRepository } from '../../../../apps/mobile/src/data/assistantTurnRepository';
import { recoverInterruptedAssistantWork } from '../../../../apps/mobile/src/data/assistantRecovery';
import {
  CommandFault,
  createCommandExecutor,
  registerReadyIntent,
} from '../../../../apps/mobile/src/data/commandExecutor';
import type { CommandHandlers } from '../../../../apps/mobile/src/data/commandExecutor';
import { readConversationClearScope } from '../../../../apps/mobile/src/data/conversationClearScope';
import { createClearConversationCommandHandler } from '../../../../apps/mobile/src/data/clearConversationCommand';
import { favouriteCommandHandlers } from '../../../../apps/mobile/src/data/favouriteCommands';
import { createPlanCommandHandlers } from '../../../../apps/mobile/src/data/planCommands';
import { preferenceCommandHandlers } from '../../../../apps/mobile/src/data/preferenceCommands';
import { initializeDatabase } from '../../../../apps/mobile/src/data/initialize';
import { readSnapshot } from '../../../../apps/mobile/src/data/query';
import { readReceiptInSnapshot } from '../../../../apps/mobile/src/data/stateRepositories';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../../apps/mobile/src/data/sql';
import type { SqlValue } from '../../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './sqlite';

type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
export const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value)) as Mutable<T>;
export const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
export const ready = <T>(result: RepositoryResult<T>): T => {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
};
export const receipt = (result: CommandResult) => {
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail();
  return result.receipt;
};
export function failed(result: { kind: string; error?: { code: string } }, code?: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  if (code) assert.equal(result.error?.code, code);
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const placement = { actualDate: '2026-09-29', mealKey: 'dinner' } as const;
export const saveAndPlan: ProposalResponse['proposals'] = [
  { kind: 'saveRecipe', recipeId: '53064' },
  { kind: 'addPlan', recipeId: '53150', placement, expectedTarget: { kind: 'empty' } },
];

export async function fixture(initialGeneration = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-'));
  const path = join(directory, 'continuation.db');
  let generation = initialGeneration;
  let date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  const events: StoreChange[] = [];
  const attempts: { kind: CommandPayload['kind']; operationId: string }[] = [];
  const faults = {
    statement: '',
    statementCommandFault: false,
    commitAck: false,
    receiptRead: false,
    independentReceiptRead: false,
    rollback: false,
    beforeExecutorHash: async () => {},
  };
  const identifiers = {
    installationId: randomUUID(),
    conversationId: randomUUID(),
    shoppingScopeId: randomUUID(),
  };
  const open = async (recover: boolean) => {
    const db = desktopConnection(path);
    await configureConnection(db.connection);
    const writer = new SerializedWriter(db.connection);
    await initializeDatabase(
      writer,
      {
        identity: catalogue.identity,
        recipes: catalogue.recipes,
        recipeSources: catalogueProvenance.recipeSources,
      },
      identifiers,
    );
    if (recover) await recoverInterruptedAssistantWork(writer, catalogueBoundary);
    const readDb = desktopConnection(path);
    await configureConnection(readDb.connection);
    await readDb.connection.exec('PRAGMA query_only=ON');
    const reader = new SerializedReader(readDb.connection);
    const readerAll = readDb.connection.all;
    readDb.connection.all = async <Row extends object>(
      sql: string,
      values?: readonly SqlValue[],
    ) => {
      if (faults.independentReceiptRead && sql.includes('FROM operation_receipt'))
        throw new Error('injected independent receipt outage');
      return readerAll<Row>(sql, values);
    };
    const prepare = db.connection.prepare;
    db.connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        ...statement,
        run: async (values) => {
          if (faults.statement && sql.startsWith(faults.statement)) {
            if (faults.statementCommandFault)
              throw new CommandFault({
                code: 'stale_context',
                messageKey: 'test.handler_rejected',
                retry: 'reconcile',
              });
            throw new Error('injected continuation statement failure');
          }
          await statement.run(values);
        },
      };
    };
    const all = db.connection.all;
    db.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      if (faults.receiptRead && sql.includes('FROM operation_receipt'))
        throw new Error('injected receipt read failure');
      return all<Row>(sql, values);
    };
    const exec = db.connection.exec;
    db.connection.exec = async (sql) => {
      if (sql === 'ROLLBACK' && faults.rollback)
        throw new Error('injected rollback failure before execution');
      await exec(sql);
      if (sql === 'COMMIT' && faults.commitAck) {
        faults.commitAck = false;
        throw new Error('lost continuation COMMIT acknowledgement');
      }
    };
    const options = {
      attempts: createAssistantAttemptRecovery(),
      reader,
      writer,
      catalogue: catalogueBoundary,
      platform,
      now: () => '2026-09-28T00:00:00.000Z',
      dateContext: () => date,
      connectionGeneration: () => generation,
      onCommitted: (event: StoreChange) => events.push(event),
    };
    const plans = createPlanCommandHandlers({
      sha256: platform.sha256,
      readRecipe: (id) => catalogue.recipes.find((recipe) => recipe.recipeId === id),
    });
    const handlers: CommandHandlers = {
      ...plans,
      ...preferenceCommandHandlers,
      ...createClearConversationCommandHandler({
        catalogue: catalogueBoundary,
        sha256: platform.sha256,
      }),
      setFavourite: async (session, payload, now, command) => {
        attempts.push({ kind: payload.kind, operationId: command.operationId });
        return favouriteCommandHandlers.setFavourite!(session, payload, now, command);
      },
      addPlan: async (session, payload, now, command) => {
        attempts.push({ kind: payload.kind, operationId: command.operationId });
        return plans.addPlan!(session, payload, now, command);
      },
      replacePlanRecipe: async (session, payload, now, command) => {
        attempts.push({ kind: payload.kind, operationId: command.operationId });
        return plans.replacePlanRecipe!(session, payload, now, command);
      },
      savePreference: async (session, payload, now, command) => {
        attempts.push({ kind: payload.kind, operationId: command.operationId });
        return preferenceCommandHandlers.savePreference!(session, payload, now, command);
      },
    };
    const executor = createCommandExecutor({
      ...options,
      handlers,
      platform: {
        sha256: async (text) => {
          await faults.beforeExecutorHash();
          return platform.sha256(text);
        },
      },
      assistantHooks: createAssistantCommandHooks(options),
      readReceipt: (id) =>
        readSnapshot(reader, (session) => readReceiptInSnapshot(session, id, catalogueBoundary)),
    });
    const actions = createAssistantActionRepository({
      ...options,
      executeCommand: (command) => executor.execute(command),
      readHistoricalReceipt: executor.readHistoricalReceipt,
      executeContinuation: (command, admission) =>
        executor.executeAssistantContinuation(command, admission),
    });
    return {
      ...db,
      writer,
      reader,
      actions,
      executor,
      context: createAssistantContextRepository(options),
      turns: createAssistantTurnRepository(options),
    };
  };
  let store = await open(false);
  const closeStore = async () => {
    store.actions.invalidateActionContinuationReview();
    await store.reader.close();
    await store.writer.close();
  };
  const accept = async (
    proposals: ProposalResponse['proposals'] = clone(saveAndPlan),
    replacementConfirmations: ReplacementConfirmation[] = [],
  ) => {
    const contextResult = await store.context.readContext({
      text: 'Apply these explicitly requested choices.',
      messageId: randomUUID(),
      selection: {},
    });
    if (contextResult.kind !== 'ready') assert.fail(JSON.stringify(contextResult));
    const context = clone(contextResult.value);
    const request: AssistantTurnRequest = {
      apiVersion: '2',
      catalogue: catalogue.identity,
      requestId: randomUUID(),
      userIntentId: randomUUID(),
      intentRevision: 0,
      conversationId: context.conversationId,
      conversationGeneration: context.conversationGeneration,
      connectionGeneration: generation,
      message: context.currentMessage,
      context: {
        history: context.history,
        memory: context.memory,
        preferences: context.preferences,
        referenceSets: context.referenceSets,
        planOccurrences: context.planOccurrences,
        date: context.date,
      },
      capabilities: ['saveRecipe', 'addPlan', 'savePreference'],
    };
    const begun = ready(
      await store.turns.beginTurn({
        request,
        expectedConversationRevision: context.contextRevision,
      }),
    );
    const response: ProposalResponse = {
      apiVersion: '2',
      catalogue: request.catalogue,
      requestId: request.requestId,
      userIntentId: request.userIntentId,
      intentRevision: 0,
      conversationId: request.conversationId,
      conversationGeneration: request.conversationGeneration,
      connectionGeneration: generation,
      preferenceRevision: request.context.preferences.revision,
      kind: 'proposal',
      text: 'Ready for your approval.',
      sources: [],
      referenceSets: [],
      proposals,
      memoryUpdate: {
        baseRevision: request.context.memory.projectionRevision,
        baseContextRevision: request.context.memory.baseContextRevision,
        reviews: request.context.memory.reviewTargetMessageIds.map((sourceMessageId) => ({
          sourceMessageId,
          disposition: 'non_memory',
        })) as MemoryUpdate['reviews'],
        entries: [],
      },
    };
    const accepted = ready(
      await store.turns.acceptResponse({ response, ...begun.acceptanceEnvelope }),
    ).acknowledgement;
    assert.ok(accepted.guards);
    const state = ready(await store.actions.readCurrentActionState(request.userIntentId));
    const plan = await prepareAuthorizedActionPlan(
      request,
      response,
      {
        source: 'explicit_user',
        proposals,
        replacementConfirmations,
      },
      clone(state),
      accepted.guards,
      platform,
    );
    ready(
      await store.actions.freezeActionPlan({
        plan,
        expectedIntentRevision: 0,
        guards: accepted.guards,
      }),
    );
    return { request, plan };
  };
  const slotInput = (plan: AuthorizedActionPlan, index = 0) => ({
    userIntentId: plan.userIntentId,
    expectedIntentRevision: 0,
    slotId: plan.slots[index]!.slotId,
  });
  const direct = async (payload: CommandPayload) => {
    const reviewed =
      payload.kind === 'clearConversation'
        ? {
            ...payload,
            expectedScopeFingerprint: (
              await store.reader.transaction((session) =>
                readConversationClearScope(session, {
                  catalogue: catalogueBoundary,
                  sha256: platform.sha256,
                }),
              )
            ).fingerprint,
          }
        : payload;
    const command = await createCommandPreparer(platform, catalogueBoundary)(reviewed);
    await registerReadyIntent(
      store.writer,
      {
        userIntentId: command.userIntentId,
        revision: 0,
        phase: 'ready',
        slots: [{ slotId: randomUUID(), command }],
      },
      catalogueBoundary,
      platform,
    );
    return store.executor.execute(command);
  };
  const snapshot = () =>
    Object.fromEntries(
      [
        'state_revision',
        'pending_intent',
        'assistant_intent_context',
        'assistant_acceptance',
        'assistant_acceptance_envelope',
        'assistant_action_plan',
        'command_slot',
        'operation_receipt',
        'favourite',
        'plan_occurrence',
        'saved_preference',
        'source_preference_link',
        'message',
        'catalogue_manifest',
        'shopping_scope',
      ].map((table) => [
        table,
        store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  return {
    get store() {
      return store;
    },
    events,
    attempts,
    faults,
    accept,
    direct,
    snapshot,
    slotInput,
    finalize: (plan: AuthorizedActionPlan, index = 0) =>
      store.actions.finalizeNextIntentSlot(slotInput(plan, index)),
    execute: (plan: AuthorizedActionPlan, index = 0) =>
      store.actions.executeIntentSlot(slotInput(plan, index)),
    review: (plan: AuthorizedActionPlan) =>
      store.actions.readActionContinuationReview({
        userIntentId: plan.userIntentId,
        expectedIntentRevision: 0,
      }),
    setGeneration: (value: number) => {
      generation = value;
    },
    changeDate: () => {
      date = { ...date, localDate: '2026-09-29' };
    },
    reopen: async (nextGeneration = generation) => {
      await closeStore();
      generation = nextGeneration;
      store = await open(true);
    },
    close: async () => {
      await closeStore();
      await removeFixtureDirectory(directory);
    },
  };
}

export async function failedPlan(f: Awaited<ReturnType<typeof fixture>>, tail = false) {
  const proposals = clone(saveAndPlan);
  if (tail) proposals.push({ kind: 'savePreference', type: 'cuisine', explicitValue: 'Thai' });
  const turn = await f.accept(proposals);
  ready(await f.finalize(turn.plan));
  const firstReceipt = receipt(await f.execute(turn.plan));
  const frozen = ready(await f.finalize(turn.plan, 1)).slot;
  f.faults.statement = 'INSERT INTO plan_occurrence';
  const result = await f.execute(turn.plan, 1);
  failed(result, 'storage_failure');
  f.faults.statement = '';
  return { ...turn, frozen, firstReceipt };
}

export function reviewValue(
  value: RepositoryResult<Immutable<AssistantActionContinuationReview> | null>,
) {
  const review = ready(value);
  assert.ok(review);
  return review;
}
