import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { catalogue } from '@cookmate/catalogue';
import { fixture, multipartPhoto } from './helpers';
import { sha256 } from '../src/drafts/repository';
import { MAX_UPLOAD_BYTES } from '../src/media/service';

async function picture(colour = 'red') {
  return sharp({ create: { width: 40, height: 30, channels: 3, background: colour } })
    .png()
    .withMetadata({ exif: { IFD0: { Artist: 'private fixture metadata' } } })
    .toBuffer();
}
test('photo bytes are decoded, metadata stripped, immutable and recoverable without auto-attachment', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const draft = await c.create();
  const upload = multipartPhoto(await picture());
  const headers = { ...upload.headers, 'x-operation-id': 'upload-one', 'x-draft-revision': '1' };
  const first = await c.request(
    'POST',
    `/admin/api/drafts/${draft.draft.draftId}/media`,
    upload.payload,
    headers,
  );
  assert.equal(first.statusCode, 200, first.body);
  const asset = first.json();
  assert.equal(asset.width, 40);
  assert.equal(asset.height, 30);
  assert.equal(asset.rightsStatus, 'unreviewed');
  assert.match(asset.assetId, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    (
      await c.request(
        'POST',
        `/admin/api/drafts/${draft.draft.draftId}/media`,
        upload.payload,
        headers,
      )
    ).json(),
    asset,
  );
  assert.equal(
    (await c.request('GET', `/admin/api/drafts/${draft.draft.draftId}`)).json().input.photoAssetId,
    null,
  );
  const retrieved = await c.request('GET', asset.photoUrl);
  assert.equal(retrieved.statusCode, 200);
  assert.equal(sha256(retrieved.rawPayload), asset.assetId.slice(7));
  const meta = await sharp(retrieved.rawPayload).metadata();
  assert.equal(meta.exif, undefined);
  assert.equal(meta.icc, undefined);
  assert.equal(meta.format, 'webp');
  const attached = await c.request('PUT', `/admin/api/drafts/${draft.draft.draftId}`, {
    operationId: 'attach-photo',
    expectedRevision: 1,
    input: { ...draft.draft.input, photoAssetId: asset.assetId },
  });
  assert.equal(attached.statusCode, 200);
  assert.equal(attached.json().draft.photoUrl, asset.photoUrl);
  assert.deepEqual(
    (
      await c.request(
        'POST',
        `/admin/api/drafts/${draft.draft.draftId}/media`,
        upload.payload,
        headers,
      )
    ).json(),
    asset,
  );
  assert.equal((await c.request('GET', '/admin/api/operations/upload-one')).statusCode, 404);
  assert.deepEqual(
    (await readdir(join(f.directory, 'media'))).filter((name) => name.startsWith('.upload-')),
    [],
  );
});
test('upload identities bind original bytes and draft CAS; failures remove quarantine', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const draft = await c.create();
  const id = draft.draft.draftId;
  const first = multipartPhoto(await picture());
  const headers = { ...first.headers, 'x-operation-id': 'same-upload', 'x-draft-revision': '1' };
  assert.equal(
    (await c.request('POST', `/admin/api/drafts/${id}/media`, first.payload, headers)).statusCode,
    200,
  );
  const changed = multipartPhoto(await picture('blue'));
  assert.equal(
    (
      await c.request('POST', `/admin/api/drafts/${id}/media`, changed.payload, {
        ...changed.headers,
        'x-operation-id': 'same-upload',
        'x-draft-revision': '1',
      })
    ).statusCode,
    409,
  );
  await c.request('PUT', `/admin/api/drafts/${id}`, {
    operationId: 'edit',
    expectedRevision: 1,
    input: { ...draft.draft.input, title: 'Changed' },
  });
  assert.equal(
    (
      await c.request('POST', `/admin/api/drafts/${id}/media`, first.payload, {
        ...headers,
        'x-operation-id': 'stale-upload',
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(
    (await readdir(join(f.directory, 'media'))).filter((name) => name.startsWith('.upload-')),
    [],
  );
});
test('spoofed images, multiple files, oversized input and decompression dimensions are rejected', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const draft = await c.create();
  const id = draft.draft.draftId;
  const oversizedDimensions = await sharp({
    create: { width: 4500, height: 4500, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  const cases = [
    multipartPhoto(Buffer.from('<svg><script>alert(1)</script></svg>')),
    multipartPhoto(await picture(), true),
    multipartPhoto(Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1)),
    multipartPhoto(oversizedDimensions),
  ];
  for (const [index, upload] of cases.entries()) {
    const result = await c.request('POST', `/admin/api/drafts/${id}/media`, upload.payload, {
      ...upload.headers,
      'x-operation-id': `bad-${index}`,
      'x-draft-revision': '1',
    });
    assert.ok([400, 413].includes(result.statusCode), result.body);
  }
  assert.deepEqual(
    (await readdir(join(f.directory, 'media'))).filter((name) => name.startsWith('.upload-')),
    [],
  );
});
test('asset lookup is authenticated, hash-constrained and fails closed on altered bytes', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const draft = await c.create();
  const upload = multipartPhoto(await picture());
  const response = await c.request(
    'POST',
    `/admin/api/drafts/${draft.draft.draftId}/media`,
    upload.payload,
    { ...upload.headers, 'x-operation-id': 'asset-upload', 'x-draft-revision': '1' },
  );
  assert.equal(response.statusCode, 200, response.body);
  const asset = response.json();
  assert.equal((await f.client().request('GET', asset.photoUrl)).statusCode, 401);
  assert.equal((await c.request('GET', '/admin/api/assets/not-a-hash')).statusCode, 400);
  await writeFile(
    join(f.directory, 'media', `${asset.assetId.slice(7)}.webp`),
    Buffer.alloc(asset.bytes, 0),
  );
  assert.equal((await c.request('GET', asset.photoUrl)).statusCode, 503);
});
test('bundled photo returns the retained actual association and no arbitrary path lookup', async (t) => {
  const f = await fixture(t);
  const c = f.client();
  await c.login();
  const id = catalogue.recipes[0]!.recipeId;
  const response = await c.request('GET', `/admin/api/baseline/${id}/photo`);
  assert.equal(response.statusCode, 200);
  assert.equal((await sharp(response.rawPayload).metadata()).format, 'jpeg');
  assert.equal((await c.request('GET', '/admin/api/baseline/unknown/photo')).statusCode, 404);
});
