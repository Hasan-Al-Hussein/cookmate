import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { catalogue } from '@cookmate/catalogue';
import {
  CONTENT_LIMITS,
  createBundledRecipeRevision,
  type OverlayEntry,
  type OverlayHead,
  type PublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { createContentOverlaySigner } from '../../../apps/admin/src/publishing/signer';
import {
  openContentReleaseStore,
  type ContentReadingView,
  type ContentVerificationPorts,
} from '../../../apps/mobile/src/data/contentReleaseStore';
import { authoredFixture } from '../../catalogue/test/content-fixtures';
import { member, published } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const hashBytes = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const at = '2026-10-01T12:00:00.000Z';
function gate() {
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { wait, finish };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-reading-media-'));
  const filename = join(directory, 'content.sqlite');
  const base = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256);
  const baselineBytes = await readFile(
    new URL(`../../catalogue/assets/photos/${base.ref.recipeId}.jpg`, import.meta.url),
  );
  const media = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#72974b' } })
    .png()
    .toBuffer();
  const mediaHash = await hashBytes(media);
  const document = authoredFixture('90001');
  document.recipe.photoKey = `photos/${mediaHash}.png`;
  document.media[0] = {
    ...document.media[0]!,
    assetId: `sha256:${mediaHash}`,
    sha256: mediaHash,
    bytes: media.length,
    mimeType: 'image/png',
    photoKey: document.recipe.photoKey,
    dimensions: { ...document.media[0]!.dimensions!, width: 2, height: 3 },
  };
  const publication = await published(document);
  const pair = generateKeyPairSync('ed25519');
  const keyId = 'reading-media-fixture';
  const signer = createContentOverlaySigner({ keyId, privateKey: pair.privateKey });
  const controls = {
    afterCommit: async () => {},
    bundle: async () => baselineBytes as Uint8Array | null,
    hash: hashBytes,
    inspect: async (bytes: Uint8Array) => {
      const image = sharp(bytes);
      try {
        const facts = await image.metadata();
        if (!facts.width || !facts.height || !['jpeg', 'png', 'webp'].includes(facts.format!))
          return null;
        return {
          mimeType: `image/${facts.format}` as 'image/jpeg' | 'image/png' | 'image/webp',
          width: facts.width,
          height: facts.height,
        };
      } finally {
        image.destroy();
      }
    },
  };
  let reads = 0,
    bundledReads = 0;
  const reader = desktopConnection(filename),
    writer = desktopConnection(filename);
  const originalAll = writer.connection.all;
  const originalExec = writer.connection.exec;
  writer.connection.exec = async (sql) => {
    await originalExec(sql);
    if (sql === 'COMMIT') await controls.afterCommit();
  };
  writer.connection.all = async <Row extends object>(
    sql: string,
    values?: Parameters<typeof originalAll>[1],
  ) => {
    reads++;
    return originalAll<Row>(sql, values);
  };
  const ports: ContentVerificationPorts = {
    baseline: { identity: { ...catalogue.identity }, revisions: [base] },
    readerVersion: 1,
    sha256,
    trustVerifier: createContentTrustVerifier([
      {
        keyId,
        publicKeyHex: Buffer.from(
          pair.publicKey.export({ format: 'jwk' }).x!,
          'base64url',
        ).toString('hex'),
      },
    ]),
    sha256Bytes: (bytes) => controls.hash(bytes),
    inspectImage: (bytes) => controls.inspect(bytes),
    async readBundledMedia(reference) {
      bundledReads++;
      return reference.sha256 === base.document.media[0]!.sha256 ? controls.bundle() : null;
    },
  };
  const store = await openContentReleaseStore({
    ...ports,
    readConnection: reader.connection,
    writeConnection: writer.connection,
    now: () => new Date(at),
  });
  let closeStarted = false;
  const close = async () => {
    closeStarted = true;
    await store.close();
  };
  t.after(async () => {
    if (!closeStarted) await close();
    await removeFixtureDirectory(directory);
  });
  async function stage(
    previous: OverlayHead | null = null,
    entries: OverlayEntry[] = [member(publication)],
    packages: PublishedRecipeRevision[] = [publication],
  ) {
    const sequence = (previous?.sequence ?? 0) + 1;
    const envelope = await signer.signManifest({
      formatVersion: 2,
      releaseId: `media-release-${sequence}`,
      sequence,
      previous,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: { ...catalogue.identity },
      entries,
    });
    const retained = await store.stage({
      stageId: `media-stage-${sequence}`,
      envelope,
      publications: packages,
      media: packages.length ? [{ sha256: mediaHash, bytes: media }] : [],
    });
    return store.reviewStage(retained.stageId, { expectedHead: previous, retainedRefs: [] });
  }
  async function activate(
    previous: OverlayHead | null = null,
    entries?: OverlayEntry[],
    packages?: PublishedRecipeRevision[],
  ) {
    const review = await stage(previous, entries, packages);
    return store.activate(review, `media-activate-${review.head.sequence}`);
  }
  return {
    store,
    close,
    base,
    baselineBytes,
    document,
    publication,
    media,
    controls,
    stage,
    activate,
    database: writer.database,
    counts: () => ({ reads, bundledReads }),
  };
}

