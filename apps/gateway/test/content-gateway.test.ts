import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import {
  createContentReader,
  verifySignedContentOverlay,
  type EffectiveContentSnapshot,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import { overlayFixture, signed } from '../../../packages/catalogue/test/content-overlay-fixtures';
import { createVerifiedContentGateway, type VerifiedGatewayContent } from '../src/contentGateway';
import { GatewayError } from '../src/errors';
import type { ModelProvider, ProviderInput } from '../src/provider-contract';
import { deferred, memoryRegistry, nonMemoryUpdate, request } from './helpers';

// Core-verified overlay with controlled trust/media/reservation/provider ports. These tests
// demonstrate gateway coordination only, not real cryptography, media delivery or hosted AI.
async function contentFixture() {
  const f = await overlayFixture();
  const snapshot = await verifySignedContentOverlay(f.envelope, f.options);
  const selectedHead: OverlayHead = {
    releaseId: f.envelope.manifest.releaseId,
    sequence: f.envelope.manifest.sequence,
    fingerprint: f.envelope.fingerprint,
  };
  const controls: {
    snapshot: EffectiveContentSnapshot | null;
    head: OverlayHead | null;
    closed: boolean;
    failure: Error | null;
  } = { snapshot, head: selectedHead, closed: false, failure: null };
  let held = 0,
    reservations = 0,
    released = 0;
  const content: VerifiedGatewayContent = {
    head: selectedHead,
    async withVerifiedReading(head, refs, work) {
      reservations++;
      assert.deepEqual(head, selectedHead);
      assert.deepEqual(refs, []);
      if (controls.failure) throw controls.failure;
      let active = true;
      held++;
      const assertActive = (): undefined => {
        if (!active || controls.closed) throw new Error('Controlled content reservation closed');
        return undefined;
      };
      try {
        assertActive();
        const result = await work({
          head: controls.head,
          snapshot: controls.snapshot,
          assertActive,
        });
        assertActive();
        return result;
      } finally {
        active = false;
        held--;
        released++;
      }
    },
  };
  return { f, snapshot, content, controls, counts: () => ({ held, reservations, released }) };
}

function completion(input: ProviderInput): Awaited<ReturnType<ModelProvider['complete']>> {
  return {
    value: {
      kind: 'respond',
      sufficiency: 'sufficient',
      missingFacts: [],
      memoryUpdate: nonMemoryUpdate(input.request),
      response: {
        kind: 'answer',
        text: 'The fixture recipe includes salt.',
        recipeIds: ['90001'],
        sources: [{ recipeId: '90001', section: 'ingredient', position: 1 }],
      },
    },
    usage: { inputTokens: 1, outputTokens: 1, thoughtTokens: 0 },
  };
}

async function setup(t: TestContext, provider?: ModelProvider, deadlineMs?: number) {
  const fixture = await contentFixture(),
    memory = await memoryRegistry();
  const calls: ProviderInput[] = [];
  const gateway = await createVerifiedContentGateway({
    registry: memory.registry,
    content: fixture.content,
    provider: {
      async complete(input, execution) {
        calls.push(input);
        return provider ? provider.complete(input, execution) : completion(input);
      },
    },
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  t.after(() => gateway.app.close());
  const client = await memory.registry.issue();
  const input = request();
  input.catalogue = { ...createContentReader(fixture.snapshot).identity };
  input.context.selectedRecipeId = '90001';
  input.message.text = 'Tell me about Fixture soup.';
  const send = (payload = input) =>
    gateway.app.inject({
      method: 'POST',
      url: '/v2/assistant/turn',
      headers: { authorization: `Bearer ${client.token}` },
      payload,
    });
  return { ...fixture, ...gateway, ...memory, input, client, calls, send };
}

const unavailable = (error: unknown) =>
  error instanceof GatewayError &&
  error.status === 409 &&
  error.detail.messageKey === 'gateway.content_release_unavailable';

for (const mode of [
  'invalid_head',
  'missing_snapshot',
  'wrong_view_head',
  'wrong_snapshot_head',
  'expired_reservation',
  'verification_failed',
] as const)
  test(`initialization fails closed without packaged fallback: ${mode}`, async () => {
    const f = await contentFixture(),
      memory = await memoryRegistry();
    let modelCalls = 0;
    if (mode === 'invalid_head') f.content.head = { ...f.content.head, sequence: 0 };
    if (mode === 'missing_snapshot') f.controls.snapshot = null;
    if (mode === 'wrong_view_head')
      f.controls.head = { ...f.content.head, fingerprint: 'f'.repeat(64) };
    if (mode === 'wrong_snapshot_head') {
      const manifest = { ...f.f.manifest, releaseId: 'alternate-controlled-release' };
      f.controls.snapshot = await verifySignedContentOverlay(await signed(manifest), f.f.options);
    }
    if (mode === 'expired_reservation') f.controls.closed = true;
    if (mode === 'verification_failed')
      f.controls.failure = new Error('Controlled signature rejection');
    await assert.rejects(
      createVerifiedContentGateway({
        registry: memory.registry,
        content: f.content,
        provider: {
          async complete(input) {
            modelCalls++;
            return completion(input);
          },
        },
      }),
      ['expired_reservation', 'verification_failed'].includes(mode) ? /Controlled/ : unavailable,
    );
    assert.equal(modelCalls, 0);
    assert.equal(f.counts().held, 0);
    assert.equal(f.counts().reservations, mode === 'invalid_head' ? 0 : 1);
  });

test('each accepted turn revalidates the chosen identity and supplies only that exact evidence', async (t) => {
  const f = await setup(t);
  assert.deepEqual(f.counts(), { held: 0, reservations: 1, released: 1 });
  const first = await f.send();
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().catalogue, f.input.catalogue);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.evidence[0]!.contentRef, f.f.publication.revision.ref);
  assert.equal(f.calls[0]!.evidence[0]!.ingredients[0]!.locator, null);
  assert.equal(f.calls[0]!.evidence[0]!.ingredients[0]!.rawMeasure, null);
  const second = await f.send({ ...f.input, requestId: '00000000-0000-4000-8000-000000000099' });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.counts(), { held: 0, reservations: 3, released: 3 });
});

