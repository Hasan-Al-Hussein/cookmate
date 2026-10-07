import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runJsonModeTextDiagnostic,
  sanitizeFictionalGeneratedText,
} from '../src/json-mode-text-diagnostic';
import {
  JSON_MODE_ENVELOPE_SCHEMA_TEXT,
  JSON_MODE_SYSTEM_INSTRUCTION,
} from '../src/json-mode-proof';
import { LIMITS } from '../src/limits';
import { SMOKE_TEXT } from '../src/memory-smoke';
import { MODEL_RESPONSE_SCHEMA, PROVIDER_ENVELOPE_SCHEMA } from '../src/provider-schema';
import { SYSTEM_INSTRUCTION } from '../src/provider-contract';
import { serializeSyntheticShapeDiagnostic } from '../src/synthetic-shape-diagnostic';

const model = 'gemini-3.5-flash-lite' as const;
const apiKey = 'FICTIONAL_TEXT_[literal].*+?';
const hidden = 'PRIVATE_HTTP_ENVELOPE_ONLY';
const cap = 32 * 1024;
type Body = Record<string, unknown>;
function record(value: unknown): Body {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Body;
}
function validStep(body: Body) {
  assert.ok(typeof body.input === 'string');
  const request = record(record(JSON.parse(body.input)).request);
  const source = record(request.message);
  assert.equal(typeof source.messageId, 'string');
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
function completed(text: string, extras: Body = {}) {
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
) {
  const requests: {
    url: string;
    body: Body;
    init: RequestInit;
    method: string;
    signal: AbortSignal | null | undefined;
  }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.ok(init && typeof init.body === 'string');
    const body = record(JSON.parse(init.body));
    requests.push({
      url,
      body,
      init,
      method: init.method ?? (input instanceof Request ? input.method : 'GET'),
      signal: init.signal ?? (input instanceof Request ? input.signal : undefined),
    });
    return url.endsWith(':countTokens') ? Response.json({ totalTokens: 1000 }) : reply(body);
  };
  return { requests, run: () => runJsonModeTextDiagnostic({ apiKey, model, fetch: transport }) };
}
function included(text: string, key = apiKey) {
  const capture = sanitizeFictionalGeneratedText(text, key);
  assert.equal(capture.status, 'included');
  assert.equal(capture.originalTextBytes, Buffer.byteLength(text));
  assert.equal(capture.sanitizedTextBytes, Buffer.byteLength(capture.generatedText!));
  assert.equal(
    capture.serializedTextBytes,
    Buffer.byteLength(JSON.stringify(capture.generatedText)),
  );
  return capture;
}

test('sanitizer removes exact literal and JSON-escaped credentials without treating regex syntax as code', () => {
  const literal = 'FICTIONAL_[.*+?]\\"\n_ONLY';
  const escaped = JSON.stringify(literal).slice(1, -1);
  assert.notEqual(literal, escaped);
  const capture = included(`before ${literal} middle ${escaped} after`, literal);
  assert.equal(capture.generatedText, 'before [REDACTED] middle [REDACTED] after');
  assert.equal(capture.redactionCount, 2);
  const serialized = JSON.stringify(capture);
  assert.equal(serialized.includes(literal), false);
  assert.equal(serialized.includes(escaped), false);
});

test('Google, sk and Bearer patterns are redacted from generated text', () => {
  const google = 'AIza' + 'aB9_-'.repeat(7);
  const sk = 'sk-proj-fictional_1234567890-ONLY';
  const bearer = 'eyJfictional.abc123_signature~+/==';
  const capture = included(`${google}\n${sk}\nBeArEr ${bearer}`);
  assert.equal(capture.generatedText, '[REDACTED]\n[REDACTED]\n[REDACTED]');
  assert.equal(capture.redactionCount, 3);
  for (const credential of [google, sk, bearer])
    assert.equal(JSON.stringify(capture).includes(credential), false);
});

test('sensitive labels conservatively omit the entire text even when syntax is broken', () => {
  for (const label of [
    'authorization',
    'authentication',
    'api_key',
    'apiKey',
    'API-KEY',
    'token',
    'access_token',
    'refresh_token',
    'password',
    'passwd',
    'secret',
    'credential',
    'private_key',
    'private key',
    'passphrase',
    'cookie',
    'connection_string',
    'auth',
    'pwd',
    'key',
    'Bearer:',
  ]) {
    const text = `{"${label}": "PRIVATE_LABEL_VALUE",`;
    const capture = sanitizeFictionalGeneratedText(text, apiKey);
    assert.equal(capture.status, 'omitted_sensitive_marker', label);
    assert.equal(capture.generatedText, null);
    assert.equal(JSON.stringify(capture).includes('PRIVATE_LABEL_VALUE'), false);
    assert.equal(capture.sanitizedTextBytes, null);
  }
});

