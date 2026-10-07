import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity } from '@cookmate/catalogue';
import { API_VERSION, MAX_ASSISTANT_BODY_BYTES } from '@cookmate/contracts';
import type { PairResponse } from '@cookmate/contracts';
import { createGatewayConnection } from './transport';
import { createSecureCredentialStore, trustedEndpoint } from './credentials';
import type { CredentialStore, PairingCredential } from './credentials';
import { ConnectionError } from './errors';
import { id, request, response } from '../assistant-core/fixtures.test-support';

const endpoint = 'https://cookmate.example';

test('the final sharing gate blocks transmission even with valid pairing and request data', async () => {
  let calls = 0;
  let allowed = false;
  const client = createGatewayConnection({
    credentials: memory(credential()),
    now,
    authorizeAssistantRequest() {
      if (!allowed)
        throw new ConnectionError({
          code: 'unsupported_request',
          messageKey: 'assistant.sharing_consent_required',
          retry: 'after_correction',
        });
    },
    fetch: async () => {
      calls++;
      return json(response());
    },
  });
  await client.restore('installation');
  await assert.rejects(
    client.turn(request()),
    (error: unknown) =>
      error instanceof ConnectionError &&
      error.detail.messageKey === 'assistant.sharing_consent_required',
  );
  assert.equal(calls, 0);
  allowed = true;
  await client.turn(request());
  assert.equal(calls, 1);
  allowed = false;
  await assert.rejects(client.turn(request()), code('unsupported_request'));
  assert.equal(calls, 1);
});
const pairing: PairResponse = {
  apiVersion: API_VERSION,
  clientId: id(10),
  token: 'a'.repeat(43),
  expiresAt: '2026-10-05T00:00:00.000Z',
  catalogue: { ...identity },
};
const now = () => Date.parse('2026-09-28T00:00:00.000Z');
function memory(initial: unknown = null): CredentialStore & { value: unknown } {
  return {
    value: initial,
    async read() {
      return this.value;
    },
    async write(value) {
      this.value = value;
    },
    async clear() {
      this.value = null;
    },
  };
}
function credential(): PairingCredential {
  return { installationId: 'installation', endpoint, pairing };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function code(expected: string) {
  return (error: unknown) => error instanceof ConnectionError && error.detail.code === expected;
}

// Fictional platform storage: each injected rejection happens before that operation takes effect.
function faultingSecureStore(initial: PairingCredential) {
  let stored: string | null = JSON.stringify(initial);
  let failure: 'read' | 'write' | 'clear' | null = null;
  const calls = { read: 0, write: 0, clear: 0 };
  const before = (operation: 'read' | 'write' | 'clear') => {
    calls[operation]++;
    if (failure === operation) throw new Error('FICTIONAL_PRIVATE_STORAGE_FAILURE');
  };
  return {
    calls,
    stored: () => stored,
    fail(operation: typeof failure) {
      failure = operation;
    },
    credentials: createSecureCredentialStore({
      async getItemAsync() {
        before('read');
        return stored;
      },
      async setItemAsync(_, value) {
        before('write');
        stored = value;
      },
      async deleteItemAsync() {
        before('clear');
        stored = null;
      },
    }),
  };
}
function storageFailure(error: unknown) {
  assert.ok(error instanceof ConnectionError);
  assert.equal(error.detail.code, 'storage_failure');
  assert.equal(error.detail.messageKey, 'connection.storage_failure');
  assert.equal(error.message.includes('FICTIONAL_PRIVATE_STORAGE_FAILURE'), false);
  assert.equal(JSON.stringify(error.detail).includes('FICTIONAL_PRIVATE_STORAGE_FAILURE'), false);
  return true;
}

test('CredentialStore read rejection invalidates a restored pairing and allows explicit restore recovery', async () => {
  const store = faultingSecureStore(credential());
  let requests = 0;
  const client = createGatewayConnection({
    credentials: store.credentials,
    now,
    fetch: async (_, options) => {
      requests++;
      return json(response(JSON.parse(String(options?.body)) as ReturnType<typeof request>));
    },
  });
  const paired = await client.restore('installation');
  assert.equal(paired.status, 'paired');
  const before = store.stored();
  store.fail('read');
  await assert.rejects(client.restore('installation'), storageFailure);
  assert.deepEqual(client.getState(), { generation: paired.generation + 1, status: 'unpaired' });
  assert.equal(store.stored(), before, 'A failed read must not erase the unread credential');
  assert.deepEqual(store.calls, { read: 2, write: 0, clear: 0 });
  await assert.rejects(client.turn(request(client.getState().generation)), code('unauthenticated'));
  assert.equal(requests, 0, 'No saved or stale in-memory token may dispatch after the failed read');
  store.fail(null);
  const recovered = await client.restore('installation');
  assert.equal(recovered.status, 'paired');
  assert.equal((await client.turn(request(recovered.generation))).kind, 'proposal');
  assert.equal(requests, 1);
  assert.equal(store.stored(), before);
});

test('CredentialStore write rejection never reports pairing saved or dispatches; deliberate re-pair recovers', async () => {
  const store = faultingSecureStore(credential());
  const nextPairing: PairResponse = { ...pairing, clientId: id(11), token: 'b'.repeat(43) };
  const calls: string[] = [];
  const client = createGatewayConnection({
    credentials: store.credentials,
    now,
    fetch: async (url, options) => {
      calls.push(String(url));
      if (String(url) === `${endpoint}/v2/pair`) return json(nextPairing);
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        `Bearer ${nextPairing.token}`,
      );
      return json(response(JSON.parse(String(options?.body)) as ReturnType<typeof request>));
    },
  });
  const original = await client.restore('installation');
  store.fail('write');
  await assert.rejects(client.pair(endpoint, 'AAAAAAAAAAAA'), storageFailure);
  assert.deepEqual(client.getState(), { generation: original.generation + 1, status: 'unpaired' });
  assert.equal(
    store.stored(),
    null,
    'Old pairing was erased and the injected write did not commit',
  );
  assert.deepEqual(store.calls, { read: 1, write: 1, clear: 1 });
  await assert.rejects(client.turn(request(client.getState().generation)), code('unauthenticated'));
  assert.deepEqual(calls, [`${endpoint}/v2/pair`], 'No automatic re-pair or assistant dispatch');
  store.fail(null);
  const recovered = await client.pair(endpoint, 'BBBBBBBBBBBB');
  assert.equal(recovered.status, 'paired');
  assert.equal(recovered.clientId, nextPairing.clientId);
  assert.deepEqual(JSON.parse(store.stored()!), {
    installationId: 'installation',
    endpoint,
    pairing: nextPairing,
  });
  assert.equal((await client.turn(request(recovered.generation))).kind, 'proposal');
  assert.deepEqual(calls, [
    `${endpoint}/v2/pair`,
    `${endpoint}/v2/pair`,
    `${endpoint}/v2/assistant/turn`,
  ]);
});

