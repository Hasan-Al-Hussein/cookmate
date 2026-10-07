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
import { openContentAccountBootstrap } from '../../../apps/mobile/src/features/content/openContentAccountBootstrap';
import { createContentAccountLifecycleBackend } from '../../../apps/mobile/src/features/content/contentAccountRuntimeBackend';
import { createLocalAccountSettings } from '../../../apps/mobile/src/features/account/localAccountSettings';
import {
  openPrivateContentRuntime,
  PrivateContentCleanupError,
} from '../../../apps/mobile/src/features/content/privateContentRuntime';
import type { AccountReplicationScope } from '@cookmate/account-sync';
import {
  createContentAccountWorkspaceAdapter,
  contentAccountWorkspaceNaming,
  CONTENT_ACCOUNT_MARKER_KEY,
  type ContentAccountWorkspacePorts,
} from '../../../apps/mobile/src/features/content/contentAccountWorkspaces';
import { preparePrivateContentWorkspace } from '../../../apps/mobile/src/features/content/preparePrivateContentWorkspace';
import {
  privateContentAccountDatabaseName,
  privateContentDatabaseNames,
  readPrivateContentConfiguration,
} from '../../../apps/mobile/src/features/content/privateContentConfig';
import { createWorkspaceSelection } from '../../../apps/mobile/src/features/account/workspaceSelection';
import { createContentAccountSelection } from '../../../apps/mobile/src/features/content/contentAccountSelection';
import { createPrivateContentController } from '../../../apps/mobile/src/features/content/privateContentController';
import {
  configureConnection,
  SerializedReader,
  SerializedWriter,
  SqlTransactionQueue,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { createContentManualShopping } from '../../../apps/mobile/src/data/contentManualShopping';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-workspaces-'));
  t.after(() => removeFixtureDirectory(directory));
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
  const guest = privateContentDatabaseNames(config.installationId).cooking;
  let closed = true,
    recoverySettled = true,
    lostCopy = false,
    privateFailure = false,
    closesFail = false;
  let copies = 0,
    privateCopies = 0;
  let guestCloses = 0,
    delegatedFailure = false,
    largeTransfers = 0;
  const removed: string[] = [],
    removedPrivate: string[] = [];
  const nameFor = (id: string) => privateContentAccountDatabaseName(config.installationId, id);
  async function inspect<T>(
    name: string,
    work: (db: ReturnType<typeof desktopConnection>['database']) => T,
  ) {
    const db = desktopConnection(join(directory, name));
    try {
      return work(db.database);
    } finally {
      await db.connection.close();
    }
  }
  const options: ContentAccountWorkspacePorts = {
    config,
    platform: { newId: randomUUID, sha256 },
    assertClosed() {
      if (!closed) throw new Error('Still open');
    },
    async assertGuestRecoverySettled() {
      if (!recoverySettled) throw new Error('Unresolved guest reference');
    },
    async openConnection(name) {
      assert.ok(
        name === guest ||
          name === nameFor(owner) ||
          name === nameFor(other) ||
          name === privateContentDatabaseNames(config.installationId).content,
      );
      const db = desktopConnection(join(directory, name));
      return {
        ...db.connection,
        async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
          const rows = await db.connection.all<Row>(sql, values);
          for (const row of rows)
            for (const value of Object.values(row))
              if (
                (typeof value === 'string' && value.length > 4096) ||
                (value instanceof Uint8Array && value.byteLength > 4096)
              )
                largeTransfers++;
          return rows;
        },
        async close() {
          await db.connection.close();
          if (name === guest && ++guestCloses === 2 && delegatedFailure)
            throw new Error('Delegated guest close uncertain');
          if (closesFail) throw new Error('Injected close acknowledgement');
        },
      };
    },
    async cloneGuestWithMarker(sourceName, destinationName, marker) {
      copies++;
      assert.equal(sourceName, guest);
      // Real SQLite backups; the source itself never receives the account marker.
      const source = desktopConnection(join(directory, sourceName));
      const stagingPath = join(directory, `copy-${randomUUID()}.db`);
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
      if (lostCopy) {
        lostCopy = false;
        throw new Error('Lost clone acknowledgement');
      }
    },
    async deleteDatabase(name) {
      assert.notEqual(name, guest);
      removed.push(name);
      await unlink(join(directory, name));
    },
    async copyGuestPrivateState() {
      privateCopies++;
      if (privateFailure) throw new Error('Private settings interrupted');
    },
    async removePrivateState(id) {
      removedPrivate.push(id);
    },
  };
  await preparePrivateContentWorkspace({
    config,
    platform: options.platform,
    openConnection: options.openConnection,
  });
  const db = desktopConnection(join(directory, guest)),
    read = desktopConnection(join(directory, guest));
  await configureConnection(db.connection);
  await configureConnection(read.connection);
  const queue = new SqlTransactionQueue(),
    writer = new SerializedWriter(db.connection, queue),
    reader = new SerializedReader(read.connection, queue);
  const manual = createContentManualShopping({
    reader,
    writer,
    installationId: config.installationId,
    platform: options.platform,
    now: () => '2026-10-01T12:00:00.000Z',
    getAccess: () => ({ ownerId: null, authGeneration: 1 }),
    assertAccess: () => undefined,
    onCommitted: () => undefined,
  });
  const itemId = randomUUID();
  assert.equal(
    (
      await manual.execute({
        kind: 'addManualItem',
        operationId: randomUUID(),
        expectedEpoch: 0,
        itemId,
        fields: {
          name: 'Synthetic tea bags',
          amountText: '2',
          unitText: 'packs',
          category: 'other',
        },
      })
    ).kind,
    'ready',
  );
  manual.close();
  await writer.close();
  await reader.close();
  const dump = (name: string) =>
    inspect(name, (db) => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      return JSON.stringify(
        tables.map(({ name: table }) => [
          table,
          db.prepare(`SELECT * FROM "${String(table).replaceAll('"', '""')}"`).all(),
        ]),
      );
    });
  return {
    directory,
    options,
    config,
    guest,
    nameFor,
    inspect,
    dump,
    itemId,
    removed,
    removedPrivate,
    get copies() {
      return copies;
    },
    get privateCopies() {
      return privateCopies;
    },
    setClosed(value: boolean) {
      closed = value;
    },
    setRecovery(value: boolean) {
      recoverySettled = value;
    },
    loseCopy() {
      lostCopy = true;
    },
    failPrivate(value: boolean) {
      privateFailure = value;
    },
    failClose() {
      closesFail = true;
    },
    failDelegatedClose() {
      guestCloses = 0;
      delegatedFailure = true;
    },
    get largeTransfers() {
      return largeTransfers;
    },
    resetTransfers() {
      largeTransfers = 0;
    },
  };
}

