import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApi, ApiError, safePhotoUrl } from './api';

test('metadata review sends the exact field, evidence and revision through protected transport', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const api = new AdminApi(
    () => {},
    async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(
        calls.length === 1
          ? { configured: true, user: null, csrfToken: 'metadata-csrf', expiresAt: null }
          : { operationId: 'metadata-operation', draft: {} },
      );
    },
  );
  await api.session();
  const input = {
    field: 'prepMinutes' as const,
    value: 0,
    source: 'Fixture source; no preparation time.',
  };
  await api.metadata('draft/id', 'metadata-operation', 7, input);
  assert.equal(calls[1]!.url, '/admin/api/drafts/draft%2Fid/metadata');
  assert.equal(calls[1]!.init?.method, 'POST');
  assert.equal(new Headers(calls[1]!.init?.headers).get('x-csrf-token'), 'metadata-csrf');
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), {
    operationId: 'metadata-operation',
    expectedRevision: 7,
    input,
  });
});

test('signed release API preserves exact payload, CSRF and actor-scoped recovery fingerprint', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const api = new AdminApi(
    () => {},
    async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(
        calls.length === 1
          ? { configured: true, user: null, csrfToken: 'fixture-csrf', expiresAt: null }
          : {},
      );
    },
  );
  await api.session();
  await api.publicationReleaseState();
  const request = { operationId: 'operation-fixture', expectedHead: null, entries: [] };
  await api.issuePublicationRelease(request);
  await api.publicationReleaseOperation(request.operationId, 'a'.repeat(64));
  await api.resolvePublicationRelease(request.operationId, 'a'.repeat(64));
  assert.equal(calls[1]!.url, '/admin/api/publication/releases/current');
  assert.deepEqual(JSON.parse(String(calls[2]!.init?.body)), request);
  assert.equal(new Headers(calls[2]!.init?.headers).get('x-csrf-token'), 'fixture-csrf');
  assert.equal(
    calls[3]!.url,
    `/admin/api/publication/releases/operations/operation-fixture?requestFingerprint=${'a'.repeat(64)}`,
  );
  assert.equal(
    calls[4]!.url,
    '/admin/api/publication/releases/operations/operation-fixture/resolve',
  );
  assert.deepEqual(JSON.parse(String(calls[4]!.init?.body)), {
    requestFingerprint: 'a'.repeat(64),
  });
  assert.equal(new Headers(calls[4]!.init?.headers).get('x-csrf-token'), 'fixture-csrf');
});

test('publication preflight sends only the expected revision with same-origin CSRF protection', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const api = new AdminApi(
    () => {},
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? { configured: true, user: null, csrfToken: 'fixture-csrf', expiresAt: null }
            : { status: 'prepared_not_published' },
        ),
      );
    },
  );
  await api.session();
  assert.equal((await api.publicationPreview('fixture-draft', 7)).status, 'prepared_not_published');
  assert.equal(calls[1]!.url, '/admin/api/drafts/fixture-draft/publication-preview');
  assert.equal(calls[1]!.init?.method, 'POST');
  assert.equal(new Headers(calls[1]!.init?.headers).get('x-csrf-token'), 'fixture-csrf');
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), { expectedRevision: 7 });
});

test('default transport calls native fetch with its global receiver', async (t) => {
  let calls = 0;
  const receiverSensitiveFetch: typeof fetch = function (this: unknown) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    calls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          configured: true,
          user: null,
          csrfToken: 'native-token',
          expiresAt: null,
        }),
      ),
    );
  };
  t.mock.method(globalThis, 'fetch', receiverSensitiveFetch);
  const api = new AdminApi(() => {});
  assert.equal((await api.session()).csrfToken, 'native-token');
  assert.equal(calls, 1);
});

test('session CSRF is used for writes; draft payload and stable operation ID are sent unchanged', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify(
        calls.length === 1
          ? { configured: true, user: null, csrfToken: 'session-token', expiresAt: null }
          : { operationId: 'operation', draft: {} },
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const api = new AdminApi(() => {}, fetcher);
  await api.session();
  await api.create('operation', '53262');
  assert.equal(calls[1]!.url, '/admin/api/drafts');
  assert.equal(new Headers(calls[1]!.init?.headers).get('x-csrf-token'), 'session-token');
  assert.equal(calls[1]!.init?.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calls[1]!.init?.body)), {
    operationId: 'operation',
    fromRecipeId: '53262',
  });
});
test('authentication failure notifies the shell without replaying a rejected operation', async () => {
  let expired = 0;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in again.' } }),
      { status: 401 },
    );
  };
  const api = new AdminApi(() => {
    expired++;
  }, fetcher);
  await assert.rejects(
    api.draft('example'),
    (error: unknown) => error instanceof ApiError && error.status === 401 && !error.uncertain,
  );
  assert.equal(expired, 1);
  assert.equal(calls, 1);
});
test('lost responses stay uncertain and unsafe photograph URLs never become image requests', async () => {
  const api = new AdminApi(
    () => {},
    async () => {
      throw new Error('Network interrupted');
    },
  );
  await assert.rejects(
    api.operation('example'),
    (error: unknown) => error instanceof ApiError && error.uncertain,
  );
  assert.equal(safePhotoUrl('/admin/api/baseline/53262/photo'), '/admin/api/baseline/53262/photo');
  assert.equal(
    safePhotoUrl(`/admin/api/assets/${'a'.repeat(64)}`),
    `/admin/api/assets/${'a'.repeat(64)}`,
  );
  for (const value of [
    'https://external.test/photo.jpg',
    '//external.test/a',
    'javascript:alert(1)',
    '/admin/api/baseline/53262/photo?redirect=bad',
    '/admin/api/assets/../session',
    '/private/photo.png',
  ])
    assert.equal(safePhotoUrl(value), undefined);
});