for (const operation of [
  'fresh-install restore',
  'pair',
  'forget',
  'revokeAndForget',
  'auth rejection',
] as const) {
  test(`CredentialStore clear rejection during ${operation} fails closed and explicit deletion recovers`, async () => {
    const store = faultingSecureStore(credential());
    const calls: string[] = [];
    const client = createGatewayConnection({
      credentials: store.credentials,
      now,
      fetch: async (url) => {
        calls.push(String(url));
        assert.equal(
          operation,
          'auth rejection',
          'Storage must clear before pairing/revocation HTTP',
        );
        return json(
          { error: { code: 'pairing_revoked', retry: 'after_reconnect', messageKey: 'PRIVATE' } },
          401,
        );
      },
    });
    const original = await client.restore('installation');
    const before = store.stored();
    store.fail('clear');
    const actions = {
      'fresh-install restore': () => client.restore('different-installation'),
      pair: () => client.pair(endpoint, 'AAAAAAAAAAAA'),
      forget: () => client.forget(),
      revokeAndForget: () => client.revokeAndForget(),
      'auth rejection': () => client.turn(request(original.generation)),
    };
    await assert.rejects(actions[operation](), storageFailure);
    assert.deepEqual(client.getState(), {
      generation: original.generation + 1,
      status: operation === 'auth rejection' ? 'reconnect' : 'unpaired',
      ...(operation === 'auth rejection' ? { reason: 'pairing_revoked' } : {}),
    });
    assert.equal(
      store.stored(),
      before,
      'Rejected clear must not be reported as physical deletion',
    );
    assert.equal(store.calls.clear, 1);
    assert.equal(store.calls.write, 0);
    const expectedCalls = operation === 'auth rejection' ? [`${endpoint}/v2/assistant/turn`] : [];
    assert.deepEqual(calls, expectedCalls);
    await assert.rejects(
      client.turn(request(client.getState().generation)),
      code('unauthenticated'),
    );
    assert.deepEqual(calls, expectedCalls, 'Retained platform bytes cannot authorize another turn');
    store.fail(null);
    await client.forget();
    assert.equal(store.stored(), null);
    assert.equal(store.calls.clear, 2);
    assert.deepEqual(client.getState(), {
      generation: original.generation + 2,
      status: 'unpaired',
    });
    assert.deepEqual(
      calls,
      expectedCalls,
      'Recovery deletes locally without claiming server revocation',
    );
  });
}

