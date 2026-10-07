import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { existsSync, linkSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { catalogue } from '@cookmate/catalogue';
import { PUBLICATION_MAX_BYTES, type OverlayHead } from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { authoredFixture } from '../../../packages/catalogue/test/content-fixtures';
import { member, published } from '../../../packages/catalogue/test/content-overlay-fixtures';
import { sha256 } from '../src/drafts/repository';
import { createContentOverlaySigner } from '../src/publishing/signer';
import { fingerprintIssuanceRequest, IssuedOverlayStore } from '../src/publishing/issuedStore';
import {
  ConsumerDeliveryError,
  openConsumerContentDelivery,
  type ConsumerContentDelivery,
  type ConsumerDeliveryFailure,
} from '../src/publishing/consumerDelivery';
import { registerConsumerContentRoutes } from '../src/publishing/consumerRoutes';
import { createPrivateContentTransport } from '../../mobile/src/features/content/privateContentTransport';

// Real SQLite, real Ed25519 and actual PNG bytes. Editorial permissions are explicit synthetic
// fixture assertions. Fastify inject tests route behavior without starting a listening server.
const origin = 'http://127.0.0.1:3456';
const failure = (code: ConsumerDeliveryFailure) => (error: unknown) =>
  error instanceof ConsumerDeliveryError && error.code === code;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-consumer-delivery-test-'));
  const filename = join(directory, 'issued.sqlite');
  const pair = generateKeyPairSync('ed25519');
  const trustedKeys = [
    {
      keyId: 'consumer-delivery-fixture',
      publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
        'hex',
      ),
    },
  ];
  const signer = createContentOverlaySigner({
    keyId: trustedKeys[0]!.keyId,
    privateKey: pair.privateKey,
  });
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#255040' } })
    .png()
    .toBuffer();
  const mediaHash = sha256(bytes);
  const document = authoredFixture();
  document.recipe.photoKey = `photos/${mediaHash}.png`;
  document.media[0] = {
    ...document.media[0]!,
    assetId: `sha256:${mediaHash}`,
    sha256: mediaHash,
    bytes: bytes.length,
    mimeType: 'image/png',
    photoKey: document.recipe.photoKey,
    dimensions: { ...document.media[0]!.dimensions!, width: 3, height: 2 },
  };
  const publication = await published(document);
  const issued = new IssuedOverlayStore(filename, createContentTrustVerifier(trustedKeys));
  let head: OverlayHead | null = null;
  const envelopes = [];
  try {
    for (const sequence of [1, 2, 3]) {
      const envelope = await signer.signManifest({
        formatVersion: 2,
        releaseId: `consumer-${sequence}`,
        sequence,
        previous: head,
        createdAt: '2026-10-01T12:00:00.000Z',
        minimumReaderVersion: 1,
        baseline: { ...catalogue.identity },
        entries:
          sequence === 3
            ? [
                {
                  state: 'withdrawn',
                  recipeId: document.recipe.recipeId,
                  reason: 'Fixture withdrawal',
                },
              ]
            : [member(publication)],
      });
      issued.commit({
        expectedHead: head,
        receipt: {
          status: 'issued_not_activated',
          actorId: 'fixture-operator',
          operationId: `operation-${sequence}`,
          requestFingerprint: fingerprintIssuanceRequest(head, envelope.manifest.entries),
          envelope,
        },
        publications: sequence === 1 ? [publication] : [],
        media: sequence === 1 ? [{ hash: mediaHash, bytes }] : [],
        assertActor() {},
        assertAuthority() {},
      });
      envelopes.push(envelope);
      head = {
        releaseId: envelope.manifest.releaseId,
        sequence,
        fingerprint: envelope.fingerprint,
      };
    }
  } finally {
    issued.close();
  }
  const readers: ConsumerContentDelivery[] = [];
  const apps: FastifyInstance[] = [];
  t.after(async () => {
    for (const app of apps) await app.close();
    for (const reader of readers) await reader.close();
    const target = resolve(directory);
    const child = relative(resolve(tmpdir()), target);
    assert.ok(
      !child.startsWith('..') &&
        !isAbsolute(child) &&
        child.startsWith('cookmate-consumer-delivery-test-'),
    );
    await rm(target, { recursive: true, force: true });
  });
  const options = {
    issuedDatabaseFile: filename,
    trustedKeys,
    allowedReleaseIds: ['consumer-1', 'consumer-2', 'consumer-3'],
  };
  function open(input = options) {
    const reader = openConsumerContentDelivery(input);
    readers.push(reader);
    return reader;
  }
  function mutate(work: (db: DatabaseSync) => void) {
    const db = new DatabaseSync(filename);
    try {
      work(db);
    } finally {
      db.close();
    }
  }
  return {
    directory,
    filename,
    options,
    open,
    mutate,
    envelopes,
    publication,
    bytes,
    mediaHash,
    snapshot: () => createHash('sha256').update(readFileSync(filename)).digest('hex'),
    async app(configuredOrigin = origin) {
      const app = Fastify({ logger: false, trustProxy: false });
      apps.push(app);
      const reader = open();
      registerConsumerContentRoutes(app, { origin: configuredOrigin, delivery: reader });
      await app.ready();
      return { app, reader };
    },
  };
}

