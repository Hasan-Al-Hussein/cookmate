import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { catalogue, catalogueProvenance, type Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  type OverlayEntry,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { createContentOverlaySigner } from '../../../apps/admin/src/publishing/signer';
import {
  CONTENT_PHOTO_BATCH_LIMIT,
  CONTENT_PHOTO_BATCH_BYTES,
  type ContentPhotoRequest,
} from '../../../apps/mobile/src/data/adoptedContentReader';
import type { ContentAdoptionAccess } from '../../../apps/mobile/src/data/contentAdoption';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { openContentCookingStore } from '../../../apps/mobile/src/data/contentCookingStore';
import {
  openContentReleaseStore,
  type ContentReadingView,
  type ContentVerificationPorts,
} from '../../../apps/mobile/src/data/contentReleaseStore';
import { configureConnection, SerializedWriter } from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const at = '2026-10-02T00:00:00.000Z';
const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const hashBytes = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-photo-batch-'));
  const handles: ReturnType<typeof desktopConnection>[] = [];
  let cooking: Awaited<ReturnType<typeof openContentCookingStore>> | undefined;
  let delivery: Awaited<ReturnType<typeof openContentReleaseStore>> | undefined;
  let access: ContentAdoptionAccess | null = { ownerId: null, authGeneration: 1 };
  let bundledReads = 0,
    signatures = 0,
    reservations = 0;
  const controls = {
    beforeBundle: async (_call: number): Promise<'read' | 'missing'> => 'read',
    view: (view: Immutable<ContentReadingView>): Immutable<ContentReadingView> => view,
  };
  t.after(async () => {
    const failures: unknown[] = [];
    for (const owned of [cooking, delivery, ...handles.map((handle) => handle.connection)]) {
      try {
        await owned?.close();
      } catch (error) {
        failures.push(error);
      }
    }
    assert.deepEqual(failures, []);
    // Keep only these fresh disposable fixtures; no automatic deletion of blocked old paths.
  });
  function open(filename: string) {
    const result = desktopConnection(join(directory, filename));
    const close = result.connection.close;
    let closed = false;
    result.connection.close = async () => {
      if (!closed) {
        await close();
        closed = true;
      }
    };
    handles.push(result);
    return result;
  }
  const baseline = await Promise.all(
    catalogue.recipes
      .slice(0, CONTENT_PHOTO_BATCH_LIMIT)
      .map((recipe) => createBundledRecipeRevision(recipe.recipeId, hash)),
  );
  const references = new Map(
    baseline.flatMap((revision) =>
      revision.document.media.map((media) => [canonicalContentJson(media), media] as const),
    ),
  );
  const pair = generateKeyPairSync('ed25519'),
    keyId = 'photo-batch-fixture';
  const signer = createContentOverlaySigner({ keyId, privateKey: pair.privateKey });
  const verifier = createContentTrustVerifier([
    {
      keyId,
      publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
        'hex',
      ),
    },
  ]);
  const ports: ContentVerificationPorts = {
    baseline: { identity: catalogue.identity, revisions: baseline },
    readerVersion: 2,
    sha256: hash,
    sha256Bytes: hashBytes,
    trustVerifier: {
      async verify(input) {
        signatures++;
        return verifier.verify(input);
      },
    },
    async readBundledMedia(reference) {
      const original = references.get(canonicalContentJson(reference));
      if (!original) return null;
      bundledReads++;
      if ((await controls.beforeBundle(bundledReads)) === 'missing') return null;
      return readFile(
        new URL(`../../catalogue/assets/photos/${original.recipeId}.jpg`, import.meta.url),
      );
    },
    async inspectImage(bytes) {
      const image = sharp(bytes);
      try {
        const facts = await image.metadata();
        if (!facts.width || !facts.height || facts.format !== 'jpeg') return null;
        return { mimeType: 'image/jpeg', width: facts.width, height: facts.height };
      } finally {
        image.destroy();
      }
    },
  };
  const contentWrite = open('content.sqlite');
  const content = await openContentReleaseStore({
    ...ports,
    readConnection: open('content.sqlite').connection,
    writeConnection: contentWrite.connection,
    now: () => new Date(at),
  });
  delivery = content;
  async function activate(previous: OverlayHead | null = null, entries: OverlayEntry[] = []) {
    const sequence = (previous?.sequence ?? 0) + 1;
    const envelope = await signer.signManifest({
      formatVersion: 2,
      releaseId: `photo-batch-${sequence}`,
      sequence,
      previous,
      createdAt: at,
      minimumReaderVersion: 2,
      baseline: catalogue.identity,
      entries,
    });
    const staged = await content.stage({
      stageId: `photo-batch-stage-${sequence}`,
      envelope,
      publications: [],
      media: [],
    });
    return content.activate(
      await content.reviewStage(staged.stageId, { expectedHead: previous, retainedRefs: [] }),
      `photo-batch-activate-${sequence}`,
    );
  }
  const activated = await activate();
  const seed = open('cooking.sqlite');
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
  await migrateCookingContentDatabase(writer, { sha256: hash });
  await migrateAccountContentHistoryDatabase(writer, { sha256: hash });
  await writer.close();
  const observed: Parameters<typeof openContentCookingStore>[0]['contentStore'] = {
    ...content,
    withVerifiedReading(head, refs, work) {
      reservations++;
      return content.withVerifiedReading(head, refs, (view) => work(controls.view(view)));
    },
  };
  const store = await openContentCookingStore({
    schemaVersion: 8,
    installationId: ids.installationId,
    openConnection: async () => open('cooking.sqlite').connection,
    contentStore: observed,
    platform: { newId: randomUUID, sha256: hash },
    now: () => at,
    dateContext: () => ({ localDate: '2026-10-02', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    getAccess: () => access,
    assertAccess(scope) {
      assert.deepEqual(access, scope);
      return undefined;
    },
  });
  cooking = store;
  await store.adoption.adopt(await store.adoption.review({ candidateHead: activated.head }));
  const requests = baseline.map((revision) => ({
    ref: { ...revision.ref },
    assetId: revision.document.media[0]!.assetId,
  }));
  bundledReads = signatures = reservations = 0;
  return {
    store,
    content,
    activated,
    activate,
    requests,
    controls,
    cookingDatabase: open('cooking.sqlite').database,
    contentDatabase: contentWrite.database,
    counts: () => ({ bundledReads, signatures, reservations }),
    setAccess(next: ContentAdoptionAccess | null) {
      access = next;
    },
  };
}

test('six ordered exact photos share one signed reservation, with independent owned copies', async (t) => {
  const f = await fixture(t);
  const requests = [
    f.requests[2]!,
    f.requests[0]!,
    f.requests[0]!,
    f.requests[5]!,
    f.requests[1]!,
    f.requests[4]!,
  ];
  const result = await f.store.content.readPhotos(requests);
  assert.equal(result.value.length, CONTENT_PHOTO_BATCH_LIMIT);
  assert.deepEqual(result.head, f.activated.head);
  assert.ok(Object.isFrozen(result.value));
  for (const [index, item] of result.value.entries()) {
    assert.equal(item.kind, 'ready');
    if (item.kind !== 'ready') assert.fail();
    assert.deepEqual(item.photo.contentRef, requests[index]!.ref);
    assert.equal(item.photo.assetId, requests[index]!.assetId);
    assert.equal(await hashBytes(item.photo.bytes), item.photo.sha256);
    assert.ok(Object.isFrozen(item));
  }
  assert.deepEqual(f.counts(), { bundledReads: 12, signatures: 1, reservations: 1 });
  const first = result.value[1]!,
    second = result.value[2]!;
  assert.equal(first.kind, 'ready');
  assert.equal(second.kind, 'ready');
  if (first.kind !== 'ready' || second.kind !== 'ready') assert.fail();
  first.photo.bytes.fill(0);
  assert.equal(await hashBytes(second.photo.bytes), second.photo.sha256);
});

test('batch bounds and exact copied request shapes reject before reservation', async (t) => {
  const f = await fixture(t),
    request = f.requests[0]!;
  const invalid: unknown[] = [
    null,
    [],
    Array(7).fill(request),
    [{ ...request, unexpected: true }],
    [{ ...request, assetId: '' }],
    [{ ...request, assetId: 'a'.repeat(201) }],
    [{ ...request, ref: { ...request.ref, contentFingerprint: 'bad' } }],
  ];
  const accessor = Object.defineProperty({}, 'ref', {
    enumerable: true,
    get() {
      throw new Error('Must not call accessor');
    },
  });
  invalid.push([accessor]);
  for (const input of invalid)
    assert.throws(() => f.store.content.readPhotos(input as readonly ContentPhotoRequest[]), {
      code: 'invalid_input',
    });
  assert.deepEqual(f.counts(), { bundledReads: 0, signatures: 0, reservations: 0 });
});

test('caller mutation after dispatch cannot redirect exact ref or asset', async (t) => {
  const f = await fixture(t),
    request = structuredClone(f.requests[0]!);
  const original = structuredClone(request);
  const work = f.store.content.readPhotos([request]);
  request.ref.recipeId = f.requests[1]!.ref.recipeId;
  request.assetId = f.requests[1]!.assetId;
  const item = (await work).value[0]!;
  assert.equal(item.kind, 'ready');
  if (item.kind !== 'ready') assert.fail();
  assert.deepEqual(item.photo.contentRef, original.ref);
  assert.equal(item.photo.assetId, original.assetId);
});

test('aggregate declared bytes reject before requested-photo reads, including duplicate outputs', async (t) => {
  const f = await fixture(t);
  let photos = 0;
  // Controlled metadata seam only: genuine SQL/owner/signature hydration still runs first.
  // This tests budget admission without manufacturing a huge signed asset or allocating it.
  f.controls.view = (view) => {
    assert.ok(view.snapshot);
    const snapshot = view.snapshot;
    const inflate = (
      value: (typeof snapshot.discoverable)[number],
    ): (typeof snapshot.discoverable)[number] => ({
      ...value,
      revision: {
        ...value.revision,
        document: {
          ...value.revision.document,
          media: value.revision.document.media.map((media) => ({
            ...media,
            bytes: CONTENT_PHOTO_BATCH_BYTES / 2 + 1,
          })),
        },
      },
    });
    return {
      ...view,
      snapshot: {
        ...snapshot,
        discoverable: snapshot.discoverable.map(inflate),
        lookupExact(ref) {
          const lookup = snapshot.lookupExact(ref);
          return lookup.kind === 'readable' ? { ...lookup, value: inflate(lookup.value) } : lookup;
        },
      },
      readPhoto(ref, assetId) {
        photos++;
        return view.readPhoto(ref, assetId);
      },
    };
  };
  await assert.rejects(f.store.content.readPhotos([f.requests[0]!, f.requests[0]!]), {
    code: 'photo_batch_too_large',
  });
  assert.equal(photos, 0);
  assert.deepEqual(f.counts(), { bundledReads: 6, signatures: 1, reservations: 1 });
});

test('an unknown asset is unavailable in place while other photos remain readable; single read still rejects', async (t) => {
  const f = await fixture(t),
    request = f.requests[0]!;
  const absent = { ...request, assetId: `sha256:${'f'.repeat(64)}` };
  const result = await f.store.content.readPhotos([request, absent, f.requests[1]!]);
  assert.deepEqual(
    result.value.map((item) => item.kind),
    ['ready', 'unavailable', 'ready'],
  );
  assert.equal(f.counts().signatures, 1);
  await assert.rejects(f.store.content.readPhoto(absent.ref, absent.assetId), {
    code: 'exact_unavailable',
  });
});

test('missing requested bytes can be partial, but unknown dependency exceptions reject the entire batch', async (t) => {
  const f = await fixture(t);
  f.controls.beforeBundle = async (call) => (call === 7 ? 'missing' : 'read');
  assert.deepEqual(
    (await f.store.content.readPhotos(f.requests.slice(0, 2))).value.map((item) => item.kind),
    ['unavailable', 'ready'],
  );
  f.controls.beforeBundle = async (call) => {
    if (call === 15) throw new Error('Synthetic media dependency failure');
    return 'read';
  };
  await assert.rejects(
    f.store.content.readPhotos(f.requests.slice(0, 2)),
    /Synthetic media dependency failure/,
  );
});

for (const change of [
  'owner',
  'reader-close',
  'content-close',
  'adoption',
  'restore',
  'installation',
] as const) {
  test(`${change} during a photo batch rejects its whole result`, async (t) => {
    const f = await fixture(t);
    let closing: Promise<void> | undefined;
    f.controls.beforeBundle = async (call) => {
      if (call === 7) {
        if (change === 'owner') f.setAccess({ ownerId: randomUUID(), authGeneration: 2 });
        if (change === 'reader-close') f.store.content.close();
        if (change === 'content-close') closing = f.content.close();
        if (change === 'adoption')
          f.cookingDatabase.exec('UPDATE app_content_adoption SET revision=revision+1');
        if (change === 'restore')
          f.cookingDatabase
            .prepare('INSERT INTO app_metadata(key,value) VALUES (?,?)')
            .run('account-replication:apply-epoch', '1');
        if (change === 'installation')
          f.cookingDatabase
            .prepare("UPDATE app_metadata SET value=? WHERE key='installation_id'")
            .run(randomUUID());
      }
      return 'read';
    };
    const code =
      change === 'owner' || change === 'installation'
        ? 'access_changed'
        : change === 'reader-close'
          ? 'closed'
          : change === 'content-close'
            ? 'content_store_invalid'
            : 'adoption_changed';
    await assert.rejects(f.store.content.readPhotos(f.requests.slice(0, 2)), { code });
    await closing;
  });
}

test('unknown exact revision and persisted release tampering reject before any partial result', async (t) => {
  const f = await fixture(t);
  const unknown: RecipeContentRef = {
    ...f.requests[0]!.ref,
    revisionId: 'unknown-fixture-revision',
  };
  await assert.rejects(f.store.content.readPhotos([{ ...f.requests[0]!, ref: unknown }]), {
    code: 'exact_unavailable',
  });
  f.contentDatabase.prepare('UPDATE content_store_release SET envelope_json=?').run('{}');
  await assert.rejects(f.store.content.readPhotos(f.requests.slice(0, 2)));
});

test('a later signed withdrawal rejects an older adopted photo batch without stale fallback', async (t) => {
  const f = await fixture(t);
  await f.store.content.readPhotos(f.requests.slice(0, 2));
  await f.activate(f.activated.head, [
    {
      state: 'withdrawn',
      recipeId: f.requests[0]!.ref.recipeId,
      reason: 'Local fixture withdrawal',
    },
  ]);
  await assert.rejects(f.store.content.readPhotos(f.requests.slice(0, 2)), {
    code: 'policy_changed',
  });
});
