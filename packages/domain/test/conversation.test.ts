import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  PendingIntent,
  MemoryUpdate,
} from '@cookmate/contracts';
import type { ConversationContextSnapshot } from '../src/index';
import type { StoreChange } from '../src/services';
import { createAssistantTurnRepository } from '../../../apps/mobile/src/data/assistantTurnRepository';
import { createConversationRepository } from '../../../apps/mobile/src/data/conversationRepository';
import { createAssistantContextRepository } from '../../../apps/mobile/src/data/assistantContextRepository';
import { recoverInterruptedAssistantWork } from '../../../apps/mobile/src/data/assistantRecovery';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

async function fixture() {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  let writer = new SerializedWriter(storage.connection);
  const identifiers = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    identifiers,
  );
  // One in-memory connection is used strictly serially by this desktop-only fixture.
  const reader = new SerializedReader(storage.connection);
  const events: StoreChange[] = [];
  let readerUnavailable = false;
  const readTransaction = reader.transaction.bind(reader);
  reader.transaction = (work) =>
    readerUnavailable ? Promise.reject(new Error('reader unavailable')) : readTransaction(work);
  let connectionGeneration = 1;
  let currentDate = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  const turns = createAssistantTurnRepository({
    reader,
    writer: {
      transaction: (work, impact, admission) => writer.transaction(work, impact, admission),
    },
    catalogue: catalogueBoundary,
    platform: {
      newId: randomUUID,
      sha256: async (text) => createHash('sha256').update(text).digest('hex'),
    },
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => currentDate,
    connectionGeneration: () => connectionGeneration,
    onCommitted: (change) => events.push(change),
  });
  const contexts = createAssistantContextRepository({
    reader,
    writer,
    catalogue: catalogueBoundary,
    dateContext: () => currentDate,
    onCommitted: () => undefined,
  });
  const request = async (): Promise<AssistantTurnRequest> => {
    const result = await contexts.readContext({
      text: 'Find Alfredo',
      messageId: randomUUID(),
      selection: {},
    });
    if (result.kind !== 'ready') assert.fail(JSON.stringify(result));
    const context = JSON.parse(JSON.stringify(result.value)) as ConversationContextSnapshot;
    return {
      apiVersion: '2',
      catalogue: { ...catalogue.identity },
      requestId: randomUUID(),
      userIntentId: randomUUID(),
      intentRevision: 0,
      conversationId: identifiers.conversationId,
      conversationGeneration: 0,
      connectionGeneration,
      message: context.currentMessage,
      context: {
        history: context.history,
        memory: context.memory,
        referenceSets: context.referenceSets,
        preferences: context.preferences,
        planOccurrences: context.planOccurrences,
        date: context.date,
      },
      capabilities: ['saveRecipe', 'addPlan', 'savePreference'],
    };
  };
  return {
    ...storage,
    get writer() {
      return writer;
    },
    recoverWriter: () => {
      writer = new SerializedWriter(storage.connection);
    },
    events,
    readerAvailable: (available: boolean) => {
      readerUnavailable = !available;
    },
    reader,
    identifiers,
    turns,
    request,
    assistantId: (request: AssistantTurnRequest) =>
      String(
        storage.database
          .prepare(
            'SELECT assistant_message_id AS id FROM assistant_acceptance_envelope WHERE user_intent_id=?',
          )
          .get(request.userIntentId)?.id ?? randomUUID(),
      ),
    changeConnection: () => {
      connectionGeneration++;
    },
    changeDate: () => {
      currentDate = { ...currentDate, localDate: '2026-09-29' };
    },
    repository: createConversationRepository(reader, catalogueBoundary),
  };
}

