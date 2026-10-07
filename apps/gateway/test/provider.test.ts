import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTask } from 'node:timers/promises';
import { createGeminiProvider, mapProviderError } from '../src/gemini';
import type { ProviderDiagnostic } from '../src/gemini';
import { createOrchestrator, createProviderBudget } from '../src/orchestrator';
import { createEvidenceBuilder } from '../src/evidence';
import { GatewayError, gatewayError } from '../src/errors';
import type { ProviderInput } from '../src/provider-contract';
import { SYSTEM_INSTRUCTION } from '../src/provider-contract';
import { MODEL_ENVELOPE_SCHEMA_TEXT } from '../src/provider-schema';
import { request, deferred } from './helpers';
import { createProviderPhysicalAdmission } from '../src/provider-physical-admission';
import type { ProviderPhysicalAdmission } from '../src/provider-physical-admission';

const model = 'gemini-3.5-flash-lite' as const;
const marker = 'FICTIONAL_PROVIDER_KEY_DO_NOT_LOG';
type Capture = { url: URL; init: RequestInit; body: Record<string, unknown>; rawBody: string };
function wire(value: unknown = { kind: 'fixture' }, extras = {}) {
  return {
    id: 'fictional-interaction',
    model,
    status: 'completed',
    steps: [
      { type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ step: value }) }] },
    ],
    usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 0 },
    ...extras,
  };
}
function fixture(
  respond: (capture: Capture, index: number) => Response | Promise<Response> = () =>
    Response.json(wire()),
  options: {
    totalTokens?: unknown;
    now?: () => number;
    physicalAdmission?: ProviderPhysicalAdmission;
    onDiagnostic?(event: ProviderDiagnostic): void;
  } = {},
) {
  const captures: Capture[] = [];
  const diagnostics: ProviderDiagnostic[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const rawBody = String(
      init?.body ?? (input instanceof Request ? await input.clone().text() : '{}'),
    );
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const capture = { url, init: init ?? {}, body, rawBody };
    captures.push(capture);
    if (url.pathname.endsWith(':countTokens'))
      return Response.json({
        totalTokens: Object.hasOwn(options, 'totalTokens') ? options.totalTokens : 200,
      });
    return respond(
      capture,
      captures.filter((item) => item.url.pathname.endsWith('/interactions')).length,
    );
  };
  const provider = createGeminiProvider({
    apiKey: marker,
    model,
    fetch: transport,
    ...(options.now ? { now: options.now } : {}),
    ...(options.physicalAdmission ? { physicalAdmission: options.physicalAdmission } : {}),
    onDiagnostic: (event) => {
      diagnostics.push(event);
      options.onDiagnostic?.(event);
    },
  });
  const input: ProviderInput = {
    request: request(),
    evidence: createEvidenceBuilder().packet(['53262']),
    retrieval: [],
    remainingRetrievalRounds: 1,
  };
  const budget = createProviderBudget();
  const controller = new AbortController();
  const run = () =>
    provider.complete(input, {
      budget,
      signal: controller.signal,
      deadline: (options.now?.() ?? Date.now()) + 45_000,
    });
  return { captures, diagnostics, provider, input, budget, controller, run };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof GatewayError && error.detail.code === expected;

const admissionRejected =
  (seconds: number, expected: 'busy' | 'quota' = 'busy') =>
  (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.detail.code, expected);
    assert.equal(error.detail.retry, 'after_delay');
    assert.equal(error.detail.retryAfterSeconds, seconds);
    return true;
  };

test('shared physical admission counts preflight and generation across provider sessions without queuing', async () => {
  let now = 0;
  const physicalAdmission = createProviderPhysicalAdmission({
    requestsPerMinute: 5,
    now: () => now,
  });
  const sessions = Array.from({ length: 4 }, () => fixture(undefined, { physicalAdmission }));
  await sessions[0]!.run();
  await sessions[1]!.run();
  await assert.rejects(sessions[2]!.run(), admissionRejected(60));
  await assert.rejects(sessions[3]!.run(), admissionRejected(60));
  assert.deepEqual(
    sessions.map((session) => session.captures.length),
    [2, 2, 1, 0],
  );
  assert.ok(sessions.every((session) => session.budget.retries === 0));
  now = 60_000;
  assert.equal(sessions[3]!.captures.length, 0); // Advancing time never dispatches queued work.
  const resumed = fixture(undefined, { physicalAdmission });
  await resumed.run();
  assert.equal(resumed.captures.length, 2);
});

test('cancellation from the last request observer does not consume physical admission', async () => {
  const physicalAdmission = createProviderPhysicalAdmission({ requestsPerMinute: 2, now: () => 0 });
  const cancelled = fixture(undefined, {
    physicalAdmission,
    onDiagnostic(event) {
      if (event.stage === 'http_request')
        cancelled.controller.abort(gatewayError('cancelled', 499, 'never'));
    },
  });
  await assert.rejects(cancelled.run(), code('cancelled'));
  assert.equal(cancelled.captures.length, 0);
  const next = fixture(undefined, { physicalAdmission });
  await next.run();
  assert.equal(next.captures.length, 2);
});

