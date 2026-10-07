import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  emptyAccountSnapshot,
  parseAccountSnapshot,
} from '@cookmate/account-sync';
import { canonicalAccountContentSnapshot } from '../../../packages/account-sync/src/contentSnapshot';
import { createAccountHandler } from '../src/handler';
import { parseAccountServiceSnapshot } from '../src/snapshot';
import type { AccountBackend } from '../src/backend';
import { contentSnapshotFixture, largeContentSnapshot } from './contentSnapshotFixture';

const owner = '10000000-0000-4000-8000-000000000001';
const session = '20000000-0000-4000-8000-000000000001';
const operation = '30000000-0000-4000-8000-000000000001';
const at = '2026-10-01T12:00:00.000Z';
function fixture(enableContentSnapshots?: boolean, stored: unknown = contentSnapshotFixture()) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const backend: AccountBackend = {
    async verify() {
      return { ownerId: owner, sessionId: session };
    },
    async rpc(name, input) {
      calls.push({ name, input });
      if (name === 'cookmate_sync_read')
        return {
          ownerId: owner,
          revision: 1,
          schemaVersion: 1,
          snapshot: stored,
          updatedAt: at,
          deletionPending: false,
          deletionOperationId: null,
        };
      return { ownerId: owner, operationId: operation, revision: 1, committedAt: at };
    },
    async deleteUser() {
      throw new Error('Not part of these snapshot tests');
    },
  };
  return {
    calls,
    handler: createAccountHandler({
      backend,
      allowedOrigins: [],
      ...(enableContentSnapshots === undefined ? {} : { enableContentSnapshots }),
    }),
  };
}
function request(body: unknown) {
  return new Request('https://account.test/functions/v1/cookmate-account', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const commit = (snapshot: unknown) =>
  request({ action: 'commit', operationId: operation, expectedRevision: 0, snapshot });

test('format3 capability is default off and stored format3 is never replaced by an empty success', async () => {
  for (const enabled of [undefined, false]) {
    const { handler, calls } = fixture(enabled);
    const denied = await handler(commit(contentSnapshotFixture()));
    assert.equal(denied.status, 400);
    assert.deepEqual(await denied.json(), { error: 'invalid_snapshot' });
    assert.equal(calls.length, 0);
    const reading = await handler(request({ action: 'read' }));
    assert.equal(reading.status, 409);
    assert.deepEqual(await reading.json(), { error: 'stored_data_needs_review' });
    assert.equal(calls.length, 1);
  }
  assert.throws(
    () => parseAccountSnapshot(JSON.stringify(contentSnapshotFixture())),
    /unsupported_version/,
  );
});

test('explicit enabled service accepts exact format3 fields with the unchanged transport envelope', async () => {
  const value = contentSnapshotFixture(),
    before = JSON.stringify(value);
  const { handler, calls } = fixture(true, value);
  const committed = await handler(commit(value));
  assert.equal(committed.status, 200);
  assert.deepEqual(await committed.json(), {
    ownerId: owner,
    operationId: operation,
    revision: 1,
    committedAt: at,
  });
  assert.deepEqual(calls[0]!.input, {
    p_owner: owner,
    p_session: session,
    p_operation: operation,
    p_expected_revision: 0,
    p_snapshot: JSON.parse(canonicalAccountContentSnapshot(value)),
  });
  const response = await handler(request({ action: 'read' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ownerId: owner,
    revision: 1,
    schemaVersion: 1,
    snapshot: JSON.parse(canonicalAccountContentSnapshot(value)),
    updatedAt: at,
    deletionPending: false,
    deletionOperationId: null,
  });
  assert.equal(JSON.stringify(value), before);
});

test('enabled service retains legacy1/2 parsing and never infers history inclusion', async () => {
  const one = emptyAccountSnapshot(
    { version: 'fixture-v1', fingerprint: 'a'.repeat(64) },
    {
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    },
  );
  const two = {
    ...one,
    schemaVersion: 2,
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
  };
  const three = contentSnapshotFixture();
  delete three.cookingHistory;
  for (const value of [one, two, three]) {
    const { handler, calls } = fixture(true, value);
    assert.equal((await handler(commit(value))).status, 200);
    assert.deepEqual(calls[0]!.input.p_snapshot, value);
    assert.equal(Object.hasOwn(calls[0]!.input.p_snapshot as object, 'cookingHistory'), false);
    assert.equal((await handler(request({ action: 'read' }))).status, 200);
  }
});

test('format3 rejects unknown fields, authority payloads and malformed exact-reference relationships before storage', async () => {
  const value = contentSnapshotFixture(),
    first = value.planReferences[0]!;
  const invalid: unknown[] = [
    { ...value, conversation: ['private text'] },
    { ...value, credentials: 'private token' },
    { ...value, scopeApproval: { historyIncluded: true } },
    { ...value, schemaVersion: 4 },
    { ...value, schemaVersion: '3' },
    { ...value, planReferences: [] },
    { ...value, planReferences: [first, first] },
    {
      ...value,
      planReferences: [{ ...first, contentRef: { ...first.contentRef, recipeId: '99999' } }],
    },
    {
      ...value,
      planReferences: [
        { ...first, contentRef: { ...first.contentRef, contentFingerprint: 'bad' } },
      ],
    },
    {
      ...value,
      planReferences: [
        { ...first, contentRef: { ...first.contentRef, url: 'https://untrusted.test/body' } },
      ],
    },
    { ...value, personal: { ...value.personal, receipts: [] } },
    { ...value, cookingHistory: { ...value.cookingHistory, epoch: 2 } },
    {
      ...value,
      cookingHistory: {
        entries: [
          {
            kind: 'exact',
            entry: { ...value.cookingHistory!.entries[0]!.entry, operationId: operation },
          },
        ],
        removedEventIds: [],
      },
    },
    {
      ...value,
      cookingHistory: {
        ...value.cookingHistory!,
        removedEventIds: [value.cookingHistory!.entries[0]!.entry.eventId],
      },
    },
  ];
  for (const payload of invalid) {
    const { handler, calls } = fixture(true, payload);
    const result = await handler(commit(payload));
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { error: 'invalid_snapshot' });
    assert.equal(calls.length, 0);
    const read = await handler(request({ action: 'read' }));
    assert.equal(read.status, 409);
    assert.deepEqual(await read.json(), { error: 'stored_data_needs_review' });
  }
});

test('format3 snapshot byte cap is independent of transport and formatted database allowances', async () => {
  const oversized = largeContentSnapshot(ACCOUNT_SNAPSHOT_MAX_BYTES + 2048);
  const bytes = Buffer.byteLength(JSON.stringify(oversized));
  assert.ok(bytes > ACCOUNT_SNAPSHOT_MAX_BYTES);
  assert.ok(bytes < ACCOUNT_SNAPSHOT_MAX_BYTES + 4096);
  const { handler, calls } = fixture(true, oversized);
  const response = await handler(commit(oversized));
  assert.equal(response.status, 400, 'request fits transport cap but exceeds snapshot cap');
  assert.deepEqual(await response.json(), { error: 'invalid_snapshot' });
  assert.equal(calls.length, 0);
  assert.equal((await handler(request({ action: 'read' }))).status, 409);
  const enormous = await handler(
    commit({
      ...contentSnapshotFixture(),
      oversized: 'x'.repeat(ACCOUNT_SNAPSHOT_MAX_BYTES + 8192),
    }),
  );
  assert.equal(enormous.status, 413);
});

test('near-boundary exact snapshot retains full references and raw values through enabled handler', async () => {
  const value = largeContentSnapshot(ACCOUNT_SNAPSHOT_MAX_BYTES - 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > ACCOUNT_SNAPSHOT_MAX_BYTES * 0.99);
  const { handler, calls } = fixture(true, value);
  assert.equal((await handler(commit(value))).status, 200);
  const expected = JSON.parse(canonicalAccountContentSnapshot(value));
  assert.deepEqual(calls[0]!.input.p_snapshot, expected);
  const response = await handler(request({ action: 'read' }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).snapshot, expected);
});

test('service codec owns data without invoking accessors and capability choice is captured at construction', async () => {
  let accessed = false;
  const value = contentSnapshotFixture();
  Object.defineProperty(value, 'profile', {
    enumerable: true,
    get() {
      accessed = true;
      return { displayName: null };
    },
  });
  assert.throws(() => parseAccountServiceSnapshot(value, true));
  assert.equal(accessed, false);
  const backend: AccountBackend = {
    async verify() {
      return { ownerId: owner, sessionId: session };
    },
    async rpc() {
      throw new Error('Disabled input must not dispatch');
    },
    async deleteUser() {},
  };
  const options = { backend, allowedOrigins: [], enableContentSnapshots: false };
  const handler = createAccountHandler(options);
  options.enableContentSnapshots = true;
  assert.equal((await handler(commit(contentSnapshotFixture()))).status, 400);
});
