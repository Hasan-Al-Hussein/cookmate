import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createCredentialRegistry } from '../src/registry';
import { createPairingService } from '../src/pairing';
import { createGateway } from '../src/server';
import type { TurnHandler } from '../src/server';
import { GatewayError } from '../src/errors';
import { answer, deferred, memoryRegistry, request } from './helpers';

const code = (expected: string) => (error: unknown) =>
  error instanceof GatewayError && error.detail.code === expected;
async function setup(turn: TurnHandler = async (input) => answer(input), deadlineMs?: number) {
  const memory = await memoryRegistry();
  const gateway = createGateway({
    catalogue: catalogue.boundary,
    registry: memory.registry,
    turn,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  const client = await memory.registry.issue();
  const send = (payload: unknown = request(), token = client.token) =>
    gateway.app.inject({
      method: 'POST',
      url: '/v2/assistant/turn',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  return { ...gateway, ...memory, client, send };
}

test('credentials survive reload as hashes; revocation and expiry remain distinct', async () => {
  let now = Date.parse('2026-09-28T00:00:00.000Z');
  const memory = await memoryRegistry(() => now);
  const client = await memory.registry.issue();
  assert.equal(JSON.stringify(memory.saved()).includes(client.token), false);
  const restored = await createCredentialRegistry(memory.storage, () => now);
  assert.equal(restored.authenticate(client.token).clientId, client.clientId);
  await restored.revoke(client.clientId);
  assert.throws(() => restored.authenticate(client.token), code('pairing_revoked'));
  const next = await restored.issue();
  now = Date.parse(next.expiresAt);
  assert.throws(() => restored.authenticate(next.token), code('pairing_expired'));
});

test('corrupt registry and durable write failure fail closed, including existing tokens', async () => {
  await assert.rejects(
    createCredentialRegistry({
      async read() {
        return { version: 1, credentials: [{ token: 'raw' }] };
      },
      async write() {},
    }),
    code('storage_failure'),
  );
  const memory = await memoryRegistry();
  const client = await memory.registry.issue();
  let revoked = '';
  memory.registry.onRevoked((id) => {
    revoked = id;
  });
  memory.failWrites();
  await assert.rejects(memory.registry.revoke(client.clientId), code('storage_failure'));
  assert.equal(revoked, client.clientId);
  assert.throws(() => memory.registry.authenticate(client.token), code('storage_failure'));
});

test('pairing is operator-opened, expiring, attempt-limited and one use under concurrency', async () => {
  let now = 1_000;
  const { registry } = await memoryRegistry(() => now);
  const pairing = createPairingService(registry, catalogue.identity, () => now);
  await assert.rejects(pairing.pair('A'.repeat(12)), code('pairing_expired'));
  const window = pairing.openWindow();
  const paired = await Promise.allSettled([pairing.pair(window.code), pairing.pair(window.code)]);
  assert.equal(paired.filter((item) => item.status === 'fulfilled').length, 1);
  const guessed = pairing.openWindow();
  const wrong = guessed.code === 'A'.repeat(12) ? 'B'.repeat(12) : 'A'.repeat(12);
  for (let i = 0; i < 5; i++) await assert.rejects(pairing.pair(wrong), code('unauthenticated'));
  await assert.rejects(pairing.pair(guessed.code), code('pairing_expired'));
  const expired = pairing.openWindow();
  now = Date.parse(expired.expiresAt);
  await assert.rejects(pairing.pair(expired.code), code('pairing_expired'));
});

test('Fastify rejects authentication, coercion, version, catalogue, JSON and size errors before provider', async (t) => {
  let calls = 0;
  const gateway = await setup(async (input) => {
    calls++;
    return answer(input);
  });
  t.after(() => gateway.app.close());
  const unauth = await gateway.app.inject({
    method: 'POST',
    url: '/v2/assistant/turn',
    payload: request(),
  });
  assert.equal(unauth.statusCode, 401);
  for (const payload of [
    { ...request(), extra: true },
    { ...request(), intentRevision: '0' },
  ]) {
    const result = await gateway.send(payload);
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().error.code, 'invalid_input');
  }
  assert.equal((await gateway.send({ ...request(), apiVersion: '1' })).statusCode, 409);
  const drift = await gateway.send({
    ...request(),
    catalogue: { ...catalogue.identity, fingerprint: 'a'.repeat(64) },
  });
  assert.equal(drift.json().error.code, 'incompatible_version');
  const broken = await gateway.app.inject({
    method: 'POST',
    url: '/v2/assistant/turn',
    headers: {
      authorization: `Bearer ${gateway.client.token}`,
      'content-type': 'application/json',
    },
    payload: '{bad secret',
  });
  assert.equal(broken.statusCode, 400);
  assert.equal(broken.body.includes('secret'), false);
  const large = await gateway.send({ ...request(), extra: 'a'.repeat(128 * 1024) });
  assert.equal(large.statusCode, 413);
  assert.equal(calls, 0);
  assert.equal((await gateway.send()).statusCode, 200);
  assert.equal(calls, 1);
});

test('health reveals only readiness and API version; pairing routes never expose credentials elsewhere', async (t) => {
  const gateway = await setup();
  t.after(() => gateway.app.close());
  const health = await gateway.app.inject('/health');
  assert.deepEqual(health.json(), { status: 'ready', apiVersion: '2' });
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal((await gateway.app.inject('/health?token=private')).statusCode, 400);
  const window = gateway.pairing.openWindow();
  const pair = await gateway.app.inject({
    method: 'POST',
    url: '/v2/pair',
    payload: { apiVersion: '2', code: window.code },
  });
  assert.equal(pair.statusCode, 200);
  assert.match(pair.json().token, /^[A-Za-z0-9_-]{43}$/);
  const revoke = await gateway.app.inject({
    method: 'DELETE',
    url: '/v2/pairing',
    headers: { authorization: `Bearer ${pair.json().token}` },
  });
  assert.equal(revoke.statusCode, 204);
  assert.equal(
    (await gateway.send(request(), pair.json().token)).json().error.code,
    'pairing_revoked',
  );
});

test('one turn per client and two global; no cross-client context or request identity reuse', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const seen: string[] = [];
  const gateway = await setup(async (input) => {
    seen.push(input.message.text);
    entered.resolve();
    await release.promise;
    return answer(input);
  });
  t.after(() => gateway.app.close());
  const first = gateway.send();
  await entered.promise;
  assert.equal((await gateway.send()).json().error.code, 'already_pending');
  const changed = request();
  changed.message.text = 'another payload';
  assert.equal((await gateway.send(changed)).json().error.code, 'operation_conflict');
  const secondClient = await gateway.registry.issue();
  const thirdClient = await gateway.registry.issue();
  const secondInput = request();
  secondInput.message.text = 'Only client two sees this.';
  const second = gateway.send(secondInput, secondClient.token);
  while (seen.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await gateway.send(request(), thirdClient.token)).json().error.code, 'busy');
  release.resolve();
  assert.equal((await first).statusCode, 200);
  assert.equal((await second).statusCode, 200);
  assert.deepEqual(seen, [request().message.text, secondInput.message.text]);
  assert.equal(gateway.admission.size, 0);
});

test('revocation aborts in-flight work; deadline frees admission even for an uncooperative provider', async (t) => {
  const entered = deferred<void>();
  const revoked = await setup(async () => {
    entered.resolve();
    return new Promise(() => {});
  });
  t.after(() => revoked.app.close());
  const pending = revoked.send();
  await entered.promise;
  await revoked.registry.revoke(revoked.client.clientId);
  assert.equal((await pending).json().error.code, 'pairing_revoked');
  assert.equal(revoked.admission.size, 0);
  const timed = await setup(async () => new Promise(() => {}), 20);
  t.after(() => timed.app.close());
  // Fastify inject has no listening socket keeping the process alive for unref'd deadline.
  const keeper = setTimeout(() => {}, 1_000);
  try {
    assert.equal((await timed.send()).json().error.code, 'deadline');
  } finally {
    clearTimeout(keeper);
  }
  assert.equal(timed.admission.size, 0);
});

test('raw provider exceptions and stale response identity never cross HTTP boundary', async (t) => {
  const failed = await setup(async () => {
    throw new Error('PRIVATE_KEY transcript provider body');
  });
  t.after(() => failed.app.close());
  const result = await failed.send();
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.includes('PRIVATE_KEY'), false);
  const stale = await setup(async (input) => ({ ...answer(input), connectionGeneration: 99 }));
  t.after(() => stale.app.close());
  assert.equal((await stale.send()).json().error.code, 'invalid_model_result');
});

test('revocation after early authentication but before parsed-body dispatch makes zero provider calls', async (t) => {
  let calls = 0;
  const entered = deferred<void>();
  const release = deferred<void>();
  const gateway = await setup(async (input) => {
    calls++;
    return answer(input);
  });
  t.after(() => gateway.app.close());
  gateway.app.addHook('preValidation', async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = gateway.send();
  await entered.promise;
  await gateway.registry.revoke(gateway.client.clientId);
  release.resolve();
  assert.equal((await pending).json().error.code, 'pairing_revoked');
  assert.equal(calls, 0);
  assert.equal(gateway.admission.size, 0);
});
