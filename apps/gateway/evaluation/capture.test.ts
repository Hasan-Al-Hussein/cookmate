import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { GoogleGenAI } from '@google/genai';
import type { HttpOptions } from '@google/genai';
import {
  CaptureObservationError,
  observeSyntheticResponse,
  sanitizeSyntheticStructuredCopy,
} from './capture';
import type { SyntheticResponseCapture } from './capture';
import { LIMITS } from '../src/limits';

const model = 'gemini-3.5-flash-lite';
const apiKey = 'SYNTHETIC_CAPTURE_ONLY_[literal].*+?';
const excluded = 'SYNTHETIC_ENVELOPE_THOUGHT_HEADER_NOT_CAPTURED';
const captureLimit = 32 * 1024;
const knownUsage = { status: 'KNOWN', inputTokens: 100, outputTokens: 20, thoughtTokens: 0 };
const unknownUsage = {
  status: 'UNKNOWN',
  inputTokens: null,
  outputTokens: null,
  thoughtTokens: null,
};
const text = (value: unknown) => ({ type: 'text', text: value });
const output = (...parts: unknown[]) => ({ type: 'model_output', content: parts });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function envelope(steps: unknown, extras: Record<string, unknown> = {}) {
  return {
    id: excluded,
    input: excluded,
    model,
    status: 'completed',
    usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 0 },
    steps,
    ...extras,
  };
}
function options(apiKeyOverride = apiKey) {
  const unsafe: string[] = [];
  const controller = new AbortController();
  return {
    unsafe,
    controller,
    options: {
      apiKey: apiKeyOverride,
      signal: controller.signal,
      onUnsafe: (reason: string) => {
        unsafe.push(reason);
      },
    },
  };
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real installed SDK with a fictional transport, never a network fallback. */
async function sdkFixture(steps: unknown, extras: Record<string, unknown> = {}) {
  const state = options();
  const bytes = Buffer.from(` \n${JSON.stringify(envelope(steps, extras))}\r\n`);
  const captures: SyntheticResponseCapture[] = [];
  let calls = 0;
  const transport: NonNullable<HttpOptions['fetch']> = async (input) => {
    calls++;
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const original = new Response(bytes, {
      status: 200,
      statusText: 'Synthetic',
      headers: { 'content-type': 'application/json', 'x-fixture-private': excluded },
    });
    // The SDK already owns a listener on this signal; observation must preserve it.
    const existingAbortListeners = getEventListeners(state.controller.signal, 'abort');
    const observed = await observeSyntheticResponse(original, state.options);
    captures.push(observed.capture);
    assert.equal(original.body?.locked, false);
    assert.equal(observed.response.status, 200);
    assert.equal(observed.response.statusText, 'Synthetic');
    assert.equal(observed.response.headers.get('x-fixture-private'), excluded);
    assert.deepEqual(getEventListeners(state.controller.signal, 'abort'), existingAbortListeners);
    assert.deepEqual(Buffer.from(await observed.response.clone().arrayBuffer()), bytes);
    return observed.response;
  };
  const client = new GoogleGenAI({
    apiKey,
    vertexai: false,
    apiVersion: 'v1beta',
    httpOptions: { fetch: transport, retryOptions: { attempts: 1 }, timeout: 1000 },
  });
  const result = await client.interactions.create(
    {
      model,
      api_version: 'v1beta',
      input: 'SYNTHETIC offline capture fixture only.',
      store: false,
      stream: false,
      response_format: { type: 'text', mime_type: 'application/json' },
    },
    {
      signal: state.controller.signal,
      timeout_ms: 1000,
      retries: { strategy: 'none' },
      maxRetries: 0,
    },
  );
  assert.equal(calls, 1);
  assert.equal(captures.length, 1);
  return { capture: captures[0]!, result, unsafe: state.unsafe, bytes };
}

test('installed SDK receives exact original bytes while indexed multi-step Unicode text is preserved', async () => {
  const first = ' \n{';
  const second = '"meal":"\ud83c';
  const third = '\udf72"}\t';
  const f = await sdkFixture([
    { type: 'thought', content: [text(excluded + apiKey)] },
    output(text(first), text(second)),
    output(text(third)),
  ]);
  assert.equal(f.capture.fixture, 'SYNTHETIC');
  assert.equal(f.capture.status, 'captured');
  assert.equal(f.capture.selected_text, 'NOT_OBSERVED');
  assert.deepEqual(f.capture.parts, [
    { stepIndex: 1, contentIndex: 0, text: first, utf8Bytes: Buffer.byteLength(first) },
    { stepIndex: 1, contentIndex: 1, text: second, utf8Bytes: Buffer.byteLength(second) },
    { stepIndex: 2, contentIndex: 0, text: third, utf8Bytes: Buffer.byteLength(third) },
  ]);
  assert.equal(f.capture.modelOutputSteps, 2);
  assert.equal(f.capture.modelTextParts, 3);
  assert.deepEqual(f.capture.usage, knownUsage);
  assert.equal(f.capture.responseBytes, f.bytes.byteLength);
  assert.equal(f.capture.serializedBytes, Buffer.byteLength(JSON.stringify(f.capture.parts)));
  assert.equal(f.capture.sha256, hash(JSON.stringify(f.capture.parts)));
  assert.equal(f.result.output_text, first + second + third);
  assert.equal(JSON.stringify(f.capture).includes(excluded), false);
  assert.equal(JSON.stringify(f.capture).includes(apiKey), false);
  assert.deepEqual(f.unsafe, []);
});

test('SDK final-run selection is distinct from all captured model text and is never claimed observed', async () => {
  const first = '{"earlier":"Saved everything."}';
  const last = '{"later":"fictional answer"}';
  const f = await sdkFixture([
    output(text(first)),
    { type: 'thought', summary: [] },
    output({ type: 'thought', summary: [] }, text(last)),
  ]);
  assert.equal(f.result.output_text, last);
  assert.equal(f.capture.status, 'captured');
  assert.deepEqual(
    f.capture.parts.map((part) => [part.stepIndex, part.contentIndex, part.text]),
    [
      [0, 0, first],
      [2, 1, last],
    ],
  );
  assert.equal(f.capture.selected_text, 'NOT_OBSERVED');
  assert.equal(Object.hasOwn(f.capture, 'selectedText'), false);
  assert.equal(Object.hasOwn(f.capture, 'text'), false);
});

test('malformed generated JSON, whitespace, fences and false completion wording remain exact evidence', async () => {
  const raw = ' \r\n```json\n{"extra": "🍲",}\n```\tSaved everything. ';
  const f = await sdkFixture([output(text(raw))]);
  assert.throws(() => JSON.parse(raw));
  assert.equal(f.capture.status, 'captured');
  assert.equal(f.capture.parts[0]?.text, raw);
  assert.equal(f.result.output_text, raw);
  assert.deepEqual(f.capture.usage, knownUsage);
  assert.equal(f.capture.sha256, hash(JSON.stringify(f.capture.parts)));
});

test('missing usage does not erase safely attributable emitted text or claim provider validity', async () => {
  const f = await sdkFixture([output(text('{"fictional":true}'))], { usage: undefined });
  assert.equal(f.result.usage, undefined);
  assert.equal(f.capture.status, 'captured');
  assert.deepEqual(f.capture.usage, unknownUsage);
  assert.equal(f.capture.selected_text, 'NOT_OBSERVED');
  assert.equal(Object.hasOwn(f.capture, 'usageValid'), false);
  assert.equal(Object.hasOwn(f.capture, 'pass'), false);
});

test('reported usage remains KNOWN above production caps and with an invalid generated model shape', async () => {
  const counts = {
    total_input_tokens: 576001,
    total_output_tokens: 96001,
    total_thought_tokens: 5000,
  };
  const f = await sdkFixture([output(text('{"not_a_model_kind":true}'))], {
    usage: { ...counts, extra: apiKey },
  });
  assert.deepEqual(f.capture.usage, {
    status: 'KNOWN',
    inputTokens: counts.total_input_tokens,
    outputTokens: counts.total_output_tokens,
    thoughtTokens: counts.total_thought_tokens,
  });
  assert.equal(f.capture.status, 'captured');
  assert.equal(f.result.output_text, '{"not_a_model_kind":true}');
  assert.equal(JSON.stringify(f.capture).includes(apiKey), false);
  assert.deepEqual(f.unsafe, []);
});

test('missing or invalid usage fields remain null and UNKNOWN while valid remaining counts survive', async () => {
  const fields = [
    ['total_input_tokens', 'inputTokens'],
    ['total_output_tokens', 'outputTokens'],
    ['total_thought_tokens', 'thoughtTokens'],
  ] as const;
  const invalidValues = [
    undefined,
    null,
    -1,
    0.5,
    '7',
    false,
    {},
    [],
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
    NaN,
  ];
  for (const [wire, projected] of fields) {
    for (const invalid of invalidValues) {
      const state = options();
      const usage = {
        total_input_tokens: 100,
        total_output_tokens: 20,
        total_thought_tokens: 0,
        [wire]: invalid,
      };
      const result = await observeSyntheticResponse(
        Response.json(envelope([output(text('fictional'))], { usage })),
        state.options,
      );
      assert.deepEqual(result.capture.usage, {
        ...knownUsage,
        status: 'UNKNOWN',
        [projected]: null,
      });
      assert.equal(result.capture.status, 'captured');
      assert.deepEqual(state.unsafe, []);
    }
  }
  for (const usage of [undefined, null, false, 'usage', []]) {
    const state = options();
    const result = await observeSyntheticResponse(
      Response.json(envelope([output(text('fictional'))], { usage })),
      state.options,
    );
    assert.deepEqual(result.capture.usage, unknownUsage);
    assert.deepEqual(state.unsafe, []);
  }
  const zero = await observeSyntheticResponse(
    Response.json(
      envelope([output(text('fictional'))], {
        usage: { total_input_tokens: 0, total_output_tokens: 0, total_thought_tokens: 0 },
      }),
    ),
    options().options,
  );
  assert.deepEqual(zero.capture.usage, {
    status: 'KNOWN',
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
  });
  const overflow = await observeSyntheticResponse(
    new Response(
      '{"usage":{"total_input_tokens":1e400,"total_output_tokens":20,"total_thought_tokens":0},"steps":[]}',
    ),
    options().options,
  );
  assert.deepEqual(overflow.capture.usage, { ...knownUsage, status: 'UNKNOWN', inputTokens: null });
});

test('decoded numeric usage survives text omissions while undecodable envelopes remain UNKNOWN', async () => {
  const cases: [unknown, string][] = [
    [null, 'malformed_envelope'],
    [[null], 'malformed_envelope'],
    [[{ type: 'model_output' }], 'ambiguous_model_text'],
    [[output(text(1))], 'ambiguous_model_text'],
    [[{ type: 'thought', text: excluded }], 'no_model_text'],
    [[output(text(apiKey))], 'unsafe_credential'],
    [[output(text(String.raw`\u0053`))], 'unsafe_encoding'],
    [[output(text('x'.repeat(captureLimit)))], 'capture_limit'],
  ];
  for (const [steps, reason] of cases) {
    const result = await observeSyntheticResponse(
      Response.json(envelope(steps)),
      options().options,
    );
    assert.equal(result.capture.reason, reason);
    assert.deepEqual(result.capture.usage, knownUsage);
  }
  for (const raw of ['{malformed', 'null', '[]', 'true']) {
    const result = await observeSyntheticResponse(new Response(raw), options().options);
    assert.equal(result.capture.reason, 'malformed_envelope');
    assert.deepEqual(result.capture.usage, unknownUsage);
  }
  const noBody = await observeSyntheticResponse(new Response(null), options().options);
  assert.equal(noBody.capture.reason, 'no_body');
  assert.deepEqual(noBody.capture.usage, unknownUsage);
});

test('HTTP error bodies pass through unread without inspecting or capturing them', async () => {
  for (const status of [400, 503]) {
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            pulls++;
          },
        },
        { highWaterMark: 0 },
      ),
      { status, headers: { 'x-private': excluded } },
    );
    const state = options();
    const result = await observeSyntheticResponse(response, state.options);
    assert.equal(result.response, response);
    assert.equal(response.bodyUsed, false);
    assert.equal(response.body?.locked, false);
    assert.equal(pulls, 0);
    assert.equal(result.capture.reason, 'not_successful');
    assert.equal(result.capture.responseBytes, null);
    assert.equal(result.capture.sha256, null);
    assert.deepEqual(result.capture.usage, unknownUsage);
    assert.deepEqual(result.capture.parts, []);
    assert.deepEqual(state.unsafe, []);
    await response.body?.cancel();
  }
});