test('transport errors and eligible retries remain charged at actual transport invocation', async () => {
  for (const limit of [2, 3]) {
    const physicalAdmission = createProviderPhysicalAdmission({
      requestsPerMinute: limit,
      now: () => 0,
    });
    const retried = fixture(
      (_capture, index) =>
        index === 1
          ? Response.json(
              { error: { code: 'service_unavailable', message: marker } },
              { status: 503 },
            )
          : Response.json(wire()),
      { physicalAdmission },
    );
    if (limit === 3) await retried.run();
    else await assert.rejects(retried.run(), admissionRejected(60));
    assert.equal(retried.captures.length, limit);
    assert.equal(retried.budget.retries, 1);
    const next = fixture(undefined, { physicalAdmission });
    await assert.rejects(next.run(), admissionRejected(60));
    assert.equal(next.captures.length, 0);
  }
  const physicalAdmission = createProviderPhysicalAdmission({ requestsPerMinute: 2, now: () => 0 });
  const failed = fixture(
    () => {
      throw new Error(marker);
    },
    { physicalAdmission },
  );
  await assert.rejects(failed.run(), code('provider_unavailable'));
  assert.equal(failed.captures.length, 2);
  assert.equal(failed.budget.retries, 0);
  const next = fixture(undefined, { physicalAdmission });
  await assert.rejects(next.run(), admissionRejected(60));
  assert.equal(next.captures.length, 0);
});

test('a dispatched429 shares cooldown before a stalled body is read or canceled', async () => {
  let now = 0,
    canceled = 0;
  const headerSeen = deferred<void>();
  const physicalAdmission = createProviderPhysicalAdmission({
    requestsPerMinute: 100,
    now: () => now,
  });
  const blocked = fixture(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        }),
        { status: 429, headers: { 'retry-after': '20' } },
      ),
    {
      physicalAdmission,
      onDiagnostic(event) {
        if (event.stage === 'http_response' && event.httpStatus === 429) headerSeen.resolve();
      },
    },
  );
  const pending = blocked.run();
  await headerSeen.promise;
  const next = fixture(undefined, { physicalAdmission });
  await assert.rejects(next.run(), admissionRejected(20, 'quota'));
  assert.equal(next.captures.length, 0);
  blocked.controller.abort(gatewayError('cancelled', 499, 'never'));
  await assert.rejects(pending, code('cancelled'));
  assert.equal(canceled, 1);
  assert.equal(blocked.captures.length, 2);
  now = 19_999;
  await assert.rejects(
    fixture(undefined, { physicalAdmission }).run(),
    admissionRejected(1, 'quota'),
  );
  now = 20_000;
  const resumed = fixture(undefined, { physicalAdmission });
  await resumed.run();
  assert.equal(resumed.captures.length, 2);
});

test('shared429 cooldown uses missing-hint fallback, preserves zero and reuses HTTP-date normalization', async () => {
  const wallTime = Date.parse('2026-09-30T10:00:00.500Z');
  for (const [hint, seconds] of [
    [undefined, 60],
    ['PRIVATE_HINT', 60],
    ['0', 0],
    ['9', 9],
    ['Wed, 30 Sep 2026 10:00:08 GMT', 8],
  ] as const) {
    const physicalAdmission = createProviderPhysicalAdmission({
      requestsPerMinute: 100,
      now: () => 0,
    });
    const blocked = fixture(
      () =>
        Response.json(
          { error: { code: 'too_many_requests', message: marker } },
          { status: 429, headers: hint === undefined ? {} : { 'retry-after': hint } },
        ),
      { physicalAdmission, now: () => wallTime },
    );
    await assert.rejects(blocked.run(), code('quota'));
    const next = fixture(undefined, { physicalAdmission });
    if (seconds === 0) await next.run();
    else await assert.rejects(next.run(), admissionRejected(seconds, 'quota'));
    assert.equal(next.captures.length, seconds === 0 ? 2 : 0);
    assert.equal(blocked.captures.length, 2);
    assert.equal(blocked.budget.retries, 0);
    assert.equal(JSON.stringify(blocked.diagnostics).includes(marker), false);
  }
});

test('invalid admission clock on429 fails future requests closed without skipping response cleanup', async () => {
  let now = 0;
  const physicalAdmission = createProviderPhysicalAdmission({
    requestsPerMinute: 5,
    now: () => now,
  });
  let response: Response | undefined;
  const blocked = fixture(
    () => {
      now = NaN;
      response = Response.json(
        { error: { code: 'too_many_requests', message: marker } },
        { status: 429 },
      );
      return response;
    },
    { physicalAdmission },
  );
  await assert.rejects(blocked.run(), code('quota'));
  assert.equal(response?.body?.locked, false);
  assert.ok(
    blocked.diagnostics.some(
      (event) => event.stage === 'http_error_metadata' && event.bodyState === 'parsed',
    ),
  );
  now = 60_000;
  const next = fixture(undefined, { physicalAdmission });
  await assert.rejects(next.run(), code('provider_unavailable'));
  assert.equal(next.captures.length, 0);
});

