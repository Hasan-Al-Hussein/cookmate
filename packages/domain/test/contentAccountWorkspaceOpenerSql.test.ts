import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { catalogue } from '@cookmate/catalogue';
import { createBundledContentSnapshot } from '@cookmate/catalogue/content';
import type { AccountReplicationScope } from '@cookmate/account-sync';
import type { LocalWorkspace } from '../../../apps/mobile/src/features/account/workspaceSelection';
import {
  createContentAccountWorkspaceOpener,
  type ContentAccountWorkspaceHandle,
  type ContentAccountWorkspaceOpenerOptions,
} from '../../../apps/mobile/src/features/content/contentAccountWorkspaceOpener';
import { createContentAccountSelection } from '../../../apps/mobile/src/features/content/contentAccountSelection';
import {
  createContentAccountWorkspaceAdapter,
  type ContentAccountWorkspacePorts,
} from '../../../apps/mobile/src/features/content/contentAccountWorkspaces';
import {
  createPrivateContentController,
  type PrivateContentOpeningLease,
} from '../../../apps/mobile/src/features/content/privateContentController';
import { preparePrivateContentWorkspace } from '../../../apps/mobile/src/features/content/preparePrivateContentWorkspace';
import { PrivateContentCleanupError } from '../../../apps/mobile/src/features/content/privateContentRuntime';
import {
  privateContentAccountDatabaseName,
  privateContentDatabaseNames,
  readPrivateContentConfiguration,
} from '../../../apps/mobile/src/features/content/privateContentConfig';
import type { SqlConnection } from '../../../apps/mobile/src/data/sql';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const baselinePromise = createBundledContentSnapshot(sha256);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real disposable schema8 databases and existing lifecycle owners. Network and publication
 * verification are unavailable; the installed packaged catalogue is the only recipe source.
 */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-account-opener-'));
  const config = readPrivateContentConfiguration(
    JSON.stringify({
      version: 1,
      origin: 'http://localhost:19093',
      installationId: randomUUID(),
      releaseId: 'test-release',
      trustKeys: [{ keyId: 'test', publicKeyHex: '1'.repeat(64) }],
    }),
    'http://localhost:19093',
  )!;
  const names = privateContentDatabaseNames(config.installationId);
  const accountName = (id: string) => privateContentAccountDatabaseName(config.installationId, id);
  const allowed = new Set([names.cooking, names.content, accountName(owner), accountName(other)]);
  const live = new Set<SqlConnection>();
  let opens = 0,
    failClose = false;
  async function openConnection(name: string): Promise<SqlConnection> {
    assert.ok(allowed.has(name));
    opens++;
    const raw = desktopConnection(join(directory, name)).connection;
    let closed = false;
    const connection: SqlConnection = {
      all: raw.all.bind(raw),
      exec: raw.exec.bind(raw),
      prepare: raw.prepare.bind(raw),
      async close() {
        if (!closed) {
          await raw.close();
          closed = true;
          live.delete(connection);
        }
        if (failClose) throw new Error('Controlled close acknowledgement loss');
      },
    };
    live.add(connection);
    return connection;
  }
  const databases: Omit<ContentAccountWorkspacePorts, 'assertClosed'> = {
    config,
    platform: { newId: randomUUID, sha256 },
    openConnection,
    assertGuestRecoverySettled: async () => undefined,
    async cloneGuestWithMarker(sourceName, destinationName, marker) {
      assert.equal(sourceName, names.cooking);
      assert.ok(allowed.has(destinationName));
      const source = desktopConnection(join(directory, sourceName));
      const stagingPath = join(directory, `staging-${randomUUID()}.db`);
      try {
        await backup(source.database, stagingPath);
      } finally {
        await source.connection.close();
      }
      const staging = desktopConnection(stagingPath);
      try {
        staging.database
          .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
          .run(marker.key, marker.value);
        await backup(staging.database, join(directory, destinationName));
      } finally {
        await staging.connection.close();
        await unlink(stagingPath);
      }
    },
    deleteDatabase: async (name) => {
      assert.ok(allowed.has(name));
      await unlink(join(directory, name));
    },
    copyGuestPrivateState: async () => undefined,
    removePrivateState: async () => undefined,
  };
  let opener!: ReturnType<typeof createContentAccountWorkspaceOpener>;
  let lastLease: PrivateContentOpeningLease | undefined;
  const controller = createPrivateContentController({
    prepare: () => preparePrivateContentWorkspace(databases),
    open: (lease) => {
      lastLease = lease;
      return opener.openDuringLease(lease);
    },
  });
  await controller.prepare();
  let manifest: string | null = null;
  const selection = createContentAccountSelection({
    controller,
    databases,
    storage: {
      read: async () => manifest,
      write: async (value) => {
        manifest = value;
      },
    },
  });
  await selection.initialize();
  let workspace: LocalWorkspace = { kind: 'guest' },
    generation = 1;
  let scope: AccountReplicationScope | null = null;
  const listeners = new Set<() => void>();
  let verificationGate: ReturnType<typeof deferred> | undefined;
  let verificationEntered: ReturnType<typeof deferred> | undefined;
  let stopFailure = false;
  const baseline = await baselinePromise;
  const mediaFiles = new Map(
    baseline.revisions.flatMap((value) =>
      value.document.media.map(
        (media) =>
          [
            media.sha256,
            new URL(`../../catalogue/assets/photos/${value.ref.recipeId}.jpg`, import.meta.url),
          ] as const,
      ),
    ),
  );
  const journalOwners: Array<string | null> = [];
  const options: ContentAccountWorkspaceOpenerOptions = {
    ...databases,
    controller,
    selection,
    catalogue: catalogue.identity,
    selectionAccess: () => ({ workspace, workspaceGeneration: generation }),
    subscribeAccess(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (stopFailure) throw new Error('Controlled subscription cleanup loss');
      };
    },
    verifyPreparedInClosedLease: (id, assertClosed) =>
      createContentAccountWorkspaceAdapter({ ...databases, assertClosed }).verify(id),
    journal(id) {
      journalOwners.push(id);
      return {
        read: async () => null,
        save: async () => {
          throw new Error('No publication');
        },
        clear: async () => undefined,
      };
    },
    getLocalSettings: () => ({
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    }),
    now: () => '2026-10-02T12:00:00.000Z',
    dateContext: () => ({ localDate: '2026-10-02', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    fetch: async () => {
      throw new Error('No external network');
    },
    async verification() {
      verificationEntered?.resolve();
      if (verificationGate) await verificationGate.promise;
      return {
        baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
        readerVersion: 1,
        sha256,
        sha256Bytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
        trustVerifier: { verify: async () => false },
        async inspectImage(bytes) {
          const image = sharp(bytes);
          try {
            const value = await image.metadata();
            return value.width && value.height && value.format === 'jpeg'
              ? { width: value.width, height: value.height, mimeType: 'image/jpeg' as const }
              : null;
          } finally {
            image.destroy();
          }
        },
        async readBundledMedia(media) {
          const file = mediaFiles.get(media.sha256);
          return file ? readFile(file) : null;
        },
      };
    },
  };
  opener = createContentAccountWorkspaceOpener(options);
  const handles: ContentAccountWorkspaceHandle[] = [];
  t.after(async () => {
    failClose = false;
    stopFailure = false;
    for (const handle of handles) await handle.close().catch(() => undefined);
    for (const connection of live) await connection.close();
    await removeFixtureDirectory(directory);
  });
  function notify() {
    for (const listener of [...listeners]) listener();
  }
  async function open(input = workspace) {
    const result = await opener.open(input, () => scope);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') throw new Error('Expected prepared fixture');
    handles.push(result.services);
    return result.services;
  }
  async function select(id: string | null, authenticated = true) {
    if (id) await selection.activateAccount(id);
    else await selection.activateGuest();
    workspace = id ? { kind: 'account', ownerId: id } : { kind: 'guest' };
    generation++;
    scope = id && authenticated ? { ownerId: id, authGeneration: generation } : null;
    notify();
  }
  async function inspect<Value>(
    name: string,
    work: (db: ReturnType<typeof desktopConnection>['database']) => Value,
  ) {
    const raw = desktopConnection(join(directory, name));
    try {
      return work(raw.database);
    } finally {
      await raw.connection.close();
    }
  }
  return {
    opener,
    options,
    controller,
    selection,
    open,
    select,
    inspect,
    config,
    names,
    accountName,
    journalOwners,
    currentScope: () => scope,
    get live() {
      return live.size;
    },
    get opens() {
      return opens;
    },
    get listeners() {
      return listeners.size;
    },
    get lastLease() {
      return lastLease;
    },
    changeAccess(next: AccountReplicationScope | null, changeGeneration = true) {
      scope = next;
      if (changeGeneration) generation++;
      notify();
    },
    holdVerification() {
      verificationEntered = deferred();
      verificationGate = deferred();
      return { entered: verificationEntered.promise, release: verificationGate.resolve };
    },
    failClose() {
      failClose = true;
    },
    failSubscriptionClose() {
      stopFailure = true;
    },
  };
}

