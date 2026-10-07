import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assistantJsonByteLength,
  checkAssistantRequest,
  checkMemoryResponseForRequest,
  MAX_ASSISTANT_BODY_BYTES,
} from '@cookmate/contracts';
import type { ModelMemoryUpdate, UserMemorySource } from '@cookmate/contracts';
import { catalogue } from '@cookmate/catalogue';
import { createOrchestrator } from '../src/orchestrator';
import { createGateway } from '../src/server';
import { GatewayError } from '../src/errors';
import type { ModelProvider, ProviderInput } from '../src/provider-contract';
import { answer, memoryRegistry, nonMemoryUpdate, request } from './helpers';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const execution = () => ({ signal: new AbortController().signal, deadline: Date.now() + 45_000 });
const invalid = (error: unknown) =>
  error instanceof GatewayError && error.detail.code === 'invalid_model_result';
const source = (n: number, quote: string): UserMemorySource => ({
  sourceMessageId: id(n),
  sourceSequence: n,
  quote,
  sourceDateContext: { localDate: '2026-09-27', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 },
  preferenceRevisionAtSource: 0,
  preferenceLinks: [],
});
function step(memoryUpdate: unknown, kind = 'answer', text = 'Here is the cooking context.') {
  return {
    kind: 'respond',
    sufficiency: 'sufficient',
    missingFacts: [],
    memoryUpdate,
    response: {
      kind,
      text,
      recipeIds: [],
      sources: [],
      ...(kind === 'clarification' ? { missing: ['intent'] } : {}),
    },
  };
}
function fake(value: unknown) {
  const inputs: ProviderInput[] = [];
  const provider: ModelProvider = {
    async complete(input) {
      inputs.push(structuredClone(input));
      return { value, usage: { inputTokens: 100, outputTokens: 100, thoughtTokens: 0 } };
    },
  };
  return { inputs, run: createOrchestrator(provider) };
}
function backlog() {
  const input = request();
  input.message.sourceSequence = 100;
  input.message.text = 'Tuesday instead; keep the peanut restriction.  🥜';
  input.context.memory.pendingSources = [source(20, 'No peanuts; Monday. e\u0301 is verbatim.')];
  input.context.memory.reviewTargetMessageIds = [id(20), input.message.messageId];
  input.context.memory.coverage.pendingUserSourceCount = 2;
  input.context.memory.coverage.pendingWorkingSourceCount = 2;
  input.context.memory.coverage.suppliedReviewTargetCount = 2;
  const update: ModelMemoryUpdate = {
    baseRevision: 0,
    baseContextRevision: 0,
    reviews: [
      { sourceMessageId: id(20), disposition: 'retain' },
      { sourceMessageId: input.message.messageId, disposition: 'retain' },
    ],
    entries: [
      {
        sourceMessageId: id(20),
        kind: 'constraint',
        scope: { kind: 'conversation' },
        relations: [],
      },
      {
        sourceMessageId: input.message.messageId,
        kind: 'correction',
        scope: { kind: 'conversation' },
        relations: [{ kind: 'supersedes', target: { kind: 'source', sourceMessageId: id(20) } }],
      },
    ],
  };
  return { input, update };
}

test('same-call backlog correction expands exact whole USER quotes without changing source provenance', async () => {
  const { input, update } = backlog();
  const f = fake(step(update));
  const result = await f.run(input, execution());
  assert.notEqual(result.kind, 'error');
  if (result.kind === 'error') return;
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.inputs[0]!.request, input);
  assert.equal(
    result.memoryUpdate.entries[0]!.quote,
    input.context.memory.pendingSources[0]!.quote,
  );
  assert.equal(result.memoryUpdate.entries[1]!.quote, input.message.text);
  assert.deepEqual(result.memoryUpdate.entries[1]!.relations, update.entries[1]!.relations);
  assert.equal(Object.hasOwn(update.entries[0]!, 'quote'), false);
  assert.equal(checkMemoryResponseForRequest(result, input).ok, true);
});

