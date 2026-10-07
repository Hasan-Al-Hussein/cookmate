import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountDatabaseName,
  createWorkspaceSelection,
  GUEST_DATABASE_NAME,
  parseWorkspaceManifest,
  workspaceDatabaseName,
  WORKSPACE_ACCOUNT_LIMIT,
  WORKSPACE_MANIFEST_MAX_BYTES,
  WorkspaceSelectionError,
} from './workspaceSelection';
import type {
  WorkspaceManifest,
  WorkspaceSelectionOptions,
  WorkspaceDatabaseNamingPolicy,
} from './workspaceSelection';
import { requiresWebStorageReload } from '../../data/webStorageFailure';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const reason = (expected: string) => (error: unknown) =>
  error instanceof WorkspaceSelectionError && error.reason === expected;

function fixture(naming?: WorkspaceDatabaseNamingPolicy) {
  let raw: string | null = null;
  let reads = 0;
  let writes = 0;
  let closed = true;
  let readFailure = false;
  let onWrite: ((value: string) => void) | null = null;
  let onPrepare: ((owner: string) => void) | null = null;
  let onRemove: ((owner: string) => void) | null = null;
  const guest = ['original guest recipe'];
  const files = new Map<string, string[]>();
  const namespaces = new Map<string, string>();
  const prepares: { owner: string; copyGuest: boolean }[] = [];
  const removes: string[] = [];
  const options: WorkspaceSelectionOptions = {
    ...(naming ? { naming } : {}),
    storage: {
      read: async () => {
        reads++;
        if (readFailure) throw new Error('storage read unavailable');
        return raw;
      },
      write: async (value) => {
        writes++;
        if (onWrite) onWrite(value);
        else raw = value;
      },
    },
    databases: {
      prepare: async (owner, copyGuest) => {
        assert.equal(closed, true);
        assert.equal(parseWorkspaceManifest(raw!, naming).pending?.ownerId, owner);
        prepares.push({ owner, copyGuest });
        onPrepare?.(owner);
        // Models the native adapter's destination transaction/owner marker: never recopy ready data.
        if (!files.has(owner)) files.set(owner, copyGuest ? [...guest] : []);
      },
      remove: async (owner) => {
        assert.equal(closed, true);
        const durable = parseWorkspaceManifest(raw!, naming);
        assert.deepEqual(durable.pending, { kind: 'remove', ownerId: owner });
        assert.deepEqual(durable.active, { kind: 'account', ownerId: owner });
        removes.push(owner);
        files.delete(owner);
        onRemove?.(owner);
        namespaces.delete(owner);
      },
    },
    assertClosed: () => {
      if (!closed) throw new Error('provider is open');
    },
  };
  const manager = createWorkspaceSelection(options);
  return {
    manager,
    options,
    guest,
    files,
    namespaces,
    prepares,
    removes,
    reopen: () => createWorkspaceSelection(options),
    get raw() {
      return raw;
    },
    setRaw(value: string | null) {
      raw = value;
    },
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    setClosed(value: boolean) {
      closed = value;
    },
    failReads(value: boolean) {
      readFailure = value;
    },
    writeHook(value: typeof onWrite) {
      onWrite = value;
    },
    prepareHook(value: typeof onPrepare) {
      onPrepare = value;
    },
    removeHook(value: typeof onRemove) {
      onRemove = value;
    },
  };
}

test('pending workspace preparation preserves the browser reload cause and untouched guest', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.prepareHook(() => {
    throw new Error('Invalid VFS state');
  });
  await assert.rejects(
    f.manager.activate(A),
    (error) => reason('prepare_failed')(error) && requiresWebStorageReload(error),
  );
  assert.equal(f.manager.getSnapshot().status, 'pending');
  assert.deepEqual(f.guest, ['original guest recipe']);
  assert.equal(f.files.size, 0);
});