test('baseline photos use actual packaged membership, real bytes and independent mutable output copies', async (t) => {
  const f = await fixture(t),
    assetId = f.base.document.media[0]!.assetId;
  await f.store.withVerifiedReading(null, [], async (view) => {
    const first = await view.readPhoto(f.base.ref, assetId);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.contentRef), true);
    assert.equal(first.mimeType, 'image/jpeg');
    assert.ok(first.width > 0 && first.height > 0);
    assert.deepEqual(Buffer.from(first.bytes), f.baselineBytes);
    first.bytes.fill(0);
    const second = await view.readPhoto(f.base.ref, assetId);
    assert.deepEqual(Buffer.from(second.bytes), f.baselineBytes);
    assert.notEqual(second.bytes.buffer, f.baselineBytes.buffer);
    const before = f.counts();
    for (const [ref, asset] of [
      [{ ...f.base.ref, contentFingerprint: 'f'.repeat(64) }, assetId],
      [f.base.ref, 'https://example.invalid/photo.jpg'],
      [f.base.ref, `sha256:${'f'.repeat(64)}`],
      [f.publication.revision.ref, f.publication.revision.document.media[0]!.assetId],
    ] as const)
      await assert.rejects(view.readPhoto(ref, asset), {
        code: 'content_store_retained_ref_unavailable',
      });
    assert.deepEqual(f.counts(), before);
  });
});

test('only adopted exact media is readable; staging never supplies a photo and archived pins remain exact', async (t) => {
  const f = await fixture(t),
    ref = f.publication.revision.ref,
    assetId = f.document.media[0]!.assetId;
  const review = await f.stage();
  await f.store.withVerifiedReading(null, [], async (view) => {
    await assert.rejects(view.readPhoto(ref, assetId), {
      code: 'content_store_retained_ref_unavailable',
    });
  });
  const first = await f.store.activate(review, 'media-first');
  await f.store.withVerifiedReading(first.head, [ref], async (view) => {
    const photo = await view.readPhoto(ref, assetId);
    assert.deepEqual(Buffer.from(photo.bytes), f.media);
    assert.deepEqual([photo.mimeType, photo.width, photo.height], ['image/png', 2, 3]);
    await assert.rejects(view.readPhoto(ref, f.base.document.media[0]!.assetId), {
      code: 'content_store_retained_ref_unavailable',
    });
  });
  const second = await f.activate(
    first.head,
    [{ ...member(f.publication), state: 'archived', reason: 'Fixture archive' }],
    [],
  );
  await f.store.withVerifiedReading(second.head, [ref], async (view) => {
    assert.equal(view.snapshot!.lookupExact(ref).kind, 'readable');
    assert.deepEqual(Buffer.from((await view.readPhoto(ref, assetId)).bytes), f.media);
  });
});

test('a newer recipe never substitutes for a retained old exact photo association', async (t) => {
  const f = await fixture(t),
    ref = f.publication.revision.ref,
    assetId = f.document.media[0]!.assetId;
  const first = await f.activate();
  const nextDocument = structuredClone(f.document);
  assert.ok(nextDocument.kind === 'authored');
  nextDocument.recipe.title = 'Explicit second revision';
  nextDocument.provenance.basedOn = ref;
  const next = await published(nextDocument, 'revision-2');
  const second = await f.activate(first.head, [member(next)], [next]);
  await f.store.withVerifiedReading(second.head, [ref], async (view) => {
    const photo = await view.readPhoto(ref, assetId);
    assert.deepEqual(photo.contentRef, ref);
    await assert.rejects(
      view.readPhoto({ ...ref, contentFingerprint: next.revision.ref.contentFingerprint }, assetId),
      { code: 'content_store_retained_ref_unavailable' },
    );
  });
  await f.store.withVerifiedReading(first.head, [], async (view) => {
    await assert.rejects(view.readPhoto(next.revision.ref, assetId), {
      code: 'content_store_retained_ref_unavailable',
    });
  });
});

