import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createAccountHandler } from '../src/handler';
import { createDeletionStatusHandler } from '../src/deletionStatusHandler';
import { createSupabaseBackend, type AccountBackend } from '../src/backend';
import { AccountServiceError } from '../src/protocol';

const owner = '10000000-0000-4000-8000-000000000001';
const session = '20000000-0000-4000-8000-000000000001';
const operation = '30000000-0000-4000-8000-000000000001';
const token = '12'.repeat(32);
const digest = createHash('sha256')
  .update(`cookmate-account-deletion-v1:${operation}:${token}`)
  .digest('hex');
const deletedAt = '2026-09-30T16:00:00.000Z';
const expiresAt = '2026-10-30T16:00:00.000Z';
const deletion = {
  action: 'delete',
  operationId: operation,
  expectedRevision: 7,
  confirmation: 'DELETE_COOKMATE_ACCOUNT',
  recoveryToken: token,
};
const statusInput = { operationId: operation, recoveryToken: token };
const completed = () => ({
  operationId: operation,
  state: 'deleted',
  deletedAt,
  expiresAt,
  capabilityDigests: [digest],
});
const request = (value: unknown, headers: Record<string, string> = {}) =>
  new Request('https://account.test/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  });
const allowedOrigins = ['https://cookmate.test'];

test('lost Auth response and failed immediate lookup recover by capability after the JWT is rejected', async () => {
  let removed = false;
  let unavailable = true;
  let deletes = 0;
  let verifications = 0;
  const backend: AccountBackend = {
    async verify() {
      verifications++;
      if (removed) throw new AccountServiceError(401, 'sign_in_required');
      return { ownerId: owner, sessionId: session };
    },
    async rpc(name, input) {
      if (name === 'cookmate_account_begin_delete') {
        assert.deepEqual(input, {
          p_owner: owner,
          p_session: session,
          p_operation: operation,
          p_expected_revision: 7,
          p_capability_digest: digest,
        });
        assert.ok(!JSON.stringify(input).includes(token));
        return { ownerId: owner, operationId: operation, deletionPending: true };
      }
      assert.equal(name, 'cookmate_account_deletion_receipt');
      assert.deepEqual(input, { p_operation: operation });
      if (unavailable) throw new AccountServiceError(503, 'account_service_unavailable');
      return removed ? completed() : null;
    },
    async deleteUser(id) {
      assert.equal(id, owner);
      deletes++;
      removed = true;
      throw new Error('lost Auth response');
    },
  };
  const main = createAccountHandler({ backend, allowedOrigins });
  const status = createDeletionStatusHandler({ backend, allowedOrigins });
  const first = await main(request(deletion, { authorization: 'Bearer fixture-token' }));
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: 'deletion_not_confirmed' });
  unavailable = false;
  const oldToken = await main(request(deletion, { authorization: 'Bearer fixture-token' }));
  assert.equal(oldToken.status, 401);
  for (let index = 0; index < 2; index++) {
    const recovered = await status(request(statusInput));
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await recovered.json(), {
      operationId: operation,
      status: 'deleted',
      deletedAt,
      expiresAt,
    });
  }
  assert.equal(deletes, 1);
  assert.equal(verifications, 2, 'status must not require or invoke Auth verification');
});

test('completed SQL receipt confirms a lost Auth response without another destructive attempt', async () => {
  const backend: AccountBackend = {
    verify: async () => ({ ownerId: owner, sessionId: session }),
    rpc: async (name) =>
      name === 'cookmate_account_begin_delete'
        ? { ownerId: owner, operationId: operation, deletionPending: true }
        : completed(),
    deleteUser: async () => {
      throw new Error('Auth response lost');
    },
  };
  const response = await createAccountHandler({ backend, allowedOrigins })(
    request(deletion, { authorization: 'Bearer token' }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ownerId: owner,
    operationId: operation,
    deleted: true,
  });
});

