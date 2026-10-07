import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDeletionRecoveryJournal,
  createDeletionRecoveryTransport,
  DELETION_RECOVERY_STORAGE_KEY,
  DeletionRecoveryError,
  type DeletionRecoveryFailure,
  type DeletionRecoveryPendingInput,
  type DeletionRecoveryReceipt,
  type DeletionRecoveryStorage,
  type PendingDeletionRecovery,
} from './deletionRecovery';

const id = (number: number) =>
  `${number.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const now = '2026-09-30T12:00:00.000Z';
const pendingInput = (number = 1): DeletionRecoveryPendingInput => ({
  ownerId: id(number),
  operationId: id(number + 1000),
  expectedRevision: 7,
  recoveryToken: number.toString(16).padStart(64, '0'),
});
const asPending = (number = 1): PendingDeletionRecovery => ({
  kind: 'pending',
  ...pendingInput(number),
});
const deletedReceipt = (operationId = pendingInput().operationId) => ({
  operationId,
  status: 'deleted' as const,
  deletedAt: '2026-09-30T11:59:00.123456+00:00',
  expiresAt: '2026-10-30T11:59:00.123456+00:00',
});
const reason = (expected: DeletionRecoveryFailure) => (error: unknown) =>
  error instanceof DeletionRecoveryError && error.reason === expected;

function fixture() {
  let raw: string | null = null;
  let writes = 0;
  let reads = 0;
  let mode: 'normal' | 'lost-ack' | 'not-saved' = 'normal';
  let beforeRead: ((count: number) => void) | null = null;
  const store: DeletionRecoveryStorage = {
    async getItem(key) {
      assert.equal(key, DELETION_RECOVERY_STORAGE_KEY);
      reads++;
      beforeRead?.(reads);
      return raw;
    },
    async setItem(key, value) {
      assert.equal(key, DELETION_RECOVERY_STORAGE_KEY);
      writes++;
      if (mode !== 'not-saved') raw = value;
      if (mode === 'lost-ack') throw new Error('Synthetic lost storage acknowledgement');
    },
    async removeItem() {
      assert.fail(
        'Confirmation must replace the whole record, not remove its pending credential first',
      );
    },
  };
  return {
    store,
    journal: createDeletionRecoveryJournal(store, { now: () => now }),
    get raw() {
      return raw;
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    replace(value: string | null) {
      raw = value;
    },
    mode(value: typeof mode) {
      mode = value;
    },
    beforeRead(value: typeof beforeRead) {
      beforeRead = value;
    },
  };
}

test('absent journal is empty and a pending credential survives a fresh journal instance', async () => {
  const f = fixture();
  assert.deepEqual(await f.journal.list(), []);
  assert.equal(await f.journal.read(id(1)), null);
  const first = await f.journal.putPending(pendingInput());
  assert.deepEqual(first, asPending());
  const reopened = createDeletionRecoveryJournal(f.store);
  assert.deepEqual(await reopened.read(id(1)), first);
  assert.equal(await reopened.read(id(2)), null);
});

test('exact retries do not write or rotate an intact credential', async () => {
  const f = fixture();
  await f.journal.putPending(pendingInput());
  const before = f.raw;
  await f.journal.putPending(pendingInput());
  assert.equal(f.writes, 1);
  assert.equal(f.raw, before);
  for (const changed of [
    { ...pendingInput(), recoveryToken: 'f'.repeat(64) },
    { ...pendingInput(), operationId: id(999) },
    { ...pendingInput(), expectedRevision: 8 },
  ])
    await assert.rejects(f.journal.putPending(changed), reason('changed'));
  assert.equal(f.raw, before);
});

test('shared storage serializes concurrent owners and rejects operation reuse across owners', async () => {
  const f = fixture();
  const another = createDeletionRecoveryJournal(f.store);
  await Promise.all([f.journal.putPending(pendingInput(1)), another.putPending(pendingInput(2))]);
  assert.equal((await f.journal.list()).length, 2);
  await assert.rejects(
    f.journal.putPending({ ...pendingInput(3), operationId: pendingInput(1).operationId }),
    reason('changed'),
  );
  assert.deepEqual(await f.journal.read(id(2)), asPending(2));
});

test('lost write acknowledgement resolves only through exact persisted readback', async () => {
  const f = fixture();
  f.mode('lost-ack');
  assert.deepEqual(await f.journal.putPending(pendingInput()), asPending());
  f.mode('not-saved');
  await assert.rejects(f.journal.putPending(pendingInput(2)), reason('storage'));
  assert.equal(await f.journal.read(id(2)), null);
  assert.deepEqual(await f.journal.read(id(1)), asPending());
});

test('whole-record comparison detects an outside change before overwriting another owner', async () => {
  const f = fixture();
  await f.journal.putPending(pendingInput(1));
  const otherRecord = JSON.stringify({ schemaVersion: 1, entries: [asPending(1), asPending(3)] });
  const changeAt = f.reads + 2;
  f.beforeRead((count) => {
    if (count === changeAt) f.replace(otherRecord);
  });
  await assert.rejects(f.journal.putPending(pendingInput(2)), reason('changed'));
  assert.equal(f.raw, otherRecord);
  assert.deepEqual(await f.journal.read(id(3)), asPending(3));
});

test('confirmation atomically retains proof, removes only its token, and preserves the other owner', async () => {
  const f = fixture();
  await f.journal.putPending(pendingInput(1));
  await f.journal.putPending(pendingInput(2));
  f.mode('lost-ack');
  const confirmed = await f.journal.confirm(asPending(), deletedReceipt());
  assert.deepEqual(confirmed, {
    kind: 'confirmed',
    ownerId: id(1),
    operationId: id(1001),
    expectedRevision: 7,
    confirmedAt: now,
  });
  assert.equal(f.raw!.includes(pendingInput(1).recoveryToken), false);
  assert.equal(f.raw!.includes(pendingInput(2).recoveryToken), true);
  const reopened = createDeletionRecoveryJournal(f.store);
  assert.deepEqual(await reopened.read(id(1)), confirmed);
  assert.deepEqual(await reopened.read(id(2)), asPending(2));
  assert.deepEqual(await reopened.confirm(asPending(), deletedReceipt()), confirmed);
  assert.deepEqual(await reopened.putPending(pendingInput()), confirmed);
  assert.equal(f.raw!.includes(pendingInput(1).recoveryToken), false);
});

test('authenticated deletion receipt must match both the owner and operation', async () => {
  const f = fixture();
  await f.journal.putPending(pendingInput());
  for (const receipt of [
    { ownerId: id(2), operationId: id(1001), deleted: true as const },
    { ownerId: id(1), operationId: id(1002), deleted: true as const },
  ])
    await assert.rejects(f.journal.confirm(asPending(), receipt), reason('invalid_response'));
  assert.deepEqual(await f.journal.read(id(1)), asPending());
  assert.equal(
    (
      await f.journal.confirm(asPending(), {
        ownerId: id(1),
        operationId: id(1001),
        deleted: true,
      })
    ).kind,
    'confirmed',
  );
});

test('absent, stale, pending or unpersisted proof never clears the recovery credential', async () => {
  const f = fixture();
  await assert.rejects(f.journal.confirm(asPending(), deletedReceipt()), reason('changed'));
  await f.journal.putPending(pendingInput());
  await assert.rejects(
    f.journal.confirm({ ...asPending(), recoveryToken: 'f'.repeat(64) }, deletedReceipt()),
    reason('changed'),
  );
  await assert.rejects(
    f.journal.confirm(asPending(), {
      operationId: id(1001),
      status: 'pending',
    } as unknown as DeletionRecoveryReceipt),
    reason('invalid_response'),
  );
  f.mode('not-saved');
  await assert.rejects(f.journal.confirm(asPending(), deletedReceipt()), reason('storage'));
  assert.deepEqual(await f.journal.read(id(1)), asPending());
});

test('definitely unadmitted rejection removes only the exact pending owner and preserves another owner', async () => {
  const f = fixture();
  await f.journal.putPending(pendingInput(1));
  await f.journal.putPending(pendingInput(2));
  await f.journal.rejectPending(asPending(1));
  assert.equal(await f.journal.read(id(1)), null);
  assert.deepEqual(await f.journal.read(id(2)), asPending(2));
  assert.equal(f.raw!.includes(pendingInput(1).recoveryToken), false);
  assert.equal(f.raw!.includes(pendingInput(2).recoveryToken), true);
});

test('unadmitted rejection cannot remove a missing, mismatched or confirmed row', async () => {
  const f = fixture();
  await assert.rejects(f.journal.rejectPending(asPending()), reason('changed'));
  assert.equal(f.writes, 0);
  await f.journal.putPending(pendingInput());
  const before = f.raw;
  for (const expected of [
    { ...asPending(), ownerId: id(2) },
    { ...asPending(), operationId: id(1002) },
    { ...asPending(), expectedRevision: 8 },
    { ...asPending(), recoveryToken: 'f'.repeat(64) },
  ])
    await assert.rejects(f.journal.rejectPending(expected), reason('changed'));
  assert.equal(f.raw, before);
  const confirmed = await f.journal.confirm(asPending(), deletedReceipt());
  const confirmedRaw = f.raw;
  await assert.rejects(f.journal.rejectPending(asPending()), reason('changed'));
  assert.equal(f.raw, confirmedRaw);
  assert.deepEqual(await f.journal.read(id(1)), confirmed);
});

test('failed rejection persistence leaves the credential available for recovery', async () => {
  const f = fixture();
  await f.journal.putPending(pendingInput());
  f.mode('not-saved');
  await assert.rejects(f.journal.rejectPending(asPending()), reason('storage'));
  assert.deepEqual(await f.journal.read(id(1)), asPending());
});

test('rejection resolves a lost write acknowledgement through exact readback', async () => {
  const f = fixture();
  await f.journal.putPending(pendingInput());
  f.mode('lost-ack');
  await f.journal.rejectPending(asPending());
  assert.deepEqual(await f.journal.list(), []);
  assert.deepEqual(JSON.parse(f.raw!), { schemaVersion: 1, entries: [] });
  const writes = f.writes;
  await assert.rejects(f.journal.rejectPending(asPending()), reason('changed'));
  assert.equal(f.writes, writes);
});

test('rejection detects another owner changing before write and a mismatched final readback', async () => {
  const f = fixture();
  await f.journal.putPending(pendingInput());
  const both = JSON.stringify({ schemaVersion: 1, entries: [asPending(), asPending(2)] });
  const beforeWrite = f.reads + 2;
  f.beforeRead((count) => {
    if (count === beforeWrite) f.replace(both);
  });
  await assert.rejects(f.journal.rejectPending(asPending()), reason('changed'));
  assert.equal(f.raw, both);
  const changedReadback = JSON.stringify({
    schemaVersion: 1,
    entries: [asPending(2), asPending(3)],
  });
  const afterWrite = f.reads + 3;
  f.beforeRead((count) => {
    if (count === afterWrite) f.replace(changedReadback);
  });
  await assert.rejects(f.journal.rejectPending(asPending()), reason('changed'));
  assert.equal(f.raw, changedReadback);
  assert.deepEqual(await f.journal.read(id(3)), asPending(3));
});

test('invalid IDs, revisions and tokens are rejected without storage writes', async () => {
  const f = fixture();
  for (const input of [
    { ...pendingInput(), ownerId: 'not-an-owner' },
    { ...pendingInput(), operationId: id(1001).toUpperCase() },
    { ...pendingInput(), expectedRevision: -1 },
    { ...pendingInput(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...pendingInput(), expectedRevision: 0.5 },
    { ...pendingInput(), recoveryToken: 'A'.repeat(64) },
    { ...pendingInput(), recoveryToken: 'a'.repeat(63) },
  ])
    await assert.rejects(f.journal.putPending(input), reason('invalid_input'));
  assert.equal(f.writes, 0);
});

test('journal enforces owner and byte bounds without evicting recovery records', async () => {
  const f = fixture();
  for (let number = 1; number <= 64; number++) await f.journal.putPending(pendingInput(number));
  const before = f.raw;
  await assert.rejects(f.journal.putPending(pendingInput(65)), reason('limit'));
  assert.equal(f.raw, before);
  assert.equal((await f.journal.list()).length, 64);
  f.replace(' '.repeat(65_537));
  await assert.rejects(f.journal.list(), reason('invalid_record'));
});

test('malformed, duplicate and secret-bearing confirmed records fail closed', async () => {
  const f = fixture();
  for (const raw of [
    '{',
    JSON.stringify({ schemaVersion: 2, entries: [] }),
    JSON.stringify({ schemaVersion: 1, entries: [asPending(), asPending()] }),
    JSON.stringify({
      schemaVersion: 1,
      entries: [{ ...asPending(), kind: 'confirmed', confirmedAt: now }],
    }),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          kind: 'confirmed',
          ownerId: id(1),
          operationId: id(1001),
          expectedRevision: 7,
          confirmedAt: '2026-02-30T00:00:00Z',
        },
      ],
    }),
  ]) {
    f.replace(raw);
    await assert.rejects(f.journal.list(), reason('invalid_record'));
    assert.equal(f.raw, raw);
  }
});

const endpoint = 'https://account.example/functions/v1/cookmate-account-deletion-status';
const capability = () => ({ operationId: id(1001), recoveryToken: pendingInput().recoveryToken });
const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

test('status lookup sends only the exact capability and safe request options without Auth', async () => {
  let calls = 0;
  const lookup = createDeletionRecoveryTransport({
    endpoint,
    publishableKey: 'sb_publishable_synthetic',
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, endpoint);
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.credentials, 'omit');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('apikey'), 'sb_publishable_synthetic');
      assert.deepEqual(JSON.parse(String(init?.body)), capability());
      return jsonResponse(deletedReceipt());
    },
  });
  assert.deepEqual(await lookup.readStatus(capability()), deletedReceipt());
  assert.equal(calls, 1);
});

test('pending lookup remains pending and public routing key may be omitted', async () => {
  const pending = { operationId: id(1001), status: 'pending' as const };
  const lookup = createDeletionRecoveryTransport({
    endpoint,
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('apikey'), null);
      return jsonResponse(pending);
    },
  });
  assert.deepEqual(await lookup.readStatus(capability()), pending);
});

test('unknown, expired and wrong-capability 404s are the same opaque unavailable result', async () => {
  for (const body of [{ error: 'deletion_receipt_unavailable' }, { deleted: true }, null]) {
    const lookup = createDeletionRecoveryTransport({
      endpoint,
      fetch: async () => jsonResponse(body, 404),
    });
    await assert.rejects(lookup.readStatus(capability()), reason('unavailable'));
  }
});

test('non-status URLs, redirects, embedded credentials and invalid routing keys fail closed', async () => {
  for (const invalid of [
    endpoint.replace('https:', 'http:'),
    endpoint.replace('deletion-status', 'delete'),
    `${endpoint}/`,
    `${endpoint}?token=x`,
    `${endpoint}#x`,
    endpoint.replace('https://', 'https://user:secret@'),
  ])
    assert.throws(
      () => createDeletionRecoveryTransport({ endpoint: invalid }),
      reason('invalid_input'),
    );
  assert.throws(
    () => createDeletionRecoveryTransport({ endpoint, publishableKey: 'private-service-role-key' }),
    reason('invalid_input'),
  );
  for (const status of [302, 401, 503]) {
    const lookup = createDeletionRecoveryTransport({
      endpoint,
      fetch: async () => jsonResponse(deletedReceipt(), status),
    });
    await assert.rejects(lookup.readStatus(capability()), reason('unavailable'));
  }
});

