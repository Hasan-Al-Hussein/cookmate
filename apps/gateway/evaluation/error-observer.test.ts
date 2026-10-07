import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { LIMITS } from '../src/limits';
import { observeEvaluationError } from './error-observer';

const marker = 'PRIVATE_ERROR_PROJECT_KEY_URL_928';
const metric = 'generativelanguage.googleapis.com/generate_content_free_tier_requests';
const rule = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
const model = 'gemini-3.8-flash';
const quotaType = 'type.googleapis.com/google.rpc.QuotaFailure';
const retryType = 'type.googleapis.com/google.rpc.RetryInfo';
const reasonType = 'type.googleapis.com/google.rpc.ErrorInfo';
const violation = (extra: Record<string, unknown> = {}) => ({
  quotaMetric: metric,
  quotaId: rule,
  quotaValue: '0',
  quotaDimensions: { model, project: marker, location: marker },
  subject: marker,
  description: marker,
  ...extra,
});
const envelope = (details: unknown) =>
  JSON.stringify({
    error: { code: 'quota_exceeded', status: 'RESOURCE_EXHAUSTED', message: marker, details },
  });
async function inspect(body: string | null, retryAfter?: string) {
  const controller = new AbortController();
  const response = new Response(body, {
    status: 429,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  });
  const result = await observeEvaluationError(response, {
    signal: controller.signal,
    now: Date.now,
    deadline: Date.now() + 1000,
  });
  assert.equal(response.body?.locked ?? false, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(JSON.stringify(result.metadata).includes(marker), false);
  return result;
}

test('known structured quota fields are normalized without raw prose, identifiers or headers', async () => {
  const result = await inspect(
    envelope([
      { '@type': quotaType, violations: [violation()] },
      { '@type': retryType, retryDelay: '1.000340012s', private: marker },
      {
        '@type': reasonType,
        domain: 'googleapis.com',
        reason: 'RATE_LIMIT_EXCEEDED',
        metadata: { consumer: marker },
      },
      { '@type': reasonType, domain: 'googleapis.com', reason: 'RESOURCE_QUOTA_EXCEEDED' },
      { '@type': marker, links: [{ url: marker }] },
    ]),
    '7',
  );
  assert.equal(result.metadata.bodyState, 'parsed');
  assert.equal(result.metadata.code, 'quota_exceeded');
  assert.equal(result.metadata.status, 'RESOURCE_EXHAUSTED');
  assert.deepEqual(result.metadata.quotas, [
    {
      category: 'requests_per_minute',
      metric,
      ruleId: rule,
      model,
      limit: { state: 'valid', value: 0 },
    },
  ]);
  assert.deepEqual(result.metadata.quotaReasons, ['rate_limit', 'resource_quota']);
  assert.deepEqual(result.metadata.retryInfoDelayMs, [{ state: 'valid', value: 1001 }]);
  assert.deepEqual(result.metadata.retryAfterDelayMs, { state: 'valid', value: 7000 });
  assert.equal(result.metadata.unknownDetails, true);
});

test('unknown and hostile fields stay unknown rather than being inferred from prose or prefixes', async () => {
  const result = await inspect(
    envelope([
      {
        '@type': quotaType,
        violations: [
          violation({
            quotaMetric: metric + marker,
            quotaId: rule + marker,
            quotaDimensions: { model: model + marker },
            quotaValue: marker,
          }),
        ],
      },
      { '@type': reasonType, reason: 'RATE_LIMIT_EXCEEDED', domain: marker },
      { '@type': reasonType, reason: marker, domain: 'googleapis.com' },
      { '@type': quotaType + marker, violations: [violation()] },
      { '@type': retryType, retryDelay: marker },
    ]),
    marker,
  );
  assert.deepEqual(result.metadata.quotas, [
    {
      category: 'unknown',
      metric: 'unknown',
      ruleId: 'unknown',
      model: 'unknown',
      limit: { state: 'invalid', value: null },
    },
  ]);
  assert.deepEqual(result.metadata.quotaReasons, []);
  assert.deepEqual(result.metadata.retryInfoDelayMs, [{ state: 'invalid', value: null }]);
  assert.deepEqual(result.metadata.retryAfterDelayMs, { state: 'invalid', value: null });
  const prototype = await inspect(
    '{"error":{"__proto__":{"status":"RESOURCE_EXHAUSTED","details":[]},"code":"' + marker + '"}}',
  );
  assert.equal(prototype.metadata.status, 'unknown');
  assert.equal(prototype.metadata.code, 'unknown');
  assert.equal(prototype.metadata.detailsState, 'absent');
});

test('limits distinguish explicit zero, absence, malformed and unsafe numeric ranges', async () => {
  for (const [value, state, expected] of [
    [undefined, 'absent', null],
    [0, 'valid', 0],
    ['20', 'valid', 20],
    [null, 'invalid', null],
    [-1, 'invalid', null],
    [0.5, 'invalid', null],
    ['1e2', 'invalid', null],
    [false, 'invalid', null],
    ['9007199254740992', 'out_of_range', null],
    ['9'.repeat(80), 'out_of_range', null],
  ] as const) {
    const result = await inspect(
      envelope([{ '@type': quotaType, violations: [violation({ quotaValue: value })] }]),
    );
    assert.deepEqual(result.metadata.quotas[0]!.limit, { state, value: expected });
  }
  const omitted = await inspect(envelope([{ '@type': quotaType, violations: [{}] }]));
  assert.equal(omitted.metadata.quotas[0]!.category, 'unknown');
  assert.equal(omitted.metadata.quotas[0]!.limit.state, 'absent');
});

test('retry observations are bounded and never substitute missing values with zero', async () => {
  for (const [value, state, expected] of [
    [undefined, 'absent', null],
    ['0s', 'valid', 0],
    ['0.000000001s', 'valid', 1],
    ['86400s', 'valid', 86_400_000],
    ['86400.1s', 'out_of_range', null],
    ['-1s', 'invalid', null],
    ['1e2s', 'invalid', null],
    ['1.0000000001s', 'invalid', null],
    [5, 'invalid', null],
    ['Infinitys', 'invalid', null],
  ] as const) {
    const result = await inspect(envelope([{ '@type': retryType, retryDelay: value }]));
    assert.deepEqual(result.metadata.retryInfoDelayMs, [{ state, value: expected }]);
  }
  for (const [value, state] of [
    ['86401', 'out_of_range'],
    ['1.5', 'invalid'],
    ['Wed, 21 Oct 2015 07:28:00 GMT', 'invalid'],
  ] as const)
    assert.equal((await inspect(null, value)).metadata.retryAfterDelayMs.state, state);
  assert.deepEqual((await inspect(null)).metadata.retryAfterDelayMs, {
    state: 'absent',
    value: null,
  });
});

test('JSON/detail shape states and truncation are visible without retaining unrecognized data', async () => {
  assert.equal((await inspect(null)).metadata.bodyState, 'no_body');
  for (const body of ['', '{broken', '<html>' + marker + '</html>'])
    assert.equal((await inspect(body)).metadata.bodyState, 'malformed_json');
  for (const body of ['[]', 'null', '{}', '{"error":[]}'])
    assert.equal((await inspect(body)).metadata.bodyState, 'nonstandard_error');
  assert.equal((await inspect(envelope(undefined))).metadata.detailsState, 'absent');
  assert.equal((await inspect(envelope({ private: marker }))).metadata.detailsState, 'malformed');
  const malformed = await inspect(envelope([null, { '@type': quotaType, violations: marker }]));
  assert.equal(malformed.metadata.malformedDetails, true);
  const truncated = await inspect(
    envelope([
      { '@type': quotaType, violations: Array.from({ length: 9 }, () => violation()) },
      ...Array.from({ length: 9 }, () => ({ '@type': retryType, retryDelay: '1s' })),
    ]),
  );
  assert.equal(truncated.metadata.detailsState, 'truncated');
  assert.equal(truncated.metadata.violationsTruncated, true);
  assert.equal(truncated.metadata.quotas.length, 8);
  assert.equal(truncated.metadata.retryInfoDelayMs.length, 7);
});

test('continued503 preserves every body byte, status and header while diagnostics remain bounded', async () => {
  const bytes = Buffer.from([0, 255, 123, 13, 10, 128]);
  const response = new Response(bytes, {
    status: 503,
    statusText: 'Synthetic unavailable',
    headers: {
      'content-type': 'application/octet-stream',
      'retry-after': '4',
      'x-private': marker,
    },
  });
  const expectedHeaders = [...response.headers];
  const result = await observeEvaluationError(response, {
    signal: new AbortController().signal,
    now: Date.now,
    deadline: Date.now() + 1000,
  });
  assert.ok(result.response);
  assert.equal(result.response.status, 503);
  assert.equal(result.response.statusText, 'Synthetic unavailable');
  assert.deepEqual([...result.response.headers], expectedHeaders);
  assert.deepEqual(Buffer.from(await result.response.arrayBuffer()), bytes);
  assert.equal(result.metadata.bodyState, 'malformed_json');
  assert.equal(JSON.stringify(result.metadata).includes(marker), false);
  assert.equal(JSON.stringify(result.metadata).includes('x-private'), false);
});

test('the exact128KiB boundary succeeds; an oversized body cancels without awaiting underlying cancel', async () => {
  const exact = await inspect('{}' + ' '.repeat(LIMITS.providerResponseBytes - 2));
  assert.ok(exact.response);
  assert.equal((await exact.response.arrayBuffer()).byteLength, LIMITS.providerResponseBytes);
  let cancelled = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LIMITS.providerResponseBytes + 1));
      },
      cancel() {
        cancelled++;
        return new Promise<void>(() => {});
      },
    }),
    { status: 503 },
  );
  const result = await observeEvaluationError(response, {
    signal: new AbortController().signal,
    now: Date.now,
    deadline: Date.now() + 1000,
  });
  assert.equal(result.response, null);
  assert.equal(result.metadata.bodyState, 'response_limit');
  assert.equal(cancelled, 1);
  assert.equal(response.body!.locked, false);
});

