import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAccountContentRemote,
  parseAccountContentServiceRemoteState,
} from '../src/contentRemote';
import type { AccountContentSnapshot } from '../src/contentSnapshot';
import {
  AccountRemoteError,
  createAccountRemote,
  type AccountRemoteOptions,
  type AccountRemoteSession,
} from '../src/remote';
import { ACCOUNT_SNAPSHOT_MAX_BYTES } from '../src/types';
import { expandedSnapshot, history, note } from './expandedFixtures';
import { id, occurrence, snapshot, timestamp } from './fixtures';
import * as publicAccountApi from '../src/index';

const ownerId = id(701),
  operationId = id(702);
const session: AccountRemoteSession = {
  ownerId,
  accessToken: 'synthetic.access.token',
  generation: 1,
};
function content(): AccountContentSnapshot {
  const { cookingHistory: _old, ...core } = expandedSnapshot();
  return {
    ...core,
    schemaVersion: 3,
    plan: [occurrence(11)],
    planReferences: [
      {
        occurrenceId: id(11),
        contentRef: {
          recipeId: '52819',
          revisionId: 'fixture-exact-original',
          contentFingerprint: 'b'.repeat(64),
        },
      },
    ],
    personal: {
      notes: [note(12, '52819', '  Original\n量  ')],
      collections: [],
      memberships: [],
      manualItems: [],
    },
    cookingHistory: {
      entries: [
        {
          kind: 'legacy',
          entry: history(13),
          pin: { kind: 'unresolved', reason: 'content_mismatch' },
        },
      ],
      removedEventIds: [id(14)],
    },
  };
}
const state = (value: unknown = null) => ({
  schemaVersion: 1,
  ownerId,
  revision: value === null ? 0 : 4,
  snapshot: value,
  updatedAt: value === null ? null : timestamp,
  deletionPending: false,
  deletionOperationId: null,
});
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const receipt = () => ({ ownerId, operationId, revision: 5, committedAt: timestamp });
function options(
  fetcher: typeof fetch,
  overrides: Partial<AccountRemoteOptions> = {},
): AccountRemoteOptions {
  return {
    endpoint: 'https://account.example/functions/v1/cookmate-account',
    publishableKey: 'sb_publishable_synthetic',
    ownerId,
    session: async () => session,
    isCurrent: () => true,
    fetch: fetcher,
    ...overrides,
  };
}
const reason = (wanted: string) => (error: unknown) =>
  error instanceof AccountRemoteError && error.reason === wanted;

test('reader preserves each original format and exact references without legacy projection', async () => {
  for (const value of [null, snapshot(), expandedSnapshot(), content()]) {
    let calls = 0;
    const api = createAccountContentRemote(
      options(async (_url, init) => {
        calls++;
        assert.deepEqual(JSON.parse(String(init?.body)), { action: 'read' });
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          'Bearer synthetic.access.token',
        );
        assert.equal(init?.cache, 'no-store');
        assert.equal(init?.redirect, 'error');
        return reply(state(value));
      }),
    );
    const actual = await api.read();
    assert.deepEqual(actual.snapshot, value);
    assert.ok(Object.isFrozen(actual));
    if (actual.snapshot) assert.ok(Object.isFrozen(actual.snapshot.plan));
    assert.equal(calls, 1);
  }
});

test('format3 adapter is private and the existing legacy remote still rejects format3', async () => {
  assert.equal('createAccountContentRemote' in publicAccountApi, false);
  assert.equal('createAccountRequest' in publicAccountApi, false);
  assert.equal('accountRemoteTimestamp' in publicAccountApi, false);
  await assert.rejects(
    createAccountRemote(options(async () => reply(state(content())))).read(),
    reason('invalid_response'),
  );
});

