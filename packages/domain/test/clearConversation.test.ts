import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  LocalCommand,
  PendingIntent,
} from '@cookmate/contracts';
import { createCommandPreparer } from '../src/prepareCommand';
import {
  createCommandExecutor,
  registerReadyIntent,
} from '../../../apps/mobile/src/data/commandExecutor';
import { readConversationClearScope } from '../../../apps/mobile/src/data/conversationClearScope';
import { createClearConversationCommandHandler } from '../../../apps/mobile/src/data/clearConversationCommand';
import { favouriteCommandHandlers } from '../../../apps/mobile/src/data/favouriteCommands';
import { createAssistantTurnRepository } from '../../../apps/mobile/src/data/assistantTurnRepository';
import { createAssistantContextRepository } from '../../../apps/mobile/src/data/assistantContextRepository';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
const prepare = createCommandPreparer(platform, catalogueBoundary);
const date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
async function fixture() {
  const storage = desktopConnection();
  await configureConnection(storage.connection);
  const writer = new SerializedWriter(storage.connection);
  const conversationId = randomUUID();
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId: randomUUID(), shoppingScopeId: randomUUID(), conversationId },
  );
  const reader = new SerializedReader(storage.connection);
  const turns = createAssistantTurnRepository({
    writer,
    reader,
    catalogue: catalogueBoundary,
    platform,
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => date,
    connectionGeneration: () => 1,
    onCommitted: () => undefined,
  });
  const executor = createCommandExecutor({
    writer,
    catalogue: catalogueBoundary,
    platform,
    handlers: {
      ...favouriteCommandHandlers,
      ...createClearConversationCommandHandler({
        catalogue: catalogueBoundary,
        sha256: platform.sha256,
      }),
    },
    now: () => '2026-09-28T00:00:00.000Z',
    dateContext: () => date,
    readReceipt: async () => {
      throw new Error('No separate reconciliation reader in this serial fixture');
    },
    onCommitted: () => undefined,
  });
  const register = async (command: LocalCommand) => {
    const intent: PendingIntent = {
      userIntentId: command.userIntentId,
      revision: command.intentRevision,
      phase: 'ready',
      ...(command.origin ? { origin: command.origin } : {}),
      slots: [{ slotId: randomUUID(), command }],
    };
    await registerReadyIntent(writer, intent, catalogueBoundary, platform);
  };
  const contexts = createAssistantContextRepository({
    reader,
    writer,
    catalogue: catalogueBoundary,
    dateContext: () => date,
    onCommitted: () => undefined,
  });
  const context = await contexts.readContext({
    text: 'Find Alfredo',
    messageId: randomUUID(),
    selection: {},
  });
  assert.equal(context.kind, 'ready');
  if (context.kind !== 'ready') assert.fail();
  const snapshot = JSON.parse(
    JSON.stringify(context.value),
  ) as import('../src/index').ConversationContextSnapshot;
  const request: AssistantTurnRequest = {
    apiVersion: '2',
    catalogue: { ...catalogue.identity },
    requestId: randomUUID(),
    userIntentId: randomUUID(),
    intentRevision: 0,
    conversationId,
    conversationGeneration: 0,
    connectionGeneration: 1,
    message: snapshot.currentMessage,
    context: {
      history: [],
      memory: snapshot.memory,
      referenceSets: [],
      preferences: snapshot.preferences,
      planOccurrences: [],
      date,
    },
    capabilities: ['saveRecipe'],
  };
  const prepareClear = async (expectedGeneration = 0) =>
    prepare({
      kind: 'clearConversation',
      conversationId,
      expectedGeneration,
      expectedScopeFingerprint: (
        await reader.transaction((session) =>
          readConversationClearScope(session, {
            catalogue: catalogueBoundary,
            sha256: platform.sha256,
          }),
        )
      ).fingerprint,
    });
  return {
    ...storage,
    writer,
    reader,
    turns,
    ...executor,
    register,
    request,
    conversationId,
    prepareClear,
  };
}