test('transcript pagination preserves display order and old references outside the current page', async () => {
  const f = await fixture();
  try {
    const messages = Array.from({ length: 65 }, () => randomUUID());
    messages.forEach((id, index) =>
      f.database
        .prepare('INSERT INTO message VALUES (?, ?, 0, ?, ?, ?, ?, ?)')
        .run(
          id,
          f.identifiers.conversationId,
          index,
          index % 2 ? 'assistant' : 'user',
          JSON.stringify(`message ${index}`),
          'complete',
          '2026-09-28T00:00:00.000Z',
        ),
    );
    f.database.exec('UPDATE conversation SET next_sequence = 65');
    const references = [randomUUID(), randomUUID()];
    references.forEach((id, index) => {
      f.database.prepare('INSERT INTO reference_set VALUES (?, ?, ?)').run(id, messages[1]!, index);
      ['53064', '53262'].forEach((recipe, position) =>
        f.database.prepare('INSERT INTO reference_item VALUES (?, ?, ?)').run(id, position, recipe),
      );
    });
    const newest = await f.repository.readConversation();
    assert.equal(newest.kind, 'ready');
    if (newest.kind !== 'ready') return;
    assert.equal(newest.value.messages.length, 30);
    assert.equal(newest.value.messages[0]!.sequence, 35);
    assert.equal(newest.value.beforeSequence, 35);
    assert.equal(newest.value.hasEarlier, true);
    const middle = await f.repository.readConversation({
      beforeSequence: newest.value.beforeSequence!,
    });
    assert.equal(middle.kind, 'ready');
    if (middle.kind !== 'ready') return;
    const oldest = await f.repository.readConversation({
      beforeSequence: middle.value.beforeSequence!,
    });
    assert.equal(oldest.kind, 'ready');
    if (oldest.kind !== 'ready') return;
    assert.deepEqual(
      oldest.value.messages.map((item) => item.sequence),
      [0, 1, 2, 3, 4],
    );
    assert.equal(oldest.value.hasEarlier, false);
    assert.equal(oldest.value.beforeSequence, null);
    assert.deepEqual(
      oldest.value.messages[1]!.referenceSets.map((item) => item.referenceSetId),
      references,
    );
    assert.deepEqual(oldest.value.messages[1]!.referenceSets[0]!.recipeIds, ['53064', '53262']);
    const explicitlySelected = await f.repository.readReferenceSets([references[1]!]);
    assert.equal(explicitlySelected.kind, 'ready');
    if (explicitlySelected.kind === 'ready') {
      assert.equal(explicitlySelected.value[0]!.referenceSetId, references[1]);
      assert.equal(Object.isFrozen(explicitlySelected.value[0]!.recipeIds), true);
    }
    f.database.exec('UPDATE conversation SET generation = 1, next_sequence = 0');
    const stale = await f.repository.readReferenceSets(references);
    assert.equal(stale.kind, 'ready');
    if (stale.kind === 'ready') assert.deepEqual(stale.value, []);
  } finally {
    await f.writer.close();
  }
});