test('malformed and ambiguous API envelopes return typed omission while original bytes stay intact', async () => {
  const cases: [string, string][] = [
    ['{bad SYNTHETIC_ENVELOPE', 'malformed_envelope'],
    ['null', 'malformed_envelope'],
    [JSON.stringify({ steps: null }), 'malformed_envelope'],
    [JSON.stringify(envelope([null])), 'malformed_envelope'],
    [JSON.stringify(envelope([{ type: 'model_output' }])), 'ambiguous_model_text'],
    [JSON.stringify(envelope([output(text(1))])), 'ambiguous_model_text'],
    [JSON.stringify(envelope([output(null)])), 'ambiguous_model_text'],
    [JSON.stringify(envelope([{ type: 'thought', text: excluded }])), 'no_model_text'],
  ];
  for (const [body, reason] of cases) {
    const state = options();
    const result = await observeSyntheticResponse(new Response(body), state.options);
    assert.equal(result.capture.status, 'omitted');
    assert.equal(result.capture.reason, reason);
    assert.equal(result.capture.sha256, null);
    assert.deepEqual(result.capture.parts, []);
    assert.equal(await result.response.text(), body);
    assert.equal(JSON.stringify(result.capture).includes(excluded), false);
    assert.deepEqual(state.unsafe, []);
  }
  const invalidUtf8 = await observeSyntheticResponse(
    new Response(new Uint8Array([0xff])),
    options().options,
  );
  assert.equal(invalidUtf8.capture.reason, 'malformed_envelope');
  assert.deepEqual(
    new Uint8Array(await invalidUtf8.response.arrayBuffer()),
    new Uint8Array([0xff]),
  );
});