test('status response requires exact operation, keys and real ordered timestamps', async () => {
  for (const value of [
    deletedReceipt(id(1002)),
    { ...deletedReceipt(), ownerId: id(1) },
    { ...deletedReceipt(), deletedAt: '2026-02-30T10:00:00Z' },
    { ...deletedReceipt(), expiresAt: '2026-09-01T10:00:00Z' },
    { ...deletedReceipt(), expiresAt: '2026-10-30T13:00:00+01:00' },
    { operationId: id(1001), status: 'pending', deleted: true },
    { operationId: id(1001), status: 'unknown' },
  ]) {
    const lookup = createDeletionRecoveryTransport({
      endpoint,
      fetch: async () => jsonResponse(value),
    });
    await assert.rejects(lookup.readStatus(capability()), reason('invalid_response'));
  }
});

test('streamed body bound rejects oversized data despite a small header and cancels unread data', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2049));
    },
    cancel() {
      cancelled = true;
    },
  });
  const lookup = createDeletionRecoveryTransport({
    endpoint,
    fetch: async () =>
      new Response(body, {
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      }),
  });
  await assert.rejects(lookup.readStatus(capability()), reason('invalid_response'));
  assert.equal(cancelled, true);
});

test('oversized declared length also cancels its unread response body', async () => {
  let cancelled = false;
  const lookup = createDeletionRecoveryTransport({
    endpoint,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json', 'content-length': '2049' } },
      ),
  });
  await assert.rejects(lookup.readStatus(capability()), reason('invalid_response'));
  assert.equal(cancelled, true);
});