test('HTTPS origins reject credential URLs, query strings, paths, HTTP and phone localhost', () => {
  for (const value of [
    'http://cookmate.example',
    `${endpoint}?token=x`,
    `${endpoint}/prefix`,
    'https://user:secret@cookmate.example',
    `${endpoint}#secret`,
    'https://localhost:3000',
    'https://127.0.0.1',
    'https://127.0.0.2',
    'https://phone.localhost',
    'https://0.0.0.0',
    'https://[::1]',
  ])
    assert.throws(() => trustedEndpoint(value), code('untrusted_endpoint'));
  assert.equal(trustedEndpoint(`${endpoint}/`), endpoint);
});

test('fresh-install marker mismatch clears surviving native credentials', async () => {
  const credentials = memory(credential());
  const client = createGatewayConnection({
    credentials,
    now,
    fetch: async () => {
      throw new Error('unexpected network');
    },
  });
  assert.equal((await client.restore('different-installation')).status, 'unpaired');
  assert.equal(credentials.value, null);
  await assert.rejects(client.turn(request()), code('unauthenticated'));
});

test('pairing stores strict credential only; assistant uses bearer body and no redirects', async () => {
  const credentials = memory();
  const calls: { url: string; options?: RequestInit }[] = [];
  const client = createGatewayConnection({
    credentials,
    now,
    fetch: async (url, options) => {
      calls.push({ url: String(url), ...(options ? { options } : {}) });
      if (String(url).endsWith('/v2/pair')) return json(pairing);
      return json(response(JSON.parse(String(options?.body)) as ReturnType<typeof request>));
    },
  });
  await client.restore('installation');
  const state = await client.pair(endpoint, 'AAAAAAAAAAAA');
  assert.equal(state.status, 'paired');
  assert.equal('token' in state, false);
  const answer = await client.turn(request(state.generation));
  assert.equal(answer.kind, 'proposal');
  assert.equal(calls[1]!.options?.redirect, 'error');
  assert.equal(calls[1]!.url, `${endpoint}/v2/assistant/turn`);
  assert.equal(
    (calls[1]!.options?.headers as Record<string, string>).Authorization,
    `Bearer ${pairing.token}`,
  );
  assert.equal(calls.length, 2);
});

test('unversioned health discovers API 2 and rejects API 1', async () => {
  for (const version of ['2', '1']) {
    const client = createGatewayConnection({
      credentials: memory(),
      now,
      fetch: async (url, options) => {
        assert.equal(String(url), `${endpoint}/health`);
        assert.equal(options?.method, 'GET');
        return json({ status: 'ready', apiVersion: version });
      },
    });
    if (version === '2') await client.health(endpoint);
    else await assert.rejects(client.health(endpoint), code('incompatible_version'));
  }
});

test('API 1 and invalid memory provenance are rejected before acceptance', async () => {
  const reply = response();
  const { memoryUpdate: _memoryUpdate, ...missingMemory } = reply;
  const invalidResponses = [
    { ...reply, apiVersion: '1' },
    missingMemory,
    { ...reply, memoryUpdate: { ...reply.memoryUpdate, baseRevision: 7 } },
    {
      ...reply,
      memoryUpdate: {
        ...reply.memoryUpdate,
        reviews: [{ sourceMessageId: request().message.messageId, disposition: 'retain' }],
        entries: [
          {
            sourceMessageId: request().message.messageId,
            quote: 'Invented user words',
            kind: 'constraint',
            scope: { kind: 'conversation' },
            relations: [],
          },
        ],
      },
    },
  ];
  for (const value of invalidResponses) {
    const client = createGatewayConnection({
      credentials: memory(credential()),
      now,
      fetch: async () => json(value),
    });
    await client.restore('installation');
    await assert.rejects(client.turn(request()), ConnectionError);
  }
});

