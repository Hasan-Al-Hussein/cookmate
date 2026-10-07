import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type {
  AnswerResponse,
  AssistantTurnRequest,
  AssistantTurnResponse,
  DateContext,
  MemoryUpdate,
  ProposalResponse,
} from '@cookmate/contracts';
import type {
  AssistantPersistencePort,
  CookMateServices,
  DirectActionInput,
  RepositoryResult,
} from '@cookmate/domain';
import { createAssistantCoordinator } from '../../mobile/src/assistant-core/coordinator';
import { AssistantCoreError } from '../../mobile/src/assistant-core/actions';
import { ConnectionError } from '../../mobile/src/connection/errors';
import type { GatewayConnection } from '../../mobile/src/connection';
import { createLocalStore } from '../../mobile/src/data/localStore';
import {
  desktopConnection,
  removeFixtureDirectory,
} from '../../../packages/domain/test/helpers/sqlite';

const platform = {
  newId: randomUUID,
  sha256: async (text: string) => createHash('sha256').update(text).digest('hex'),
};
const preferences: ProposalResponse['proposals'] = [
  { kind: 'savePreference', type: 'cuisine', explicitValue: 'Italian' },
  { kind: 'savePreference', type: 'cuisine', explicitValue: 'French' },
];

function ready<Value>(result: RepositoryResult<Value>): Value {
  if (result.kind !== 'ready') assert.fail(JSON.stringify(result.error));
  return result.value;
}

function responseBase(request: AssistantTurnRequest) {
  const [first, ...rest] = request.context.memory.reviewTargetMessageIds;
  const memoryUpdate: MemoryUpdate = {
    baseRevision: request.context.memory.projectionRevision,
    baseContextRevision: request.context.memory.baseContextRevision,
    reviews: [
      { sourceMessageId: first, disposition: 'non_memory' },
      ...rest.map((sourceMessageId) => ({ sourceMessageId, disposition: 'non_memory' as const })),
    ],
    entries: [],
  };
  return {
    apiVersion: request.apiVersion,
    catalogue: request.catalogue,
    requestId: request.requestId,
    userIntentId: request.userIntentId,
    intentRevision: request.intentRevision,
    conversationId: request.conversationId,
    conversationGeneration: request.conversationGeneration,
    connectionGeneration: request.connectionGeneration,
    preferenceRevision: request.context.preferences.revision,
    sources: [],
    referenceSets: [],
    memoryUpdate,
  };
}

function proposal(request: AssistantTurnRequest): ProposalResponse {
  return {
    ...responseBase(request),
    kind: 'proposal',
    text: 'Review the two requested preference saves.',
    proposals: structuredClone(preferences),
  };
}

function answer(request: AssistantTurnRequest, retain = false): AnswerResponse {
  const response: AnswerResponse = {
    ...responseBase(request),
    kind: 'answer',
    text: 'The temporary cooking context is noted.',
  };
  if (retain) {
    for (const review of response.memoryUpdate.reviews)
      if (review.sourceMessageId === request.message.messageId) review.disposition = 'retain';
    response.memoryUpdate.entries = [
      {
        sourceMessageId: request.message.messageId,
        quote: request.message.text,
        kind: 'constraint',
        scope: { kind: 'conversation' },
        relations: [],
      },
    ];
  }
  return response;
}

async function direct(services: CookMateServices, input: DirectActionInput) {
  const review = ready(await services.commands.reviewDirect(input));
  const command = ready(await services.commands.prepareDirect(review));
  const result = await services.commands.execute(command);
  assert.equal(result.kind, 'receipt', JSON.stringify(result));
  if (result.kind !== 'receipt') assert.fail('Expected a real committed/no-op receipt');
  assert.deepEqual(ready(await services.queries.readReceipt(command.operationId)), result.receipt);
  return { command, receipt: result.receipt };
}

