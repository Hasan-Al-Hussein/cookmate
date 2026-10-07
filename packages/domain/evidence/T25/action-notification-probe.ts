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
import { createCommandPreparer } from '../../src/prepareCommand';
import type { AuthorizedActionPlan, RepositoryResult, StoreChange } from '../../src/index';
import {
  createAssistantActionRepository,
  createAssistantCommandHooks,
} from '../../../../apps/mobile/src/data/assistantActionRepository';
import { createAssistantContextRepository } from '../../../../apps/mobile/src/data/assistantContextRepository';
import { createAssistantTurnRepository } from '../../../../apps/mobile/src/data/assistantTurnRepository';
import { recoverInterruptedAssistantWork } from '../../../../apps/mobile/src/data/assistantRecovery';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../../apps/mobile/src/data/commandExecutor';
import { preferenceCommandHandlers } from '../../../../apps/mobile/src/data/preferenceCommands';
import { favouriteCommandHandlers } from '../../../../apps/mobile/src/data/favouriteCommands';
import { createPlanCommandHandlers } from '../../../../apps/mobile/src/data/planCommands';
import { createShoppingCommandHandlers } from '../../../../apps/mobile/src/data/shoppingCommands';
import {
  createStateRepositories,
  readReceiptInSnapshot,
} from '../../../../apps/mobile/src/data/stateRepositories';
import { readSnapshot } from '../../../../apps/mobile/src/data/query';
import { initializeDatabase } from '../../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../../apps/mobile/src/data/sql';
import {
  prepareAuthorizedActionPlan,
  prepareAuthorizedIntent,
} from '../../../../apps/mobile/src/assistant-core/actions';
import type { ExplicitActionAuthority } from '../../../../apps/mobile/src/assistant-core/actions';
import { desktopConnection, removeFixtureDirectory } from '../../test/helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
const prepare = createCommandPreparer(platform, catalogueBoundary);
type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value)) as Mutable<T>;
const ready = <T>(result: RepositoryResult<T>): T => {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
};
const receipt = (result: CommandResult) => {
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail();
  return result.receipt;
};
function failed(result: { kind: string; error?: { code: string } }, code: string) {
  assert.equal(result.kind, 'failed', JSON.stringify(result));
  assert.equal(result.error?.code, code);
}
const preferences: ProposalResponse['proposals'] = [
  { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
  { kind: 'savePreference', type: 'cuisine', explicitValue: 'Thai' },
];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-'));
  const path = join(directory, 'assistant-actions.db');
  let date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  let connectionGeneration = 1;
  const events: StoreChange[] = [];
  const faults = {
    statement: '',
    commitAck: false,
    uncertain: false,
    dispatched: 0,
    afterStatement: (_sql: string) => {},
  };
  const seed = {
    identity: catalogue.identity,
    recipes: catalogue.recipes,
    recipeSources: catalogueProvenance.recipeSources,
  };
  const identifiers = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  const open = async () => {
    const db = desktopConnection(path);
    await configureConnection(db.connection);
    const writer = new SerializedWriter(db.connection);
    await initializeDatabase(writer, seed, identifiers);
    const readDb = desktopConnection(path);
    await configureConnection(readDb.connection);
    await readDb.connection.exec('PRAGMA query_only=ON');
    const reader = new SerializedReader(readDb.connection);
    const options = {
      reader,
      writer,
      catalogue: catalogueBoundary,
      platform,
      now: () => '2026-09-28T00:00:00.000Z',
      dateContext: () => date,
      connectionGeneration: () => connectionGeneration,
      onCommitted: (event: StoreChange) => events.push(event),
    };
    const nativePrepare = db.connection.prepare;
    db.connection.prepare = async (sql) => {
      const statement = await nativePrepare(sql);
      return {
        ...statement,
        run: async (values) => {
          if (faults.statement && sql.startsWith(faults.statement))
            throw new Error('injected action transaction failure');
          await statement.run(values);
          faults.afterStatement(sql);
        },
      };
    };
    const nativeExec = db.connection.exec;
    db.connection.exec = async (sql) => {
      await nativeExec(sql);
      if (sql === 'COMMIT' && faults.commitAck) {
        faults.commitAck = false;
        throw new Error('lost COMMIT acknowledgement');
      }
    };
    const context = createAssistantContextRepository(options);
    const turns = createAssistantTurnRepository(options);
    const state = createStateRepositories(reader, catalogueBoundary);
    const executor = createCommandExecutor({
      ...options,
      handlers: {
        ...preferenceCommandHandlers,
        ...favouriteCommandHandlers,
        ...createPlanCommandHandlers({
          sha256: platform.sha256,
          readRecipe: (id) => catalogue.recipes.find((recipe) => recipe.recipeId === id),
        }),
        ...createShoppingCommandHandlers({
          sha256: platform.sha256,
          readRecipe: (id) => catalogue.recipes.find((recipe) => recipe.recipeId === id),
        }),
      },
      assistantHooks: createAssistantCommandHooks(options),
      readReceipt: (id) =>
        readSnapshot(reader, (session) => readReceiptInSnapshot(session, id, catalogueBoundary)),
    });
    const actions = createAssistantActionRepository({
      ...options,
      executeCommand: async (command) => {
        faults.dispatched++;
        return faults.uncertain
          ? { kind: 'uncertain', operationId: command.operationId }
          : executor.execute(command);
      },
    });
    return { ...db, writer, reader, context, turns, state, executor, actions };
  };
  let store = await open();
  const direct = async (payload: CommandPayload) => {
    const command = await prepare(payload);
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
  const accept = async (
    proposals: ProposalResponse['proposals'] = clone(preferences),
    authorityOptions: {
      replacements?: ExplicitActionAuthority['replacementConfirmations'];
      relativeDate?: string;
    } = {},
  ) => {
    const context = await store.context.readContext({
      text: 'Please apply these explicitly authorized choices.',
      messageId: randomUUID(),
      selection: {},
    });
    if (context.kind !== 'ready') assert.fail(JSON.stringify(context));
    const s = clone(context.value);
    const request: AssistantTurnRequest = {
      apiVersion: '2',
      catalogue: catalogue.identity,
      requestId: randomUUID(),
      userIntentId: randomUUID(),
      intentRevision: 0,
      conversationId: s.conversationId,
      conversationGeneration: s.conversationGeneration,
      connectionGeneration,
      message: s.currentMessage,
      context: {
        history: s.history,
        memory: s.memory,
        preferences: s.preferences,
        referenceSets: s.referenceSets,
        planOccurrences: s.planOccurrences,
        date: s.date,
      },
      capabilities: ['saveRecipe', 'addPlan', 'savePreference'],
    };
    const begun = ready(
      await store.turns.beginTurn({ request, expectedConversationRevision: s.contextRevision }),
    );
    const response: ProposalResponse = {
      apiVersion: '2',
      catalogue: request.catalogue,
      requestId: request.requestId,
      userIntentId: request.userIntentId,
      intentRevision: 0,
      conversationId: request.conversationId,
      conversationGeneration: request.conversationGeneration,
      connectionGeneration,
      preferenceRevision: request.context.preferences.revision,
      kind: 'proposal',
      text: 'These actions await your approval.',
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
    const current = ready(await store.actions.readCurrentActionState(request.userIntentId));
    assert.ok(accepted.guards);
    const authority: ExplicitActionAuthority = {
      source: 'explicit_user',
      proposals,
      replacementConfirmations: authorityOptions.replacements ?? [],
      ...(authorityOptions.relativeDate
        ? {
            relativeDateGuard: {
              interpretedAt: request.context.date,
              resolvedDate: authorityOptions.relativeDate,
              sourceMessageId: request.message.messageId,
            },
          }
        : {}),
    };
    const plan = await prepareAuthorizedActionPlan(
      request,
      response,
      authority,
      clone(current),
      accepted.guards,
      platform,
    );
    return {
      request,
      response,
      accepted,
      current,
      authority,
      plan,
      guards: clone(accepted.guards),
    };
  };
  const freeze = async (turn: Awaited<ReturnType<typeof accept>>) =>
    ready(
      await store.actions.freezeActionPlan({
        plan: turn.plan,
        expectedIntentRevision: 0,
        guards: turn.guards,
      }),
    );
  const finalize = (plan: AuthorizedActionPlan, index: number) =>
    store.actions.finalizeNextIntentSlot({
      userIntentId: plan.userIntentId,
      expectedIntentRevision: 0,
      slotId: plan.slots[index]!.slotId,
    });
  const execute = (plan: AuthorizedActionPlan, index: number) =>
    store.actions.executeIntentSlot({
      userIntentId: plan.userIntentId,
      expectedIntentRevision: 0,
      slotId: plan.slots[index]!.slotId,
    });
  const snapshot = () =>
    Object.fromEntries(
      [
        'saved_preference',
        'source_preference_link',
        'favourite',
        'plan_occurrence',
        'state_revision',
        'pending_intent',
        'command_slot',
        'operation_receipt',
        'assistant_action_plan',
        'assistant_intent_context',
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
    faults,
    direct,
    accept,
    freeze,
    finalize,
    execute,
    snapshot,
    changeDate: () => {
      date = { ...date, localDate: '2026-09-29' };
    },
    changeConnection: () => {
      connectionGeneration++;
    },
    reopen: async (recover = false) => {
      await store.reader.close();
      await store.writer.close();
      store = await open();
      if (recover) await recoverInterruptedAssistantWork(store.writer, catalogueBoundary);
    },
    close: async () => {
      await store.reader.close();
      await store.writer.close();
      await removeFixtureDirectory(directory);
    },
  };
}

async function main(){
 for(const duplicate of [true,false]){
  const f=await fixture();
  try{
   if(duplicate)receipt(await f.direct({kind:'setFavourite',recipeId:'53064',saved:true}));
   const turn=await f.accept([{kind:'saveRecipe',recipeId:'53064'}]);
   await f.freeze(turn);ready(await f.finalize(turn.plan,0));
   const before=f.store.database.prepare("SELECT collection,revision FROM state_revision WHERE collection IN ('store','conversation') ORDER BY collection").all();
   f.events.length=0;
   const result=receipt(await f.execute(turn.plan,0));
   const saved=ready(await f.store.turns.readIntent(turn.plan.userIntentId));
   const cursor=(f.store.database.prepare('SELECT cursor FROM assistant_action_plan WHERE user_intent_id=?').get(turn.plan.userIntentId) as {cursor:number}).cursor;
   const after=f.store.database.prepare("SELECT collection,revision FROM state_revision WHERE collection IN ('store','conversation') ORDER BY collection").all();
   assert.equal(saved?.intent.phase,'settled');assert.equal(cursor,1);
   assert.equal(saved?.slotResults.length,1);
   assert.equal(f.events.length,1);assert(f.events[0]!.collections.includes('conversation'));
   assert.equal((after.find((row:any)=>row.collection==='store') as any).revision,(before.find((row:any)=>row.collection==='store') as any).revision+1);
   assert.equal((after.find((row:any)=>row.collection==='conversation') as any).revision,(before.find((row:any)=>row.collection==='conversation') as any).revision);
   assert.deepEqual(receipt(await f.execute(turn.plan,0)),result);assert.equal(f.events.length,1);
   console.log(JSON.stringify({probe:'assistant-receipt-conversation-notification-recheck',duplicate,outcome:result.outcome,phase:saved?.intent.phase,cursor,events:f.events,before,after,exactRetryAddsNoEvent:true}));
  }finally{await f.close();}
 }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
