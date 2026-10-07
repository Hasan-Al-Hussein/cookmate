import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import type { SqlConnection } from '../../data/sql';
import {
  createPrivateContentBrowserConnection,
  createPrivateContentAccountBrowserConnection,
  privateContentAccountBrowserName,
} from './privateContentBrowserConnection';
import {
  PrivateContentConfigurationError,
  privateContentDatabaseNames,
  privateContentAccountDatabaseName,
} from './privateContentConfig';

const installationId = '650a0000-0000-4000-8000-000000000001';
const otherInstallationId = '650a0000-0000-4000-8000-000000000002';
const ownerId = '650b0000-0000-4000-8000-000000000001';
const otherOwnerId = '650b0000-0000-4000-8000-000000000002';
const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
function connection(): SqlConnection {
  return {
    async exec() {},
    async all() {
      return [];
    },
    async prepare() {
      return { async run() {}, async finalize() {} };
    },
    async close() {},
  };
}

test('browser aliases preserve the complete installation UUID and separate cooking/content without changing logical names', async () => {
  const opened: string[] = [];
  const handles: SqlConnection[] = [];
  const open = createPrivateContentBrowserConnection(installationId, async (name) => {
    opened.push(name);
    const handle = connection();
    handles.push(handle);
    return handle;
  });
  const names = privateContentDatabaseNames(installationId);
  assert.equal(names.cooking, `cookmate-review-${installationId}-cooking.db`);
  assert.equal(names.content, `cookmate-review-${installationId}-content.db`);
  assert.equal(await open(names.cooking), handles[0]);
  assert.equal(await open(names.content), handles[1]);
  assert.deepEqual(opened, [`cmr-${installationId}-c.db`, `cmr-${installationId}-r.db`]);
  const other = createPrivateContentBrowserConnection(otherInstallationId, async (name) => {
    opened.push(name);
    return connection();
  });
  await other(privateContentDatabaseNames(otherInstallationId).cooking);
  assert.equal(new Set(opened).size, 3);
});

test('only exact names for the configured installation reach the physical opener; failures are never retried under another name', async () => {
  const opened: string[] = [];
  const failure = new Error('fixture opener failed');
  const open = createPrivateContentBrowserConnection(installationId, async (name) => {
    opened.push(name);
    throw failure;
  });
  for (const name of [
    'cookmate.db',
    'cookmate-guest.db',
    'cookmate-account.db',
    privateContentDatabaseNames(otherInstallationId).cooking,
    `cmr-${installationId}-c.db`,
    `./cookmate-review-${installationId}-cooking.db`,
    `cookmate-review-${installationId}-cooking.db-journal`,
  ]) {
    await assert.rejects(open(name), PrivateContentConfigurationError);
  }
  assert.deepEqual(opened, []);
  await assert.rejects(
    open(privateContentDatabaseNames(installationId).cooking),
    (error) => error === failure,
  );
  assert.deepEqual(opened, [`cmr-${installationId}-c.db`]);
  for (const invalid of [
    '',
    'short-installation',
    '../cookmate',
    installationId.replace('-4000-', '-1000-'),
  ]) {
    assert.throws(
      () => createPrivateContentBrowserConnection(invalid, async () => connection()),
      PrivateContentConfigurationError,
    );
  }
});

test('actual installed Expo VFS rejects the old normalized path and admits each alias with journal suffix space', async () => {
  const require = createRequire(import.meta.url);
  const sqliteDirectory = dirname(require.resolve('expo-sqlite/package.json'));
  const { Base } = (await import(
    pathToFileURL(join(sqliteDirectory, 'web/wa-sqlite/VFS.js')).href
  )) as {
    Base: new (name: string, module: object) => { mxPathname: number };
  };
  const { FacadeVFS } = (await import(
    pathToFileURL(join(sqliteDirectory, 'web/wa-sqlite/FacadeVFS.js')).href
  )) as {
    FacadeVFS: { prototype: { jFullPathname(filename: string, output: Uint8Array): number } };
  };
  const limit = new Base('bounded-path-proof', {}).mxPathname;
  assert.equal(limit, 64, 'Review this compatibility test when the installed VFS limit changes.');
  for (const logical of Object.values(privateContentDatabaseNames(installationId))) {
    const normalized = `./${logical}`;
    assert.equal(Buffer.byteLength(normalized), 65);
    assert.notEqual(FacadeVFS.prototype.jFullPathname(normalized, new Uint8Array(limit + 1)), 0);
  }
  const checkPhysical = async (name: string) => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const normalized = `./${name}${suffix}`;
      assert.ok(Buffer.byteLength(normalized) < limit);
      const output: Uint8Array = new Uint8Array(limit + 1);
      assert.equal(FacadeVFS.prototype.jFullPathname(normalized, output), 0);
      const terminator = output.indexOf(0);
      assert.equal(new TextDecoder().decode(output.subarray(0, terminator)), normalized);
    }
    return connection();
  };
  const open = createPrivateContentBrowserConnection(installationId, checkPhysical);
  for (const name of Object.values(privateContentDatabaseNames(installationId))) await open(name);
  const account = createPrivateContentAccountBrowserConnection(
    installationId,
    ownerId,
    sha256,
    checkPhysical,
  );
  const logicalAccount = privateContentAccountDatabaseName(installationId, ownerId);
  assert.ok(Buffer.byteLength(`./${logicalAccount}`) > limit);
  await account(logicalAccount);
});