function answer(request: AssistantTurnRequest): AssistantTurnResponse {
  return {
    apiVersion: '2',
    catalogue: request.catalogue,
    requestId: request.requestId,
    userIntentId: request.userIntentId,
    intentRevision: request.intentRevision,
    conversationId: request.conversationId,
    conversationGeneration: request.conversationGeneration,
    connectionGeneration: request.connectionGeneration,
    preferenceRevision: request.context.preferences.revision,
    kind: 'proposal',
    text: 'You can save this recipe.',
    sources: [{ recipeId: '53064', section: 'recipe' }],
    referenceSets: [
      { referenceSetId: randomUUID(), messageId: randomUUID(), recipeIds: ['53064', '53262'] },
    ],
    proposals: [{ kind: 'saveRecipe', recipeId: '53064' }],
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
}

test('turn request precedes response durably; response references bind to the actual displayed message and guards', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    const begin = await f.turns.beginTurn({ request, expectedConversationRevision: 0 });
    assert.equal(begin.kind, 'ready');
    if (begin.kind !== 'ready') return;
    assert.equal(begin.value.intent.phase, 'awaiting_response');
    assert.equal(begin.value.response, null);
    assert.equal(f.database.prepare('SELECT status FROM message').get()?.status, 'sending');
    const draft = await f.turns.saveDraft(
      { conversationId: request.conversationId, generation: 0, expectedConversationRevision: 1 },
      'Next question',
    );
    assert.equal(draft.kind, 'ready');
    if (draft.kind === 'ready') assert.equal(draft.value.revision, 1);
    const response = answer(request);
    const assistantMessageId = f.assistantId(request);
    const accepted = await f.turns.acceptResponse({
      response,
      assistantMessageId,
      expectedIntentRevision: 0,
    });
    assert.equal(accepted.kind, 'ready');
    if (accepted.kind !== 'ready') return;
    assert.equal(accepted.value.acknowledgement.intent.phase, 'confirmation');
    assert.equal(accepted.value.acknowledgement.guards?.contextRevision, 2);
    assert.equal(accepted.value.acknowledgement.guards?.connectionGeneration, 1);
    assert.equal(accepted.value.acknowledgement.response?.kind, 'proposal');
    if (accepted.value.acknowledgement.response?.kind === 'proposal')
      assert.equal(
        accepted.value.acknowledgement.response.referenceSets[0]!.messageId,
        assistantMessageId,
      );
    const page = await f.repository.readConversation();
    assert.equal(page.kind, 'ready');
    if (page.kind === 'ready') {
      assert.deepEqual(
        page.value.messages.map((item) => item.status),
        ['complete', 'complete'],
      );
      assert.equal(page.value.header.composerDraft, 'Next question');
      assert.equal(page.value.messages[1]!.messageId, assistantMessageId);
      assert.deepEqual(page.value.messages[1]!.referenceSets[0]!.recipeIds, ['53064', '53262']);
    }
    const replay = await f.turns.acceptResponse({
      response,
      assistantMessageId,
      expectedIntentRevision: 0,
    });
    assert.equal(replay.kind, 'ready');
    if (replay.kind === 'ready') {
      assert.equal(replay.value.replay, true);
      assert.deepEqual(replay.value.acknowledgement, accepted.value.acknowledgement);
    }
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count, 0);
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      0,
    );
  } finally {
    await f.writer.close();
  }
});

test('connection changes and a second active turn cannot accept or append a stale response', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    assert.equal(
      (await f.turns.beginTurn({ request, expectedConversationRevision: 0 })).kind,
      'ready',
    );
    const competing = await f.turns.beginTurn({
      request: await f.request(),
      expectedConversationRevision: 1,
    });
    assert.equal(competing.kind, 'failed');
    if (competing.kind === 'failed') assert.equal(competing.error.code, 'already_pending');
    f.changeConnection();
    const stale = await f.turns.acceptResponse({
      response: answer(request),
      assistantMessageId: f.assistantId(request),
      expectedIntentRevision: 0,
    });
    assert.equal(stale.kind, 'failed');
    if (stale.kind === 'failed') assert.equal(stale.error.code, 'stale_context');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()?.count, 1);
    const failure = await f.turns.recordTurnFailure({
      userIntentId: request.userIntentId,
      expectedIntentRevision: 0,
      error: {
        code: 'network_unavailable',
        messageKey: 'assistant.disconnected',
        retry: 'after_reconnect',
      },
    });
    assert.equal(failure.kind, 'ready');
    if (failure.kind === 'ready') {
      assert.equal(failure.value.intent.phase, 'cancelled');
      assert.equal(failure.value.response?.kind, 'error');
    }
    assert.equal(f.database.prepare('SELECT status FROM message').get()?.status, 'failed');
  } finally {
    await f.writer.close();
  }
});

