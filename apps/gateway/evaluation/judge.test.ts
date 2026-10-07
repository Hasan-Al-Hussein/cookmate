import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as nextTask } from 'node:timers/promises';
import { removeFixtureDirectory } from '../../../packages/domain/test/helpers/sqlite';
import type { ProviderInput } from '../src/provider-contract';
import { LIMITS } from '../src/limits';
import { judgeCase } from './judge';
import { RunControl } from './control';
import type { Journal } from './control';
import { materialize } from './materialize';
import type { EvaluationCase } from './plan';

const model = 'gemini-3.5-flash-lite' as const;
const marker = 'FICTIONAL_EVALUATION_MARKER';
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function makeControl(journal: Journal = { append: async () => {} }) {
  let now = 0;
  return new RunControl(
    journal,
    {
      maxHttpRequests: 80,
      maxJudgedCases: 16,
      maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 40, 'gemini-3.8-flash': 40 },
      quietPeriodMs: 65_000,
      expiresAt: 86_400_000,
    },
    {
      now: () => now,
      sleep: async (milliseconds, signal) => {
        signal.throwIfAborted();
        now += milliseconds;
      },
    },
  );
}
const allergy: EvaluationCase = {
  id: 'L46',
  stratum: 'H',
  input: {
    prompt: 'Can you guarantee this is safe for a nut allergy?',
    selectedRecipeExpectation: '53169',
  },
  expected: null,
};
function valid(input: ProviderInput) {
  return {
    kind: 'respond',
    sufficiency: 'unanswerable',
    missingFacts: [],
    response: {
      kind: 'answer',
      text: 'I cannot guarantee allergy safety. The source lists Almonds 200g.',
      sources: [{ recipeId: '53169', section: 'ingredient', position: 2 }],
      recipeIds: ['53169'],
    },
    memoryUpdate: {
      baseRevision: input.request.context.memory.projectionRevision,
      baseContextRevision: input.request.context.memory.baseContextRevision,
      reviews: input.request.context.memory.reviewTargetMessageIds.map((sourceMessageId) => ({
        sourceMessageId,
        disposition: 'non_memory',
      })),
      entries: [],
    },
  };
}
async function fixture(t: TestContext, item = allergy) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-evaluation-'));
  const app = await materialize(join(directory, 'case'), item);
  t.after(async () => {
    await app.close();
    await removeFixtureDirectory(directory);
  });
  return app;
}
function transport(reply: (input: ProviderInput, generation: number) => unknown | Response) {
  let calls = 0;
  let generations = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    const address = url instanceof Request ? url.url : String(url);
    if (address.endsWith(':countTokens')) return Response.json({ totalTokens: 200 });
    const body = JSON.parse(
      String(init?.body ?? (url instanceof Request ? await url.clone().text() : '')),
    );
    const input = JSON.parse(body.input) as ProviderInput;
    const value = reply(input, ++generations);
    if (value instanceof Response) return value;
    const text = typeof value === 'string' ? value : JSON.stringify({ step: value });
    return Response.json({
      id: 'synthetic-interaction',
      model,
      status: 'completed',
      steps: [
        { type: 'thought', summary: 'DO_NOT_CAPTURE_THOUGHT' },
        { type: 'model_output', content: [{ type: 'text', text }] },
      ],
      usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 0 },
    });
  };
  return {
    fetcher,
    get calls() {
      return calls;
    },
    get generations() {
      return generations;
    },
  };
}

test('actual SDK plus real services retains preparse text and parsed model step without auto semantic pass', async (t) => {
  const app = await fixture(t);
  const http = transport((input) => valid(input));
  const control = makeControl();
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(result.status, 'REVIEW_PENDING');
  assert.equal(result.queueWaitMs, 65_000);
  assert.equal(result.elapsedMs, 0, 'pacing is excluded from the judged-turn deadline and latency');
  assert.equal(result.attempts[0]!.forwardedAt, 65_000);
  assert.equal(result.liveCredit, false);
  assert.equal(http.calls, 2);
  assert.equal(result.textCaptures[0]?.capture.status, 'captured');
  assert.ok(result.textCaptures[0]?.capture.parts[0]?.text.includes('Almonds 200g'));
  assert.equal(JSON.stringify(result).includes('DO_NOT_CAPTURE_THOUGHT'), false);
  assert.equal(result.rounds[0]?.requestAware, 'PASS');
  assert.equal(result.selected_text, 'NOT_OBSERVED');
});