test('request diagnostics measure actual SDK UTF-8 bodies without retaining text, identifiers or headers', async () => {
  const f = fixture();
  f.input.request.message.text = `PRIVATE_REQUEST_TEXT_الطعام_🍲_"quote"\n${marker}`;
  const before = structuredClone(f.input);
  await f.run();
  assert.deepEqual(f.input, before);
  const shapes = f.diagnostics.filter((event) => event.stage === 'http_request');
  assert.equal(shapes.length, 2);
  assert.equal(f.captures.length, 2);
  assert.equal(f.budget.preflights, 1);
  assert.equal(f.budget.generations, 1);
  assert.equal(f.budget.retries, 0);
  for (const [index, capture] of f.captures.entries()) {
    const shape = shapes[index]!;
    assert.equal(shape.operation, index === 0 ? 'preflight' : 'generation');
    assert.equal(shape.route, index === 0 ? 'count_tokens' : 'interactions');
    assert.equal(shape.model, model);
    const actualBody = capture.rawBody;
    assert.ok(Buffer.byteLength(actualBody, 'utf8') > actualBody.length);
    assert.deepEqual(shape.serializedBody, {
      encoding: index === 0 ? 'utf8_string' : 'bytes',
      bytes: Buffer.byteLength(actualBody, 'utf8'),
    });
    assert.ok(shape.input);
    assert.equal(shape.input.promptBytes, Buffer.byteLength(JSON.stringify(before), 'utf8'));
    assert.equal(shape.input.systemInstructionBytes, Buffer.byteLength(SYSTEM_INSTRUCTION, 'utf8'));
    assert.equal(
      shape.input.schemaTextBytes,
      Buffer.byteLength(MODEL_ENVELOPE_SCHEMA_TEXT, 'utf8'),
    );
    assert.deepEqual(shape.input.counts, {
      historyMessages: 0,
      memoryItems: 0,
      pendingMemorySources: 0,
      reviewTargets: 1,
      savedPreferences: 0,
      planOccurrences: 0,
      referenceSets: 0,
      evidenceRecipes: 1,
      evidenceIngredients: before.evidence[0]!.ingredients.length,
      evidenceInstructions: before.evidence[0]!.instructions.length,
      evidenceAnnotations: before.evidence[0]!.annotations.length,
      retrievalRecords: 0,
    });
  }
  const retained = JSON.stringify(f.diagnostics);
  for (const forbidden of [
    marker,
    'PRIVATE_REQUEST_TEXT',
    'الطعام',
    before.request.requestId,
    before.request.message.messageId,
    before.evidence[0]!.title,
    '53262',
    'authorization',
    'x-goog-api-key',
    'system_instruction',
    'generativelanguage.googleapis.com',
  ])
    assert.equal(retained.includes(forbidden), false, forbidden);
});

test('interleaved SDK requests keep their own numeric shape and observer mutation cannot affect later calls', async () => {
  const bothPreflights = deferred<void>();
  const releaseA = deferred<void>();
  const releaseB = deferred<void>();
  const captures: { operation: string; promptBytes: number; evidenceRecipes: number }[] = [];
  const shapes: Extract<ProviderDiagnostic, { stage: 'http_request' }>[] = [];
  let preflights = 0;
  const provider = createGeminiProvider({
    apiKey: marker,
    model,
    onDiagnostic(event) {
      if (event.stage !== 'http_request') return;
      shapes.push(structuredClone(event));
      if (event.input) event.input.counts.evidenceRecipes = 999;
    },
    fetch: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = JSON.parse(
        String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}')),
      );
      const preflight = url.endsWith(':countTokens');
      const prompt = preflight ? body.contents[0].parts[1].text : body.input;
      const parsed = JSON.parse(prompt) as ProviderInput;
      captures.push({
        operation: preflight ? 'preflight' : 'generation',
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        evidenceRecipes: parsed.evidence.length,
      });
      if (preflight) {
        if (++preflights === 2) bothPreflights.resolve();
        await (parsed.evidence.length === 0 ? releaseA.promise : releaseB.promise);
        return Response.json({ totalTokens: 200 });
      }
      return Response.json(wire());
    },
  });
  const a: ProviderInput = {
    request: request(),
    evidence: [],
    retrieval: [],
    remainingRetrievalRounds: 1,
  };
  const b: ProviderInput = {
    ...structuredClone(a),
    evidence: createEvidenceBuilder().packet(['53262']),
  };
  b.request.message.text += ' Different private turn.';
  const budgets = [createProviderBudget(), createProviderBudget()];
  const run = (input: ProviderInput, index: number) =>
    provider.complete(input, {
      budget: budgets[index]!,
      signal: new AbortController().signal,
      deadline: Date.now() + 45_000,
    });
  const first = run(a, 0),
    second = run(b, 1);
  await bothPreflights.promise;
  releaseB.resolve();
  await second;
  releaseA.resolve();
  await first;
  assert.deepEqual(
    captures.map((item) => [item.operation, item.evidenceRecipes]),
    [
      ['preflight', 0],
      ['preflight', 1],
      ['generation', 1],
      ['generation', 0],
    ],
  );
  assert.deepEqual(
    shapes.map((shape) => ({
      operation: shape.operation,
      promptBytes: shape.input?.promptBytes,
      evidenceRecipes: shape.input?.counts.evidenceRecipes,
    })),
    captures,
  );
  for (const budget of budgets) {
    assert.equal(budget.generations, 1);
    assert.equal(budget.preflights, 1);
    assert.equal(budget.retries, 0);
  }
});

