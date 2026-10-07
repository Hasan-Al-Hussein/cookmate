import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { DateContext, NormalAssistantTurnResponse } from '@cookmate/contracts';
import type { RepositoryResult } from '@cookmate/domain';
import { createAssistantContextRepository } from '../../mobile/src/data/assistantContextRepository';
import { createAssistantTurnRepository } from '../../mobile/src/data/assistantTurnRepository';
import { initializeDatabase } from '../../mobile/src/data/initialize';
import { configureConnection, SerializedReader, SerializedWriter } from '../../mobile/src/data/sql';
import {
  desktopConnection,
  removeFixtureDirectory,
} from '../../../packages/domain/test/helpers/sqlite';
import { createGateway } from '../src/server';
import { createOrchestrator } from '../src/orchestrator';
import type { ProviderInput } from '../src/provider-contract';
import { memoryRegistry } from './helpers';
import { buildAssistantRequest } from '../../mobile/src/assistant-core/context';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
function ready<T>(result: RepositoryResult<T>): T {
  if (result.kind !== 'ready') assert.fail(JSON.stringify(result.error));
  return result.value;
}
async function openStore(path: string, date: DateContext) {
  const write = desktopConnection(path);
  await configureConnection(write.connection);
  const writer = new SerializedWriter(write.connection);
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    { installationId: randomUUID(), shoppingScopeId: randomUUID(), conversationId: randomUUID() },
  );
  const read = desktopConnection(path);
  await configureConnection(read.connection);
  await read.connection.exec('PRAGMA query_only=ON');
  const reader = new SerializedReader(read.connection);
  const options = {
    reader,
    writer,
    catalogue: catalogueBoundary,
    platform,
    now: () => `${date.localDate}T08:00:00.000Z`,
    dateContext: () => date,
    connectionGeneration: () => 1,
    onCommitted: () => {},
  };
  const context = createAssistantContextRepository(options);
  const turns = createAssistantTurnRepository(options);
  return {
    context,
    turns,
    async close() {
      await reader.close();
      await writer.close();
    },
  };
}

test('real file SQLite source state crosses v2 gateway and immutable acceptance, survives reopen and rejects changed replay', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-gateway-'));
  const path = join(directory, 'fictional.sqlite');
  const date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  let store = await openStore(path, date);
  const inputs: ProviderInput[] = [];
  const { registry } = await memoryRegistry();
  const token = (await registry.issue()).token;
  const gateway = createGateway({
    registry,
    catalogue: catalogueBoundary,
    turn: createOrchestrator({
      async complete(input) {
        inputs.push(structuredClone(input));
        const memory = input.request.context.memory;
        const older = memory.items[0];
        return {
          value: {
            kind: 'respond',
            sufficiency: 'sufficient',
            missingFacts: [],
            memoryUpdate: {
              baseRevision: memory.projectionRevision,
              baseContextRevision: memory.baseContextRevision,
              reviews: [
                { sourceMessageId: input.request.message.messageId, disposition: 'retain' },
              ],
              entries: [
                {
                  sourceMessageId: input.request.message.messageId,
                  kind: older ? 'correction' : 'constraint',
                  scope: { kind: 'conversation' },
                  relations: older
                    ? [
                        {
                          kind: 'supersedes',
                          target: {
                            kind: 'memory',
                            memoryId: older.memoryId,
                            expectedRevision: older.revision,
                          },
                        },
                      ]
                    : [],
                },
              ],
            },
            response: {
              kind: 'answer',
              text: 'The temporary cooking constraint is noted.',
              sources: [],
              recipeIds: [],
            },
          },
          usage: { inputTokens: 100, outputTokens: 100, thoughtTokens: 0 },
        };
      },
    }),
  });
  t.after(async () => {
    await gateway.app.close();
    await store.close();
    await removeFixtureDirectory(directory);
  });
  async function turn(text: string) {
    const snapshotResult = await store.context.readContext({
      text,
      messageId: randomUUID(),
      selection: {},
    });
    if (snapshotResult.kind !== 'ready') assert.fail(JSON.stringify(snapshotResult));
    const snapshot = snapshotResult.value;
    const built = buildAssistantRequest(snapshot, {
      text,
      selection: {},
      date: snapshot.date,
      ids: {
        requestId: randomUUID(),
        userIntentId: randomUUID(),
        intentRevision: 0,
        messageId: snapshot.currentMessage.messageId,
        connectionGeneration: 1,
      },
    });
    if (built.kind !== 'ready') assert.fail(JSON.stringify(built));
    const request = built.request;
    const begun = ready(
      await store.turns.beginTurn({
        request,
        expectedConversationRevision: snapshot.contextRevision,
      }),
    );
    const result = await gateway.app.inject({
      method: 'POST',
      url: '/v2/assistant/turn',
      headers: { authorization: `Bearer ${token}` },
      payload: request,
    });
    assert.equal(result.statusCode, 200, result.body);
    const response = result.json<NormalAssistantTurnResponse>();
    const accepted = ready(
      await store.turns.acceptResponse({ response, ...begun.acceptanceEnvelope }),
    );
    return { request, response, begun, accepted };
  }
  const first = await turn('No peanuts\0 for this dinner; Monday.');
  await store.close();
  store = await openStore(path, { ...date, localDate: '2026-09-29' });
  const second = await turn('Tuesday instead; keep no peanuts.');
  assert.equal(first.request.conversationId, second.request.conversationId);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[1]!.request.context.memory.items[0]!.quote, first.request.message.text);
  assert.equal(
    inputs[1]!.request.context.memory.items[0]!.sourceDateContext.localDate,
    '2026-09-28',
  );
  assert.equal(second.response.memoryUpdate.entries[0]!.quote, second.request.message.text);
  const replay = ready(
    await store.turns.acceptResponse({
      response: first.response,
      ...first.begun.acceptanceEnvelope,
    }),
  );
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.acknowledgement, first.accepted.acknowledgement);
  const changed = structuredClone(first.response);
  changed.memoryUpdate.reviews[0]!.disposition = 'unresolved';
  const rejected = await store.turns.acceptResponse({
    response: changed,
    ...first.begun.acceptanceEnvelope,
  });
  assert.equal(rejected.kind, 'failed');
  if (rejected.kind === 'failed') assert.equal(rejected.error.code, 'operation_conflict');
  const page = ready(await store.context.readMemoryPage());
  assert.equal(page.items.length, 2);
  const correction = page.items.find(
    (item) => item.sourceMessageId === second.request.message.messageId,
  )!;
  assert.equal(
    correction.relations[0]!.target.memoryId,
    page.items.find((item) => item.sourceMessageId === first.request.message.messageId)!.memoryId,
  );
});
