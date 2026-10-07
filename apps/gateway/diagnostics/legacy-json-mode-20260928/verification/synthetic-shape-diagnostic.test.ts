import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  runSyntheticShapeDiagnostic,
  serializeSyntheticShapeDiagnostic,
} from '../src/synthetic-shape-diagnostic';
import { runMemorySmoke, SMOKE_TEXT } from '../src/memory-smoke';
import { PROVIDER_ENVELOPE_SCHEMA } from '../src/provider-schema';
import { SYSTEM_INSTRUCTION } from '../src/provider-contract';

const model = 'gemini-3.5-flash-lite' as const;
const key = 'FICTIONAL_SHAPE_API_KEY_[literal].*+?';
const hiddenHttp = 'PRIVATE_HTTP_ENVELOPE_AND_HEADERS';
function completed(value: unknown) {
  return Response.json(
    {
      id: 'private-http-id',
      model,
      status: 'completed',
      usage: { total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 0 },
      apiKey: hiddenHttp,
      headers: { authorization: hiddenHttp },
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'text', text: JSON.stringify({ step: value }) }],
        },
      ],
    },
    { headers: { 'x-private': hiddenHttp } },
  );
}
function validModel(body: Record<string, any>) {
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
    response: {
      kind: 'answer',
      text: 'I will keep that temporary constraint in mind.',
      sources: [],
      recipeIds: [],
    },
  };
}
function fixture(reply: (body: Record<string, any>) => Response) {
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    calls++;
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(
      String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}')),
    );
    if (url.endsWith(':countTokens')) {
      assert.deepEqual(JSON.parse(body.contents[0].parts[2].text), PROVIDER_ENVELOPE_SCHEMA);
      return Response.json({ totalTokens: 1000 });
    }
    assert.deepEqual(body.response_format.schema, PROVIDER_ENVELOPE_SCHEMA);
    assert.equal(body.system_instruction, SYSTEM_INSTRUCTION);
    const request = JSON.parse(body.input).request;
    assert.equal(request.message.text, SMOKE_TEXT);
    assert.deepEqual(request.context.history, []);
    assert.deepEqual(request.context.preferences.items, []);
    assert.deepEqual(request.context.memory.items, []);
    assert.deepEqual(request.capabilities, []);
    return reply(body);
  };
  return {
    transport,
    calls: () => calls,
    run: () => runSyntheticShapeDiagnostic({ apiKey: key, model, fetch: transport }),
  };
}

test('fixed fictional shape diagnostic captures only redacted generated JSON with strict rejection unchanged', async () => {
  const genericKey = 'AIza' + 'a'.repeat(35);
  const generated = {
    response: { kind: 'answer', text: `Untrusted fixture text ${key} ${genericKey}` },
    [key]: 'a model property',
    nested: {
      access_token: 'VERY_PRIVATE_TOKEN',
      prose: 'Bearer FICTIONAL_BEARER_TOKEN_1234567890',
    },
  };
  const f = fixture(() => completed(generated));
  const report = await f.run();
  assert.equal(f.calls(), 2);
  assert.equal(report.bounds.networkRequests, 2);
  assert.equal(report.bounds.retries, 0);
  assert.equal(report.bounds.deadlineMsPerTurn, 45000);
  assert.equal(report.capturedOutputs, 1);
  assert.equal(report.generatedJsonIsUntrustedData, true);
  assert.equal(report.modelOutput?.projectedShapeValid, false);
  assert.equal(report.modelOutput?.fullShapeValid, false);
  assert.equal(report.modelOutput?.kind, 'unknown');
  assert.equal(report.modelOutput?.generatedJsonStatus, 'included');
  assert.ok(report.modelOutput?.errors.some((error) => error.keyword === 'required'));
  assert.ok(report.modelOutput!.errors.length <= 16);
  assert.equal(report.cases[0]!.disposition, 'FAIL');
  assert.equal(report.cases[0]!.code, 'invalid_model_result');
  assert.equal(report.cases[0]!.normalizationValid, null);
  const saved = JSON.stringify(report);
  for (const secret of [
    key,
    genericKey,
    'VERY_PRIVATE_TOKEN',
    'FICTIONAL_BEARER_TOKEN_1234567890',
    hiddenHttp,
    'private-http-id',
  ])
    assert.equal(saved.includes(secret), false, secret);
  assert.ok(saved.includes('Untrusted fixture text'));
});