test('abort during SDK Request observation cancels the undispatched original and releases its lease', async (t) => {
  const f = fixture();
  const clone = Request.prototype.clone;
  let originalsCancelled = 0;
  let cleanupSettled = false;
  let cloneCalls = 0;
  let sdkRetained: Request | undefined;
  const cloneSpy = t.mock.method(Request.prototype, 'clone', function (this: Request) {
    // SDK 2.24.0 first clones its retained request; the second clone is our observer.
    if (++cloneCalls === 1) {
      sdkRetained = this;
      return clone.call(this);
    }
    assert.equal(cloneCalls, 2);
    const copy = clone.call(this);
    // Native clone replaces the original's body with its retained tee branch.
    assert.ok(this.body);
    const cancel = this.body.cancel;
    t.mock.method(
      this.body,
      'cancel',
      function (this: ReadableStream<Uint8Array>, reason?: unknown) {
        originalsCancelled++;
        return cancel.call(this, reason).then(() => {
          cleanupSettled = true;
        });
      },
    );
    queueMicrotask(() => f.controller.abort(gatewayError('cancelled', 499, 'never')));
    return copy;
  });
  t.after(async () => {
    await sdkRetained?.body?.cancel();
  });
  await assert.rejects(f.run(), code('cancelled'));
  cloneSpy.mock.restore();
  await nextTask();
  assert.equal(cloneCalls, 2);
  assert.equal(originalsCancelled, 1);
  assert.equal(f.captures.length, 1);
  assert.equal(f.budget.retries, 0);
  assert.equal(f.diagnostics.filter((event) => event.stage === 'http_request').length, 1);
  const run = () =>
    f.provider.complete(f.input, {
      budget: createProviderBudget(),
      signal: new AbortController().signal,
      deadline: Date.now() + 45_000,
    });
  assert.equal((await Promise.all([run(), run()])).length, 2);
  assert.equal(f.captures.length, 5);
  // SDK retains the parent tee until its request is released; it is not our physical lease.
  await sdkRetained?.body?.cancel();
  await nextTask();
  assert.equal(cleanupSettled, true);
});

test('HTTP-date diagnostics record the same bounded runtime cooldown without changing retry behavior', async () => {
  const receivedAt = Date.parse('2026-09-30T10:00:00.500Z');
  for (const [hint, seconds, rawState] of [
    ['Wed, 30 Sep 2026 10:00:08 GMT', 8, 'invalid'],
    ['Wed, 30 Sep 2026 09:59:00 GMT', 0, 'invalid'],
    ['Fri, 02 Oct 2026 10:00:00 GMT', 86400, 'invalid'],
    ['86401', 86400, 'out_of_range'],
    ['Thu, 30 Sep 2026 10:00:08 GMT', undefined, 'invalid'],
  ] as const) {
    const f = fixture(
      () =>
        Response.json(
          { error: { code: 'too_many_requests', message: marker } },
          { status: 429, headers: { 'retry-after': hint } },
        ),
      { now: () => receivedAt },
    );
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.detail.code, 'quota');
      assert.equal(error.detail.retryAfterSeconds, seconds);
      return true;
    });
    const metadata = f.diagnostics.find((event) => event.stage === 'http_error_metadata');
    assert.ok(metadata && metadata.stage === 'http_error_metadata');
    assert.equal(metadata.runtimeRetryAfterDelayMs, seconds === undefined ? null : seconds * 1000);
    assert.equal(metadata.retryAfterDelayMs.state, rawState);
    assert.equal(metadata.detailsState, 'absent');
    assert.deepEqual(metadata.quotas, []);
    assert.equal(f.captures.length, 2);
    assert.equal(f.budget.retries, 0);
    assert.equal(JSON.stringify(f.diagnostics).includes(hint), false);
    assert.equal(JSON.stringify(f.diagnostics).includes(marker), false);
  }
});

test('preflight diagnostics retain actual safe counts without changing input admission', async () => {
  for (const [totalTokens, expected] of [
    [0, null],
    [11744, null],
    [11745, 'too_large'],
    [undefined, 'invalid_model_result'],
    [null, 'invalid_model_result'],
    [-1, 'invalid_model_result'],
    [0.5, 'invalid_model_result'],
    ['200', 'invalid_model_result'],
    [Number.MAX_SAFE_INTEGER + 1, 'invalid_model_result'],
  ] as const) {
    const f = fixture(undefined, { totalTokens });
    if (expected) await assert.rejects(f.run(), code(expected));
    else await f.run();
    const valid =
      typeof totalTokens === 'number' && Number.isSafeInteger(totalTokens) && totalTokens >= 0;
    assert.deepEqual(
      f.diagnostics.find((event) => event.stage === 'preflight_result'),
      {
        stage: 'preflight_result',
        countValid: valid,
        countedInputTokens: valid ? totalTokens : null,
      },
    );
    assert.equal(f.captures.length, expected ? 1 : 2);
    assert.equal(f.budget.retries, 0);
  }
});