test('construction does no I/O; initialization creates the original guest manifest only', async () => {
  const f = fixture();
  assert.equal(f.reads, 0);
  assert.equal(f.writes, 0);
  assert.equal(f.manager.getSnapshot().status, 'uninitialized');
  const initial = await f.manager.initialize();
  assert.equal(initial.status, 'ready');
  assert.equal(initial.databaseName, GUEST_DATABASE_NAME);
  assert.equal(initial.manifest?.guestClaim, null);
  assert.equal(
    f.raw,
    '{"format":"cookmate-workspaces","schemaVersion":1,"revision":0,"guestDatabase":"cookmate.db","guestClaim":null,"accountOwners":[],"active":{"kind":"guest"},"pending":null}',
  );
  assert.deepEqual(f.prepares, []);
  assert.deepEqual(f.removes, []);
  assert.equal(f.writes, 1);
  await f.manager.initialize();
  assert.equal(f.writes, 1);
  assert.ok(Object.isFrozen(initial.manifest));
});

test('first account clones untouched guest; B starts empty and returning to A reuses its own copy', async () => {
  const f = fixture();
  await f.manager.initialize();
  const a = await f.manager.activate(A);
  assert.equal(a.databaseName, accountDatabaseName(A));
  assert.deepEqual(f.files.get(A), f.guest);
  f.files.get(A)!.push('A private work');
  const b = await f.manager.activate(B);
  assert.equal(b.databaseName, accountDatabaseName(B));
  assert.deepEqual(f.files.get(B), []);
  assert.deepEqual(f.prepares, [
    { owner: A, copyGuest: true },
    { owner: B, copyGuest: false },
  ]);
  await f.manager.activate(A);
  assert.equal(f.prepares.length, 2);
  assert.deepEqual(f.files.get(A), ['original guest recipe', 'A private work']);
  const guest = await f.manager.activateGuest();
  assert.equal(guest.databaseName, GUEST_DATABASE_NAME);
  assert.deepEqual(f.guest, ['original guest recipe']);
  assert.equal(guest.manifest?.guestClaim, A);
  assert.equal(f.files.size, 2);
});

test('sign-out Keep retains the active owner local copy without an auth claim or extra write', async () => {
  const f = fixture();
  await f.manager.initialize();
  await f.manager.activate(A);
  const writes = f.writes;
  const kept = await f.manager.keepLocalCopy(A);
  assert.deepEqual(kept.manifest?.active, { kind: 'account', ownerId: A });
  assert.equal(f.writes, writes);
  assert.equal(f.files.has(A), true);
  assert.deepEqual(f.removes, []);
  await assert.rejects(f.manager.keepLocalCopy(B), reason('workspace_changed'));
});

test('open-provider barrier blocks activation and removal before any destructive or persisted action', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.setClosed(false);
  const original = f.raw;
  await assert.rejects(f.manager.activate(A), reason('workspace_open'));
  assert.equal(f.raw, original);
  assert.equal(f.prepares.length, 0);
  f.setClosed(true);
  await f.manager.activate(A);
  f.setClosed(false);
  await assert.rejects(f.manager.removeLocalCopy(A), reason('workspace_open'));
  await assert.rejects(f.manager.activateGuest(), reason('workspace_open'));
  assert.equal(f.files.has(A), true);
  assert.equal(f.removes.length, 0);
});

test('failed clone keeps durable activation intent, exposes no openable filename and resumes explicitly after restart', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.prepareHook(() => {
    throw new Error('clone failed');
  });
  await assert.rejects(f.manager.activate(A), reason('prepare_failed'));
  assert.equal(f.manager.getSnapshot().status, 'pending');
  assert.equal(f.manager.getSnapshot().databaseName, null);
  assert.equal(f.manager.getSnapshot().manifest?.guestClaim, A);
  const reopened = f.reopen();
  const initial = await reopened.initialize();
  assert.equal(initial.status, 'pending');
  assert.equal(f.prepares.length, 1);
  f.prepareHook(null);
  const restored = await reopened.recoverPending();
  assert.equal(restored.status, 'ready');
  assert.equal(restored.databaseName, accountDatabaseName(A));
  assert.deepEqual(f.files.get(A), f.guest);
});

