import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { createGeminiProvider } from '../src/gemini';
import { createOrchestrator } from '../src/orchestrator';
import { GatewayError } from '../src/errors';
import {
  MODEL_RESPONSE_SCHEMA,
  PROVIDER_RESPONSE_SCHEMA,
  PROVIDER_ENVELOPE_SCHEMA,
  PROVIDER_GRAMMAR_SCHEMA,
} from '../src/provider-schema';
import { nonMemoryUpdate, request } from './helpers';

const ajv = new Ajv({ strict: false });
const fullShape = ajv.compile(MODEL_RESPONSE_SCHEMA);
const projectedShape = ajv.compile(PROVIDER_RESPONSE_SCHEMA);
const model = 'gemini-3.5-flash-lite' as const;
const removedKeywords = new Set(['minLength', 'maxLength', 'pattern', 'uniqueItems']);
const invalid = (error: unknown) =>
  error instanceof GatewayError && error.detail.code === 'invalid_model_result';
const base = () => ({
  kind: 'respond',
  sufficiency: 'sufficient',
  missingFacts: [],
  memoryUpdate: nonMemoryUpdate(),
  response: { kind: 'answer', text: 'Here is the cooking context.', sources: [], recipeIds: [] },
});
const withText = (text: string) => ({ ...base(), response: { ...base().response, text } });
const preference = (explicitValue: string) => ({
  ...base(),
  response: {
    ...base().response,
    kind: 'proposal',
    proposals: [{ kind: 'savePreference', type: 'ingredient_avoid', explicitValue }],
  },
});
const retained = (scope: unknown) => ({
  ...base(),
  memoryUpdate: {
    baseRevision: 0,
    baseContextRevision: 0,
    reviews: [{ sourceMessageId: request().message.messageId, disposition: 'retain' }],
    entries: [
      { sourceMessageId: request().message.messageId, kind: 'constraint', scope, relations: [] },
    ],
  },
});
const retrieval = (criteria = {}, requiredFacts: string[] = []) => ({
  kind: 'retrieve',
  criteria,
  recipeIds: [],
  requiredFacts,
});

function actualSdk(value: unknown, wrap = true, nextValue?: unknown) {
  let calls = 0;
  let generations = 0;
  const provider = createGeminiProvider({
    apiKey: 'FICTIONAL_SCHEMA_TEST_ONLY',
    model,
    fetch: async (input, init) => {
      calls++;
      const url = input instanceof Request ? input.url : String(input);
      const body = JSON.parse(
        String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}')),
      );
      if (url.endsWith(':countTokens')) {
        assert.deepEqual(JSON.parse(body.contents[0].parts[2].text), PROVIDER_ENVELOPE_SCHEMA);
        return Response.json({ totalTokens: 1000 });
      }
      generations++;
      assert.deepEqual(body.response_format.schema, PROVIDER_ENVELOPE_SCHEMA);
      const step = generations === 1 || nextValue === undefined ? value : nextValue;
      return Response.json({
        id: 'fictional-schema-projection',
        model,
        status: 'completed',
        usage: { total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 0 },
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'text', text: JSON.stringify(wrap ? { step } : step) }],
          },
        ],
      });
    },
  });
  return {
    run: () =>
      createOrchestrator(provider)(request(), {
        signal: new AbortController().signal,
        deadline: Date.now() + 45000,
      }),
    counts: () => ({ calls, generations }),
  };
}

