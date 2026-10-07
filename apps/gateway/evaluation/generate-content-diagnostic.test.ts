import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import {
  createGenerateContentDispatchGuard,
  GENERATE_CONTENT_ENDPOINT,
  GENERATE_CONTENT_REQUEST_JSON,
  inspectGenerateContentApprovalInputs,
  runGenerateContentDiagnostic,
} from './generate-content-diagnostic';
import type { GenerateContentApproval } from './generate-content-diagnostic';
import { DIAGNOSTIC_MODEL, DIAGNOSTIC_PROMPT, DiagnosticStopped } from './provider-diagnostic';
import type { OfflineDiagnosticClock } from './provider-diagnostic';

// Every call is explicitly OFFLINE_INJECTED: fictional credentials, transport and clock.
const KEY = 'OFFLINE_FICTIONAL_KEY_[literal].*+?';
const PRIVATE = 'OFFLINE_PROVIDER_PROSE_HEADERS_THOUGHT_MUST_NOT_SURVIVE';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class FixtureClock implements OfflineDiagnosticClock {
  time = Date.parse('2026-09-28T10:00:00.000Z');
  sleeps: number[] = [];
  quietHook: (() => Promise<void>) | undefined;
  private deadline: (() => void) | undefined;
  now() {
    return this.time;
  }
  async sleep(milliseconds: number, signal: AbortSignal) {
    signal.throwIfAborted();
    this.sleeps.push(milliseconds);
    if (milliseconds === 65_000) {
      await this.quietHook?.();
      this.time += milliseconds;
      return;
    }
    assert.equal(milliseconds, 45_000);
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(new Error('OFFLINE timer aborted'));
      signal.addEventListener('abort', aborted, { once: true });
      this.deadline = () => {
        signal.removeEventListener('abort', aborted);
        resolve();
      };
    });
  }
  expire() {
    assert.ok(this.deadline);
    this.time += 45_000;
    this.deadline();
  }
}
async function fixture(t: TestContext, mutate?: (approval: GenerateContentApproval) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-generate-content-offline-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('cookmate-generate-content-offline-'));
    await rm(target, { recursive: true, force: true });
  });
  const clock = new FixtureClock();
  const approvalPath = join(directory, 'approval.json');
  const resultPath = join(directory, 'result.json');
  const approval: GenerateContentApproval = {
    ...(await inspectGenerateContentApprovalInputs()),
    version: 1,
    authorization: 'ROOT_APPROVED_ONE_GENERATE_CONTENT_DIAGNOSTIC',
    runId: 'generate-content-20260928-01',
    expiresAt: new Date(clock.now() + 300_000).toISOString(),
    paths: { approval: approvalPath, result: resultPath },
  };
  mutate?.(approval);
  await writeFile(approvalPath, JSON.stringify(approval), { flag: 'wx' });
  let keys = 0;
  return {
    clock,
    approval,
    approvalPath,
    resultPath,
    claimPath: join(directory, `${approval.runId}.consumed.jsonl`),
    keys: () => keys,
    options: {
      mode: 'OFFLINE_INJECTED' as const,
      approvalPath,
      resultPath,
      clock,
      readKey: () => {
        keys++;
        return KEY;
      },
    },
  };
}
function envelope(extra: Record<string, unknown> = {}) {
  return {
    modelVersion: DIAGNOSTIC_MODEL,
    responseId: PRIVATE,
    candidates: [
      {
        content: { role: 'model', parts: [{ text: '{"ok":true}' }] },
        finishReason: 'STOP',
        finishMessage: PRIVATE,
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 0 },
    ...extra,
  };
}
function success(extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify(envelope(extra)), {
    headers: { 'content-type': 'application/json', 'x-private': PRIVATE },
  });
}
const stopped = (reason: DiagnosticStopped['reason']) => (error: unknown) =>
  error instanceof DiagnosticStopped && error.reason === reason;
async function saved(path: string) {
  const text = await readFile(path, 'utf8');
  for (const forbidden of [
    KEY,
    PRIVATE,
    'AIza',
    'Bearer',
    'parts',
    'finishMessage',
    'responseId',
    'modelVersion',
  ])
    assert.equal(text.includes(forbidden), false, `Unsafe retained field/value: ${forbidden}`);
  return text;
}