test('response reference insertion failure rolls back reply, guards and message status for exact retry', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    assert.equal(
      (await f.turns.beginTurn({ request, expectedConversationRevision: 0 })).kind,
      'ready',
    );
    const response = answer(request);
    const assistantMessageId = f.assistantId(request);
    const prepare = f.connection.prepare;
    let inject = true;
    f.connection.prepare = async (sql) => {
      const statement = await prepare(sql);
      return {
        ...statement,
        run: async (values) => {
          if (inject && sql.startsWith('INSERT INTO reference_item'))
            throw new Error('injected reference write fault');
          await statement.run(values);
        },
      };
    };
    assert.equal(
      (await f.turns.acceptResponse({ response, assistantMessageId, expectedIntentRevision: 0 }))
        .kind,
      'failed',
    );
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()?.count, 1);
    assert.equal(f.database.prepare('SELECT status FROM message').get()?.status, 'sending');
    assert.equal(
      f.database.prepare('SELECT response_json FROM assistant_intent_context').get()?.response_json,
      null,
    );
    inject = false;
    assert.equal(
      (await f.turns.acceptResponse({ response, assistantMessageId, expectedIntentRevision: 0 }))
        .kind,
      'ready',
    );
    await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
    const recovered = await f.turns.readIntent(request.userIntentId);
    assert.equal(recovered.kind, 'ready');
    if (recovered.kind === 'ready') assert.equal(recovered.value?.intent.phase, 'cancelled');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()?.count, 2);
    assert.equal(
      (
        await f.turns.acceptResponse({
          response: answer(request),
          assistantMessageId: f.assistantId(request),
          expectedIntentRevision: 0,
        })
      ).kind,
      'failed',
    );
  } finally {
    await f.writer.close();
  }
});

test('invalid transcript/reference records fail visibly; valid empty query is distinct', async () => {
  const f = await fixture();
  try {
    const empty = await f.repository.readConversation();
    assert.equal(empty.kind, 'ready');
    if (empty.kind === 'ready') assert.deepEqual(empty.value.messages, []);
    assert.equal((await f.repository.readConversation({ limit: 101 })).kind, 'failed');
    assert.equal((await f.repository.readReferenceSets(['not-an-id'])).kind, 'failed');
    const messageId = randomUUID();
    f.database
      .prepare('INSERT INTO message VALUES (?, ?, 0, 0, ?, ?, ?, ?)')
      .run(
        messageId,
        f.identifiers.conversationId,
        'assistant',
        JSON.stringify('A result'),
        'complete',
        '2026-09-28T00:00:00.000Z',
      );
    f.database.exec('UPDATE conversation SET next_sequence = 1');
    const referenceId = randomUUID();
    f.database.prepare('INSERT INTO reference_set VALUES (?, ?, 0)').run(referenceId, messageId);
    f.database.prepare('INSERT INTO reference_item VALUES (?, 1, ?)').run(referenceId, '53064');
    assert.equal((await f.repository.readConversation()).kind, 'failed');
    assert.equal((await f.repository.readReferenceSets([referenceId])).kind, 'failed');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()?.count, 1);
  } finally {
    await f.writer.close();
  }
});