/** The only synthetic boundary is the gateway. Persistence, authority, commands and receipts
 * come from the public factory against a real file and distinct read/write connections. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-coordinator-'));
  const path = join(directory, 'fixture.sqlite');
  let services: CookMateServices | undefined;
  let persistence: AssistantPersistencePort | undefined;
  let date: DateContext = {
    localDate: '2026-09-28',
    timeZone: 'Asia/Dubai',
    utcOffsetMinutes: 240,
  };
  let generation = 1;
  const requests: AssistantTurnRequest[] = [];
  let respond: (request: AssistantTurnRequest) => Promise<AssistantTurnResponse> = async (
    request,
  ) => proposal(request);
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected fixture connection operation');
  };
  const connection: GatewayConnection = {
    getState: () => ({ status: 'paired', generation }),
    restore: unused,
    health: unused,
    pair: unused,
    async turn(request) {
      requests.push(structuredClone(request));
      return respond(request);
    },
    cancel: () => {
      generation++;
    },
    forget: unused,
    revokeAndForget: unused,
  };
  t.after(async () => {
    await services?.close();
    await removeFixtureDirectory(directory);
  });
  async function open() {
    const result = await createLocalStore({
      openConnection: async () => desktopConnection(path).connection,
      platform,
      now: () => `${date.localDate}T08:00:00.000Z`,
      dateContext: () => ({ ...date }),
    });
    if (result.kind !== 'ready') assert.fail(JSON.stringify(result.error));
    services = result.services;
    persistence = services.assistant({ connectionGeneration: () => generation });
  }
  await open();
  return {
    get services() {
      assert.ok(services);
      return services;
    },
    get persistence() {
      assert.ok(persistence);
      return persistence;
    },
    requests,
    respond(next: typeof respond) {
      respond = next;
    },
    core(port = persistence) {
      assert.ok(services);
      assert.ok(port);
      return createAssistantCoordinator({
        persistence: port,
        services,
        connection,
        platform,
        currentDate: () => ({ ...date }),
      });
    },
    async reopen(nextDate?: string) {
      await services?.close();
      services = undefined;
      persistence = undefined;
      if (nextDate) date = { ...date, localDate: nextDate };
      await open();
    },
    async receiptCount() {
      const observer = desktopConnection(path).connection;
      try {
        await observer.exec('PRAGMA query_only=ON');
        const rows = await observer.all<{ count: number }>(
          'SELECT COUNT(*) AS count FROM operation_receipt',
        );
        assert.ok(rows[0]);
        return rows[0].count;
      } finally {
        await observer.close();
      }
    },
  };
}

test('factory coordinator uses actual no-op preference revision, retains exact operation IDs and never repeats effects', async (t) => {
  const f = await fixture(t);
  const seeded = await direct(f.services, {
    kind: 'savePreference',
    type: 'cuisine',
    explicitValue: 'Italian',
  });
  const before = ready(await f.services.queries.readPreferences());
  const core = f.core();
  const sent = await core.send('Save Italian and French as my cuisine preferences.');
  if (sent.kind !== 'reply' || sent.response.kind !== 'proposal') assert.fail(JSON.stringify(sent));
  const plan = await core.approve(sent.response.userIntentId, {
    source: 'explicit_user',
    proposals: sent.response.proposals,
    replacementConfirmations: [],
  });
  assert.equal(new Set(plan.slots.map((slot) => slot.operationId)).size, 2);
  assert.equal((await core.dispatch(plan.userIntentId)).summary, 'complete');
  const stored = ready(await f.persistence.readIntent(plan.userIntentId));
  assert.ok(stored);
  assert.deepEqual(
    stored.intent.slots.map((slot) => slot.command.operationId),
    plan.slots.map((slot) => slot.operationId),
  );
  for (const slot of stored.intent.slots) {
    assert.equal(slot.command.command.kind, 'savePreference');
    if (slot.command.command.kind === 'savePreference')
      assert.equal(slot.command.command.expectedPreferenceRevision, before.revision);
  }
  const receipts = await Promise.all(
    plan.slots.map(async (slot) => ready(await f.services.queries.readReceipt(slot.operationId))),
  );
  assert.ok(receipts[0]);
  assert.ok(receipts[1]);
  assert.equal(receipts[0].outcome, 'no_op');
  assert.equal(receipts[1].outcome, 'committed');
  assert.equal(receipts[0].effects[0]?.entityId, seeded.receipt.effects[0]?.entityId);
  const after = ready(await f.services.queries.readPreferences());
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.items.map((item) => item.value).sort(), ['French', 'Italian']);
  assert.equal((await core.dispatch(plan.userIntentId)).summary, 'complete');
  assert.deepEqual(ready(await f.services.queries.readPreferences()), after);
  assert.deepEqual(
    await Promise.all(
      plan.slots.map(async (slot) => ready(await f.services.queries.readReceipt(slot.operationId))),
    ),
    receipts,
  );
  await f.reopen();
  assert.deepEqual(ready(await f.services.queries.readPreferences()), after);
  assert.equal((await f.core().reconcile(plan.userIntentId)).summary, 'complete');
  assert.equal(f.requests.length, 1);
});

test('factory answer memory and exact historical acceptance survive acknowledgement loss and reopen', async (t) => {
  const f = await fixture(t);
  f.respond(async (request) => answer(request, true));
  const actual = f.persistence;
  const envelopes: Parameters<AssistantPersistencePort['acceptResponse']>[0][] = [];
  const losingAck: AssistantPersistencePort = {
    ...actual,
    async acceptResponse(input) {
      envelopes.push(structuredClone(input));
      ready(await actual.acceptResponse(input));
      throw new Error('Synthetic loss after actual acceptance commit');
    },
  };
  const failed = await f.core(losingAck).send('Only twenty minutes for dinner today.');
  if (failed.kind !== 'failed' || !failed.acceptanceRetry) assert.fail(JSON.stringify(failed));
  const retry = failed.acceptanceRetry;
  const acknowledgement = ready(await actual.readAcceptance(retry.userIntentId));
  assert.ok(acknowledgement);
  assert.deepEqual(envelopes[0], {
    response: retry.response,
    ...acknowledgement.acceptanceEnvelope,
  });
  assert.equal(ready(await actual.readMemoryPage()).items.length, 1);
  await f.reopen('2026-09-29');
  const phase = ready(await f.persistence.readIntent(retry.userIntentId))?.intent.phase;
  const core = f.core();
  const replay = await core.retryAcceptance(retry.userIntentId, retry.response);
  if (replay.kind !== 'reply') assert.fail(JSON.stringify(replay));
  assert.equal(replay.historicalAcknowledgement, true);
  assert.deepEqual(ready(await f.persistence.readAcceptance(retry.userIntentId)), acknowledgement);
  assert.equal(ready(await f.persistence.readIntent(retry.userIntentId))?.intent.phase, phase);
  const existing = await core.retryTurn(retry.userIntentId);
  assert.equal(existing.kind, 'reply');
  const changed = structuredClone(retry.response);
  if (changed.kind === 'error') assert.fail('Expected normal accepted response');
  changed.text += ' Changed payload.';
  const rejected = await core.retryAcceptance(retry.userIntentId, changed);
  if (rejected.kind !== 'failed') assert.fail(JSON.stringify(rejected));
  assert.equal(rejected.error.code, 'operation_conflict');
  assert.equal(f.requests.length, 1);
  const messages = ready(await f.persistence.readConversation()).messages;
  assert.equal(messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 1);
  const memory = ready(await f.persistence.readMemoryPage()).items;
  assert.equal(memory.length, 1);
  assert.equal(memory[0]?.quote, f.requests[0]?.message.text);
});

test('cancelled proposal acceptance replay cannot restore confirmation or dispatch authority after reopen', async (t) => {
  const f = await fixture(t);
  const actual = f.persistence;
  const before = ready(await f.services.queries.readPreferences());
  assert.equal(before.items.length, 0);
  assert.equal(await f.receiptCount(), 0);
  const losingAck: AssistantPersistencePort = {
    ...actual,
    async acceptResponse(input) {
      ready(await actual.acceptResponse(input));
      throw new Error('Synthetic loss after actual proposal acceptance commit');
    },
  };
  const failed = await f.core(losingAck).send('Save Italian and French cuisine preferences.');
  if (failed.kind !== 'failed' || !failed.acceptanceRetry) assert.fail(JSON.stringify(failed));
  const retry = failed.acceptanceRetry;
  if (retry.response.kind !== 'proposal') assert.fail('Expected an accepted proposal');
  const acknowledged = ready(await actual.readAcceptance(retry.userIntentId));
  const confirmable = ready(await actual.readIntent(retry.userIntentId));
  assert.ok(acknowledged);
  assert.ok(confirmable);
  assert.equal(acknowledged.intent.phase, 'confirmation');
  assert.equal(confirmable.intent.phase, 'confirmation');
  assert.equal(confirmable.actionPlan, null);
  assert.equal(confirmable.intent.slots.length, 0);

  await f.reopen();
  const cancelled = ready(await f.persistence.readIntent(retry.userIntentId));
  assert.ok(cancelled);
  assert.equal(cancelled.intent.phase, 'cancelled');
  const core = f.core();
  const replay = await core.retryAcceptance(retry.userIntentId, retry.response);
  if (replay.kind !== 'reply') assert.fail(JSON.stringify(replay));
  assert.equal(replay.historicalAcknowledgement, true);
  assert.deepEqual(replay.response, acknowledged.response);
  const recovered = await core.readAcceptance(retry.userIntentId);
  if (recovered?.kind !== 'reply') assert.fail(JSON.stringify(recovered));
  assert.equal(recovered.historicalAcknowledgement, true);
  assert.deepEqual(ready(await f.persistence.readAcceptance(retry.userIntentId)), acknowledged);
  assert.deepEqual(ready(await f.persistence.readIntent(retry.userIntentId)), cancelled);

  await assert.rejects(
    core.approve(retry.userIntentId, {
      source: 'explicit_user',
      proposals: retry.response.proposals,
      replacementConfirmations: [],
    }),
    (error: unknown) =>
      error instanceof AssistantCoreError && error.detail.code === 'stale_context',
  );
  await assert.rejects(
    core.dispatch(retry.userIntentId),
    (error: unknown) =>
      error instanceof AssistantCoreError && error.detail.code === 'invalid_input',
  );
  assert.deepEqual(ready(await f.persistence.readIntent(retry.userIntentId)), cancelled);
  assert.equal(await f.receiptCount(), 0);
  assert.deepEqual(ready(await f.services.queries.readPreferences()), before);
  assert.equal(f.requests.length, 1);
});

for (const lostAt of ['begin', 'failure'] as const) {
  test(`factory retained-ID retry after ${lostAt} acknowledgement loss and reopen keeps one USER and exact frozen request`, async (t) => {
    const f = await fixture(t);
    const actual = f.persistence;
    const wrapped: AssistantPersistencePort = {
      ...actual,
      async beginTurn(input) {
        const result = await actual.beginTurn(input);
        ready(result);
        if (lostAt === 'begin') throw new Error('Synthetic loss after actual begin commit');
        return result;
      },
      async recordTurnFailure(input) {
        const result = await actual.recordTurnFailure(input);
        ready(result);
        if (lostAt === 'failure')
          throw new Error('Synthetic loss after actual failure journal commit');
        return result;
      },
    };
    f.respond(async () => {
      throw new ConnectionError({
        code: 'network_unavailable',
        messageKey: 'test.offline',
        retry: 'after_reconnect',
      });
    });
    const failed = await f.core(wrapped).send('Find a recipe for this evening.');
    if (failed.kind !== 'failed' || !failed.userIntentId) assert.fail(JSON.stringify(failed));
    const intentId = failed.userIntentId;
    const original = ready(await actual.readIntent(intentId));
    assert.ok(original);
    assert.equal(f.requests.length, lostAt === 'begin' ? 0 : 1);
    assert.equal(
      ready(await actual.readConversation()).messages.filter((message) => message.role === 'user')
        .length,
      1,
    );
    await f.reopen();
    f.respond(async (request) => answer(request));
    const core = f.core();
    const retried = await core.retryTurn(intentId);
    if (retried.kind !== 'reply') assert.fail(JSON.stringify(retried));
    assert.equal(f.requests.length, lostAt === 'begin' ? 1 : 2);
    for (const request of f.requests) assert.deepEqual(request, original.request);
    const stored = ready(await f.persistence.readIntent(intentId));
    assert.ok(stored);
    assert.deepEqual(stored.request, original.request);
    assert.deepEqual(stored.acceptanceEnvelope, original.acceptanceEnvelope);
    const messages = ready(await f.persistence.readConversation()).messages;
    assert.equal(messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(
      messages.find((message) => message.role === 'user')?.messageId,
      original.request.message.messageId,
    );
    assert.equal(messages.filter((message) => message.role === 'assistant').length, 1);
    assert.equal((await core.retryTurn(intentId)).kind, 'reply');
    assert.equal(f.requests.length, lostAt === 'begin' ? 1 : 2);
    await f.reopen();
    assert.deepEqual(ready(await f.persistence.readIntent(intentId))?.request, original.request);
  });
}

test('unrelated direct preference commit after first receipt rejects second finalization without widening the approved plan', async (t) => {
  const f = await fixture(t);
  const actual = f.persistence;
  const executed: string[] = [];
  const interveningOperations: string[] = [];
  const wrapped: AssistantPersistencePort = {
    ...actual,
    async executeIntentSlot(input) {
      executed.push(input.slotId);
      const result = await actual.executeIntentSlot(input);
      if (executed.length === 1 && result.kind === 'receipt') {
        const intervening = await direct(f.services, {
          kind: 'savePreference',
          type: 'cuisine',
          explicitValue: 'Japanese',
        });
        interveningOperations.push(intervening.command.operationId);
      }
      return result;
    },
  };
  const core = f.core(wrapped);
  const sent = await core.send('Save Italian and French as cuisine preferences.');
  if (sent.kind !== 'reply' || sent.response.kind !== 'proposal') assert.fail(JSON.stringify(sent));
  const plan = await core.approve(sent.response.userIntentId, {
    source: 'explicit_user',
    proposals: sent.response.proposals,
    replacementConfirmations: [],
  });
  const result = await core.dispatch(plan.userIntentId);
  assert.equal(result.summary, 'partial');
  assert.equal(result.results.slots[0]?.result.kind, 'receipt');
  const second = result.results.slots[1]?.result;
  assert.equal(second?.kind, 'failed');
  if (second?.kind === 'failed') assert.equal(second.error.code, 'stale_context');
  assert.deepEqual(executed, [plan.slots[0]!.slotId]);
  const saved = ready(await actual.readIntent(plan.userIntentId));
  assert.ok(saved);
  assert.deepEqual(saved.actionPlan, plan);
  assert.equal(saved.intent.slots.length, 1);
  assert.ok(ready(await f.services.queries.readReceipt(plan.slots[0]!.operationId)));
  assert.equal(ready(await f.services.queries.readReceipt(plan.slots[1]!.operationId)), null);
  assert.ok(ready(await f.services.queries.readReceipt(interveningOperations[0]!)));
  const after = ready(await f.services.queries.readPreferences());
  assert.deepEqual(after.items.map((item) => item.value).sort(), ['Italian', 'Japanese']);
  assert.equal((await core.dispatch(plan.userIntentId)).summary, 'partial');
  assert.deepEqual(executed, [plan.slots[0]!.slotId]);
  assert.deepEqual(ready(await f.services.queries.readPreferences()), after);
  await f.reopen();
  assert.equal((await f.core().reconcile(plan.userIntentId)).summary, 'partial');
  assert.deepEqual(ready(await f.services.queries.readPreferences()), after);
  assert.equal(ready(await f.services.queries.readReceipt(plan.slots[1]!.operationId)), null);
});

test('ready finalized and reserved slots remain uncertain until reopen proves durable cancellation and no effects', async (t) => {
  const f = await fixture(t);
  const core = f.core();
  const sent = await core.send('Save Italian and French as cuisine preferences.');
  if (sent.kind !== 'reply' || sent.response.kind !== 'proposal') assert.fail(JSON.stringify(sent));
  const plan = await core.approve(sent.response.userIntentId, {
    source: 'explicit_user',
    proposals: sent.response.proposals,
    replacementConfirmations: [],
  });
  const readyIntent = ready(await f.persistence.readIntent(plan.userIntentId));
  assert.ok(readyIntent);
  assert.equal(readyIntent.intent.slots.length, 0);
  assert.equal((await core.reconcile(plan.userIntentId)).summary, 'uncertain');
  ready(
    await f.persistence.finalizeNextIntentSlot({
      userIntentId: plan.userIntentId,
      expectedIntentRevision: readyIntent.intent.revision,
      slotId: plan.slots[0]!.slotId,
    }),
  );
  const finalized = ready(await f.persistence.readIntent(plan.userIntentId));
  assert.ok(finalized);
  assert.equal(finalized.intent.slots.length, 1);
  const before = ready(await f.persistence.readActionRecovery(plan.userIntentId));
  assert.ok(before);
  assert.deepEqual(
    before.slots.map((slot) => slot.outcome),
    ['unresolved', 'unresolved'],
  );
  assert.equal((await core.reconcile(plan.userIntentId)).summary, 'uncertain');
  assert.equal(await f.receiptCount(), 0);

  await f.reopen();
  const restored = ready(await f.persistence.readIntent(plan.userIntentId));
  assert.ok(restored);
  assert.equal(restored.intent.phase, 'cancelled');
  const proof = ready(await f.persistence.readActionRecovery(plan.userIntentId));
  assert.ok(proof);
  assert.deepEqual(
    proof.slots.map((slot) => slot.outcome),
    ['not_executed', 'not_executed'],
  );
  const recovery = await f.core().reconcile(plan.userIntentId);
  assert.equal(recovery.summary, 'failed');
  for (const [index, slot] of recovery.results.slots.entries()) {
    assert.equal(slot.slotId, plan.slots[index]!.slotId);
    assert.equal(slot.result.kind, 'failed');
    if (slot.result.kind === 'failed') {
      assert.equal(slot.result.operationId, plan.slots[index]!.operationId);
      assert.equal(slot.result.error.code, 'cancelled');
      assert.equal(slot.result.error.messageKey, 'assistant.not_dispatched');
    }
  }
  assert.equal(await f.receiptCount(), 0);
  assert.deepEqual(ready(await f.services.queries.readPreferences()).items, []);
  assert.deepEqual(ready(await f.persistence.readIntent(plan.userIntentId)), restored);
  const readOnlyCore = f.core({
    ...f.persistence,
    async finalizeNextIntentSlot() {
      assert.fail('Restored cancelled dispatch must not finalize');
    },
    async executeIntentSlot() {
      assert.fail('Restored cancelled dispatch must not execute');
    },
  });
  assert.deepEqual(await readOnlyCore.dispatch(plan.userIntentId), recovery);
  assert.equal(await f.receiptCount(), 0);
  assert.deepEqual(ready(await f.persistence.readIntent(plan.userIntentId)), restored);
  assert.equal(f.requests.length, 1);
});

test('lost execution acknowledgement reconciles the real receipt and proves the remaining absence only after cancellation', async (t) => {
  const f = await fixture(t);
  const actual = f.persistence;
  let dispatched = 0;
  const lostAck: AssistantPersistencePort = {
    ...actual,
    async executeIntentSlot(input) {
      dispatched++;
      const result = await actual.executeIntentSlot(input);
      assert.equal(result.kind, 'receipt');
      throw new Error('Synthetic acknowledgement loss after actual effect and journal commit');
    },
  };
  const core = f.core(lostAck);
  const sent = await core.send('Save Italian and French as cuisine preferences.');
  if (sent.kind !== 'reply' || sent.response.kind !== 'proposal') assert.fail(JSON.stringify(sent));
  const plan = await core.approve(sent.response.userIntentId, {
    source: 'explicit_user',
    proposals: sent.response.proposals,
    replacementConfirmations: [],
  });
  assert.equal((await core.dispatch(plan.userIntentId)).summary, 'uncertain');
  assert.equal(dispatched, 1);
  const receipt = ready(await f.services.queries.readReceipt(plan.slots[0]!.operationId));
  assert.ok(receipt);
  assert.equal(ready(await f.services.queries.readReceipt(plan.slots[1]!.operationId)), null);
  const unresolved = ready(await actual.readActionRecovery(plan.userIntentId));
  assert.ok(unresolved);
  assert.deepEqual(
    unresolved.slots.map((slot) => slot.outcome),
    ['receipt', 'unresolved'],
  );
  assert.equal((await core.reconcile(plan.userIntentId)).summary, 'uncertain');

  await core.cancel(plan.userIntentId);
  const recovery = await core.reconcile(plan.userIntentId);
  assert.equal(recovery.summary, 'partial');
  assert.deepEqual(recovery.results.slots[0]!.result, { kind: 'receipt', receipt });
  assert.equal(recovery.results.slots[1]!.result.kind, 'failed');
  assert.equal(await f.receiptCount(), 1);
  assert.deepEqual(
    ready(await f.services.queries.readPreferences()).items.map((item) => item.value),
    ['Italian'],
  );
  await f.reopen();
  assert.deepEqual(await f.core().reconcile(plan.userIntentId), recovery);
  assert.equal(dispatched, 1);
  assert.equal(await f.receiptCount(), 1);
  assert.equal(f.requests.length, 1);
});