test('read-only consumer serves exact signed packages and copied member bytes, preserving the sequential archive', async (t) => {
  const f = await fixture(t),
    reader = f.open(),
    before = f.snapshot();
  const first = await reader.readPackage('consumer-1');
  assert.equal(first.status, 'issued_export_not_adopted');
  assert.deepEqual(first.envelope, f.envelopes[0]);
  assert.deepEqual(first.publications, [f.publication]);
  assert.deepEqual(first.media, [
    { sha256: f.mediaHash, bytes: f.bytes.length, mimeType: 'image/png' },
  ]);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.envelope.manifest));
  const media = await reader.readMedia('consumer-1', f.mediaHash);
  assert.deepEqual(media.bytes, f.bytes);
  media.bytes[0] = 0;
  assert.deepEqual((await reader.readMedia('consumer-1', f.mediaHash)).bytes, f.bytes);
  const second = await reader.readPackage('consumer-2');
  assert.deepEqual(second.envelope, f.envelopes[1]);
  assert.deepEqual(second.publications, []);
  assert.deepEqual(second.media, []);
  await assert.rejects(reader.readMedia('consumer-2', f.mediaHash), failure('not_found'));
  const third = await reader.readPackage('consumer-3');
  assert.equal(third.envelope.manifest.entries[0]!.state, 'withdrawn');
  assert.deepEqual(
    (await reader.readPackage('consumer-1')).envelope,
    first.envelope,
    'historical delivery never claims current adoption',
  );
  await reader.close();
  assert.equal(f.snapshot(), before);
});

test('explicit allowlist, independent keys and options are owned before delivery; no latest or arbitrary media access', async (t) => {
  const f = await fixture(t);
  const options = {
    ...f.options,
    trustedKeys: f.options.trustedKeys.map((key) => ({ ...key })),
    allowedReleaseIds: ['consumer-1'],
  };
  const reader = f.open(options);
  options.allowedReleaseIds.push('consumer-2');
  options.trustedKeys[0]!.publicKeyHex = 'f'.repeat(64);
  assert.equal((await reader.readPackage('consumer-1')).envelope.manifest.sequence, 1);
  for (const id of ['consumer-2', 'latest', 'missing'])
    await assert.rejects(reader.readPackage(id), failure('not_found'));
  await assert.rejects(reader.readMedia('consumer-1', 'c'.repeat(64)), failure('not_found'));
  await assert.rejects(reader.readPackage('../admin.sqlite'), failure('invalid_request'));
  await assert.rejects(
    reader.readMedia('consumer-1', '../../private-key'),
    failure('invalid_request'),
  );
  const foreign = generateKeyPairSync('ed25519');
  const wrong = f.open({
    ...f.options,
    trustedKeys: [
      {
        keyId: f.options.trustedKeys[0]!.keyId,
        publicKeyHex: Buffer.from(
          foreign.publicKey.export({ format: 'jwk' }).x!,
          'base64url',
        ).toString('hex'),
      },
    ],
  });
  await assert.rejects(wrong.readPackage('consumer-1'), failure('unavailable'));
});

test('configuration rejects missing, aliased and unmigrated files without creating or modifying a database', async (t) => {
  const f = await fixture(t);
  const absent = join(f.directory, 'absent.sqlite');
  assert.throws(() => f.open({ ...f.options, issuedDatabaseFile: absent }), failure('unavailable'));
  assert.equal(existsSync(absent), false);
  assert.throws(
    () => f.open({ ...f.options, issuedDatabaseFile: f.directory }),
    failure('unavailable'),
  );
  const alias = join(f.directory, 'issued-alias.sqlite');
  linkSync(f.filename, alias);
  try {
    assert.throws(
      () => f.open({ ...f.options, issuedDatabaseFile: alias }),
      failure('unavailable'),
    );
  } finally {
    unlinkSync(alias);
  }
  const junction = join(f.directory, 'directory-alias');
  symlinkSync(f.directory, junction, 'junction');
  try {
    assert.throws(
      () => f.open({ ...f.options, issuedDatabaseFile: join(junction, basename(f.filename)) }),
      failure('unavailable'),
    );
  } finally {
    unlinkSync(junction);
  }
  f.mutate((db) => db.exec('UPDATE issued_meta SET version=1'));
  const before = f.snapshot();
  assert.throws(() => f.open(), failure('unavailable'));
  assert.equal(f.snapshot(), before, 'read-only open never upgrades an earlier issuance schema');
});

