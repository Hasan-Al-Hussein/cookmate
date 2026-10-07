import { createAssistantAttemptRecovery } from '../../../apps/mobile/src/data/assistantAttemptRecovery';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type {
  AssistantTurnRequest,
  CommandPayload,
  CommandResult,
  MemoryUpdate,
  ProposalResponse,
} from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import type { AuthorizedActionPlan, RepositoryResult, StoreChange } from '../src/index';
import {
  createAssistantActionRepository,
  createAssistantCommandHooks,
} from '../../../apps/mobile/src/data/assistantActionRepository';
import { createAssistantContextRepository } from '../../../apps/mobile/src/data/assistantContextRepository';
import { createAssistantTurnRepository } from '../../../apps/mobile/src/data/assistantTurnRepository';
import { createConversationRepository } from '../../../apps/mobile/src/data/conversationRepository';
import { recoverInterruptedAssistantWork } from '../../../apps/mobile/src/data/assistantRecovery';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import { preferenceCommandHandlers } from '../../../apps/mobile/src/data/preferenceCommands';
import { favouriteCommandHandlers } from '../../../apps/mobile/src/data/favouriteCommands';
import { createPlanCommandHandlers } from '../../../apps/mobile/src/data/planCommands';
import { createShoppingCommandHandlers } from '../../../apps/mobile/src/data/shoppingCommands';
import {
  createStateRepositories,
  readReceiptInSnapshot,
} from '../../../apps/mobile/src/data/stateRepositories';
import { readSnapshot } from '../../../apps/mobile/src/data/query';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import {
  prepareAuthorizedActionPlan,
  prepareAuthorizedIntent,
} from '../../../apps/mobile/src/assistant-core/actions';
import type { ExplicitActionAuthority } from '../../../apps/mobile/src/assistant-core/actions';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('action recovery is read-only and active absent receipts remain unresolved without preventing explicit execution', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
    assert.equal(ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId)), null);
    await f.freeze(turn);
    for (const finalized of [false, true]) {
      if (finalized) ready(await f.finalize(turn.plan, 0));
      const before = f.snapshot();
      const changes = f.store.database.prepare('SELECT total_changes() AS n').get()?.n;
      const events = f.events.length;
      const result = await f.store.actions.readActionRecovery(turn.plan.userIntentId);
      const proof = ready(result)!;
      assert.equal(proof.phase, 'ready');
      assert.equal(proof.conversationId, turn.request.conversationId);
      assert.equal(proof.conversationGeneration, turn.request.conversationGeneration);
      assert.equal(proof.userIntentId, turn.plan.userIntentId);
      assert.equal(proof.intentRevision, 0);
      assert.deepEqual(proof.slots, [
        {
          slotId: turn.plan.slots[0]!.slotId,
          operationId: turn.plan.slots[0]!.operationId,
          outcome: 'unresolved',
          receipt: null,
        },
      ]);
      if (result.kind !== 'ready') assert.fail();
      assert.equal(
        result.revision,
        f.store.database
          .prepare("SELECT revision FROM state_revision WHERE collection='store'")
          .get()?.revision,
      );
      assert.equal(Object.isFrozen(proof.slots[0]), true);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.store.database.prepare('SELECT total_changes() AS n').get()?.n, changes);
      assert.equal(f.events.length, events);
      assert.equal(f.faults.dispatched, 0);
    }
    const actual = receipt(await f.execute(turn.plan, 0));
    f.changeDate();
    f.changeConnection();
    const before = f.snapshot();
    const proof = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
    assert.equal(proof.phase, 'settled');
    assert.equal(proof.slots[0]!.outcome, 'receipt');
    assert.deepEqual(proof.slots[0]!.receipt, actual);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.faults.dispatched, 1);
  } finally {
    await f.close();
  }
});

test('reopened action recovery proves suspended absent effects for both finalized and unfinalized reservations', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept();
    await f.freeze(turn);
    const frozen = ready(await f.finalize(turn.plan, 0)).slot;
    await f.reopen(true);
    f.changeDate();
    f.changeConnection();
    const before = f.snapshot();
    const proof = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
    assert.equal(proof.phase, 'reconciling');
    assert.deepEqual(
      proof.slots,
      turn.plan.slots.map((slot) => ({
        slotId: slot.slotId,
        operationId: slot.operationId,
        outcome: 'not_executed',
        receipt: null,
      })),
    );
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.faults.dispatched, 0);
    failed(await f.store.executor.execute(frozen.command), 'cancelled');
    failed(await f.finalize(turn.plan, 1), 'cancelled');
    assert.deepEqual(f.snapshot(), before);
  } finally {
    await f.close();
  }
});

