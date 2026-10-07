import { createAssistantAttemptRecovery } from '../../../../apps/mobile/src/data/assistantAttemptRecovery';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { AssistantTurnRequest, MemoryUpdate, ProposalResponse } from '@cookmate/contracts';
import type { RepositoryResult } from '../../src/index';
import { createAssistantRecoveryGate } from '../../../../apps/mobile/src/data/recoveryGate';
import { createAssistantContextRepository } from '../../../../apps/mobile/src/data/assistantContextRepository';
import { createAssistantTurnRepository } from '../../../../apps/mobile/src/data/assistantTurnRepository';
import {
  createAssistantActionRepository,
  createAssistantCommandHooks,
} from '../../../../apps/mobile/src/data/assistantActionRepository';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../../apps/mobile/src/data/commandExecutor';
import { favouriteCommandHandlers } from '../../../../apps/mobile/src/data/favouriteCommands';
import { readConversationClearScope } from '../../../../apps/mobile/src/data/conversationClearScope';
import { createClearConversationCommandHandler } from '../../../../apps/mobile/src/data/clearConversationCommand';
import { createCommandPreparer } from '../../src/prepareCommand';
import { readReceiptInSnapshot } from '../../../../apps/mobile/src/data/stateRepositories';
import { readSnapshot } from '../../../../apps/mobile/src/data/query';
import { initializeDatabase } from '../../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../../apps/mobile/src/data/sql';
import type { SqlValue } from '../../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './sqlite';

export const ready = <T>(result: RepositoryResult<T>): T => {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
};