test('bounded configuration rejects duplicate/excessive IDs and accessors without executing them', async (t) => {
  const f = await fixture(t);
  for (const allowedReleaseIds of [
    [],
    ['consumer-1', 'consumer-1'],
    Array.from({ length: 257 }, (_, i) => `release-${i}`),
  ])
    assert.throws(() => f.open({ ...f.options, allowedReleaseIds }), failure('unavailable'));
  let reads = 0;
  const accessor = {
    ...f.options,
    get trustedKeys() {
      reads++;
      return f.options.trustedKeys;
    },
  };
  assert.throws(() => f.open(accessor), failure('unavailable'));
  assert.equal(reads, 0);
});

test('corrupt issuance version is denied without hydrating an oversized metadata scalar', async (t) => {
  const f = await fixture(t);
  f.mutate((db) => db.exec("UPDATE issued_meta SET version=printf('%*s',2097152,'corrupt')"));
  const before = f.snapshot();
  const prepare = DatabaseSync.prototype.prepare;
  let metadataReads = 0;
  let hydratedBytes = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.includes('FROM issued_meta')) {
      metadataReads++;
      for (const value of Object.values(statement.get() ?? {})) {
        if (typeof value === 'string') hydratedBytes += Buffer.byteLength(value);
      }
    }
    return statement;
  });
  assert.throws(() => f.open(), failure('unavailable'));
  assert.equal(metadataReads, 1);
  assert.equal(hydratedBytes, 0);
  assert.equal(f.snapshot(), before);
});

test('signature, publication and image tampering fail closed without leaking private paths', async (t) => {
  const f = await fixture(t),
    reader = f.open();
  const original = JSON.stringify(f.envelopes[0]);
  f.mutate((db) =>
    db
      .prepare(
        "UPDATE issued_release SET document=json_set(document,'$.signature.value',?) WHERE id='consumer-1'",
      )
      .run('A'.repeat(86)),
  );
  await assert.rejects(reader.readPackage('consumer-1'), failure('unavailable'));
  f.mutate((db) =>
    db.prepare("UPDATE issued_release SET document=? WHERE id='consumer-1'").run(original),
  );
  const publication = JSON.stringify(f.publication);
  f.mutate((db) =>
    db.exec(
      "UPDATE issued_publication SET document=json_set(document,'$.revision.document.recipe.title','Altered unsigned draft text')",
    ),
  );
  await assert.rejects(reader.readPackage('consumer-1'), failure('unavailable'));
  f.mutate((db) => db.prepare('UPDATE issued_publication SET document=?').run(publication));
  f.mutate((db) => db.prepare('UPDATE issued_media SET bytes=?').run(Buffer.alloc(f.bytes.length)));
  await assert.rejects(reader.readMedia('consumer-1', f.mediaHash), (error) => {
    assert.ok(failure('unavailable')(error));
    assert.equal(String(error).includes(f.directory), false);
    assert.equal(String(error).includes('privateKey'), false);
    return true;
  });
});

test('stored publication bounds reject before an unbounded body select and do not rewrite corruption', async (t) => {
  const f = await fixture(t),
    reader = f.open();
  f.mutate((db) =>
    db
      .prepare("UPDATE issued_publication SET document=printf('%*s',?,'')")
      .run(PUBLICATION_MAX_BYTES + 1),
  );
  const before = f.snapshot();
  const prepare = DatabaseSync.prototype.prepare;
  let rawReads = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql.includes('SELECT recipe,revision,document FROM issued_publication')) rawReads++;
    return prepare.call(this, sql);
  });
  await assert.rejects(reader.readPackage('consumer-1'), failure('too_large'));
  assert.equal(rawReads, 0);
  assert.equal(f.snapshot(), before);
});

test('one in-flight read is admitted; closing revokes its delivery and drains before idempotent close', async (t) => {
  const f = await fixture(t),
    reader = f.open();
  const pending = reader.readPackage('consumer-1');
  await assert.rejects(reader.readPackage('consumer-1'), failure('busy'));
  // Start a fresh read without yielding: signature verification crosses an asynchronous boundary.
  await pending;
  const interrupted = reader.readMedia('consumer-1', f.mediaHash);
  const closed = reader.close();
  assert.equal(reader.close(), closed);
  await assert.rejects(interrupted, failure('unavailable'));
  await closed;
  await assert.rejects(reader.readPackage('consumer-1'), failure('unavailable'));
});