test('retained older constraint and correction evidence stays intact beyond the recent history window', async () => {
  const input = request();
  input.message.sourceSequence = 100;
  input.context.memory.items = [
    {
      ...source(10, 'No peanuts for this dinner; Monday.'),
      memoryId: id(110),
      revision: 1,
      kind: 'constraint',
      scope: { kind: 'conversation' },
      relations: [],
    },
    {
      ...source(12, 'Tuesday instead.'),
      memoryId: id(112),
      revision: 1,
      kind: 'correction',
      scope: { kind: 'conversation' },
      relations: [
        { kind: 'supersedes', target: { kind: 'memory', memoryId: id(110), expectedRevision: 1 } },
      ],
    },
  ];
  input.context.memory.coverage.retainedEntryCount = 2;
  input.context.memory.coverage.suppliedEntryCount = 2;
  input.context.history = Array.from({ length: 20 }, (_, index) => ({
    messageId: id(index + 40),
    sourceSequence: index + 40,
    role: 'assistant' as const,
    text: 'An unrelated cooking exchange.',
  }));
  const f = fake(step(nonMemoryUpdate(input)));
  await f.run(input, execution());
  assert.deepEqual(f.inputs[0]!.request.context.memory.items, input.context.memory.items);
  assert.equal(
    f.inputs[0]!.request.context.memory.items[0]!.sourceDateContext.localDate,
    '2026-09-27',
  );
});

test('model-injected quotes, extra identity, missing reviews and malformed same-batch targets fail closed', async () => {
  const { input, update } = backlog();
  const variants: unknown[] = [
    { ...update, entries: update.entries.map((entry) => ({ ...entry, quote: 'invented' })) },
    { ...update, reviews: update.reviews.slice(0, 1) },
    { ...update, reviews: [...update.reviews, update.reviews[0]] },
    { ...update, baseContextRevision: 1 },
    { ...update, entries: [{ ...update.entries[0], memoryId: id(999) }, update.entries[1]] },
    { ...update, entries: [{ ...update.entries[0], sourceMessageId: id(999) }, update.entries[1]] },
    {
      ...update,
      entries: [
        {
          ...update.entries[0],
          relations: [
            {
              kind: 'supersedes',
              target: { kind: 'source', sourceMessageId: input.message.messageId },
            },
          ],
        },
        update.entries[1],
      ],
    },
    {
      ...update,
      entries: [
        update.entries[0],
        {
          ...update.entries[1],
          relations: [
            {
              kind: 'supersedes',
              target: { kind: 'memory', memoryId: id(999), expectedRevision: 1 },
            },
          ],
        },
      ],
    },
  ];
  for (const value of variants) {
    const f = fake(step(value));
    await assert.rejects(f.run(input, execution()), invalid);
    assert.equal(f.inputs.length, 1);
  }
});

test('unresolved review permits clarification only', async () => {
  const input = request();
  const update = {
    ...nonMemoryUpdate(input),
    reviews: [{ sourceMessageId: input.message.messageId, disposition: 'unresolved' }],
  };
  await assert.rejects(fake(step(update)).run(input, execution()), invalid);
  const clarified = await fake(step(update, 'clarification')).run(input, execution());
  assert.equal(clarified.kind, 'clarification');
});

test('a bare ambiguous ordinal clarifies before the provider and keeps every review target pending', async () => {
  const { input } = backlog();
  delete input.context.selectedRecipeId;
  input.message.text = 'the second recipe.';
  const before = structuredClone(input);
  const f = fake(null);
  const local = await f.run(input, execution());
  assert.equal(f.inputs.length, 0);
  assert.equal(local.kind, 'clarification');
  if (local.kind !== 'clarification') return;
  assert.deepEqual(
    local.memoryUpdate.reviews,
    input.context.memory.reviewTargetMessageIds.map((sourceMessageId) => ({
      sourceMessageId,
      disposition: 'unresolved',
    })),
  );
  assert.deepEqual(local.memoryUpdate.entries, []);
  assert.equal(checkMemoryResponseForRequest(local, input).ok, true);
  assert.deepEqual(input, before);
});

test('sentence-level reference clarification reaches the provider with unchanged memory provenance', async () => {
  const { input } = backlog();
  delete input.context.selectedRecipeId;
  input.message.text = 'Tell me about the second recipe.';
  const before = structuredClone(input);
  const [firstReviewTarget, ...remainingReviewTargets] =
    input.context.memory.reviewTargetMessageIds;
  const update: ModelMemoryUpdate = {
    ...nonMemoryUpdate(input),
    reviews: [
      { sourceMessageId: firstReviewTarget, disposition: 'unresolved' },
      ...remainingReviewTargets.map((sourceMessageId) => ({
        sourceMessageId,
        disposition: 'unresolved' as const,
      })),
    ],
  };
  const f = fake(step(update, 'clarification', 'Which recipe list do you mean?'));
  const result = await f.run(input, execution());
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.inputs[0]!.request, before);
  assert.equal(result.kind, 'clarification');
  if (result.kind !== 'clarification') return;
  assert.deepEqual(result.memoryUpdate.reviews, update.reviews);
  assert.deepEqual(result.memoryUpdate.entries, []);
  assert.equal(checkMemoryResponseForRequest(result, input).ok, true);
  assert.deepEqual(input, before);
});

