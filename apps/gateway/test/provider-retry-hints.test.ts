import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGeminiProvider } from '../src/gemini';
import { createProviderBudget } from '../src/orchestrator';
import { createEvidenceBuilder } from '../src/evidence';
import { GatewayError, gatewayError } from '../src/errors';
import type { ProviderInput } from '../src/provider-contract';
import { request } from './helpers';

const model = 'gemini-3.5-flash-lite' as const;
const privateMarker = 'FICTIONAL_PRIVATE_PROVIDER_DETAIL';
const now = Date.parse('2026-09-30T10:00:00.500Z');
const input: ProviderInput = {
  request: request(),
  evidence: createEvidenceBuilder().packet(['53262']),
  retrieval: [],
  remainingRetrievalRounds: 1,
};

function fixture(options: {
  status: number;
  hint?: string;
  stage?: 'preflight' | 'generation';
  body?: string | null;
}) {
  let calls = 0;
  const controller = new AbortController();
  const budget = createProviderBudget();
  const provider = createGeminiProvider({
    apiKey: 'FICTIONAL_TEST_KEY',
    model,
    now: () => now,
    fetch: async () => {
      calls++;
      if (options.stage === 'generation' && calls === 1) return Response.json({ totalTokens: 200 });
      const headers = new Headers({
        'content-type': 'application/json',
        'x-private-header': privateMarker,
      });
      if (options.hint !== undefined) headers.set('retry-after', options.hint);
      return new Response(
        options.body === undefined
          ? JSON.stringify({ error: { code: options.status, message: privateMarker } })
          : options.body,
        { status: options.status, headers },
      );
    },
  });
  return {
    budget,
    controller,
    calls: () => calls,
    run: () =>
      provider.complete(input, {
        budget,
        signal: controller.signal,
        deadline: now + 45_000,
      }),
  };
}

for (const status of [429, 503]) {
  for (const [hint, expected] of [
    ['7', 7],
    ['0', 0],
    ['00012', 12],
    ['86400', 86400],
    ['86401', 86400],
    ['9'.repeat(64), 86400],
    ['Wed, 30 Sep 2026 10:00:08 GMT', 8],
    ['Wed, 30 Sep 2026 09:59:00 GMT', 0],
    ['Fri, 02 Oct 2026 10:00:00 GMT', 86400],
    [undefined, undefined],
    ['', undefined],
    ['-1', undefined],
    ['1.5', undefined],
    ['1e3', undefined],
    ['Infinity', undefined],
    ['7, 8', undefined],
    ['9'.repeat(65), undefined],
    ['2026-09-30T10:00:08Z', undefined],
    ['Thu, 30 Sep 2026 10:00:08 GMT', undefined],
    ['Mon, 30 Feb 2026 10:00:08 GMT', undefined],
    [privateMarker, undefined],
  ] as const) {
    test(`preflight HTTP ${status} normalizes Retry-After ${JSON.stringify(hint)}`, async () => {
      const f = fixture({ status, ...(hint === undefined ? {} : { hint }) });
      await assert.rejects(f.run(), (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.equal(error.status, status);
        assert.deepEqual(error.detail, {
          code: status === 429 ? 'quota' : 'provider_unavailable',
          messageKey: status === 429 ? 'gateway.quota' : 'gateway.provider_unavailable',
          retry: 'after_delay',
          ...(expected === undefined ? {} : { retryAfterSeconds: expected }),
        });
        assert.equal(JSON.stringify(error).includes(privateMarker), false);
        assert.equal(JSON.stringify(error).includes('x-private-header'), false);
        return true;
      });
      assert.equal(f.calls(), 1);
      assert.equal(f.budget.generations, 0);
      assert.equal(f.budget.retries, 0);
    });
  }

  test(`generation HTTP ${status} returns its cooldown without retrying early`, async () => {
    const f = fixture({ status, hint: '20', stage: 'generation' });
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.detail.retryAfterSeconds, 20);
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(f.calls(), 2);
    assert.equal(f.budget.preflights, 1);
    assert.equal(f.budget.generations, 1);
    assert.equal(f.budget.retries, 0);
  });
}