test('account aliases contain the complete independently calculated SHA256 digest of installation and owner', async () => {
  const aliases = new Set<string>();
  for (const install of [installationId, otherInstallationId]) {
    for (const owner of [ownerId, otherOwnerId]) {
      const input = canonicalContentJson(['content-account-cooking', install, owner]);
      const digest = createHash('sha256').update(input).digest();
      const calls: string[] = [];
      const alias = await privateContentAccountBrowserName(install, owner, async (text) => {
        calls.push(text);
        return sha256(text);
      });
      assert.deepEqual(calls, [input]);
      assert.equal(alias, `cma-${digest.toString('base64url')}.db`);
      assert.equal(
        Buffer.from(alias.slice(4, -3), 'base64url').toString('hex'),
        digest.toString('hex'),
      );
      assert.equal(alias.length, 50);
      aliases.add(alias);
    }
  }
  assert.equal(aliases.size, 4);
});

test('account opener admits only its owner and installation logical names, never supplied physical aliases', async () => {
  const opened: string[] = [],
    hashed: string[] = [];
  const open = createPrivateContentAccountBrowserConnection(
    installationId,
    ownerId,
    async (text) => {
      hashed.push(text);
      return sha256(text);
    },
    async (name) => {
      opened.push(name);
      return connection();
    },
  );
  const logical = privateContentAccountDatabaseName(installationId, ownerId);
  const alias = await privateContentAccountBrowserName(installationId, ownerId, sha256);
  for (const invalid of [
    'cookmate.db',
    alias,
    `./${logical}`,
    `${logical}-journal`,
    `${logical}\n`,
    privateContentAccountDatabaseName(installationId, otherOwnerId),
    privateContentAccountDatabaseName(otherInstallationId, ownerId),
    privateContentDatabaseNames(otherInstallationId).content,
  ])
    await assert.rejects(open(invalid), PrivateContentConfigurationError);
  assert.deepEqual(opened, []);
  assert.deepEqual(hashed, []);
  const guest = privateContentDatabaseNames(installationId);
  await open(guest.cooking);
  await open(guest.content);
  await open(logical);
  await open(logical);
  assert.deepEqual(opened, [
    `cmr-${installationId}-c.db`,
    `cmr-${installationId}-r.db`,
    alias,
    alias,
  ]);
  assert.equal(hashed.length, 1);
});

test('malformed digests including newline suffix never reach a physical opener', async () => {
  for (const digest of [
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    'a'.repeat(64) + '\n',
    'a'.repeat(64) + '\r\n',
  ]) {
    const opened: string[] = [],
      open = createPrivateContentAccountBrowserConnection(
        installationId,
        ownerId,
        async () => digest,
        async (name) => {
          opened.push(name);
          return connection();
        },
      );
    await assert.rejects(
      open(privateContentAccountDatabaseName(installationId, ownerId)),
      PrivateContentConfigurationError,
    );
    assert.deepEqual(opened, []);
  }
});

test('invalid identities do not hash, and hash failure cannot fall back or retry under a shorter name', async () => {
  let hashes = 0,
    opens = 0;
  const failure = new Error('digest unavailable');
  const hash = async () => {
      hashes++;
      throw failure;
    },
    physical = async () => {
      opens++;
      return connection();
    };
  for (const [install, owner] of [
    [installationId, '../owner'],
    [installationId, ownerId.toUpperCase()],
    ['bad-install', ownerId],
    [installationId, ownerId + '\n'],
  ]) {
    assert.throws(
      () => createPrivateContentAccountBrowserConnection(install!, owner!, hash, physical),
      PrivateContentConfigurationError,
    );
  }
  assert.equal(hashes, 0);
  assert.equal(opens, 0);
  const open = createPrivateContentAccountBrowserConnection(
    installationId,
    ownerId,
    hash,
    physical,
  );
  const logical = privateContentAccountDatabaseName(installationId, ownerId);
  await assert.rejects(open(logical), (error) => error === failure);
  await assert.rejects(open(logical), (error) => error === failure);
  assert.equal(hashes, 1);
  assert.equal(opens, 0);
});