test('Unicode, hex, malformed and octal escapes are omitted instead of decoded or repaired', () => {
  for (const text of [
    String.raw`{"text":"\u0041"}`,
    String.raw`{"text":"\x41"}`,
    String.raw`{"text":"\u{41}"}`,
    String.raw`{"text":"\uZZZZ"}`,
    String.raw`{"text":"\xZ"}`,
    String.raw`{"text":"\101"}`,
    String.raw`{"text":"\0"}`,
  ]) {
    const capture = sanitizeFictionalGeneratedText(text, apiKey);
    assert.equal(capture.status, 'omitted_ambiguous_encoding');
    assert.equal(capture.generatedText, null);
    assert.equal(JSON.stringify(capture).includes(text), false);
  }
});

test('whitespace, fences, prose, trailing commas and literal Unicode are preserved exactly', () => {
  for (const text of [
    ' \r\n{}\t ',
    ' \n```json\n{"meal":"🍲",}\n```\t',
    'Here is the result:\n{"meal": "🍲",}\n',
    ' \r\n{ "meal": "🍲", }\t',
    String.raw`{"meal":"a \"quoted\" dish"}`,
  ]) {
    const capture = included(text);
    assert.equal(capture.generatedText, text);
    assert.equal(capture.redactionCount, 0);
  }
});

test('the capture cap uses compact serialized UTF-8 bytes including escaping expansion', () => {
  assert.equal(included('x'.repeat(cap - 2)).serializedTextBytes, cap);
  assert.equal(included('"'.repeat((cap - 2) / 2)).serializedTextBytes, cap);
  for (const [text, expected] of [
    ['x'.repeat(cap - 1), cap + 1],
    ['"'.repeat(cap / 2), cap + 2],
    ['🍲'.repeat(cap / 4), cap + 2],
    ['\n'.repeat(cap / 2), cap + 2],
  ] as const) {
    const capture = sanitizeFictionalGeneratedText(text, apiKey);
    assert.equal(capture.status, 'omitted_too_large');
    assert.equal(capture.generatedText, null);
    assert.equal(capture.serializedTextBytes, expected);
  }
  const huge = sanitizeFictionalGeneratedText('x'.repeat(LIMITS.providerResponseBytes + 1), apiKey);
  assert.equal(huge.status, 'omitted_too_large');
  assert.equal(huge.generatedText, null);
  assert.equal(huge.sanitizedTextBytes, null);
});

test('installed SDK retains sanitized single-part invalid JSON while normal JSON validation still fails', async () => {
  const raw = ` \n\`\`\`json\n{"meal":"🍲","note":"${apiKey}",}\n\`\`\`\t`;
  const f = fixture(() => completed(raw));
  const report = await f.run();
  assert.equal(report.cases[0]!.disposition, 'FAIL');
  assert.equal(report.cases[0]!.code, 'invalid_model_result');
  assert.equal(report.modelText.status, 'included');
  assert.equal(report.modelText.generatedText, raw.replace(apiKey, '[REDACTED]'));
  assert.equal(report.modelText.originalTextBytes, Buffer.byteLength(raw));
  assert.equal(report.capturedOutputs, 0);
  assert.equal(report.modelOutput, null);
  const jsonCheck = report.cases[0]!.diagnostics.find((event) => event.stage === 'json_check');
  assert.deepEqual(jsonCheck, { stage: 'json_check', valid: false });
  assert.equal(report.physicalRequests, 2);
  assert.equal(f.requests.length, 2);
  const saved = serializeSyntheticShapeDiagnostic(report);
  assert.equal(saved, JSON.stringify(report) + '\n');
  assert.equal(saved.includes(apiKey), false);
  assert.equal(saved.includes(hidden), false);
  assert.equal(JSON.parse(saved).modelText.generatedText, raw.replace(apiKey, '[REDACTED]'));
});