test('configured first account copies populated guest once, remains unbound, and second account starts independently', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options),
    before = await f.dump(f.guest);
  let raw: string | null = null;
  const selection = createWorkspaceSelection({
    naming: contentAccountWorkspaceNaming(f.config.installationId),
    storage: {
      read: async () => raw,
      write: async (value) => {
        raw = value;
      },
    },
    databases: adapter,
    assertClosed: f.options.assertClosed,
  });
  await selection.initialize();
  await selection.activate(owner);
  assert.deepEqual(await adapter.verify(owner), { binding: null });
  assert.equal(await f.dump(f.guest), before);
  assert.equal(
    await f.inspect(
      f.nameFor(owner),
      (db) => db.prepare('SELECT item_id FROM manual_shopping_item').get()!.item_id,
    ),
    f.itemId,
  );
  assert.equal(
    await f.inspect(
      f.nameFor(owner),
      (db) =>
        db
          .prepare("SELECT COUNT(*) count FROM app_metadata WHERE key='account-replication:owner'")
          .get()!.count,
    ),
    0,
  );
  assert.equal(f.copies, 1);
  assert.equal(f.privateCopies, 1);
  await adapter.prepare(owner, true);
  assert.equal(f.copies, 1);
  assert.equal(f.privateCopies, 1);
  await selection.activateGuest();
  await selection.activate(other);
  assert.equal(selection.getSnapshot().manifest?.guestClaim, owner);
  assert.equal(
    await f.inspect(
      f.nameFor(other),
      (db) => db.prepare('SELECT COUNT(*) count FROM manual_shopping_item').get()!.count,
    ),
    0,
  );
  assert.equal(await f.dump(f.guest), before);
  await selection.removeLocalCopy(other);
  assert.deepEqual(f.removed, [f.nameFor(other)]);
  assert.deepEqual(f.removedPrivate, [other]);
  assert.equal(selection.getSnapshot().manifest?.guestClaim, owner);
});