test('invalid UTF-8, missing body and non-JSON responses never become deletion proof', async () => {
  for (const make of [
    () =>
      new Response(Uint8Array.of(0xc3, 0x28), { headers: { 'content-type': 'application/json' } }),
    () => new Response(null, { headers: { 'content-type': 'application/json' } }),
    () =>
      new Response(JSON.stringify(deletedReceipt()), { headers: { 'content-type': 'text/html' } }),
  ]) {
    const lookup = createDeletionRecoveryTransport({ endpoint, fetch: async () => make() });
    await assert.rejects(lookup.readStatus(capability()), reason('invalid_response'));
  }
});

test('already-cancelled and malformed lookups make no request', async () => {
  let calls = 0;
  const lookup = createDeletionRecoveryTransport({
    endpoint,
    fetch: async () => {
      calls++;
      return jsonResponse(deletedReceipt());
    },
  });
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(lookup.readStatus(capability(), caller.signal), reason('cancelled'));
  await assert.rejects(
    lookup.readStatus({ ...capability(), recoveryToken: 'short' }),
    reason('invalid_input'),
  );
  assert.equal(calls, 0);
});

test('caller cancellation bounds a transport that ignores AbortSignal', async () => {
  const caller = new AbortController();
  const lookup = createDeletionRecoveryTransport({
    endpoint,
    fetch: () => new Promise(() => undefined),
  });
  const pending = lookup.readStatus(capability(), caller.signal);
  const rejected = assert.rejects(pending, reason('cancelled'));
  caller.abort();
  await rejected;
});

test('deadline covers a stalled response body without awaiting its stalled cancellation', async () => {
  const lookup = createDeletionRecoveryTransport({
    endpoint,
    timeoutMs: 5,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel: () => new Promise(() => undefined),
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  await assert.rejects(lookup.readStatus(capability()), reason('unavailable'));
});

test('late fetch response after cancellation has its body released, never treated as proof', async () => {
  let finish!: (response: Response) => void;
  let cancelled = false;
  const caller = new AbortController();
  const lookup = createDeletionRecoveryTransport({
    endpoint,
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const result = lookup.readStatus(capability(), caller.signal);
  const rejected = assert.rejects(result, reason('cancelled'));
  caller.abort();
  await rejected;
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await Promise.resolve();
  assert.equal(cancelled, true);
});
