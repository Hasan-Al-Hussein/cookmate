import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { createBundledContentSnapshot } from '@cookmate/catalogue/content';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import {
  openPrivateContentRuntime,
  createPrivateContentOpener,
  PrivateContentCleanupError,
  type PrivateContentRuntime,
  type PrivateContentRuntimeOptions,
} from '../../../apps/mobile/src/features/content/privateContentRuntime';
import {
  privateContentDatabaseNames,
  privateContentAccountDatabaseName,
  readPrivateContentConfiguration,
} from '../../../apps/mobile/src/features/content/privateContentConfig';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(t: TestContext, version = 8) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-commands-private-route-'));
  t.after(() => removeFixtureDirectory(directory));
  const ids = {
    installationId: randomUUID(),
    shoppingScopeId: randomUUID(),
    conversationId: randomUUID(),
  };
  const names = privateContentDatabaseNames(ids.installationId);
  if (version) {
    const db = desktopConnection(join(directory, names.cooking));
    await configureConnection(db.connection);
    const writer = new SerializedWriter(db.connection);
    try {
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
      if (version >= 7) await migrateCookingContentDatabase(writer, { sha256 });
      if (version >= 8) await migrateAccountContentHistoryDatabase(writer, { sha256 });
    } finally {
      await writer.close();
    }
  }
  const baseline = await createBundledContentSnapshot(sha256);
  const opened: string[] = [],
    live = new Set<object>();
  let opens = 0;
  const options: PrivateContentRuntimeOptions = {
    config: readPrivateContentConfiguration(
      JSON.stringify({
        version: 1,
        origin: 'http://localhost:19091',
        installationId: ids.installationId,
        releaseId: 'release-1',
        trustKeys: [{ keyId: 'test-key', publicKeyHex: '1'.repeat(64) }],
      }),
      'http://localhost:19091',
    )!,
    async openConnection(name) {
      assert.ok(name === names.cooking || name === names.content);
      opened.push(name);
      opens++;
      const db = desktopConnection(join(directory, name));
      live.add(db);
      return {
        ...db.connection,
        async close() {
          await db.connection.close();
          live.delete(db);
        },
      };
    },
    async verification() {
      return {
        baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
        readerVersion: 1,
        sha256,
        sha256Bytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
        trustVerifier: { verify: async () => false },
        inspectImage: async () => null,
        readBundledMedia: async () => null,
      };
    },
    journal: {
      read: async () => null,
      save: async () => {
        throw new Error('No update in this test');
      },
      clear: async () => {},
    },
    platform: { newId: randomUUID, sha256 },
    now: () => '2026-10-01T14:00:00.000Z',
    dateContext: () => ({ localDate: '2026-10-01', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    fetch: async () => {
      throw new Error('Discovery must not send a network request');
    },
  };
  return { options, names, directory, opened, live, opens: () => opens };
}

test('prepared private8 opens real bundled reader without default DB or network; close revokes and drains all handles', async (t) => {
  const f = await fixture(t);
  const runtime = await openPrivateContentRuntime(f.options);
  const recipes = await runtime.host.content.discover();
  assert.equal(recipes.value.length, 100);
  assert.equal(
    (await runtime.host.content.readCurrent(catalogue.recipes[0]!.recipeId)).value.kind,
    'readable',
  );
  assert.ok(f.opened.every((name) => name.startsWith('cookmate-review-')));
  const close = runtime.close();
  await assert.rejects(runtime.host.content.discover());
  await close;
  assert.equal(f.live.size, 0);
  await assert.rejects(runtime.fetchRelease());
});

for (const version of [0, 6, 7])
  test(`schema${version} is refused without migration or content-cache creation`, async (t) => {
    const f = await fixture(t, version);
    await assert.rejects(openPrivateContentRuntime(f.options), /schema8/);
    assert.deepEqual(f.opened, [f.names.cooking]);
    assert.equal(f.live.size, 0);
    const observer = desktopConnection(join(f.directory, f.names.cooking));
    assert.equal(observer.database.prepare('PRAGMA user_version').get()!.user_version, version);
    await observer.connection.close();
  });

test('wrong installation and account-bound private databases are refused', async (t) => {
  const f = await fixture(t);
  const observer = desktopConnection(join(f.directory, f.names.cooking));
  observer.database
    .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
    .run(randomUUID());
  await assert.rejects(openPrivateContentRuntime(f.options), /installation/);
  observer.database
    .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
    .run(f.options.config.installationId);
  observer.database
    .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
    .run('account-replication:owner', randomUUID());
  await assert.rejects(openPrivateContentRuntime(f.options));
  assert.equal(f.live.size, 0);
  await observer.connection.close();
});

test('failure acquiring second content handle closes earlier acquired connection', async (t) => {
  const f = await fixture(t);
  const open = f.options.openConnection;
  f.options.openConnection = async (name) => {
    if (f.opens() === 2) throw new Error('injected opening failure');
    return open(name);
  };
  await assert.rejects(openPrivateContentRuntime(f.options), /injected/);
  assert.equal(f.live.size, 0);
});

test('opener waits for close and permits retry only after a clean opening failure', async () => {
  let opened = 0,
    finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake = {
    storageScope: { installationId: '10000000-0000-4000-8000-000000000001', ownerId: null },
    host: {} as PrivateContentRuntime['host'],
    fetchRelease: async () => {
      throw new Error();
    },
    close: () => closed,
  };
  const open = createPrivateContentOpener(async () => {
    opened++;
    if (opened === 1) throw new Error('clean failure');
    return fake;
  });
  await assert.rejects(open(), /clean failure/);
  const one = await open();
  const next = open();
  await Promise.resolve();
  assert.equal(opened, 2);
  const retiring = one.close();
  await Promise.resolve();
  assert.equal(opened, 2);
  finish();
  await retiring;
  const two = await next;
  assert.equal(opened, 3);
  await two.close();
});

test('opener retains cleanup failure and never starts competing handles', async () => {
  let opened = 0;
  const open = createPrivateContentOpener(async () => {
    opened++;
    throw new PrivateContentCleanupError([new Error('close failure')]);
  });
  await assert.rejects(open(), PrivateContentCleanupError);
  await assert.rejects(open(), PrivateContentCleanupError);
  assert.equal(opened, 1);
});

test('runtime opener revokes synchronously before same-turn delivery can begin', async () => {
  let active = true,
    fetched = 0;
  const open = createPrivateContentOpener(async () => ({
    storageScope: { installationId: '10000000-0000-4000-8000-000000000001', ownerId: null },
    host: {} as PrivateContentRuntime['host'],
    fetchRelease: async () => {
      if (!active) throw new Error('closed');
      fetched++;
      throw new Error('unexpected fetch');
    },
    close: () => {
      active = false;
      return Promise.resolve();
    },
  }));
  const runtime = await open();
  const closed = runtime.close();
  await assert.rejects(runtime.fetchRelease(), /closed/);
  await closed;
  assert.equal(fetched, 0);
});

test('runtime refuses aliased live SQL ports without hiding the duplicate behind wrappers', async (t) => {
  const f = await fixture(t),
    open = f.options.openConnection;
  let retained: Awaited<ReturnType<typeof open>> | undefined;
  f.options.openConnection = async (name) => {
    if (name === f.names.content) return (retained ??= await open(name));
    return open(name);
  };
  await assert.rejects(openPrivateContentRuntime(f.options), /distinct/);
  assert.equal(f.live.size, 0);
});

async function retainedAccountFixture(t: TestContext, bound = true) {
  const f = await fixture(t);
  const ownerId = randomUUID();
  const accountName = privateContentAccountDatabaseName(f.options.config.installationId, ownerId);
  await copyFile(join(f.directory, f.names.cooking), join(f.directory, accountName));
  if (bound) {
    const observer = desktopConnection(join(f.directory, accountName));
    observer.database
      .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
      .run('account-replication:owner', JSON.stringify({ schemaVersion: 1, ownerId }));
    await observer.connection.close();
  }
  const open = f.options.openConnection;
  f.options.openConnection = async (name) => {
    if (name !== accountName) return open(name);
    f.opened.push(name);
    const db = desktopConnection(join(f.directory, name));
    f.live.add(db);
    return {
      ...db.connection,
      async close() {
        await db.connection.close();
        f.live.delete(db);
      },
    };
  };
  return { ...f, ownerId, accountName };
}

test('retained signed-out owner copy opens locally without replication authority and revokes with selection', async (t) => {
  const f = await retainedAccountFixture(t);
  let current = true,
    verified = 0;
  const listeners = new Set<() => void>();
  const localAccount = {
    ownerId: f.ownerId,
    workspaceGeneration: 5,
    isCurrent: () => current,
    subscribeAccess(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async verifyPrepared() {
      verified++;
    },
  };
  const runtime = await openPrivateContentRuntime({ ...f.options, localAccount });
  assert.equal(verified, 1);
  assert.deepEqual(runtime.storageScope, {
    installationId: f.options.config.installationId,
    ownerId: f.ownerId,
  });
  assert.equal(runtime.host.account, null);
  assert.equal((await runtime.host.content.discover()).value.length, 100);
  assert.ok(f.opened.includes(f.accountName));
  assert.ok(!f.opened.includes(f.names.cooking));
  // Replacing caller fields cannot change the owner or current-selection fence already captured.
  localAccount.ownerId = randomUUID();
  localAccount.isCurrent = () => true;
  current = false;
  for (const listener of listeners) listener();
  await assert.rejects(runtime.host.content.discover());
  await assert.rejects(runtime.fetchRelease());
  await runtime.close();
  assert.equal(f.live.size, 0);
  assert.equal(listeners.size, 0);
  const guest = desktopConnection(join(f.directory, f.names.cooking));
  assert.equal(
    guest.database
      .prepare("SELECT value FROM app_metadata WHERE key='account-replication:owner'")
      .get(),
    undefined,
  );
  await guest.connection.close();
});

test('local selection cannot open an unbound account copy or skip preparation verification', async (t) => {
  const f = await retainedAccountFixture(t, false);
  const localAccount = {
    ownerId: f.ownerId,
    workspaceGeneration: 1,
    isCurrent: () => true,
    subscribeAccess: () => () => {},
    verifyPrepared: async () => {},
  };
  await assert.rejects(
    openPrivateContentRuntime({ ...f.options, localAccount }),
    /binding differs/,
  );
  assert.equal(f.live.size, 0);
  f.opened.length = 0;
  await assert.rejects(
    openPrivateContentRuntime({
      ...f.options,
      localAccount: {
        ...localAccount,
        verifyPrepared: async () => {
          throw new Error('unverified preparation');
        },
      },
    }),
    /unverified preparation/,
  );
  assert.deepEqual(f.opened, []);
});

test('stale local selection after preparation and mixed access are rejected before handles open', async (t) => {
  const f = await retainedAccountFixture(t);
  let current = true;
  const localAccount = {
    ownerId: f.ownerId,
    workspaceGeneration: 1,
    isCurrent: () => current,
    subscribeAccess: () => () => {},
    verifyPrepared: async () => {
      current = false;
    },
  };
  await assert.rejects(openPrivateContentRuntime({ ...f.options, localAccount }), /closed/);
  assert.deepEqual(f.opened, []);
  await assert.rejects(
    openPrivateContentRuntime({
      ...f.options,
      localAccount,
      account: {
        scope: { ownerId: f.ownerId, authGeneration: 1 },
        currentScope: () => null,
        subscribeAccess: () => () => {},
        verifyPrepared: async () => {},
        getLocalSettings: () => ({
          appPreferences: { theme: 'system', motion: 'system', locale: 'en' },
          profile: { displayName: null },
        }),
      },
    }),
    /not both/,
  );
  assert.deepEqual(f.opened, []);
});
