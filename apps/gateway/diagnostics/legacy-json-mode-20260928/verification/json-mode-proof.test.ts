import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  JSON_MODE_ENVELOPE_SCHEMA_TEXT,
  JSON_MODE_SYSTEM_INSTRUCTION,
  runJsonModeProof,
} from '../src/json-mode-proof';
import { MODEL_RESPONSE_SCHEMA, PROVIDER_ENVELOPE_SCHEMA } from '../src/provider-schema';
import { SYSTEM_INSTRUCTION } from '../src/provider-contract';
import { SMOKE_TEXT } from '../src/memory-smoke';
import { serializeSyntheticShapeDiagnostic } from '../src/synthetic-shape-diagnostic';

const model = 'gemini-3.5-flash-lite' as const;
const key = 'FICTIONAL_JSON_MODE_KEY_[literal].*+?';
const hidden = 'PRIVATE_HTTP_MESSAGE_HEADER';
type Body = Record<string, any>;
function validStep(body: Body) {
  const source = JSON.parse(body.input).request.message;
  return {
    kind: 'respond',
    sufficiency: 'sufficient',
    missingFacts: [],
    memoryUpdate: {
      baseRevision: 0,
      baseContextRevision: 0,
      reviews: [{ sourceMessageId: source.messageId, disposition: 'retain' }],
      entries: [
        {
          sourceMessageId: source.messageId,
          kind: 'constraint',
          scope: { kind: 'conversation' },
          relations: [],
        },
      ],
    },
    response: { kind: 'answer', text: 'I will remember that.', sources: [], recipeIds: [] },
  };
}
function completed(text: string, extras = {}) {
  return Response.json(
    {
      id: hidden,
      model,
      status: 'completed',
      usage: { total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 0 },
      steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
      ...extras,
    },
    { headers: { 'x-private': hidden } },
  );
}
function fixture(
  reply: (body: Body) => Response = (body) => completed(JSON.stringify({ step: validStep(body) })),
  count: unknown = 1000,
) {
  const captures: {
    url: string;
    body: Body;
    init: RequestInit;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body));
    captures.push({
      url,
      body,
      init: init ?? {},
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
    });
    return url.endsWith(':countTokens') ? Response.json({ totalTokens: count }) : reply(body);
  };
  return { captures, run: () => runJsonModeProof({ apiKey: key, model, fetch: transport }) };
}