test('later signed withdrawal blocks media from older adopted heads and the baseline view', async (t) => {
  const f = await fixture(t),
    ref = f.publication.revision.ref,
    assetId = f.document.media[0]!.assetId;
  const first = await f.activate();
  const second = await f.activate(
    first.head,
    [{ state: 'withdrawn', recipeId: ref.recipeId, reason: 'Fixture withdrawal' }],
    [],
  );
  let called = false;
  await assert.rejects(
    f.store.withVerifiedReading(first.head, [ref], async () => {
      called = true;
    }),
    { code: 'content_store_adoption_policy_changed' },
  );
  assert.equal(called, false);
  await f.store.withVerifiedReading(second.head, [], async (view) => {
    await assert.rejects(view.readPhoto(ref, assetId), {
      code: 'content_store_adoption_policy_changed',
    });
  });
  await f.store.withVerifiedReading(null, [], async (view) => {
    await assert.rejects(view.readPhoto(f.base.ref, f.base.document.media[0]!.assetId), {
      code: 'content_store_adoption_policy_changed',
    });
  });
});

for (const phase of ['bundle', 'hash', 'inspect'] as const)
  test(`escaped callbacks perform no later reads, including work awaiting ${phase}`, async (t) => {
    const f = await fixture(t),
      assetId = f.base.document.media[0]!.assetId;
    let escaped!: ContentReadingView['readPhoto'];
    let assertActive!: ContentReadingView['assertActive'];
    const entered = gate(),
      complete = gate();
    if (phase === 'bundle')
      f.controls.bundle = async () => {
        entered.finish();
        await complete.wait;
        return f.baselineBytes;
      };
    if (phase === 'hash')
      f.controls.hash = async (bytes) => {
        entered.finish();
        await complete.wait;
        return hashBytes(bytes);
      };
    if (phase === 'inspect') {
      const original = f.controls.inspect;
      f.controls.inspect = async (bytes) => {
        entered.finish();
        await complete.wait;
        return original(bytes);
      };
    }
    let pending!: Promise<unknown>;
    await f.store.withVerifiedReading(null, [], async (view) => {
      escaped = view.readPhoto;
      assertActive = view.assertActive;
      assert.equal(assertActive(), undefined);
      pending = assert.rejects(view.readPhoto(f.base.ref, assetId), {
        code: 'content_store_invalid',
      });
      await entered.wait;
    });
    const before = f.counts();
    assert.throws(assertActive, { code: 'content_store_invalid' });
    await assert.rejects(escaped(f.base.ref, assetId), { code: 'content_store_invalid' });
    complete.finish();
    await pending;
    assert.deepEqual(f.counts(), before);
  });

test('closing the store invalidates a media read already awaiting host bytes before releasing locks', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    complete = gate();
  f.controls.bundle = async () => {
    entered.finish();
    await complete.wait;
    return f.baselineBytes;
  };
  const reading = assert.rejects(
    f.store.withVerifiedReading(null, [], (view) =>
      view.readPhoto(f.base.ref, f.base.document.media[0]!.assetId),
    ),
    { code: 'content_store_invalid' },
  );
  await entered.wait;
  const closing = f.close();
  complete.finish();
  await reading;
  await closing;
  await assert.rejects(
    f.store.withVerifiedReading(null, [], async () => null),
    { code: 'content_store_invalid' },
  );
});

test('closing after photo verification rejects the still-pending reading callback result', async (t) => {
  const f = await fixture(t),
    verified = gate(),
    complete = gate();
  const reading = assert.rejects(
    f.store.withVerifiedReading(null, [], async (view) => {
      const photo = await view.readPhoto(f.base.ref, f.base.document.media[0]!.assetId);
      assert.deepEqual(Buffer.from(photo.bytes), f.baselineBytes);
      verified.finish();
      await complete.wait;
      return photo;
    }),
    { code: 'content_store_invalid' },
  );
  await verified.wait;
  const closing = f.close();
  complete.finish();
  await reading;
  await closing;
});

