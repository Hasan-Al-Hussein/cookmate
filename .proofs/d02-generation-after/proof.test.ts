import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { catalogue, catalogueBoundary, catalogueProvenance } from '@cookmate/catalogue';
import type { AssistantTurnRequest, NormalAssistantTurnResponse } from '@cookmate/contracts';
import type { RepositoryResult, StoreChange } from '@cookmate/domain';
import { createAssistantTurnRepository } from './apps/mobile/src/data/assistantTurnRepository';
import { createAssistantContextRepository } from './apps/mobile/src/data/assistantContextRepository';
import { recoverInterruptedAssistantWork } from './apps/mobile/src/data/assistantRecovery';
import { initializeDatabase } from './apps/mobile/src/data/initialize';
import { configureConnection, SerializedReader, SerializedWriter } from './apps/mobile/src/data/sql';
import { createGatewayConnection } from './apps/mobile/src/connection/transport';
import { desktopConnection } from './packages/domain/test/helpers/sqlite';

const output = process.env.D02_PROOF_OUTPUT!;
assert.ok(output);
const seed = { identity: catalogue.identity, recipes: catalogue.recipes, recipeSources: catalogueProvenance.recipeSources };
const date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
const platform = { newId: randomUUID, sha256: async (value: string) => createHash('sha256').update(value).digest('hex') };
function ready<T>(result: RepositoryResult<T>): T {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
const tables = ['conversation', 'conversation_memory_state', 'message', 'message_context', 'memory_source_review', 'memory_entry', 'memory_relation', 'reference_set', 'reference_item', 'pending_intent', 'assistant_intent_context', 'assistant_acceptance', 'assistant_action_plan', 'command_slot', 'operation_receipt', 'state_revision', 'favourite', 'plan_occurrence'];
async function open(path: string) {
  const db = desktopConnection(path);
  await configureConnection(db.connection);
  const writer = new SerializedWriter(db.connection);
  const reader = new SerializedReader(db.connection);
  await initializeDatabase(writer, seed, { installationId: randomUUID(), conversationId: randomUUID(), shoppingScopeId: randomUUID() });
  let fetchCalls = 0;
  const connection = createGatewayConnection({
    credentials: { read: async () => null, write: async () => undefined, clear: async () => undefined },
    fetch: async () => { fetchCalls++; throw new Error('Network forbidden in baseline proof'); },
  });
  const events: StoreChange[] = [];
  const options = { reader, writer, catalogue: catalogueBoundary, platform, now: () => '2026-09-28T00:00:00.000Z', dateContext: () => date, connectionGeneration: () => connection.getState().generation, onCommitted: (change: StoreChange) => events.push(change) };
  const turns = createAssistantTurnRepository(options);
  const context = createAssistantContextRepository(options);
  return { ...db, writer, turns, context, connection, events, fetchCalls: () => fetchCalls, snapshot: () => Object.fromEntries(tables.map((table) => [table, db.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) };
}
async function begin(f: Awaited<ReturnType<typeof open>>) {
  const snapshot = await f.context.readContext({ text: 'No peanuts; suggest recipes', messageId: randomUUID(), selection: { selectedRecipeId: '53262' } });
  assert.equal(snapshot.kind, 'ready', JSON.stringify(snapshot));
  if (snapshot.kind !== 'ready') assert.fail();
  const s = snapshot.value;
  const request: AssistantTurnRequest = {
    apiVersion: '2', catalogue: catalogue.identity, requestId: randomUUID(), userIntentId: randomUUID(), intentRevision: 0, conversationId: s.conversationId, conversationGeneration: s.conversationGeneration, connectionGeneration: f.connection.getState().generation, message: s.currentMessage,
    context: { history: s.history, memory: s.memory, preferences: s.preferences, referenceSets: s.referenceSets, planOccurrences: s.planOccurrences, date: s.date }, capabilities: ['saveRecipe', 'addPlan', 'savePreference'],
  };
  const saved = ready(await f.turns.beginTurn({ request, expectedConversationRevision: s.contextRevision }));
  const response: NormalAssistantTurnResponse = {
    apiVersion: '2', catalogue: request.catalogue, requestId: request.requestId, userIntentId: request.userIntentId, intentRevision: 0, conversationId: request.conversationId, conversationGeneration: request.conversationGeneration, connectionGeneration: request.connectionGeneration, preferenceRevision: request.context.preferences.revision,
    kind: 'proposal', text: 'Here are two recipes.', sources: [{ recipeId: '53262', section: 'recipe' }], referenceSets: [{ referenceSetId: randomUUID(), messageId: randomUUID(), recipeIds: ['53262', '53064'] }], proposals: [{ kind: 'saveRecipe', recipeId: '53262' }],
    memoryUpdate: { baseRevision: request.context.memory.projectionRevision, baseContextRevision: request.context.memory.baseContextRevision, reviews: request.context.memory.reviewTargetMessageIds.map((sourceMessageId) => ({ sourceMessageId, disposition: 'retain' })), entries: [{ sourceMessageId: request.message.messageId, quote: request.message.text, kind: 'constraint', scope: { kind: 'conversation' }, relations: [] }] },
  };
  return { request, input: { response, ...saved.acceptanceEnvelope } };
}

for (const seam of ['before-writer', 'final-observer'] as const) {
  test(`repaired acceptance with actual transport cancellation: ${seam}`, async () => {
    const directory = join(output, seam);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'workspace.sqlite');
    let f = await open(path);
    try {
      const { request, input } = await begin(f);
      const before = f.snapshot();
      f.events.length = 0;
      const generationBefore = f.connection.getState().generation;
      let observerReached = false;
      let observerFailed = 0;
      let observerCommitted = 0;
      if (seam === 'before-writer') f.connection.cancel();
      else f.writer.setObserver({
        begin: async () => undefined,
        beforeCommit: async () => {
          observerReached = true;
          assert.equal(f.database.prepare('SELECT count(*) AS n FROM assistant_acceptance').get()?.n, 1);
          await Promise.resolve();
          f.connection.cancel();
        },
        committed: async () => { observerCommitted++; },
        failed: () => { observerFailed++; },
      });
      const result = await f.turns.acceptResponse(input);
      const after = f.snapshot();
      const generationAfter = f.connection.getState().generation;
      const notificationCount = f.events.length;
      assert.equal(generationAfter, generationBefore + 1);
      assert.equal(result.kind, 'failed');
      if (result.kind === 'failed') assert.equal(result.error.code, 'stale_context');
      assert.deepEqual(after, before);
      assert.equal(notificationCount, 0);
      if (seam === 'final-observer') {
        assert.equal(observerReached, true);
        assert.equal(observerCommitted, 0);
        assert.equal(observerFailed, 1);
      }
      assert.equal(after.assistant_action_plan!.length, 0);
      assert.equal(after.command_slot!.length, 0);
      assert.equal(after.operation_receipt!.length, 0);
      assert.equal(f.fetchCalls(), 0);
      const trace = { seam, generationBefore, generationAfter, observerReached, observerFailed, observerCommitted, result, notificationCount, fetchCalls: f.fetchCalls(), before, after };
      await f.writer.close();
      f = await open(path);
      const reopenedBeforeRecovery = f.snapshot();
      assert.deepEqual(reopenedBeforeRecovery, after);
      await recoverInterruptedAssistantWork(f.writer, catalogueBoundary);
      const reopened = f.snapshot();
      const intent = ready(await f.turns.readIntent(request.userIntentId));
      const acceptance = ready(await f.turns.readAcceptance(request.userIntentId));
      assert.equal(intent?.intent.phase, 'cancelled');
      assert.equal(intent?.actionPlan, null);
      assert.equal(intent?.intent.slots.length, 0);
      assert.equal(acceptance, null);
      assert.equal(intent?.response, null);
      assert.equal(reopened.memory_entry!.length, 0);
      assert.equal(reopened.assistant_acceptance!.length, 0);
      assert.equal(reopened.reference_set!.length, 0);
      assert.equal(f.fetchCalls(), 0);
      await writeFile(join(directory, 'trace.json'), JSON.stringify({ ...trace, reopenedBeforeRecovery, reopened, intent, acceptance }, null, 2) + '\n');
    } finally {
      await f.writer.close();
    }
  });
}