test('JSON-mode proof counts the exact schema-bearing prompt once and preserves all other request settings', async () => {
  const frozenGrammar = JSON.stringify(PROVIDER_ENVELOPE_SCHEMA);
  const frozenFull = JSON.stringify(MODEL_RESPONSE_SCHEMA);
  const f = fixture();
  const report = await f.run();
  assert.equal(report.cases[0]!.disposition, 'PASS');
  assert.equal(report.physicalRequests, 2);
  assert.equal(report.networkRequests, 2);
  assert.equal(report.invariantFailed, false);
  assert.ok(Object.values(report.invariants).every((value) => value === true));
  assert.equal(f.captures.length, 2);
  const counted = f.captures[0]!;
  const generated = f.captures[1]!;
  assert.equal(
    counted.url,
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`,
  );
  assert.equal(generated.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.deepEqual(counted.body, {
    contents: [
      {
        role: 'user',
        parts: [{ text: JSON_MODE_SYSTEM_INSTRUCTION }, { text: generated.body.input }],
      },
    ],
  });
  assert.deepEqual(generated.body, {
    model,
    input: counted.body.contents[0]!.parts[1]!.text,
    system_instruction: JSON_MODE_SYSTEM_INSTRUCTION,
    store: false,
    stream: false,
    generation_config: { max_output_tokens: 2000 },
    response_format: { type: 'text', mime_type: 'application/json' },
  });
  assert.ok(JSON_MODE_SYSTEM_INSTRUCTION.startsWith(SYSTEM_INSTRUCTION + '\n'));
  assert.equal(JSON_MODE_SYSTEM_INSTRUCTION.split(JSON_MODE_ENVELOPE_SCHEMA_TEXT).length, 2);
  assert.deepEqual(JSON.parse(JSON_MODE_ENVELOPE_SCHEMA_TEXT), {
    type: 'object',
    properties: { step: MODEL_RESPONSE_SCHEMA },
    required: ['step'],
    additionalProperties: false,
  });
  for (const capture of f.captures) {
    assert.equal(capture.init?.redirect, 'error');
    assert.ok(capture.signal instanceof AbortSignal);
    assert.equal(JSON.stringify(capture.body).includes(key), false);
  }
  const request = JSON.parse(generated.body.input).request;
  assert.equal(request.message.text, SMOKE_TEXT);
  assert.deepEqual(request.context.history, []);
  assert.deepEqual(request.context.preferences.items, []);
  assert.deepEqual(request.context.memory.items, []);
  assert.deepEqual(request.capabilities, []);
  assert.equal(report.cases[0]!.normalizationValid, true);
  assert.equal(report.cases[0]!.exactQuote, true);
  assert.equal(report.cases[0]!.exactReview, true);
  assert.equal(report.modelOutput?.fullShapeValid, true);
  assert.equal(report.bounds.inputAdmissionPerGeneration, 12000);
  assert.equal(report.bounds.outputAndThoughtPerGeneration, 2000);
  assert.equal(report.bounds.deadlineMsPerTurn, 45000);
  assert.equal(report.bounds.networkRequests, 2);
  assert.equal(report.bounds.retries, 0);
  assert.equal(JSON.stringify(PROVIDER_ENVELOPE_SCHEMA), frozenGrammar);
  assert.equal(JSON.stringify(MODEL_RESPONSE_SCHEMA), frozenFull);
});

test('JSON parsing and exact outer envelope remain mandatory in MIME-only mode', async () => {
  for (const reply of [
    () => completed('not JSON'),
    (body: Body) => completed(JSON.stringify({ step: validStep(body), extra: true })),
    (body: Body) => completed(JSON.stringify(validStep(body))),
  ]) {
    const f = fixture(reply);
    const report = await f.run();
    assert.equal(report.cases[0]!.disposition, 'FAIL');
    assert.equal(report.cases[0]!.code, 'invalid_model_result');
    assert.equal(report.capturedOutputs, 0);
    assert.equal(f.captures.length, 2);
  }
});

test('full contract and request-aware memory rejection stay active without stripping or repair', async () => {
  for (const defect of ['wrong_branch', 'missing_required', 'wrong_source'] as const) {
    const f = fixture((body) => {
      const step: Body = validStep(body);
      if (defect === 'wrong_branch') step.criteria = {};
      if (defect === 'missing_required') delete step.memoryUpdate;
      if (defect === 'wrong_source')
        step.memoryUpdate.reviews[0].sourceMessageId = '00000000-0000-4000-8000-000000000000';
      return completed(JSON.stringify({ step }));
    });
    const report = await f.run();
    assert.equal(report.cases[0]!.disposition, 'FAIL', defect);
    assert.equal(report.cases[0]!.normalizationValid, false, defect);
    assert.equal(report.modelOutput?.fullShapeValid, defect === 'wrong_source');
    if (defect === 'wrong_branch')
      assert.deepEqual((report.modelOutput?.generatedJson as Body).criteria, {});
    if (defect === 'missing_required')
      assert.equal(
        Object.hasOwn(report.modelOutput!.generatedJson as object, 'memoryUpdate'),
        false,
      );
    assert.equal(f.captures.length, 2);
  }
});

test('admission uses the existing framing reserve and stops before generation on invalid or excessive counts', async () => {
  const atLimit = fixture(undefined, 11744);
  assert.equal((await atLimit.run()).cases[0]!.disposition, 'PASS');
  for (const count of [11745, 12000, -1, 1.5, null]) {
    const f = fixture(undefined, count);
    const report = await f.run();
    assert.equal(report.cases[0]!.disposition, 'FAIL');
    assert.equal(report.physicalRequests, 1);
    assert.equal(f.captures.length, 1);
    assert.equal(report.invariants.generationMatchedCountedPrompt, false);
  }
});

test('HTTP failures have no retry or fallback and do not retain provider errors or credentials', async () => {
  for (const status of [400, 503]) {
    const f = fixture(() =>
      Response.json({ error: { code: 'invalid_request', message: hidden + key } }, { status }),
    );
    const report = await f.run();
    assert.equal(report.cases[0]!.disposition, 'FAIL');
    assert.equal(f.captures.length, 2);
    assert.equal(report.capturedOutputs, 0);
    assert.equal(JSON.stringify(report).includes(hidden), false);
    assert.equal(JSON.stringify(report).includes(key), false);
  }
});

test('existing sanitizer, compact capture cap and provider body cap survive the transport switch', async () => {
  const redacted = await fixture(() =>
    completed(JSON.stringify({ step: { text: key, access_token: hidden } })),
  ).run();
  const saved = serializeSyntheticShapeDiagnostic(redacted);
  assert.equal(saved, JSON.stringify(redacted) + '\n');
  assert.equal(saved.includes(key), false);
  assert.equal(saved.includes(hidden), false);
  const large = await fixture(() =>
    completed(JSON.stringify({ step: { text: 'x'.repeat(40 * 1024) } })),
  ).run();
  assert.equal(large.modelOutput?.generatedJsonStatus, 'omitted_too_large');
  assert.equal(large.modelOutput?.generatedJson, null);
  const oversized = await fixture(() =>
    completed(JSON.stringify({ step: { text: 'x'.repeat(140 * 1024) } })),
  ).run();
  assert.equal(oversized.cases[0]!.disposition, 'FAIL');
  assert.equal(oversized.capturedOutputs, 0);
});

test('JSON-mode CLI refuses existing evidence before execution and preserves its bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-json-proof-'));
  const output = join(directory, 'evidence.json');
  try {
    await writeFile(output, 'retained evidence');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/gateway/diagnostics/legacy-json-mode-20260928/src/json-mode-proof.ts',
        '--execute',
        '--capture-fictional-model-json',
        '--model',
        model,
        '--output',
        output,
      ],
      {
        cwd: new URL('../../../../../', import.meta.url),
        env: { ...process.env, GEMINI_API_KEY: '' },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    assert.equal(await readFile(output, 'utf8'), 'retained evidence');
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /JSON-mode proof failed/);
  } finally {
    await rm(output, { force: true });
    await rmdir(directory);
  }
});