test('literal and cross-part supplied credentials omit all text and synchronously latch unsafe', async () => {
  for (const strings of [[apiKey], [apiKey.slice(0, 9), apiKey.slice(9)]]) {
    const events: string[] = [];
    const body = JSON.stringify(envelope(strings.map((part) => output(text(part)))));
    const result = await observeSyntheticResponse(new Response(body), {
      apiKey,
      signal: new AbortController().signal,
      onUnsafe: (reason) => {
        events.push(reason);
      },
    }).then((value) => {
      events.push('returned');
      return value;
    });
    assert.deepEqual(events, ['unsafe_credential', 'returned']);
    assert.equal(result.capture.reason, 'unsafe_credential');
    assert.deepEqual(result.capture.parts, []);
    assert.equal(result.capture.sha256, null);
    assert.equal(result.capture.serializedBytes, 0);
    assert.equal(JSON.stringify(result.capture).includes(apiKey), false);
    assert.equal(await result.response.text(), body);
  }
});

test('JSON-escaped and Unicode/hex/octal concealed indicators omit instead of repairing', async () => {
  const supplied = 'SYNTHETIC/[.*+?]"\\VALUE';
  const escaped = JSON.stringify(supplied).slice(1, -1);
  const cases = [
    {
      strings: [escaped.slice(0, 10), escaped.slice(10)],
      key: supplied,
      reason: 'unsafe_credential',
    },
    { strings: ['\\', 'u0053YNTHETIC'], key: apiKey, reason: 'unsafe_encoding' },
    { strings: [String.raw`\x53YNTHETIC`], key: apiKey, reason: 'unsafe_encoding' },
    { strings: [String.raw`\123YNTHETIC`], key: apiKey, reason: 'unsafe_encoding' },
    { strings: [String.raw`\u{53}YNTHETIC`], key: apiKey, reason: 'unsafe_encoding' },
  ];
  for (const sample of cases) {
    const state = options(sample.key);
    const result = await observeSyntheticResponse(
      Response.json(envelope(sample.strings.map((part) => output(text(part))))),
      state.options,
    );
    assert.equal(result.capture.reason, sample.reason);
    assert.deepEqual(state.unsafe, [sample.reason]);
    assert.deepEqual(result.capture.parts, []);
    assert.equal(result.capture.sha256, null);
  }
});