test('strict envelope refuses wrong owner, extra fields, malformed refs and conflicting deletion state', () => {
  const wrong = content();
  wrong.planReferences[0]!.occurrenceId = id(99);
  for (const value of [
    { ...state(content()), ownerId: id(703) },
    { ...state(content()), debug: 'PRIVATE' },
    { ...state(content()), schemaVersion: 3 },
    { ...state(), revision: 1 },
    { ...state(content()), updatedAt: '2026-02-30T00:00:00Z' },
    { ...state(content()), deletionPending: true },
    { ...state(content()), deletionOperationId: id(704) },
    state(wrong),
    state({ ...content(), schemaVersion: 4 }),
    state({ ...content(), unexpected: true }),
  ])
    assert.throws(
      () => parseAccountContentServiceRemoteState(value, ownerId),
      reason('invalid_response'),
    );
  const deleted = parseAccountContentServiceRemoteState(
    { ...state(content()), deletionPending: true, deletionOperationId: id(704) },
    ownerId,
  );
  assert.equal(deleted.deletionOperationId, id(704));
});

test('reader refuses accessors before invoking them and detaches nested snapshot input', () => {
  let invoked = false;
  const value = state(content());
  const parsed = parseAccountContentServiceRemoteState(value, ownerId);
  (value.snapshot as AccountContentSnapshot).personal.notes[0]!.text = 'changed';
  assert.equal(
    (parsed.snapshot as AccountContentSnapshot).personal.notes[0]!.text,
    '  Original\n量  ',
  );
  Object.defineProperty(value, 'snapshot', {
    enumerable: true,
    get() {
      invoked = true;
      return content();
    },
  });
  assert.throws(
    () => parseAccountContentServiceRemoteState(value, ownerId),
    reason('invalid_response'),
  );
  assert.equal(invoked, false);
});

test('PostgreSQL microsecond UTC timestamps remain exact service evidence', async () => {
  const micro = '2026-10-01T13:20:10.123456+00:00';
  const api = createAccountContentRemote(
    options(async (_url, init) =>
      reply(
        JSON.parse(String(init?.body)).action === 'read'
          ? { ...state(content()), updatedAt: micro }
          : { ...receipt(), committedAt: micro },
      ),
    ),
  );
  assert.equal((await api.read()).updatedAt, micro);
  assert.equal(
    (await api.commit({ operationId, expectedRevision: 4, snapshot: content() })).committedAt,
    micro,
  );
});

test('only a valid format3 candidate dispatches and the exact receipt is immutable', async () => {
  let calls = 0;
  const input = { operationId, expectedRevision: 4, snapshot: content() };
  const api = createAccountContentRemote(
    options(async (_url, init) => {
      calls++;
      assert.deepEqual(JSON.parse(String(init?.body)), { action: 'commit', ...input });
      return reply(receipt());
    }),
  );
  const result = await api.commit(input);
  assert.deepEqual(result, receipt());
  assert.ok(Object.isFrozen(result));
  for (const invalid of [
    { ...input, snapshot: snapshot() },
    { ...input, snapshot: expandedSnapshot() },
    { ...input, operationId: 'not-an-operation' },
    { ...input, expectedRevision: Number.MAX_SAFE_INTEGER },
    { ...input, extra: 'not allowed' },
    { ...input, snapshot: { ...content(), planReferences: [] } },
  ])
    await assert.rejects(api.commit(invalid as typeof input), reason('invalid_response'));
  assert.equal(calls, 1);
});

test('candidate and operation cannot change during asynchronous session acquisition', async () => {
  let release!: (value: AccountRemoteSession) => void;
  const acquired = new Promise<AccountRemoteSession>((resolve) => {
    release = resolve;
  });
  const input = { operationId, expectedRevision: 4, snapshot: content() };
  const expected = structuredClone(input);
  const api = createAccountContentRemote(
    options(
      async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), { action: 'commit', ...expected });
        return reply(receipt());
      },
      { session: () => acquired },
    ),
  );
  const pending = api.commit(input);
  input.operationId = id(750);
  input.expectedRevision = 999;
  input.snapshot.personal.notes[0]!.text = 'Do not upload this late mutation';
  release(session);
  assert.deepEqual(await pending, receipt());
});

test('configured owner and callbacks cannot be rebound by mutating options', async () => {
  const config = options(async () => reply(state(content())));
  const api = createAccountContentRemote(config);
  config.ownerId = id(751);
  config.session = async () => ({ ...session, ownerId: id(751) });
  config.isCurrent = () => false;
  assert.equal((await api.read()).ownerId, ownerId);
});