test('startup recovery stops unfinished authority, retains receipts and is idempotent', async () => {
  const f = await fixture();
  try {
    const phases: PendingIntent['phase'][] = [
      'draft',
      'awaiting_response',
      'clarification',
      'confirmation',
      'ready',
      'dispatched',
      'reconciling',
      'settled',
      'cancelled',
    ];
    phases.forEach((phase) => {
      const intent: PendingIntent = { userIntentId: randomUUID(), revision: 0, phase, slots: [] };
      f.database
        .prepare('INSERT INTO pending_intent VALUES (?, 0, ?, ?)')
        .run(intent.userIntentId, phase, JSON.stringify(intent));
    });
    const receiptId = randomUUID();
    f.database
      .prepare('INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        receiptId,
        randomUUID(),
        'f'.repeat(64),
        'no_op',
        '2026-09-28T00:00:00.000Z',
        'unchanged',
        '[]',
      );
    f.database
      .prepare('INSERT INTO message VALUES (?, ?, 0, 0, ?, ?, ?, ?)')
      .run(
        randomUUID(),
        f.identifiers.conversationId,
        'user',
        JSON.stringify('Unfinished request'),
        'sending',
        '2026-09-28T00:00:00.000Z',
      );
    f.database.exec('UPDATE conversation SET next_sequence = 1');
    await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
    assert.deepEqual(
      f.database
        .prepare('SELECT phase FROM pending_intent ORDER BY rowid')
        .all()
        .map((row) => row.phase),
      [
        'cancelled',
        'cancelled',
        'cancelled',
        'cancelled',
        'cancelled',
        'reconciling',
        'reconciling',
        'settled',
        'cancelled',
      ],
    );
    assert.equal(f.database.prepare('SELECT status FROM message').get()?.status, 'interrupted');
    assert.equal(
      f.database.prepare('SELECT operation_id FROM operation_receipt').get()?.operation_id,
      receiptId,
    );
    assert.equal(
      f.database
        .prepare("SELECT revision FROM state_revision WHERE collection = 'conversation'")
        .get()?.revision,
      1,
    );
    await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
    assert.equal(
      f.database
        .prepare("SELECT revision FROM state_revision WHERE collection = 'conversation'")
        .get()?.revision,
      1,
    );
  } finally {
    await f.writer.close();
  }
});

test('startup recovery rejects malformed nested turn metadata atomically without deleting it', async () => {
  const f = await fixture();
  try {
    const intent: PendingIntent = {
      userIntentId: randomUUID(),
      revision: 0,
      phase: 'awaiting_response',
      slots: [],
    };
    f.database
      .prepare('INSERT INTO pending_intent VALUES (?, 0, ?, ?)')
      .run(intent.userIntentId, intent.phase, JSON.stringify(intent));
    f.database
      .prepare('INSERT INTO assistant_intent_context VALUES (?, 1, ?, 0, ?, NULL, NULL, ?)')
      .run(intent.userIntentId, 'awaiting_response', '{}', '[]');
    await assert.rejects(
      recoverInterruptedAssistantWork(f.writer, catalogueBoundary),
      /Stored conversation is invalid/,
    );
    assert.equal(
      f.database.prepare('SELECT phase FROM pending_intent').get()?.phase,
      'awaiting_response',
    );
    assert.equal(
      f.database.prepare('SELECT request_json FROM assistant_intent_context').get()?.request_json,
      '{}',
    );
    assert.equal(
      f.database.prepare("SELECT revision FROM state_revision WHERE collection = 'store'").get()
        ?.revision,
      0,
    );
  } finally {
    await f.writer.close();
  }
});

test('begin, accept, failure and draft lost acknowledgements notify once only after durable entity proof', async () => {
  for (const kind of ['begin', 'accept', 'failure', 'draft'] as const) {
    const f = await fixture();
    try {
      const request = await f.request();
      if (kind === 'accept' || kind === 'failure')
        assert.equal(
          (await f.turns.beginTurn({ request, expectedConversationRevision: 0 })).kind,
          'ready',
        );
      f.events.length = 0;
      const response = answer(request);
      const assistantMessageId = f.assistantId(request);
      const execute = () =>
        kind === 'begin'
          ? f.turns.beginTurn({ request, expectedConversationRevision: 0 })
          : kind === 'accept'
            ? f.turns.acceptResponse({ response, assistantMessageId, expectedIntentRevision: 0 })
            : kind === 'failure'
              ? f.turns.recordTurnFailure({
                  userIntentId: request.userIntentId,
                  expectedIntentRevision: 0,
                  error: {
                    code: 'network_unavailable',
                    messageKey: 'assistant.offline',
                    retry: 'after_reconnect',
                  },
                })
              : f.turns.saveDraft(
                  {
                    conversationId: request.conversationId,
                    generation: 0,
                    expectedConversationRevision: 0,
                  },
                  'Retained draft',
                );
      const exec = f.connection.exec;
      let lostAck = true;
      f.connection.exec = async (sql) => {
        await exec(sql);
        if (sql === 'COMMIT' && lostAck) {
          lostAck = false;
          throw new Error('lost commit acknowledgement');
        }
      };
      f.readerAvailable(false);
      assert.equal((await execute()).kind, 'failed', kind);
      assert.deepEqual(f.events, [], kind);
      const revision = Number(
        f.database.prepare("SELECT revision FROM state_revision WHERE collection = 'store'").get()
          ?.revision,
      );
      f.readerAvailable(true);
      assert.equal((await f.turns.readIntent(request.userIntentId)).kind, 'ready');
      assert.deepEqual(f.events, [{ revision, collections: ['conversation'] }], kind);
      f.recoverWriter();
      assert.equal((await execute()).kind, 'ready', kind);
      assert.deepEqual(f.events, [{ revision, collections: ['conversation'] }], kind);
      assert.equal(
        f.database.prepare("SELECT revision FROM state_revision WHERE collection = 'store'").get()
          ?.revision,
        revision,
      );
    } finally {
      await f.writer.close();
    }
  }
});