test('missing, expired and wrong capabilities are indistinguishable and pending has no identity data', async () => {
  for (const value of [null, { ...completed(), capabilityDigests: ['f'.repeat(64)] }]) {
    const handler = createDeletionStatusHandler({
      backend: { rpc: async () => value },
      allowedOrigins,
    });
    const response = await handler(request(statusInput));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'deletion_receipt_unavailable' });
  }
  const pending = createDeletionStatusHandler({
    backend: {
      rpc: async () => ({ ...completed(), state: 'pending', deletedAt: null, expiresAt: null }),
    },
    allowedOrigins,
  });
  const response = await pending(request(statusInput));
  assert.deepEqual(await response.json(), { operationId: operation, status: 'pending' });
});

test('mixed-case deletion IDs use canonical SQL identity and preserve caller correlation', async () => {
  const operationId = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
  const canonical = operationId.toLowerCase();
  const capabilityDigest = createHash('sha256')
    .update(`cookmate-account-deletion-v1:${canonical}:${token}`)
    .digest('hex');
  let deletes = 0;
  const backend: AccountBackend = {
    verify: async () => ({ ownerId: owner, sessionId: session }),
    rpc: async (name, input) => {
      if (name === 'cookmate_account_begin_delete') {
        assert.equal(input.p_operation, canonical);
        assert.equal(input.p_capability_digest, capabilityDigest);
        return { ownerId: owner, operationId: canonical, deletionPending: true };
      }
      assert.equal(name, 'cookmate_account_deletion_receipt');
      assert.equal(String(input.p_operation).toLowerCase(), canonical);
      return { ...completed(), operationId: canonical, capabilityDigests: [capabilityDigest] };
    },
    deleteUser: async () => {
      deletes++;
    },
  };
  const response = await createAccountHandler({ backend, allowedOrigins })(
    request({ ...deletion, operationId }, { authorization: 'Bearer token' }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ownerId: owner, operationId, deleted: true });
  const recovered = await createDeletionStatusHandler({ backend, allowedOrigins })(
    request({ operationId, recoveryToken: token }),
  );
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), {
    operationId,
    status: 'deleted',
    deletedAt,
    expiresAt,
  });
  assert.equal(deletes, 1);
});

test('status requests are exact, small, POST-only and origin bounded before the privileged lookup', async () => {
  let calls = 0;
  const handler = createDeletionStatusHandler({
    backend: {
      rpc: async () => {
        calls++;
        return completed();
      },
    },
    allowedOrigins,
  });
  for (const input of [
    { ...statusInput, ownerId: owner },
    { ...statusInput, action: 'delete' },
    { ...statusInput, recoveryToken: 'F'.repeat(64) },
    { ...statusInput, recoveryToken: 'x'.repeat(64) },
    { ...statusInput, recoveryToken: 'a'.repeat(63) },
    { ...statusInput, recoveryToken: token + '\n' },
    { ...statusInput, operationId: 'other-owner' },
    { ...statusInput, operationId: operation + '\n' },
  ])
    assert.equal((await handler(request(input))).status, 400);
  assert.equal((await handler(request({ ...statusInput, padding: 'x'.repeat(2048) }))).status, 413);
  assert.equal(
    (await handler(request(statusInput, { origin: 'https://attacker.test' }))).status,
    403,
  );
  assert.equal((await handler(new Request('https://account.test/status'))).status, 405);
  assert.equal((await handler(request(statusInput, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal(calls, 0);
});

test('every capability slot can recover its exact receipt without exposing hashes', async () => {
  for (let index = 0; index < 8; index++) {
    const capabilityDigests = Array.from({ length: 8 }, (_, slot) =>
      slot === index ? digest : 'f'.repeat(64),
    );
    const handler = createDeletionStatusHandler({
      backend: { rpc: async () => ({ ...completed(), capabilityDigests }) },
      allowedOrigins,
    });
    const response = await handler(request(statusInput));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      operationId: operation,
      status: 'deleted',
      deletedAt,
      expiresAt,
    });
  }
});

test('malformed internal receipts never become deletion confirmation', async () => {
  for (const value of [
    { ...completed(), ownerId: owner },
    { ...completed(), capabilityDigests: [] },
    { ...completed(), capabilityDigests: Array(9).fill(digest) },
    { ...completed(), capabilityDigests: [token.slice(1)] },
    { ...completed(), capabilityDigests: [digest + '\n'] },
    { ...completed(), operationId: session },
    { ...completed(), expiresAt: deletedAt },
    { ...completed(), state: 'pending' },
  ]) {
    const response = await createDeletionStatusHandler({
      backend: { rpc: async () => value },
      allowedOrigins,
    })(request(statusInput));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'invalid_server_result' });
  }
});

