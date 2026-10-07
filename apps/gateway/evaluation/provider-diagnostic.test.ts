import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { HttpOptions } from '@google/genai';
import {
  createDiagnosticDispatchGuard,
  DiagnosticStopped,
  DIAGNOSTIC_BOUNDS,
  DIAGNOSTIC_MODEL,
  DIAGNOSTIC_PROMPT,
  DIAGNOSTIC_REQUEST_JSON,
  inspectDiagnosticApprovalInputs,
  runProviderDiagnostic,
} from './provider-diagnostic';
import type { DiagnosticApproval, OfflineDiagnosticClock } from './provider-diagnostic';

// Every transport and clock in this file is explicitly injected; no network fallback or real key.
const KEY = 'OFFLINE_FICTIONAL_KEY_[literal].*+?';
const PRIVATE = 'OFFLINE_RAW_BODY_THOUGHT_HEADERS_MUST_NOT_SURVIVE';
type SdkFetch = NonNullable<HttpOptions['fetch']>;
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
      const aborted = () => {
        reject(new Error('OFFLINE timer aborted'));
      };
      signal.addEventListener('abort', aborted, { once: true });
      this.deadline = () => {
        signal.removeEventListener('abort', aborted);
        resolve();
      };
    });
  }
  expire() {
    assert.ok(this.deadline, 'Request deadline was armed after the quiet period');
    this.time += 45_000;
    this.deadline();
  }
}
async function fixture(t: TestContext, mutate?: (approval: DiagnosticApproval) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-one-call-offline-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('cookmate-one-call-offline-'));
    await rm(target, { recursive: true, force: true });
  });
  const clock = new FixtureClock();
  const approvalPath = join(directory, 'approval.json');
  const resultPath = join(directory, 'result.json');
  const approval: DiagnosticApproval = {
    ...(await inspectDiagnosticApprovalInputs()),
    version: 1,
    authorization: 'ROOT_APPROVED_ONE_DIAGNOSTIC',
    runId: 'one-call-20260928-01',
    expiresAt: new Date(clock.now() + 300_000).toISOString(),
    paths: { approval: approvalPath, result: resultPath },
  };
  mutate?.(approval);
  await writeFile(approvalPath, JSON.stringify(approval), { flag: 'wx' });
  let keys = 0;
  const options = {
    mode: 'OFFLINE_INJECTED' as const,
    approvalPath,
    resultPath,
    clock,
    readKey: () => {
      keys++;
      return KEY;
    },
  };
  return {
    options,
    clock,
    approval,
    approvalPath,
    resultPath,
    claimPath: join(directory, `${approval.runId}.consumed.jsonl`),
    keys: () => keys,
  };
}
function success(text = '{"ok":true}', extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: PRIVATE,
      model: DIAGNOSTIC_MODEL,
      status: 'completed',
      usage: { total_input_tokens: 12, total_output_tokens: 5, total_thought_tokens: 0 },
      steps: [
        { type: 'thought', text: PRIVATE },
        { type: 'model_output', content: [{ type: 'text', text }] },
      ],
      ...extra,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'x-private': PRIVATE } },
  );
}
const stopReason = (reason: DiagnosticStopped['reason']) => (error: unknown) =>
  error instanceof DiagnosticStopped && error.reason === reason;
async function assertPrivateAbsent(path: string) {
  const saved = await readFile(path, 'utf8');
  for (const forbidden of [
    KEY,
    PRIVATE,
    'AIza',
    'Bearer',
    'sk-secret',
    'output_text',
    'parts',
    'sha256',
  ])
    assert.equal(
      saved.includes(forbidden),
      false,
      `Persisted disallowed value/field: ${forbidden}`,
    );
  return saved;
}

