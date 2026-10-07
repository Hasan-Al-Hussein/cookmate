import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { access, link, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import {
  readAdminPublicationConfiguration,
  type AdminPublicationConfiguration,
} from '../src/publishing/runtime';
import { IssuedOverlayStore } from '../src/publishing/issuedStore';
import { buildAdminServer } from '../src/server';
import { fixture } from './helpers';

const failure = {
  code: 'publication_configuration',
  message: 'Private publication configuration is unavailable or invalid.',
};
function keyMaterial() {
  const pair = generateKeyPairSync('ed25519');
  return {
    pem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    privateKey: pair.privateKey,
    trustedKeys: [
      {
        keyId: 'fixture-key',
        publicKeyHex: Buffer.from(
          pair.publicKey.export({ format: 'jwk' }).x!,
          'base64url',
        ).toString('hex'),
      },
    ],
  };
}

test('omitted optional configuration reads no file, and explicit trusted key configuration remains private until enabled', async (t) => {
  assert.equal(
    await readAdminPublicationConfiguration('nonexistent-relative-directory'),
    undefined,
  );
  const f = await fixture(t);
  const key = keyMaterial();
  const filename = join(f.directory, 'publication.json');
  const config = {
    schemaVersion: 1,
    keyId: 'fixture-key',
    privateKeyFile: 'fixture.pem',
    trustedKeys: key.trustedKeys,
  };
  await writeFile(join(f.directory, 'fixture.pem'), key.pem);
  await writeFile(filename, JSON.stringify(config));
  const loaded = await readAdminPublicationConfiguration(f.directory, filename);
  assert.equal(loaded!.signingPrivateKey, key.pem);
  assert.deepEqual(loaded!.trustedKeys, key.trustedKeys);
  assert.equal(loaded!.issuedDatabaseFile, join(f.directory, 'issued-content.sqlite'));
  await assert.rejects(access(loaded!.issuedDatabaseFile), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.directory, 'fixture.pem'), 'utf8'), key.pem);
  await f.app.close();
  const configured = buildAdminServer({ ...f.options, publication: loaded! });
  await configured.ready();
  await configured.close();
  // Closing releases both databases so the exact private configuration can reopen.
  const reopened = buildAdminServer({ ...f.options, publication: loaded! });
  await reopened.ready();
  await reopened.close();
});

test('configuration rejects malformed, unbounded, non-sibling and untrusted material without exposing secret text', async (t) => {
  const f = await fixture(t);
  const key = keyMaterial();
  const filename = join(f.directory, 'publication.json');
  const pemFile = join(f.directory, 'fixture.pem');
  const config = {
    schemaVersion: 1,
    keyId: 'fixture-key',
    privateKeyFile: 'fixture.pem',
    trustedKeys: key.trustedKeys,
  };
  await writeFile(pemFile, key.pem);
  const invalid: unknown[] = [
    {},
    { ...config, extra: true },
    { ...config, schemaVersion: 2 },
    { ...config, keyId: 'fixture-key\n' },
    { ...config, privateKeyFile: '../fixture.pem' },
    { ...config, privateKeyFile: pemFile },
    { ...config, privateKeyFile: 'fixture.pem\n' },
    { ...config, privateKeyFile: 'publication.json' },
    { ...config, trustedKeys: [] },
    { ...config, trustedKeys: [...key.trustedKeys, ...key.trustedKeys] },
    { ...config, trustedKeys: keyMaterial().trustedKeys },
    { ...config, trustedKeys: [{ ...key.trustedKeys[0], extra: 'untrusted' }] },
  ];
  for (const value of invalid) {
    await writeFile(filename, JSON.stringify(value));
    await assert.rejects(readAdminPublicationConfiguration(f.directory, filename), failure);
  }
  for (const value of ['{broken', 'x'.repeat(16 * 1024 + 1)]) {
    await writeFile(filename, value);
    await assert.rejects(readAdminPublicationConfiguration(f.directory, filename), failure);
  }
  await writeFile(filename, JSON.stringify(config));
  for (const value of ['synthetic-private-secret-invalid', 'x'.repeat(16 * 1024 + 1), '']) {
    await writeFile(pemFile, value);
    await assert.rejects(readAdminPublicationConfiguration(f.directory, filename), failure);
  }
  await writeFile(pemFile, key.pem);
  const nested = join(f.directory, 'nested');
  await mkdir(nested);
  await assert.rejects(readAdminPublicationConfiguration(nested, filename), failure);
  await assert.rejects(readAdminPublicationConfiguration(f.directory, 'publication.json'), failure);
  const alias = join(f.directory, 'alias.json');
  await link(filename, alias);
  await assert.rejects(readAdminPublicationConfiguration(f.directory, alias), failure);
  await assert.rejects(access(join(f.directory, 'issued-content.sqlite')), { code: 'ENOENT' });
});

test('server rejects untrusted signer and admin database aliases before issuance journal creation, with reusable lifecycle', async (t) => {
  const f = await fixture(t);
  await f.app.close();
  const key = keyMaterial();
  const publication: AdminPublicationConfiguration = {
    issuedDatabaseFile: join(f.directory, 'issued.sqlite'),
    signingKeyId: 'fixture-key',
    signingPrivateKey: key.privateKey,
    trustedKeys: key.trustedKeys,
  };
  for (const patch of [
    { trustedKeys: keyMaterial().trustedKeys },
    { trustedKeys: [] },
    { signingPrivateKey: 'synthetic-private-key' },
    { issuedDatabaseFile: f.filename },
    { issuedDatabaseFile: f.filename + '-wal' },
    { issuedDatabaseFile: f.filename + '-shm' },
    { issuedDatabaseFile: 'relative.sqlite' },
  ])
    assert.throws(
      () => buildAdminServer({ ...f.options, publication: { ...publication, ...patch } }),
      failure,
    );
  await assert.rejects(access(publication.issuedDatabaseFile), { code: 'ENOENT' });
  const alias = join(f.directory, 'admin-alias.sqlite');
  await link(f.filename, alias);
  assert.throws(
    () =>
      buildAdminServer({
        ...f.options,
        publication: { ...publication, issuedDatabaseFile: alias },
      }),
    failure,
  );
  const app = buildAdminServer({ ...f.options, publication });
  await app.ready();
  await app.close();
});

test('issuance schema version one upgrades separately and transaction failure leaves its original journal untouched', async (t) => {
  const f = await fixture(t);
  const filename = join(f.directory, 'legacy-issued.sqlite');
  const trust = createContentTrustVerifier(keyMaterial().trustedKeys);
  const store = new IssuedOverlayStore(filename, trust);
  store.close();
  const sql = new DatabaseSync(filename);
  sql.exec(`DROP TABLE issued_cancelled; UPDATE issued_meta SET version=1;
    CREATE TRIGGER fixture_fail BEFORE UPDATE OF version ON issued_meta BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END;`);
  assert.throws(() => new IssuedOverlayStore(filename, trust), /fixture migration failure/);
  assert.equal(sql.prepare('SELECT version FROM issued_meta').get()!.version, 1);
  assert.equal(
    sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='issued_cancelled'").get()!.n,
    0,
  );
  sql.exec('DROP TRIGGER fixture_fail');
  const migrated = new IssuedOverlayStore(filename, trust);
  assert.equal(migrated.head(), null);
  assert.equal(sql.prepare('SELECT version FROM issued_meta').get()!.version, 2);
  migrated.close();
  sql.close();
  const admin = new DatabaseSync(f.filename);
  assert.equal(
    admin.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'issued_%'").get()!.n,
    0,
  );
  admin.close();
});
