import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_SNAPSHOT_MAX_BYTES, emptyAccountSnapshot } from '@cookmate/account-sync';
import { createAccountHandler } from '../src/handler';
import { createSupabaseBackend, type AccountBackend } from '../src/backend';
import { AccountServiceError } from '../src/protocol';
import { deletionCapabilityDigest } from '../src/deletion';
import { largeSnapshot } from './largeSnapshot';

const owner = '10000000-0000-4000-8000-000000000001';
const session = '20000000-0000-4000-8000-000000000001';
const operation = '30000000-0000-4000-8000-000000000001';
const recoveryToken = 'a'.repeat(64);
const snapshot = () =>
  emptyAccountSnapshot(
    { version: 'test-v1', fingerprint: 'a'.repeat(64) },
    {
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    },
  );
const receipt = () => ({
  ownerId: owner,
  operationId: operation,
  revision: 1,
  committedAt: '2026-09-30T16:00:00.000Z',
});
const emptyRead = () => ({
  ownerId: owner,
  revision: 0,
  schemaVersion: 1,
  snapshot: null,
  updatedAt: null,
  deletionPending: false,
  deletionOperationId: null,
});
function fixture(overrides: Partial<AccountBackend> = {}) {
  const calls: Array<{ name: string; input: unknown }> = [];
  let deleted = false;
  const backend: AccountBackend = {
    async verify(token) {
      calls.push({ name: 'verify', input: token });
      return { ownerId: owner, sessionId: session };
    },
    async rpc(name, input) {
      calls.push({ name, input });
      if (name === 'cookmate_sync_read') return emptyRead();
      if (name === 'cookmate_account_begin_delete')
        return { ownerId: owner, operationId: operation, deletionPending: true };
      if (name === 'cookmate_account_deletion_receipt')
        return {
          operationId: operation,
          state: deleted ? 'deleted' : 'pending',
          deletedAt: deleted ? '2026-09-30T16:00:00.000Z' : null,
          expiresAt: deleted ? '2026-10-30T16:00:00.000Z' : null,
          capabilityDigests: [await deletionCapabilityDigest(operation, recoveryToken)],
        };
      return receipt();
    },
    async deleteUser(id) {
      calls.push({ name: 'deleteUser', input: id });
      deleted = true;
    },
    ...overrides,
  };
  return {
    calls,
    handler: createAccountHandler({ backend, allowedOrigins: ['https://cookmate.test'] }),
  };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://account.test/functions/v1/cookmate-account', {
    method: 'POST',
    headers: {
      authorization: 'Bearer fixture-token',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
test('guest requests cannot access account data', async () => {
  const { handler, calls } = fixture();
  const result = await handler(request({ action: 'read' }, { authorization: '' }));
  assert.equal(result.status, 401);
  assert.equal(calls.length, 0);
});
test('identity is derived from verification, never supplied owner fields', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(request({ action: 'read', ownerId: 'other' }))).status, 400);
  assert.equal(calls.filter((v) => v.name === 'cookmate_sync_read').length, 0);
  assert.equal((await handler(request({ action: 'read' }))).status, 200);
  assert.deepEqual(calls.at(-1)?.input, { p_owner: owner, p_session: session });
});
test('validated commit returns only a server-confirmed receipt', async () => {
  const { handler, calls } = fixture();
  const result = await handler(
    request({
      action: 'commit',
      operationId: operation,
      expectedRevision: 0,
      snapshot: snapshot(),
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), receipt());
  const input = calls.at(-1)!.input as Record<string, unknown>;
  assert.equal(input.p_owner, owner);
  assert.equal(input.p_session, session);
  assert.deepEqual(input.p_snapshot, snapshot());
});
test('unknown snapshot fields, conversations and secrets never reach storage', async () => {
  for (const extra of [
    { apiKey: 'private' },
    { conversation: [{ text: 'private' }] },
    { unexpected: true },
  ]) {
    const { handler, calls } = fixture();
    const result = await handler(
      request({
        action: 'commit',
        operationId: operation,
        expectedRevision: 0,
        snapshot: { ...snapshot(), ...extra },
      }),
    );
    assert.equal(result.status, 400);
    assert.equal(calls.length, 1);
    assert.equal((await result.text()).includes('private'), false);
  }
});

test('expanded snapshot content crosses an unchanged transport envelope', async () => {
  const expanded = {
    ...snapshot(),
    schemaVersion: 2,
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
  };
  const committed = fixture();
  const result = await committed.handler(
    request({
      action: 'commit',
      operationId: operation,
      expectedRevision: 0,
      snapshot: expanded,
    }),
  );
  assert.equal(result.status, 200);
  assert.deepEqual((committed.calls.at(-1)!.input as Record<string, unknown>).p_snapshot, expanded);
  const wire = {
    ...emptyRead(),
    revision: 1,
    snapshot: expanded,
    updatedAt: receipt().committedAt,
  };
  const reading = fixture({ rpc: async () => wire });
  const response = await reading.handler(request({ action: 'read' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), wire);
});

test('SQL downgrade guard becomes a bounded upgrade-required response', async () => {
  const backend = createSupabaseBackend({
    url: 'https://project.test',
    publishableKey: 'public-fixture',
    serviceKey: 'server-fixture',
    fetch: async () =>
      Response.json({ code: 'CM426', message: 'private database context' }, { status: 400 }),
  });
  const { handler } = fixture({ rpc: backend.rpc });
  const response = await handler(
    request({
      action: 'commit',
      operationId: operation,
      expectedRevision: 1,
      snapshot: snapshot(),
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'snapshot_upgrade_required' });
  assert.equal(response.headers.get('retry-after'), null);
});
test('server conflict and retry hints are truthful and provider details stay private', async () => {
  for (const [status, code] of [
    [409, 'needs_review'],
    [429, 'sync_rate_limited'],
  ] as const) {
    const { handler } = fixture({
      rpc: async () => {
        throw new AccountServiceError(status, code);
      },
    });
    const result = await handler(
      request({
        action: 'commit',
        operationId: operation,
        expectedRevision: 0,
        snapshot: snapshot(),
      }),
    );
    assert.equal(result.status, status);
    assert.deepEqual(await result.json(), { error: code });
    assert.equal(result.headers.get('retry-after'), status === 429 ? '60' : null);
  }
  const { handler } = fixture({
    rpc: async () => {
      throw new Error('private service credential');
    },
  });
  const result = await handler(request({ action: 'read' }));
  assert.equal(result.status, 503);
  assert.equal((await result.text()).includes('credential'), false);
});
test('wrong-owner server response is rejected instead of exposed', async () => {
  const { handler } = fixture({ rpc: async () => ({ ...receipt(), ownerId: 'another-account' }) });
  const result = await handler(
    request({
      action: 'commit',
      operationId: operation,
      expectedRevision: 0,
      snapshot: snapshot(),
    }),
  );
  assert.equal(result.status, 503);
  assert.equal((await result.text()).includes('another-account'), false);
});
test('failed, jumping or incomplete commits cannot become success', async () => {
  for (const value of [
    {},
    null,
    { ...receipt(), revision: 0 },
    { ...receipt(), revision: 2 },
    { ...receipt(), committedAt: 'invalid' },
    { ...receipt(), committedAt: '2026-02-30T16:00:00.000Z' },
  ]) {
    const { handler } = fixture({ rpc: async () => value });
    assert.equal(
      (
        await handler(
          request({
            action: 'commit',
            operationId: operation,
            expectedRevision: 0,
            snapshot: snapshot(),
          }),
        )
      ).status,
      503,
    );
  }
});
test('read response validates snapshot/revision/time and pending deletion identity pairs', async () => {
  const variants = [
    { ...emptyRead(), revision: 1 },
    { ...emptyRead(), snapshot: snapshot() },
    { ...emptyRead(), updatedAt: receipt().committedAt },
    { ...emptyRead(), snapshot: undefined },
    { ...emptyRead(), deletionPending: true },
    { ...emptyRead(), deletionOperationId: operation },
    { ...emptyRead(), deletionPending: true, deletionOperationId: 'invalid' },
    { ...emptyRead(), revision: 1, snapshot: snapshot(), updatedAt: '2026-02-30T16:00:00.000Z' },
  ];
  for (const value of variants) {
    const { handler } = fixture({ rpc: async () => value });
    const result = await handler(request({ action: 'read' }));
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'invalid_server_result' });
  }
  const corrupt = fixture({
    rpc: async () => ({
      ...emptyRead(),
      revision: 1,
      snapshot: { ...snapshot(), credentials: 'private' },
      updatedAt: receipt().committedAt,
    }),
  });
  assert.equal((await corrupt.handler(request({ action: 'read' }))).status, 409);
});
test('read and commit responses project allowed fields; UTC PostgreSQL microseconds remain valid', async () => {
  const valid = {
    ...emptyRead(),
    revision: 1,
    snapshot: snapshot(),
    updatedAt: '2026-09-30T16:00:00.123456+00:00',
    deletionPending: true,
    deletionOperationId: operation,
  };
  const reading = fixture({ rpc: async () => ({ ...valid, internalDetail: 'never return' }) });
  const response = await reading.handler(request({ action: 'read' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), valid);
  const committing = fixture({
    rpc: async () => ({ ...receipt(), serviceMetadata: 'never return' }),
  });
  const committed = await committing.handler(
    request({
      action: 'commit',
      operationId: operation,
      expectedRevision: 0,
      snapshot: snapshot(),
    }),
  );
  assert.equal(committed.status, 200);
  assert.deepEqual(await committed.json(), receipt());
});
test('account deletion needs exact explicit confirmation and successful server deletion', async () => {
  const { handler, calls } = fixture();
  const base = { action: 'delete', operationId: operation, expectedRevision: 0, recoveryToken };
  assert.equal((await handler(request({ ...base, confirmation: 'yes' }))).status, 400);
  assert.equal(calls.filter((v) => v.name === 'deleteUser').length, 0);
  const result = await handler(request({ ...base, confirmation: 'DELETE_COOKMATE_ACCOUNT' }));
  assert.deepEqual(await result.json(), { ownerId: owner, operationId: operation, deleted: true });
  assert.deepEqual(
    calls.slice(-3).map((v) => v.name),
    ['cookmate_account_begin_delete', 'deleteUser', 'cookmate_account_deletion_receipt'],
  );
  const failed = fixture({
    deleteUser: async () => {
      throw new AccountServiceError(503, 'deletion_not_confirmed');
    },
  });
  assert.equal(
    (await failed.handler(request({ ...base, confirmation: 'DELETE_COOKMATE_ACCOUNT' }))).status,
    503,
  );
});
test('unapproved browser origins and mutating GET are refused; native lacks Origin', async () => {
  const { handler, calls } = fixture();
  assert.equal(
    (await handler(request({ action: 'read' }, { origin: 'https://attacker.test' }))).status,
    403,
  );
  assert.equal(calls.length, 0);
  assert.equal((await handler(new Request('https://account.test'))).status, 405);
  const response = await handler(request({ action: 'read' }, { origin: 'https://cookmate.test' }));
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://cookmate.test');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await handler(request({ action: 'read' }))).status, 200);
});
test('oversized bodies are bounded even without a Content-Length header', async () => {
  const { handler, calls } = fixture();
  const result = await handler(
    request({ action: 'read', oversize: 'x'.repeat(2 * 1024 * 1024 + 8192) }),
  );
  assert.equal(result.status, 413);
  assert.equal(calls.length, 1);
});
test('adapter verifies with Auth before trusting token claims', async () => {
  const claims = { sub: owner, session_id: session };
  const token = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test`;
  let requests = 0;
  const backend = createSupabaseBackend({
    url: 'https://project.test',
    publishableKey: 'public',
    serviceKey: 'server-only',
    fetch: async (input, init) => {
      requests++;
      assert.equal(new URL(String(input)).pathname, '/auth/v1/user');
      assert.equal(new Headers(init?.headers).get('apikey'), 'public');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      return Response.json({ id: owner });
    },
  });
  assert.deepEqual(await backend.verify(token), { ownerId: owner, sessionId: session });
  assert.equal(requests, 1);
  const rejected = createSupabaseBackend({
    url: 'https://project.test',
    publishableKey: 'public',
    serviceKey: 'server-only',
    fetch: async () => Response.json({ error: 'private provider response' }, { status: 401 }),
  });
  await assert.rejects(rejected.verify(token), /sign_in_required/);
});
test('invalid configuration and tokens lacking a live-session identity fail closed', async () => {
  assert.throws(() =>
    createSupabaseBackend({
      url: 'http://project.test',
      publishableKey: 'public',
      serviceKey: 'secret',
    }),
  );
  const backend = createSupabaseBackend({
    url: 'https://project.test',
    publishableKey: 'public',
    serviceKey: 'secret',
    fetch: async () => Response.json({ id: owner }),
  });
  await assert.rejects(backend.verify('e30.e30.signature'), /sign_in_required/);
});

test('large formatted RPC read is bounded separately from the strict snapshot wire limit', async () => {
  const value = largeSnapshot();
  const readResult = {
    ...emptyRead(),
    revision: 1,
    snapshot: value,
    updatedAt: receipt().committedAt,
  };
  const formatted = JSON.stringify(readResult, null, 4);
  assert.ok(Buffer.byteLength(formatted) > 3 * 1024 * 1024);
  assert.ok(Buffer.byteLength(formatted) < 6 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= ACCOUNT_SNAPSHOT_MAX_BYTES);
  const backend = createSupabaseBackend({
    url: 'https://project.test',
    publishableKey: 'public',
    serviceKey: 'server-only',
    fetch: async () => new Response(formatted, { headers: { 'content-type': 'application/json' } }),
  });
  const { handler } = fixture({ rpc: backend.rpc });
  const response = await handler(request({ action: 'read' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), readResult);
});

test('larger SQL storage allowance never relaxes the handler snapshot wire budget', async () => {
  const value = largeSnapshot();
  value.preferences = Array.from({ length: 100 }, (_, index) => ({
    preferenceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    type: 'cuisine',
    value: `${index}:` + 'x'.repeat(250),
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > ACCOUNT_SNAPSHOT_MAX_BYTES);
  const { handler, calls } = fixture();
  const response = await handler(
    request({ action: 'commit', operationId: operation, expectedRevision: 0, snapshot: value }),
  );
  assert.equal(response.status, 413);
  assert.equal(calls.filter((item) => item.name === 'cookmate_sync_commit').length, 0);
});

test('lost Auth deletion response remains unconfirmed; a later 401 never becomes deletion success', async () => {
  const claims = { sub: owner, session_id: session };
  const token = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.test`;
  let removed = false;
  const backend = createSupabaseBackend({
    url: 'https://project.test',
    publishableKey: 'public',
    serviceKey: 'server-only',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/v1/user')
        return Response.json(removed ? {} : { id: owner }, { status: removed ? 404 : 200 });
      assert.equal(init?.method, 'DELETE');
      removed = true;
      throw new Error('injected lost response after deletion');
    },
  });
  const { handler } = fixture({ verify: backend.verify, deleteUser: backend.deleteUser });
  const body = {
    action: 'delete',
    operationId: operation,
    expectedRevision: 0,
    confirmation: 'DELETE_COOKMATE_ACCOUNT',
    recoveryToken,
  };
  const first = await handler(request(body, { authorization: `Bearer ${token}` }));
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: 'deletion_not_confirmed' });
  const retry = await handler(request(body, { authorization: `Bearer ${token}` }));
  assert.equal(retry.status, 401);
  assert.deepEqual(await retry.json(), { error: 'sign_in_required' });
});