async function bind(f: Awaited<ReturnType<typeof fixture>>) {
  const handle = await f.open();
  assert.equal(handle.kind, 'account_bootstrap');
  if (handle.kind !== 'account_bootstrap') throw new Error('Expected bootstrap');
  const scope = f.currentScope();
  assert.ok(scope);
  const review = await handle.services.approval.review(scope);
  await handle.services.approval.approve(scope, review, { historyIncluded: false });
  const operationId = randomUUID();
  const push = await handle.services.journal.reviewPush(scope, {
    operationId,
    remote: {
      ownerId: scope.ownerId,
      revision: 0,
      snapshot: null,
      updatedAt: null,
      deletionOperationId: null,
    },
  });
  const staged = await handle.services.journal.stageReviewedPush(scope, push, {
    initialImportReviewed: true,
  });
  assert.ok(staged.pending);
  await handle.close();
  return { operationId, staged, scope };
}

test('guest uses the existing controller, closes synchronously on selection retirement and retains original SQLite state', async (t) => {
  const f = await fixture(t);
  const before = await f.inspect(f.names.cooking, (db) =>
    JSON.stringify(db.prepare('SELECT key,value FROM app_metadata ORDER BY key').all()),
  );
  const handle = await f.open();
  assert.equal(handle.kind, 'content_workspace');
  if (handle.kind !== 'content_workspace') return;
  assert.equal(handle.access, 'guest');
  assert.equal(handle.runtime.host.account, null);
  assert.deepEqual(handle.runtime.storageScope, {
    installationId: f.config.installationId,
    ownerId: null,
  });
  await assert.rejects(f.controller.prepare(), /already in use/);
  await assert.rejects(f.open(), /Close the configured workspace/);
  f.changeAccess(null);
  assert.notEqual(handle.runtime.host.getSnapshot().status, 'ready');
  const closing = handle.close();
  assert.strictEqual(handle.close(), closing);
  await closing;
  assert.equal(f.live, 0);
  assert.equal(f.listeners, 0);
  assert.equal(
    await f.inspect(f.names.cooking, (db) =>
      JSON.stringify(db.prepare('SELECT key,value FROM app_metadata ORDER BY key').all()),
    ),
    before,
  );
  assert.deepEqual(f.journalOwners, [null]);
  await f.controller.prepare();
});

