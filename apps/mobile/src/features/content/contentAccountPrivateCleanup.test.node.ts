import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentPrivateState } from './contentPrivateState';
import { contentUpdateJournalKey, createLocalContentUpdateJournal } from './contentUpdateJournal';
import { removeContentAccountPrivateState } from './contentAccountPrivateCleanup';

const installationId = '680a0000-0000-4000-8000-000000000001';
const otherInstallationId = '680a0000-0000-4000-8000-000000000002';
const ownerId = '680b0000-0000-4000-8000-000000000001';
const otherOwnerId = '680b0000-0000-4000-8000-000000000002';
const scope = { installationId, ownerId };

function storage() {
  const values = new Map<string, string>();
  const reads: string[] = [],
    removals: string[] = [];
  const port = {
    async read(key: string) {
      reads.push(key);
      return values.get(key) ?? null;
    },
    async write(key: string, value: string) {
      values.set(key, value);
    },
    async remove(key: string) {
      removals.push(key);
      values.delete(key);
    },
  };
  return { values, reads, removals, port };
}
function fixture() {
  const metadata = storage(),
    sessionDraft = storage();
  const state = createContentPrivateState(scope, metadata.port);
  const keys = [...state.storageKeys, contentUpdateJournalKey(installationId, ownerId)];
  for (const key of keys) metadata.values.set(key, 'owner retained record');
  sessionDraft.values.set(state.draftScopeKey, 'owner private draft');
  for (const protectedScope of [
    { installationId, ownerId: null },
    { installationId, ownerId: otherOwnerId },
    { installationId: otherInstallationId, ownerId },
  ]) {
    const protectedState = createContentPrivateState(protectedScope, metadata.port);
    for (const key of protectedState.storageKeys) metadata.values.set(key, 'protected reference');
    metadata.values.set(
      contentUpdateJournalKey(protectedScope.installationId, protectedScope.ownerId),
      'protected journal',
    );
    sessionDraft.values.set(protectedState.draftScopeKey, 'protected draft');
  }
  // Cleanup must not scan prefixes, even inside the same installation/owner namespace.
  for (const key of [
    `cookmate.content-private.${installationId}.${ownerId}:unowned`,
    `cookmate.content-account.${installationId}:cookmate.account.settings.${ownerId}`,
    `cookmate.content-account.${installationId}:cookmate.account.workspace-selection`,
    `cookmate.content-account.${installationId}:cookmate.account.deletion-recovery`,
    `cookmate.account.auth-content-${installationId}`,
  ])
    metadata.values.set(key, 'protected lifecycle/settings/auth state');
  const protectedMetadata = new Map([...metadata.values].filter(([key]) => !keys.includes(key)));
  const protectedDrafts = new Map(
    [...sessionDraft.values].filter(([key]) => key !== state.draftScopeKey),
  );
  return {
    metadata,
    sessionDraft,
    state,
    keys,
    protectedMetadata,
    protectedDrafts,
    options: { metadata: metadata.port, sessionDraft: sessionDraft.port },
  };
}
function assertClean(f: ReturnType<typeof fixture>) {
  assert.deepEqual(f.metadata.values, f.protectedMetadata);
  assert.deepEqual(f.sessionDraft.values, f.protectedDrafts);
}

test('removes six reference families, local planning and recent settings, the update journal and scoped draft', async () => {
  const f = fixture();
  assert.equal(f.state.storageKeys.length, 8);
  f.metadata.values.delete(contentUpdateJournalKey(installationId, ownerId));
  const journal = createLocalContentUpdateJournal(installationId, ownerId, f.metadata.port);
  await journal.save({
    version: 1,
    kind: 'adoption',
    installationId,
    ownerId,
    operationId: '680c0000-0000-4000-8000-000000000001',
    fingerprint: 'a'.repeat(64),
  });
  f.metadata.reads.length = 0;
  await removeContentAccountPrivateState(scope, f.options);
  assertClean(f);
  assert.deepEqual(f.metadata.removals, f.keys);
  assert.deepEqual(f.metadata.reads, [...f.keys, ...f.keys]);
  assert.deepEqual(f.sessionDraft.removals, [f.state.draftScopeKey]);
  assert.deepEqual(f.sessionDraft.reads, [f.state.draftScopeKey, f.state.draftScopeKey]);
  assert.equal(await journal.read(), null);
});