test('wrong correlations/catalogue and unknown recipe proposals are rejected', async () => {
  for (const mutate of [
    (result: ReturnType<typeof response>) => {
      result.requestId = id(90);
    },
    (result: ReturnType<typeof response>) => {
      result.preferenceRevision = 4;
    },
    (result: ReturnType<typeof response>) => {
      result.catalogue = { ...identity, fingerprint: 'b'.repeat(64) };
    },
    (result: ReturnType<typeof response>) => {
      result.proposals = [{ kind: 'saveRecipe', recipeId: '99999999' }];
    },
  ]) {
    const result = response();
    mutate(result);
    const client = createGatewayConnection({
      credentials: memory(credential()),
      now,
      fetch: async () => json(result),
    });
    await client.restore('installation');
    await assert.rejects(client.turn(request()), ConnectionError);
  }
});

test('forget aborts late response and never restores pairing or retries', async () => {
  let resolve: (value: Response) => void = () => undefined;
  let calls = 0;
  const credentials = memory(credential());
  const client = createGatewayConnection({
    credentials,
    now,
    fetch: async () => {
      calls++;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    },
  });
  await client.restore('installation');
  const pending = client.turn(request());
  const rejected = assert.rejects(pending, code('cancelled'));
  await client.forget();
  resolve(json(response()));
  await rejected;
  assert.equal(client.getState().status, 'unpaired');
  assert.equal(credentials.value, null);
  assert.equal(calls, 1);
});

test('timeout is bounded even when fetch ignores abort and has no client retry', async () => {
  let calls = 0;
  const client = createGatewayConnection({
    credentials: memory(credential()),
    now,
    deadlineMs: 5,
    fetch: async () => {
      calls++;
      return new Promise<Response>(() => undefined);
    },
  });
  await client.restore('installation');
  await assert.rejects(client.turn(request()), code('deadline'));
  assert.equal(calls, 1);
});

test('cancel invalidates the old epoch while retaining pairing for a deliberate later request', async () => {
  const client = createGatewayConnection({
    credentials: memory(credential()),
    now,
    fetch: async (_, options) =>
      json(response(JSON.parse(String(options?.body)) as ReturnType<typeof request>)),
  });
  await client.restore('installation');
  client.cancel();
  assert.equal(client.getState().status, 'paired');
  assert.equal(client.getState().generation, 2);
  await assert.rejects(client.turn(request(1)), code('stale_context'));
  assert.equal((await client.turn(request(2))).kind, 'proposal');
});

test('forget during a pending SecureStore write cannot resurrect the paired association', async () => {
  const credentials = memory();
  let writing: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    writing = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  credentials.write = async (value) => {
    writing();
    await gate;
    credentials.value = value;
  };
  const client = createGatewayConnection({ credentials, now, fetch: async () => json(pairing) });
  await client.restore('installation');
  const pairingRequest = client.pair(endpoint, 'AAAAAAAAAAAA');
  const rejected = assert.rejects(pairingRequest, code('stale_context'));
  await entered;
  const forgetting = client.forget();
  release();
  await rejected;
  await forgetting;
  assert.equal(client.getState().status, 'unpaired');
  assert.equal(credentials.value, null);
});

test('oversized streamed reply, redirect and unbounded request are rejected', async () => {
  const replies = [
    new Response('a'.repeat(MAX_ASSISTANT_BODY_BYTES + 1)),
    new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
  ];
  for (const reply of replies) {
    const client = createGatewayConnection({
      credentials: memory(credential()),
      now,
      fetch: async () => reply,
    });
    await client.restore('installation');
    await assert.rejects(client.turn(request()), ConnectionError);
  }
  let calls = 0;
  const client = createGatewayConnection({
    credentials: memory(credential()),
    now,
    fetch: async () => {
      calls++;
      return json({});
    },
  });
  await client.restore('installation');
  const input = request();
  input.message.text = '🧑'.repeat(4001);
  await assert.rejects(client.turn(input), code('invalid_input'));
  assert.equal(calls, 0);
});

