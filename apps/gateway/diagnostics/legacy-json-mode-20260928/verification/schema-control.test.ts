import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSchemaControl, T03_CONTROL_SCHEMA, SCHEMA_CONTROL_BOUNDS } from '../src/schema-control';
import { PROVIDER_ENVELOPE_SCHEMA } from '../src/provider-schema';
import { SYSTEM_INSTRUCTION } from '../src/provider-contract';

const model = 'gemini-3.5-flash-lite' as const;
const secret = 'FICTIONAL_PRIVATE_CREDENTIAL_AND_ERROR_TEXT';
type Capture = { url: string; body: Record<string, any>; raw: string };
const errorResponse = (code: unknown = 'invalid_request', status = 400, rpcStatus?: string) =>
  Response.json(
    {
      error: {
        code,
        message: `Invalid request. ${secret}`,
        ...(rpcStatus ? { status: rpcStatus } : {}),
      },
      apiKey: secret,
    },
    { status, headers: { 'x-private': secret } },
  );

function completed(value: unknown, extras = {}) {
  return Response.json({
    id: 'fictional-schema-control',
    model,
    status: 'completed',
    usage: { total_input_tokens: 1000, total_output_tokens: 100, total_thought_tokens: 0 },
    steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(value) }] }],
    ...extras,
  });
}

function fixture(
  respond: (capture: Capture, generation: number) => Response | Promise<Response>,
  preflight: (index: number) => Response = () => Response.json({ totalTokens: 1000 }),
) {
  const captures: Capture[] = [];
  let generations = 0;
  let preflights = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = String(init?.body ?? '');
    const capture = { url, body: JSON.parse(raw), raw };
    captures.push(capture);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal ?? (input instanceof Request ? input.signal : undefined));
    return url.endsWith(':countTokens') ? preflight(++preflights) : respond(capture, ++generations);
  };
  return { captures, run: () => runSchemaControl({ apiKey: secret, model, fetch: transport }) };
}

test('paired actual SDK requests share every input byte and change only the generation schema', async () => {
  const originalSchema = JSON.stringify(PROVIDER_ENVELOPE_SCHEMA);
  const f = fixture((_capture, generation) =>
    generation === 1
      ? errorResponse()
      : completed({ recipe_id: 'fictional', servings_known: false }),
  );
  const report = await f.run();
  assert.equal(f.captures.length, 4);
  assert.equal(report.networkRequests, 4);
  assert.deepEqual(SCHEMA_CONTROL_BOUNDS, {
    arms: 2,
    preflightsPerArm: 1,
    generationsPerArm: 1,
    networkRequests: 4,
    retries: 0,
    deadlineMsPerArm: 45000,
    inputAdmissionPerGeneration: 12000,
    outputAndThoughtPerGeneration: 2000,
  });
  const [preflightA, generationA, preflightB, generationB] = f.captures;
  assert.equal(preflightA!.raw, preflightB!.raw);
  assert.equal(generationA!.body.input, generationB!.body.input);
  assert.equal(generationA!.body.system_instruction, SYSTEM_INSTRUCTION);
  assert.deepEqual(generationB!.body.response_format.schema, T03_CONTROL_SCHEMA);
  const restored = structuredClone(generationB!.body);
  restored.response_format.schema = generationA!.body.response_format.schema;
  assert.equal(JSON.stringify(restored), generationA!.raw);
  assert.deepEqual(generationA!.body.response_format.schema, PROVIDER_ENVELOPE_SCHEMA);
  assert.equal(JSON.stringify(PROVIDER_ENVELOPE_SCHEMA), originalSchema);
  assert.equal(preflightA!.body.contents[0].parts[2].text, originalSchema);
  assert.equal(generationB!.body.model, model);
  assert.equal(generationB!.body.store, false);
  assert.equal(generationB!.body.stream, false);
  assert.deepEqual(generationB!.body.generation_config, { max_output_tokens: 2000 });
  assert.deepEqual(report.comparison, {
    preflightBodyIdentical: true,
    generationBodyIdenticalBeforeMutation: true,
    onlySchemaChanged: true,
    sameEndpointAndMethod: true,
  });
  assert.equal(
    report.requestHashes.original_schema?.preflight,
    report.requestHashes.tiny_schema_control?.preflight,
  );
  assert.notEqual(
    report.requestHashes.original_schema?.generation,
    report.requestHashes.tiny_schema_control?.generation,
  );
  assert.equal(report.conclusion, 'original_schema_implicated');
  assert.equal(report.productSuccess, false);
  assert.equal(report.arms[1]!.code, 'invalid_model_result');
  // The current adapter rejects the legacy tiny shape before exposing a step.
  // HTTP completion remains the counterfactual observation; shape metrics are unknown.
  assert.equal(report.arms[1]!.providerSchemaValid, null);
  assert.equal(report.arms[1]!.tinySchemaValid, null);
  assert.equal(report.arms[1]!.normalizationValid, null);
  assert.equal(report.arms[1]!.responseKind, null);
  assert.ok(report.arms.every((arm) => arm.preflights === 1 && arm.generations === 1));
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(report).includes('fictional-schema-control'), false);
});