test('partial prefix and lost commit acknowledgement recover actual receipts and prove remaining slots absent after reopen', async () => {
  for (const lostAck of [false, true]) {
    const f = await fixture();
    try {
      const turn = await f.accept();
      await f.freeze(turn);
      ready(await f.finalize(turn.plan, 0));
      f.faults.commitAck = lostAck;
      const actual = receipt(await f.execute(turn.plan, 0));
      if (!lostAck) {
        const active = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
        assert.equal(active.phase, 'dispatched');
        assert.deepEqual(
          active.slots.map((slot) => slot.outcome),
          ['receipt', 'unresolved'],
        );
        ready(await f.finalize(turn.plan, 1));
      } else
        failed(await f.store.actions.readActionRecovery(turn.plan.userIntentId), 'storage_failure');
      await f.reopen(true);
      const before = f.snapshot();
      const count = f.faults.dispatched;
      const proof = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
      assert.equal(proof.phase, 'reconciling');
      assert.deepEqual(
        proof.slots.map((slot) => slot.outcome),
        ['receipt', 'not_executed'],
      );
      assert.deepEqual(proof.slots[0]!.receipt, actual);
      assert.equal(proof.slots[1]!.receipt, null);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.faults.dispatched, count);
    } finally {
      await f.close();
    }
  }
});