test(
  'installed SDK emits one exact GenerateContent POST after quiet wait and durable reservation',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const result = await runGenerateContentDiagnostic({
      ...f.options,
      fetch: async (input, init) => {
        calls++;
        const request = new Request(input instanceof Request ? input.clone() : input, init);
        assert.equal(request.url, GENERATE_CONTENT_ENDPOINT);
        assert.equal(request.method, 'POST');
        assert.equal(await request.text(), GENERATE_CONTENT_REQUEST_JSON);
        assert.equal(init?.redirect, 'error');
        assert.ok(init?.signal);
        assert.equal(f.keys(), 1);
        assert.deepEqual(f.clock.sleeps, [65_000, 45_000]);
        assert.equal(await readFile(f.resultPath, 'utf8'), '');
        assert.deepEqual(
          (await readFile(f.claimPath, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
          [
            { version: 1, runId: f.approval.runId, state: 'CONSUMED_NO_RESUME' },
            { state: 'DISPATCH_RESERVED', attempts: 1 },
          ],
        );
        return success();
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.outcome, 'VALIDATED_TINY_RESPONSE');
    assert.equal(result.returnTo, 'HOLD');
    assert.equal(result.route, 'GENERATE_CONTENT');
    assert.equal(result.physicalRequests, 1);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.completionReason, 'STOP');
    assert.equal(result.modelMatches, true);
    assert.equal(result.expectedJsonMatches, true);
    assert.equal(result.cleanup, 'SETTLED');
    assert.deepEqual(result.usage, {
      status: 'KNOWN',
      inputTokens: 12,
      outputTokens: 5,
      thoughtTokens: 0,
    });
    assert.deepEqual(JSON.parse(await saved(f.resultPath)), result);
    assert.equal(
      f.approval.promptSha256,
      createHash('sha256').update(DIAGNOSTIC_PROMPT).digest('hex'),
    );
    assert.equal(
      f.approval.requestSha256,
      createHash('sha256').update(GENERATE_CONTENT_REQUEST_JSON).digest('hex'),
    );
    assert.ok(f.approval.sourceDigests['apps/gateway/evaluation/generate-content-diagnostic.ts']);
    assert.ok(
      f.approval.sourceDigests['apps/gateway/evaluation/generate-content-diagnostic.test.ts'],
    );
  },
);

test('exact endpoint/body guard consumes even a bad first attempt and rejects concurrent attempts', async () => {
  for (const [url, body] of [
    [
      GENERATE_CONTENT_ENDPOINT.replace('gemini-3.8-flash', 'gemini-3.5-flash-lite'),
      GENERATE_CONTENT_REQUEST_JSON,
    ],
    [GENERATE_CONTENT_ENDPOINT + '?alt=json', GENERATE_CONTENT_REQUEST_JSON],
    ['https://example.invalid/collect', GENERATE_CONTENT_REQUEST_JSON],
    [GENERATE_CONTENT_ENDPOINT, '{}'],
  ]) {
    const guard = createGenerateContentDispatchGuard();
    await assert.rejects(guard(url!, { method: 'POST', body: body! }), stopped('request_mismatch'));
    await assert.rejects(
      guard(GENERATE_CONTENT_ENDPOINT, { method: 'POST', body: GENERATE_CONTENT_REQUEST_JSON }),
      stopped('dispatch_limit'),
    );
  }
  const guard = createGenerateContentDispatchGuard();
  const first = guard(GENERATE_CONTENT_ENDPOINT, {
    method: 'POST',
    body: GENERATE_CONTENT_REQUEST_JSON,
  });
  await assert.rejects(
    guard(GENERATE_CONTENT_ENDPOINT, { method: 'POST', body: GENERATE_CONTENT_REQUEST_JSON }),
    stopped('dispatch_limit'),
  );
  await first;
});

test('consumed approval and existing output cannot be replayed or overwritten', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const options = {
    ...f.options,
    fetch: async () => {
      calls++;
      return success();
    },
  };
  await runGenerateContentDiagnostic(options);
  const before = await saved(f.resultPath);
  await assert.rejects(runGenerateContentDiagnostic(options));
  assert.equal(calls, 1);
  assert.equal(f.keys(), 1);
  assert.equal(await saved(f.resultPath), before);
  const other = await fixture(t);
  await writeFile(other.resultPath, 'DO_NOT_OVERWRITE', { flag: 'wx' });
  await assert.rejects(
    runGenerateContentDiagnostic({ ...other.options, fetch: options.fetch }),
    stopped('evidence_failure'),
  );
  assert.equal(await readFile(other.resultPath, 'utf8'), 'DO_NOT_OVERWRITE');
  assert.equal(other.keys(), 0);
});

test('approval, path, expiry, request and source binding fail before credential access', async (t) => {
  const mutations: ((approval: GenerateContentApproval) => void)[] = [
    (a) => {
      a.authorization = 'ROOT_APPROVED_ONE_DIAGNOSTIC' as GenerateContentApproval['authorization'];
    },
    (a) => {
      a.requestSha256 = '0'.repeat(64);
    },
    (a) => {
      a.sourceDigests['apps/gateway/evaluation/generate-content-diagnostic.ts'] = '0'.repeat(64);
    },
    (a) => {
      a.paths.result = join(dirname(a.paths.result), 'other.json');
    },
    (a) => {
      a.expiresAt = '2026-09-28T09:00:00.000Z';
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t, mutate);
    await assert.rejects(
      runGenerateContentDiagnostic({
        ...f.options,
        fetch: async () => {
          throw new Error('must not dispatch');
        },
      }),
    );
    assert.equal(f.keys(), 0);
  }
  const f = await fixture(t, (a) => {
    a.expiresAt = '2026-09-28T10:01:00.000Z';
  });
  const result = await runGenerateContentDiagnostic({
    ...f.options,
    fetch: async () => {
      throw new Error('must not dispatch');
    },
  });
  assert.equal(result.stopReason, 'approval_expired');
  assert.equal(f.keys(), 0);
  assert.equal(result.physicalRequests, 0);
});

test('HTTP 200 is separate from valid output, fixed completion and complete combined usage', async (t) => {
  const cases: [Record<string, unknown>, DiagnosticStopped['reason']][] = [
    [{ modelVersion: PRIVATE }, 'output_mismatch'],
    [
      {
        candidates: [
          { finishReason: PRIVATE, content: { role: 'model', parts: [{ text: '{"ok":true}' }] } },
        ],
      },
      'output_mismatch',
    ],
    [
      {
        candidates: [
          { finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: '{"ok":' }] } },
        ],
      },
      'output_mismatch',
    ],
    [
      {
        candidates: [
          {
            finishReason: 'STOP',
            content: { role: 'model', parts: [{ text: '{"ok":true}', thought: true }] },
          },
        ],
      },
      'output_mismatch',
    ],
    [
      {
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [{ text: '{"ok":true}' }, { functionCall: { name: PRIVATE } }],
            },
          },
        ],
      },
      'output_mismatch',
    ],
    [{ candidates: [envelope().candidates[0], envelope().candidates[0]] }, 'output_mismatch'],
    [
      {
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: KEY }] } }],
      },
      'output_mismatch',
    ],
    [{ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 } }, 'unknown_usage'],
    [
      { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: -1 } },
      'unknown_usage',
    ],
    [
      { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 252 } },
      'usage_limit',
    ],
  ];
  for (const [extra, reason] of cases) {
    const f = await fixture(t);
    const result = await runGenerateContentDiagnostic({
      ...f.options,
      fetch: async () => success(extra),
    });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.stopReason, reason);
    assert.equal(result.physicalRequests, 1);
    if (reason === 'unknown_usage') assert.equal(result.usage.thoughtTokens, null);
    await saved(f.resultPath);
  }
});