test('lost removal acknowledgements are accepted only after exact absence is confirmed', async () => {
  const f = fixture();
  for (const entry of [f.metadata, f.sessionDraft]) {
    const remove = entry.port.remove;
    entry.port.remove = async (key) => {
      await remove(key);
      throw new Error('lost acknowledgement');
    };
  }
  await removeContentAccountPrivateState(scope, f.options);
  assertClean(f);
});

test('a successful acknowledgement with retained metadata fails and can be retried', async () => {
  const f = fixture();
  const remove = f.metadata.port.remove;
  f.metadata.port.remove = async (key) => {
    if (key !== f.keys[2]) await remove(key);
  };
  await assert.rejects(removeContentAccountPrivateState(scope, f.options), /not confirmed/);
  assert.equal(f.metadata.values.get(f.keys[2]!), 'owner retained record');
  f.metadata.port.remove = remove;
  await removeContentAccountPrivateState(scope, f.options);
  assertClean(f);
});

test('a rejected removal with retained data fails, preserving retry information in the owning lifecycle', async () => {
  const f = fixture();
  const remove = f.sessionDraft.port.remove;
  f.sessionDraft.port.remove = async () => {
    throw new Error('storage failed');
  };
  await assert.rejects(removeContentAccountPrivateState(scope, f.options), /not confirmed/);
  assert.equal(f.sessionDraft.values.get(f.state.draftScopeKey), 'owner private draft');
  f.sessionDraft.port.remove = remove;
  await removeContentAccountPrivateState(scope, f.options);
  assertClean(f);
});

test('an unavailable absence read cannot turn an applied deletion into reported success', async () => {
  for (const family of ['metadata', 'sessionDraft'] as const) {
    const f = fixture(),
      read = f[family].port.read;
    f[family].port.read = async () => {
      throw new Error('absence unavailable');
    };
    await assert.rejects(removeContentAccountPrivateState(scope, f.options), /absence unavailable/);
    f[family].port.read = read;
    await removeContentAccountPrivateState(scope, f.options);
    assertClean(f);
  }
});

test('the final absence pass detects an earlier key reappearing during cleanup', async () => {
  const f = fixture(),
    remove = f.sessionDraft.port.remove;
  f.sessionDraft.port.remove = async (key) => {
    await remove(key);
    f.metadata.values.set(f.keys[0]!, 'reappeared');
  };
  await assert.rejects(removeContentAccountPrivateState(scope, f.options), /not confirmed/);
  f.sessionDraft.port.remove = remove;
  await removeContentAccountPrivateState(scope, f.options);
  assertClean(f);
});

test('scope and both storage ports are captured before the first asynchronous removal', async () => {
  const f = fixture(),
    input = { ...scope },
    remove = f.metadata.port.remove;
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.metadata.port.remove = async (key) => {
    entered();
    await wait;
    await remove(key);
  };
  const result = removeContentAccountPrivateState(input, f.options);
  await started;
  input.installationId = otherInstallationId;
  input.ownerId = otherOwnerId;
  for (const entry of [f.metadata, f.sessionDraft]) {
    entry.port.read = async () => {
      throw new Error('replaced read');
    };
    entry.port.remove = async () => {
      throw new Error('replaced remove');
    };
  }
  release();
  await result;
  assertClean(f);
});

test('invalid, guest and accessor-bearing scopes fail before any storage I/O', async () => {
  const f = fixture();
  for (const invalid of [
    { installationId: '../other', ownerId },
    { installationId, ownerId: 'guest' },
    { installationId, ownerId: null },
    { ...scope, extra: 'unexpected' },
  ])
    await assert.rejects(async () =>
      Reflect.apply(removeContentAccountPrivateState, undefined, [invalid, f.options]),
    );
  let getterCalls = 0;
  await assert.rejects(
    removeContentAccountPrivateState(
      {
        installationId,
        get ownerId() {
          getterCalls++;
          return ownerId;
        },
      },
      f.options,
    ),
  );
  assert.equal(getterCalls, 0);
  assert.deepEqual(f.metadata.reads, []);
  assert.deepEqual(f.metadata.removals, []);
  assert.deepEqual(f.sessionDraft.reads, []);
  assert.deepEqual(f.sessionDraft.removals, []);
});

test('retry after completed cleanup is idempotent and preserves every other partition', async () => {
  const f = fixture();
  await removeContentAccountPrivateState(scope, f.options);
  await removeContentAccountPrivateState(scope, f.options);
  assertClean(f);
});