test('clone finalization failure retries the marker-protected destination without overwriting prepared data', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.writeHook((value) => {
    const next = parseWorkspaceManifest(value);
    if (next.active.kind === 'account' && next.pending === null)
      throw new Error('final write failed');
    f.setRaw(value);
  });
  await assert.rejects(f.manager.activate(A), reason('storage_write_failed'));
  assert.equal(f.manager.getSnapshot().status, 'pending');
  f.files.get(A)!.push('surviving prepared content');
  f.writeHook(null);
  const reopened = f.reopen();
  await reopened.initialize();
  await reopened.recoverPending();
  assert.deepEqual(f.files.get(A), ['original guest recipe', 'surviving prepared content']);
  assert.equal(f.prepares.length, 2);
  assert.deepEqual(f.guest, ['original guest recipe']);
});

test('removal switches to guest only after both owner database and namespaces are removed', async () => {
  const f = fixture();
  await f.manager.initialize();
  await f.manager.activate(A);
  await f.manager.activate(B);
  f.namespaces.set(A, 'A preferences');
  f.namespaces.set(B, 'B draft');
  f.removeHook(() => {
    throw new Error('namespace cleanup failed');
  });
  await assert.rejects(f.manager.removeLocalCopy(B), reason('removal_failed'));
  assert.equal(f.files.has(B), false);
  assert.equal(f.namespaces.get(B), 'B draft');
  assert.equal(f.manager.getSnapshot().status, 'pending');
  assert.equal(f.manager.getSnapshot().databaseName, null);
  assert.deepEqual(f.manager.getSnapshot().manifest?.active, { kind: 'account', ownerId: B });
  assert.equal(f.files.has(A), true);
  assert.equal(f.namespaces.get(A), 'A preferences');
  f.removeHook(null);
  const reopened = f.reopen();
  await reopened.initialize();
  const removed = await reopened.recoverPending();
  assert.equal(removed.databaseName, GUEST_DATABASE_NAME);
  assert.deepEqual(removed.manifest?.accountOwners, [A]);
  assert.equal(f.namespaces.has(B), false);
  assert.deepEqual(f.removes, [B, B]);
  assert.deepEqual(f.guest, ['original guest recipe']);
});

test('removal finalization failure survives restart and never targets guest or another account', async () => {
  const f = fixture();
  await f.manager.initialize();
  await f.manager.activate(A);
  f.writeHook((value) => {
    const next = parseWorkspaceManifest(value);
    if (next.pending === null) throw new Error('manifest finalization failed');
    f.setRaw(value);
  });
  await assert.rejects(f.manager.removeLocalCopy(A), reason('storage_write_failed'));
  assert.equal(f.files.has(A), false);
  assert.equal(f.manager.getSnapshot().status, 'pending');
  f.writeHook(null);
  const reopened = f.reopen();
  await reopened.initialize();
  await reopened.removeLocalCopy(A);
  assert.deepEqual(f.removes, [A, A]);
  assert.equal(reopened.getSnapshot().databaseName, GUEST_DATABASE_NAME);
  assert.equal(reopened.getSnapshot().manifest?.guestClaim, A);
});

test('write readback confirms lost acknowledgements for activation and removal', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.writeHook((value) => {
    f.setRaw(value);
    throw new Error('acknowledgement lost');
  });
  assert.equal((await f.manager.activate(A)).status, 'ready');
  assert.equal((await f.manager.removeLocalCopy(A)).databaseName, GUEST_DATABASE_NAME);
  assert.deepEqual(f.prepares, [{ owner: A, copyGuest: true }]);
  assert.deepEqual(f.removes, [A]);
});