test(
  'official SDK sends only the exact tiny request after a durable reservation; result retains fixed proof only',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const fetch: SdkFetch = async (input, init) => {
      calls++;
      assert.ok(input instanceof Request, 'Installed Interactions SDK supplies Request input');
      assert.equal(input.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
      assert.equal(input.method, 'POST');
      assert.equal(input.bodyUsed, false, 'Wire inspection must not consume the original SDK body');
      assert.equal(await input.text(), DIAGNOSTIC_REQUEST_JSON);
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal);
      assert.equal(f.keys(), 1);
      assert.deepEqual(f.clock.sleeps, [65_000, 45_000]);
      assert.equal(await readFile(f.resultPath, 'utf8'), '', 'Terminal evidence is written once');
      const marker = (await readFile(f.claimPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      assert.deepEqual(marker, [
        { version: 1, runId: f.approval.runId, state: 'CONSUMED_NO_RESUME' },
        { state: 'DISPATCH_RESERVED', attempts: 1 },
      ]);
      return success();
    };
    const result = await runProviderDiagnostic({ ...f.options, fetch });
    assert.equal(calls, 1);
    assert.equal(result.outcome, 'OBSERVED');
    assert.equal(result.returnTo, 'HOLD');
    assert.equal(result.mode, 'OFFLINE_INJECTED');
    assert.equal(result.physicalRequests, 1);
    assert.equal(result.modelMatches, true);
    assert.equal(result.expectedJsonMatches, true);
    assert.deepEqual(result.usage, {
      status: 'KNOWN',
      inputTokens: 12,
      outputTokens: 5,
      thoughtTokens: 0,
    });
    assert.deepEqual(JSON.parse(await assertPrivateAbsent(f.resultPath)), result);
    assert.ok(Buffer.byteLength(DIAGNOSTIC_PROMPT) <= 128);
    assert.ok(Buffer.byteLength(DIAGNOSTIC_REQUEST_JSON) <= 512);
  },
);

test(
  'claim replay and an existing result prevent key access and any additional physical request',
  { timeout: 5_000 },
  async (t) => {
    const replay = await fixture(t);
    let calls = 0;
    const fetch: SdkFetch = async () => {
      calls++;
      return success();
    };
    await runProviderDiagnostic({ ...replay.options, fetch });
    const original = await readFile(replay.resultPath, 'utf8');
    await assert.rejects(runProviderDiagnostic({ ...replay.options, fetch }));
    await assert.rejects(
      runProviderDiagnostic({
        ...replay.options,
        resultPath: join(dirname(replay.resultPath), 'new.json'),
        fetch,
      }),
    );
    assert.equal(calls, 1);
    assert.equal(replay.keys(), 1);
    assert.equal(await readFile(replay.resultPath, 'utf8'), original);
    const occupied = await fixture(t);
    await writeFile(occupied.resultPath, 'PREEXISTING_SYNTHETIC_EVIDENCE', { flag: 'wx' });
    await assert.rejects(runProviderDiagnostic({ ...occupied.options, fetch }));
    assert.equal(occupied.keys(), 0);
    assert.equal(await readFile(occupied.resultPath, 'utf8'), 'PREEXISTING_SYNTHETIC_EVIDENCE');
    assert.equal(calls, 1);
  },
);

test(
  'copied approval bytes cannot be replayed or rebound to another filename under the same run ID',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const fetch: SdkFetch = async () => {
      calls++;
      return success();
    };
    await runProviderDiagnostic({ ...f.options, fetch });
    const copiedPath = join(dirname(f.approvalPath), 'approval-copy.json');
    const copiedResult = join(dirname(f.resultPath), 'result-copy.json');
    await writeFile(copiedPath, await readFile(f.approvalPath), { flag: 'wx' });
    await assert.rejects(
      runProviderDiagnostic({
        ...f.options,
        approvalPath: copiedPath,
        resultPath: copiedResult,
        fetch,
      }),
      stopReason('approval_invalid'),
    );
    // Even edited path bindings cannot mint a second claim for the same run in this directory.
    await writeFile(
      copiedPath,
      JSON.stringify({ ...f.approval, paths: { approval: copiedPath, result: copiedResult } }),
    );
    await assert.rejects(
      runProviderDiagnostic({
        ...f.options,
        approvalPath: copiedPath,
        resultPath: copiedResult,
        fetch,
      }),
      (error: unknown) =>
        error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST',
    );
    assert.equal(calls, 1);
    assert.equal(f.keys(), 1);
    await assert.rejects(readFile(copiedResult));
  },
);

