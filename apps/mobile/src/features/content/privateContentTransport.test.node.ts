import assert from 'node:assert/strict';
import { createHash, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test, { type TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import {
  contentOverlaySignaturePayload,
  fingerprintContentOverlay,
  type ContentOverlayManifest,
} from '@cookmate/catalogue/content';
import { readPrivateContentConfiguration, isPrivateContentPath } from './privateContentConfig';
import {
  createPrivateContentTransport,
  PRIVATE_CONTENT_PACKAGE_BYTES,
} from './privateContentTransport';

const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const hashBytes = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: TestContext) {
  const keys = generateKeyPairSync('ed25519');
  const trustKeys = [
    {
      keyId: 'independent-operator-key',
      publicKeyHex: keys.publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(-32)
        .toString('hex'),
    },
  ];
  const calls: { url: string; cookie?: string; authorization?: string }[] = [];
  const image = new Uint8Array([1, 2, 3]);
  const imageHash = await hashBytes(image);
  const manifest: ContentOverlayManifest = {
    formatVersion: 2,
    releaseId: 'release-1',
    sequence: 1,
    previous: null,
    createdAt: '2026-10-01T14:00:00.000Z',
    minimumReaderVersion: 1,
    baseline: catalogue.identity,
    entries: [],
  };
  const fingerprint = await fingerprintContentOverlay(manifest, hash);
  const envelope = {
    manifest,
    fingerprint,
    signature: {
      keyId: trustKeys[0]!.keyId,
      scheme: 'ed25519-hex-v1',
      value: sign(
        null,
        Buffer.from(contentOverlaySignaturePayload(manifest, fingerprint)),
        keys.privateKey,
      ).toString('hex'),
    },
  };
  const payload = {
    formatVersion: 1,
    status: 'issued_export_not_adopted',
    envelope,
    publications: [],
    media: [{ sha256: imageHash, bytes: image.byteLength, mimeType: 'image/png' }],
  };
  const server = createServer((req, res) => {
    calls.push({
      url: req.url ?? '',
      ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    });
    if (req.url?.endsWith('/package')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    } else {
      res.setHeader('content-type', 'image/png');
      res.end(image);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = readPrivateContentConfiguration(
    JSON.stringify({
      version: 1,
      origin,
      installationId: randomUUID(),
      releaseId: manifest.releaseId,
      trustKeys,
    }),
    origin,
  )!;
  const verification = {
    sha256: hash,
    sha256Bytes: hashBytes,
    trustVerifier: createContentTrustVerifier(trustKeys),
    readerVersion: 1,
  };
  const options = { config, verification, newId: randomUUID, fetch: globalThis.fetch };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { options, calls, payload, imageHash, origin };
}

test('real local HTTP and Ed25519 authorize bounded acquisition, without admin credentials or adoption', async (t) => {
  const f = await fixture(t),
    transport = createPrivateContentTransport(f.options);
  const value = await transport.fetchRelease();
  transport.close();
  assert.equal(value.media[0]!.sha256, f.imageHash);
  assert.equal(value.publications.length, 0);
  assert.equal(f.calls.length, 2);
  assert.ok(
    f.calls.every(
      (call) =>
        call.url.startsWith('/cookmate-content/releases/release-1/') &&
        !call.cookie &&
        !call.authorization,
    ),
  );
  await assert.rejects(transport.fetchRelease(), /closed/);
});

test('untrusted signature stops before any media acquisition', async (t) => {
  const f = await fixture(t);
  f.payload.envelope.signature.value = '0'.repeat(128);
  await assert.rejects(createPrivateContentTransport(f.options).fetchRelease(), /signature/);
  assert.equal(f.calls.length, 1);
});

test('media inventory aggregate limits and duplicate hashes stop before media', async (t) => {
  const f = await fixture(t);
  f.payload.media.push({ ...f.payload.media[0]! });
  await assert.rejects(createPrivateContentTransport(f.options).fetchRelease(), /inventory/);
  assert.equal(f.calls.length, 1);
});

test('oversized declared package and foreign response URL are rejected', async (t) => {
  const f = await fixture(t);
  let response = new Response('{}', {
    headers: {
      'content-type': 'application/json',
      'content-length': String(PRIVATE_CONTENT_PACKAGE_BYTES + 1),
    },
  });
  const transport = createPrivateContentTransport({ ...f.options, fetch: async () => response });
  await assert.rejects(transport.fetchRelease(), /verified/);
  response = new Response('{}', { headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: 'https://foreign.invalid/package' });
  await assert.rejects(transport.fetchRelease(), /verified/);
});

test('close interrupts a stalled body immediately and leaves no staged partial package', async (t) => {
  const f = await fixture(t);
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
  const transport = createPrivateContentTransport({ ...f.options, fetch: async () => response });
  const result = transport.fetchRelease();
  await new Promise((resolve) => setImmediate(resolve));
  transport.close();
  await assert.rejects(result, /interrupted|closed/);
  assert.equal(cancelled, true);
});

test('configuration is disabled by default, exact-origin and independent of URL parameters', () => {
  assert.equal(readPrivateContentConfiguration(undefined, 'http://localhost:8081'), null);
  assert.equal(isPrivateContentPath('/private-content'), true);
  assert.equal(isPrivateContentPath('/private-content/unknown'), true);
  assert.equal(isPrivateContentPath('/private-content-other'), false);
  const value = {
    version: 1,
    origin: 'http://localhost:18081',
    installationId: randomUUID(),
    releaseId: 'one',
    trustKeys: [{ keyId: 'one', publicKeyHex: '1'.repeat(64) }],
  };
  const config = readPrivateContentConfiguration(JSON.stringify(value), value.origin)!;
  assert.ok(Object.isFrozen(config.trustKeys[0]));
  for (const invalid of [
    { ...value, origin: 'http://example.com' },
    { ...value, installationId: '../../cookmate.db' },
    { ...value, secret: 'forbidden' },
    { ...value, releaseId: '../admin' },
  ]) {
    assert.throws(() => readPrivateContentConfiguration(JSON.stringify(invalid), value.origin));
  }
  assert.throws(() =>
    readPrivateContentConfiguration(JSON.stringify(value), 'http://localhost:8081'),
  );
});