test('generic credentials and sensitive labels are detected across indexed parts without reading thoughts', async () => {
  const google = 'AIza' + 'aB9_-'.repeat(7);
  for (const indicator of [
    google,
    'sk-proj-synthetic_1234567890',
    'Bearer synthetic.opaque',
    '{"password":"opaque"}',
    '{"api_key":"opaque"}',
  ]) {
    const state = options();
    const result = await observeSyntheticResponse(
      Response.json(
        envelope([
          output(text(indicator.slice(0, 2))),
          { type: 'thought', content: [text(excluded)] },
          output(text(indicator.slice(2))),
        ]),
      ),
      state.options,
    );
    assert.equal(result.capture.reason, 'unsafe_credential');
    assert.deepEqual(state.unsafe, ['unsafe_credential']);
    assert.equal(result.capture.sha256, null);
    assert.equal(JSON.stringify(result.capture).includes(indicator), false);
  }
  const state = options();
  const safe = await observeSyntheticResponse(
    Response.json(
      envelope([
        { type: 'thought', content: [text(apiKey)] },
        output({ type: 'thought', text: apiKey }, text('fictional meal')),
      ]),
    ),
    state.options,
  );
  assert.equal(safe.capture.status, 'captured');
  assert.deepEqual(state.unsafe, []);
});