test('real clear command removes transcript/reference/request/draft scope while preserving cooking state and receipts', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.turns.beginTurn({ request: f.request, expectedConversationRevision: 0 })).kind,
      'ready',
    );
    const response: AssistantTurnResponse = {
      apiVersion: '2',
      catalogue: f.request.catalogue,
      requestId: f.request.requestId,
      userIntentId: f.request.userIntentId,
      intentRevision: 0,
      conversationId: f.conversationId,
      conversationGeneration: 0,
      connectionGeneration: 1,
      preferenceRevision: 0,
      kind: 'answer',
      text: 'Here is Alfredo.',
      sources: [{ recipeId: '53064', section: 'recipe' }],
      referenceSets: [
        { referenceSetId: randomUUID(), messageId: randomUUID(), recipeIds: ['53064'] },
      ],
      memoryUpdate: {
        baseRevision: 0,
        baseContextRevision: 0,
        reviews: [{ sourceMessageId: f.request.message.messageId, disposition: 'non_memory' }],
        entries: [],
      },
    };
    assert.equal(
      (
        await f.turns.acceptResponse({
          response,
          assistantMessageId: String(
            f.database
              .prepare('SELECT assistant_message_id AS id FROM assistant_acceptance_envelope')
              .get()?.id,
          ),
          expectedIntentRevision: 0,
        })
      ).kind,
      'ready',
    );
    const command = await prepare(
      { kind: 'setFavourite', recipeId: '53064', saved: true },
      {
        origin: {
          conversationId: f.conversationId,
          generation: 0,
          messageId: f.request.message.messageId,
        },
      },
    );
    await f.register(command);
    const saved = await f.execute(command);
    assert.equal(saved.kind, 'receipt');
    f.database
      .prepare('UPDATE conversation SET composer_draft = ?')
      .run(JSON.stringify('Private draft'));
    f.database
      .prepare('INSERT INTO saved_preference VALUES (?, ?, ?, 1)')
      .run(randomUUID(), 'cuisine', JSON.stringify('Indian'));
    const clear = await f.prepareClear();
    await f.register(clear);
    const cleared = await f.execute(clear);
    assert.equal(cleared.kind, 'receipt');
    for (const table of ['message', 'reference_set', 'reference_item', 'assistant_intent_context'])
      assert.equal(f.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count, 1);
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM saved_preference').get()?.count,
      1,
    );
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM operation_receipt').get()?.count,
      2,
    );
    assert.deepEqual(
      {
        ...f.database
          .prepare('SELECT generation, composer_draft, next_sequence FROM conversation')
          .get(),
      },
      { generation: 1, composer_draft: JSON.stringify(''), next_sequence: 0 },
    );
    assert.deepEqual(await f.execute(command), saved);
    assert.deepEqual(await f.execute(clear), cleared);
    assert.equal(f.database.prepare('SELECT generation FROM conversation').get()?.generation, 1);
  } finally {
    await f.writer.close();
  }
});

test('clear stops pending reply acceptance and uncommitted chat commands; stale clear does not affect the new generation', async () => {
  const f = await fixture();
  try {
    await f.turns.beginTurn({ request: f.request, expectedConversationRevision: 0 });
    const pending = await prepare(
      { kind: 'setFavourite', recipeId: '53064', saved: true },
      {
        origin: {
          conversationId: f.conversationId,
          generation: 0,
          messageId: f.request.message.messageId,
        },
      },
    );
    await f.register(pending);
    const clear = await f.prepareClear();
    await f.register(clear);
    assert.equal((await f.execute(clear)).kind, 'receipt');
    assert.equal((await f.execute(pending)).kind, 'failed');
    const failedReply = await f.turns.recordTurnFailure({
      userIntentId: f.request.userIntentId,
      expectedIntentRevision: 0,
      error: {
        code: 'network_unavailable',
        messageKey: 'assistant.late',
        retry: 'after_reconnect',
      },
    });
    assert.equal(failedReply.kind, 'failed');
    const staleClear = await f.prepareClear();
    await f.register(staleClear);
    assert.equal((await f.execute(staleClear)).kind, 'failed');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM favourite').get()?.count, 0);
    assert.equal(f.database.prepare('SELECT generation FROM conversation').get()?.generation, 1);
  } finally {
    await f.writer.close();
  }
});

test('clear receipt fault rolls back transcript deletion and generation before an exact successful retry', async () => {
  const f = await fixture();
  try {
    await f.turns.beginTurn({ request: f.request, expectedConversationRevision: 0 });
    const clear = await f.prepareClear();
    await f.register(clear);
    let fail = true;
    const nativePrepare = f.connection.prepare;
    f.connection.prepare = async (sql) => {
      const statement = await nativePrepare(sql);
      return {
        ...statement,
        run: async (values) => {
          if (fail && sql.startsWith('INSERT INTO operation_receipt'))
            throw new Error('receipt fault');
          await statement.run(values);
        },
      };
    };
    assert.equal((await f.execute(clear)).kind, 'failed');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()?.count, 1);
    assert.equal(
      f.database.prepare('SELECT COUNT(*) AS count FROM assistant_intent_context').get()?.count,
      1,
    );
    assert.equal(f.database.prepare('SELECT generation FROM conversation').get()?.generation, 0);
    fail = false;
    assert.equal((await f.execute(clear)).kind, 'receipt');
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM message').get()?.count, 0);
    assert.equal(f.database.prepare('SELECT generation FROM conversation').get()?.generation, 1);
  } finally {
    await f.writer.close();
  }
});