test('removed saved choice and unrelated temporary clause retain identical provenance across history and memory', async () => {
  const input = request();
  input.message.sourceSequence = 100;
  input.message.preferenceRevisionAtSource = 2;
  input.context.preferences = { revision: 2, lastRemovalRevision: 2, items: [] };
  const original = {
    ...source(10, 'Remember Italian; no peanuts tonight.'),
    preferenceLinks: [
      {
        sourceMessageId: id(10),
        preferenceId: id(210),
        type: 'cuisine' as const,
        value: 'Italian',
        savedRevision: 1,
        removedRevision: 2,
      },
    ],
  };
  input.context.history = [
    {
      messageId: original.sourceMessageId,
      text: original.quote,
      role: 'user',
      sourceSequence: original.sourceSequence,
      sourceDateContext: original.sourceDateContext,
      preferenceRevisionAtSource: original.preferenceRevisionAtSource,
      preferenceLinks: original.preferenceLinks,
    },
  ];
  input.context.memory.items = [
    {
      ...original,
      memoryId: id(110),
      revision: 1,
      kind: 'constraint',
      scope: { kind: 'conversation' },
      relations: [],
    },
  ];
  input.context.memory.coverage.retainedEntryCount = 1;
  input.context.memory.coverage.suppliedEntryCount = 1;
  const f = fake(step(nonMemoryUpdate(input)));
  await f.run(input, execution());
  assert.deepEqual(f.inputs[0]!.request.context, input.context);
  const mismatched = structuredClone(input);
  if (mismatched.context.history[0]!.role === 'user')
    mismatched.context.history[0]!.preferenceLinks = [];
  const rejected = fake(null);
  await assert.rejects(rejected.run(mismatched, execution()), GatewayError);
  assert.equal(rejected.inputs.length, 0);
});

test('expanded reply size is bounded even when quote-free provider output and full input each fit', async () => {
  const input = request();
  input.message.sourceSequence = 100;
  input.message.text = 'x'.repeat(4000);
  input.context.memory.pendingSources = Array.from({ length: 7 }, (_, i) =>
    source(i + 10, '😀'.repeat(4000)),
  );
  input.context.memory.reviewTargetMessageIds = [
    input.message.messageId,
    ...input.context.memory.pendingSources.map((s) => s.sourceMessageId),
  ];
  Object.assign(input.context.memory.coverage, {
    pendingUserSourceCount: 8,
    pendingWorkingSourceCount: 8,
    suppliedReviewTargetCount: 8,
  });
  assert.ok(assistantJsonByteLength(input) < MAX_ASSISTANT_BODY_BYTES);
  assert.equal(checkAssistantRequest(input, catalogue.boundary).ok, true);
  const update = {
    ...nonMemoryUpdate(input),
    reviews: input.context.memory.reviewTargetMessageIds.map((sourceMessageId) => ({
      sourceMessageId,
      disposition: 'retain',
    })),
    entries: input.context.memory.reviewTargetMessageIds.map((sourceMessageId) => ({
      sourceMessageId,
      kind: 'context',
      scope: { kind: 'conversation' },
      relations: [],
    })),
  };
  const value = step(update, 'answer', '😀'.repeat(8000));
  assert.ok(assistantJsonByteLength(value) < MAX_ASSISTANT_BODY_BYTES);
  await assert.rejects(
    fake(value).run(input, execution()),
    (error: unknown) => error instanceof GatewayError && error.detail.code === 'too_large',
  );
});

test('HTTP boundary rejects invalid normalized memory even when an injected turn bypasses orchestration', async (t) => {
  const { registry } = await memoryRegistry();
  const client = await registry.issue();
  const gateway = createGateway({
    registry,
    catalogue: catalogue.boundary,
    turn: async (input) => {
      const result = answer(input);
      if (result.kind !== 'error') result.memoryUpdate.baseRevision = 999;
      return result;
    },
  });
  t.after(() => gateway.app.close());
  const reply = await gateway.app.inject({
    method: 'POST',
    url: '/v2/assistant/turn',
    headers: { authorization: `Bearer ${client.token}` },
    payload: request(),
  });
  assert.equal(reply.statusCode, 502);
  assert.equal(reply.json().error.code, 'invalid_model_result');
  assert.equal(
    (await gateway.app.inject({ method: 'POST', url: '/v1/assistant/turn', payload: request() }))
      .statusCode,
    404,
  );
});