test('a stalled body is bounded by remaining deadline, cleans listeners, and never waits on cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = 0;
  let now = 1000;
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel() {
        cancelled++;
        return new Promise<void>(() => {});
      },
    }),
    { status: 429 },
  );
  const observed = observeEvaluationError(response, {
    signal: controller.signal,
    now: () => now,
    deadline: 1017,
  });
  now = 1017;
  t.mock.timers.tick(17);
  const result = await observed;
  assert.equal(result.response, null);
  assert.equal(result.metadata.bodyState, 'deadline');
  assert.equal(cancelled, 1);
  assert.equal(response.body!.locked, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort and stream read failures retain only omission states and release the reader', async () => {
  for (const mode of ['abort', 'read_failure'] as const) {
    const controller = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          if (mode === 'read_failure') stream.error(new Error(marker));
        },
      }),
      { status: 429 },
    );
    const pending = observeEvaluationError(response, {
      signal: controller.signal,
      now: Date.now,
      deadline: Date.now() + 1000,
    });
    if (mode === 'abort') controller.abort(new Error(marker));
    const result = await pending;
    assert.equal(result.response, null);
    assert.equal(result.metadata.bodyState, mode === 'abort' ? 'aborted' : 'read_failure');
    assert.equal(JSON.stringify(result.metadata).includes(marker), false);
    assert.equal(response.body!.locked, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});