export async function recoveryFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-'));
  const path = join(directory, 'recovery.db');
  const db = desktopConnection(path);
  const readerDb = desktopConnection(path);
  await configureConnection(db.connection);
  await configureConnection(readerDb.connection);
  const writer = new SerializedWriter(db.connection);
  const reader = new SerializedReader(readerDb.connection);
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    {
      installationId: randomUUID(),
      conversationId: randomUUID(),
      shoppingScopeId: randomUUID(),
    },
  );
  await readerDb.connection.exec('PRAGMA query_only=ON');
  const counters = {
    sql: 0,
    writerSql: 0,
    readerSql: 0,
    hashes: 0,
    bodies: 0,
    bodyBytes: 0,
    transactions: 0,
  };
  const faults = {
    commitAck: false,
    failFence: false,
    afterCommit: undefined as (() => void) | undefined,
    beforeBegin: undefined as (() => void) | undefined,
  };
  const platform = {
    newId: randomUUID,
    sha256: async (value: string) => {
      counters.hashes++;
      return createHash('sha256').update(value).digest('hex');
    },
  };
  const rawAll = db.connection.all;
  db.connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
    counters.sql++;
    counters.writerSql++;
    if (faults.failFence && sql.includes('data_version'))
      throw new Error('injected freshness read failure');
    const rows = await rawAll<Row>(sql, values);
    for (const row of rows)
      for (const [key, value] of Object.entries(row)) {
        if ((/json$/i.test(key) || key === 'text') && typeof value === 'string') {
          counters.bodies++;
          counters.bodyBytes += Buffer.byteLength(value);
        }
      }
    return rows;
  };
  const rawExec = db.connection.exec;
  db.connection.exec = async (sql) => {
    counters.sql++;
    counters.writerSql++;
    if (sql === 'BEGIN IMMEDIATE') {
      counters.transactions++;
      faults.beforeBegin?.();
    }
    await rawExec(sql);
    if (sql === 'COMMIT') {
      faults.afterCommit?.();
      if (faults.commitAck) {
        faults.commitAck = false;
        throw new Error('lost COMMIT acknowledgement');
      }
    }
  };
  const rawPrepare = db.connection.prepare;
  db.connection.prepare = async (sql) => {
    const statement = await rawPrepare(sql);
    return {
      run: async (values) => {
        counters.sql++;
        counters.writerSql++;
        await statement.run(values);
      },
      finalize: () => statement.finalize(),
    };
  };
  const readerAll = readerDb.connection.all;
  readerDb.connection.all = async <Row extends object>(
    sql: string,
    values?: readonly SqlValue[],
  ) => {
    counters.sql++;
    counters.readerSql++;
    const rows = await readerAll<Row>(sql, values);
    for (const row of rows)
      for (const [key, value] of Object.entries(row)) {
        if ((/json$/i.test(key) || key === 'text') && typeof value === 'string') {
          counters.bodies++;
          counters.bodyBytes += Buffer.byteLength(value);
        }
      }
    return rows;
  };
  const readerExec = readerDb.connection.exec;
  readerDb.connection.exec = async (sql) => {
    counters.sql++;
    counters.readerSql++;
    await readerExec(sql);
  };
  const options = {
    attempts: createAssistantAttemptRecovery(),
    writer,
    reader,
    catalogue: catalogueBoundary,
    platform,
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => ({ localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    connectionGeneration: () => 1,
    onCommitted: () => {},
  };
  const turns = createAssistantTurnRepository(options);
  const context = createAssistantContextRepository(options);
  const executor = createCommandExecutor({
    ...options,
    handlers: {
      ...favouriteCommandHandlers,
      ...createClearConversationCommandHandler({
        catalogue: catalogueBoundary,
        sha256: platform.sha256,
      }),
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
  let gate: ReturnType<typeof createAssistantRecoveryGate> | undefined;
  const addTurn = async (
    input: { id?: string; plan?: boolean; execute?: boolean; twoSlots?: boolean } = {},
  ) => {
    const loaded = await context.readContext({
      text: 'Save these explicitly requested recipes.',
      messageId: randomUUID(),
      selection: {},
    });
    if (loaded.kind !== 'ready') assert.fail(JSON.stringify(loaded));
    const s = JSON.parse(JSON.stringify(loaded.value));
    const request: AssistantTurnRequest = {
      apiVersion: '2',
      catalogue: catalogue.identity,
      requestId: randomUUID(),
      userIntentId: input.id ?? randomUUID(),
      intentRevision: 0,
      conversationId: s.conversationId,
      conversationGeneration: s.conversationGeneration,
      connectionGeneration: 1,
      message: s.currentMessage,
      context: {
        history: s.history,
        memory: s.memory,
        preferences: s.preferences,
        referenceSets: s.referenceSets,
        planOccurrences: s.planOccurrences,
        date: s.date,
      },
      capabilities: ['saveRecipe'],
    };
    const begun = ready(
      await turns.beginTurn({ request, expectedConversationRevision: s.contextRevision }),
    );
    const response: ProposalResponse = {
      apiVersion: '2',
      catalogue: request.catalogue,
      requestId: request.requestId,
      userIntentId: request.userIntentId,
      intentRevision: 0,
      conversationId: request.conversationId,
      conversationGeneration: request.conversationGeneration,
      connectionGeneration: 1,
      preferenceRevision: request.context.preferences.revision,
      kind: 'proposal',
      text: 'Ready for explicit approval.',
      sources: [],
      referenceSets: [],
      proposals: input.twoSlots
        ? [
            { kind: 'saveRecipe', recipeId: '53064' },
            { kind: 'saveRecipe', recipeId: '53150' },
          ]
        : [{ kind: 'saveRecipe', recipeId: '53064' }],
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
      await turns.acceptResponse({ response, ...begun.acceptanceEnvelope }),
    ).acknowledgement;
    const plan = {
      userIntentId: request.userIntentId,
      revision: 0,
      origin: {
        conversationId: request.conversationId,
        generation: request.conversationGeneration,
        messageId: request.message.messageId,
      },
      slots: response.proposals.map((proposal, proposalIndex) => ({
        slotId: randomUUID(),
        operationId: randomUUID(),
        proposalIndex,
        payload: {
          kind: 'setFavourite' as const,
          recipeId: (proposal as { recipeId: string }).recipeId,
          saved: true,
        },
      })),
    };
    const slotInput = (index = 0) => ({
      userIntentId: plan.userIntentId,
      expectedIntentRevision: 0,
      slotId: plan.slots[index]!.slotId,
    });
    if (input.plan !== false) {
      assert.ok(accepted.guards);
      ready(
        await actions.freezeActionPlan({
          plan,
          expectedIntentRevision: 0,
          guards: accepted.guards,
        }),
      );
      ready(await actions.finalizeNextIntentSlot(slotInput()));
      if (input.execute !== false)
        assert.equal((await actions.executeIntentSlot(slotInput())).kind, 'receipt');
    }
    return { request, begun, plan, slotInput };
  };
  return {
    ...db,
    path,
    readerDb,
    writer,
    reader,
    platform,
    turns,
    context,
    actions,
    clearConversation: async () => {
      const header = db.database
        .prepare('SELECT conversation_id AS id,generation FROM conversation')
        .get()!;
      const command = await createCommandPreparer(
        platform,
        catalogueBoundary,
      )({
        kind: 'clearConversation',
        conversationId: header.id as string,
        expectedGeneration: header.generation as number,
        expectedScopeFingerprint: (
          await reader.transaction((session) =>
            readConversationClearScope(session, {
              catalogue: catalogueBoundary,
              sha256: platform.sha256,
            }),
          )
        ).fingerprint,
      });
      await registerReadyIntent(
        writer,
        {
          userIntentId: command.userIntentId,
          revision: 0,
          phase: 'ready',
          slots: [{ slotId: randomUUID(), command }],
        },
        catalogueBoundary,
        platform,
      );
      return executor.execute(command);
    },
    faults,
    counters,
    addTurn,
    install: () =>
      (gate = createAssistantRecoveryGate({ writer, catalogue: catalogueBoundary, platform })),
    resetCounters: () => {
      for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0;
    },
    close: async () => {
      gate?.close();
      await reader.close();
      await writer.close();
      await removeFixtureDirectory(directory);
    },
  };
}

export async function finishAudit(gate: ReturnType<typeof createAssistantRecoveryGate>) {
  let calls = 0;
  let continuation: string | undefined;
  for (;;) {
    const result = await gate.refreshRecoveryGate(continuation ? { continuation } : {});
    const value = ready(result);
    calls++;
    if (value.kind === 'ready') return { value, calls, result };
    continuation = value.continuation;
    assert.ok(calls < 100, 'bounded test audit did not complete');
  }
}