for (const mode of ['verification_failed', 'missing_snapshot', 'changed_head', 'closed'] as const)
  test(`per-turn ${mode} rejects before model dispatch and never falls back`, async (t) => {
    const f = await setup(t);
    if (mode === 'verification_failed')
      f.controls.failure = new Error('PRIVATE fixture verification diagnostic');
    if (mode === 'missing_snapshot') f.controls.snapshot = null;
    if (mode === 'changed_head') f.controls.head = { ...f.content.head, sequence: 2 };
    if (mode === 'closed') f.controls.closed = true;
    const response = await f.send();
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error.messageKey, 'gateway.content_release_unavailable');
    assert.equal(response.body.includes('PRIVATE'), false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.counts().held, 0);
    assert.equal(f.admission.size, 0);
  });

test('a client with a different catalogue identity is denied before any content or model work', async (t) => {
  const f = await setup(t),
    other = request();
  other.context.selectedRecipeId = '90001';
  const before = f.counts();
  const response = await f.send(other);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, 'incompatible_version');
  assert.deepEqual(f.counts(), before);
  assert.equal(f.calls.length, 0);
});

test('a different core-verified snapshot cannot silently replace a gateway instance identity', async (t) => {
  const f = await setup(t);
  const manifest = { ...f.f.manifest, releaseId: 'other-controlled-identity' };
  f.controls.snapshot = await verifySignedContentOverlay(await signed(manifest), f.f.options);
  const response = await f.send();
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(f.calls.length, 0);
  assert.equal(f.counts().held, 0);
});

for (const mode of ['deadline', 'cancel', 'revoke'] as const)
  test(`${mode} releases the content reservation even when the model ignores AbortSignal`, async (t) => {
    const entered = deferred<void>(),
      model = deferred<Awaited<ReturnType<ModelProvider['complete']>>>();
    let modelInput!: ProviderInput, signal!: AbortSignal;
    const f = await setup(
      t,
      {
        async complete(input, execution) {
          modelInput = input;
          signal = execution.signal;
          entered.resolve();
          return model.promise;
        },
      },
      mode === 'deadline' ? 30 : 1000,
    );
    let cancel: () => void = () => {
      throw new Error('Request did not reach onRequest');
    };
    f.app.addHook('onRequest', async (incoming) => {
      cancel = () => {
        incoming.raw.emit('aborted');
      };
    });
    // Injection has no socket keeping the process alive for the admission timer, which is unref'd.
    const keeper = setTimeout(() => {}, 3000);
    try {
      const pending = f.send();
      await entered.promise;
      assert.equal(f.counts().held, 1);
      if (mode === 'cancel') cancel();
      if (mode === 'revoke') await f.registry.revoke(f.client.clientId);
      const response = await pending;
      assert.equal(
        response.statusCode,
        mode === 'deadline' ? 504 : mode === 'cancel' ? 499 : 401,
        response.body,
      );
      assert.equal(
        response.json().error.code,
        mode === 'deadline' ? 'deadline' : mode === 'cancel' ? 'cancelled' : 'pairing_revoked',
      );
      assert.equal(signal.aborted, true);
      assert.equal(
        f.counts().held,
        0,
        'Logical cancellation must release before uncooperative model settles',
      );
      assert.equal(f.admission.size, 0);
      const settledBody = response.body;
      model.resolve(completion(modelInput));
      await nextTurn();
      assert.equal(response.body, settledBody);
      assert.equal(f.calls.length, 1);
      assert.equal(f.counts().held, 0);
    } finally {
      clearTimeout(keeper);
      if (modelInput) model.resolve(completion(modelInput));
    }
  });

test('content closure during a model call suppresses its otherwise valid late answer', async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const f = await setup(t, {
    async complete(input) {
      entered.resolve();
      await release.promise;
      return completion(input);
    },
  });
  const pending = f.send();
  await entered.promise;
  f.controls.closed = true;
  release.resolve();
  const response = await pending;
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.messageKey, 'gateway.content_release_unavailable');
  assert.equal(response.body.includes('fixture recipe includes salt'), false);
  assert.equal(f.counts().held, 0);
  assert.equal(f.admission.size, 0);
});

test(
  'real loopback shutdown releases its reservation before an abort-ignoring model settles',
  { timeout: 5000 },
  async (t) => {
    const entered = deferred<void>(),
      release = deferred<void>();
    let modelSettled = false,
      signal!: AbortSignal;
    const f = await setup(t, {
      async complete(input, execution) {
        signal = execution.signal;
        entered.resolve();
        await release.promise;
        modelSettled = true;
        return completion(input);
      },
    });
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const pending = fetch(`${address}/v2/assistant/turn`, {
        method: 'POST',
        headers: { authorization: `Bearer ${f.client.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(f.input),
      });
      await entered.promise;
      assert.equal(f.counts().held, 1);
      const closing = f.app.close();
      const response = await pending;
      const body = (await response.json()) as { error: { code: string } };
      await closing;
      assert.equal(response.status, 503);
      assert.equal(body.error.code, 'provider_unavailable');
      assert.equal(modelSettled, false, 'Close must finish without waiting for the model gate');
      assert.equal(signal.aborted, true);
      assert.equal(f.counts().held, 0);
      assert.equal(f.admission.size, 0);
    } finally {
      release.resolve();
      await nextTurn();
    }
  },
);