test('consumer routes serve exact bytes with isolation headers and no administrator surface', async (t) => {
  const f = await fixture(t),
    { app } = await f.app();
  const headers = { host: '127.0.0.1:3456', origin };
  const response = await app.inject({
    method: 'GET',
    url: '/cookmate-content/releases/consumer-1/package',
    headers,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().envelope, f.envelopes[0]);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  const media = await app.inject({
    method: 'GET',
    url: `/cookmate-content/releases/consumer-1/media/${f.mediaHash}`,
    headers,
  });
  assert.equal(media.statusCode, 200);
  assert.equal(media.headers['content-type'], 'image/png');
  assert.equal(Number(media.headers['content-length']), f.bytes.length);
  assert.deepEqual(media.rawPayload, f.bytes);
  for (const url of [
    '/admin/api/session',
    '/admin/api/drafts',
    '/admin/api/publication/releases/current',
  ]) {
    const denied = await app.inject({ method: 'GET', url, headers });
    assert.equal(denied.statusCode, 404);
  }
});

test('consumer route origin, remote peer, query and credential admission cannot be widened by request input', async (t) => {
  const f = await fixture(t),
    { app } = await f.app();
  const url = '/cookmate-content/releases/consumer-1/package';
  const base = { host: '127.0.0.1:3456', origin };
  for (const headers of [
    { ...base, host: 'evil.invalid' },
    { ...base, origin: 'https://evil.invalid' },
    { ...base, cookie: 'cookmate_admin=unused' },
    { ...base, authorization: 'Bearer unused' },
    { ...base, 'sec-fetch-site': 'cross-site' },
  ]) {
    const response = await app.inject({ method: 'GET', url, headers });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(
    (await app.inject({ method: 'GET', url, headers: base, remoteAddress: '203.0.113.10' }))
      .statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: `${url}?destination=other`, headers: base }))
      .statusCode,
    400,
  );
  assert.equal((await app.inject({ method: 'POST', url, headers: base })).statusCode, 404);
  const another = Fastify();
  try {
    assert.throws(
      () =>
        registerConsumerContentRoutes(another, {
          origin: 'https://public.invalid',
          delivery: f.open(),
        }),
      failure('unavailable'),
    );
  } finally {
    await another.close();
  }
});

test(
  'real loopback HTTP connects mobile transport to the signed SQLite delivery without credentials or flattened ancestry',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    // Reserve a new loopback-only port; no existing app, admin fixture or Metro listener is touched.
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const localOrigin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done, reject) =>
      reservation.close((error) => (error ? reject(error) : done())),
    );
    const { app } = await f.app(localOrigin);
    await app.listen({ host: '127.0.0.1', port: address.port });
    const calls: { url: string; credentials?: RequestCredentials; redirect?: RequestRedirect }[] =
      [];
    const transports: ReturnType<typeof createPrivateContentTransport>[] = [];
    try {
      for (const releaseId of ['consumer-1', 'consumer-2']) {
        const transport = createPrivateContentTransport({
          config: {
            version: 1,
            origin: localOrigin,
            installationId: randomUUID(),
            releaseId,
            trustKeys: f.options.trustedKeys,
          },
          newId: randomUUID,
          verification: {
            sha256: async (text) => sha256(text),
            sha256Bytes: async (bytes) => sha256(Buffer.from(bytes)),
            trustVerifier: createContentTrustVerifier(f.options.trustedKeys),
            readerVersion: 1,
          },
          fetch(url, options) {
            calls.push({
              url,
              ...(options.credentials ? { credentials: options.credentials } : {}),
              ...(options.redirect ? { redirect: options.redirect } : {}),
            });
            return fetch(url, options);
          },
        });
        transports.push(transport);
        const stage = await transport.fetchRelease();
        assert.ok(stage.envelope);
        assert.deepEqual(stage.envelope, f.envelopes[releaseId === 'consumer-1' ? 0 : 1]);
        if (releaseId === 'consumer-1') {
          assert.deepEqual(stage.publications, [f.publication]);
          assert.deepEqual(Buffer.from(stage.media[0]!.bytes), f.bytes);
        } else {
          assert.deepEqual(stage.publications, []);
          assert.deepEqual(stage.media, []);
          assert.deepEqual(stage.envelope.manifest.previous, {
            releaseId: 'consumer-1',
            sequence: 1,
            fingerprint: f.envelopes[0]!.fingerprint,
          });
        }
      }
      assert.deepEqual(
        calls.map((call) => call.url),
        [
          `${localOrigin}/cookmate-content/releases/consumer-1/package`,
          `${localOrigin}/cookmate-content/releases/consumer-1/media/${f.mediaHash}`,
          `${localOrigin}/cookmate-content/releases/consumer-2/package`,
        ],
      );
      assert.ok(calls.every((call) => call.credentials === 'omit' && call.redirect === 'error'));
    } finally {
      for (const transport of transports) transport.close();
      await app.close();
    }
  },
);