test('failed lifecycle/phase contradictions are rejected without concealing or rewriting corruption', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    await f.turns.beginTurn({ request, expectedConversationRevision: 0 });
    await f.turns.recordTurnFailure({
      userIntentId: request.userIntentId,
      expectedIntentRevision: 0,
      error: {
        code: 'network_unavailable',
        messageKey: 'assistant.offline',
        retry: 'after_reconnect',
      },
    });
    const stored = JSON.parse(
      String(f.database.prepare('SELECT intent_json FROM pending_intent').get()?.intent_json),
    ) as PendingIntent;
    for (const phase of [
      'draft',
      'awaiting_response',
      'clarification',
      'confirmation',
      'ready',
      'dispatched',
      'reconciling',
      'settled',
      'cancelled',
    ] as const) {
      f.database
        .prepare('UPDATE pending_intent SET phase = ?, intent_json = ?')
        .run(phase, JSON.stringify({ ...stored, phase }));
      const read = await f.turns.readIntent(request.userIntentId);
      assert.equal(
        read.kind,
        phase === 'settled' || phase === 'cancelled' ? 'ready' : 'failed',
        phase,
      );
      assert.equal(f.database.prepare('SELECT phase FROM pending_intent').get()?.phase, phase);
    }
  } finally {
    await f.writer.close();
  }
});

test('an unrelated durable revision never proves a rolled-back turn notification', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    const exec = f.connection.exec;
    let rejectCommit = true;
    f.connection.exec = async (sql) => {
      if (sql === 'COMMIT' && rejectCommit) {
        rejectCommit = false;
        throw new Error('commit did not run');
      }
      await exec(sql);
    };
    f.readerAvailable(false);
    assert.equal(
      (await f.turns.beginTurn({ request, expectedConversationRevision: 0 })).kind,
      'failed',
    );
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()?.count, 0);
    f.database.exec("UPDATE state_revision SET revision = 1 WHERE collection = 'store'");
    f.readerAvailable(true);
    const absent = await f.turns.readIntent(request.userIntentId);
    assert.equal(absent.kind, 'ready');
    if (absent.kind === 'ready') assert.equal(absent.value, null);
    assert.deepEqual(f.events, []);
  } finally {
    await f.writer.close();
  }
});