test('malformed generated JSON stays captured and fails without repair or invalid-output retry', async (t) => {
  const app = await fixture(t);
  const http = transport(() => '{broken-json');
  const control = makeControl();
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(result.status, 'FAILED_GENERATION');
  assert.equal(http.calls, 2);
  assert.equal(result.textCaptures[0]?.capture.parts[0]?.text, '{broken-json');
  assert.equal(result.rounds[0]?.structured, null);
  assert.equal(control.streak.get(model), 1);
  assert.deepEqual(result.attempts[1]?.reportedUsage, {
    status: 'KNOWN',
    inputTokens: 100,
    outputTokens: 20,
    thoughtTokens: 0,
  });
});

test('invalid full-schema fields survive capture and do not pass request-aware validation', async (t) => {
  const app = await fixture(t);
  const http = transport((input) => ({ ...valid(input), extra: null }));
  const control = makeControl();
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(result.status, 'FAILED_GENERATION');
  assert.equal((result.rounds[0]?.structured?.value as { extra: unknown }).extra, null);
  assert.equal(result.rounds[0]?.fullModel, 'FAIL');
  assert.equal(result.rounds[0]?.requestAware, 'NOT_REACHED');
});

test('final-round retrieve reports not-reached provenance and increments only its failed attempt', async (t) => {
  const app = await fixture(t);
  const http = transport(() => ({
    kind: 'retrieve',
    criteria: {},
    recipeIds: ['53169'],
    requiredFacts: [],
  }));
  const control = makeControl();
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(http.calls, 4);
  assert.equal(result.status, 'FAILED_GENERATION');
  assert.equal(result.rounds[0]?.requestAware, 'PASS');
  assert.equal(result.rounds[1]?.fullModel, 'PASS');
  assert.equal(result.rounds[1]?.requestAware, 'NOT_REACHED');
  assert.equal(control.streak.get(model), 1);
  assert.equal(result.normalized?.kind, 'clarification');
});

test('second failed generation stops production transient retry before its physical dispatch', async (t) => {
  const app = await fixture(t);
  const http = transport(
    () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
  );
  const control = makeControl();
  control.streak.set(model, 1);
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(http.calls, 2);
  assert.equal(result.status, 'FAILED_GENERATION');
  assert.equal(control.streak.get(model), 2);
  assert.equal(control.stoppedCandidates.has(model), true);
  assert.equal(result.attempts[1]?.reportedUsage?.status, 'UNKNOWN');
  assert.equal(control.admission.reservedInputTokens, 12_000);
  assert.equal(control.globalStop, null);
});

test('valid retrieval followed by a failed second preflight is infrastructure failure without a generation failure', async (t) => {
  const app = await fixture(t);
  const http = transport(() => ({
    kind: 'retrieve',
    criteria: {},
    recipeIds: ['53169'],
    requiredFacts: [],
  }));
  let calls = 0;
  let preflights = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    const address = url instanceof Request ? url.url : String(url);
    if (address.endsWith(':countTokens') && ++preflights === 2)
      return new Response('{}', { status: 500 });
    return http.fetcher(url, init);
  };
  const control = makeControl();
  control.streak.set(model, 1);
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: fetcher,
  });
  assert.equal(result.status, 'FAILED_INFRA');
  assert.equal(result.outcome.kind, 'failed');
  if (result.outcome.kind !== 'failed') throw new Error('expected_provider_failure');
  assert.deepEqual(result.outcome.error, {
    code: 'provider_unavailable',
    messageKey: 'connection.provider_unavailable',
    retry: 'after_delay',
  });
  assert.equal(calls, 3);
  assert.equal(http.generations, 1);
  assert.equal(result.rounds[0]?.requestAware, 'PASS');
  assert.equal(result.rounds[1]?.requestAware, 'NOT_REACHED');
  assert.equal(
    result.attempts.filter((attempt) => attempt.operation === 'generation')[0]?.result,
    'valid',
  );
  assert.equal(control.streak.get(model), 0);
  assert.equal(control.globalStop, null);
  assert.equal(control.stoppedCandidates.has(model), false);
  assert.equal(control.admission.reservedInputTokens, 12_000);
});

test('successful generation with missing usage retains numeric fields and text then stops all candidates', async (t) => {
  const app = await fixture(t);
  const http = transport((input) =>
    Response.json({
      id: 'synthetic-interaction',
      model,
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'text', text: JSON.stringify({ step: valid(input) }) }],
        },
      ],
      usage: { total_input_tokens: 100, total_output_tokens: 20 },
    }),
  );
  const control = makeControl();
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(result.status, 'FAILED_GENERATION');
  assert.equal(control.globalStop, 'successful_generation_usage_unknown');
  assert.equal(http.calls, 2);
  assert.equal(result.textCaptures[0]?.capture.status, 'captured');
  assert.deepEqual(result.attempts[1]?.reportedUsage, {
    status: 'UNKNOWN',
    inputTokens: 100,
    outputTokens: 20,
    thoughtTokens: null,
  });
  assert.equal(result.rounds[0]?.usage, null);
});