test('actual SDK quota errors retain bounded metadata while request and retry behavior stay unchanged', async () => {
  const responseBody = {
    error: {
      code: 'too_many_requests',
      message: marker,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
              quotaValue: '0',
              quotaDimensions: { model, project: marker },
              subject: marker,
              description: marker,
            },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1.000000001s' },
      ],
    },
  };
  const f = fixture(() =>
    Response.json(responseBody, {
      status: 429,
      headers: { 'retry-after': '7', 'x-private-header': marker },
    }),
  );
  await assert.rejects(
    f.run(),
    (error: unknown) =>
      error instanceof GatewayError &&
      error.detail.code === 'quota' &&
      error.detail.retry === 'after_delay' &&
      !JSON.stringify(error).includes(marker),
  );
  assert.equal(f.captures.length, 2);
  assert.equal(f.budget.preflights, 1);
  assert.equal(f.budget.generations, 1);
  assert.equal(f.budget.retries, 0);
  assert.deepEqual(
    f.diagnostics.find((event) => event.stage === 'preflight_result'),
    {
      stage: 'preflight_result',
      countValid: true,
      countedInputTokens: 200,
    },
  );
  const metadata = f.diagnostics.find((event) => event.stage === 'http_error_metadata');
  assert.ok(metadata && metadata.stage === 'http_error_metadata');
  assert.equal(metadata.code, 'too_many_requests');
  assert.equal(metadata.bodyState, 'parsed');
  assert.equal(metadata.quotas[0]!.category, 'requests_per_minute');
  assert.deepEqual(metadata.quotas[0]!.limit, { state: 'valid', value: 0 });
  assert.deepEqual(metadata.retryInfoDelayMs, [{ state: 'valid', value: 1001 }]);
  assert.deepEqual(metadata.retryAfterDelayMs, { state: 'valid', value: 7000 });
  assert.equal(JSON.stringify(f.diagnostics).includes(marker), false);
  assert.equal(JSON.stringify(f.diagnostics).includes('x-private-header'), false);
  assert.deepEqual(f.captures[1]!.body, {
    model,
    input: JSON.stringify(f.input),
    system_instruction: SYSTEM_INSTRUCTION,
    store: false,
    stream: false,
    generation_config: { max_output_tokens: 2000 },
    response_format: { type: 'text', mime_type: 'application/json' },
  });
});

test('error metadata survives missing or malformed bodies and failing diagnostic consumers', async () => {
  for (const [body, bodyState] of [
    [null, 'no_body'],
    ['<html>' + marker, 'malformed_json'],
  ] as const) {
    const f = fixture(() => new Response(body, { status: 429, headers: { 'retry-after': '0' } }), {
      onDiagnostic: () => {
        throw new Error(marker);
      },
    });
    await assert.rejects(f.run(), code('quota'));
    assert.equal(f.captures.length, 2);
    assert.equal(f.budget.retries, 0);
    const metadata = f.diagnostics.find((event) => event.stage === 'http_error_metadata');
    assert.ok(metadata && metadata.stage === 'http_error_metadata');
    assert.equal(metadata.bodyState, bodyState);
    assert.equal(metadata.detailsState, 'absent');
    assert.deepEqual(metadata.retryAfterDelayMs, { state: 'valid', value: 0 });
    assert.equal(JSON.stringify(f.diagnostics).includes(marker), false);
  }
});

test('oversized error bodies retain only retry metadata and preserve cancellation behavior', async () => {
  let cancelled = 0;
  const f = fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(128 * 1024 + 1));
          },
          cancel() {
            cancelled++;
          },
        }),
        { status: 429, headers: { 'retry-after': '3' } },
      ),
  );
  await assert.rejects(f.run(), code('invalid_model_result'));
  assert.equal(cancelled, 1);
  assert.equal(f.captures.length, 2);
  assert.equal(f.budget.retries, 0);
  const metadata = f.diagnostics.find((event) => event.stage === 'http_error_metadata');
  assert.ok(metadata && metadata.stage === 'http_error_metadata');
  assert.equal(metadata.bodyState, 'response_limit');
  assert.equal(metadata.code, 'unknown');
  assert.deepEqual(metadata.quotas, []);
  assert.deepEqual(metadata.retryAfterDelayMs, { state: 'valid', value: 3000 });
});

test('official SDK counts the exact schema-bearing instruction once and sends MIME-only stateless JSON', async () => {
  const f = fixture();
  assert.deepEqual((await f.run()).value, { kind: 'fixture' });
  assert.equal(f.captures.length, 2);
  assert.equal(f.budget.generations, 1);
  assert.equal(f.budget.preflights, 1);
  for (const capture of f.captures) {
    assert.equal(capture.url.origin, 'https://generativelanguage.googleapis.com');
    assert.equal(capture.url.search, '');
    assert.equal(capture.init.redirect, 'error');
    assert.equal(JSON.stringify(capture.body).includes(marker), false);
  }
  const body = f.captures[1]!.body;
  assert.equal(body.model, model);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.deepEqual(body.generation_config, { max_output_tokens: 2000 });
  for (const key of ['previous_interaction_id', 'tools', 'background', 'agent', 'environment'])
    assert.equal(Object.hasOwn(body, key), false);
  assert.deepEqual(body.response_format, { type: 'text', mime_type: 'application/json' });
  const contents = f.captures[0]!.body.contents as { parts: { text: string }[] }[];
  assert.equal(contents[0]!.parts.length, 2);
  assert.equal(contents[0]!.parts[0]!.text, SYSTEM_INSTRUCTION);
  assert.equal(body.system_instruction, SYSTEM_INSTRUCTION);
  assert.equal(contents[0]!.parts[1]!.text, body.input);
});

test('missing or invalid thought usage is unknown and rejected without retry', async () => {
  for (const usage of [
    undefined,
    null,
    {},
    { total_input_tokens: 100, total_output_tokens: 20 },
    ...[undefined, null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1].map((thought) => ({
      total_input_tokens: 100,
      total_output_tokens: 20,
      total_thought_tokens: thought,
    })),
  ]) {
    const f = fixture(() => Response.json(wire({}, { usage })));
    await assert.rejects(f.run(), code('invalid_model_result'));
    assert.equal(f.captures.length, 2);
    assert.equal(f.budget.retries, 0);
  }
});