test('provider projection removes only the four unlisted keywords while retaining the full model shape', () => {
  const removed: string[] = [];
  const compare = (full: unknown, projected: unknown, path: string) => {
    if (Array.isArray(full)) {
      assert.ok(Array.isArray(projected), path);
      assert.equal(projected.length, full.length, path);
      full.forEach((value, index) => compare(value, projected[index], `${path}/${index}`));
      return;
    }
    if (full === null || typeof full !== 'object') {
      assert.deepEqual(projected, full, path);
      return;
    }
    assert.ok(
      projected !== null && typeof projected === 'object' && !Array.isArray(projected),
      path,
    );
    const actual = projected as Record<string, unknown>;
    const schemaNode = !path.endsWith('/properties');
    const keys = Object.keys(full);
    assert.deepEqual(
      Object.keys(actual),
      keys.filter((key) => !(schemaNode && removedKeywords.has(key))),
      path,
    );
    for (const [key, value] of Object.entries(full)) {
      if (schemaNode && removedKeywords.has(key)) removed.push(key);
      else compare(value, actual[key], `${path}/${key}`);
    }
  };
  const { type, ...projectedUnion } = PROVIDER_RESPONSE_SCHEMA;
  assert.equal(type, 'object');
  compare(MODEL_RESPONSE_SCHEMA, projectedUnion, '');
  assert.deepEqual([...new Set(removed)].sort(), [...removedKeywords].sort());
  assert.equal(removed.filter((key) => key === 'minLength').length, 26);
  assert.equal(removed.filter((key) => key === 'maxLength').length, 35);
  assert.equal(removed.filter((key) => key === 'pattern').length, 26);
  assert.equal(removed.filter((key) => key === 'uniqueItems').length, 1);
  assert.equal(Buffer.byteLength(JSON.stringify(MODEL_RESPONSE_SCHEMA)), 10192);
  assert.equal(Buffer.byteLength(JSON.stringify(projectedUnion)), 8336);
  assert.equal(Buffer.byteLength(JSON.stringify(PROVIDER_RESPONSE_SCHEMA)), 8352);
});

test('explicit root object type preserves the value set of the prior projected union', () => {
  const { type, ...priorProjection } = PROVIDER_RESPONSE_SCHEMA;
  assert.equal(type, 'object');
  assert.ok(MODEL_RESPONSE_SCHEMA.anyOf.every((branch) => branch.type === 'object'));
  const previousShape = ajv.compile(priorProjection);
  for (const value of [
    null,
    true,
    1,
    'text',
    [],
    {},
    base(),
    retrieval(),
    retained({ kind: 'conversation' }),
    preference('Italian'),
    withText('a'.repeat(8001)),
    { ...base(), unknown: true },
    { kind: 'unsupported' },
  ]) {
    assert.equal(projectedShape(value), previousShape(value));
  }
});

test('required typed envelope contains the compiled explicit-property grammar', async () => {
  assert.deepEqual(PROVIDER_ENVELOPE_SCHEMA, {
    type: 'object',
    properties: { step: PROVIDER_GRAMMAR_SCHEMA },
    required: ['step'],
    additionalProperties: false,
  });
  const envelopeShape = ajv.compile(PROVIDER_ENVELOPE_SCHEMA);
  for (const step of [
    base(),
    retrieval(),
    retained({ kind: 'conversation' }),
    preference('Italian'),
  ]) {
    assert.equal(envelopeShape({ step }), true);
    assert.equal(fullShape(step), true);
  }
  for (const wire of [
    {},
    base(),
    null,
    [],
    { step: null },
    { step: [] },
    { step: {} },
    { step: base(), extra: true },
    { result: base() },
    { step: { step: base() } },
  ]) {
    assert.equal(envelopeShape(wire), false);
    const f = actualSdk(wire, false);
    await assert.rejects(f.run(), invalid);
    assert.deepEqual(f.counts(), { calls: 2, generations: 1 });
  }
});