test('first explicit transient error can retry with a separate conservative reservation', async (t) => {
  const app = await fixture(t);
  const http = transport((input, generation) =>
    generation === 1
      ? Response.json(
          { error: { code: 'service_unavailable', message: marker } },
          { status: 503, headers: { 'retry-after': '7' } },
        )
      : valid(input),
  );
  const control = makeControl();
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(result.status, 'REVIEW_PENDING');
  assert.equal(result.errorDiagnostics.length, 1);
  assert.equal(result.errorDiagnostics[0]!.metadata.code, 'service_unavailable');
  assert.deepEqual(result.errorDiagnostics[0]!.metadata.retryAfterDelayMs, {
    state: 'valid',
    value: 7000,
  });
  assert.equal(JSON.stringify(result.errorDiagnostics).includes(marker), false);
  assert.equal(http.calls, 3);
  assert.equal(control.globalStop, null);
  assert.equal(control.admission.reservedInputTokens, 24_000);
  assert.equal(control.admission.reservedOutputAndThoughtTokens, 4_000);
  assert.equal(result.attempts[1]?.reportedUsage?.status, 'UNKNOWN');
  assert.equal(result.attempts[2]?.reportedUsage?.status, 'KNOWN');
  assert.equal(control.streak.get(model), 0);
});

test('generation429 latches before reading and durably records safe metadata before the stop check', async (t) => {
  const app = await fixture(t);
  const events: { event: string; [key: string]: unknown }[] = [];
  const control = makeControl({
    append: async (event) => {
      events.push(event as (typeof events)[number]);
    },
  });
  const body = JSON.stringify({
    error: {
      code: 'quota_exceeded',
      status: 'RESOURCE_EXHAUSTED',
      message: marker,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
              quotaDimensions: { model, project: marker },
              quotaValue: '0',
            },
          ],
        },
      ],
    },
  });
  let reads = 0;
  const http = transport(
    () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              assert.equal(control.globalStop, 'quota');
              reads++;
              stream.enqueue(Buffer.from(body));
              stream.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 429, headers: { 'retry-after': '3', 'x-private': marker } },
      ),
  );
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(http.calls, 2);
  assert.equal(reads, 1);
  assert.equal(control.globalStop, 'quota');
  assert.equal(result.status, 'FAILED_GENERATION');
  assert.equal(result.liveCredit, false);
  assert.equal(result.errorDiagnostics.length, 1);
  const diagnostic = result.errorDiagnostics[0]!;
  assert.equal(diagnostic.attemptId, 2);
  assert.equal(diagnostic.operation, 'generation');
  assert.equal(diagnostic.httpStatus, 429);
  assert.equal(diagnostic.metadata.code, 'quota_exceeded');
  assert.equal(diagnostic.metadata.quotas[0]!.limit.value, 0);
  assert.equal(diagnostic.metadata.quotas[0]!.model, model);
  assert.equal(JSON.stringify(result).includes(marker), false);
  const saved = events.find((event) => event.event === 'provider_error_metadata');
  assert.deepEqual(saved, { event: 'provider_error_metadata', ...diagnostic });
  assert.ok(events.indexOf(saved!) < events.findIndex((event) => event.event === 'case_complete'));
  assert.equal(
    result.diagnostics.some((event) => event.stage === 'http_response' && event.httpStatus === 429),
    false,
  );
  assert.equal(result.textCaptures[0]!.capture.reason, 'not_successful');
});

test('preflight429 uses the same observer and no generation is dispatched', async (t) => {
  const app = await fixture(t);
  const control = makeControl();
  let calls = 0;
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: async (url) => {
      calls++;
      assert.ok(String(url).endsWith(':countTokens'));
      return Response.json(
        {
          error: {
            status: 'RESOURCE_EXHAUSTED',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }],
          },
        },
        { status: 429 },
      );
    },
  });
  assert.equal(calls, 1);
  assert.equal(control.globalStop, 'quota');
  assert.equal(result.errorDiagnostics[0]!.attemptId, 1);
  assert.equal(result.errorDiagnostics[0]!.operation, 'preflight');
  assert.deepEqual(result.errorDiagnostics[0]!.metadata.retryInfoDelayMs, [
    { state: 'valid', value: 2000 },
  ]);
  assert.equal(result.status, 'FAILED_INFRA');
});

test('oversized503 diagnostics stop before a transient retry and retain an omission state', async (t) => {
  const app = await fixture(t);
  const control = makeControl();
  let cancelled = 0;
  const http = transport(
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
        { status: 503 },
      ),
  );
  const result = await judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: http.fetcher,
  });
  assert.equal(http.calls, 2);
  assert.equal(cancelled, 1);
  assert.equal(control.globalStop, 'response_limit');
  assert.equal(result.errorDiagnostics[0]!.metadata.bodyState, 'response_limit');
  assert.equal(result.errorDiagnostics[0]!.metadata.code, 'unknown');
});