test('action recovery waits behind a pending writer and observes its atomic receipt after settlement', async () => {
  const f = await fixture();
  const writing = deferred();
  const release = deferred();
  try {
    const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
    await f.freeze(turn);
    ready(await f.finalize(turn.plan, 0));
    f.faults.afterStatement = async (sql) => {
      if (sql.startsWith('INSERT INTO operation_receipt')) {
        writing.resolve();
        await release.promise;
      }
    };
    const executing = f.execute(turn.plan, 0);
    await writing.promise;
    let completed = false;
    const proof = f.store.actions.readActionRecovery(turn.plan.userIntentId).then((result) => {
      completed = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    release.resolve();
    const actual = receipt(await executing);
    const recovered = ready(await proof)!;
    assert.equal(recovered.phase, 'settled');
    assert.equal(recovered.slots[0]!.outcome, 'receipt');
    assert.deepEqual(recovered.slots[0]!.receipt, actual);
    assert.equal(f.faults.dispatched, 1);
  } finally {
    release.resolve();
    await f.close();
  }
});

test('recovery cannot prove absence while execution hashes before enqueue; cancellation blocks the late writer', async () => {
  const f = await fixture();
  const hashing = deferred();
  const release = deferred();
  try {
    const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
    await f.freeze(turn);
    ready(await f.finalize(turn.plan, 0));
    f.faults.beforeExecutorHash = async () => {
      hashing.resolve();
      await release.promise;
    };
    const executing = f.execute(turn.plan, 0);
    await hashing.promise;
    const before = f.snapshot();
    const live = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
    assert.equal(live.phase, 'ready');
    assert.equal(live.slots[0]!.outcome, 'unresolved');
    assert.deepEqual(f.snapshot(), before);
    ready(
      await f.store.actions.cancelIntent({
        userIntentId: turn.plan.userIntentId,
        expectedIntentRevision: 0,
      }),
    );
    const stopped = ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!;
    assert.equal(stopped.phase, 'cancelled');
    assert.equal(stopped.slots[0]!.outcome, 'not_executed');
    release.resolve();
    failed(await executing, 'cancelled');
    assert.equal(
      f.store.database.prepare('SELECT COUNT(*) AS n FROM operation_receipt').get()?.n,
      0,
    );
    assert.equal(f.store.database.prepare('SELECT COUNT(*) AS n FROM favourite').get()?.n, 0);
    assert.equal(
      ready(await f.store.actions.readActionRecovery(turn.plan.userIntentId))!.slots[0]!.outcome,
      'not_executed',
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

test('action recovery rejects unknown, corrupted and unavailable state without empty success or mutation', async () => {
  const f = await fixture();
  try {
    failed(await f.store.actions.readActionRecovery(randomUUID()), 'stale_context');
    failed(await f.store.actions.readActionRecovery('not-an-id'), 'invalid_input');
    const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
    await f.freeze(turn);
    const slot = ready(await f.finalize(turn.plan, 0)).slot;
    f.store.database.exec('PRAGMA foreign_keys=OFF');
    const beforeUnavailable = f.snapshot();
    failed(await f.store.actions.readActionRecovery(turn.plan.userIntentId), 'storage_failure');
    assert.deepEqual(f.snapshot(), beforeUnavailable);
    f.store.database.exec('PRAGMA foreign_keys=ON');
    const command = clone(slot.command);
    command.payloadFingerprint = '0'.repeat(64);
    const pending = f.store.database
      .prepare('SELECT intent_json FROM pending_intent WHERE user_intent_id=?')
      .get(turn.plan.userIntentId)!;
    const intent = JSON.parse(pending.intent_json as string);
    intent.slots[0].command = command;
    f.store.database
      .prepare('UPDATE pending_intent SET intent_json=? WHERE user_intent_id=?')
      .run(JSON.stringify(intent), turn.plan.userIntentId);
    f.store.database
      .prepare('UPDATE command_slot SET command_json=? WHERE slot_id=?')
      .run(JSON.stringify(command), slot.slotId);
    const corrupt = f.snapshot();
    failed(await f.store.actions.readActionRecovery(turn.plan.userIntentId), 'storage_failure');
    assert.deepEqual(f.snapshot(), corrupt);
    intent.slots[0].command = clone(slot.command);
    f.store.database
      .prepare('UPDATE pending_intent SET intent_json=? WHERE user_intent_id=?')
      .run(JSON.stringify(intent), turn.plan.userIntentId);
    f.store.database
      .prepare('UPDATE command_slot SET command_json=? WHERE slot_id=?')
      .run(JSON.stringify(slot.command), slot.slotId);
    f.store.database
      .prepare('DELETE FROM assistant_action_plan WHERE user_intent_id=?')
      .run(turn.plan.userIntentId);
    const missingPlan = f.snapshot();
    failed(await f.store.actions.readActionRecovery(turn.plan.userIntentId), 'storage_failure');
    failed(await f.store.conversation.readIntentPage(), 'storage_failure');
    assert.deepEqual(f.snapshot(), missingPlan);
    assert.equal(f.faults.dispatched, 0);
  } finally {
    await f.close();
  }
});

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
    afterStatement: (_sql: string): void | Promise<void> => {},
    beforeExecutorHash: async () => {},
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
      attempts: createAssistantAttemptRecovery(),
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
          await faults.afterStatement(sql);
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
    const conversation = createConversationRepository(reader, catalogueBoundary);
    const state = createStateRepositories(reader, catalogueBoundary);
    const executor = createCommandExecutor({
      ...options,
      platform: {
        ...platform,
        sha256: async (text) => {
          await faults.beforeExecutorHash();
          return platform.sha256(text);
        },
      },
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
      readHistoricalReceipt: executor.readHistoricalReceipt,
      executeContinuation: (command, admission) =>
        executor.executeAssistantContinuation(command, admission),
      executeCommand: async (command) => {
        faults.dispatched++;
        return faults.uncertain
          ? { kind: 'uncertain', operationId: command.operationId }
          : executor.execute(command);
      },
    });
    return { ...db, writer, reader, context, turns, conversation, state, executor, actions };
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
    Object.fromEntries<Record<string, unknown>[]>(
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

function assertSuspendedWithoutEffects(
  f: Awaited<ReturnType<typeof fixture>>,
  before: ReturnType<Awaited<ReturnType<typeof fixture>>['snapshot']>,
) {
  const after = f.snapshot();
  for (const table of Object.keys(before)) {
    if (!['state_revision', 'pending_intent', 'assistant_intent_context'].includes(table))
      assert.deepEqual(after[table], before[table], table);
  }
  assert.deepEqual(
    after.state_revision!.filter((row) => row.collection !== 'store'),
    before.state_revision!.filter((row) => row.collection !== 'store'),
  );
  assert.equal(
    Number(after.state_revision!.find((row) => row.collection === 'store')!.revision),
    Number(before.state_revision!.find((row) => row.collection === 'store')!.revision) + 1,
  );
  assert.deepEqual(
    after.pending_intent!.map((row) => ({
      ...row,
      phase: undefined,
      intent_json: { ...JSON.parse(String(row.intent_json)), phase: undefined },
    })),
    before.pending_intent!.map((row) => ({
      ...row,
      phase: undefined,
      intent_json: { ...JSON.parse(String(row.intent_json)), phase: undefined },
    })),
  );
  assert.ok(after.pending_intent!.some((row) => row.phase === 'reconciling'));
  assert.deepEqual(
    after.assistant_intent_context!.map((row) => ({ ...row, slot_results_json: undefined })),
    before.assistant_intent_context!.map((row) => ({ ...row, slot_results_json: undefined })),
  );
}

test('assistant receipt metadata publishes conversation once for committed and no-op effects without changing semantic authority', async () => {
  for (const duplicate of [true, false]) {
    const f = await fixture();
    try {
      if (duplicate)
        receipt(await f.direct({ kind: 'setFavourite', recipeId: '53064', saved: true }));
      const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
      await f.freeze(turn);
      ready(await f.finalize(turn.plan, 0));
      const before = f.store.database
        .prepare(
          "SELECT collection,revision FROM state_revision WHERE collection IN ('store','conversation') ORDER BY collection",
        )
        .all();
      f.events.length = 0;
      const result = receipt(await f.execute(turn.plan, 0));
      const saved = ready(await f.store.turns.readIntent(turn.plan.userIntentId));
      assert.equal(saved?.intent.phase, 'settled');
      assert.equal(saved?.slotResults.length, 1);
      assert.equal(result.outcome, duplicate ? 'no_op' : 'committed');
      assert.equal(f.events.length, 1);
      assert.deepEqual(
        f.events[0]!.collections,
        duplicate ? ['conversation'] : ['favourites', 'conversation'],
      );
      assert.equal(
        f.events[0]!.revision,
        Number(before.find((row) => row.collection === 'store')!.revision) + 1,
      );
      assert.equal(
        f.store.database
          .prepare("SELECT revision FROM state_revision WHERE collection='conversation'")
          .get()?.revision,
        before.find((row) => row.collection === 'conversation')!.revision,
      );
      assert.deepEqual(receipt(await f.execute(turn.plan, 0)), result);
      assert.equal(f.events.length, 1);
    } finally {
      await f.close();
    }
  }
});

test('duplicate first preference no-op advances only actual receipt authority; later slot uses actual revision and retained IDs', async () => {
  const f = await fixture();
  try {
    receipt(
      await f.direct({
        kind: 'savePreference',
        preferenceId: randomUUID(),
        type: 'cuisine',
        explicitValue: 'Italian',
        expectedPreferenceRevision: 0,
      }),
    );
    const turn = await f.accept();
    const frozen = await f.freeze(turn);
    assert.equal(frozen.intent.phase, 'ready');
    assert.equal(frozen.intent.slots.length, 0);
    const notFinalized = await f.execute(turn.plan, 0);
    failed(notFinalized, 'stale_context');
    if (notFinalized.kind !== 'failed') assert.fail();
    assert.equal(notFinalized.operationId, turn.plan.slots[0]!.operationId);
    assert.equal(f.faults.dispatched, 0);
    failed(await f.finalize(turn.plan, 1), 'stale_context');
    const first = ready(await f.finalize(turn.plan, 0));
    assert.equal(first.slot.command.operationId, turn.plan.slots[0]!.operationId);
    assert.equal(first.slot.command.command.kind, 'savePreference');
    if (first.slot.command.command.kind === 'savePreference')
      assert.equal(first.slot.command.command.expectedPreferenceRevision, 1);
    const beforeRetry = f.snapshot();
    assert.deepEqual(ready(await f.finalize(turn.plan, 0)), first);
    assert.deepEqual(f.snapshot(), beforeRetry);
    const firstReceipt = receipt(await f.execute(turn.plan, 0));
    assert.equal(firstReceipt.outcome, 'no_op');
    assert.equal(
      f.store.database.prepare('SELECT cursor FROM assistant_action_plan').get()?.cursor,
      1,
    );
    const baseline = JSON.parse(
      f.store.database.prepare('SELECT guards_json FROM assistant_action_plan').get()!
        .guards_json as string,
    ) as { preferenceRevision: number; contextRevision: number };
    assert.equal(baseline.preferenceRevision, 1);
    assert.equal(
      baseline.contextRevision,
      f.store.database
        .prepare("SELECT revision FROM state_revision WHERE collection='conversation'")
        .get()?.revision,
    );
    const second = ready(await f.finalize(turn.plan, 1));
    assert.equal(second.slot.command.operationId, turn.plan.slots[1]!.operationId);
    if (second.slot.command.command.kind !== 'savePreference') assert.fail();
    assert.equal(second.slot.command.command.expectedPreferenceRevision, 1);
    assert.equal(
      second.slot.command.command.preferenceId,
      (turn.plan.slots[1]!.payload as { preferenceId: string }).preferenceId,
    );
    assert.equal(receipt(await f.execute(turn.plan, 1)).outcome, 'committed');
    const stored = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
    assert.equal(stored.intent.phase, 'settled');
    assert.equal(stored.slotResults.length, 2);
    assert.equal(ready(await f.store.state.readPreferences()).revision, 2);
    f.changeDate();
    f.changeConnection();
    const beforeHistorical = f.snapshot();
    assert.deepEqual(receipt(await f.execute(turn.plan, 0)), firstReceipt);
    assert.equal(ready(await f.finalize(turn.plan, 0)).intent.intent.phase, 'settled');
    assert.equal((await f.freeze(turn)).intent.phase, 'settled');
    assert.deepEqual(f.snapshot(), beforeHistorical);
  } finally {
    await f.close();
  }
});

test('plan freezing rejects extra, reordered, altered and colliding proposal identities; stored corruption fails as storage failure', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept();
    const variants = [
      { ...turn.plan, extra: true },
      { ...turn.plan, slots: [...turn.plan.slots].reverse() },
      { ...turn.plan, slots: turn.plan.slots.slice(0, 1) },
      {
        ...turn.plan,
        slots: turn.plan.slots.map((slot, index) =>
          index ? { ...slot, operationId: turn.plan.slots[0]!.operationId } : slot,
        ),
      },
      {
        ...turn.plan,
        slots: turn.plan.slots.map((slot, index) =>
          index ? { ...slot, payload: { ...slot.payload, explicitValue: 'Invented value' } } : slot,
        ),
      },
    ];
    for (const plan of variants)
      failed(
        await f.store.actions.freezeActionPlan({
          plan: plan as AuthorizedActionPlan,
          expectedIntentRevision: 0,
          guards: turn.guards,
        }),
        'invalid_input',
      );
    await f.freeze(turn);
    const changed = clone(turn.plan);
    changed.slots[0]!.slotId = randomUUID();
    failed(
      await f.store.actions.freezeActionPlan({
        plan: changed,
        expectedIntentRevision: 0,
        guards: turn.guards,
      }),
      'operation_conflict',
    );
    f.store.database.exec('UPDATE assistant_action_plan SET cursor=1');
    failed(await f.store.turns.readIntent(turn.plan.userIntentId), 'storage_failure');
    failed(await f.finalize(turn.plan, 0), 'storage_failure');
    assert.equal(
      f.store.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('unrelated preference or runtime changes invalidate dispatch even through the general executor; retries do not renew guards', async () => {
  for (const change of ['preference', 'date', 'connection']) {
    const f = await fixture();
    try {
      const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
      await f.freeze(turn);
      const slot = ready(await f.finalize(turn.plan, 0)).slot;
      if (change === 'preference')
        receipt(
          await f.direct({
            kind: 'savePreference',
            preferenceId: randomUUID(),
            type: 'cuisine',
            explicitValue: 'Indian',
            expectedPreferenceRevision: 0,
          }),
        );
      else if (change === 'date') f.changeDate();
      else f.changeConnection();
      const before = f.snapshot();
      assert.deepEqual(ready(await f.finalize(turn.plan, 0)).slot, slot);
      failed(await f.execute(turn.plan, 0), 'stale_context');
      failed(await f.store.executor.execute(slot.command), 'cancelled');
      assertSuspendedWithoutEffects(f, before);
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test('receipt, journal, cursor and real authority revisions roll back together if a hook write fails', async () => {
  for (const stage of [
    'UPDATE assistant_intent_context SET slot_results_json',
    'UPDATE assistant_action_plan SET guards_json',
  ]) {
    const f = await fixture();
    try {
      const turn = await f.accept([
        { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
      ]);
      await f.freeze(turn);
      const slot = ready(await f.finalize(turn.plan, 0)).slot;
      const before = f.snapshot();
      const events = f.events.length;
      f.faults.statement = stage;
      failed(await f.store.executor.execute(slot.command), 'storage_failure');
      if (stage.startsWith('UPDATE assistant_intent_context')) {
        assert.deepEqual(f.snapshot(), before);
        assert.equal(f.events.length, events);
      } else {
        assertSuspendedWithoutEffects(f, before);
        assert.equal(f.events.length, events + 1);
      }
      f.faults.statement = '';
      ready(await f.store.actions.reconcileActionRecovery(turn.plan.userIntentId));
      const review = ready(
        await f.store.actions.readActionContinuationReview({
          userIntentId: turn.plan.userIntentId,
          expectedIntentRevision: 0,
        }),
      );
      assert.ok(review);
      const result = receipt(await f.store.actions.confirmActionContinuation({ review }));
      assert.equal(result.outcome, 'committed');
      assert.equal(
        f.store.database.prepare('SELECT cursor FROM assistant_action_plan').get()?.cursor,
        1,
      );
      assert.equal(
        ready(await f.store.turns.readIntent(turn.plan.userIntentId))!.slotResults[0]!.result.kind,
        'receipt',
      );
      assert.deepEqual(receipt(await f.execute(turn.plan, 0)), result);
    } finally {
      await f.close();
    }
  }
});

test('cancellation and interrupted reopen preserve receipts but cannot dispatch remaining reserved slots', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept();
    await f.freeze(turn);
    const first = ready(await f.finalize(turn.plan, 0));
    const result = receipt(await f.execute(turn.plan, 0));
    const cancelled = ready(
      await f.store.actions.cancelIntent({
        userIntentId: turn.plan.userIntentId,
        expectedIntentRevision: 0,
      }),
    );
    assert.equal(cancelled.intent.phase, 'reconciling');
    failed(await f.finalize(turn.plan, 1), 'cancelled');
    const historical = ready(await f.finalize(turn.plan, 0));
    assert.deepEqual(historical.slot, first.slot);
    assert.equal(historical.intent.intent.phase, 'reconciling');
    assert.deepEqual(receipt(await f.execute(turn.plan, 0)), result);
    await f.reopen(true);
    assert.deepEqual(receipt(await f.execute(turn.plan, 0)), result);
    failed(await f.finalize(turn.plan, 1), 'cancelled');
    assert.equal(ready(await f.store.state.readPreferences()).items.length, 1);
    assert.equal(
      f.store.database.prepare('SELECT COUNT(*) AS count FROM command_slot').get()?.count,
      1,
    );
  } finally {
    await f.close();
  }
});

test('uncertain prefix cannot silently advance, retry dispatch or finalize a later action', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept();
    await f.freeze(turn);
    ready(await f.finalize(turn.plan, 0));
    f.faults.uncertain = true;
    assert.equal((await f.execute(turn.plan, 0)).kind, 'uncertain');
    assert.equal(f.faults.dispatched, 1);
    assert.equal(
      f.store.database.prepare('SELECT cursor FROM assistant_action_plan').get()?.cursor,
      0,
    );
    assert.equal(
      ready(await f.store.turns.readIntent(turn.plan.userIntentId))!.intent.phase,
      'reconciling',
    );
    f.faults.uncertain = false;
    failed(await f.execute(turn.plan, 0), 'stale_context');
    failed(await f.finalize(turn.plan, 1), 'stale_context');
    assert.equal(f.faults.dispatched, 1);
    assert.equal(
      f.store.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('lost freeze or finalize acknowledgement preserves exact reserved identities and operation-specific notification proof', async () => {
  for (const stage of ['freeze', 'finalize']) {
    const f = await fixture();
    try {
      const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
      if (stage === 'finalize') await f.freeze(turn);
      const events = f.events.length;
      f.faults.commitAck = true;
      const attempted =
        stage === 'freeze'
          ? await f.store.actions.freezeActionPlan({
              plan: turn.plan,
              expectedIntentRevision: 0,
              guards: turn.guards,
            })
          : await f.finalize(turn.plan, 0);
      failed(attempted, 'storage_failure');
      assert.equal(f.events.length, events + 1);
      assert.equal(f.store.writer.requiresRecovery(), true);
      const dirtySnapshot = f.snapshot();
      failed(
        await f.store.actions.reconcileActionRecovery(turn.plan.userIntentId),
        'storage_failure',
      );
      assert.deepEqual(
        f.snapshot(),
        dirtySnapshot,
        'independent proof cannot rehabilitate writer cleanup',
      );
      assert.equal(
        f.events.length,
        events + 1,
        'no suspension commit occurred on the dirty writer',
      );
      await f.reopen(stage === 'finalize');
      const persisted = ready(await f.store.turns.readIntent(turn.plan.userIntentId))!;
      assert.deepEqual(persisted.actionPlan, turn.plan);
      assert.equal(persisted.intent.phase, stage === 'finalize' ? 'reconciling' : 'ready');
      await f.freeze(turn);
      const slot = ready(await f.finalize(turn.plan, 0)).slot;
      assert.equal(slot.command.operationId, turn.plan.slots[0]!.operationId);
      const before = f.snapshot();
      assert.deepEqual(ready(await f.finalize(turn.plan, 0)).slot, slot);
      assert.deepEqual(f.snapshot(), before);
      if (stage === 'finalize') {
        const review = ready(
          await f.store.actions.readActionContinuationReview({
            userIntentId: turn.plan.userIntentId,
            expectedIntentRevision: 0,
          }),
        );
        assert.ok(review);
        assert.equal(
          receipt(await f.store.actions.confirmActionContinuation({ review })).outcome,
          'committed',
        );
      } else assert.equal(receipt(await f.execute(turn.plan, 0)).outcome, 'committed');
    } finally {
      await f.close();
    }
  }
});

test('draft typing preserves authority but a subsequent semantic conversation turn invalidates remaining actions', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept([
      { kind: 'saveRecipe', recipeId: '53064' },
      { kind: 'saveRecipe', recipeId: '53150' },
    ]);
    await f.freeze(turn);
    ready(await f.finalize(turn.plan, 0));
    ready(
      await f.store.turns.saveDraft(
        {
          conversationId: turn.request.conversationId,
          generation: turn.request.conversationGeneration,
          expectedConversationRevision: turn.guards.contextRevision,
        },
        'An unfinished draft',
      ),
    );
    assert.equal(
      f.store.database
        .prepare("SELECT revision FROM state_revision WHERE collection='conversation'")
        .get()?.revision,
      turn.guards.contextRevision,
    );
    receipt(await f.execute(turn.plan, 0));
    const next = ready(await f.finalize(turn.plan, 1)).slot;
    await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
    const before = f.snapshot();
    failed(await f.execute(turn.plan, 1), 'stale_context');
    failed(await f.store.executor.execute(next.command), 'cancelled');
    assertSuspendedWithoutEffects(f, before);
    assert.equal(
      f.store.database
        .prepare("SELECT COUNT(*) AS count FROM favourite WHERE recipe_id='53150'")
        .get()?.count,
      0,
    );
  } finally {
    await f.close();
  }
});

test('runtime change after receipt and guard writes rolls back the transaction at the final executor hook', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
    await f.freeze(turn);
    const slot = ready(await f.finalize(turn.plan, 0)).slot;
    const before = f.snapshot();
    const events = f.events.length;
    f.faults.afterStatement = (sql) => {
      if (sql.startsWith('UPDATE assistant_action_plan SET guards_json')) f.changeDate();
    };
    failed(await f.store.executor.execute(slot.command), 'stale_context');
    assertSuspendedWithoutEffects(f, before);
    assert.equal(f.events.length, events + 1);
  } finally {
    await f.close();
  }
});

test('undispatched cancellation and missing assistant context never become direct-command authority', async () => {
  for (const mode of ['cancel', 'missing_context']) {
    const f = await fixture();
    try {
      const turn = await f.accept([{ kind: 'saveRecipe', recipeId: '53064' }]);
      await f.freeze(turn);
      const slot = ready(await f.finalize(turn.plan, 0)).slot;
      if (mode === 'cancel') {
        const stopped = ready(
          await f.store.actions.cancelIntent({
            userIntentId: turn.plan.userIntentId,
            expectedIntentRevision: 0,
          }),
        );
        assert.equal(stopped.intent.phase, 'cancelled');
        assert.equal(ready(await f.finalize(turn.plan, 0)).intent.intent.phase, 'cancelled');
      } else
        f.store.database
          .prepare('DELETE FROM assistant_intent_context WHERE user_intent_id=?')
          .run(turn.plan.userIntentId);
      failed(
        await f.store.executor.execute(slot.command),
        mode === 'cancel' ? 'cancelled' : 'storage_failure',
      );
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count,
        0,
      );
      assert.equal(
        f.store.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test('legacy fully frozen intent remains immutable and executes its complete command prefix in proposal order', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept([
      { kind: 'saveRecipe', recipeId: '53064' },
      { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
    ]);
    const intent = await prepareAuthorizedIntent(
      turn.request,
      turn.response,
      turn.authority,
      clone(turn.current),
      turn.guards,
      platform,
    );
    const frozen = ready(
      await f.store.actions.freezeIntent({
        intent,
        expectedIntentRevision: 0,
        guards: turn.guards,
      }),
    );
    assert.deepEqual(frozen.intent.slots, intent.slots);
    const plan = frozen.actionPlan!;
    failed(await f.execute(clone(plan), 1), 'stale_context');
    receipt(await f.execute(clone(plan), 0));
    receipt(await f.execute(clone(plan), 1));
    assert.equal(
      ready(await f.store.turns.readIntent(intent.userIntentId))!.intent.phase,
      'settled',
    );
    assert.deepEqual(
      ready(
        await f.store.actions.freezeIntent({
          intent,
          expectedIntentRevision: 0,
          guards: turn.guards,
        }),
      ).intent.slots,
      intent.slots,
    );
  } finally {
    await f.close();
  }
});

test('relative add-plan keeps its source date and occurrence identity while receipt authority permits the next plan slot', async () => {
  const f = await fixture();
  try {
    const turn = await f.accept(
      [
        {
          kind: 'addPlan',
          recipeId: '53064',
          placement: { actualDate: '2026-09-29', mealKey: 'lunch' },
          expectedTarget: { kind: 'empty' },
        },
        {
          kind: 'addPlan',
          recipeId: '53150',
          placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
          expectedTarget: { kind: 'empty' },
        },
      ],
      { relativeDate: '2026-09-29' },
    );
    const wrongSource = clone(turn.plan);
    wrongSource.relativeDateGuard!.sourceMessageId = randomUUID();
    failed(
      await f.store.actions.freezeActionPlan({
        plan: wrongSource,
        expectedIntentRevision: 0,
        guards: turn.guards,
      }),
      'invalid_input',
    );
    await f.freeze(turn);
    for (const index of [0, 1]) {
      const slot = ready(await f.finalize(turn.plan, index)).slot;
      assert.deepEqual(slot.command.relativeDateGuard, turn.plan.relativeDateGuard);
      assert.deepEqual(slot.command.origin, turn.plan.origin);
      assert.deepEqual(slot.command.command, turn.plan.slots[index]!.payload);
      receipt(await f.execute(turn.plan, index));
      const guards = JSON.parse(
        f.store.database.prepare('SELECT guards_json FROM assistant_action_plan').get()!
          .guards_json as string,
      );
      assert.equal(guards.planRevision, index + 1);
      assert.equal(
        guards.contextRevision,
        f.store.database
          .prepare("SELECT revision FROM state_revision WHERE collection='conversation'")
          .get()?.revision,
      );
    }
    const plan = ready(await f.store.state.readPlan('2026-09-28', '2026-10-04'));
    assert.deepEqual(
      plan.occurrences.map((entry) => entry.occurrenceId).sort(),
      turn.plan.slots.map((slot) => (slot.payload as { occurrenceId: string }).occurrenceId).sort(),
    );
    assert.equal(
      ready(await f.store.turns.readIntent(turn.plan.userIntentId))!.intent.phase,
      'settled',
    );
  } finally {
    await f.close();
  }
});

test('selected occupied replacement binds exact target and shopping consequences, then advances from actual scope revision', async () => {
  for (const unrelatedScopeChange of [false, true]) {
    const f = await fixture();
    try {
      const occurrenceId = randomUUID();
      const placement = { actualDate: '2026-09-29', mealKey: 'dinner' as const };
      receipt(
        await f.direct({
          kind: 'addPlan',
          occurrenceId,
          recipeId: '53064',
          placement,
          expectedTarget: { kind: 'empty' },
        }),
      );
      receipt(
        await f.direct({
          kind: 'setShoppingSelection',
          occurrenceIds: [occurrenceId],
          expectedShoppingScopeRevision: 0,
        }),
      );
      const current = ready(await f.store.state.readPlan('2026-09-28', '2026-10-04'));
      const occupant = current.occurrences[0]!;
      const turn = await f.accept(
        [
          {
            kind: 'addPlan',
            recipeId: '53150',
            placement,
            expectedTarget: { kind: 'occupied', occurrenceId, expectedRevision: occupant.revision },
          },
          { kind: 'saveRecipe', recipeId: '53150' },
        ],
        {
          replacements: [
            {
              occurrenceId,
              expectedRevision: occupant.revision,
              expectedShoppingScopeRevision: current.shoppingScope.revision,
              currentRecipeId: occupant.recipeId,
              replacementRecipeId: '53150',
              includedInShopping: true,
              placement,
            },
          ],
        },
      );
      const wrongScope = clone(turn.plan);
      if (wrongScope.slots[0]!.payload.kind !== 'replacePlanRecipe') assert.fail();
      wrongScope.slots[0]!.payload.expectedShoppingScopeRevision++;
      failed(
        await f.store.actions.freezeActionPlan({
          plan: wrongScope,
          expectedIntentRevision: 0,
          guards: turn.guards,
        }),
        'stale_context',
      );
      await f.freeze(turn);
      const first = ready(await f.finalize(turn.plan, 0)).slot;
      if (first.command.command.kind !== 'replacePlanRecipe') assert.fail();
      assert.equal(
        first.command.command.expectedShoppingScopeRevision,
        current.shoppingScope.revision,
      );
      assert.equal(first.command.command.expectedRevision, occupant.revision);
      if (unrelatedScopeChange) {
        receipt(
          await f.direct({
            kind: 'setShoppingSelection',
            occurrenceIds: [],
            expectedShoppingScopeRevision: current.shoppingScope.revision,
          }),
        );
        const before = f.snapshot();
        failed(await f.execute(turn.plan, 0), 'stale_context');
        assertSuspendedWithoutEffects(f, before);
        continue;
      }
      receipt(await f.execute(turn.plan, 0));
      const changed = ready(await f.store.state.readPlan('2026-09-28', '2026-10-04'));
      assert.equal(changed.occurrences[0]!.recipeId, '53150');
      // Recipe demand changed; the selected occurrence IDs (and scope revision) did not.
      assert.equal(changed.shoppingScope.revision, current.shoppingScope.revision);
      const guards = JSON.parse(
        f.store.database.prepare('SELECT guards_json FROM assistant_action_plan').get()!
          .guards_json as string,
      );
      assert.equal(guards.shoppingScopeRevision, changed.shoppingScope.revision);
      assert.equal(
        guards.planRevision,
        f.store.database
          .prepare("SELECT revision FROM state_revision WHERE collection='plan'")
          .get()?.revision,
      );
      ready(await f.finalize(turn.plan, 1));
      receipt(await f.execute(turn.plan, 1));
      assert.equal(
        ready(await f.store.turns.readIntent(turn.plan.userIntentId))!.intent.phase,
        'settled',
      );
    } finally {
      await f.close();
    }
  }
});