test('unreceipted legacy clear requires fresh review while a completed legacy clear replays its exact receipt', async () => {
  const f = await fixture();
  try {
    const legacy = await prepare({
      kind: 'clearConversation',
      conversationId: f.conversationId,
      expectedGeneration: 0,
    });
    await f.register(legacy);
    const denied = await f.execute(legacy);
    assert.equal(denied.kind, 'failed');
    if (denied.kind === 'failed') assert.equal(denied.error.code, 'stale_context');
    const receipt = {
      schemaVersion: 1 as const,
      operationId: legacy.operationId,
      userIntentId: legacy.userIntentId,
      payloadFingerprint: legacy.payloadFingerprint,
      outcome: 'committed' as const,
      committedAt: '2026-09-28T00:00:00.000Z',
      shoppingProjection: 'unchanged' as const,
      effects: [{ kind: 'conversation' as const, entityId: f.conversationId, revision: 1 }],
    };
    f.database
      .prepare('INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        receipt.operationId,
        receipt.userIntentId,
        receipt.payloadFingerprint,
        receipt.outcome,
        receipt.committedAt,
        receipt.shoppingProjection,
        JSON.stringify(receipt.effects),
      );
    const before = f.database.prepare('SELECT total_changes() AS n').get()?.n;
    assert.deepEqual(await f.execute(legacy), { kind: 'receipt', receipt });
    assert.equal(f.database.prepare('SELECT total_changes() AS n').get()?.n, before);
  } finally {
    await f.writer.close();
  }
});

test('transaction recheck rejects same-length and whitespace-only draft changes without deleting anything', async () => {
  for (const [initial, changed] of [
    ['one', 'two'],
    [' ', '\t'],
  ]) {
    const f = await fixture();
    try {
      f.database.prepare('UPDATE conversation SET composer_draft=?').run(JSON.stringify(initial));
      const clear = await f.prepareClear();
      await f.register(clear);
      f.database.prepare('UPDATE conversation SET composer_draft=?').run(JSON.stringify(changed));
      const before = f.database.prepare('SELECT total_changes() AS n').get()?.n;
      const result = await f.execute(clear);
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.error.code, 'stale_context');
      assert.equal(f.database.prepare('SELECT total_changes() AS n').get()?.n, before);
      assert.equal(
        f.database.prepare('SELECT composer_draft FROM conversation').get()?.composer_draft,
        JSON.stringify(changed),
      );
    } finally {
      await f.writer.close();
    }
  }
});

test('zero-message draft clears, while a truly empty scope receives a no-op receipt without generation or collection changes', async () => {
  const f = await fixture();
  try {
    const empty = await f.prepareClear();
    await f.register(empty);
    const before = f.database.prepare('SELECT * FROM state_revision ORDER BY collection').all();
    const result = await f.execute(empty);
    assert.equal(result.kind, 'receipt');
    if (result.kind === 'receipt') {
      assert.equal(result.receipt.outcome, 'no_op');
      assert.equal(result.receipt.shoppingProjection, 'unchanged');
      assert.deepEqual(result.receipt.effects, []);
    }
    assert.deepEqual(
      f.database.prepare('SELECT * FROM state_revision ORDER BY collection').all(),
      before,
    );
    assert.equal(f.database.prepare('SELECT generation FROM conversation').get()?.generation, 0);
    f.database.prepare('UPDATE conversation SET composer_draft=?').run(JSON.stringify(' 🍲 '));
    const draft = await f.prepareClear();
    await f.register(draft);
    const cleared = await f.execute(draft);
    assert.equal(cleared.kind, 'receipt');
    if (cleared.kind === 'receipt') assert.equal(cleared.receipt.outcome, 'committed');
    assert.equal(f.database.prepare('SELECT generation FROM conversation').get()?.generation, 1);
    assert.equal(
      f.database.prepare('SELECT composer_draft FROM conversation').get()?.composer_draft,
      JSON.stringify(''),
    );
    assert.deepEqual(await f.execute(empty), result);
  } finally {
    await f.writer.close();
  }
});