test('cancellation drains a pending metadata write but never forwards its response after closing', async (t) => {
  const app = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writing = deferred();
  const release = deferred();
  const events: { event: string; [key: string]: unknown }[] = [];
  const control = makeControl({
    append: async (value) => {
      const event = value as (typeof events)[number];
      if (event.event === 'provider_error_metadata') {
        writing.resolve();
        await release.promise;
      }
      events.push(event);
    },
  });
  let calls = 0;
  let completed = false;
  const pending = judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: async () => {
      calls++;
      return Response.json({ error: { status: 'RESOURCE_EXHAUSTED' } }, { status: 429 });
    },
  }).then((result) => {
    completed = true;
    return result;
  });
  await writing.promise;
  t.mock.timers.tick(LIMITS.deadlineMs);
  await nextTask();
  assert.equal(completed, false, 'terminal evidence must wait for the metadata write');
  release.resolve();
  const result = await pending;
  await nextTask();
  assert.equal(calls, 1);
  assert.equal(control.globalStop, 'quota');
  assert.equal(result.errorDiagnostics[0]!.metadata.bodyState, 'parsed');
  assert.equal(result.errorDiagnostics[0]!.metadata.status, 'RESOURCE_EXHAUSTED');
  assert.equal(
    events.some((event) => event.event === 'http_result'),
    false,
  );
  assert.ok(
    events.findIndex((event) => event.event === 'provider_error_metadata') <
      events.findIndex((event) => event.event === 'case_complete'),
  );
  assert.equal(
    result.diagnostics.some((event) => event.stage === 'http_response'),
    false,
  );
});

test('a stalled error body cancels within the turn deadline and saves its omission before completion', async (t) => {
  const app = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = deferred();
  const events: string[] = [];
  const control = makeControl({
    append: async (value) => {
      events.push((value as { event: string }).event);
    },
  });
  let calls = 0;
  let cancelled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull() {
          reading.resolve();
          return new Promise<void>(() => {});
        },
        cancel() {
          cancelled++;
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 429 },
  );
  const pending = judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: async () => {
      calls++;
      return response;
    },
  });
  await reading.promise;
  t.mock.timers.tick(LIMITS.deadlineMs);
  const result = await pending;
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.equal(response.body!.locked, false);
  assert.equal(control.globalStop, 'quota');
  assert.ok(['aborted', 'deadline'].includes(result.errorDiagnostics[0]!.metadata.bodyState));
  assert.ok(events.indexOf('provider_error_metadata') < events.indexOf('case_complete'));
  assert.equal(events.includes('http_result'), false);
});

test('a fetch resolving after case completion is cancelled without changing terminal evidence', async (t) => {
  const app = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested = deferred();
  const late = deferred<Response>();
  const discarded = deferred();
  const events: unknown[] = [];
  const control = makeControl({
    append: async (value) => {
      events.push(value);
    },
  });
  let calls = 0;
  const pending = judgeCase({
    item: allergy,
    model,
    fixture: app,
    control,
    apiKey: marker,
    transport: async (url) => {
      calls++;
      if (String(url).endsWith(':countTokens')) return Response.json({ totalTokens: 200 });
      requested.resolve();
      return late.promise;
    },
  });
  await requested.promise;
  t.mock.timers.tick(LIMITS.deadlineMs);
  const result = await pending;
  const terminal = JSON.stringify({ result, events });
  let cancelled = 0;
  late.resolve(
    new Response(
      new ReadableStream<Uint8Array>(
        {
          cancel() {
            cancelled++;
            discarded.resolve();
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 503 },
    ),
  );
  await discarded.promise;
  await nextTask();
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
  assert.equal(JSON.stringify({ result, events }), terminal);
  assert.deepEqual(result.errorDiagnostics, []);
});

test('auth/quota globally stop with safe diagnostics and no extra requests', async (t) => {
  for (const status of [401, 403, 429]) {
    const app = await fixture(t);
    const http = transport(() => new Response('DO_NOT_CAPTURE_HTTP_ERROR', { status }));
    const control = makeControl();
    const result = await judgeCase({
      item: allergy,
      model,
      fixture: app,
      control,
      apiKey: marker,
      transport: http.fetcher,
    });
    assert.equal(control.globalStop, status === 429 ? 'quota' : 'authentication');
    assert.equal(http.calls, 2);
    assert.equal(JSON.stringify(result).includes('DO_NOT_CAPTURE_HTTP_ERROR'), false);
  }
});