test('grammar-admitted wrong-branch fields reach full validation unchanged and are rejected', async () => {
  const grammarShape = ajv.compile(PROVIDER_GRAMMAR_SCHEMA);
  const withResponse = (response: object) => ({ ...base(), response });
  const withProposal = (proposal: object) =>
    withResponse({ ...base().response, kind: 'proposal', proposals: [proposal] });
  const withTarget = (target: object) => ({
    ...retained({ kind: 'conversation' }),
    memoryUpdate: {
      ...retained({ kind: 'conversation' }).memoryUpdate,
      entries: [
        {
          ...retained({ kind: 'conversation' }).memoryUpdate.entries[0],
          relations: [{ kind: 'supersedes', target }],
        },
      ],
    },
  });
  const id = request().message.messageId;
  const variants = [
    { ...retrieval(), response: base().response },
    { kind: 'retrieve' },
    { ...base(), criteria: {} },
    withResponse({ ...base().response, missing: [] }),
    withResponse({ ...base().response, proposals: [] }),
    withResponse({ ...base().response, kind: 'clarification' }),
    withResponse({
      ...base().response,
      sources: [{ recipeId: '53262', section: 'recipe', position: 1 }],
    }),
    withResponse({ ...base().response, sources: [{ recipeId: '53262', section: 'ingredient' }] }),
    retained({ kind: 'conversation', recipeIds: ['53262'] }),
    retained({ kind: 'recipes' }),
    withTarget({ kind: 'source', sourceMessageId: id, memoryId: id, expectedRevision: 0 }),
    withTarget({ kind: 'memory', memoryId: id }),
    withProposal({
      kind: 'saveRecipe',
      recipeId: '53262',
      type: 'cuisine',
      explicitValue: 'Italian',
    }),
    withProposal({
      kind: 'savePreference',
      type: 'cuisine',
      explicitValue: 'Italian',
      recipeId: '53262',
    }),
    withProposal({
      kind: 'addPlan',
      recipeId: '53262',
      placement: { actualDate: '2026-09-28', mealKey: 'dinner' },
      expectedTarget: { kind: 'empty', occurrenceId: id, expectedRevision: 0 },
    }),
  ];
  for (const value of variants) {
    const before = structuredClone(value);
    assert.equal(grammarShape(value), true, JSON.stringify(grammarShape.errors));
    assert.equal(fullShape(value), false);
    const f = actualSdk(value);
    await assert.rejects(f.run(), invalid);
    assert.deepEqual(f.counts(), { calls: 2, generations: 1 });
    assert.deepEqual(value, before);
  }
});

test('wrapped retrieval and response preserve the real two-round evidence and memory path', async () => {
  const read = { ...retrieval(), recipeIds: ['53262'], requiredFacts: ['ingredients'] };
  const reply = {
    ...retained({ kind: 'conversation' }),
    response: {
      kind: 'answer',
      text: 'The supplied recipe is Adana kebab.',
      recipeIds: ['53262'],
      sources: [{ recipeId: '53262', section: 'recipe' }],
    },
  };
  const f = actualSdk(read, true, reply);
  const result = await f.run();
  assert.equal(result.kind, 'answer');
  if (result.kind === 'answer') {
    assert.equal(result.memoryUpdate.entries[0]!.quote, request().message.text);
    assert.ok(
      result.sources.some((source) => source.recipeId === '53262' && source.section === 'recipe'),
    );
    assert.ok(result.sources.every((source) => source.recipeId === '53262'));
  }
  assert.deepEqual(f.counts(), { calls: 4, generations: 2 });
});