test('missing and malformed bounded error bodies retain only the safe HTTP cooldown', async () => {
  for (const body of [null, `<html>${privateMarker}`]) {
    const f = fixture({ status: 429, hint: '4', stage: 'generation', body });
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.detail.code, 'quota');
      assert.equal(error.detail.retryAfterSeconds, 4);
      assert.equal(JSON.stringify(error).includes(privateMarker), false);
      return true;
    });
    assert.equal(f.calls(), 2);
  }
});

test('refusal, response-size and cancellation boundaries outrank a cooldown header', async () => {
  const refusal = fixture({
    status: 503,
    hint: '10',
    stage: 'generation',
    body: JSON.stringify({ error: { code: 'content_blocked', message: privateMarker } }),
  });
  await assert.rejects(refusal.run(), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.deepEqual(error.detail, {
      code: 'provider_refused',
      messageKey: 'gateway.provider_refused',
      retry: 'after_correction',
    });
    return true;
  });
  assert.equal(refusal.calls(), 2);
  assert.equal(refusal.budget.retries, 0);

  const oversized = fixture({ status: 429, hint: '10', body: 'x'.repeat(128 * 1024 + 1) });
  await assert.rejects(oversized.run(), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.detail.code, 'invalid_model_result');
    assert.equal(error.detail.retryAfterSeconds, undefined);
    return true;
  });

  const cancelled = fixture({ status: 429, hint: '10' });
  const reason = gatewayError('cancelled', 499, 'never');
  cancelled.controller.abort(reason);
  await assert.rejects(cancelled.run(), (error: unknown) => error === reason);
  assert.equal(cancelled.calls(), 0);
});

test('headers on authentication failures do not add a misleading retry cooldown', async () => {
  for (const status of [401, 403]) {
    const f = fixture({ status, hint: '10' });
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.detail.code, 'provider_unavailable');
      assert.equal(error.detail.retry, 'after_correction');
      assert.equal(error.detail.retryAfterSeconds, undefined);
      return true;
    });
    assert.equal(f.calls(), 1);
  }
});

test('concurrent turns keep retry hints attached to their own physical response', async () => {
  const calls: string[] = [];
  const provider = createGeminiProvider({
    apiKey: 'FICTIONAL_TEST_KEY',
    model,
    now: () => now,
    fetch: async (requestInput, init) => {
      const url = new URL(
        typeof requestInput === 'string' || requestInput instanceof URL
          ? requestInput
          : requestInput.url,
      );
      if (url.pathname.endsWith(':countTokens')) return Response.json({ totalTokens: 200 });
      const body = JSON.parse(
        String(
          init?.body ??
            (requestInput instanceof Request ? await requestInput.clone().text() : '{}'),
        ),
      ) as { input: string };
      const turn = JSON.parse(body.input) as ProviderInput;
      calls.push(turn.request.message.text);
      return Response.json(
        { error: { code: 'too_many_requests', message: privateMarker } },
        { status: 429, headers: { 'retry-after': turn.request.message.text } },
      );
    },
  });
  const results = await Promise.allSettled(
    ['11', '22'].map((text) => {
      const turn = structuredClone(input);
      turn.request.message.text = text;
      return provider.complete(turn, {
        budget: createProviderBudget(),
        signal: new AbortController().signal,
        deadline: now + 45_000,
      });
    }),
  );
  assert.deepEqual([...calls].sort(), ['11', '22']);
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 'rejected');
    if (result.status !== 'rejected') assert.fail('Expected provider quota');
    assert.ok(result.reason instanceof GatewayError);
    assert.equal(result.reason.detail.retryAfterSeconds, index === 0 ? 11 : 22);
  }
});