test('unbound account uses reviewed bootstrap, then authenticated and signed-out bound modes share the exact owner copy', async (t) => {
  const f = await fixture(t);
  const guestBefore = await f.inspect(f.names.cooking, (db) =>
    JSON.stringify(db.prepare('SELECT key,value FROM app_metadata ORDER BY key').all()),
  );
  await f.select(owner);
  const { operationId, staged, scope } = await bind(f);
  const handle = await f.open();
  assert.equal(handle.kind, 'content_workspace');
  if (handle.kind !== 'content_workspace') return;
  assert.equal(handle.access, 'authenticated');
  assert.ok(handle.runtime.host.account);
  assert.deepEqual(
    await handle.runtime.host.account.journal.recover(scope, {
      operationId,
      requestFingerprint: staged.pending!.requestFingerprint,
    }),
    staged,
  );
  f.changeAccess(null);
  assert.notEqual(handle.runtime.host.getSnapshot().status, 'ready');
  await handle.close();
  const local = await f.open();
  assert.equal(local.kind, 'content_workspace');
  if (local.kind !== 'content_workspace') return;
  assert.equal(local.access, 'local');
  assert.equal(local.runtime.host.account, null);
  assert.equal(local.runtime.storageScope.ownerId, owner);
  await local.close();
  assert.equal(f.live, 0);
  assert.equal(
    await f.inspect(f.names.cooking, (db) =>
      JSON.stringify(db.prepare('SELECT key,value FROM app_metadata ORDER BY key').all()),
    ),
    guestBefore,
  );
  assert.deepEqual(f.journalOwners, [owner, owner]);
});