test('configured selection shares the actual open runtime lease and recovers an interrupted copy before another owner', async (t) => {
  const f = await fixture(t),
    original = await f.dump(f.guest);
  const baseline = await createBundledContentSnapshot(sha256);
  const controller = createPrivateContentController({
    prepare: () => preparePrivateContentWorkspace(f.options),
    open: () =>
      openPrivateContentRuntime({
        config: f.config,
        openConnection: f.options.openConnection,
        platform: f.options.platform,
        now: () => '2026-10-01T12:00:00.000Z',
        dateContext: () => ({
          localDate: '2026-10-01',
          timeZone: 'Asia/Dubai',
          utcOffsetMinutes: 240,
        }),
        verification: async () => ({
          baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
          readerVersion: 1,
          sha256,
          sha256Bytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
          trustVerifier: { verify: async () => false },
          inspectImage: async () => null,
          readBundledMedia: async () => null,
        }),
        journal: {
          read: async () => null,
          save: async () => {
            throw new Error('No publication');
          },
          clear: async () => {},
        },
        fetch: async () => {
          throw new Error('No network');
        },
      }),
  });
  let raw: string | null = null;
  const options = {
    controller,
    databases: f.options,
    storage: {
      read: async () => raw,
      write: async (value: string) => {
        raw = value;
      },
    },
  };
  const selection = createContentAccountSelection(options);
  await selection.initialize();
  const guestManifest = raw;
  const opened = await controller.open();
  assert.deepEqual(opened.storageScope, { installationId: f.config.installationId, ownerId: null });
  await assert.rejects(selection.activateAccount(owner), /already in use/);
  await assert.rejects(selection.verify(owner), /already in use/);
  assert.equal(raw, guestManifest);
  assert.equal(f.copies, 0);
  await opened.close();
  f.loseCopy();
  await assert.rejects(selection.activateAccount(owner));
  assert.equal(selection.getSnapshot().status, 'pending');
  await assert.rejects(selection.activateAccount(other));
  const reopened = createContentAccountSelection(options);
  await reopened.initialize();
  await reopened.recoverPending();
  const selected = reopened.getSnapshot();
  assert.equal(selected.status, 'ready');
  assert.deepEqual(selected.manifest?.active, { kind: 'account', ownerId: owner });
  assert.deepEqual(await reopened.verify(owner), { binding: null });
  assert.equal(f.copies, 1);
  assert.equal(await f.dump(f.guest), original);
  await reopened.keepLocalCopy(owner);
  await reopened.activateGuest();
  assert.equal(reopened.getSnapshot().manifest?.guestClaim, owner);
  assert.equal(await f.dump(f.guest), original);
});

test('lost backup acknowledgement resumes the original marked image without recopying changed guest data', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options);
  f.loseCopy();
  await assert.rejects(adapter.prepare(owner, true), /Lost clone/);
  const saved = await f.inspect(
    f.nameFor(owner),
    (db) =>
      db.prepare('SELECT value FROM app_metadata WHERE key=?').get(CONTENT_ACCOUNT_MARKER_KEY)!
        .value,
  );
  assert.equal(JSON.parse(String(saved)).phase, 'copied');
  await f.inspect(f.guest, (db) =>
    db
      .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
      .run('test:later-guest-change', 'Only the retained guest has this later data'),
  );
  const before = await f.dump(f.guest);
  const reopened = createContentAccountWorkspaceAdapter(f.options);
  await reopened.prepare(owner, true);
  assert.deepEqual(await reopened.verify(owner), { binding: null });
  assert.equal(f.copies, 1);
  assert.equal(await f.dump(f.guest), before);
  assert.equal(
    await f.inspect(
      f.nameFor(owner),
      (db) =>
        db
          .prepare("SELECT COUNT(*) count FROM app_metadata WHERE key='test:later-guest-change'")
          .get()!.count,
    ),
    0,
  );
});