test('HTTP errors reuse fixed metadata without retry or retained prose/headers', async (t) => {
  for (const status of [429, 503]) {
    const f = await fixture(t);
    let calls = 0;
    const result = await runGenerateContentDiagnostic({
      ...f.options,
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            error: {
              code: status,
              message: PRIVATE,
              status: status === 503 ? 'UNAVAILABLE' : 'RESOURCE_EXHAUSTED',
            },
          }),
          { status, headers: { 'retry-after': '30', 'x-private': KEY } },
        );
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.stopReason, 'http_error');
    assert.equal(result.httpStatus, status);
    assert.equal(result.errorMetadata?.bodyState, 'parsed');
    assert.equal(result.errorMetadata?.retryAfterDelayMs.value, 30_000);
    await saved(f.resultPath);
  }
});

test('transport and malformed JSON failures never retain exception/body text', async (t) => {
  for (const fetch of [
    async () => {
      throw new Error(`${KEY} ${PRIVATE}`);
    },
    async () => new Response(`${KEY} ${PRIVATE}`),
  ]) {
    const f = await fixture(t);
    const result = await runGenerateContentDiagnostic({ ...f.options, fetch });
    assert.equal(result.outcome, 'FAILED');
    assert.equal(result.physicalRequests, 1);
    assert.equal(result.cleanup, 'SETTLED');
    await saved(f.resultPath);
  }
});