test('valid full-schema output still passes exact quote/review and preserves JSON-proof request settings', async () => {
  const frozenFull = JSON.stringify(MODEL_RESPONSE_SCHEMA);
  const frozenGrammar = JSON.stringify(PROVIDER_ENVELOPE_SCHEMA);
  let generatedText = '';
  const f = fixture((body) => {
    generatedText = JSON.stringify({ step: validStep(body) });
    return completed(generatedText);
  });
  const report = await f.run();
  assert.equal(report.cases[0]!.disposition, 'PASS');
  assert.equal(report.cases[0]!.normalizationValid, true);
  assert.equal(report.cases[0]!.exactQuote, true);
  assert.equal(report.cases[0]!.exactReview, true);
  assert.equal(report.modelOutput?.fullShapeValid, true);
  assert.equal(report.modelText.status, 'included');
  assert.equal(report.modelText.generatedText, generatedText);
  assert.equal(report.invariantFailed, false);
  assert.ok(Object.values(report.invariants).every(Boolean));
  assert.equal(f.requests.length, 2);
  const counted = f.requests[0]!;
  const generated = f.requests[1]!;
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
    input: generated.body.input,
    system_instruction: JSON_MODE_SYSTEM_INSTRUCTION,
    store: false,
    stream: false,
    generation_config: { max_output_tokens: LIMITS.outputTokens },
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
  assert.equal(typeof generated.body.input, 'string');
  const request = record(record(JSON.parse(generated.body.input as string)).request);
  assert.equal(record(request.message).text, SMOKE_TEXT);
  assert.deepEqual(request.capabilities, []);
  assert.deepEqual(record(request.context).history, []);
  for (const sent of f.requests) {
    assert.equal(sent.method, 'POST');
    assert.equal(sent.init.redirect, 'error');
    assert.ok(sent.signal instanceof AbortSignal);
    assert.equal(JSON.stringify(sent.body).includes(apiKey), false);
  }
  assert.equal(report.bounds.inputAdmissionPerGeneration, 12000);
  assert.equal(report.bounds.outputAndThoughtPerGeneration, 2000);
  assert.equal(report.bounds.deadlineMsPerTurn, 45000);
  assert.equal(report.bounds.networkRequests, 2);
  assert.equal(report.bounds.retries, 0);
  assert.equal(report.combinedGeneratedCaptureByteLimit, cap);
  assert.equal(report.generatedTextIsUntrustedData, true);
  assert.equal(JSON.stringify(MODEL_RESPONSE_SCHEMA), frozenFull);
  assert.equal(JSON.stringify(PROVIDER_ENVELOPE_SCHEMA), frozenGrammar);
});

test('HTTP 400 and 503 never capture text, retry or retain raw headers and error prose', async () => {
  for (const status of [400, 503]) {
    const f = fixture(() =>
      Response.json(
        {
          error: { code: 'invalid_request', message: hidden + apiKey },
          steps: [{ type: 'model_output', content: [{ type: 'text', text: hidden }] }],
        },
        { status, headers: { 'x-private': hidden } },
      ),
    );
    const report = await f.run();
    assert.equal(report.cases[0]!.disposition, 'FAIL');
    assert.equal(report.modelText.status, 'not_observed');
    assert.equal(report.modelText.generatedText, null);
    assert.equal(report.capturedOutputs, 0);
    assert.equal(report.physicalRequests, 2);
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.stringify(report).includes(hidden), false);
    assert.equal(JSON.stringify(report).includes(apiKey), false);
  }
});

test('mismatched model, incomplete completion and invalid usage cannot authorize text capture', async () => {
  for (const extras of [
    { model: 'gemini-fictional-other' },
    { status: 'in_progress' },
    { usage: null },
    { usage: {} },
    { usage: { total_input_tokens: 1000, total_output_tokens: -1, total_thought_tokens: 0 } },
    { usage: { total_input_tokens: 1000, total_output_tokens: 1999, total_thought_tokens: 2 } },
  ]) {
    const f = fixture(() => completed('FICTIONAL_UNVERIFIED_PROSE', extras));
    const report = await f.run();
    assert.equal(report.cases[0]!.disposition, 'FAIL');
    assert.equal(report.modelText.status, 'omitted_unverified_output');
    assert.equal(report.modelText.generatedText, null);
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.stringify(report).includes('FICTIONAL_UNVERIFIED_PROSE'), false);
  }
});

test('multiple steps, multiple text parts, mixed content and malformed parts omit raw text capture', async () => {
  const text = { type: 'text', text: 'FICTIONAL_AMBIGUOUS_PROSE' };
  for (const steps of [
    [
      { type: 'model_output', content: [text] },
      { type: 'model_output', content: [text] },
    ],
    [
      { type: 'thought', text: 'fictional' },
      { type: 'model_output', content: [text] },
    ],
    [{ type: 'model_output', content: [text, text] }],
    [{ type: 'model_output', content: [{ type: 'thought', text: 'fictional' }, text] }],
    [{ type: 'model_output', content: [{ type: 'text', text: 4 }] }],
    [{ type: 'model_output', content: [] }],
    [],
    null,
  ]) {
    const f = fixture(() => completed('unused', { steps }));
    const report = await f.run();
    assert.equal(report.modelText.status, 'omitted_ambiguous_output');
    assert.equal(report.modelText.generatedText, null);
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.stringify(report).includes('FICTIONAL_AMBIGUOUS_PROSE'), false);
  }
});