test('unpersisted intent cannot authorize database preparation or deletion, including silent dropped writes', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.writeHook(() => {});
  await assert.rejects(f.manager.activate(A), reason('storage_write_failed'));
  assert.equal(f.prepares.length, 0);
  assert.equal(f.manager.getSnapshot().manifest?.guestClaim, null);
  f.writeHook(null);
  await f.manager.activate(A);
  f.writeHook(() => {
    throw new Error('write rejected');
  });
  await assert.rejects(f.manager.removeLocalCopy(A), reason('storage_write_failed'));
  assert.equal(f.removes.length, 0);
  assert.equal(f.files.has(A), true);
});

test('read failures and malformed existing manifests never reset to a fresh guest', async () => {
  const f = fixture();
  f.failReads(true);
  await assert.rejects(f.manager.initialize(), reason('storage_unavailable'));
  assert.equal(f.writes, 0);
  assert.equal(f.manager.getSnapshot().status, 'unavailable');
  f.failReads(false);
  f.setRaw('{broken');
  await assert.rejects(f.manager.initialize(), reason('invalid_manifest'));
  assert.equal(f.raw, '{broken');
  assert.equal(f.writes, 0);
  await assert.rejects(f.manager.activate(A), reason('not_initialized'));
});

test('unavailable readback fails closed and a subsequent initialize recovers the durable intent', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.writeHook((value) => {
    f.setRaw(value);
    f.failReads(true);
  });
  await assert.rejects(f.manager.activate(A), reason('storage_unavailable'));
  assert.equal(f.manager.getSnapshot().status, 'unavailable');
  assert.equal(f.prepares.length, 0);
  f.failReads(false);
  f.writeHook(null);
  const reopened = f.reopen();
  assert.equal((await reopened.initialize()).status, 'pending');
  await reopened.recoverPending();
  assert.deepEqual(f.files.get(A), f.guest);
});

test('changed persisted manifest invalidates cached selection before any owner deletion', async () => {
  const f = fixture();
  await f.manager.initialize();
  await f.manager.activate(A);
  await f.manager.activate(B);
  const changed = { ...parseWorkspaceManifest(f.raw!), active: { kind: 'account', ownerId: A } };
  f.setRaw(JSON.stringify(changed));
  await assert.rejects(f.manager.removeLocalCopy(B), reason('manifest_changed'));
  assert.equal(f.manager.getSnapshot().status, 'unavailable');
  assert.deepEqual(f.removes, []);
  assert.equal(f.files.size, 2);
});

test('queued activations serialize and an old removal choice cannot delete a newly active account', async () => {
  const f = fixture();
  await f.manager.initialize();
  await Promise.all([f.manager.activate(A), f.manager.activate(B)]);
  assert.deepEqual(f.prepares, [
    { owner: A, copyGuest: true },
    { owner: B, copyGuest: false },
  ]);
  await f.manager.activate(A);
  const activating = f.manager.activate(B);
  const removing = f.manager.removeLocalCopy(A);
  await activating;
  await assert.rejects(removing, reason('workspace_changed'));
  assert.deepEqual(f.removes, []);
  assert.equal(f.files.size, 2);
});

test('pending activation cannot be replaced by another account, guest switch, Keep or Remove', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.prepareHook(() => {
    throw new Error('pending clone');
  });
  await assert.rejects(f.manager.activate(A), reason('prepare_failed'));
  const raw = f.raw;
  await assert.rejects(f.manager.activate(B), reason('pending_change'));
  await assert.rejects(f.manager.activateGuest(), reason('pending_change'));
  await assert.rejects(f.manager.keepLocalCopy(A), reason('pending_change'));
  await assert.rejects(f.manager.removeLocalCopy(A), reason('pending_change'));
  assert.equal(f.raw, raw);
  assert.deepEqual(f.removes, []);
});

