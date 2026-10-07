import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, symlinkSync, unlinkSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { catalogue } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import {
  ConsumerDeliveryError,
  type ConsumerContentDelivery,
} from '../src/publishing/consumerDelivery';
import { buildConsumerReviewServer } from '../src/publishing/consumerServer';
import {
  openOrdinaryBrowserDelivery,
  prepareOrdinaryBrowserFixture,
  readOrdinaryBrowserFixture,
} from './ordinary-browser-fixture';

// Inject-only HTTP tests: no listener, existing preview, or user workspace is opened.
const origin = 'http://127.0.0.1:3489';
const headers = { host: '127.0.0.1:3489', origin };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-consumer-server-test-'));
  const root = join(directory, 'web');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Isolated fixture</title>');
  await writeFile(join(root, 'app.js'), 'fixture source');
  await writeFile(join(root, 'empty.css'), '');
  let reads = 0,
    closes = 0;
  const delivery: ConsumerContentDelivery = {
    async readPackage() {
      reads++;
      throw new ConsumerDeliveryError('not_found');
    },
    async readMedia() {
      reads++;
      throw new ConsumerDeliveryError('not_found');
    },
    async close() {
      closes++;
    },
  };
  const app = buildConsumerReviewServer({ origin, webRoot: root, delivery });
  t.after(async () => {
    await app.close();
    const child = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(
      !child.startsWith('..') &&
        !isAbsolute(child) &&
        child.startsWith('cookmate-consumer-server-test-'),
    );
    await rm(directory, { recursive: true, force: true });
  });
  await app.ready();
  return { app, root, directory, delivery, counts: () => ({ reads, closes }) };
}

test('exported ordinary deep links and exact assets retain isolation headers without opening content', async (t) => {
  const f = await fixture(t);
  for (const url of [
    '/',
    '/private-content',
    '/plan',
    '/plan/',
    '/favourites',
    '/settings',
    '/manual-shopping?create=1',
    '/collections',
    '/collection/10000000-0000-4000-8000-000000000001',
    '/plan-edit',
    '/shopping-meals',
    '/cooking-history',
    '/recipe/52819?contentRef=exact',
    '/recipe-personal/52819',
  ]) {
    const response = await f.app.inject({ method: 'GET', url, headers });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /Isolated fixture/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
    assert.equal(response.headers['cross-origin-embedder-policy'], 'require-corp');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const script = await f.app.inject({ method: 'GET', url: '/app.js', headers });
  assert.equal(script.body, 'fixture source');
  assert.equal(Number(script.headers['content-length']), Buffer.byteLength(script.body));
  const empty = await f.app.inject({ method: 'GET', url: '/empty.css', headers });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.body, '');
  assert.equal(empty.headers['content-length'], '0');
  assert.deepEqual(f.counts(), { reads: 0, closes: 0 });
  const missing = await f.app.inject({
    method: 'GET',
    url: '/cookmate-content/releases/fixture/package',
    headers,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(f.counts().reads, 1, 'content route uses only its delivery port');
  await f.app.close();
  assert.equal(f.counts().closes, 1);
});

test('private static origin and path admission expose neither administrator routes nor arbitrary files', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'private.sqlite'), 'not an export asset');
  await writeFile(join(f.directory, 'outside.js'), 'outside directory');
  for (const url of [
    '/admin/api/session',
    '/cookmate-content/private.json',
    '/private.sqlite',
    '/%2e%2e/outside.js',
    '/%5coutside.js',
    '/.env',
    '/missing.js',
    '/unknown',
    '//',
    '/recipe/not-a-recipe',
    '/recipe/52819/extra',
    '/recipe-personal/52819/extra',
    '/manual-shopping/extra',
    '/collection/not-a-collection',
    '/collection/10000000-0000-4000-8000-000000000001/extra',
    '/private-content/unknown',
  ]) {
    const response = await f.app.inject({ method: 'GET', url, headers });
    assert.equal(response.statusCode, 404, url);
    assert.equal(response.body.includes(f.directory), false);
    assert.equal(response.body.includes('outside directory'), false);
  }
  for (const rejected of [
    { ...headers, host: 'other.invalid' },
    { ...headers, origin: 'http://other.invalid' },
    { ...headers, 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal(
      (await f.app.inject({ method: 'GET', url: '/', headers: rejected })).statusCode,
      403,
    );
  }
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/', headers, remoteAddress: '203.0.113.1' }))
      .statusCode,
    403,
  );
  assert.equal((await f.app.inject({ method: 'POST', url: '/', headers })).statusCode, 404);
  assert.throws(
    () =>
      buildConsumerReviewServer({
        origin: 'http://0.0.0.0:3489',
        webRoot: f.root,
        delivery: f.delivery,
      }),
    /127.0.0.1/,
  );
});