test('an unbound signed-out copy cannot fall back to guest or invent authenticated access', async (t) => {
  const f = await fixture(t);
  await f.select(owner, false);
  await assert.rejects(f.open(), /Sign in before reviewing/);
  assert.deepEqual(f.journalOwners, []);
  assert.equal(f.live, 0);
  assert.deepEqual(await f.selection.verify(owner), { binding: null });
});

test('bootstrap keeps the controller lease until close and retires its captured services on auth loss', async (t) => {
  const f = await fixture(t);
  await f.select(owner);
  const handle = await f.open();
  assert.equal(handle.kind, 'account_bootstrap');
  if (handle.kind !== 'account_bootstrap') return;
  await assert.rejects(f.controller.prepare(), /already in use/);
  await assert.rejects(f.selection.activateGuest(), /already in use/);
  f.changeAccess(null);
  await assert.rejects(handle.services.capture());
  await handle.close();
  assert.equal(f.live, 0);
  assert.equal(f.listeners, 0);
  assert.deepEqual(await f.selection.verify(owner), { binding: null });
});

test('mismatched owner and accessor-bearing workspace fail before any SQLite opening', async (t) => {
  const f = await fixture(t);
  const count = f.opens;
  await assert.rejects(
    f.opener.open({ kind: 'account', ownerId: owner }, () => ({
      ownerId: other,
      authGeneration: 1,
    })),
    /does not match/,
  );
  let invoked = false;
  await assert.rejects(
    f.opener.open(
      {
        kind: 'account',
        get ownerId() {
          invoked = true;
          return owner;
        },
      },
      () => null,
    ),
    /Invalid configured workspace/,
  );
  assert.equal(invoked, false);
  assert.equal(f.opens, count);
});

test('selection loss during guest opening closes every acquired handle before rejecting publication', async (t) => {
  const f = await fixture(t);
  const gate = f.holdVerification();
  const opening = f.open();
  await gate.entered;
  f.changeAccess(null);
  gate.release();
  await assert.rejects(opening, /access changed/);
  assert.equal(f.live, 0);
  assert.equal(f.listeners, 0);
  await f.controller.prepare();
});

test('same-owner auth generation change during bound opening cannot publish stale services', async (t) => {
  const f = await fixture(t);
  await f.select(owner);
  await bind(f);
  const gate = f.holdVerification();
  const opening = f.open();
  await gate.entered;
  f.changeAccess({ ownerId: owner, authGeneration: 999 }, false);
  gate.release();
  await assert.rejects(opening);
  assert.equal(f.live, 0);
  assert.equal(f.listeners, 0);
  assert.deepEqual(await f.selection.verify(owner), { binding: owner });
});

test('captured runtime ports cannot be replaced while opening is suspended', async (t) => {
  const f = await fixture(t);
  const gate = f.holdVerification();
  const opening = f.open();
  await gate.entered;
  f.options.openConnection = async () => {
    throw new Error('Mutated connection must not run');
  };
  f.options.journal = () => {
    throw new Error('Mutated journal must not run');
  };
  f.options.platform.sha256 = async () => {
    throw new Error('Mutated hash must not run');
  };
  gate.release();
  const handle = await opening;
  assert.equal(handle.kind, 'content_workspace');
  await handle.close();
  assert.equal(f.live, 0);
});

test('failed runtime cleanup blocks subsequent account and guest openings', async (t) => {
  const f = await fixture(t);
  const handle = await f.open();
  f.failClose();
  await assert.rejects(handle.close(), PrivateContentCleanupError);
  const opened = f.opens;
  await assert.rejects(f.open(), PrivateContentCleanupError);
  await assert.rejects(f.controller.prepare(), PrivateContentCleanupError);
  assert.equal(f.opens, opened);
});

test('failed access disposer still closes SQLite and remains a visible reopen barrier', async (t) => {
  const f = await fixture(t);
  const handle = await f.open();
  f.failSubscriptionClose();
  await assert.rejects(handle.close(), PrivateContentCleanupError);
  assert.equal(f.live, 0);
  assert.equal(f.listeners, 0);
  await assert.rejects(f.open(), PrivateContentCleanupError);
});

test('a retired opening lease cannot be replayed without an issued workspace request', async (t) => {
  const f = await fixture(t);
  const handle = await f.open();
  await handle.close();
  assert.ok(f.lastLease);
  const count = f.opens;
  await assert.rejects(f.opener.openDuringLease(f.lastLease), /No issued/);
  await assert.rejects(f.controller.open(), /No issued/);
  assert.equal(f.opens, count);
  assert.equal(f.live, 0);
});