test('known text indicators still latch when another model part has ambiguous attribution', async () => {
  const state = options();
  const result = await observeSyntheticResponse(
    Response.json(envelope([output(text(apiKey), text(1))])),
    state.options,
  );
  assert.equal(result.capture.reason, 'unsafe_credential');
  assert.deepEqual(state.unsafe, ['unsafe_credential']);
  assert.equal(result.capture.sha256, null);
});

test('the 32 KiB limit covers the entire serialized indexed list including escaping, with no truncation', async () => {
  const byteSize = (value: string) =>
    Buffer.byteLength(
      JSON.stringify([
        { stepIndex: 0, contentIndex: 0, text: value, utf8Bytes: Buffer.byteLength(value) },
      ]),
    );
  const length = captureLimit - byteSize('') - 4; // Five-digit byte count replaces the one-digit zero.
  assert.ok(length >= 10000 && length < 100000);
  const exactText = 'x'.repeat(length);
  assert.equal(byteSize(exactText), captureLimit);
  const exact = await observeSyntheticResponse(
    Response.json(envelope([output(text(exactText))])),
    options().options,
  );
  assert.equal(exact.capture.status, 'captured');
  assert.equal(exact.capture.serializedBytes, captureLimit);
  for (const value of [exactText + 'x', '"'.repeat(captureLimit / 2)]) {
    const result = await observeSyntheticResponse(
      Response.json(envelope([output(text(value))])),
      options().options,
    );
    assert.equal(result.capture.reason, 'capture_limit');
    assert.deepEqual(result.capture.parts, []);
    assert.equal(result.capture.serializedBytes, 0);
    assert.equal(result.capture.sha256, null);
  }
});

test(
  'the 128 KiB body bound surfaces to the wrapper and cancels without awaiting underlying completion',
  { timeout: 5000 },
  async () => {
    const body = JSON.stringify(envelope([output(text('fictional'))]));
    const exactBytes = Buffer.from(
      body + ' '.repeat(LIMITS.providerResponseBytes - Buffer.byteLength(body)),
    );
    const accepted = await observeSyntheticResponse(new Response(exactBytes), options().options);
    assert.equal(accepted.capture.status, 'captured');
    assert.equal(accepted.capture.responseBytes, LIMITS.providerResponseBytes);
    assert.deepEqual(Buffer.from(await accepted.response.arrayBuffer()), exactBytes);
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
    );
    await assert.rejects(
      observeSyntheticResponse(response, options().options),
      (error: unknown) =>
        error instanceof CaptureObservationError && error.reason === 'response_limit',
    );
    assert.equal(cancelled, 1);
    assert.equal(response.body?.locked, false);
  },
);

test(
  'a stalled partial read obeys the deadline even when stream cancellation never settles',
  { timeout: 5000 },
  async (context) => {
    const state = options();
    const waiting = deferred();
    const deadline = new Error('SYNTHETIC deadline');
    let cancelled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(Buffer.from('{"partial":'));
          },
          pull() {
            waiting.resolve();
          },
          cancel() {
            cancelled++;
            return new Promise<void>(() => {});
          },
        },
        { highWaterMark: 0 },
      ),
    );
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = observeSyntheticResponse(response, state.options);
      const rejected = assert.rejects(pending, (error: unknown) => error === deadline);
      setTimeout(() => state.controller.abort(deadline), LIMITS.deadlineMs);
      await waiting.promise;
      assert.equal(response.body?.locked, true);
      context.mock.timers.tick(LIMITS.deadlineMs);
      await rejected;
      assert.equal(cancelled, 1);
      assert.equal(response.body?.locked, false);
      assert.equal(getEventListeners(state.controller.signal, 'abort').length, 0);
      assert.deepEqual(state.unsafe, []);
    } finally {
      context.mock.timers.reset();
    }
  },
);