test('disposable ordinary preparation issues a labelled signed revision with separate public configuration and owned storage', async (t) => {
  await assert.rejects(prepareOrdinaryBrowserFixture('http://localhost:3456'), /127\.0\.0\.1/);
  await assert.rejects(prepareOrdinaryBrowserFixture('http://127.0.0.1:3456/'), /127\.0\.0\.1/);
  const manifest = await prepareOrdinaryBrowserFixture('http://127.0.0.1:3456');
  // Retained deliberately for inspection; no browser store or HTTP listener is opened.
  t.diagnostic(`Retained disposable fixture: ${manifest.directory}`);
  assert.deepEqual(await readOrdinaryBrowserFixture(manifest.directory), manifest);
  assert.deepEqual(manifest.baseline, catalogue.identity);
  assert.equal(manifest.issuedHead.sequence, 1);
  assert.match(
    manifest.config.installationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(manifest.recipe.ref.recipeId, catalogue.recipes[0]!.recipeId);
  assert.deepEqual(await readdir(join(manifest.directory, 'web')), []);
  const configFile = join(manifest.directory, 'ordinary-config.json');
  const config = await readFile(configFile, 'utf8');
  assert.equal(config, canonicalContentJson(manifest.config));
  assert.deepEqual(Object.keys(JSON.parse(config)).sort(), [
    'installationId',
    'origin',
    'releaseId',
    'trustKeys',
    'version',
  ]);
  const delivery = await openOrdinaryBrowserDelivery(manifest);
  try {
    const issued = await delivery.readPackage(manifest.config.releaseId);
    assert.equal(issued.status, 'issued_export_not_adopted');
    assert.equal(issued.envelope.fingerprint, manifest.issuedHead.fingerprint);
    assert.deepEqual(issued.envelope.manifest.baseline, catalogue.identity);
    assert.equal(issued.publications.length, 1);
    const publication = issued.publications[0]!;
    const document = publication.revision.document;
    assert.equal(document.kind, 'authored');
    assert.deepEqual(publication.revision.ref, manifest.recipe.ref);
    assert.equal(document.recipe.title, manifest.recipe.title);
    assert.deepEqual(
      document.recipe.ingredients.map(({ position, rawName, rawMeasure }) => ({
        position,
        rawName,
        rawMeasure,
      })),
      catalogue.recipes[0]!.ingredients.map(({ position, rawName, rawMeasure }) => ({
        position,
        rawName,
        rawMeasure,
      })),
    );
    assert.deepEqual(
      document.recipe.instructions.map(({ sequence, rawText, presentation }) => ({
        sequence,
        rawText,
        presentation,
      })),
      catalogue.recipes[0]!.instructions.map(({ sequence, rawText, presentation }) => ({
        sequence,
        rawText,
        presentation,
      })),
    );
    assert.ok(publication.permissions.length >= 2);
    assert.ok(
      publication.permissions.every(
        (permission) =>
          permission.statement ===
          'Synthetic disposable test assertion only; not actual rights permission.',
      ),
    );
    assert.ok(issued.media.length > 0);
    for (const descriptor of issued.media) {
      const media = await delivery.readMedia(manifest.config.releaseId, descriptor.sha256);
      assert.equal(media.bytes.byteLength, descriptor.bytes);
      assert.equal(createHash('sha256').update(media.bytes).digest('hex'), descriptor.sha256);
    }
    await assert.rejects(delivery.readPackage('unknown-release'), ConsumerDeliveryError);
  } finally {
    await delivery.close();
  }
  await assert.rejects(delivery.readPackage(manifest.config.releaseId), ConsumerDeliveryError);
  await assert.rejects(
    openOrdinaryBrowserDelivery({
      ...manifest,
      recipe: { ...manifest.recipe, title: 'Disposable proof: tampered title' },
    }),
    /owned fixture manifest/,
  );
  await writeFile(
    configFile,
    canonicalContentJson({ ...manifest.config, installationId: 'changed-installation' }),
  );
  await assert.rejects(
    readOrdinaryBrowserFixture(manifest.directory),
    /configuration no longer matches/,
  );
  await writeFile(configFile, config);
  const manifestFile = join(manifest.directory, 'fixture.json');
  const serialized = await readFile(manifestFile, 'utf8');
  await writeFile(manifestFile, canonicalContentJson({ ...manifest, unexpected: 'field' }));
  await assert.rejects(readOrdinaryBrowserFixture(manifest.directory), /identity is invalid/);
  await writeFile(manifestFile, 'x'.repeat(16_385));
  await assert.rejects(readOrdinaryBrowserFixture(manifest.directory), /owned bounded file/);
  await writeFile(manifestFile, serialized);
  assert.deepEqual(await readOrdinaryBrowserFixture(manifest.directory), manifest);
});

test('static admission rejects aliased directories and oversized files before streaming', async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias');
  symlinkSync(f.directory, alias, 'junction');
  try {
    assert.equal(
      (await f.app.inject({ method: 'GET', url: '/alias/web/app.js', headers })).statusCode,
      404,
    );
    assert.throws(
      () =>
        buildConsumerReviewServer({ origin, webRoot: join(alias, 'web'), delivery: f.delivery }),
      /exported web directory/,
    );
  } finally {
    unlinkSync(alias);
  }
  const large = join(f.root, 'large.js');
  await writeFile(large, '');
  await truncate(large, 64 * 1024 * 1024 + 1);
  const response = await f.app.inject({ method: 'GET', url: '/large.js', headers });
  assert.equal(response.statusCode, 404);
  assert.ok(response.rawPayload.byteLength < 1024);
});

test('asset growth after stat cannot stream beyond the admitted byte range', async (t) => {
  const f = await fixture(t);
  const filename = join(f.root, 'app.js');
  const probe = await open(filename, 'r');
  const prototype: Pick<FileHandle, 'createReadStream'> = Object.getPrototypeOf(probe);
  const createReadStream = prototype.createReadStream;
  await probe.close();
  let streams = 0;
  t.mock.method(
    prototype,
    'createReadStream',
    function (this: FileHandle, options: Parameters<FileHandle['createReadStream']>[0]) {
      streams++;
      appendFileSync(filename, ' bytes added after admission');
      return createReadStream.call(this, options);
    },
  );
  const response = await f.app.inject({ method: 'GET', url: '/app.js', headers });
  assert.equal(streams, 1);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'fixture source');
  assert.equal(Number(response.headers['content-length']), Buffer.byteLength(response.body));
});