test('HTTP failure/transient failure never captures envelope or retries, and output capture stays capped', async () => {
  for (const status of [400, 503]) {
    const f = fixture(() =>
      Response.json(
        { error: { code: 'invalid_request', message: hiddenHttp }, modelJson: { apiKey: key } },
        { status },
      ),
    );
    const report = await f.run();
    assert.equal(f.calls(), 2);
    assert.equal(report.modelOutput, null);
    assert.equal(report.capturedOutputs, 0);
    assert.equal(JSON.stringify(report).includes(hiddenHttp), false);
    assert.equal(JSON.stringify(report).includes(key), false);
  }
  const large = fixture(() => completed({ text: 'x'.repeat(40 * 1024) }));
  const report = await large.run();
  assert.equal(large.calls(), 2);
  assert.equal(report.modelOutput?.generatedJson, null);
  assert.equal(report.modelOutput?.generatedJsonStatus, 'omitted_too_large');
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 16 * 1024);
  const tooLargeForProvider = fixture(() => completed({ text: 'x'.repeat(140 * 1024) }));
  const oversized = await tooLargeForProvider.run();
  assert.equal(tooLargeForProvider.calls(), 2);
  assert.equal(oversized.modelOutput, null);
});

test('valid synthetic shape still reaches exact-source normalization; ordinary smoke does not retain generated content', async () => {
  const f = fixture((body) => completed(validModel(body)));
  const report = await f.run();
  assert.equal(report.cases[0]!.disposition, 'PASS');
  assert.equal(report.cases[0]!.normalizationValid, true);
  assert.equal(report.modelOutput?.projectedShapeValid, true);
  assert.equal(report.modelOutput?.fullShapeValid, true);
  assert.equal(report.modelOutput?.kind, 'respond');
  const ordinary = await runMemorySmoke({ apiKey: key, models: [model], fetch: f.transport });
  assert.equal(ordinary.cases[0]!.disposition, 'PASS');
  assert.equal(
    JSON.stringify(ordinary).includes('I will keep that temporary constraint in mind.'),
    false,
  );
});

test('saved evidence uses the exact compact representation checked against the capture byte limit', async () => {
  const generated = { a: { b: Array(3000).fill(null) } };
  assert.ok(Buffer.byteLength(JSON.stringify(generated, null, 2)) > 32 * 1024);
  const f = fixture(() => completed(generated));
  const report = await f.run();
  assert.equal(report.modelOutput?.generatedJsonStatus, 'included');
  const compact = JSON.stringify(report.modelOutput?.generatedJson);
  assert.equal(Buffer.byteLength(compact), report.modelOutput?.generatedJsonBytes);
  assert.ok(Buffer.byteLength(compact) <= 32 * 1024);
  const saved = serializeSyntheticShapeDiagnostic(report);
  assert.equal(saved, JSON.stringify(report) + '\n');
  assert.ok(saved.includes('"generatedJson":' + compact));
  assert.deepEqual(JSON.parse(saved).modelOutput.generatedJson, generated);
});

test('smoke observation is detached and exceptions cannot alter provider values or validation', async () => {
  const f = fixture((body) => completed(validModel(body)));
  let observations = 0;
  const report = await runMemorySmoke({
    apiKey: key,
    models: [model],
    fetch: f.transport,
    observeModelOutput(value) {
      observations++;
      (value as { kind: string }).kind = 'injected';
      throw new Error(key);
    },
  });
  assert.equal(observations, 1);
  assert.equal(report.cases[0]!.disposition, 'PASS');
  assert.equal(JSON.stringify(report).includes(key), false);
});