test('explicit zero is accepted and combined output plus thought is capped at exactly 2000', async () => {
  for (const [output, thought, accepted] of [
    [2000, 0, true],
    [0, 2000, true],
    [167, 675, true],
    [1000, 1000, true],
    [1999, 2, false],
    [2001, 0, false],
    [0, 2001, false],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false],
  ] as const) {
    const f = fixture(() =>
      Response.json(
        wire(
          {},
          {
            usage: {
              total_input_tokens: 100,
              total_output_tokens: output,
              total_thought_tokens: thought,
            },
          },
        ),
      ),
    );
    if (accepted)
      assert.deepEqual((await f.run()).usage, {
        inputTokens: 100,
        outputTokens: output,
        thoughtTokens: thought,
      });
    else await assert.rejects(f.run(), code('invalid_model_result'));
    assert.equal(f.captures.length, 2);
    assert.equal(f.budget.retries, 0);
  }
});

test('one explicit transient retry reuses count; SDK retries remain disabled across both rounds', async () => {
  const f = fixture((_capture, index) =>
    index === 1
      ? Response.json(
          { error: { message: 'private failure', code: 503, status: 'UNAVAILABLE' } },
          { status: 503 },
        )
      : Response.json(wire()),
  );
  await f.run();
  await f.run();
  assert.equal(f.budget.generations, 3);
  assert.equal(f.budget.preflights, 2);
  assert.equal(f.budget.retries, 1);
  assert.equal(f.captures.length, 5);
  await assert.rejects(f.run(), code('too_large'));
  assert.equal(f.captures.length, 5);
});

test('actual SDK preserves adjacent structured text and omitted earlier model text fails closed', async () => {
  const text = JSON.stringify({ step: { kind: 'fixture' } });
  const part = (value: string) => ({ type: 'text', text: value });
  const step = (content: unknown[]) => ({ type: 'model_output', content });
  for (const steps of [
    [step([part(text.slice(0, 7)), part(text.slice(7))])],
    [step([part(text.slice(0, 7))]), step([part(text.slice(7))])],
    [step([{ type: 'thought', summary: [] }, part('  ' + text + '\n')])],
  ]) {
    const f = fixture(() => Response.json(wire({}, { steps })));
    assert.deepEqual((await f.run()).value, { kind: 'fixture' });
    assert.equal(f.captures.length, 2);
  }
  for (const steps of [
    [step([part('{"discarded":"PRIVATE"}'), { type: 'thought', summary: [] }, part(text)])],
    [step([part('{"discarded":"PRIVATE"}')]), { type: 'thought', content: [] }, step([part(text)])],
  ]) {
    const f = fixture(() => Response.json(wire({}, { steps })));
    await assert.rejects(f.run(), code('invalid_model_result'));
    assert.equal(f.captures.length, 2);
    assert.equal(f.budget.retries, 0);
  }
});

test('quota/auth/invalid payload/model/truncation failures do not retry or expose provider text', async () => {
  for (const [status, expected] of [
    [429, 'quota'],
    [401, 'provider_unavailable'],
    [403, 'provider_unavailable'],
    [400, 'invalid_model_result'],
  ] as const) {
    const f = fixture(() =>
      Response.json({ error: { message: 'private provider detail', code: status } }, { status }),
    );
    await assert.rejects(
      f.run(),
      (error: unknown) =>
        code(expected)(error) && !JSON.stringify(error).includes('private provider detail'),
    );
    assert.equal(f.captures.length, 2);
  }
  for (const bad of [
    wire({}, { model: 'some-unapproved-model' }),
    wire({}, { status: 'in_progress' }),
    wire(
      {},
      { steps: [{ type: 'model_output', content: [{ type: 'text', text: '{broken private' }] }] },
    ),
    wire(
      {},
      { usage: { total_input_tokens: 100, total_output_tokens: 2001, total_thought_tokens: 0 } },
    ),
  ]) {
    const f = fixture(() => Response.json(bad));
    await assert.rejects(f.run(), code('invalid_model_result'));
    assert.equal(f.captures.length, 2);
  }
});

// Exact block-code envelope: https://ai.google.dev/gemini-api/docs/api-errors
// 400 is a controlled representative HTTP error, not a claim about an observed live refusal status.
test('documented Interactions block code becomes a safe refusal through the actual SDK, without retry or prose inference', async () => {
  const privateText = 'FICTIONAL_PRIVATE_REFUSAL_DETAIL';
  const blockCodes = [
    'safety',
    'recitation',
    'language',
    'prohibited_content',
    'spii',
    'blocklist',
    'image_safety',
    'image_prohibited_content',
    'image_recitation',
    'image_other',
    'content_blocked',
  ];
  for (const { blockCode, status } of [
    ...blockCodes.map((blockCode) => ({ blockCode, status: 400 })),
    // A recognized refusal must be handled before the explicit HTTP5xx retry decision.
    { blockCode: 'content_blocked', status: 503 },
  ]) {
    const blocked = fixture(() =>
      Response.json(
        { error: { code: blockCode, message: `${privateText} ${marker}` } },
        { status },
      ),
    );
    await assert.rejects(blocked.run(), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, 422);
      assert.deepEqual(error.detail, {
        code: 'provider_refused',
        messageKey: 'gateway.provider_refused',
        retry: 'after_correction',
      });
      assert.equal(JSON.stringify(error).includes(privateText), false);
      assert.equal(JSON.stringify(error).includes(marker), false);
      return true;
    });
    assert.equal(blocked.captures.length, 2);
    assert.equal(blocked.budget.preflights, 1);
    assert.equal(blocked.budget.generations, 1);
    assert.equal(blocked.budget.retries, 0);
    const retained = JSON.stringify(blocked.diagnostics);
    assert.equal(retained.includes(privateText), false);
    assert.equal(retained.includes(marker), false);
    assert.deepEqual(
      blocked.diagnostics.filter((event) => event.stage === 'http_response'),
      [
        { stage: 'http_response', operation: 'preflight', httpStatus: 200 },
        { stage: 'http_response', operation: 'generation', httpStatus: status },
      ],
    );
  }
  // Identical HTTP status and refusal-like text cannot supply the missing machine discriminator.
  for (const errorCode of ['invalid_request', 'safety_extra']) {
    const control = fixture(() =>
      Response.json(
        {
          error: {
            code: errorCode,
            message: `safety content_blocked: cannot answer ${privateText}`,
          },
        },
        { status: 400 },
      ),
    );
    await assert.rejects(control.run(), code('invalid_model_result'));
    assert.equal(control.captures.length, 2);
    assert.equal(control.budget.retries, 0);
  }
});