test('mismatched or additional receipt fields cannot acknowledge a write', async () => {
  for (const value of [
    { ...receipt(), ownerId: id(703) },
    { ...receipt(), operationId: id(704) },
    { ...receipt(), revision: 6 },
    { ...receipt(), debug: 'PRIVATE' },
    { ...receipt(), committedAt: '2026-02-30T00:00:00Z' },
  ])
    await assert.rejects(
      createAccountContentRemote(options(async () => reply(value))).commit({
        operationId,
        expectedRevision: 4,
        snapshot: content(),
      }),
      reason('invalid_response'),
    );
});

test('owner switch or closed generation during response prevents its use', async () => {
  let current = true,
    calls = 0;
  const api = createAccountContentRemote(
    options(
      async () => {
        calls++;
        current = false;
        return reply(receipt());
      },
      { isCurrent: () => current },
    ),
  );
  await assert.rejects(
    api.commit({ operationId, expectedRevision: 4, snapshot: content() }),
    reason('account_changed'),
  );
  assert.equal(calls, 1);
});

test('in-place credential mutation cannot make an old response current in either adapter', async () => {
  for (const create of [createAccountContentRemote, createAccountRemote]) {
    for (const change of ['generation', 'accessToken'] as const) {
      const mutable = { ...session };
      const api = create(
        options(
          async () => {
            if (change === 'generation') mutable.generation++;
            else mutable.accessToken = 'replacement.token';
            return reply(state());
          },
          { session: async () => mutable, isCurrent: (candidate) => candidate === mutable },
        ),
      );
      await assert.rejects(api.read(), reason('account_changed'));
    }
  }
});

test('same-owner revocation between request completion and adapter continuation is rejected', async () => {
  for (const action of ['read', 'commit'] as const) {
    let current = true,
      checks = 0;
    const api = createAccountContentRemote(
      options(async () => reply(action === 'read' ? state(content()) : receipt()), {
        isCurrent: () => {
          if (++checks === 3)
            queueMicrotask(() => {
              current = false;
            });
          return current;
        },
      }),
    );
    await assert.rejects(
      action === 'read'
        ? api.read()
        : api.commit({ operationId, expectedRevision: 4, snapshot: content() }),
      reason('account_changed'),
    );
    assert.equal(checks, 4);
  }
});

test('early oversized Content-Length rejection closes its otherwise open body', async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      cancelled++;
    },
  });
  const api = createAccountContentRemote(
    options(
      async () =>
        new Response(body, {
          headers: { 'content-length': String(ACCOUNT_SNAPSHOT_MAX_BYTES + 8193) },
        }),
    ),
  );
  await assert.rejects(api.read(), reason('invalid_response'));
  assert.equal(cancelled, 1);
});

test('server opt-in failure, CAS and quota responses stay explicit without hidden retries or private prose', async () => {
  for (const [code, status, expected] of [
    ['snapshot_upgrade_required', 409, 'snapshot_upgrade_required'],
    ['stored_data_needs_review', 409, 'stored_data_needs_review'],
    ['needs_review', 409, 'needs_review'],
    ['deletion_pending', 409, 'deletion_pending'],
    ['sync_rate_limited', 429, 'sync_rate_limited'],
    ['PRIVATE_SQL', 503, 'unavailable'],
  ] as const) {
    let calls = 0;
    const api = createAccountContentRemote(
      options(async () => {
        calls++;
        return reply({ error: code, detail: 'PRIVATE' }, status);
      }),
    );
    await assert.rejects(
      api.commit({ operationId, expectedRevision: 4, snapshot: content() }),
      (error: unknown) => reason(expected)(error) && !String(error).includes('PRIVATE'),
    );
    assert.equal(calls, 1);
  }
});

test('oversized and invalid UTF8 responses are bounded and never become empty successful state', async () => {
  for (const value of [
    new Response('{}', {
      headers: { 'content-length': String(ACCOUNT_SNAPSHOT_MAX_BYTES + 8193) },
    }),
    new Response('x'.repeat(ACCOUNT_SNAPSHOT_MAX_BYTES + 8193)),
    new Response(new Uint8Array([0xc3, 0x28])),
  ])
    await assert.rejects(
      createAccountContentRemote(options(async () => value)).read(),
      (error: unknown) => reason('invalid_response')(error) || reason('unavailable')(error),
    );
});