test('resolution is an explicit CSRF-protected same-ID request with no save payload', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const api = new AdminApi(
    () => {},
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? { configured: true, user: null, csrfToken: 'resolution-token', expiresAt: null }
            : { operationId: 'pending-id', status: 'cancelled' },
        ),
      );
    },
  );
  await api.session();
  assert.equal(calls.length, 1);
  assert.deepEqual(await api.resolveOperation('pending-id'), {
    operationId: 'pending-id',
    status: 'cancelled',
  });
  assert.equal(calls[1]!.url, '/admin/api/operations/pending-id/cancel');
  assert.equal(calls[1]!.init?.method, 'POST');
  assert.equal(new Headers(calls[1]!.init?.headers).get('x-csrf-token'), 'resolution-token');
  assert.equal(calls[1]!.init?.body, '{}');
});

test('an interrupted resolution remains uncertain and is never automatically retried', async () => {
  let calls = 0;
  const api = new AdminApi(
    () => {},
    async () => {
      calls++;
      if (calls === 1)
        return new Response(
          JSON.stringify({ configured: true, user: null, csrfToken: 'token', expiresAt: null }),
        );
      throw new Error('Lost resolution acknowledgement');
    },
  );
  await api.session();
  await assert.rejects(
    api.resolveOperation('pending-id'),
    (error: unknown) => error instanceof ApiError && error.uncertain,
  );
  assert.equal(calls, 2);
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const sessionResponse = (token: string) =>
  new Response(
    JSON.stringify({
      configured: true,
      user: { userId: token, username: token, role: 'administrator' },
      csrfToken: token,
      expiresAt: null,
    }),
  );

test('an earlier request 401 cannot revoke a newer accepted sign-in', async () => {
  const delayed = deferredResponse();
  let unauthorized = 0;
  let calls = 0;
  let finalToken: string | null = null;
  const api = new AdminApi(
    () => {
      unauthorized++;
    },
    async (_url, init) => {
      calls++;
      if (calls === 1) return sessionResponse('old-token');
      if (calls === 2) return delayed.promise;
      if (calls === 3) return sessionResponse('new-token');
      finalToken = new Headers(init?.headers).get('x-csrf-token');
      return new Response(JSON.stringify({ operationId: 'new-change', draft: {} }));
    },
  );
  await api.session();
  const earlier = assert.rejects(
    api.draft('draft'),
    (error: unknown) =>
      error instanceof ApiError && error.code === 'auth_response_stale' && error.uncertain,
  );
  await api.login('new-operator', 'typed-password');
  delayed.resolve(
    new Response(JSON.stringify({ error: { code: 'expired', message: 'Old session expired.' } }), {
      status: 401,
    }),
  );
  await earlier;
  assert.equal(unauthorized, 0);
  await api.create('new-change');
  assert.equal(finalToken, 'new-token');
});

test('overlapping authentication requests are rejected before fetch rather than racing session cookies', async () => {
  const delayed = deferredResponse();
  let calls = 0;
  let finalToken: string | null = null;
  const api = new AdminApi(
    () => {},
    async (_url, init) => {
      calls++;
      if (calls === 1) return sessionResponse('initial-token');
      if (calls === 2) return delayed.promise;
      if (calls === 3) return sessionResponse('new-token');
      finalToken = new Headers(init?.headers).get('x-csrf-token');
      return new Response(JSON.stringify({ operationId: 'new-change', draft: {} }));
    },
  );
  await api.session();
  const refresh = api.session();
  for (const request of [
    () => api.session(),
    () => api.login('new-operator', 'typed-password'),
    () => api.reauth('typed-password'),
    () => api.logout(),
  ])
    await assert.rejects(
      request(),
      (error: unknown) =>
        error instanceof ApiError && error.code === 'session_busy' && !error.uncertain,
    );
  assert.equal(calls, 2);
  delayed.resolve(sessionResponse('refreshed-token'));
  assert.equal((await refresh).csrfToken, 'refreshed-token');
  assert.equal((await api.login('new-operator', 'typed-password')).user?.userId, 'new-token');
  await api.create('new-change');
  assert.equal(finalToken, 'new-token');
});

test('a failed authentication request releases its admission guard for an explicit retry', async () => {
  let calls = 0;
  const api = new AdminApi(
    () => {},
    async () => {
      calls++;
      if (calls === 1) throw new Error('Connection lost');
      return sessionResponse('retry-token');
    },
  );
  await assert.rejects(
    api.session(),
    (error: unknown) => error instanceof ApiError && error.uncertain,
  );
  assert.equal((await api.session()).csrfToken, 'retry-token');
  assert.equal(calls, 2);
});