test('delegated guest-verification close failure blocks every later owner and removal', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options);
  f.failDelegatedClose();
  await assert.rejects(adapter.prepare(owner, true), AggregateError);
  await assert.rejects(adapter.prepare(other, false), AggregateError);
  await assert.rejects(adapter.remove(owner), AggregateError);
  assert.equal(f.copies, 0);
  assert.deepEqual(f.removed, []);
});

test('oversized text, blobs and malformed installation identities are rejected before payload transfer', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options);
  await adapter.prepare(owner, false);
  for (const value of [
    'x'.repeat(100_000),
    new Uint8Array(100_000),
    `${f.config.installationId}\0`,
  ]) {
    await f.inspect(f.nameFor(owner), (db) =>
      db.prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'").run(value),
    );
    f.resetTransfers();
    await assert.rejects(adapter.verify(owner));
    assert.equal(f.largeTransfers, 0);
  }
  await f.inspect(f.nameFor(owner), (db) => {
    db.prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'").run(
      f.config.installationId,
    );
    db.prepare('UPDATE app_metadata SET value=? WHERE key=?').run(
      'x'.repeat(100_000),
      CONTENT_ACCOUNT_MARKER_KEY,
    );
  });
  f.resetTransfers();
  await assert.rejects(adapter.verify(owner));
  assert.equal(f.largeTransfers, 0);
});