test(
  'expired approval, changed source digest, runtime or bounds reject before credential access',
  { timeout: 5_000 },
  async (t) => {
    const edits: Array<(approval: DiagnosticApproval) => void> = [
      (a) => {
        a.expiresAt = '2026-09-28T09:00:00.000Z';
      },
      (a) => {
        a.sourceDigests['apps/gateway/evaluation/provider-diagnostic.ts'] = '0'.repeat(64);
      },
      (a) => {
        a.runtime.sdkVersion = 'unreviewed';
      },
      (a) => {
        a.bounds = {
          ...DIAGNOSTIC_BOUNDS,
          maxHttpRequests: 2,
        } as unknown as typeof DIAGNOSTIC_BOUNDS;
      },
    ];
    for (const edit of edits) {
      const f = await fixture(t, edit);
      await assert.rejects(
        runProviderDiagnostic({
          ...f.options,
          fetch: async () => {
            assert.fail('No dispatch');
          },
        }),
      );
      assert.equal(f.keys(), 0);
      await assert.rejects(readFile(f.claimPath));
    }
    const expiresDuringQuiet = await fixture(t, (a) => {
      a.expiresAt = '2026-09-28T10:00:30.000Z';
    });
    const result = await runProviderDiagnostic({
      ...expiresDuringQuiet.options,
      fetch: async () => {
        assert.fail('No dispatch');
      },
    });
    assert.equal(result.stopReason, 'approval_expired');
    assert.equal(result.dispatchReserved, false);
    assert.equal(expiresDuringQuiet.keys(), 0);
    await assert.rejects(
      runProviderDiagnostic({
        ...expiresDuringQuiet.options,
        fetch: async () => {
          assert.fail('No replay');
        },
      }),
    );
  },
);

test('physical guard refuses a second/concurrent dispatch and changed bodies, methods or endpoints', async () => {
  const request = () =>
    new Request('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      body: DIAGNOSTIC_REQUEST_JSON,
    });
  const guard = createDiagnosticDispatchGuard();
  const original = request();
  const first = guard(original);
  await assert.rejects(guard(request()), stopReason('dispatch_limit'));
  await first;
  assert.equal(await original.text(), DIAGNOSTIC_REQUEST_JSON);
  for (const changed of [
    new Request('https://generativelanguage.googleapis.com/v1beta/interactions?key=unsafe', {
      method: 'POST',
      body: DIAGNOSTIC_REQUEST_JSON,
    }),
    new Request('https://generativelanguage.googleapis.com/v1beta/interactions'),
    new Request('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      body: DIAGNOSTIC_REQUEST_JSON.replace('256', '512'),
    }),
  ])
    await assert.rejects(createDiagnosticDispatchGuard()(changed), stopReason('request_mismatch'));
});

test(
  '503 and 429 retain only allowlisted metadata, never retry or follow provider prose',
  { timeout: 5_000 },
  async (t) => {
    for (const status of [503, 429]) {
      const f = await fixture(t);
      let calls = 0;
      const result = await runProviderDiagnostic({
        ...f.options,
        fetch: async () => {
          calls++;
          return new Response(
            JSON.stringify({
              error: {
                code: status === 503 ? 'service_unavailable' : 'resource_exhausted',
                status: status === 503 ? 'UNAVAILABLE' : 'RESOURCE_EXHAUSTED',
                message: `${PRIVATE} ${KEY} Bearer sk-secret`,
                details: [
                  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' },
                ],
              },
            }),
            {
              status,
              headers: { 'content-type': 'application/json', 'retry-after': '3', 'x-private': KEY },
            },
          );
        },
      });
      assert.equal(result.outcome, 'FAILED');
      assert.equal(result.stopReason, 'http_error');
      assert.equal(result.httpStatus, status);
      assert.equal(result.physicalRequests, 1);
      assert.equal(calls, 1);
      assert.equal(result.errorMetadata?.bodyState, 'parsed');
      assert.deepEqual(result.errorMetadata?.retryAfterDelayMs, { state: 'valid', value: 3000 });
      assert.deepEqual(
        f.clock.sleeps,
        [65_000, 45_000],
        'Retry metadata does not schedule a retry',
      );
      await assertPrivateAbsent(f.resultPath);
    }
  },
);

test(
  'HTTP 200 is insufficient: wrong model/JSON, incomplete completion and missing usage remain failed',
  { timeout: 5_000 },
  async (t) => {
    const cases: Array<{ text?: string; extra?: Record<string, unknown>; reason: string }> = [
      { extra: { model: 'gemini-3.5-flash-lite' }, reason: 'output_mismatch' },
      { text: '{"ok":false}', reason: 'output_mismatch' },
      { text: '{"ok":true,"extra":1}', reason: 'output_mismatch' },
      { extra: { status: 'incomplete' }, reason: 'output_mismatch' },
      {
        extra: { usage: { total_input_tokens: 12, total_output_tokens: 5 } },
        reason: 'unknown_usage',
      },
      {
        extra: {
          usage: { total_input_tokens: 12, total_output_tokens: 255, total_thought_tokens: 2 },
        },
        reason: 'usage_limit',
      },
      { text: JSON.stringify({ ok: true, text: KEY }), reason: 'unsafe_output' },
    ];
    for (const entry of cases) {
      const f = await fixture(t);
      const result = await runProviderDiagnostic({
        ...f.options,
        fetch: async () => success(entry.text, entry.extra),
      });
      assert.equal(result.outcome, 'FAILED');
      assert.equal(result.stopReason, entry.reason);
      assert.equal(result.physicalRequests, 1);
      if (entry.reason === 'unknown_usage') {
        assert.equal(result.usage.status, 'UNKNOWN');
        assert.equal(result.usage.thoughtTokens, null);
      }
      await assertPrivateAbsent(f.resultPath);
    }
  },
);