test('read failures and unsafe-latch failures reach the controlling caller rather than a swallowed observer', async () => {
  const state = options();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(excluded));
      },
    }),
  );
  await assert.rejects(
    observeSyntheticResponse(response, state.options),
    (error: unknown) =>
      error instanceof CaptureObservationError &&
      error.reason === 'read_failure' &&
      !error.message.includes(excluded),
  );
  assert.equal(response.body?.locked, false);
  assert.equal(getEventListeners(state.controller.signal, 'abort').length, 0);
  const latchFailure = new Error('SYNTHETIC stop latch failure');
  await assert.rejects(
    observeSyntheticResponse(Response.json(envelope([output(text(apiKey))])), {
      ...state.options,
      onUnsafe() {
        throw latchFailure;
      },
    }),
    (error: unknown) => error === latchFailure,
  );
});

test('structured evidence keeps extra fields and false wording unchanged in a detached safe copy', () => {
  const state = options();
  const original = {
    kind: 'respond',
    wrongBranchField: { arbitrary: 'Saved everything.' },
    values: ['🍲', 3, false, null],
  };
  const captured = sanitizeSyntheticStructuredCopy(original, {
    ...state.options,
    remainingBytes: captureLimit,
  });
  assert.equal(captured.status, 'captured');
  assert.deepEqual(captured.value, original);
  assert.notEqual(captured.value, original);
  assert.equal(captured.serializedBytes, Buffer.byteLength(JSON.stringify(captured.value)));
  assert.equal(captured.sha256, hash(JSON.stringify(captured.value)));
  record(record(captured.value).wrongBranchField).arbitrary = 'changed copy';
  assert.equal(original.wrongBranchField.arbitrary, 'Saved everything.');
  assert.deepEqual(state.unsafe, []);
});

test('structured copy gets only the shared budget remaining after pre-parse text, without truncation', async () => {
  const state = options();
  const textCapture = await observeSyntheticResponse(
    Response.json(envelope([output(text('x'.repeat(20 * 1024)))])),
    state.options,
  );
  assert.equal(textCapture.capture.status, 'captured');
  const value = { extra: 'x'.repeat(16 * 1024) };
  const parsed = sanitizeSyntheticStructuredCopy(value, {
    ...state.options,
    remainingBytes: captureLimit - textCapture.capture.serializedBytes,
  });
  assert.equal(parsed.reason, 'capture_limit');
  assert.equal(parsed.value, null);
  assert.equal(parsed.sha256, null);
  assert.equal(parsed.serializedBytes, 0);
  assert.equal(value.extra.length, 16 * 1024);
  assert.equal(textCapture.capture.parts[0]?.text.length, 20 * 1024);
});

test('structured property names, values and escaped indicators omit and latch without raw hashes', () => {
  for (const value of [
    { [apiKey]: 'fictional' },
    { text: apiKey },
    { pwd: 'opaque' },
    { text: String.raw`\u0041` },
  ]) {
    const state = options();
    const result = sanitizeSyntheticStructuredCopy(value, {
      ...state.options,
      remainingBytes: captureLimit,
    });
    assert.equal(result.status, 'omitted');
    assert.equal(result.value, null);
    assert.equal(result.sha256, null);
    assert.equal(state.unsafe.length, 1);
    assert.equal(JSON.stringify(result).includes(apiKey), false);
  }
});

test('structured malformed objects, cycles, accessors and resource limits fail closed without execution', () => {
  const state = options();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let calls = 0;
  const getter = Object.defineProperty({}, 'text', {
    enumerable: true,
    get() {
      calls++;
      throw new Error(excluded);
    },
  });
  let deep: unknown = 'fictional';
  for (let index = 0; index < 26; index++) deep = { child: deep };
  for (const value of [
    cycle,
    getter,
    undefined,
    NaN,
    1n,
    new Date(),
    deep,
    Array.from({ length: 4097 }, () => null),
    'x'.repeat(LIMITS.providerResponseBytes + 1),
  ]) {
    const result = sanitizeSyntheticStructuredCopy(value, {
      ...state.options,
      remainingBytes: captureLimit,
    });
    assert.equal(result.status, 'omitted');
    assert.equal(result.value, null);
    assert.equal(result.sha256, null);
    assert.equal(JSON.stringify(result).includes(excluded), false);
  }
  assert.equal(calls, 0);
  const inert = JSON.parse('{"__proto__":{"fictional":true}}');
  const result = sanitizeSyntheticStructuredCopy(inert, {
    ...state.options,
    remainingBytes: captureLimit,
  });
  assert.equal(result.status, 'captured');
  assert.equal(Object.hasOwn(record(result.value), '__proto__'), true);
  assert.equal(Object.hasOwn(Object.prototype, 'fictional'), false);
});