test(
  'oversize body cancels and holds physical lease until asynchronous cancellation settles',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    const cancellation = deferred<void>();
    let cancelled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(131_073));
        },
        cancel() {
          cancelled++;
          return cancellation.promise;
        },
      }),
    );
    const result = await runGenerateContentDiagnostic({
      ...f.options,
      fetch: async () => response,
    });
    const before = await saved(f.resultPath);
    assert.equal(result.stopReason, 'response_limit');
    assert.equal(result.cleanup, 'PENDING');
    assert.equal(cancelled, 1);
    const blocked = await fixture(t);
    await assert.rejects(
      runGenerateContentDiagnostic({ ...blocked.options, fetch: async () => success() }),
      stopped('dispatch_limit'),
    );
    assert.equal(blocked.keys(), 0);
    cancellation.resolve();
    await immediate();
    assert.equal(await saved(f.resultPath), before);
    assert.equal(
      (await runGenerateContentDiagnostic({ ...blocked.options, fetch: async () => success() }))
        .outcome,
      'VALIDATED_TINY_RESPONSE',
    );
  },
);

test(
  'deadline interrupts stalled body without waiting for hostile cancellation',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    const reading = deferred<void>();
    const cancellation = deferred<void>();
    let cancelled = 0;
    const running = runGenerateContentDiagnostic({
      ...f.options,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              reading.resolve();
            },
            cancel() {
              cancelled++;
              return cancellation.promise;
            },
          }),
        ),
    });
    await reading.promise;
    f.clock.expire();
    const result = await running;
    assert.equal(result.stopReason, 'deadline');
    assert.equal(result.httpStatus, 200);
    assert.equal(result.cleanup, 'PENDING');
    assert.equal(cancelled, 1);
    const before = await saved(f.resultPath);
    cancellation.resolve();
    await immediate();
    assert.equal(await saved(f.resultPath), before);
  },
);

test(
  'unsettled fetch holds the lease; late response is dropped and cannot change terminal evidence',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    const dispatched = deferred<void>();
    const transport = deferred<Response>();
    const running = runGenerateContentDiagnostic({
      ...f.options,
      fetch: async () => {
        dispatched.resolve();
        return transport.promise;
      },
    });
    await dispatched.promise;
    f.clock.expire();
    const result = await running;
    assert.equal(result.stopReason, 'deadline');
    assert.equal(result.cleanup, 'PENDING');
    assert.equal(result.httpStatus, null);
    const before = await saved(f.resultPath);
    const blocked = await fixture(t);
    await assert.rejects(
      runGenerateContentDiagnostic({ ...blocked.options, fetch: async () => success() }),
      stopped('dispatch_limit'),
    );
    let dropped = false;
    transport.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            dropped = true;
          },
        }),
      ),
    );
    await immediate();
    assert.equal(dropped, true);
    assert.equal(await saved(f.resultPath), before);
    assert.equal(
      (await runGenerateContentDiagnostic({ ...blocked.options, fetch: async () => success() }))
        .outcome,
      'VALIDATED_TINY_RESPONSE',
    );
  },
);