test('guestClaim survives removal and neither re-created A nor new B receives the guest again', async () => {
  const f = fixture();
  await f.manager.initialize();
  await f.manager.activate(A);
  await f.manager.removeLocalCopy(A);
  assert.equal(f.manager.getSnapshot().manifest?.guestClaim, A);
  await f.manager.activate(A);
  assert.deepEqual(f.files.get(A), []);
  await f.manager.activate(B);
  assert.deepEqual(f.files.get(B), []);
  assert.deepEqual(f.prepares, [
    { owner: A, copyGuest: true },
    { owner: A, copyGuest: false },
    { owner: B, copyGuest: false },
  ]);
});

test('strict manifest and owner validation rejects extra fields, arbitrary paths, invalid relationships and unknown versions', async () => {
  const f = fixture();
  await f.manager.initialize();
  const valid = parseWorkspaceManifest(f.raw!);
  for (const bad of [
    { ...valid, secret: 'not allowed' },
    { ...valid, guestDatabase: '../other.db' },
    { ...valid, active: { kind: 'guest', ownerId: A } },
    { ...valid, active: { kind: 'account', ownerId: A } },
    { ...valid, accountOwners: [A, A] },
    { ...valid, guestClaim: A, pending: { kind: 'remove', ownerId: A } },
    { ...valid, guestClaim: A, pending: { kind: 'activate', ownerId: B, copyGuest: true } },
  ])
    assert.throws(() => parseWorkspaceManifest(JSON.stringify(bad)), reason('invalid_manifest'));
  assert.throws(
    () => parseWorkspaceManifest(JSON.stringify({ ...valid, schemaVersion: 2 })),
    reason('unsupported_manifest'),
  );
  assert.throws(
    () => parseWorkspaceManifest(' '.repeat(WORKSPACE_MANIFEST_MAX_BYTES + 1)),
    reason('manifest_too_large'),
  );
  for (const invalid of [
    '../../cookmate',
    A.toUpperCase(),
    A + '\n',
    A + '\r\n',
    'guest',
    '00000000-0000-0000-0000-000000000000',
  ]) {
    assert.throws(() => accountDatabaseName(invalid), reason('invalid_owner'));
    await assert.rejects(f.manager.activate(invalid), reason('invalid_owner'));
  }
  assert.equal(f.prepares.length, 0);
});

test('account limit and revision exhaustion fail before staging an unrecoverable intent', async () => {
  const f = fixture();
  await f.manager.initialize();
  const initial = parseWorkspaceManifest(f.raw!);
  const owners = Array.from(
    { length: WORKSPACE_ACCOUNT_LIMIT },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );
  f.setRaw(JSON.stringify({ ...initial, guestClaim: owners[0], accountOwners: owners }));
  await f.manager.initialize();
  await assert.rejects(f.manager.activate(A), reason('account_limit'));
  assert.equal(f.prepares.length, 0);
  const nearLimit: WorkspaceManifest = { ...initial, revision: Number.MAX_SAFE_INTEGER - 1 };
  f.setRaw(JSON.stringify(nearLimit));
  await f.manager.initialize();
  await assert.rejects(f.manager.activate(A), reason('revision_exhausted'));
  assert.deepEqual(parseWorkspaceManifest(f.raw!), nearLimit);
  assert.throws(
    () =>
      parseWorkspaceManifest(
        JSON.stringify({
          ...nearLimit,
          revision: Number.MAX_SAFE_INTEGER,
          guestClaim: A,
          pending: { kind: 'activate', ownerId: A, copyGuest: true },
        }),
      ),
    reason('invalid_manifest'),
  );
});

test('unexpected readback contents are not accepted as success and never trigger database preparation', async () => {
  const f = fixture();
  await f.manager.initialize();
  f.writeHook((value) => {
    const candidate = parseWorkspaceManifest(value);
    f.setRaw(JSON.stringify({ ...candidate, revision: candidate.revision + 1 }));
  });
  await assert.rejects(f.manager.activate(C), reason('manifest_changed'));
  assert.equal(f.manager.getSnapshot().status, 'unavailable');
  assert.equal(f.prepares.length, 0);
});