test('weaker provider grammar cannot admit locally forbidden lengths, patterns or duplicates', async () => {
  const variants: [string, unknown][] = [
    ['answer length', withText('a'.repeat(8001))],
    ['preference empty', preference('')],
    ['preference length', preference('a'.repeat(257))],
    [
      'memory UUID',
      {
        ...base(),
        memoryUpdate: {
          ...nonMemoryUpdate(),
          reviews: [{ sourceMessageId: 'not-a-uuid', disposition: 'non_memory' }],
        },
      },
    ],
    ['memory duplicate recipes', retained({ kind: 'recipes', recipeIds: ['53262', '53262'] })],
    ['memory recipe pattern', retained({ kind: 'recipes', recipeIds: ['not-numeric'] })],
    [
      'memory date pattern',
      retained({ kind: 'placement', placement: { actualDate: 'Tuesday', mealKey: 'dinner' } }),
    ],
    ['missing facts length', { ...base(), missingFacts: ['a'.repeat(301)] }],
    ['retrieval query length', retrieval({ query: 'a'.repeat(4001) })],
    ['retrieval ingredient length', retrieval({ ingredients: ['a'.repeat(513)] })],
    ['retrieval fact length', retrieval({}, ['a'.repeat(301)])],
    [
      'source ID pattern',
      {
        ...base(),
        response: { ...base().response, sources: [{ recipeId: 'not-numeric', section: 'recipe' }] },
      },
    ],
    [
      'proposal ID pattern',
      {
        ...base(),
        response: {
          ...base().response,
          kind: 'proposal',
          proposals: [{ kind: 'saveRecipe', recipeId: 'not-numeric' }],
        },
      },
    ],
  ];
  for (const [label, value] of variants) {
    assert.equal(projectedShape(value), true, `${label}: ${JSON.stringify(projectedShape.errors)}`);
    assert.equal(fullShape(value), false, label);
    const fixture = actualSdk(value);
    await assert.rejects(fixture.run(), invalid, label);
    assert.deepEqual(fixture.counts(), { calls: 2, generations: 1 }, label);
  }
});

test('unknown fields, malformed nested actions and source provenance still fail locally', async () => {
  const value = base();
  const variants: [string, unknown][] = [
    ['empty answer', withText('')],
    ['outer injection', { ...value, debug: true }],
    [
      'nested source injection',
      {
        ...value,
        response: {
          ...value.response,
          sources: [{ recipeId: '53262', section: 'recipe', url: 'https://example.invalid' }],
        },
      },
    ],
    [
      'unsupported action',
      {
        ...value,
        response: {
          ...value.response,
          kind: 'proposal',
          proposals: [{ kind: 'removeRecipe', recipeId: '53262' }],
        },
      },
    ],
    [
      'model quote',
      {
        ...retained({ kind: 'conversation' }),
        memoryUpdate: {
          ...retained({ kind: 'conversation' }).memoryUpdate,
          entries: [
            {
              ...retained({ kind: 'conversation' }).memoryUpdate.entries[0],
              quote: 'invented source',
            },
          ],
        },
      },
    ],
    ['empty memory recipes', retained({ kind: 'recipes', recipeIds: [] })],
    ['too many memory recipes', retained({ kind: 'recipes', recipeIds: Array(7).fill('53262') })],
    ['unknown retrieval field', retrieval({ url: 'https://example.invalid' })],
    ['too many required facts', retrieval({}, Array(9).fill('ingredients'))],
  ];
  for (const [label, output] of variants) {
    const fixture = actualSdk(output);
    await assert.rejects(fixture.run(), invalid, label);
    assert.deepEqual(fixture.counts(), { calls: 2, generations: 1 }, label);
  }
});

test('full Unicode answer boundary and valid source-linked memory still normalize through the candidate', async () => {
  const text = '🥜'.repeat(8000);
  assert.equal(fullShape(withText(text)), true);
  const response = await actualSdk(withText(text)).run();
  assert.equal(response.kind, 'answer');
  if (response.kind === 'answer') assert.equal(response.text, text);
  await assert.rejects(actualSdk(withText(text + '🥜')).run(), invalid);
  const retainedResponse = await actualSdk(retained({ kind: 'conversation' })).run();
  assert.equal(retainedResponse.kind, 'answer');
  if (retainedResponse.kind === 'answer') {
    assert.equal(retainedResponse.memoryUpdate.entries[0]!.quote, request().message.text);
    assert.equal(
      retainedResponse.memoryUpdate.entries[0]!.sourceMessageId,
      request().message.messageId,
    );
  }
});