test('closing during the transaction COMMIT acknowledgement rejects final photo delivery', async (t) => {
  const f = await fixture(t),
    committed = gate(),
    complete = gate();
  f.controls.afterCommit = async () => {
    committed.finish();
    await complete.wait;
  };
  const reading = assert.rejects(
    f.store.withVerifiedReading(null, [], (view) =>
      view.readPhoto(f.base.ref, f.base.document.media[0]!.assetId),
    ),
    { code: 'content_store_invalid' },
  );
  await committed.wait;
  const closing = f.close();
  complete.finish();
  await reading;
  await closing;
});

test('returned bytes are reverified during the reservation and verification ports cannot mutate the private copy', async (t) => {
  const f = await fixture(t),
    ref = f.publication.revision.ref,
    assetId = f.document.media[0]!.assetId;
  const activated = await f.activate();
  await f.store.withVerifiedReading(activated.head, [ref], async (view) => {
    const originalHash = f.controls.hash,
      originalInspect = f.controls.inspect;
    f.controls.hash = async () => 'f'.repeat(64);
    await assert.rejects(view.readPhoto(ref, assetId), { code: 'content_store_invalid' });
    f.controls.hash = originalHash;
    for (const facts of [
      { mimeType: 'image/jpeg' as const, width: 2, height: 3 },
      { mimeType: 'image/png' as const, width: 2, height: 4 },
      { mimeType: 'image/png' as const, width: CONTENT_LIMITS.imageDimension + 1, height: 3 },
      { mimeType: 'image/png' as const, width: 2.5, height: 3 },
    ]) {
      f.controls.inspect = async () => facts;
      await assert.rejects(view.readPhoto(ref, assetId), { code: 'content_store_invalid' });
    }
    f.controls.hash = async (bytes) => {
      const hash = await originalHash(bytes);
      bytes.fill(0);
      return hash;
    };
    f.controls.inspect = async (bytes) => {
      const facts = await originalInspect(bytes);
      bytes.fill(0);
      return facts;
    };
    const photo = await view.readPhoto(ref, assetId);
    assert.deepEqual(Buffer.from(photo.bytes), f.media);
    f.controls.hash = originalHash;
    f.controls.inspect = originalInspect;
  });
});

test('missing, corrupt and oversized bundled bytes fail closed before decode', async (t) => {
  const f = await fixture(t);
  let decoded = 0;
  f.controls.inspect = async () => {
    decoded++;
    return null;
  };
  await f.store.withVerifiedReading(null, [], async (view) => {
    for (const bytes of [
      null,
      new Uint8Array(1),
      new Uint8Array(f.baselineBytes.length),
      new Uint8Array(CONTENT_LIMITS.mediaBytes + 1),
    ]) {
      f.controls.bundle = async () => bytes;
      await assert.rejects(view.readPhoto(f.base.ref, f.base.document.media[0]!.assetId), {
        code: 'content_store_invalid',
      });
    }
  });
  assert.equal(decoded, 0);
});

test('corrupt retained SQL media cannot be bypassed by a matching staged copy', async (t) => {
  const f = await fixture(t),
    ref = f.publication.revision.ref;
  const first = await f.activate();
  await f.stage(first.head, [member(f.publication)]);
  await assert.rejects(
    f.store.withVerifiedReading(first.head, [ref], async (view) => {
      // Fault injection after hydration proves media access does not reuse its boolean verification
      // cache or fall back to identical bytes in the unactivated stage. Failure rolls back the fault.
      f.database
        .prepare('DELETE FROM content_store_media WHERE hash=?')
        .run(f.document.media[0]!.sha256);
      return view.readPhoto(ref, f.document.media[0]!.assetId);
    }),
    { code: 'content_store_invalid' },
  );
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM content_store_media').get()!.n, 1);
  f.database
    .prepare('UPDATE content_store_media SET hex=? WHERE hash=?')
    .run('00'.repeat(f.media.length), f.document.media[0]!.sha256);
  let called = false;
  await assert.rejects(
    f.store.withVerifiedReading(first.head, [ref], async () => {
      called = true;
    }),
    { code: 'content_store_invalid' },
  );
  assert.equal(called, false);
});