const installation = '11111111-1111-4111-8111-111111111111';
function configuredNaming(id = installation): WorkspaceDatabaseNamingPolicy {
  return {
    guestDatabase: `cookmate-review-${id}-cooking.db`,
    accountDatabaseName: (owner) => `cookmate-review-${id}-account-${owner}.db`,
  };
}

test('trusted installation naming preserves original schema and selection while old parser refuses the alternate namespace', async () => {
  const naming = configuredNaming(),
    f = fixture(naming);
  const guest = await f.manager.initialize();
  assert.equal(guest.databaseName, naming.guestDatabase);
  assert.equal(guest.manifest?.schemaVersion, 1);
  assert.equal(guest.manifest?.guestDatabase, naming.guestDatabase);
  assert.throws(() => parseWorkspaceManifest(f.raw!), reason('invalid_manifest'));
  assert.equal(parseWorkspaceManifest(f.raw!, naming).guestDatabase, naming.guestDatabase);
  const account = await f.manager.activate(A);
  assert.equal(account.databaseName, naming.accountDatabaseName(A));
  assert.equal(
    workspaceDatabaseName({ kind: 'account', ownerId: A }, naming),
    account.databaseName,
  );
  assert.deepEqual(f.files.get(A), f.guest);
  assert.equal((await f.reopen().initialize()).databaseName, account.databaseName);
  assert.equal((await f.manager.activateGuest()).databaseName, naming.guestDatabase);
  assert.equal(accountDatabaseName(A), `cookmate-account-${A}.db`);
  assert.equal(workspaceDatabaseName({ kind: 'guest' }), GUEST_DATABASE_NAME);
});

test('alternate naming retains pending activation/removal and permanent guest claim across restart', async () => {
  const naming = configuredNaming(),
    f = fixture(naming);
  await f.manager.initialize();
  f.prepareHook(() => {
    throw new Error('interrupted preparation');
  });
  await assert.rejects(f.manager.activate(A), reason('prepare_failed'));
  const pending = f.reopen();
  assert.equal((await pending.initialize()).status, 'pending');
  f.prepareHook(null);
  assert.equal((await pending.recoverPending()).databaseName, naming.accountDatabaseName(A));
  f.removeHook(() => {
    throw new Error('interrupted removal');
  });
  await assert.rejects(pending.removeLocalCopy(A), reason('removal_failed'));
  const removing = f.reopen();
  assert.equal((await removing.initialize()).status, 'pending');
  f.removeHook(null);
  const result = await removing.recoverPending();
  assert.equal(result.databaseName, naming.guestDatabase);
  assert.equal(result.manifest?.guestClaim, A);
  await removing.activate(A);
  await removing.activate(B);
  assert.deepEqual(f.prepares, [
    { owner: A, copyGuest: true },
    { owner: A, copyGuest: true },
    { owner: A, copyGuest: false },
    { owner: B, copyGuest: false },
  ]);
  assert.deepEqual(f.files.get(A), []);
  assert.deepEqual(f.files.get(B), []);
  assert.deepEqual(f.guest, ['original guest recipe']);
});

test('a different installation or legacy manifest is rejected before writes or preparation', async () => {
  const a = fixture(configuredNaming());
  await a.manager.initialize();
  const b = fixture(configuredNaming('22222222-2222-4222-8222-222222222222'));
  b.setRaw(a.raw);
  await assert.rejects(b.manager.initialize(), reason('invalid_manifest'));
  assert.equal(b.writes, 0);
  assert.equal(b.manager.getSnapshot().status, 'unavailable');
  assert.deepEqual(b.prepares, []);
  const legacy = fixture();
  await legacy.manager.initialize();
  a.setRaw(legacy.raw);
  const writes = a.writes;
  await assert.rejects(a.manager.initialize(), reason('invalid_manifest'));
  assert.equal(a.writes, writes);
  assert.deepEqual(a.prepares, []);
});