test('refusal classification preserves cancellation and existing boundary errors and ignores inherited fields', () => {
  const blocked = { status: 503, error: { error: { code: 'content_blocked' } } };
  const cancelled = new AbortController();
  const cancellation = gatewayError('cancelled', 499, 'never');
  cancelled.abort(cancellation);
  assert.equal(mapProviderError(blocked, cancelled.signal), cancellation);
  const boundary = gatewayError('too_large', 422, 'after_correction');
  const signal = new AbortController().signal;
  assert.equal(mapProviderError({ ...blocked, cause: boundary }, signal), boundary);
  for (const error of [
    Object.create(blocked),
    { status: 400, error: Object.create(blocked.error) },
    { status: 400, error: { error: Object.create(blocked.error.error) } },
    { status: 400, error: { error: { code: ['safety'] } } },
    { status: 400, error: { code: 'safety' } },
  ])
    assert.notEqual(mapProviderError(error, signal).detail.code, 'provider_refused');
});

// Incomplete is documented; it does not identify the cause or prove a particular token count.
test('incomplete output rejects empty, truncated and valid-looking JSON without retry; unmarked truncation stays invalid', async () => {
  const privateText = 'FICTIONAL_PRIVATE_TRUNCATED_OUTPUT';
  const prefix = `{"step":{"kind":"${privateText}`;
  for (const [status, text] of [
    ['incomplete', ''],
    ['incomplete', prefix],
    ['incomplete', JSON.stringify({ step: { kind: 'fixture' } })],
    ['completed', prefix],
  ]) {
    const f = fixture(() =>
      Response.json(
        wire(
          {},
          {
            status,
            steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
          },
        ),
      ),
    );
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.detail.code, 'invalid_model_result');
      assert.equal(error.detail.retry, 'never');
      assert.equal(JSON.stringify(error).includes(privateText), false);
      return true;
    });
    assert.equal(f.captures.length, 2);
    assert.equal(f.budget.preflights, 1);
    assert.equal(f.budget.generations, 1);
    assert.equal(f.budget.retries, 0);
    assert.equal(JSON.stringify(f.diagnostics).includes(privateText), false);
    assert.ok(
      f.diagnostics.some(
        (event) => event.stage === 'completion_result' && event.completionStatus === status,
      ),
    );
  }
});

test('preflight failure blocks generation; counted schema/system/prompt plus framing reserve enforces cap', async () => {
  let calls = 0;
  for (const [response, expected] of [
    [Response.json({ totalTokens: 12000 }), 'too_large'],
    [Response.json({ error: { message: 'private' } }, { status: 429 }), 'quota'],
  ] as const) {
    const provider = createGeminiProvider({
      apiKey: marker,
      model,
      fetch: async () => {
        calls++;
        return response;
      },
    });
    await assert.rejects(
      provider.complete(fixture().input, {
        budget: createProviderBudget(),
        signal: new AbortController().signal,
        deadline: Date.now() + 45000,
      }),
      code(expected),
    );
  }
  assert.equal(calls, 2);
});

test('context admission failures survive orchestration as typed recovery without generation', async () => {
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: marker,
    model,
    fetch: async () => {
      calls++;
      return Response.json({ totalTokens: 12000 });
    },
  });
  await assert.rejects(
    createOrchestrator(provider)(request(), {
      signal: new AbortController().signal,
      deadline: Date.now() + 45000,
    }),
    (error: unknown) =>
      error instanceof GatewayError && error.detail.field === 'context.token_limit',
  );
  assert.equal(calls, 1);
  const oversized = fixture().input;
  oversized.request.message.text = 'x'.repeat(128 * 1024);
  await assert.rejects(
    provider.complete(oversized, {
      budget: createProviderBudget(),
      signal: new AbortController().signal,
      deadline: Date.now() + 45000,
    }),
    (error: unknown) =>
      error instanceof GatewayError && error.detail.field === 'context.byte_limit',
  );
  assert.equal(calls, 1);
});