test('runtime day/connection changes during awaited begin or response writes roll back obsolete acceptance', async () => {
  for (const kind of ['begin', 'accept'] as const)
    for (const change of ['connection', 'date'] as const) {
      const f = await fixture();
      try {
        const request = await f.request();
        if (kind === 'accept')
          await f.turns.beginTurn({ request, expectedConversationRevision: 0 });
        f.events.length = 0;
        const prepare = f.connection.prepare;
        let changed = false;
        f.connection.prepare = async (sql) => {
          if (!changed && sql.startsWith('INSERT INTO message')) {
            changed = true;
            if (change === 'connection') f.changeConnection();
            else f.changeDate();
          }
          return prepare(sql);
        };
        const result =
          kind === 'begin'
            ? await f.turns.beginTurn({ request, expectedConversationRevision: 0 })
            : await f.turns.acceptResponse({
                response: answer(request),
                assistantMessageId: f.assistantId(request),
                expectedIntentRevision: 0,
              });
        assert.equal(result.kind, 'failed', `${kind}/${change}`);
        if (result.kind === 'failed') assert.equal(result.error.code, 'stale_context');
        assert.equal(
          f.database.prepare('SELECT COUNT(*) AS count FROM message').get()?.count,
          kind === 'begin' ? 0 : 1,
        );
        assert.deepEqual(f.events, []);
        if (kind === 'accept')
          assert.equal(
            f.database.prepare('SELECT response_json FROM assistant_intent_context').get()
              ?.response_json,
            null,
          );
      } finally {
        await f.writer.close();
      }
    }
});