test('the original 128 KiB HTTP envelope cap rejects and cancels before any text extraction', async () => {
  let cancelled = 0;
  const f = fixture(() => {
    const body = Buffer.from(
      JSON.stringify({
        model,
        status: 'completed',
        padding: 'x'.repeat(LIMITS.providerResponseBytes + 1),
      }),
    );
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const report = await f.run();
  assert.equal(report.cases[0]!.disposition, 'FAIL');
  assert.equal(report.modelText.status, 'omitted_too_large');
  assert.equal(report.modelText.generatedText, null);
  assert.equal(report.capturedOutputs, 0);
  assert.equal(report.modelText.originalTextBytes, null);
  assert.equal(cancelled, 1);
  assert.equal(f.requests.length, 2);
});

test(
  'deadline abort releases a stalled partial body without awaiting an unresponsive cancel callback',
  { timeout: 5000 },
  async (context) => {
    let generationStarted = () => {};
    const generation = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    let stalledReadStarted = () => {};
    const stalled = new Promise<void>((resolve) => {
      stalledReadStarted = resolve;
    });
    let cancelled = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(Buffer.from(`{"partial":"${hidden}`));
          },
          pull() {
            // With a zero high-water mark this occurs only when the queued partial chunk
            // has been consumed and the reader is waiting for another chunk.
            stalledReadStarted();
          },
          cancel() {
            cancelled++;
            return new Promise<void>(() => {});
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'content-type': 'application/json' } },
    );
    const f = fixture(() => {
      generationStarted();
      return response;
    });
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = f.run();
      await generation;
      await stalled;
      assert.equal(response.body?.locked, true);
      assert.equal(f.requests.length, 2);
      context.mock.timers.tick(LIMITS.deadlineMs);
      const report = await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(report.cases[0]!.disposition, 'FAIL');
      assert.equal(report.cases[0]!.code, 'deadline');
      assert.equal(report.physicalRequests, 2);
      assert.equal(f.requests.length, 2);
      assert.equal(report.capturedOutputs, 0);
      assert.equal(report.modelOutput, null);
      assert.equal(report.modelText.generatedText, null);
      assert.equal(JSON.stringify(report).includes(hidden), false);
      assert.equal(cancelled, 1);
      assert.equal(response.body?.locked, false);
    } finally {
      context.mock.timers.reset();
    }
  },
);

test('text and parsed JSON share one 32 KiB capture budget while full-shape validation remains strict', async () => {
  const f = fixture((body) => {
    const step = validStep(body);
    step.response.text = 'x'.repeat(18 * 1024);
    return completed(JSON.stringify({ step }));
  });
  const report = await f.run();
  assert.equal(report.cases[0]!.disposition, 'FAIL');
  assert.equal(report.modelOutput?.fullShapeValid, false);
  assert.equal(report.modelOutput?.generatedJsonStatus, 'included');
  assert.equal(report.modelText.status, 'omitted_shared_capture_limit');
  assert.equal(report.modelText.generatedText, null);
  assert.ok(report.modelText.serializedTextBytes! < cap);
  assert.ok(Buffer.byteLength(JSON.stringify(report.modelOutput?.generatedJson)) < cap);
  assert.ok(
    report.modelText.serializedTextBytes! +
      Buffer.byteLength(JSON.stringify(report.modelOutput?.generatedJson)) >
      cap,
  );
  assert.equal(f.requests.length, 2);
});

test('text diagnostic CLI uses the new flag and refuses an existing evidence path before execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-json-text-'));
  const output = join(directory, 'evidence.json');
  try {
    await writeFile(output, 'retained fictional evidence');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/gateway/diagnostics/legacy-json-mode-20260928/src/json-mode-text-diagnostic.ts',
        '--execute',
        '--capture-fictional-model-text',
        '--model',
        model,
        '--output',
        output,
      ],
      {
        cwd: new URL('../../../../../', import.meta.url),
        env: { GEMINI_API_KEY: '' },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(await readFile(output, 'utf8'), 'retained fictional evidence');
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Fictional text diagnostic failed/);
    assert.equal(result.stderr.includes(hidden), false);
  } finally {
    await rm(output, { force: true });
    await rmdir(directory);
  }
});