test('prepared populated clone is reviewed, claimed by the original journal, and reopened in the configured bound runtime', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options),
    original = await f.dump(f.guest);
  await adapter.prepare(owner, true);
  const scope = { ownerId: owner, authGeneration: 1 };
  let current: AccountReplicationScope | null = scope;
  const savedSettings = new Map<string, string>();
  const localSettings = createLocalAccountSettings({
    ownerId: owner,
    isCurrent: () => current === scope,
    store: {
      read: async (key) => savedSettings.get(key) ?? null,
      write: async (key, value) => {
        savedSettings.set(key, value);
      },
    },
  });
  await localSettings.hydrate();
  const settings = () => ({
    appPreferences: {
      theme: 'system' as const,
      motion: 'system' as const,
      locale: 'system' as const,
    },
    profile: { displayName: null },
  });
  const baseline = await createBundledContentSnapshot(sha256),
    listeners = new Set<() => void>();
  const mediaFiles = new Map(
    baseline.revisions.flatMap((revision) =>
      revision.document.media.map(
        (media) =>
          [
            media.sha256,
            new URL(`../../catalogue/assets/photos/${revision.ref.recipeId}.jpg`, import.meta.url),
          ] as const,
      ),
    ),
  );
  let selection!: ReturnType<typeof createContentAccountSelection>;
  const controller = createPrivateContentController({
    prepare: () => preparePrivateContentWorkspace(f.options),
    open: (lease) =>
      openPrivateContentRuntime({
        config: f.config,
        openConnection: f.options.openConnection,
        platform: f.options.platform,
        now: () => '2026-10-01T12:00:00.000Z',
        dateContext: () => ({
          localDate: '2026-10-01',
          timeZone: 'Asia/Dubai',
          utcOffsetMinutes: 240,
        }),
        verification: async () => ({
          baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
          readerVersion: 1,
          sha256,
          sha256Bytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
          trustVerifier: { verify: async () => false },
          async inspectImage(bytes) {
            const image = sharp(bytes);
            try {
              const metadata = await image.metadata();
              if (!metadata.width || !metadata.height || metadata.format !== 'jpeg') return null;
              return {
                width: metadata.width,
                height: metadata.height,
                mimeType: 'image/jpeg' as const,
              };
            } finally {
              image.destroy();
            }
          },
          async readBundledMedia(media) {
            const path = mediaFiles.get(media.sha256);
            return path ? readFile(path) : null;
          },
        }),
        journal: {
          read: async () => null,
          save: async () => {
            throw new Error('No publication in this test');
          },
          clear: async () => undefined,
        },
        fetch: async () => {
          throw new Error('No hosted service in this test');
        },
        account: {
          scope,
          currentScope: () => current,
          getLocalSettings: settings,
          verifyPrepared: async () => {
            assert.deepEqual(await selection.verifyDuringOpening(owner, lease), { binding: owner });
          },
          subscribeAccess: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        },
      }),
  });
  const first = await openContentAccountBootstrap({
    controller,
    installationId: f.config.installationId,
    catalogue: catalogue.identity,
    scope,
    currentScope: () => current,
    getLocalSettings: settings,
    openConnection: f.options.openConnection,
    verifyPrepared: (assertClosed) =>
      createContentAccountWorkspaceAdapter({ ...f.options, assertClosed }).verify(owner),
    now: () => '2026-10-01T12:00:00.000Z',
    newId: randomUUID,
    sha256,
  });
  const bootstrap = first.services;
  await assert.rejects(controller.prepare(), /already in use/);
  await assert.rejects(controller.open(), /already in use/);
  const backend = createContentAccountLifecycleBackend();
  const approved = await backend.reviewApproval(first, scope);
  await backend.approveScope(first, scope, approved, false);
  const operationId = randomUUID();
  const connecting = {
    handle: first,
    scope,
    isCurrent: () => current === scope,
    settings: localSettings,
    newId: () => operationId,
    enableExpandedScope: true,
    remote: {
      endpoint: 'https://account.example.test/sync',
      publishableKey: 'sb_publishable_disposable_test',
      ownerId: owner,
      session: async () => ({
        ownerId: owner,
        generation: 1,
        accessToken: 'disposable-test-token',
      }),
      isCurrent: () => current === scope,
      fetch: (async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), { action: 'read' });
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            ownerId: owner,
            revision: 0,
            snapshot: null,
            updatedAt: null,
            deletionPending: false,
            deletionOperationId: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) satisfies typeof fetch,
    },
  };
  await assert.rejects(
    backend.connect({ ...connecting, enableExpandedScope: false }),
    /not enabled/,
  );
  const initialConnection = await backend.connect(connecting);
  await initialConnection.sync();
  const review = initialConnection.getSnapshot();
  assert.equal(review.kind, 'review');
  assert.ok(review.kind === 'review' && review.phase === 'push' && review.canConfirm);
  await initialConnection.dispatch({ kind: 'confirm' });
  const handoff = initialConnection.getSnapshot();
  assert.ok(handoff.kind === 'review' && handoff.phase === 'reopen', JSON.stringify(handoff));
  assert.equal(handoff.operationId, operationId);
  const staged = await bootstrap.journal.read(scope);
  assert.ok(staged);
  assert.ok(staged.pending);
  await initialConnection.invalidate();
  const closing = first.close();
  assert.strictEqual(first.close(), closing);
  await assert.rejects(bootstrap.capture());
  await closing;
  let manifest: string | null = null;
  selection = createContentAccountSelection({
    controller,
    databases: f.options,
    storage: {
      read: async () => manifest,
      write: async (value) => {
        manifest = value;
      },
    },
  });
  await selection.initialize();
  await selection.activateAccount(owner);
  const runtime = await controller.open();
  try {
    assert.deepEqual(runtime.storageScope, {
      installationId: f.config.installationId,
      ownerId: owner,
    });
    assert.ok(runtime.host.account);
    assert.deepEqual(
      await runtime.host.account.journal.recover(scope, {
        operationId,
        requestFingerprint: staged.pending.requestFingerprint,
      }),
      staged,
    );
    let commitCalls = 0;
    const requests: unknown[] = [];
    const connection = await backend.connect({
      handle: { kind: 'content_workspace', access: 'authenticated', runtime, close: runtime.close },
      scope,
      isCurrent: () => current === scope,
      settings: localSettings,
      newId: randomUUID,
      enableExpandedScope: true,
      remote: {
        endpoint: 'https://account.example.test/sync',
        publishableKey: 'sb_publishable_disposable_test',
        ownerId: owner,
        session: async () => ({
          ownerId: owner,
          generation: 1,
          accessToken: 'disposable-test-token',
        }),
        isCurrent: () => current === scope,
        fetch: async (_url, init) => {
          const request: unknown = JSON.parse(String(init?.body));
          requests.push(request);
          commitCalls++;
          // Controlled service transport: first acknowledgement is lost after the same commit.
          if (commitCalls === 1) throw new Error('Injected lost acknowledgement');
          return new Response(
            JSON.stringify({
              ownerId: owner,
              operationId,
              revision: 1,
              committedAt: '2026-10-01T12:00:00.000Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    });
    await connection.sync();
    assert.equal(connection.getSnapshot().kind, 'failed');
    assert.deepEqual(requests[0], {
      action: 'commit',
      operationId,
      expectedRevision: 0,
      snapshot: staged.pending!.proposed,
    });
    assert.equal(
      (await runtime.host.account.journal.read(scope))?.pending?.operationId,
      operationId,
    );
    await connection.sync();
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(connection.getSnapshot().kind, 'synced', JSON.stringify(connection.getSnapshot()));
    assert.equal(commitCalls, 2);
    assert.equal((await runtime.host.account.journal.read(scope))?.pending, null);
    assert.equal((await runtime.host.account.journal.read(scope))?.base?.revision, 1);
    await connection.invalidate();
    assert.equal(
      await f.inspect(
        f.nameFor(owner),
        (db) => db.prepare('SELECT item_id FROM manual_shopping_item').get()!.item_id,
      ),
      f.itemId,
    );
    current = null;
    for (const listener of listeners) listener();
    await assert.rejects(runtime.host.account.journal.read(scope));
    assert.equal(runtime.host.getSnapshot().status, 'revoked');
  } finally {
    await runtime.close();
  }
  assert.equal(listeners.size, 0);
  assert.equal(await f.dump(f.guest), original);
});

async function bootstrapFixture(t: TestContext) {
  const f = await fixture(t);
  await createContentAccountWorkspaceAdapter(f.options).prepare(owner, true);
  const controller = createPrivateContentController({
    prepare: () => preparePrivateContentWorkspace(f.options),
    open: async () => {
      throw new Error('No ordinary runtime in this failure fixture');
    },
  });
  const scope = { ownerId: owner, authGeneration: 1 };
  const options: Parameters<typeof openContentAccountBootstrap>[0] = {
    controller,
    scope,
    installationId: f.config.installationId,
    catalogue: catalogue.identity,
    currentScope: () => scope,
    openConnection: f.options.openConnection,
    verifyPrepared: (assertClosed) =>
      createContentAccountWorkspaceAdapter({ ...f.options, assertClosed }).verify(owner),
    getLocalSettings: () => ({
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    }),
    now: () => '2026-10-01T12:00:00.000Z',
    newId: randomUUID,
    sha256,
  };
  return { f, controller, scope, options };
}
for (const failure of ['alias', 'query_only'] as const)
  test(`bootstrap ${failure} opening failure closes owned handles before releasing the lease`, async (t) => {
    const { f, controller, options } = await bootstrapFixture(t);
    let original: Awaited<ReturnType<typeof options.openConnection>> | undefined;
    let opened = 0,
      closed = 0;
    const open = options.openConnection;
    options.openConnection = async (name) => {
      if (failure === 'alias' && original) return original;
      const raw = await open(name);
      opened++;
      const connection = {
        ...raw,
        async exec(sql: string) {
          if (failure === 'query_only' && sql === 'PRAGMA query_only=ON')
            throw new Error('injected query_only');
          return raw.exec(sql);
        },
        async close() {
          await raw.close();
          closed++;
        },
      };
      original ??= connection;
      return connection;
    };
    await assert.rejects(
      openContentAccountBootstrap(options),
      failure === 'alias' ? /distinct/ : /query_only/,
    );
    assert.equal(closed, opened);
    assert.equal((await controller.prepare()).kind, 'already_prepared');
    assert.deepEqual(await createContentAccountWorkspaceAdapter(f.options).verify(owner), {
      binding: null,
    });
  });

test('bootstrap close drains delayed review and keeps its lease until the stale result is rejected', async (t) => {
  const { controller, options, scope } = await bootstrapFixture(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  let gated = false;
  options.sha256 = async (text) => {
    if (gated) {
      enter();
      await gate;
    }
    return sha256(text);
  };
  const first = await openContentAccountBootstrap(options);
  // An existing approval guarantees that the next review validates its digest through sha256.
  const initialReview = await first.services.approval.review(scope);
  await first.services.approval.approve(scope, initialReview, { historyIncluded: false });
  gated = true;
  const reviewing = first.services.approval.review(scope);
  const rejected = assert.rejects(reviewing);
  await entered;
  let finished = false;
  const closing = first.close().then(() => {
    finished = true;
  });
  await assert.rejects(controller.prepare(), /already in use/);
  assert.equal(finished, false);
  release();
  await rejected;
  await closing;
  assert.equal((await controller.prepare()).kind, 'already_prepared');
});

test('bootstrap cleanup error stays latched even when a raw-handle retry succeeds', async (t) => {
  const { controller, options } = await bootstrapFixture(t);
  const open = options.openConnection;
  let failed = false,
    closed = 0;
  options.openConnection = async (name) => {
    const raw = await open(name);
    return {
      ...raw,
      async close() {
        if (!failed) {
          failed = true;
          throw new Error('injected close failure');
        }
        await raw.close();
        closed++;
      },
    };
  };
  const first = await openContentAccountBootstrap(options);
  await assert.rejects(first.close(), PrivateContentCleanupError);
  assert.equal(closed, 2);
  await assert.rejects(controller.prepare(), PrivateContentCleanupError);
  await assert.rejects(controller.open(), PrivateContentCleanupError);
});

test('private settings interruption holds readiness and retry never overwrites the copied SQLite rows', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options);
  f.failPrivate(true);
  await assert.rejects(adapter.prepare(owner, true), /Private settings/);
  await assert.rejects(adapter.verify(owner));
  const before = await f.inspect(f.nameFor(owner), (db) =>
    db.prepare('SELECT * FROM manual_shopping_item').all(),
  );
  f.failPrivate(false);
  await adapter.prepare(owner, true);
  assert.deepEqual(
    await f.inspect(f.nameFor(owner), (db) =>
      db.prepare('SELECT * FROM manual_shopping_item').all(),
    ),
    before,
  );
  assert.equal(f.copies, 1);
  assert.deepEqual(await adapter.verify(owner), { binding: null });
});

test('unowned and wrong-identity destinations are refused and are never deleted or copied over', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options);
  await f.inspect(f.nameFor(owner), (db) =>
    db.exec("CREATE TABLE precious(value TEXT);INSERT INTO precious VALUES ('retained')"),
  );
  await assert.rejects(adapter.prepare(owner, true));
  await assert.rejects(adapter.remove(owner));
  assert.equal(
    await f.inspect(
      f.nameFor(owner),
      (db) => db.prepare('SELECT value FROM precious').get()!.value,
    ),
    'retained',
  );
  assert.equal(f.copies, 0);
  assert.deepEqual(f.removed, []);
  await adapter.prepare(other, false);
  await f.inspect(f.nameFor(other), (db) =>
    db.prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'").run(randomUUID()),
  );
  await assert.rejects(adapter.verify(other));
  await assert.rejects(adapter.remove(other));
  assert.deepEqual(f.removed, []);
});

test('open workspace, unresolved guest reference and failed close fence all preparation and deletion', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options);
  f.setClosed(false);
  await assert.rejects(adapter.prepare(owner, true), /Still open/);
  await assert.rejects(adapter.remove(owner), /Still open/);
  f.setClosed(true);
  f.setRecovery(false);
  await assert.rejects(adapter.prepare(owner, true), /Unresolved guest/);
  assert.equal(f.copies, 0);
  f.setRecovery(true);
  f.failClose();
  await assert.rejects(adapter.prepare(owner, true), AggregateError);
  await assert.rejects(adapter.prepare(other, false), AggregateError);
  await assert.rejects(adapter.remove(owner), AggregateError);
  assert.equal(f.copies, 0);
  assert.deepEqual(f.removed, []);
});

test('guest preparation is never migrated by account cloning and unknown account owners never open files', async (t) => {
  const f = await fixture(t),
    adapter = createContentAccountWorkspaceAdapter(f.options);
  await f.inspect(f.guest, (db) => db.exec('PRAGMA user_version=7'));
  const before = await f.dump(f.guest);
  await assert.rejects(adapter.prepare(owner, true));
  assert.equal(await f.dump(f.guest), before);
  assert.equal(
    await f.inspect(f.guest, (db) => db.prepare('PRAGMA user_version').get()!.user_version),
    7,
  );
  await assert.rejects(adapter.prepare('../cookmate.db', false));
  assert.equal(f.copies, 0);
});