test('oversized provider bodies are cancelled and abort never spends a generation after preflight', async () => {
  const f = fixture(
    () =>
      new Response('x'.repeat(128 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  );
  await assert.rejects(f.run(), code('invalid_model_result'));
  assert.equal(f.captures.length, 2);
  const abort = fixture();
  abort.controller.abort(gatewayError('cancelled', 499, 'never'));
  await assert.rejects(abort.run(), code('cancelled'));
  assert.equal(abort.captures.length, 0);
  assert.equal(abort.budget.generations, 0);
});

test('two abort-ignoring physical requests retain their leases after caller cancellation', async () => {
  const stalled = [deferred<Response>(), deferred<Response>()];
  let calls = 0;
  const provider = createGeminiProvider({
    apiKey: marker,
    model,
    fetch: async () => stalled[calls++]!.promise,
  });
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) =>
    provider.complete(fixture().input, {
      budget: createProviderBudget(),
      signal: controller.signal,
      deadline: Date.now() + 45000,
    }),
  );
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  controllers.forEach((controller) => controller.abort(gatewayError('cancelled', 499, 'never')));
  await Promise.all(pending.map((result) => assert.rejects(result, code('cancelled'))));
  await assert.rejects(
    provider.complete(fixture().input, {
      budget: createProviderBudget(),
      signal: new AbortController().signal,
      deadline: Date.now() + 45000,
    }),
    code('busy'),
  );
  assert.equal(calls, 2);
  stalled.forEach((request) => request.resolve(Response.json({ totalTokens: 200 })));
});

test('provider body size errors return promptly while unresolved cancellation retains physical leases', async () => {
  const cancellations = [deferred<void>(), deferred<void>()];
  const cancelling = deferred<void>();
  const bodies: ReadableStream<Uint8Array>[] = [];
  let cancelled = 0;
  const f = fixture((_capture, index) => {
    if (index > 2) return Response.json(wire());
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(128 * 1024 + 1));
      },
      cancel() {
        if (++cancelled === 2) cancelling.resolve();
        return cancellations[index - 1]!.promise;
      },
    });
    bodies.push(body);
    return new Response(body);
  });
  const outcomes: string[] = [];
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) =>
    f.provider
      .complete(f.input, {
        budget: createProviderBudget(),
        signal: controller.signal,
        deadline: Date.now() + 45_000,
      })
      .then(
        () => {
          outcomes.push('unexpected_success');
        },
        (error: unknown) => {
          outcomes.push(error instanceof GatewayError ? error.detail.code : 'untyped_error');
        },
      ),
  );
  try {
    await cancelling.promise;
    await nextTask();
    assert.deepEqual(
      [...outcomes],
      ['invalid_model_result', 'invalid_model_result'],
      'a known body cap failure must not wait for the underlying cancel promise',
    );
    assert.ok(bodies.every((body) => !body.locked));
    await assert.rejects(f.run(), code('busy'));
    assert.equal(f.captures.length, 4, 'pending cancellations still own the two physical leases');
    cancellations.forEach((cancellation) => cancellation.resolve());
    await nextTask();
    assert.deepEqual((await f.run()).value, { kind: 'fixture' });
    assert.equal(f.captures.length, 6);
  } finally {
    controllers.forEach((controller) => controller.abort(gatewayError('cancelled', 499, 'never')));
    cancellations.forEach((cancellation) => cancellation.resolve());
    await Promise.all(pending);
  }
});

test('provider body abort cancels stalled readers but holds leases until underlying cleanup settles', async () => {
  const cancellations = [deferred<void>(), deferred<void>()];
  const reading = deferred<void>();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const bodies: ReadableStream<Uint8Array>[] = [];
  let reads = 0;
  let cancelled = 0;
  const f = fixture((_capture, index) => {
    if (index > 2) return Response.json(wire());
    const body = new ReadableStream<Uint8Array>(
      {
        start(stream) {
          streams.push(stream);
        },
        pull() {
          if (++reads === 2) reading.resolve();
          return new Promise<void>(() => {});
        },
        cancel() {
          cancelled++;
          return cancellations[index - 1]!.promise;
        },
      },
      { highWaterMark: 0 },
    );
    bodies.push(body);
    return new Response(body, { status: 429, headers: { 'retry-after': '4' } });
  });
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map((controller) =>
    f.provider.complete(f.input, {
      budget: createProviderBudget(),
      signal: controller.signal,
      deadline: Date.now() + 45_000,
    }),
  );
  try {
    await reading.promise;
    const rejected = pending.map((result) => assert.rejects(result, code('cancelled')));
    controllers.forEach((controller) => controller.abort(gatewayError('cancelled', 499, 'never')));
    await Promise.all(rejected);
    await nextTask();
    assert.equal(cancelled, 2, 'caller abort must also cancel each active response-body reader');
    assert.ok(bodies.every((body) => !body.locked));
    const metadata = f.diagnostics.filter((event) => event.stage === 'http_error_metadata');
    assert.equal(metadata.length, 2);
    for (const event of metadata) {
      assert.equal(event.bodyState, 'aborted');
      assert.deepEqual(event.retryAfterDelayMs, { state: 'valid', value: 4000 });
      assert.deepEqual(event.quotas, []);
    }
    assert.equal(JSON.stringify(metadata).includes(marker), false);
    await assert.rejects(f.run(), code('busy'));
    assert.equal(f.captures.length, 4);
    cancellations.forEach((cancellation) => cancellation.resolve());
    await nextTask();
    assert.deepEqual((await f.run()).value, { kind: 'fixture' });
    assert.equal(f.captures.length, 6);
  } finally {
    controllers.forEach((controller) => controller.abort(gatewayError('cancelled', 499, 'never')));
    for (const stream of streams) {
      try {
        stream.close();
      } catch {
        /* Already cancelled. */
      }
    }
    cancellations.forEach((cancellation) => cancellation.resolve());
    await Promise.allSettled(pending);
  }
});
