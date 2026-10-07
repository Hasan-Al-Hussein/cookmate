import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  AssistantTurnRequest,
  MemoryUpdate,
  PreferenceSnapshot,
  ProposalResponse,
  LocalCommand,
} from '@cookmate/contracts';
import type {
  CookMateServices,
  DirectActionInput,
  DirectActionReview,
  Immutable,
  RepositoryResult,
  StoreChange,
} from '../src/index';
import type { SqlValue } from '../../../apps/mobile/src/data/sql';
import { StorageFault } from '../../../apps/mobile/src/data/sql';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import { prepareAuthorizedActionPlan } from '../../../apps/mobile/src/assistant-core/actions';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};

test('clear review exposes exact safe scope counts and rejects draft, context, proposal and reply changes before preparation and execution', async () => {
  for (const stage of ['prepare', 'execute'] as const) {
    for (const change of ['draft', 'context', 'proposal', 'reply'] as const) {
      const f = await fixture();
      try {
        const connectionGeneration = () => 1;
        const assistant = f.services.assistant({ connectionGeneration });
        let review!: Immutable<DirectActionReview>;
        let command!: Immutable<LocalCommand>;
        const capture = async () => {
          review = ready(await f.services.commands.reviewDirect({ kind: 'clearConversation' }));
          assert.equal(review.consequences.kind, 'conversation_clear');
          assert.equal(JSON.stringify(review).includes('PRIVATE_SCOPE_CONTENT'), false);
          if (stage === 'execute') command = ready(await f.services.commands.prepareDirect(review));
        };
        if (change === 'reply') {
          await acceptedActionTurn(f.services, connectionGeneration, 'PRIVATE_SCOPE_CONTENT', {
            beforeAccept: capture,
          });
        } else if (change === 'draft') {
          const save = async (value: string) => {
            const header = ready(await assistant.readConversation()).header;
            ready(
              await assistant.saveDraft(
                {
                  conversationId: header.conversationId,
                  generation: header.generation,
                  expectedConversationRevision: header.revision,
                },
                value,
              ),
            );
          };
          await save('  🍲');
          await capture();
          if (review.consequences.kind === 'conversation_clear') {
            assert.equal(review.consequences.messageCount, 0);
            assert.equal(review.consequences.scope.draftCharacterCount, 3);
            assert.equal(review.consequences.scope.hasAnythingToClear, true);
          }
          await save('\t 🍲');
        } else {
          const turn = await acceptedActionTurn(
            f.services,
            connectionGeneration,
            'PRIVATE_SCOPE_CONTENT',
            {
              retainMemory: change === 'context',
            },
          );
          await capture();
          if (review.consequences.kind === 'conversation_clear') {
            assert.equal(review.consequences.scope.pendingProposalCount, 1);
            assert.equal(review.consequences.scope.contextItemCount, change === 'context' ? 1 : 0);
          }
          if (change === 'proposal') await turn.freeze();
          else {
            const header = ready(await assistant.readConversation()).header;
            ready(
              await assistant.setWorkingContext({
                expectedContextRevision: header.revision,
                afterSequence: turn.request.message.sourceSequence,
                carryMemoryIds: [],
              }),
            );
          }
        }
        const database = f.connections[0]!.database;
        const before = database.prepare('SELECT total_changes() AS n').get()?.n;
        const result =
          stage === 'prepare'
            ? await f.services.commands.prepareDirect(review)
            : await f.services.commands.execute(command);
        assert.equal(result.kind, 'failed', `${stage}/${change}: ${JSON.stringify(result)}`);
        if (result.kind === 'failed') assert.equal(result.error.code, 'stale_context');
        assert.equal(database.prepare('SELECT total_changes() AS n').get()?.n, before);
        assert.equal(ready(await assistant.readConversation()).header.generation, 0);
      } finally {
        await f.cleanup();
      }
    }
  }
});

test('clear counts proposal groups with remaining work and preserves partial receipts plus unrelated direct work', async () => {
  const f = await fixture();
  try {
    const turn = await acceptedActionTurn(f.services, () => 1, 'Save both', {
      proposals: [
        { kind: 'saveRecipe', recipeId: '53064' },
        { kind: 'saveRecipe', recipeId: '52835' },
      ],
    });
    const plan = await turn.freeze();
    ready(
      await turn.assistant.finalizeNextIntentSlot({
        userIntentId: plan.userIntentId,
        expectedIntentRevision: 0,
        slotId: plan.slots[0]!.slotId,
      }),
    );
    const first = await turn.assistant.executeIntentSlot({
      userIntentId: plan.userIntentId,
      expectedIntentRevision: 0,
      slotId: plan.slots[0]!.slotId,
    });
    assert.equal(first.kind, 'receipt', JSON.stringify(first));
    if (first.kind !== 'receipt') assert.fail();
    const unrelated = ready(
      await f.services.commands.prepareDirect(
        ready(
          await f.services.commands.reviewDirect({
            kind: 'setFavourite',
            recipeId: '52835',
            saved: true,
          }),
        ),
      ),
    );
    const review = ready(await f.services.commands.reviewDirect({ kind: 'clearConversation' }));
    if (review.consequences.kind !== 'conversation_clear') assert.fail();
    assert.equal(review.consequences.scope.pendingProposalCount, 1);
    const clear = ready(await f.services.commands.prepareDirect(review));
    const cleared = await f.services.commands.execute(clear);
    assert.equal(cleared.kind, 'receipt', JSON.stringify(cleared));
    assert.deepEqual(
      ready(await f.services.queries.readReceipt(first.receipt.operationId)),
      first.receipt,
    );
    assert.equal(ready(await f.services.queries.readFavourites()).length, 1);
    assert.equal((await f.services.commands.execute(unrelated)).kind, 'receipt');
    assert.equal(ready(await f.services.queries.readFavourites()).length, 2);
    assert.equal((await turn.assistant.readIntent(plan.userIntentId)).kind, 'ready');
    assert.deepEqual(await f.services.commands.execute(clear), cleared);
  } finally {
    await f.cleanup();
  }
});

test('active proposal with missing prefix proof reports unknown count and can still be explicitly cleared', async () => {
  const f = await fixture();
  try {
    const turn = await acceptedActionTurn(f.services, () => 1, 'Save both', {
      proposals: [
        { kind: 'saveRecipe', recipeId: '53064' },
        { kind: 'saveRecipe', recipeId: '52835' },
      ],
    });
    const plan = await turn.freeze();
    ready(
      await turn.assistant.finalizeNextIntentSlot({
        userIntentId: plan.userIntentId,
        expectedIntentRevision: 0,
        slotId: plan.slots[0]!.slotId,
      }),
    );
    const first = await turn.assistant.executeIntentSlot({
      userIntentId: plan.userIntentId,
      expectedIntentRevision: 0,
      slotId: plan.slots[0]!.slotId,
    });
    assert.equal(first.kind, 'receipt');
    if (first.kind !== 'receipt') assert.fail();
    f.connections[0]!.database.prepare('DELETE FROM operation_receipt WHERE operation_id=?').run(
      first.receipt.operationId,
    );
    const review = ready(await f.services.commands.reviewDirect({ kind: 'clearConversation' }));
    if (review.consequences.kind !== 'conversation_clear') assert.fail();
    assert.equal(review.consequences.scope.pendingProposalCount, null);
    assert.equal(review.consequences.scope.hasAnythingToClear, true);
    const clear = ready(await f.services.commands.prepareDirect(review));
    assert.equal((await f.services.commands.execute(clear)).kind, 'receipt');
    assert.equal(ready(await f.services.queries.readFavourites()).length, 1);
  } finally {
    await f.cleanup();
  }
});

