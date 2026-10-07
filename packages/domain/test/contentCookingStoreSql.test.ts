import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import type { RepositoryResult } from '../src';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { openContentCookingStore } from '../../../apps/mobile/src/data/contentCookingStore';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { sha256 } from '../../catalogue/test/content-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const at = '2026-10-01T12:00:00.000Z';
function ready<Value>(result: RepositoryResult<Value>): Value {
  assert.equal(result.kind, 'ready', JSON.stringify(result));
  if (result.kind !== 'ready') assert.fail();
  return result.value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, version: 6 | 8 = 8) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-store-'));
  const path = join(directory, 'cooking.db');
  const seed = desktopConnection(path);
  await configureConnection(seed.connection);
  const writer = new SerializedWriter(seed.connection);
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  await initializeDatabase(
    writer,
    {
      identity: catalogue.identity,
      recipes: catalogue.recipes,
      recipeSources: catalogueProvenance.recipeSources,
    },
    ids,
    {
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      enableAccountHistory: true,
    },
  );
  if (version === 8) {
    await migrateCookingContentDatabase(writer, { sha256 });
    await migrateAccountContentHistoryDatabase(writer, { sha256 });
  }
  await writer.close();
  const handles: {
    closeCount: number;
    closed: boolean;
    db: ReturnType<typeof desktopConnection>;
  }[] = [];
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 1 };
  let activeStore: Awaited<ReturnType<typeof openContentCookingStore>> | undefined;
  let hashPause:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  const options: Parameters<typeof openContentCookingStore>[0] = {
    schemaVersion: 8,
    installationId: ids.installationId,
    async openConnection() {
      const db = desktopConnection(path),
        record = { closeCount: 0, closed: false, db };
      handles.push(record);
      const close = db.connection.close;
      db.connection.close = async () => {
        record.closeCount++;
        if (!record.closed) {
          record.closed = true;
          await close();
        }
      };
      return db.connection;
    },
    // Controlled lifetime port only. Real signatures/media belong to the signed bridge suite.
    contentStore: {
      async withVerifiedReading(head, _refs, work) {
        assert.equal(head, null);
        let active = true;
        try {
          return await work({
            head: null,
            latestHead: null,
            snapshot: null,
            hasWithdrawal: false,
            assertActive() {
              assert.ok(active);
              return undefined;
            },
            async readPhoto() {
              throw new Error('No photo fixture');
            },
          });
        } finally {
          active = false;
        }
      },
      async withVerifiedAdoption() {
        throw new Error('No release fixture');
      },
      async withVerifiedReferenceInspection() {
        throw new Error('This lifetime fixture does not admit private notes');
      },
    },
    platform: {
      newId: randomUUID,
      async sha256(text) {
        if (hashPause) {
          const pause = hashPause;
          hashPause = undefined;
          pause.entered.resolve();
          await pause.release.promise;
        }
        return sha256(text);
      },
    },
    now: () => at,
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    getAccess: () => access,
    assertAccess(scope) {
      assert.deepEqual(access, scope);
      return undefined;
    },
  };
  t.after(async () => {
    await activeStore?.close().catch(() => undefined);
    for (const handle of handles) if (!handle.closed) await handle.db.connection.close();
    await removeFixtureDirectory(directory);
  });
  return {
    options,
    handles,
    path,
    async open() {
      activeStore = await openContentCookingStore(options);
      return activeStore;
    },
    setAccess(value: ContentAdoptionAccess | null) {
      access = value;
    },
    pauseHash() {
      const value = { entered: deferred(), release: deferred() };
      hashPause = value;
      return value;
    },
  };
}

test('private composition uses real migrated8 SQL, exact Plan command/receipt and isolated change observers', async (t) => {
  const f = await fixture(t),
    store = await f.open();
  const changes: unknown[] = [];
  store.subscribe(() => {
    throw new Error('Fixture view failure');
  });
  store.subscribe((change) => changes.push(change));
  const discovery = await store.content.discover();
  assert.equal(discovery.value.length, catalogue.recipes.length);
  assert.equal(discovery.ownerId, null);
  const review = ready(
    await store.commands.reviewDirect({
      kind: 'placeRecipe',
      recipeId: catalogue.recipes[0]!.recipeId,
      placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
    }),
  );
  const command = ready(await store.commands.prepareDirect(review));
  const result = await store.commands.execute(command);
  assert.equal(result.kind, 'receipt');
  assert.equal(changes.length, 1);
  const db = f.handles[0]!.db.database;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_content_pin').get()!.n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM operation_receipt').get()!.n, 1);
  const receipt = ready(await store.commands.recover(command));
  assert.ok(receipt);
  await store.close();
  const reopened = await f.open();
  assert.deepEqual(ready(await reopened.commands.recover(command)), receipt);
  assert.equal(ready(await reopened.history.readHistory()).items.length, 0);
});