test('deletion admission failure or invalid capability never calls Auth deletion', async () => {
  let deletes = 0;
  let admissions = 0;
  const backend: AccountBackend = {
    verify: async () => ({ ownerId: owner, sessionId: session }),
    rpc: async () => {
      admissions++;
      throw new AccountServiceError(409, 'deletion_capability_limit');
    },
    deleteUser: async () => {
      deletes++;
    },
  };
  const handler = createAccountHandler({ backend, allowedOrigins });
  const quota = await handler(request(deletion, { authorization: 'Bearer token' }));
  assert.equal(quota.status, 409);
  assert.equal(quota.headers.get('retry-after'), null);
  assert.deepEqual(await quota.json(), { error: 'deletion_capability_limit' });
  for (const input of [
    { ...deletion, recoveryToken: 'invalid' },
    { ...deletion, recoveryToken: token + '\n' },
    { ...deletion, operationId: operation + '\n' },
  ])
    assert.equal((await handler(request(input, { authorization: 'Bearer token' }))).status, 400);
  assert.equal(admissions, 1, 'malformed requests must fail before destructive admission');
  assert.equal(deletes, 0);
});

test('server revision and legacy-operation conflicts stay distinct and never dispatch Auth deletion', async () => {
  const accessToken = `fixture.${Buffer.from(JSON.stringify({ sub: owner, session_id: session })).toString('base64url')}.signature`;
  for (const [code, error] of [
    ['CM412', 'needs_review'],
    ['CM409', 'operation_changed'],
  ]) {
    const calls: Array<{ path: string; method: string }> = [];
    const backend = createSupabaseBackend({
      url: 'https://project.test',
      publishableKey: 'public',
      serviceKey: 'server-only',
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, method: init?.method ?? 'GET' });
        if (path === '/auth/v1/user') return Response.json({ id: owner });
        if (path === '/rest/v1/rpc/cookmate_account_begin_delete') {
          const admission = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.equal(admission.p_operation, operation);
          assert.equal(admission.p_expected_revision, deletion.expectedRevision);
          assert.equal(admission.p_capability_digest, digest);
          return Response.json({ code }, { status: 400 });
        }
        return Response.json({});
      },
    });
    const response = await createAccountHandler({ backend, allowedOrigins })(
      request(deletion, { authorization: `Bearer ${accessToken}` }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error });
    assert.deepEqual(
      calls,
      [
        { path: '/auth/v1/user', method: 'GET' },
        { path: '/rest/v1/rpc/cookmate_account_begin_delete', method: 'POST' },
      ],
      'neither conflict reaches Auth deletion or completion lookup',
    );
  }
});

test('internal status responses are bounded independently of snapshot-sized RPC responses', async () => {
  const backend = createSupabaseBackend({
    url: 'https://project.test',
    publishableKey: 'public',
    serviceKey: 'server-only',
    fetch: async () => new Response('x'.repeat(4097)),
  });
  await assert.rejects(
    backend.rpc('cookmate_account_deletion_receipt', { p_operation: operation }),
    (error: unknown) => error instanceof AccountServiceError && error.status === 413,
  );
});