test('clear scope ignores unrelated cooking, notes, history, shopping and preference writes and preserves their exact rows', async () => {
  const f = await fixture({
    enablePortableRestore: true,
    enableCooking: true,
    enablePersonal: true,
  });
  try {
    const assistant = f.services.assistant({ connectionGeneration: () => 1 });
    const header = ready(await assistant.readConversation()).header;
    ready(
      await assistant.saveDraft(
        {
          conversationId: header.conversationId,
          generation: header.generation,
          expectedConversationRevision: header.revision,
        },
        'Clear this draft only',
      ),
    );
    const review = ready(await f.services.commands.reviewDirect({ kind: 'clearConversation' }));
    const cooking = f.services.cooking!;
    const content = ready(await cooking.readSession('53064'));
    assert.equal(
      (
        await cooking.saveSession({
          operationId: randomUUID(),
          sessionId: randomUUID(),
          recipeId: '53064',
          expectedRevision: null,
          contentFingerprint: content.currentContent.contentFingerprint,
          readerVersion: content.currentContent.readerVersion,
          passageSequence: content.passageSequences[0]!,
        })
      ).kind,
      'ready',
    );
    assert.equal(
      (
        await cooking.saveCooked({
          eventId: randomUUID(),
          recipeId: '53064',
          contentFingerprint: content.currentContent.contentFingerprint,
          readerVersion: content.currentContent.readerVersion,
          expectedHistoryEpoch: 0,
          cookedOn: '2026-09-28',
          timeZone: 'Asia/Dubai',
          note: 'Keep this history',
        })
      ).kind,
      'ready',
    );
    assert.equal(
      (
        await f.services.personal!.execute({
          operationId: randomUUID(),
          expectedEpoch: 0,
          kind: 'saveNote',
          noteId: randomUUID(),
          recipeId: '53064',
          expectedRevision: null,
          text: 'Keep this private recipe note',
        })
      ).kind,
      'ready',
    );
    await f.action({ kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' });
    await f.action({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await f.action({
      kind: 'placeRecipe',
      recipeId: '53064',
      placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
    });
    const occurrence = ready(await f.services.queries.readPlan('2026-09-28', '2026-09-28'))
      .occurrences[0]!;
    await f.action({ kind: 'setShoppingSelection', occurrenceIds: [occurrence.occurrenceId] });
    const database = f.connections[0]!.database;
    const preserved = () =>
      Object.fromEntries(
        [
          'cooking_session',
          'cooking_event',
          'recipe_note',
          'personal_operation',
          'saved_preference',
          'favourite',
          'plan_occurrence',
          'shopping_selection',
        ].map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
      );
    const before = preserved();
    const clear = ready(await f.services.commands.prepareDirect(review));
    assert.equal((await f.services.commands.execute(clear)).kind, 'receipt');
    assert.deepEqual(preserved(), before);
    assert.equal(ready(await assistant.readConversation()).header.composerDraft, '');
  } finally {
    await f.cleanup();
  }
});

test('acknowledged draft events carry immutable exact headers with constant nonempty-history work', async (t) => {
  for (const retained of [1, 33]) {
    const f = await fixture();
    try {
      const generation = () => 1;
      for (let index = 0; index < retained; index++)
        await acceptedActionTurn(f.services, generation, `Retained request ${index}`);
      const assistant = f.services.assistant({ connectionGeneration: generation });
      let gate = ready(await assistant.refreshRecoveryGate());
      while (gate.kind === 'checking')
        gate = ready(await assistant.refreshRecoveryGate({ continuation: gate.continuation }));
      let header = ready(await assistant.readConversation({ limit: 1 })).header;
      const database = f.connections[0]!.database;
      const messages = database.prepare('SELECT * FROM message ORDER BY sequence').all();
      const intents = database
        .prepare('SELECT * FROM pending_intent ORDER BY user_intent_id')
        .all();
      const events: StoreChange[] = [];
      f.services.queries.subscribe((event) => {
        if (event.conversationChange)
          Object.assign(event.conversationChange.header, { composerDraft: 'subscriber mutation' });
      });
      f.services.queries.subscribe((event) => events.push(event));
      const counters = { sql: 0, historicalBodies: 0 };
      for (const { connection } of f.connections) {
        const read = connection.all;
        connection.all = async <Row extends object>(
          sql: string,
          values?: readonly SqlValue[],
        ): Promise<Row[]> => {
          counters.sql++;
          const rows = await read<Row>(sql, values);
          for (const row of rows)
            for (const [key, value] of Object.entries(row))
              if ((/json$/i.test(key) || key === 'text') && typeof value === 'string')
                counters.historicalBodies++;
          return rows;
        };
        const exec = connection.exec;
        connection.exec = async (sql) => {
          counters.sql++;
          await exec(sql);
        };
        const prepare = connection.prepare;
        connection.prepare = async (sql) => {
          const statement = await prepare(sql);
          return {
            run: async (values) => {
              counters.sql++;
              await statement.run(values);
            },
            finalize: () => statement.finalize(),
          };
        };
      }
      for (let index = 0; index < 20; index++) {
        const result = await assistant.saveDraft(
          {
            conversationId: header.conversationId,
            generation: header.generation,
            expectedConversationRevision: header.revision,
          },
          `Next draft ${index}`,
        );
        header = ready(result);
        const event = events.at(-1)!;
        assert.deepEqual(event.conversationChange, { kind: 'draft_only', header });
        assert.deepEqual(event.recovery, { kind: 'unchanged', token: gate.token });
        if (result.kind !== 'ready') assert.fail();
        assert.equal(event.revision, result.revision);
        assert.equal(Object.isFrozen(event.conversationChange), true);
        assert.equal(Object.isFrozen(event.conversationChange!.header), true);
      }
      assert.equal(events.length, 20);
      assert.equal(counters.historicalBodies, 0);
      assert.deepEqual(database.prepare('SELECT * FROM message ORDER BY sequence').all(), messages);
      assert.deepEqual(
        database.prepare('SELECT * FROM pending_intent ORDER BY user_intent_id').all(),
        intents,
      );
      t.diagnostic(JSON.stringify({ retainedIntents: retained, drafts: 20, ...counters }));
      const count = events.length;
      ready(
        await assistant.saveDraft(
          {
            conversationId: header.conversationId,
            generation: header.generation,
            expectedConversationRevision: header.revision,
          },
          header.composerDraft,
        ),
      );
      assert.equal(events.length, count, 'an unchanged draft has no committed event');
      assert.equal(
        (
          await assistant.saveDraft(
            {
              conversationId: header.conversationId,
              generation: header.generation,
              expectedConversationRevision: header.revision + 1,
            },
            'stale save',
          )
        ).kind,
        'failed',
      );
      assert.equal(events.length, count, 'a rejected save has no draft certificate');
      const later = await acceptedActionTurn(f.services, generation, 'Ordinary reply and action');
      const plan = await later.freeze();
      ready(
        await assistant.cancelIntent({
          userIntentId: plan.userIntentId,
          expectedIntentRevision: 0,
        }),
      );
      await f.action({ kind: 'clearConversation' });
      assert.ok(events.length > count);
      assert.ok(events.slice(count).every((event) => event.conversationChange === undefined));
    } finally {
      await f.cleanup();
    }
  }
});

test('lost draft commit acknowledgement reconciles without a draft-only certificate', async () => {
  const f = await fixture();
  try {
    const assistant = f.services.assistant({ connectionGeneration: () => 1 });
    ready(await assistant.refreshRecoveryGate());
    const header = ready(await assistant.readConversation()).header;
    const events: StoreChange[] = [];
    f.services.queries.subscribe((event) => events.push(event));
    const connection = f.connections[0]!.connection;
    const exec = connection.exec;
    let loseAck = true;
    connection.exec = async (sql) => {
      await exec(sql);
      if (sql === 'COMMIT' && loseAck) {
        loseAck = false;
        throw new Error('lost draft commit acknowledgement');
      }
    };
    const result = await assistant.saveDraft(
      {
        conversationId: header.conversationId,
        generation: header.generation,
        expectedConversationRevision: header.revision,
      },
      'Durable with uncertain acknowledgement',
    );
    assert.equal(result.kind, 'failed');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.conversationChange, undefined);
    assert.equal(events[0]!.recovery, undefined);
    assert.equal(
      ready(await assistant.readConversation()).header.composerDraft,
      'Durable with uncertain acknowledgement',
    );
  } finally {
    await f.cleanup();
  }
});

async function acceptedActionTurn(
  services: CookMateServices,
  connectionGeneration: () => number,
  label: string,
  options: {
    proposals?: ProposalResponse['proposals'];
    retainMemory?: boolean;
    beforeAccept?(): Promise<void>;
  } = {},
) {
  const assistant = services.assistant({ connectionGeneration });
  const context = await assistant.readContext({
    text: label,
    messageId: randomUUID(),
    selection: {},
  });
  assert.equal(context.kind, 'ready', JSON.stringify(context));
  if (context.kind !== 'ready') assert.fail();
  const snapshot = JSON.parse(JSON.stringify(context.value));
  const request: AssistantTurnRequest = {
    apiVersion: '2',
    catalogue: services.queries.catalogue,
    requestId: randomUUID(),
    userIntentId: randomUUID(),
    intentRevision: 0,
    conversationId: snapshot.conversationId,
    conversationGeneration: snapshot.conversationGeneration,
    connectionGeneration: connectionGeneration(),
    message: snapshot.currentMessage,
    context: {
      date: snapshot.date,
      history: snapshot.history,
      memory: snapshot.memory,
      preferences: snapshot.preferences,
      referenceSets: snapshot.referenceSets,
      planOccurrences: snapshot.planOccurrences,
    },
    capabilities: ['saveRecipe'],
  };
  const begun = ready(
    await assistant.beginTurn({ request, expectedConversationRevision: snapshot.contextRevision }),
  );
  const response: ProposalResponse = {
    apiVersion: '2',
    catalogue: request.catalogue,
    requestId: request.requestId,
    userIntentId: request.userIntentId,
    intentRevision: 0,
    conversationId: request.conversationId,
    conversationGeneration: request.conversationGeneration,
    connectionGeneration: request.connectionGeneration,
    preferenceRevision: request.context.preferences.revision,
    kind: 'proposal',
    text: 'Save this explicitly requested recipe.',
    sources: [],
    referenceSets: [],
    proposals: options.proposals ?? [{ kind: 'saveRecipe', recipeId: '53064' }],
    memoryUpdate: {
      baseRevision: request.context.memory.projectionRevision,
      baseContextRevision: request.context.memory.baseContextRevision,
      reviews: request.context.memory.reviewTargetMessageIds.map((sourceMessageId) => ({
        sourceMessageId,
        disposition:
          options.retainMemory && sourceMessageId === request.message.messageId
            ? 'retain'
            : 'non_memory',
      })) as MemoryUpdate['reviews'],
      entries: options.retainMemory
        ? [
            {
              sourceMessageId: request.message.messageId,
              quote: label,
              kind: 'context',
              scope: { kind: 'conversation' },
              relations: [],
            },
          ]
        : [],
    },
  };
  await options.beforeAccept?.();
  const accepted = ready(
    await assistant.acceptResponse({ ...begun.acceptanceEnvelope, response }),
  ).acknowledgement;
  return {
    assistant,
    request,
    freeze: async () => {
      assert.ok(accepted.guards);
      const current = ready(await assistant.readCurrentActionState(request.userIntentId));
      const plan = await prepareAuthorizedActionPlan(
        request,
        response,
        { source: 'explicit_user', proposals: response.proposals, replacementConfirmations: [] },
        JSON.parse(JSON.stringify(current)),
        accepted.guards,
        platform,
      );
      ready(
        await assistant.freezeActionPlan({
          plan,
          expectedIntentRevision: 0,
          guards: accepted.guards,
        }),
      );
      return plan;
    },
  };
}

test('public raw assistant command failure suspends the same store and permits explicit continuation', async () => {
  const f = await fixture();
  try {
    const turn = await acceptedActionTurn(
      f.services,
      () => 1,
      'Save through the public command service',
    );
    const plan = await turn.freeze();
    const slot = ready(
      await turn.assistant.finalizeNextIntentSlot({
        userIntentId: plan.userIntentId,
        expectedIntentRevision: 0,
        slotId: plan.slots[0]!.slotId,
      }),
    ).slot;
    const connection = f.connections[0]!.connection;
    const prepare = connection.prepare;
    let fail = true;
    connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        ...statement,
        run: async (values) => {
          await statement.run(values);
          if (fail && sql.startsWith('INSERT INTO favourite')) {
            fail = false;
            throw new Error('public ordinary assistant command rolled back');
          }
        },
      };
    };
    const result = await f.services.commands.execute(slot.command);
    assert.equal(result.kind, 'failed', JSON.stringify(result));
    assert.equal(ready(await f.services.queries.readReceipt(slot.command.operationId)), null);
    assert.equal(ready(await f.services.queries.readFavourites()).length, 0);
    const saved = ready(await turn.assistant.readIntent(plan.userIntentId))!;
    assert.equal(saved.intent.phase, 'reconciling');
    assert.deepEqual(saved.slotResults, [{ slotId: slot.slotId, result }]);
    const reconciled = ready(await turn.assistant.reconcileActionRecovery(plan.userIntentId));
    assert.ok(reconciled);
    const review = ready(
      await turn.assistant.readActionContinuationReview({
        userIntentId: plan.userIntentId,
        expectedIntentRevision: 0,
      }),
    );
    assert.ok(review);
    assert.equal(review.slot.commandState, 'frozen');
    const resumed = await turn.assistant.confirmActionContinuation({ review });
    assert.equal(resumed.kind, 'receipt', JSON.stringify(resumed));
    assert.equal(ready(await f.services.queries.readFavourites()).length, 1);
    assert.equal(
      ready(await turn.assistant.readIntent(plan.userIntentId))!.intent.phase,
      'settled',
    );
  } finally {
    await f.cleanup();
  }
});

test('public action recovery discovers cancelled plans beyond thirty intents, tracks metadata revision drift and invalidates on clear', async () => {
  const f = await fixture();
  try {
    await f.action({ kind: 'setFavourite', recipeId: '53064', saved: true });
    const connectionGeneration = () => 1;
    const ids: string[] = [];
    let last!: Awaited<ReturnType<typeof acceptedActionTurn>>;
    for (let index = 0; index < 32; index++) {
      last = await acceptedActionTurn(
        f.services,
        connectionGeneration,
        `Explicit recipe request ${index}`,
      );
      ids.push(last.request.userIntentId);
      if (index === 0) {
        await last.freeze();
        ready(
          await last.assistant.cancelIntent({
            userIntentId: last.request.userIntentId,
            expectedIntentRevision: 0,
          }),
        );
      }
    }
    const plan = await last.freeze();
    const assistant = last.assistant;
    ready(
      await assistant.finalizeNextIntentSlot({
        userIntentId: plan.userIntentId,
        expectedIntentRevision: 0,
        slotId: plan.slots[0]!.slotId,
      }),
    );
    const latestResult = await assistant.readIntentPage();
    const latest = ready(latestResult);
    assert.equal(latest.items.length, 30);
    assert.equal(latest.hasEarlier, true);
    assert.equal(
      latest.items.some((item) => item.userIntentId === ids[0]),
      false,
    );
    const earlierResult = await assistant.readIntentPage({
      beforeSequence: latest.beforeSequence!,
    });
    const earlier = ready(earlierResult);
    assert.equal(earlier.hasEarlier, false);
    assert.deepEqual(
      earlier.items.map((item) => item.userIntentId),
      ids.slice(0, 2),
    );
    assert.equal(earlier.items[0]!.phase, 'cancelled');
    const all = [...earlier.items, ...latest.items];
    assert.deepEqual(
      all.filter((item) => item.hasActionPlan).map((item) => item.userIntentId),
      [ids[0], ids[31]],
    );
    const olderProof = ready(await assistant.readActionRecovery(ids[0]!))!;
    assert.equal(olderProof.slots[0]!.outcome, 'not_executed');
    assert.equal(ready(await assistant.readActionRecovery(ids[1]!)), null);
    if (latestResult.kind !== 'ready' || earlierResult.kind !== 'ready') assert.fail();
    assert.equal(earlierResult.revision, latestResult.revision);
    const executed = await assistant.executeIntentSlot({
      userIntentId: plan.userIntentId,
      expectedIntentRevision: 0,
      slotId: plan.slots[0]!.slotId,
    });
    assert.equal(executed.kind, 'receipt', JSON.stringify(executed));
    if (executed.kind !== 'receipt') assert.fail();
    assert.equal(executed.receipt.outcome, 'no_op');
    const afterResult = await assistant.readIntentPage();
    const after = ready(afterResult);
    if (afterResult.kind !== 'ready') assert.fail();
    assert.ok(afterResult.revision > latestResult.revision);
    assert.equal(after.header.revision, latest.header.revision);
    assert.equal(after.items.at(-1)!.phase, 'settled');
    const proofResult = await assistant.readActionRecovery(plan.userIntentId);
    const proof = ready(proofResult)!;
    if (proofResult.kind !== 'ready') assert.fail();
    assert.equal(proofResult.revision, afterResult.revision);
    assert.deepEqual(proof.slots[0]!.receipt, executed.receipt);
    const changes = f.connections[0]!.database.prepare('SELECT total_changes() AS n').get()?.n;
    await assistant.readActionRecovery(plan.userIntentId);
    assert.equal(
      f.connections[0]!.database.prepare('SELECT total_changes() AS n').get()?.n,
      changes,
    );
    await f.action({ kind: 'clearConversation' });
    const cleared = ready(await assistant.readIntentPage());
    assert.deepEqual(cleared.items, []);
    assert.equal(cleared.header.conversationId, proof.conversationId);
    assert.equal(cleared.header.generation, proof.conversationGeneration + 1);
    assert.equal((await assistant.readActionRecovery(plan.userIntentId)).kind, 'failed');
    assert.deepEqual(
      ready(await f.services.queries.readReceipt(executed.receipt.operationId)),
      executed.receipt,
    );
  } finally {
    await f.cleanup();
  }
});

test('saved preferences retain exact UTF-16 through factory reopen, duplicate comparison and historical receipt', async () => {
  const f = await fixture();
  try {
    const exact = 'Italian\0\ud800 \udfff e\u0301🍲 "literal\\u0000"';
    const first = await f.action({ kind: 'savePreference', type: 'cuisine', explicitValue: exact });
    const before = ready(await f.services.queries.readPreferences());
    assert.equal(before.items[0]!.value, exact);
    await f.services.close();
    const opened = await f.open();
    assert.equal(opened.kind, 'ready');
    if (opened.kind !== 'ready') assert.fail();
    try {
      assert.deepEqual(ready(await opened.services.queries.readPreferences()), before);
      assert.deepEqual(await opened.services.commands.execute(first.command), first.result);
      const review = ready(
        await opened.services.commands.reviewDirect({
          kind: 'savePreference',
          type: 'cuisine',
          explicitValue: exact,
        }),
      );
      const command = ready(await opened.services.commands.prepareDirect(review));
      const duplicate = await opened.services.commands.execute(command);
      assert.equal(duplicate.kind, 'receipt');
      if (duplicate.kind === 'receipt') assert.equal(duplicate.receipt.outcome, 'no_op');
      assert.deepEqual(ready(await opened.services.queries.readPreferences()), before);
    } finally {
      await opened.services.close();
    }
  } finally {
    await f.cleanup();
  }
});
test('preference edit, removal and whole-set clear survive disk reopen without changing populated cooking state or draft', async () => {
  const f = await fixture();
  let services = f.services;
  const connectionGeneration = () => 1;
  const action = async (input: DirectActionInput) => {
    const review = ready(await services.commands.reviewDirect(input));
    const command = ready(await services.commands.prepareDirect(review));
    const result = await services.commands.execute(command);
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    if (result.kind !== 'receipt') assert.fail();
    assert.equal(result.receipt.outcome, 'committed');
  };
  const unrelatedState = async () => ({
    favourites: ready(await services.queries.readFavourites()),
    plan: ready(await services.queries.readPlan('2026-09-28', '2026-09-29')),
    shopping: ready(await services.queries.readShopping()),
    conversation: ready(await services.assistant({ connectionGeneration }).readConversation()),
  });
  try {
    await action({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await action({
      kind: 'placeRecipe',
      recipeId: '53064',
      placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
    });
    const occurrence = ready(await services.queries.readPlan('2026-09-28', '2026-09-29'))
      .occurrences[0]!;
    await action({ kind: 'setShoppingSelection', occurrenceIds: [occurrence.occurrenceId] });
    const shopping = ready(await services.queries.readShopping());
    assert.ok(shopping.groups.length > 0);
    await action({ kind: 'setPurchased', groupKey: shopping.groups[0]!.groupKey, purchased: true });
    const assistant = services.assistant({ connectionGeneration });
    const header = ready(await assistant.readConversation()).header;
    ready(
      await assistant.saveDraft(
        {
          conversationId: header.conversationId,
          generation: header.generation,
          expectedConversationRevision: header.revision,
        },
        'Keep this cooking question after changing preferences.',
      ),
    );
    const preferencesToSave = [
      { type: 'cuisine' as const, value: 'Italian' },
      { type: 'ingredient_avoid' as const, value: 'Walnuts' },
      { type: 'dietary_style' as const, value: 'Vegetarian' },
    ];
    const initialItems: PreferenceSnapshot['items'] = [];
    for (const [index, item] of preferencesToSave.entries()) {
      await action({
        kind: 'savePreference',
        type: item.type,
        explicitValue: item.value,
      });
      const saved = ready(await services.queries.readPreferences()).items.find(
        (preference) => preference.type === item.type && preference.value === item.value,
      );
      assert.ok(saved);
      initialItems.push({
        preferenceId: saved.preferenceId,
        type: item.type,
        value: item.value,
        revision: index + 1,
      });
    }
    const ids = { cuisine: initialItems[0]!.preferenceId, avoid: initialItems[1]!.preferenceId };
    initialItems.sort((a, b) => a.preferenceId.localeCompare(b.preferenceId));
    assert.deepEqual(ready(await services.queries.readPreferences()), {
      revision: 3,
      lastRemovalRevision: null,
      items: initialItems,
    });
    const before = await unrelatedState();
    assert.equal(before.favourites.length, 1);
    assert.equal(before.plan.occurrences.length, 1);
    assert.deepEqual(before.shopping.scope.occurrenceIds, [occurrence.occurrenceId]);
    assert.equal(before.shopping.status, 'current');
    assert.ok(before.shopping.groups.some((group) => group.purchased));
    assert.ok(before.shopping.groups.every((group) => group.contributions.length > 0));
    assert.equal(
      before.conversation.header.composerDraft,
      'Keep this cooking question after changing preferences.',
    );
    const editedItems = initialItems.map((item) =>
      item.preferenceId === ids.cuisine ? { ...item, value: 'Indian', revision: 4 } : item,
    );
    const stages: { input: DirectActionInput; expected: PreferenceSnapshot }[] = [
      {
        input: {
          kind: 'savePreference',
          preferenceId: ids.cuisine,
          type: 'cuisine',
          explicitValue: 'Indian',
        },
        expected: { revision: 4, lastRemovalRevision: 4, items: editedItems },
      },
      {
        input: { kind: 'removePreference', preferenceId: ids.avoid },
        expected: {
          revision: 5,
          lastRemovalRevision: 5,
          items: editedItems.filter((item) => item.preferenceId !== ids.avoid),
        },
      },
      {
        input: { kind: 'clearPreferences' },
        expected: { revision: 6, lastRemovalRevision: 6, items: [] },
      },
    ];
    for (const { input, expected } of stages) {
      await action(input);
      assert.deepEqual(ready(await services.queries.readPreferences()), expected);
      assert.deepEqual(await unrelatedState(), before);
      await services.close();
      const reopened = await f.open();
      assert.equal(reopened.kind, 'ready', JSON.stringify(reopened));
      if (reopened.kind !== 'ready') assert.fail();
      services = reopened.services;
      assert.deepEqual(ready(await services.queries.readPreferences()), expected);
      assert.deepEqual(await unrelatedState(), before);
    }
  } finally {
    await services.close();
    await f.cleanup();
  }
});

test('selective favourite removal survives disk reopen while preserving the other favourite and planned recipe', async () => {
  const f = await fixture();
  let reopened: CookMateServices | undefined;
  try {
    await f.action({ kind: 'setFavourite', recipeId: '53064', saved: true });
    await f.action({ kind: 'setFavourite', recipeId: '53262', saved: true });
    await f.action({
      kind: 'placeRecipe',
      recipeId: '53064',
      placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
    });
    const favouritesBefore = ready(await f.services.queries.readFavourites());
    assert.deepEqual(favouritesBefore.map((item) => item.recipeId).sort(), ['53064', '53262']);
    const retainedFavourite = favouritesBefore.filter((item) => item.recipeId === '53262');
    const planBefore = ready(await f.services.queries.readPlan('2026-09-28', '2026-09-28'));
    assert.equal(planBefore.occurrences.length, 1);
    assert.equal(planBefore.occurrences[0]!.recipeId, '53064');
    const recipeBefore = ready(await f.services.queries.readRecipe('53064'));
    assert.ok(recipeBefore);
    assert.equal(recipeBefore.recipeId, '53064');
    const removed = await f.action({ kind: 'setFavourite', recipeId: '53064', saved: false });
    if (removed.result.kind !== 'receipt') assert.fail('Expected durable removal receipt');
    const receipt = removed.result.receipt;
    assert.equal(receipt.outcome, 'committed');
    assert.equal(receipt.operationId, removed.command.operationId);
    const assertPreserved = async (services: CookMateServices) => {
      assert.deepEqual(ready(await services.queries.readFavourites()), retainedFavourite);
      assert.deepEqual(
        ready(await services.queries.readPlan('2026-09-28', '2026-09-28')),
        planBefore,
      );
      assert.deepEqual(ready(await services.queries.readRecipe('53064')), recipeBefore);
      assert.deepEqual(ready(await services.queries.readReceipt(receipt.operationId)), receipt);
    };
    await assertPreserved(f.services);
    await f.services.close();
    const opened = await f.open();
    assert.equal(opened.kind, 'ready', JSON.stringify(opened));
    if (opened.kind !== 'ready') assert.fail();
    reopened = opened.services;
    await assertPreserved(reopened);
  } finally {
    await reopened?.close();
    await f.cleanup();
  }
});

function ready<T>(result: RepositoryResult<T>): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}

test('public restore queries preserve installation identity and discover interrupted and historical intents across reopen and clear', async () => {
  const f = await fixture();
  try {
    const installationId = ready(await f.services.queries.readInstallationId());
    assert.match(installationId, /^[0-9a-f-]{36}$/);
    const generation = () => 1;
    const assistant = f.services.assistant({ connectionGeneration: generation });
    const begin = async (text: string) => {
      const context = await assistant.readContext({ text, messageId: randomUUID(), selection: {} });
      assert.equal(context.kind, 'ready');
      if (context.kind !== 'ready') assert.fail();
      const s = JSON.parse(JSON.stringify(context.value));
      const request: AssistantTurnRequest = {
        apiVersion: '2',
        catalogue: f.services.queries.catalogue,
        requestId: randomUUID(),
        userIntentId: randomUUID(),
        intentRevision: 0,
        conversationId: s.conversationId,
        conversationGeneration: s.conversationGeneration,
        connectionGeneration: 1,
        message: s.currentMessage,
        context: {
          date: s.date,
          history: s.history,
          memory: s.memory,
          referenceSets: s.referenceSets,
          preferences: s.preferences,
          planOccurrences: s.planOccurrences,
        },
        capabilities: ['saveRecipe'],
      };
      return {
        request,
        begun: ready(
          await assistant.beginTurn({ request, expectedConversationRevision: s.contextRevision }),
        ),
      };
    };
    const first = await begin('First completed turn');
    const referenceSetId = randomUUID();
    const displayedRecipeIds: [string, string] = ['53262', '53064'];
    ready(
      await assistant.acceptResponse({
        ...first.begun.acceptanceEnvelope,
        response: {
          apiVersion: '2',
          catalogue: first.request.catalogue,
          requestId: first.request.requestId,
          userIntentId: first.request.userIntentId,
          intentRevision: 0,
          conversationId: first.request.conversationId,
          conversationGeneration: 0,
          connectionGeneration: 1,
          preferenceRevision: 0,
          kind: 'answer',
          text: 'First reply',
          sources: displayedRecipeIds.map((recipeId) => ({ recipeId, section: 'recipe' as const })),
          referenceSets: [
            { referenceSetId, messageId: randomUUID(), recipeIds: displayedRecipeIds },
          ],
          memoryUpdate: {
            baseRevision: 0,
            baseContextRevision: first.request.context.memory.baseContextRevision,
            reviews: [
              { sourceMessageId: first.request.message.messageId, disposition: 'non_memory' },
            ],
            entries: [],
          },
        },
      }),
    );
    const second = await begin('Failed turn');
    ready(
      await assistant.recordTurnFailure({
        userIntentId: second.request.userIntentId,
        expectedIntentRevision: 0,
        error: {
          code: 'network_unavailable',
          messageKey: 'test.network',
          retry: 'after_reconnect',
        },
      }),
    );
    const third = await begin('Interrupted turn');
    const transcriptBefore = ready(await assistant.readConversation());
    const referencesBefore = ready(await assistant.readReferenceSets([referenceSetId]));
    assert.deepEqual(referencesBefore, [
      {
        referenceSetId,
        messageId: first.begun.acceptanceEnvelope.assistantMessageId,
        recipeIds: displayedRecipeIds,
      },
    ]);
    assert.deepEqual(transcriptBefore.messages[1]!.referenceSets, referencesBefore);
    assert.equal(referencesBefore[0]!.recipeIds[1], '53064');
    await f.services.close();
    const result = await f.open();
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') assert.fail();
    const reopened = result.services;
    try {
      assert.equal(ready(await reopened.queries.readInstallationId()), installationId);
      const port = reopened.assistant({ connectionGeneration: generation });
      const transcriptAfter = ready(await port.readConversation());
      assert.equal(transcriptAfter.header.conversationId, transcriptBefore.header.conversationId);
      assert.equal(transcriptAfter.header.generation, transcriptBefore.header.generation);
      assert.deepEqual(
        transcriptAfter.messages.map(({ messageId, sequence, referenceSets }) => ({
          messageId,
          sequence,
          referenceSets,
        })),
        transcriptBefore.messages.map(({ messageId, sequence, referenceSets }) => ({
          messageId,
          sequence,
          referenceSets,
        })),
      );
      assert.deepEqual(ready(await port.readReferenceSets([referenceSetId])), referencesBefore);
      const latest = ready(await port.readIntentPage({ limit: 1 }));
      assert.equal(latest.items[0]!.userIntentId, third.request.userIntentId);
      assert.equal(latest.items[0]!.phase, 'cancelled');
      assert.equal(latest.items[0]!.assistantMessageId, null);
      assert.equal(latest.hasEarlier, true);
      const earlier = ready(
        await port.readIntentPage({ limit: 2, beforeSequence: latest.beforeSequence! }),
      );
      assert.deepEqual(
        earlier.items.map((item) => item.userIntentId),
        [first.request.userIntentId, second.request.userIntentId],
      );
      assert.equal(earlier.hasEarlier, false);
      assert.equal(
        earlier.items[0]!.assistantMessageId,
        first.begun.acceptanceEnvelope.assistantMessageId,
      );
      assert.equal(earlier.items[0]!.phase, 'settled');
      for (const item of [...earlier.items, ...latest.items])
        assert.equal(
          ready(await port.readIntent(item.userIntentId))?.request.message.messageId,
          item.userMessageId,
        );
      assert.equal(
        f.connections[2]!.database.prepare('SELECT count(*) AS n FROM operation_receipt').get()?.n,
        0,
      );
      assert.equal((await port.readIntentPage({ limit: 101 })).kind, 'failed');
      const database = f.connections[2]!.database;
      database
        .prepare("UPDATE message SET role='assistant' WHERE message_id=?")
        .run(first.request.message.messageId);
      assert.equal((await port.readIntentPage()).kind, 'failed');
      database
        .prepare("UPDATE message SET role='user' WHERE message_id=?")
        .run(first.request.message.messageId);
      database
        .prepare('UPDATE message SET text=? WHERE message_id=?')
        .run(JSON.stringify('Corrupt reply'), first.begun.acceptanceEnvelope.assistantMessageId);
      assert.equal((await port.readIntentPage()).kind, 'failed');
      database
        .prepare('UPDATE message SET text=? WHERE message_id=?')
        .run(JSON.stringify('First reply'), first.begun.acceptanceEnvelope.assistantMessageId);
      assert.equal(ready(await port.readIntentPage()).items.length, 3);
      const clear = ready(
        await reopened.commands.prepareDirect(
          ready(await reopened.commands.reviewDirect({ kind: 'clearConversation' })),
        ),
      );
      assert.equal((await reopened.commands.execute(clear)).kind, 'receipt');
      assert.deepEqual(ready(await port.readIntentPage()).items, []);
      assert.equal(ready(await reopened.queries.readInstallationId()), installationId);
      f.connections[2]!.database.exec("DELETE FROM app_metadata WHERE key='installation_id'");
      const changes = f.connections[2]!.database.prepare('SELECT total_changes() AS n').get()?.n;
      assert.equal((await reopened.queries.readInstallationId()).kind, 'failed');
      assert.equal(
        f.connections[2]!.database.prepare('SELECT total_changes() AS n').get()?.n,
        changes,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});
test(
  'public continuation uses fresh store consent after 2-to-1 reopen and replays only the receipt after clear',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    let reopened: CookMateServices | undefined;
    try {
      const turn = await acceptedActionTurn(f.services, () => 2, 'Save this recipe after review');
      const plan = await turn.freeze();
      const slot = ready(
        await turn.assistant.finalizeNextIntentSlot({
          userIntentId: plan.userIntentId,
          expectedIntentRevision: 0,
          slotId: plan.slots[0]!.slotId,
        }),
      ).slot;
      const originalRequest = JSON.stringify(
        ready(await turn.assistant.readIntent(plan.userIntentId))!.request,
      );
      await f.services.close();
      const opened = await f.open();
      assert.equal(opened.kind, 'ready');
      if (opened.kind !== 'ready') assert.fail();
      reopened = opened.services;
      const assistant = reopened.assistant({ connectionGeneration: () => 1 });
      assert.equal(
        ready(await assistant.readIntent(plan.userIntentId))!.intent.phase,
        'reconciling',
      );
      assert.equal((await reopened.commands.execute(slot.command)).kind, 'failed');
      const review = ready(
        await assistant.readActionContinuationReview({
          userIntentId: plan.userIntentId,
          expectedIntentRevision: 0,
        }),
      );
      assert.ok(review);
      assert.equal(review.state.guards.connectionGeneration, 1);
      assert.deepEqual(review.slot, { ...slot, commandState: 'frozen' });
      assert.equal(
        JSON.stringify(ready(await assistant.readIntent(plan.userIntentId))!.request),
        originalRequest,
      );
      assert.equal(Object.isFrozen(review), true);
      assert.equal(ready(await reopened.queries.readFavourites()).length, 0);
      const [first, repeated] = await Promise.all([
        assistant.confirmActionContinuation({ review }),
        assistant.confirmActionContinuation({ review }),
      ]);
      assert.equal(first.kind, 'receipt', JSON.stringify(first));
      assert.deepEqual(repeated, first);
      assert.equal(ready(await reopened.queries.readFavourites()).length, 1);
      const clear = ready(
        await reopened.commands.prepareDirect(
          ready(await reopened.commands.reviewDirect({ kind: 'clearConversation' })),
        ),
      );
      assert.equal((await reopened.commands.execute(clear)).kind, 'receipt');
      const database = f.connections[2]!.database;
      const stale = JSON.parse(JSON.stringify(review)) as typeof review;
      const ancillary = {
        ...stale,
        reviewToken: randomUUID(),
        cursor: 7,
        slot: { ...stale.slot, slotId: randomUUID() },
        prefixReceipts: [],
        catalogue: { version: 'old-review', fingerprint: '0'.repeat(64) },
        state: { ...stale.state, guards: { ...stale.state.guards, connectionGeneration: 999 } },
      };
      const before = database.prepare('SELECT total_changes() AS n').get()?.n;
      assert.deepEqual(await assistant.confirmActionContinuation({ review: ancillary }), first);
      assert.equal(database.prepare('SELECT total_changes() AS n').get()?.n, before);
      assert.equal(
        database
          .prepare('SELECT COUNT(*) AS n FROM pending_intent WHERE user_intent_id=?')
          .get(plan.userIntentId)?.n,
        0,
      );
      assert.equal(assistant.invalidateActionContinuationReview(), undefined);
      await reopened.close();
      await assert.rejects(assistant.confirmActionContinuation({ review }), /closing/);
      await assert.rejects(turn.assistant.confirmActionContinuation({ review }), /closing/);
    } finally {
      await reopened?.close();
      await f.cleanup();
    }
  },
);

test(
  'public dismiss and close revoke an in-flight continuation before commit and leave no effect or receipt',
  { timeout: 20000 },
  async () => {
    for (const revoke of ['dismiss', 'close'] as const) {
      const f = await fixture();
      let reopened: CookMateServices | undefined;
      let release: (() => void) | undefined;
      try {
        const turn = await acceptedActionTurn(f.services, () => 1, 'Save after fresh confirmation');
        const plan = await turn.freeze();
        const slot = ready(
          await turn.assistant.finalizeNextIntentSlot({
            userIntentId: plan.userIntentId,
            expectedIntentRevision: 0,
            slotId: plan.slots[0]!.slotId,
          }),
        ).slot;
        await f.services.close();
        const opened = await f.open();
        assert.equal(opened.kind, 'ready');
        if (opened.kind !== 'ready') assert.fail();
        reopened = opened.services;
        const assistant = reopened.assistant({ connectionGeneration: () => 1 });
        const review = ready(
          await assistant.readActionContinuationReview({
            userIntentId: plan.userIntentId,
            expectedIntentRevision: 0,
          }),
        );
        assert.ok(review);
        let entered!: () => void;
        const writing = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const connection = f.connections[2]!.connection;
        const prepare = connection.prepare;
        connection.prepare = async (sql) => {
          const statement = await prepare(sql);
          return {
            ...statement,
            run: async (values) => {
              await statement.run(values);
              if (sql.startsWith('INSERT INTO operation_receipt')) {
                entered();
                await barrier;
              }
            },
          };
        };
        const confirmation = assistant.confirmActionContinuation({ review });
        await writing;
        const closing = revoke === 'close' ? reopened.close() : undefined;
        if (revoke === 'dismiss')
          assert.equal(assistant.invalidateActionContinuationReview(), undefined);
        release!();
        const result = await confirmation;
        assert.equal(result.kind, 'failed', JSON.stringify(result));
        if (result.kind === 'failed') assert.equal(result.error.code, 'cancelled');
        await closing;
        if (revoke === 'close') {
          const openedAgain = await f.open();
          assert.equal(openedAgain.kind, 'ready');
          if (openedAgain.kind !== 'ready') assert.fail();
          reopened = openedAgain.services;
        }
        assert.equal(ready(await reopened.queries.readFavourites()).length, 0);
        assert.equal(ready(await reopened.queries.readReceipt(slot.command.operationId)), null);
        const port =
          revoke === 'close' ? reopened.assistant({ connectionGeneration: () => 1 }) : assistant;
        const saved = ready(await port.readIntent(plan.userIntentId))!;
        assert.equal(saved.intent.phase, 'reconciling');
        assert.equal(saved.slotResults[0]?.result.kind, 'failed');
        assert.equal((await port.confirmActionContinuation({ review })).kind, 'failed');
      } finally {
        release?.();
        await reopened?.close();
        await f.cleanup();
      }
    }
  },
);

async function fixture(
  flags: {
    enablePortableRestore?: boolean;
    enableCooking?: boolean;
    enablePersonal?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-'));
  const path = join(directory, 'store.db');
  const connections: ReturnType<typeof desktopConnection>[] = [];
  const open = () =>
    createLocalStore({
      ...flags,
      platform,
      now: () => '2026-09-28T00:00:00.000Z',
      dateContext: () => ({
        localDate: '2026-09-28',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      openConnection: async () => {
        const item = desktopConnection(path);
        connections.push(item);
        return item.connection;
      },
    });
  const initial = await open();
  assert.equal(initial.kind, 'ready');
  if (initial.kind !== 'ready') assert.fail();
  const services = initial.services;
  const action = async (input: DirectActionInput) => {
    const review = ready(await services.commands.reviewDirect(input));
    const command = ready(await services.commands.prepareDirect(review));
    const result = await services.commands.execute(command);
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    return { review, command, result };
  };
  return {
    services,
    action,
    connections,
    open,
    cleanup: async () => {
      await services.close();
      await removeFixtureDirectory(directory);
    },
  };
}

test('direct recovery verifies frozen command fingerprints before describing or dismissing notices', async () => {
  const f = await fixture();
  try {
    const done = await f.action({ kind: 'setFavourite', recipeId: '53064', saved: true });
    const altered = {
      ...done.command,
      command: { kind: 'clearPreferences' as const, expectedPreferenceRevision: 0 },
    };
    const database = f.connections[0]!.database;
    const row = database
      .prepare('SELECT intent_json FROM pending_intent WHERE user_intent_id=?')
      .get(done.command.userIntentId)!;
    const intent = JSON.parse(row.intent_json as string);
    intent.slots[0].command = altered;
    database
      .prepare('UPDATE command_slot SET command_json=? WHERE operation_id=?')
      .run(JSON.stringify(altered), done.command.operationId);
    database
      .prepare('UPDATE pending_intent SET intent_json=? WHERE user_intent_id=?')
      .run(JSON.stringify(intent), done.command.userIntentId);
    const changes = database.prepare('SELECT total_changes() AS n').get()?.n;
    assert.equal((await f.services.queries.readDirectRecovery()).kind, 'failed');
    assert.equal(
      (await f.services.commands.acknowledgeDirectRecovery(done.command.operationId)).kind,
      'failed',
    );
    assert.equal(database.prepare('SELECT total_changes() AS n').get()?.n, changes);
    assert.equal(database.prepare('SELECT count(*) AS n FROM direct_command_recovery').get()?.n, 1);
    assert.deepEqual(
      ready(await f.services.queries.readFavourites()).map((item) => item.recipeId),
      ['53064'],
    );
  } finally {
    await f.cleanup();
  }
});

test('core factory uses two isolated connections, read-only review, frozen commands and receipt retry across reopen', async () => {
  const f = await fixture();
  try {
    assert.equal(f.connections.length, 2);
    assert.equal(f.connections[1]!.database.prepare('PRAGMA query_only').get()?.query_only, 1);
    const changesBefore = f.connections[0]!.database.prepare('SELECT total_changes() AS n').get()
      ?.n;
    const review = ready(
      await f.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '53064',
        saved: true,
      }),
    );
    assert.equal(
      f.connections[0]!.database.prepare('SELECT total_changes() AS n').get()?.n,
      changesBefore,
    );
    const command = ready(await f.services.commands.prepareDirect(review));
    assert.equal(Object.isFrozen(command.command), true);
    assert.equal(command.schemaVersion, 2);
    const events: unknown[] = [];
    f.services.queries.subscribe((event) => events.push(event));
    const result = await f.services.commands.execute(command);
    assert.equal(result.kind, 'receipt');
    assert.equal(ready(await f.services.queries.readFavourites()).length, 1);
    assert.deepEqual(await f.services.commands.execute(command), result);
    assert.equal(events.length, 1);
    const a = f.services.close();
    const b = f.services.close();
    assert.equal(a, b);
    await a;
    assert.equal((await f.services.queries.readFavourites()).kind, 'failed');
    assert.equal((await f.services.commands.execute(command)).kind, 'failed');
    const reopened = await f.open();
    assert.equal(reopened.kind, 'ready');
    if (reopened.kind !== 'ready') assert.fail();
    try {
      assert.deepEqual(await reopened.services.commands.execute(command), result);
      assert.equal(ready(await reopened.services.queries.readFavourites()).length, 1);
    } finally {
      await reopened.services.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('direct review resolves destination identity and selection consequences; intervening changes reject guarded edit', async () => {
  const f = await fixture();
  try {
    const first = await f.action({
      kind: 'placeRecipe',
      recipeId: '53064',
      placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
    });
    assert.equal(first.review.payload.kind, 'addPlan');
    const occurrence = ready(await f.services.queries.readPlan('2026-09-28', '2026-09-28'))
      .occurrences[0]!;
    const replace = ready(
      await f.services.commands.reviewDirect({
        kind: 'placeRecipe',
        recipeId: '53262',
        placement: occurrence.placement,
      }),
    );
    assert.equal(replace.payload.kind, 'replacePlanRecipe');
    if (replace.payload.kind === 'replacePlanRecipe')
      assert.equal(replace.payload.occurrenceId, occurrence.occurrenceId);
    const edit = ready(
      await f.services.commands.reviewDirect({
        kind: 'placeRecipe',
        occurrenceId: occurrence.occurrenceId,
        recipeId: '53262',
        placement: { actualDate: '2026-09-29', mealKey: 'lunch' },
      }),
    );
    assert.equal(edit.payload.kind, 'editPlan');
    const command = ready(await f.services.commands.prepareDirect(edit));
    await f.action({ kind: 'setShoppingSelection', occurrenceIds: [occurrence.occurrenceId] });
    const stale = await f.services.commands.execute(command);
    assert.equal(stale.kind, 'failed');
    if (stale.kind === 'failed') assert.equal(stale.error.code, 'stale_context');
    const next = ready(
      await f.services.commands.reviewDirect({
        kind: 'placeRecipe',
        occurrenceId: occurrence.occurrenceId,
        recipeId: '53262',
        placement: { actualDate: '2026-09-29', mealKey: 'lunch' },
      }),
    );
    assert.equal(next.consequences.kind, 'plan');
    if (next.consequences.kind === 'plan') assert.equal(next.consequences.resultSelected, true);
  } finally {
    await f.cleanup();
  }
});

test('full SQLite page budget rolls back shopping changes and permits receipt-safe deliberate retry after reopen', async (t) => {
  const f = await fixture();
  const database = f.connections[0]!.database;
  let reopenedServices: CookMateServices | undefined;
  const cookingState = async (services: CookMateServices) => ({
    plan: ready(await services.queries.readPlan('2026-09-28', '2026-10-04')),
    shopping: ready(await services.queries.readShopping()),
  });
  try {
    for (const actualDate of [
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]) {
      await f.action({
        kind: 'placeRecipe',
        recipeId: '53064',
        placement: { actualDate, mealKey: 'dinner' },
      });
    }
    const plan = ready(await f.services.queries.readPlan('2026-09-28', '2026-10-04'));
    assert.equal(plan.occurrences.length, 7);
    await f.action({
      kind: 'setShoppingSelection',
      occurrenceIds: [plan.occurrences[0]!.occurrenceId],
    });
    const selected = ready(await f.services.queries.readShopping());
    assert.ok(selected.groups.length > 0);
    await f.action({
      kind: 'setPurchased',
      groupKey: selected.groups[0]!.groupKey,
      purchased: true,
    });
    const before = await cookingState(f.services);
    assert.equal(before.shopping.status, 'current');
    assert.equal(before.shopping.scope.occurrenceIds.length, 1);
    assert.ok(before.shopping.groups.some((group) => group.purchased));
    const input: DirectActionInput = {
      kind: 'setShoppingSelection',
      occurrenceIds: plan.occurrences.map((item) => item.occurrenceId),
    };
    const command = ready(
      await f.services.commands.prepareDirect(ready(await f.services.commands.reviewDirect(input))),
    );
    const receiptsBefore = database
      .prepare('SELECT * FROM operation_receipt ORDER BY operation_id')
      .all();
    // Forbid growth only after preparation; changing the schema would invalidate recovery guards.
    const pageSize = Number(database.prepare('PRAGMA page_size').get()!.page_size);
    const pageCount = Number(database.prepare('PRAGMA page_count').get()!.page_count);
    assert.equal(database.prepare('PRAGMA freelist_count').get()!.freelist_count, 0);
    assert.ok(pageCount * pageSize < 8 * 1024 * 1024, 'fixture must remain below 8 MiB');
    assert.equal(
      database.prepare(`PRAGMA max_page_count=${pageCount}`).get()!.max_page_count,
      pageCount,
    );

    const engineErrors: { sql: string; code: unknown; errcode: unknown; errstr: unknown }[] = [];
    const connection = f.connections[0]!.connection;
    const prepare = connection.prepare;
    connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        run: async (values) => {
          try {
            await statement.run(values);
          } catch (error) {
            const detail = error as { code?: unknown; errcode?: unknown; errstr?: unknown };
            engineErrors.push({
              sql,
              code: detail.code,
              errcode: detail.errcode,
              errstr: detail.errstr,
            });
            throw error;
          }
        },
        finalize: () => statement.finalize(),
      };
    };
    const events: StoreChange[] = [];
    f.services.queries.subscribe((event) => events.push(event));
    const failed = await f.services.commands.execute(command);
    assert.deepEqual(failed, {
      kind: 'failed',
      operationId: command.operationId,
      error: { code: 'storage_failure', messageKey: 'storage.command_failed', retry: 'reconcile' },
    });
    assert.equal(engineErrors.length, 1);
    assert.equal(engineErrors[0]!.code, 'ERR_SQLITE_ERROR');
    assert.equal(engineErrors[0]!.errcode, 13, 'the actual engine must report SQLITE_FULL');
    assert.equal(engineErrors[0]!.errstr, 'database or disk is full');
    assert.match(engineErrors[0]!.sql, /INSERT INTO shopping_contribution/);
    assert.equal(events.length, 0);
    assert.equal(ready(await f.services.queries.readReceipt(command.operationId)), null);
    assert.deepEqual(await cookingState(f.services), before);
    assert.deepEqual(
      database.prepare('SELECT * FROM operation_receipt ORDER BY operation_id').all(),
      receiptsBefore,
    );
    assert.equal(database.prepare('PRAGMA page_count').get()!.page_count, pageCount);

    // Restore a bounded budget and reopen: SQLite may have auto-rolled back the full transaction.
    const restoredPageBudget = pageCount + 256;
    assert.ok(restoredPageBudget * pageSize < 8 * 1024 * 1024);
    assert.equal(
      database.prepare(`PRAGMA max_page_count=${restoredPageBudget}`).get()!.max_page_count,
      restoredPageBudget,
    );
    await f.services.close();
    const reopened = await f.open();
    assert.equal(reopened.kind, 'ready');
    if (reopened.kind !== 'ready') assert.fail();
    reopenedServices = reopened.services;
    assert.deepEqual(await cookingState(reopenedServices), before);
    assert.equal(ready(await reopenedServices.queries.readReceipt(command.operationId)), null);
    const recovery = ready(await reopenedServices.queries.readDirectRecovery()).entries.find(
      (entry) => entry.operationId === command.operationId,
    );
    assert.equal(recovery?.outcome, 'not_executed');
    assert.equal(recovery?.receipt, null);
    assert.equal((await reopenedServices.commands.execute(command)).kind, 'failed');
    assert.deepEqual(await cookingState(reopenedServices), before);

    const retried = ready(
      await reopenedServices.commands.prepareDirect(
        ready(await reopenedServices.commands.reviewDirect(input)),
      ),
    );
    assert.notEqual(retried.operationId, command.operationId);
    const retryEvents: StoreChange[] = [];
    reopenedServices.queries.subscribe((event) => retryEvents.push(event));
    const result = await reopenedServices.commands.execute(retried);
    assert.equal(result.kind, 'receipt', JSON.stringify(result));
    if (result.kind !== 'receipt') assert.fail();
    assert.equal(result.receipt.outcome, 'committed');
    const afterRetry = await cookingState(reopenedServices);
    assert.deepEqual(afterRetry.plan.occurrences, before.plan.occurrences);
    assert.deepEqual(afterRetry.plan.shoppingScope, afterRetry.shopping.scope);
    assert.deepEqual(afterRetry.shopping.scope.occurrenceIds, [...input.occurrenceIds].sort());
    assert.equal(afterRetry.shopping.status, 'current');
    assert.equal(retryEvents.length, 1);
    assert.deepEqual(await reopenedServices.commands.execute(retried), result);
    assert.equal(retryEvents.length, 1, 'receipt replay must not emit another mutation');
    assert.deepEqual(await cookingState(reopenedServices), afterRetry);
    assert.deepEqual(
      ready(await reopenedServices.queries.readReceipt(retried.operationId)),
      result.receipt,
    );
    assert.equal(ready(await reopenedServices.queries.readReceipt(command.operationId)), null);
    t.diagnostic(
      JSON.stringify({
        pageSize,
        pageCount,
        restoredPageBudget,
        engineErrors,
        failed,
        failedCommandEvents: events.length,
        retryEvents: retryEvents.length,
        priorSelected: before.shopping.scope.occurrenceIds.length,
        restoredSelected: afterRetry.shopping.scope.occurrenceIds.length,
      }),
    );
  } finally {
    await reopenedServices?.close();
    await f.cleanup();
  }
});

test('factory rejects incompatible persisted database without clearing it and closes failed-start ownership', async () => {
  const f = await fixture();
  try {
    await f.action({ kind: 'setFavourite', recipeId: '53064', saved: true });
    f.connections[0]!.database.exec('PRAGMA user_version=1');
    await f.services.close();
    const opened = await f.open();
    assert.equal(opened.kind, 'failed');
    if (opened.kind === 'failed') assert.equal(opened.error.code, 'incompatible_version');
    const failedConnection = f.connections.at(-1)!;
    assert.throws(() => failedConnection.database.prepare('SELECT 1'));
  } finally {
    await f.cleanup();
  }
});

for (const failure of ['synchronous', 'asynchronous'] as const) {
  test(`store cleanup returns a terminal sanitized failure after ${failure} raw close failure`, async () => {
    const storage = desktopConnection();
    const close = storage.connection.close;
    let attempts = 0;
    storage.connection.exec = async () => {
      throw new StorageFault('incompatible_version', 'private startup detail');
    };
    storage.connection.close = () => {
      attempts++;
      const error = new Error('private cleanup detail');
      if (failure === 'synchronous') throw error;
      return Promise.reject(error);
    };
    try {
      const opened = await createLocalStore({
        openConnection: async () => storage.connection,
        platform,
        now: () => '2026-09-29T00:00:00.000Z',
        dateContext: () => ({
          localDate: '2026-09-29',
          timeZone: 'Asia/Dubai',
          utcOffsetMinutes: 240,
        }),
      });
      assert.deepEqual(opened, {
        kind: 'failed',
        error: { code: 'storage_failure', messageKey: 'storage.cleanup_failed', retry: 'never' },
      });
      assert.equal(attempts, 1);
    } finally {
      await close();
    }
  });
}

test('store cleanup awaits all owned handles when a raw read close throws', async () => {
  const write = desktopConnection();
  const read = desktopConnection();
  const closeWrite = write.connection.close;
  const closeRead = read.connection.close;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let writeClosed: Promise<void> | undefined;
  const attempts = { read: 0, write: 0 };
  read.connection.exec = async () => {
    throw new Error('reader configuration failed');
  };
  read.connection.close = () => {
    attempts.read++;
    throw new Error('private read cleanup detail');
  };
  write.connection.close = () => {
    attempts.write++;
    started();
    writeClosed = gate.then(closeWrite);
    return writeClosed;
  };
  let settled = false;
  const outcome = createLocalStore({
    openConnection: async (mode) => (mode === 'write' ? write.connection : read.connection),
    platform,
    now: () => '2026-09-29T00:00:00.000Z',
    dateContext: () => ({ localDate: '2026-09-29', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
  }).then(
    (value) => {
      settled = true;
      return { kind: 'resolved' as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { kind: 'rejected' as const, error };
    },
  );
  try {
    await closing;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'the opener must await the remaining owned close');
    assert.deepEqual(attempts, { read: 1, write: 1 });
    release();
    assert.deepEqual(await outcome, {
      kind: 'resolved',
      value: {
        kind: 'failed',
        error: { code: 'storage_failure', messageKey: 'storage.cleanup_failed', retry: 'never' },
      },
    });
    assert.throws(() => write.database.prepare('SELECT 1'));
    assert.deepEqual(attempts, { read: 1, write: 1 });
  } finally {
    release();
    await outcome;
    await Promise.allSettled([writeClosed, closeRead()]);
  }
});

test('store cleanup preserves startup errors after successful release and permits a fresh open', async () => {
  for (const code of ['incompatible_version', 'migration_failure'] as const) {
    const storage = desktopConnection();
    const close = storage.connection.close;
    let attempts = 0;
    storage.connection.exec = async () => {
      throw new StorageFault(code, 'private original startup detail');
    };
    storage.connection.close = async () => {
      attempts++;
      await close();
    };
    const opened = await createLocalStore({
      openConnection: async () => storage.connection,
      platform,
      now: () => '2026-09-29T00:00:00.000Z',
      dateContext: () => ({
        localDate: '2026-09-29',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
    });
    assert.deepEqual(opened, {
      kind: 'failed',
      error: { code, messageKey: 'storage.open_failed', retry: 'after_correction' },
    });
    assert.equal(attempts, 1);
    assert.throws(() => storage.database.prepare('SELECT 1'));
  }
  const f = await fixture();
  try {
    assert.deepEqual(ready(await f.services.queries.readFavourites()), []);
  } finally {
    await f.cleanup();
  }
});

test('store cleanup closes a duplicated connection only once', async () => {
  const storage = desktopConnection();
  const close = storage.connection.close;
  let attempts = 0;
  storage.connection.close = async () => {
    attempts++;
    await close();
  };
  const opened = await createLocalStore({
    openConnection: async () => storage.connection,
    platform,
    now: () => '2026-09-29T00:00:00.000Z',
    dateContext: () => ({ localDate: '2026-09-29', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
  });
  assert.deepEqual(opened, {
    kind: 'failed',
    error: {
      code: 'storage_failure',
      messageKey: 'storage.open_failed',
      retry: 'after_correction',
    },
  });
  assert.equal(attempts, 1);
  assert.throws(() => storage.database.prepare('SELECT 1'));
});

test('store cleanup ready close attempts both handles once and retains its rejected barrier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-repository-'));
  const connections: ReturnType<typeof desktopConnection>[] = [];
  const attempts = { read: 0, write: 0 };
  const failure = new Error('private ready read cleanup detail');
  try {
    const opened = await createLocalStore({
      openConnection: async (mode) => {
        const storage = desktopConnection(join(directory, 'store.db'));
        connections.push(storage);
        const close = storage.connection.close;
        storage.connection.close = () => {
          attempts[mode]++;
          if (mode === 'read') throw failure;
          return close();
        };
        return storage.connection;
      },
      platform,
      now: () => '2026-09-29T00:00:00.000Z',
      dateContext: () => ({
        localDate: '2026-09-29',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
    });
    assert.equal(opened.kind, 'ready');
    if (opened.kind !== 'ready') assert.fail();
    const first = opened.services.close();
    assert.equal(opened.services.close(), first);
    await assert.rejects(first, (error: unknown) => error === failure);
    assert.equal(opened.services.close(), first);
    assert.deepEqual(attempts, { read: 1, write: 1 });
    assert.throws(() => connections[0]!.database.prepare('SELECT 1'));
    assert.equal((await opened.services.queries.readFavourites()).kind, 'failed');
  } finally {
    for (const storage of connections) {
      try {
        storage.database.close();
      } catch {
        /* Already closed by the owner. */
      }
    }
    await removeFixtureDirectory(directory);
  }
});

test('close waits for an in-flight command before releasing either connection', async () => {
  const f = await fixture();
  try {
    const review = ready(
      await f.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '53064',
        saved: true,
      }),
    );
    const command = ready(await f.services.commands.prepareDirect(review));
    const execution = f.services.commands.execute(command);
    const closing = f.services.close();
    assert.equal((await execution).kind, 'receipt');
    await closing;
    assert.throws(() => f.connections[0]!.database.prepare('SELECT 1'));
    assert.throws(() => f.connections[1]!.database.prepare('SELECT 1'));
  } finally {
    await f.cleanup();
  }
});

test('full selection review guards named meal edits through preparation and execution; exact receipt retry remains historical', async () => {
  for (const change of ['recipe', 'date', 'remove_readd'] as const) {
    const f = await fixture();
    try {
      await f.action({
        kind: 'placeRecipe',
        recipeId: '53064',
        placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
      });
      const occurrence = ready(await f.services.queries.readPlan('2026-09-28', '2026-09-28'))
        .occurrences[0]!;
      const review = ready(
        await f.services.commands.reviewDirect({
          kind: 'setShoppingSelection',
          occurrenceIds: [occurrence.occurrenceId],
        }),
      );
      assert.equal(review.consequences.kind, 'shopping_selection');
      if (review.consequences.kind === 'shopping_selection')
        assert.equal(review.consequences.afterOccurrences[0]!.recipeId, '53064');
      const command = ready(await f.services.commands.prepareDirect(review));
      if (change === 'remove_readd') {
        await f.action({ kind: 'removePlan', occurrenceId: occurrence.occurrenceId });
        await f.action({ kind: 'placeRecipe', recipeId: '53064', placement: occurrence.placement });
      } else
        await f.action({
          kind: 'placeRecipe',
          occurrenceId: occurrence.occurrenceId,
          recipeId: change === 'recipe' ? '53262' : '53064',
          placement:
            change === 'date'
              ? { actualDate: '2026-09-29', mealKey: 'lunch' }
              : occurrence.placement,
        });
      const prepareStale = await f.services.commands.prepareDirect(review);
      assert.equal(prepareStale.kind, 'failed');
      if (prepareStale.kind === 'failed') assert.equal(prepareStale.error.code, 'stale_context');
      const result = await f.services.commands.execute(command);
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.error.code, 'stale_context');
      assert.equal(ready(await f.services.queries.readShopping()).scope.occurrenceIds.length, 0);
      const current = ready(await f.services.queries.readPlan('2026-09-28', '2026-09-29'))
        .occurrences[0]!;
      const done = await f.action({
        kind: 'setShoppingSelection',
        occurrenceIds: [current.occurrenceId],
      });
      await f.action({
        kind: 'placeRecipe',
        occurrenceId: current.occurrenceId,
        recipeId: '53320',
        placement: current.placement,
      });
      assert.deepEqual(await f.services.commands.execute(done.command), done.result);
      const invalid = structuredClone(review) as unknown as Record<string, unknown>;
      delete invalid.guard;
      assert.equal(
        (await f.services.commands.prepareDirect(invalid as unknown as typeof review)).kind,
        'failed',
      );
      assert.equal(
        (await f.services.commands.prepareDirect({ ...review, guard: { kind: 'none' } })).kind,
        'failed',
      );
    } finally {
      await f.cleanup();
    }
  }
});

test('subscriber mutation cannot corrupt other notifications and a supplied empty edit ID is rejected', async () => {
  const f = await fixture();
  try {
    const events: unknown[] = [];
    f.services.queries.subscribe((event) => {
      event.revision = 999;
    });
    f.services.queries.subscribe((event) => {
      Object.assign(event.collections, { 0: 'plan' });
    });
    f.services.queries.subscribe((event) => events.push(event));
    await f.action({ kind: 'setFavourite', recipeId: '53064', saved: true });
    assert.deepEqual(events, [{ revision: 1, collections: ['favourites'] }]);
    const review = await f.services.commands.reviewDirect({
      kind: 'placeRecipe',
      occurrenceId: '',
      recipeId: '53064',
      placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
    });
    assert.equal(review.kind, 'failed');
    if (review.kind === 'failed') assert.equal(review.error.code, 'invalid_input');
  } finally {
    await f.cleanup();
  }
});

test('direct recovery persists identities before dispatch and proves receipts or cancelled no-effect after reopen without replay', async () => {
  const f = await fixture();
  try {
    const review = ready(
      await f.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '53064',
        saved: true,
      }),
    );
    const pending = ready(await f.services.commands.prepareDirect(review));
    const before = ready(await f.services.queries.readDirectRecovery());
    assert.equal(before.entries.length, 1);
    assert.equal(before.entries[0]!.operationId, pending.operationId);
    assert.equal(before.entries[0]!.outcome, 'unresolved');
    assert.equal(
      (await f.services.commands.acknowledgeDirectRecovery(pending.operationId)).kind,
      'failed',
    );
    const done = await f.action({ kind: 'setFavourite', recipeId: '53262', saved: true });
    await f.services.close();
    const reopened = await f.open();
    assert.equal(reopened.kind, 'ready');
    if (reopened.kind !== 'ready') assert.fail();
    try {
      const page = ready(await reopened.services.queries.readDirectRecovery({ limit: 1 }));
      assert.equal(page.entries[0]!.operationId, pending.operationId);
      assert.equal(page.entries[0]!.outcome, 'not_executed');
      assert.ok(page.nextAfterSequence);
      const second = ready(
        await reopened.services.queries.readDirectRecovery({
          afterSequence: page.nextAfterSequence!,
          limit: 1,
        }),
      );
      assert.equal(second.entries[0]!.operationId, done.command.operationId);
      assert.equal(second.entries[0]!.outcome, 'receipt');
      if (done.result.kind === 'receipt')
        assert.deepEqual(second.entries[0]!.receipt, done.result.receipt);
      assert.deepEqual(
        ready(await reopened.services.queries.readFavourites()).map((item) => item.recipeId),
        ['53262'],
      );
      ready(await reopened.services.commands.acknowledgeDirectRecovery(pending.operationId));
      ready(await reopened.services.commands.acknowledgeDirectRecovery(done.command.operationId));
      ready(await reopened.services.commands.acknowledgeDirectRecovery(done.command.operationId));
      assert.deepEqual(ready(await reopened.services.queries.readDirectRecovery()).entries, []);
      assert.deepEqual(await reopened.services.commands.execute(done.command), done.result);
      assert.equal((await reopened.services.commands.execute(pending)).kind, 'failed');
    } finally {
      await reopened.services.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('recovery waits behind live writer and never turns unavailable storage into empty or not-executed success', async () => {
  const f = await fixture();
  try {
    const review = ready(
      await f.services.commands.reviewDirect({
        kind: 'setFavourite',
        recipeId: '53064',
        saved: true,
      }),
    );
    const command = ready(await f.services.commands.prepareDirect(review));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.connections[0]!.connection.prepare;
    f.connections[0]!.connection.prepare = async (sql) => {
      const statement = await original(sql);
      return {
        ...statement,
        run: async (values) => {
          await statement.run(values);
          if (sql.startsWith('INSERT INTO operation_receipt')) {
            entered();
            await gate;
          }
        },
      };
    };
    const execute = f.services.commands.execute(command);
    await writing;
    let completed = false;
    const recovery = f.services.queries.readDirectRecovery().then((value) => {
      completed = true;
      return value;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    release();
    assert.equal((await execute).kind, 'receipt');
    assert.equal(ready(await recovery).entries[0]!.outcome, 'receipt');
    f.connections[0]!.database.exec('PRAGMA foreign_keys=OFF');
    assert.equal((await f.services.queries.readDirectRecovery()).kind, 'failed');
    assert.equal(
      (await f.services.commands.acknowledgeDirectRecovery(command.operationId)).kind,
      'failed',
    );
    f.connections[0]!.database.exec('PRAGMA foreign_keys=ON');
    assert.equal(ready(await f.services.queries.readDirectRecovery()).entries.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('full assistant binds one live runtime to the same store and honors close without exposing native handles', async () => {
  const f = await fixture();
  try {
    let generation = 1;
    const connectionGeneration = () => generation;
    const assistant = f.services.assistant({ connectionGeneration });
    assert.equal(f.services.assistant({ connectionGeneration }), assistant);
    assert.throws(() => f.services.assistant({ connectionGeneration: () => generation }));
    const context = await assistant.readContext({
      text: 'Find Alfredo',
      messageId: randomUUID(),
      selection: {},
    });
    assert.equal(context.kind, 'ready');
    if (context.kind !== 'ready') assert.fail();
    const snapshot = JSON.parse(JSON.stringify(context.value));
    const request: AssistantTurnRequest = {
      apiVersion: '2',
      catalogue: f.services.queries.catalogue,
      requestId: randomUUID(),
      userIntentId: randomUUID(),
      intentRevision: 0,
      conversationId: snapshot.conversationId,
      conversationGeneration: snapshot.conversationGeneration,
      connectionGeneration: generation,
      message: snapshot.currentMessage,
      context: {
        date: snapshot.date,
        history: snapshot.history,
        memory: snapshot.memory,
        referenceSets: snapshot.referenceSets,
        preferences: snapshot.preferences,
        planOccurrences: snapshot.planOccurrences,
      },
      capabilities: ['saveRecipe'],
    };
    const begun = ready(
      await assistant.beginTurn({
        request,
        expectedConversationRevision: snapshot.contextRevision,
      }),
    );
    const accepted = ready(
      await assistant.acceptResponse({
        response: {
          apiVersion: '2',
          catalogue: request.catalogue,
          requestId: request.requestId,
          userIntentId: request.userIntentId,
          intentRevision: 0,
          conversationId: request.conversationId,
          conversationGeneration: request.conversationGeneration,
          connectionGeneration: generation,
          preferenceRevision: 0,
          kind: 'answer',
          text: 'Here is the recipe.',
          sources: [],
          referenceSets: [],
          memoryUpdate: {
            baseRevision: 0,
            baseContextRevision: snapshot.contextRevision,
            reviews: [{ sourceMessageId: request.message.messageId, disposition: 'non_memory' }],
            entries: [],
          },
        },
        ...begun.acceptanceEnvelope,
      }),
    );
    assert.equal(accepted.replay, false);
    assert.equal(ready(await assistant.readConversation()).messages.length, 2);
    generation++;
    assert.equal(
      ready(await assistant.readAcceptance(request.userIntentId))?.acceptanceEnvelope
        .assistantMessageId,
      begun.acceptanceEnvelope.assistantMessageId,
    );
    await f.services.close();
    assert.equal((await assistant.readConversation()).kind, 'failed');
    assert.equal((await assistant.readIntent(request.userIntentId)).kind, 'failed');
    assert.throws(() => f.services.assistant({ connectionGeneration }));
    await assert.rejects(
      assistant.executeIntentSlot({
        userIntentId: request.userIntentId,
        expectedIntentRevision: 0,
        slotId: randomUUID(),
      }),
      /closing/,
    );
  } finally {
    await f.cleanup();
  }
});