test('opening refuses unmigrated6 without changing it and closes every acquired handle', async (t) => {
  const f = await fixture(t, 6);
  await assert.rejects(f.open(), { code: 'incompatible_version' });
  assert.deepEqual(
    f.handles.map((handle) => handle.closeCount),
    [1, 1],
  );
  const check = desktopConnection(f.path);
  try {
    assert.equal(check.database.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.equal(
      check.database
        .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='app_content_adoption'")
        .get()!.n,
      0,
    );
  } finally {
    await check.connection.close();
  }
});

test('wrong installation, owner and aliased handles fail before services escape', async (t) => {
  for (const mode of ['installation', 'owner', 'alias'] as const) {
    const f = await fixture(t);
    if (mode === 'installation') f.options.installationId = randomUUID();
    if (mode === 'owner') f.setAccess({ ownerId: randomUUID(), authGeneration: 1 });
    if (mode === 'alias') {
      const open = f.options.openConnection;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      f.options.openConnection = async (mode) => (handle ??= await open(mode));
    }
    await assert.rejects(f.open(), { code: 'storage_failure' });
    assert.ok(
      f.handles.every((handle) => handle.closeCount === 1),
      mode,
    );
  }
});

test('revocation during connection acquisition closes late handles and never opens services', async (t) => {
  const f = await fixture(t),
    acquired = deferred(),
    release = deferred();
  const open = f.options.openConnection;
  f.options.openConnection = async (mode) => {
    const connection = await open(mode);
    if (mode === 'read') {
      acquired.resolve();
      await release.promise;
    }
    return connection;
  };
  const pending = f.open();
  const rejection = assert.rejects(pending, { code: 'storage_failure' });
  await acquired.promise;
  f.setAccess(null);
  f.options.getAccess = () => ({ ownerId: null, authGeneration: 1 });
  f.options.assertAccess = () => undefined;
  release.resolve();
  await rejection;
  assert.deepEqual(
    f.handles.map((handle) => handle.closeCount),
    [1, 1],
  );
});

test('closing revokes late content and every service while sharing one cleanup promise', async (t) => {
  const f = await fixture(t),
    store = await f.open(),
    pause = f.pauseHash();
  const pending = store.content.discover();
  const rejection = assert.rejects(pending);
  await pause.entered.promise;
  const first = store.close();
  assert.equal(store.close(), first);
  await first;
  pause.release.resolve();
  await rejection;
  assert.deepEqual(
    f.handles.map((handle) => handle.closeCount),
    [1, 1],
  );
  assert.equal((await store.history.readHistory()).kind, 'failed');
  assert.equal((await store.commands.readDirectRecovery()).kind, 'failed');
  await assert.rejects(
    store.adoption.review({
      candidateHead: { releaseId: 'unavailable', sequence: 1, fingerprint: 'a'.repeat(64) },
    }),
  );
  assert.throws(() => store.subscribe(() => undefined));
});

test('retained caller options cannot replace admitted ports or revive a revoked ready store', async (t) => {
  const f = await fixture(t),
    acquired = deferred(),
    release = deferred();
  const open = f.options.openConnection;
  f.options.openConnection = async (mode) => {
    const connection = await open(mode);
    if (mode === 'write') {
      acquired.resolve();
      await release.promise;
    }
    return connection;
  };
  const pending = f.open();
  await acquired.promise;
  f.options.openConnection = async () => {
    throw new Error('Replaced connection port used');
  };
  f.options.platform.sha256 = async () => {
    throw new Error('Replaced hash port used');
  };
  assert.equal(
    Reflect.set(f.options.contentStore, 'withVerifiedReading', async () => {
      throw new Error('Replaced content port used');
    }),
    true,
  );
  release.resolve();
  const store = await pending;
  assert.equal((await store.content.discover()).value.length, catalogue.recipes.length);
  f.setAccess(null);
  f.options.getAccess = () => ({ ownerId: null, authGeneration: 1 });
  f.options.assertAccess = () => undefined;
  await assert.rejects(store.content.discover());
  assert.equal((await store.history.readHistory()).kind, 'failed');
});

test('subscriber revocation stops later delivery and suppresses success without erasing the durable receipt', async (t) => {
  const f = await fixture(t),
    store = await f.open();
  let laterCalls = 0;
  store.subscribe(() => f.setAccess({ ownerId: null, authGeneration: 2 }));
  store.subscribe(() => {
    laterCalls++;
  });
  const review = ready(
    await store.commands.reviewDirect({
      kind: 'placeRecipe',
      recipeId: catalogue.recipes[0]!.recipeId,
      placement: { actualDate: '2026-10-01', mealKey: 'dinner' },
    }),
  );
  const command = ready(await store.commands.prepareDirect(review));
  const result = await store.commands.execute(command);
  assert.equal(result.kind, 'uncertain');
  assert.equal(laterCalls, 0);
  const db = f.handles[0]!.db.database;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM operation_receipt').get()!.n, 1);
  await store.close();
  const reopened = await f.open();
  assert.ok(ready(await reopened.commands.recover(command)));
});

test('cleanup attempts both handles even when the first close reports failure', async (t) => {
  const f = await fixture(t),
    store = await f.open();
  const read = f.handles[1]!.db.connection,
    close = read.close;
  read.close = async () => {
    await close();
    throw new Error('Fixture close acknowledgement lost');
  };
  const closing = store.close();
  await assert.rejects(closing, AggregateError);
  assert.equal(store.close(), closing);
  assert.deepEqual(
    f.handles.map((handle) => handle.closeCount),
    [1, 1],
  );
  await assert.rejects(store.content.discover());
});
