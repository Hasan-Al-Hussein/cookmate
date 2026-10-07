import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountRemote, AccountRemoteError } from '../src/remote';
import type { AccountRemoteSession } from '../src/remote';
import { id, snapshot, timestamp } from './fixtures';
import { expandedSnapshot, note } from './expandedFixtures';

const owner = id(100),
  operation = id(200);
const session: AccountRemoteSession = {
  ownerId: owner,
  accessToken: 'synthetic.access.token',
  generation: 1,
};
const state = () => ({
  ownerId: owner,
  schemaVersion: 1,
  revision: 0,
  snapshot: null,
  updatedAt: null,
  deletionPending: false,
  deletionOperationId: null,
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
function remote(
  fetcher: typeof fetch,
  overrides: Partial<Parameters<typeof createAccountRemote>[0]> = {},
) {
  return createAccountRemote({
    endpoint: 'https://account.example/functions/v1/cookmate-account',
    publishableKey: 'sb_publishable_synthetic',
    ownerId: owner,
    session: async () => session,
    isCurrent: () => true,
    fetch: fetcher,
    ...overrides,
  });
}
const reason = (expected: string) => (error: unknown) =>
  error instanceof AccountRemoteError && error.reason === expected;

test('account reads use exact authenticated owner and allowlisted response fields', async () => {
  const api = remote(async (url, init) => {
    assert.equal(String(url), 'https://account.example/functions/v1/cookmate-account');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${session.accessToken}`);
    assert.deepEqual(JSON.parse(init?.body as string), { action: 'read' });
    return response({ ...state(), debug: 'PRIVATE_SERVER_FIELD' });
  });
  assert.deepEqual(await api.read(), {
    ownerId: owner,
    revision: 0,
    snapshot: null,
    updatedAt: null,
    deletionOperationId: null,
  });
});

test('transport envelope stays version one while its strictly parsed snapshot can be version two', async () => {
  const expanded = expandedSnapshot();
  expanded.personal.notes = [note()];
  const api = remote(async () =>
    response({ ...state(), revision: 1, updatedAt: timestamp, snapshot: expanded }),
  );
  assert.deepEqual((await api.read()).snapshot, expanded);
  const invalid = structuredClone(expanded);
  Object.assign(invalid.personal.notes[0]!, { revision: 1 });
  await assert.rejects(
    remote(async () =>
      response({ ...state(), revision: 1, updatedAt: timestamp, snapshot: invalid }),
    ).read(),
    reason('invalid_response'),
  );
});

test('missing, wrong-owner and changed sessions make no request', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return response(state());
  };
  await assert.rejects(
    remote(fetcher, { session: async () => null }).read(),
    reason('sign_in_required'),
  );
  await assert.rejects(
    remote(fetcher, { session: async () => ({ ...session, ownerId: id(101) }) }).read(),
    reason('account_changed'),
  );
  await assert.rejects(
    remote(fetcher, { isCurrent: () => false }).read(),
    reason('account_changed'),
  );
  assert.equal(calls, 0);
});

test('switching accounts while a response arrives cannot adopt it', async () => {
  let current = true;
  const api = remote(
    async () => {
      current = false;
      return response(state());
    },
    { isCurrent: () => current },
  );
  await assert.rejects(api.read(), reason('account_changed'));
});

test('wrong-owner, inconsistent revision and malformed snapshots are rejected', async () => {
  for (const value of [
    { ...state(), ownerId: id(101) },
    { ...state(), revision: 1 },
    { ...state(), deletionPending: true },
    {
      ...state(),
      revision: 1,
      updatedAt: timestamp,
      snapshot: { ...snapshot(), secret: 'PRIVATE' },
    },
    { ...state(), revision: 1, updatedAt: '2026-02-30T00:00:00Z', snapshot: snapshot() },
  ])
    await assert.rejects(remote(async () => response(value)).read(), reason('invalid_response'));
});

test('commit requires exact receipt, preserves operation identity and never retries', async () => {
  let calls = 0;
  const input = { operationId: operation, expectedRevision: 4, snapshot: snapshot() };
  const good = { ownerId: owner, operationId: operation, revision: 5, committedAt: timestamp };
  const api = remote(async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init?.body as string), { action: 'commit', ...input });
    return response({ ...good, unwanted: 'ignored' });
  });
  assert.deepEqual(await api.commit(input), good);
  assert.equal(calls, 1);
  for (const receipt of [
    { ...good, ownerId: id(300) },
    { ...good, revision: 6 },
    { ...good, operationId: id(301) },
  ])
    await assert.rejects(
      remote(async () => response(receipt)).commit(input),
      reason('invalid_response'),
    );
});

test('provider prose stays private and known account failures are actionable', async () => {
  for (const [status, error, expected] of [
    [409, 'needs_review', 'needs_review'],
    [409, 'snapshot_upgrade_required', 'snapshot_upgrade_required'],
    [503, 'snapshot_upgrade_required', 'unavailable'],
    [429, 'sync_rate_limited', 'sync_rate_limited'],
    [503, 'needs_review', 'unavailable'],
    [503, 'PRIVATE_SQL_AND_TOKEN', 'unavailable'],
  ] as const) {
    let calls = 0;
    const api = remote(async () => {
      calls++;
      return response({ error, detail: 'PRIVATE' }, status);
    });
    await assert.rejects(
      api.commit({ operationId: operation, expectedRevision: 0, snapshot: snapshot() }),
      (error: unknown) => reason(expected)(error) && !String(error).includes('PRIVATE'),
    );
    assert.equal(calls, 1);
  }
});

test('cancelled calls do not dispatch; timed out transport stays uncertain without resend', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    remote(async () => {
      calls++;
      return response(state());
    }).read(controller.signal),
    reason('cancelled'),
  );
  assert.equal(calls, 0);
  const api = remote(
    async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_TRANSPORT')), {
          once: true,
        }),
      );
    },
    { timeoutMs: 10 },
  );
  await assert.rejects(
    api.commit({ operationId: operation, expectedRevision: 0, snapshot: snapshot() }),
    reason('unavailable'),
  );
  assert.equal(calls, 1);
});

test('oversized streamed or advertised responses cannot bypass the client bound', async () => {
  for (const reply of [
    new Response('{}', { headers: { 'content-length': '99999999' } }),
    new Response('x'.repeat(2 * 1024 * 1024 + 8193)),
  ])
    await assert.rejects(remote(async () => reply).read(), reason('invalid_response'));
});

test('deletion needs explicit confirmation; loss or a later401 never becomes success', async () => {
  const input = {
    operationId: operation,
    expectedRevision: 2,
    confirmation: 'DELETE_COOKMATE_ACCOUNT' as const,
    recoveryToken: 'a'.repeat(64),
  };
  const api = remote(async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { action: 'delete', ...input });
    return response({ ownerId: owner, operationId: operation, deleted: true });
  });
  assert.equal((await api.delete(input)).deleted, true);
  await assert.rejects(
    remote(async () => {
      throw new Error('lost');
    }).delete(input),
    reason('unavailable'),
  );
  await assert.rejects(
    remote(async () => response({ error: 'sign_in_required' }, 401)).delete(input),
    reason('sign_in_required'),
  );
  await assert.rejects(
    remote(async () => response({ deleted: true })).delete(input),
    reason('deletion_not_confirmed'),
  );
});

test('malformed deletion tokens cannot look like a definitely rejected server operation', async () => {
  let dispatched = 0;
  const api = remote(async () => {
    dispatched++;
    return response({ error: 'needs_review' }, 409);
  });
  for (const recoveryToken of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\n'])
    await assert.rejects(
      api.delete({
        operationId: operation,
        expectedRevision: 0,
        confirmation: 'DELETE_COOKMATE_ACCOUNT',
        recoveryToken,
      }),
      reason('invalid_response'),
    );
  assert.equal(dispatched, 0);
  await assert.rejects(
    api.delete({
      operationId: operation,
      expectedRevision: 0,
      confirmation: 'DELETE_COOKMATE_ACCOUNT',
      recoveryToken: 'a'.repeat(64),
    }),
    reason('needs_review'),
  );
  assert.equal(dispatched, 1);
});

test('unsafe endpoint and administrative keys fail before any request', () => {
  const fetcher: typeof fetch = async () => response(state());
  for (const endpoint of [
    'http://account.example',
    'https://user:password@account.example',
    'https://account.example?key=private',
    'https://account.example#fragment',
  ])
    assert.throws(() => remote(fetcher, { endpoint }), reason('unavailable'));
  for (const publishableKey of ['sb_secret_private', 'service-role-value', ''])
    assert.throws(() => remote(fetcher, { publishableKey }), reason('unavailable'));
});