function turnState(f: Awaited<ReturnType<typeof fixture>>) {
  return Object.fromEntries(
    [
      'conversation',
      'conversation_memory_state',
      'message',
      'memory_source_review',
      'memory_entry',
      'memory_relation',
      'reference_set',
      'reference_item',
      'pending_intent',
      'assistant_intent_context',
      'assistant_acceptance',
      'assistant_action_plan',
      'command_slot',
      'operation_receipt',
      'state_revision',
    ].map((table) => [table, f.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

test('final admission rejects day and connection drift during observer validation or automatic finalization', async () => {
  for (const kind of ['begin', 'accept', 'rearm'] as const)
    for (const window of ['observer', 'finalize'] as const)
      for (const change of ['date', 'connection'] as const) {
        const f = await fixture();
        try {
          const request = await f.request();
          if (kind !== 'begin') {
            assert.equal(
              (await f.turns.beginTurn({ request, expectedConversationRevision: 0 })).kind,
              'ready',
            );
            if (kind === 'rearm')
              assert.equal(
                (
                  await f.turns.recordTurnFailure({
                    userIntentId: request.userIntentId,
                    expectedIntentRevision: 0,
                    error: {
                      code: 'network_unavailable',
                      messageKey: 'test.offline',
                      retry: 'after_reconnect',
                    },
                  })
                ).kind,
                'ready',
              );
          }
          f.events.length = 0;
          const before = turnState(f);
          let reached = false;
          const invalidate = () => {
            reached = true;
            if (change === 'date') f.changeDate();
            else f.changeConnection();
          };
          let failed = 0;
          let committed = 0;
          f.writer.setObserver({
            begin: async () => undefined,
            beforeCommit: async () => {
              await Promise.resolve();
              if (window === 'observer') invalidate();
            },
            committed: async () => {
              committed++;
            },
            failed: () => {
              failed++;
            },
          });
          if (window === 'finalize') {
            const transaction = f.writer.transaction.bind(f.writer);
            f.writer.transaction = (work, impact, admission) =>
              transaction(
                async (session) => {
                  const value = await work(session);
                  // A retained statement creates the actual automatic-finalization await after work.
                  await session.prepare('SELECT 1 AS admission_seam');
                  return value;
                },
                impact,
                admission,
              );
            const prepare = f.connection.prepare;
            f.connection.prepare = async (sql) => {
              const statement = await prepare(sql);
              return {
                run: statement.run,
                finalize: async () => {
                  await statement.finalize();
                  if (sql === 'SELECT 1 AS admission_seam') invalidate();
                },
              };
            };
          }
          const result =
            kind === 'begin'
              ? await f.turns.beginTurn({ request, expectedConversationRevision: 0 })
              : kind === 'rearm'
                ? await f.turns.rearmTurn({
                    userIntentId: request.userIntentId,
                    expectedIntentRevision: 0,
                  })
                : await f.turns.acceptResponse({
                    response: answer(request),
                    assistantMessageId: f.assistantId(request),
                    expectedIntentRevision: 0,
                  });
          assert.equal(reached, true, `${kind}/${window}/${change}`);
          assert.equal(result.kind, 'failed');
          if (result.kind === 'failed') assert.equal(result.error.code, 'stale_context');
          assert.deepEqual(turnState(f), before);
          assert.equal(failed, 1);
          assert.equal(committed, 0);
          assert.deepEqual(f.events, []);
        } finally {
          await f.writer.close();
        }
      }
});

test('native COMMIT admission cannot recall late cancellation and exact acceptance replay stays historical', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    assert.equal(
      (await f.turns.beginTurn({ request, expectedConversationRevision: 0 })).kind,
      'ready',
    );
    const input = {
      response: answer(request),
      assistantMessageId: f.assistantId(request),
      expectedIntentRevision: 0,
    };
    f.events.length = 0;
    const exec = f.connection.exec;
    let dispatched!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let once = true;
    f.connection.exec = async (sql) => {
      if (sql === 'COMMIT' && once) {
        once = false;
        dispatched();
        await gate;
      }
      await exec(sql);
    };
    const pending = f.turns.acceptResponse(input);
    await started;
    f.changeConnection();
    f.changeDate();
    release();
    const first = await pending;
    assert.equal(first.kind, 'ready');
    if (first.kind !== 'ready') assert.fail();
    assert.equal(first.value.replay, false);
    assert.equal(f.events.length, 1);
    const after = turnState(f);
    const replay = await f.turns.acceptResponse(input);
    assert.equal(replay.kind, 'ready');
    if (replay.kind !== 'ready') assert.fail();
    assert.equal(replay.value.replay, true);
    assert.deepEqual(replay.value.acknowledgement, first.value.acknowledgement);
    assert.deepEqual(turnState(f), after);
    assert.equal(f.events.length, 1);
  } finally {
    await f.writer.close();
  }
});

test('final runtime rejection with failed rollback reports storage reconciliation rather than clean staleness', async () => {
  for (const window of ['work', 'observer'] as const) {
    const f = await fixture();
    try {
      const request = await f.request();
      assert.equal(
        (await f.turns.beginTurn({ request, expectedConversationRevision: 0 })).kind,
        'ready',
      );
      f.events.length = 0;
      const exec = f.connection.exec;
      f.connection.exec = async (sql) => {
        if (sql === 'ROLLBACK') throw new Error('injected rollback failure');
        await exec(sql);
      };
      let changed = false;
      const invalidate = () => {
        changed = true;
        f.changeConnection();
      };
      const prepare = f.connection.prepare;
      f.connection.prepare = async (sql) => {
        if (window === 'work' && !changed && sql.startsWith('INSERT INTO message')) invalidate();
        return prepare(sql);
      };
      f.writer.setObserver({
        begin: async () => undefined,
        beforeCommit: async () => {
          await Promise.resolve();
          if (window === 'observer') invalidate();
        },
        committed: async () => undefined,
        failed: () => undefined,
      });
      const result = await f.turns.acceptResponse({
        response: answer(request),
        assistantMessageId: f.assistantId(request),
        expectedIntentRevision: 0,
      });
      assert.equal(changed, true, window);
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') {
        assert.equal(result.error.code, 'storage_failure');
        assert.equal(result.error.retry, 'reconcile');
      }
      await assert.rejects(
        f.writer.transaction(async () => undefined),
        /requires recovery/,
      );
      assert.deepEqual(f.events, []);
      // The failed rollback left an open transaction; only explicit fixture cleanup establishes absence.
      await exec('ROLLBACK');
      assert.equal(
        f.database.prepare('SELECT count(*) AS n FROM assistant_acceptance').get()?.n,
        0,
      );
    } finally {
      await f.writer.close();
    }
  }
});
