import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeminiProvider } from '../src/gemini';
import { createOrchestrator, createProviderBudget } from '../src/orchestrator';
import { createEvidenceBuilder } from '../src/evidence';
import { GatewayError, gatewayError } from '../src/errors';
import type { ProviderInput } from '../src/provider-contract';
import { request, deferred } from './helpers';

const model = 'gemini-3.5-flash-lite' as const;
const marker = 'FICTIONAL_PROVIDER_KEY_DO_NOT_LOG';
type Capture = { url: URL; init: RequestInit; body: Record<string, unknown> };
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
) {
  const captures: Capture[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const body = JSON.parse(
      String(init?.body ?? (input instanceof Request ? await input.clone().text() : '{}')),
    ) as Record<string, unknown>;
    const capture = { url, init: init ?? {}, body };
    captures.push(capture);
    if (url.pathname.endsWith(':countTokens')) return Response.json({ totalTokens: 200 });
    return respond(
      capture,
      captures.filter((item) => item.url.pathname.endsWith('/interactions')).length,
    );
  };
  const provider = createGeminiProvider({ apiKey: marker, model, fetch: transport });
  const input: ProviderInput = {
    request: request(),
    evidence: createEvidenceBuilder().packet(['53262']),
    retrieval: [],
    remainingRetrievalRounds: 1,
  };
  const budget = createProviderBudget();
  const controller = new AbortController();
  const run = () =>
    provider.complete(input, { budget, signal: controller.signal, deadline: Date.now() + 45_000 });
  return { captures, provider, input, budget, controller, run };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof GatewayError && error.detail.code === expected;

test('official SDK emits one preflight plus one stateless bounded Interactions request to fixed origin', async () => {
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
  assert.equal((body.response_format as Record<string, unknown>).mime_type, 'application/json');
  const contents = f.captures[0]!.body.contents as { parts: { text: string }[] }[];
  assert.equal(contents[0]!.parts.length, 3);
  assert.ok(contents[0]!.parts[0]!.text.startsWith('You are CookMate'));
  assert.deepEqual(
    JSON.parse(contents[0]!.parts[2]!.text),
    (body.response_format as { schema: unknown }).schema,
  );
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
    wire({}, { usage: { total_input_tokens: 100, total_output_tokens: 2001 } }),
  ]) {
    const f = fixture(() => Response.json(bad));
    await assert.rejects(f.run(), code('invalid_model_result'));
    assert.equal(f.captures.length, 2);
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