test('captured naming and adapter methods cannot be replaced through caller options while initialization awaits', async () => {
  let raw: string | null = null,
    release!: () => void,
    closed = true;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prepared: string[] = [],
    names: string[] = [];
  const naming = {
    guestDatabase: configuredNaming().guestDatabase,
    accountDatabaseName(owner: string) {
      names.push(owner);
      return `cookmate-review-${installation}-account-${owner}.db`;
    },
  };
  const options: WorkspaceSelectionOptions = {
    naming,
    storage: {
      read: async () => {
        await gate;
        return raw;
      },
      write: async (value) => {
        raw = value;
      },
    },
    databases: {
      prepare: async (owner) => {
        prepared.push(owner);
      },
      remove: async () => {},
    },
    assertClosed: () => {
      if (!closed) throw new Error('open');
    },
  };
  const manager = createWorkspaceSelection(options),
    initializing = manager.initialize();
  naming.guestDatabase = 'changed.db';
  naming.accountDatabaseName = () => {
    throw new Error('mutated resolver');
  };
  options.storage.read = async () => {
    throw new Error('mutated read');
  };
  options.storage.write = async () => {
    throw new Error('mutated write');
  };
  options.databases.prepare = async () => {
    throw new Error('mutated prepare');
  };
  options.assertClosed = () => {
    throw new Error('mutated barrier');
  };
  release();
  assert.equal((await initializing).databaseName, configuredNaming().guestDatabase);
  assert.equal((await manager.activate(A)).databaseName, configuredNaming().accountDatabaseName(A));
  assert.deepEqual(prepared, [A]);
  assert.ok(names.every((owner) => owner === A));
  closed = false;
  await assert.rejects(manager.activateGuest(), reason('workspace_open'));
});

test('custom resolver only sees valid owners; invalid/colliding names cannot authorize database preparation', async () => {
  const seen: string[] = [],
    naming = {
      guestDatabase: 'isolated-guest.db',
      accountDatabaseName: (owner: string) => {
        seen.push(owner);
        return 'one-account.db';
      },
    },
    f = fixture(naming);
  await f.manager.initialize();
  await assert.rejects(f.manager.activate('../owner'), reason('invalid_owner'));
  assert.deepEqual(seen, []);
  await f.manager.activate(A);
  const original = f.raw,
    prepares = f.prepares.length;
  await assert.rejects(f.manager.activate(B), reason('invalid_manifest'));
  assert.equal(f.raw, original);
  assert.equal(f.prepares.length, prepares);
  for (const name of [
    '../other.db',
    '/absolute.db',
    'bad\\path.db',
    'not-a-database',
    'trailing.db\n',
    'x'.repeat(256) + '.db',
    'isolated-guest.db',
    'bad\u0000.db',
  ]) {
    const invalid = fixture({
      guestDatabase: 'isolated-guest.db',
      accountDatabaseName: () => name,
    });
    await invalid.manager.initialize();
    await assert.rejects(invalid.manager.activate(A), reason('invalid_manifest'));
    assert.equal(invalid.writes, 1);
    assert.deepEqual(invalid.prepares, []);
  }
});

test('alternate names keep exact readback proof and closed barrier before any preparation', async () => {
  const naming = configuredNaming(),
    f = fixture(naming);
  await f.manager.initialize();
  f.setClosed(false);
  await assert.rejects(f.manager.activate(A), reason('workspace_open'));
  assert.deepEqual(f.prepares, []);
  f.setClosed(true);
  f.writeHook((value) => {
    f.setRaw(value);
    throw new Error('lost acknowledgement');
  });
  assert.equal((await f.manager.activate(A)).databaseName, naming.accountDatabaseName(A));
  assert.deepEqual(f.prepares, [{ owner: A, copyGuest: true }]);
  assert.equal((await f.manager.removeLocalCopy(A)).databaseName, naming.guestDatabase);
  assert.equal(parseWorkspaceManifest(f.raw!, naming).guestClaim, A);
});