test(
  'deadline cancels a stalled successful body without awaiting an abort-ignoring cancel promise',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    const reading = deferred<void>();
    let cancelled = 0;
    const running = runProviderDiagnostic({
      ...f.options,
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!stream.locked) {
              controller.enqueue(new Uint8Array([32]));
              return;
            }
            reading.resolve();
            return new Promise<void>(() => {});
          },
          cancel() {
            cancelled++;
            return new Promise<void>(() => {});
          },
        });
        return new Response(stream, { headers: { 'content-type': 'application/json' } });
      },
    });
    await reading.promise;
    f.clock.expire();
    const result = await running;
    assert.equal(result.stopReason, 'deadline');
    assert.equal(cancelled, 1);
    assert.equal(result.physicalRequests, 1);
    await assertPrivateAbsent(f.resultPath);
  },
);

test(
  'started 429 observation is drained into fixed omission metadata before terminal evidence',
  { timeout: 5_000 },
  async (t) => {
    const f = await fixture(t);
    const reading = deferred<void>();
    let cancelled = 0;
    const running = runProviderDiagnostic({
      ...f.options,
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!stream.locked) {
              controller.enqueue(new Uint8Array([32]));
              return;
            }
            reading.resolve();
            return new Promise<void>(() => {});
          },
          cancel() {
            cancelled++;
            return new Promise<void>(() => {});
          },
        });
        return new Response(stream, {
          status: 429,
          headers: { 'content-type': 'application/json', 'x-private': PRIVATE },
        });
      },
    });
    await reading.promise;
    f.clock.expire();
    const result = await running;
    assert.equal(result.stopReason, 'http_error');
    assert.equal(result.httpStatus, 429);
    assert.ok(result.errorMetadata);
    assert.ok(['deadline', 'aborted'].includes(result.errorMetadata.bodyState));
    assert.equal(cancelled, 1);
    assert.deepEqual(JSON.parse(await assertPrivateAbsent(f.resultPath)), result);
  },
);

test(
  'oversized body stops promptly and late abort-ignoring fetch cannot change terminal evidence',
  { timeout: 5_000 },
  async (t) => {
    const oversized = await fixture(t);
    let cancelled = 0;
    const large = await runProviderDiagnostic({
      ...oversized.options,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(131_073));
            },
            cancel() {
              cancelled++;
              return new Promise<void>(() => {});
            },
          }),
        ),
    });
    assert.equal(large.stopReason, 'response_limit');
    assert.equal(cancelled, 1);
    const f = await fixture(t);
    const entered = deferred<void>();
    const late = deferred<Response>();
    const dropped = deferred<void>();
    const running = runProviderDiagnostic({
      ...f.options,
      fetch: async () => {
        entered.resolve();
        return late.promise;
      },
    });
    await entered.promise;
    f.clock.expire();
    const result = await running;
    assert.equal(result.stopReason, 'deadline');
    assert.equal(result.dispatchReserved, true);
    assert.equal(result.physicalRequests, 1);
    const terminal = await readFile(f.resultPath, 'utf8');
    late.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            dropped.resolve();
          },
        }),
      ),
    );
    await dropped.promise;
    assert.equal(await readFile(f.resultPath, 'utf8'), terminal);
    assert.equal(result.httpStatus, null);
  },
);

test('raw transport errors are never persisted', { timeout: 5_000 }, async (t) => {
  const f = await fixture(t);
  const result = await runProviderDiagnostic({
    ...f.options,
    fetch: async () => {
      throw new Error(`${PRIVATE} ${KEY}`);
    },
  });
  assert.equal(result.stopReason, 'transport_failure');
  assert.equal(result.physicalRequests, 1);
  await assertPrivateAbsent(f.resultPath);
});