test('documented access, quota, prerequisite and other known non-invalid-request errors stop the control', async () => {
  for (const code of [
    'failed_precondition',
    'authentication',
    'permission_denied',
    'payment_required',
    'quota_exceeded',
    'rate_limit_exceeded',
    'too_many_requests',
    'parameter_unknown',
    'model_not_found',
    'api_error',
  ]) {
    const f = fixture(() => errorResponse(code));
    const report = await f.run();
    assert.equal(f.captures.length, 2, code);
    assert.equal(report.arms[1]!.execution, 'NOT_RUN', code);
    assert.equal(report.conclusion, 'control_not_run', code);
  }
  for (const rpc of [
    'FAILED_PRECONDITION',
    'PERMISSION_DENIED',
    'UNAUTHENTICATED',
    'RESOURCE_EXHAUSTED',
    'UNAVAILABLE',
  ]) {
    const f = fixture(() => errorResponse(undefined, 400, rpc));
    const report = await f.run();
    assert.equal(f.captures.length, 2, rpc);
    assert.equal(report.arms[1]!.execution, 'NOT_RUN', rpc);
  }
});

test('preflight rejection or invalid token counts stop before a generation or second arm', async () => {
  for (const preflight of [
    () => errorResponse('failed_precondition'),
    () => Response.json({ totalTokens: 12000 }),
    () => Response.json({ totalTokens: -1 }),
    () => Response.json({}),
  ]) {
    const f = fixture(() => {
      throw new Error('unexpected generation');
    }, preflight);
    const report = await f.run();
    assert.equal(f.captures.length, 1);
    assert.equal(report.arms[0]!.generations, 0);
    assert.equal(report.arms[1]!.execution, 'NOT_RUN');
  }
});

test('original results other than generation400 stop without retries, including transient failures', async () => {
  for (const status of [401, 403, 404, 429, 500, 502, 503, 504]) {
    const f = fixture(() => errorResponse('unknown', status));
    const report = await f.run();
    assert.equal(f.captures.length, 2, String(status));
    assert.equal(report.arms[1]!.execution, 'NOT_RUN', String(status));
  }
  const f = fixture(() => completed({ recipe_id: 'fictional', servings_known: false }));
  const report = await f.run();
  assert.equal(f.captures.length, 2);
  assert.equal(report.arms[0]!.code, 'invalid_model_result');
  assert.equal(report.arms[1]!.execution, 'NOT_RUN');
});

test('unknown code or missing envelope permits only the bounded control; repeated400 has no loop', async () => {
  for (const first of [
    () => errorResponse(secret),
    () => new Response('non-JSON private content', { status: 400 }),
    () => errorResponse(400, 400, 'INVALID_ARGUMENT'),
  ]) {
    const f = fixture((_capture, generation) => (generation === 1 ? first() : errorResponse()));
    const report = await f.run();
    assert.equal(f.captures.length, 4);
    assert.equal(report.conclusion, 'schema_only_hypothesis_weakened');
    assert.equal(report.productSuccess, false);
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.equal(JSON.stringify(report).includes('non-JSON private content'), false);
  }
});

test('control response cannot bypass full app normalization with a wrapped wrong memory revision', async () => {
  const f = fixture((capture, generation) => {
    if (generation === 1) return errorResponse();
    const sourceId = JSON.parse(capture.body.input).request.message.messageId;
    return completed({
      step: {
        kind: 'respond',
        sufficiency: 'sufficient',
        missingFacts: [],
        memoryUpdate: {
          baseRevision: 999,
          baseContextRevision: 0,
          reviews: [{ sourceMessageId: sourceId, disposition: 'non_memory' }],
          entries: [],
        },
        response: { kind: 'answer', text: secret, sources: [], recipeIds: [] },
      },
    });
  });
  const report = await f.run();
  assert.equal(report.networkRequests, 4);
  assert.equal(report.arms[1]!.providerSchemaValid, true);
  assert.equal(report.arms[1]!.tinySchemaValid, false);
  assert.equal(report.arms[1]!.normalizationValid, false);
  assert.equal(report.arms[1]!.code, 'invalid_model_result');
  assert.equal(report.productSuccess, false);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('a new access, prerequisite or quota error in the control is inconclusive for the schema hypothesis', async () => {
  for (const response of [
    () => errorResponse('authentication'),
    () => errorResponse('failed_precondition'),
    () => errorResponse('quota_exceeded'),
    () => errorResponse('unknown', 400, 'FAILED_PRECONDITION'),
    () => errorResponse('unknown', 400, 'PERMISSION_DENIED'),
    () => errorResponse('unknown', 400, 'RESOURCE_EXHAUSTED'),
  ]) {
    const f = fixture((_capture, generation) => (generation === 1 ? errorResponse() : response()));
    const report = await f.run();
    assert.equal(f.captures.length, 4);
    assert.equal(report.conclusion, 'inconclusive');
    assert.equal(report.productSuccess, false);
  }
});

test('control preflight failures, missing completion and huge error bodies do not trigger further requests', async () => {
  const preflightFailure = fixture(
    () => errorResponse(),
    (index) =>
      index === 1 ? Response.json({ totalTokens: 1000 }) : errorResponse('quota_exceeded', 429),
  );
  const failedReport = await preflightFailure.run();
  assert.equal(preflightFailure.captures.length, 3);
  assert.equal(failedReport.conclusion, 'inconclusive');
  const incomplete = fixture((_capture, generation) =>
    generation === 1 ? errorResponse() : completed({}, { status: 'incomplete' }),
  );
  assert.equal((await incomplete.run()).conclusion, 'inconclusive');
  const huge = fixture(() => new Response(secret.repeat(10000), { status: 400 }));
  const hugeReport = await huge.run();
  assert.equal(huge.captures.length, 2);
  assert.equal(hugeReport.arms[1]!.execution, 'NOT_RUN');
  assert.equal(JSON.stringify(hugeReport).includes(secret), false);
});