test('HTTP auth errors erase pairing and do not relay raw server diagnostic text', async () => {
  const credentials = memory(credential());
  const client = createGatewayConnection({
    credentials,
    now,
    fetch: async () =>
      json(
        {
          error: {
            code: 'pairing_revoked',
            retry: 'after_reconnect',
            messageKey: 'fictional-sensitive-server-text',
            field: 'private prompt',
          },
        },
        401,
      ),
  });
  await client.restore('installation');
  try {
    await client.turn(request());
    assert.fail();
  } catch (error) {
    assert.ok(error instanceof ConnectionError);
    assert.equal(JSON.stringify(error.detail).includes('fictional-sensitive-server-text'), false);
    assert.equal(error.detail.code, 'pairing_revoked');
  }
  assert.equal(credentials.value, null);
  assert.equal(client.getState().status, 'reconnect');
});

test('transport preserves only allowlisted context recovery markers', async () => {
  for (const field of ['context.token_limit', 'context.byte_limit', 'PRIVATE_DIAGNOSTIC']) {
    const client = createGatewayConnection({
      credentials: memory(credential()),
      now,
      fetch: async () =>
        json(
          { error: { code: 'too_large', retry: 'after_correction', messageKey: 'PRIVATE', field } },
          422,
        ),
    });
    await client.restore('installation');
    await assert.rejects(client.turn(request()), (error: unknown) => {
      assert.ok(error instanceof ConnectionError);
      assert.equal(error.detail.messageKey, 'connection.too_large');
      assert.equal(error.detail.field, field === 'PRIVATE_DIAGNOSTIC' ? undefined : field);
      return true;
    });
  }
});

test('provider refusal preserves safe recovery and pairing while discarding private gateway fields without retry', async () => {
  const privateText = 'FICTIONAL_PRIVATE_PROVIDER_REFUSAL';
  const credentials = memory(credential());
  let calls = 0;
  const client = createGatewayConnection({
    credentials,
    now,
    fetch: async () => {
      calls++;
      return json(
        {
          error: {
            code: 'provider_refused',
            retry: 'after_correction',
            messageKey: privateText,
            field: privateText,
          },
        },
        422,
      );
    },
  });
  const paired = await client.restore('installation');
  const before = structuredClone(credentials.value);
  const input = request(paired.generation);
  const unchangedInput = structuredClone(input);
  await assert.rejects(client.turn(input), (error: unknown) => {
    assert.ok(error instanceof ConnectionError);
    assert.deepEqual(error.detail, {
      code: 'provider_refused',
      retry: 'after_correction',
      messageKey: 'connection.provider_refused',
    });
    assert.equal(JSON.stringify(error).includes(privateText), false);
    return true;
  });
  assert.equal(calls, 1);
  assert.deepEqual(client.getState(), paired);
  assert.deepEqual(credentials.value, before);
  assert.deepEqual(input, unchangedInput);
});

test('self revoke has no request body and truthfully distinguishes local deletion from server failure', async () => {
  for (const reachable of [true, false]) {
    const credentials = memory(credential());
    const client = createGatewayConnection({
      credentials,
      now,
      fetch: async (url, options) => {
        assert.equal(String(url), `${endpoint}/v2/pairing`);
        assert.equal(options?.method, 'DELETE');
        assert.equal(options?.body, undefined);
        if (!reachable) throw new Error('network down');
        return new Response(null, { status: 204 });
      },
    });
    await client.restore('installation');
    const result = await client.revokeAndForget();
    assert.equal(result.localForgotten, true);
    assert.equal(result.serverRevoked, reachable);
    assert.equal(credentials.value, null);
  }
});

test('SecureStore adapter rejects additional provider key fields and malformed storage', async () => {
  let stored: string | null = '{broken';
  const store = createSecureCredentialStore({
    getItemAsync: async () => stored,
    setItemAsync: async (_, value) => {
      stored = value;
    },
    deleteItemAsync: async () => {
      stored = null;
    },
  });
  assert.equal(await store.read(), null);
  await assert.rejects(
    store.write({ ...credential(), providerKey: 'fictional' } as PairingCredential),
    code('invalid_input'),
  );
  await store.write(credential());
  assert.deepEqual(await store.read(), credential());
  await store.clear();
  assert.equal(stored, null);
});
