import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { catalogue, type Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  contentOverlaySignaturePayload,
  createBundledRecipeRevision,
  fingerprintContentOverlay,
  type ContentOverlayManifest,
  type OverlayEntry,
  type OverlayHead,
  type PublishedRecipeRevision,
  type SignedContentOverlay,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import {
  openContentReleaseStore,
  type ContentReferenceInspectionView,
  type ContentVerificationPorts,
} from '../../../apps/mobile/src/data/contentReleaseStore';
import { packageFingerprint } from '../../../apps/mobile/src/data/contentReleaseStoreSchema';
import { authoredFixture } from '../../catalogue/test/content-fixtures';
import { member, published } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const sha256 = async (value: string) => createHash('sha256').update(value).digest('hex');
const sha256Bytes = async (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const at = '2026-10-01T12:00:00.000Z';
const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-reference-inspection-'));
  const filename = join(directory, 'content.sqlite');
  const base = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256);
  const baselineBytes = await readFile(
    fileURLToPath(
      new URL(`../../catalogue/assets/photos/${base.ref.recipeId}.jpg`, import.meta.url),
    ),
  );
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#72974b' } })
    .png()
    .toBuffer();
  const hash = await sha256Bytes(bytes);
  const document = authoredFixture('90001');
  document.recipe.photoKey = `photos/${hash}.png`;
  document.media[0] = {
    ...document.media[0]!,
    assetId: `sha256:${hash}`,
    sha256: hash,
    bytes: bytes.length,
    mimeType: 'image/png',
    photoKey: document.recipe.photoKey,
    dimensions: { ...document.media[0]!.dimensions!, width: 2, height: 2 },
  };
  const first = await published(document, 'inspection-first');
  const nextDocument = clone(document);
  assert.ok(nextDocument.kind === 'authored');
  nextDocument.provenance.basedOn = first.revision.ref;
  nextDocument.recipe.title = 'Second exact fixture revision';
  const second = await published(nextDocument, 'inspection-second');
  const pair = generateKeyPairSync('ed25519');
  const keyId = 'inspection-fixture-key';
  const verifier = createContentTrustVerifier([
    {
      keyId,
      publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
        'hex',
      ),
    },
  ]);
  let signatures = 0,
    decodes = 0,
    queries = 0;
  let readBaseline = true;
  let afterCommit: (() => void) | null = null;
  const ports: ContentVerificationPorts = {
    baseline: { identity: { ...catalogue.identity }, revisions: [base] },
    readerVersion: 1,
    trustVerifier: {
      async verify(input) {
        signatures++;
        return verifier.verify(input);
      },
    },
    sha256,
    sha256Bytes,
    async inspectImage(value) {
      decodes++;
      const image = sharp(value);
      try {
        const metadata = await image.metadata();
        if (
          !metadata.width ||
          !metadata.height ||
          !['jpeg', 'png', 'webp'].includes(metadata.format!)
        )
          return null;
        return {
          width: metadata.width,
          height: metadata.height,
          mimeType: `image/${metadata.format}` as 'image/jpeg' | 'image/png' | 'image/webp',
        };
      } finally {
        image.destroy();
      }
    },
    async readBundledMedia(reference) {
      return readBaseline && reference.sha256 === base.document.media[0]!.sha256
        ? baselineBytes
        : null;
    },
  };
  const stores: Awaited<ReturnType<typeof openContentReleaseStore>>[] = [];
  let database!: DatabaseSync;
  async function open() {
    const reader = desktopConnection(filename),
      writer = desktopConnection(filename);
    database = writer.database;
    const exec = writer.connection.exec;
    writer.connection.exec = async (sql) => {
      queries++;
      await exec(sql);
      if (sql === 'COMMIT' && afterCommit) {
        const callback = afterCommit;
        afterCommit = null;
        callback();
      }
    };
    for (const connection of [reader.connection, writer.connection]) {
      const all = connection.all;
      connection.all = async <Row extends object>(
        sql: string,
        values?: Parameters<typeof all>[1],
      ) => {
        queries++;
        return all<Row>(sql, values);
      };
    }
    const store = await openContentReleaseStore({
      ...ports,
      readConnection: reader.connection,
      writeConnection: writer.connection,
      now: () => new Date(at),
    });
    stores.push(store);
    return store;
  }
  let store = await open();
  t.after(async () => {
    for (const connection of stores) await connection.close();
    await removeFixtureDirectory(directory);
  });
  async function envelope(
    previous: OverlayHead | null,
    entries: OverlayEntry[],
  ): Promise<SignedContentOverlay> {
    const sequence = (previous?.sequence ?? 0) + 1;
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `inspection-release-${sequence}`,
      sequence,
      previous,
      createdAt: at,
      minimumReaderVersion: 1,
      baseline: ports.baseline.identity,
      entries,
    };
    const fingerprint = await fingerprintContentOverlay(manifest, sha256);
    return {
      manifest,
      fingerprint,
      signature: {
        keyId,
        scheme: 'ed25519-hex-v1',
        value: sign(
          null,
          Buffer.from(contentOverlaySignaturePayload(manifest, fingerprint)),
          pair.privateKey,
        ).toString('hex'),
      },
    };
  }
  async function activate(
    previous: OverlayHead | null,
    entries: OverlayEntry[],
    publications: PublishedRecipeRevision[] = [],
  ) {
    const signed = await envelope(previous, entries);
    const stage = await store.stage({
      stageId: `inspection-stage-${signed.manifest.sequence}`,
      envelope: signed,
      publications,
      media: publications.length ? [{ sha256: hash, bytes }] : [],
    });
    const review = await store.reviewStage(stage.stageId, {
      expectedHead: previous,
      retainedRefs: [],
    });
    return (await store.activate(review, `inspection-activate-${signed.manifest.sequence}`)).head;
  }
  function snapshot() {
    return [
      'content_store_meta',
      'content_store_stage',
      'content_store_stage_media',
      'content_store_release',
      'content_store_media',
      'content_store_operation',
    ].map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  }
  async function chain() {
    const one = await activate(null, [member(first)], [first]);
    const two = await activate(one, [member(second)], [second]);
    const three = await activate(two, [
      { ...member(second), state: 'archived', reason: 'Synthetic archive' },
    ]);
    return { one, two, three };
  }
  return {
    base,
    first,
    second,
    hash,
    filename,
    activate,
    chain,
    snapshot,
    get store() {
      return store;
    },
    get database() {
      return database;
    },
    counts() {
      return { signatures, decodes, queries };
    },
    resetCounts() {
      signatures = 0;
      decodes = 0;
      queries = 0;
    },
    disableBaseline() {
      readBaseline = false;
    },
    afterNextCommit(callback: () => void) {
      afterCommit = callback;
    },
    async reopen() {
      await store.close();
      store = await open();
    },
    async rewriteEnvelope(releaseId: string, mutate: (value: SignedContentOverlay) => void) {
      const row = database
        .prepare('SELECT * FROM content_store_release WHERE release_id=?')
        .get(releaseId)!;
      const value = JSON.parse(row.envelope_json as string) as SignedContentOverlay;
      mutate(value);
      const fingerprint = await packageFingerprint(
        sha256,
        canonicalContentJson(value),
        row.publications_json as string,
        JSON.parse(row.media_json as string),
      );
      database
        .prepare(
          'UPDATE content_store_release SET envelope_json=?,fingerprint=? WHERE release_id=?',
        )
        .run(canonicalContentJson(value), fingerprint, releaseId);
      const receipt = database
        .prepare('SELECT * FROM content_store_operation WHERE release_id=?')
        .get(releaseId)!;
      const receiptValue = JSON.parse(receipt.receipt_json as string) as Record<string, unknown>;
      receiptValue.packageFingerprint = fingerprint;
      database
        .prepare(
          'UPDATE content_store_operation SET fingerprint=?,receipt_json=? WHERE release_id=?',
        )
        .run(fingerprint, canonicalContentJson(receiptValue), releaseId);
    },
  };
}

test('baseline-only inspection verifies actual packaged bytes and reports unknown refs without inventing archive trust', async (t) => {
  const f = await fixture(t);
  const before = f.snapshot();
  await f.store.withVerifiedReferenceInspection(
    null,
    [f.base.ref, f.first.revision.ref],
    async (view) => {
      assert.equal(view.head, null);
      assert.equal(view.latestHead, null);
      assert.deepEqual(view.adoptedRecipeIds, [f.base.ref.recipeId]);
      const base = view.entries[0]!.lookup;
      assert.equal(base.kind, 'readable');
      if (base.kind === 'readable') {
        assert.equal(base.state, 'current');
        assert.equal(base.value.origin, 'packaged_baseline');
        assert.deepEqual(base.value.revision.ref, f.base.ref);
      }
      assert.deepEqual(view.entries[1]!.lookup, { kind: 'missing' });
    },
  );
  assert.equal(f.counts().decodes, 1);
  assert.deepEqual(f.snapshot(), before);
  f.disableBaseline();
  await assert.rejects(
    f.store.withVerifiedReferenceInspection(null, [f.base.ref], async () =>
      assert.fail('unverified bytes exposed'),
    ),
  );
});

test('one chain replay classifies exact current, historical and archived references at the adopted head after reopen', async (t) => {
  const f = await fixture(t);
  const { one, two, three } = await f.chain();
  await f.reopen();
  const before = f.snapshot();
  const refs = [
    f.first.revision.ref,
    f.second.revision.ref,
    f.base.ref,
    { ...f.base.ref, contentFingerprint: 'e'.repeat(64) },
  ];
  const states = async (expected: OverlayHead | null) =>
    f.store.withVerifiedReferenceInspection(expected, refs, async (view) => {
      assert.deepEqual(view.head, expected);
      assert.deepEqual(view.latestHead, three);
      assert.deepEqual(
        view.adoptedRecipeIds,
        [f.base.ref.recipeId, ...(expected ? [f.first.revision.ref.recipeId] : [])].sort(),
      );
      return view.entries.map(({ lookup }) =>
        lookup.kind === 'readable' ? lookup.state : lookup.kind,
      );
    });
  assert.deepEqual(await states(null), ['missing', 'missing', 'current', 'missing']);
  assert.deepEqual(await states(one), ['current', 'missing', 'current', 'missing']);
  assert.deepEqual(await states(two), ['historical', 'current', 'current', 'missing']);
  f.resetCounts();
  assert.deepEqual(await states(three), ['historical', 'archived', 'current', 'missing']);
  assert.equal(
    f.counts().signatures,
    3,
    'the ancestor already materializes the historical first ref; no extra replay is needed',
  );
  assert.equal(
    f.counts().decodes,
    2,
    'actual media verified once per exact association during one inspection',
  );
  assert.deepEqual(f.snapshot(), before);
});

test('latest withdrawal wins per recipe even for unknown fullrefs, while future refs stay missing and strict reading remains strict', async (t) => {
  const f = await fixture(t);
  const { one, three } = await f.chain();
  const head = await f.activate(three, [
    {
      state: 'withdrawn',
      recipeId: f.first.revision.ref.recipeId,
      reason: 'Synthetic permission withdrawal',
    },
  ]);
  const forged = {
    ...f.first.revision.ref,
    revisionId: 'never-published',
    contentFingerprint: 'b'.repeat(64),
  };
  const before = f.snapshot();
  for (const selected of [null, one, head]) {
    await f.store.withVerifiedReferenceInspection(
      selected,
      [f.base.ref, f.first.revision.ref, f.second.revision.ref, forged],
      async (view) => {
        assert.deepEqual(
          view.adoptedRecipeIds,
          [f.base.ref.recipeId, ...(selected ? [f.first.revision.ref.recipeId] : [])].sort(),
        );
        assert.equal(view.entries[0]!.lookup.kind, 'readable');
        for (const entry of view.entries.slice(1))
          assert.deepEqual(entry.lookup, {
            kind: 'withdrawn',
            recipeId: forged.recipeId,
            reason: 'Synthetic permission withdrawal',
          });
      },
    );
  }
  await assert.rejects(
    f.store.withVerifiedReading(one, [f.first.revision.ref], async () =>
      assert.fail('strict reader admitted a withdrawn old pin'),
    ),
    { code: 'content_store_adoption_policy_changed' },
  );
  assert.deepEqual(f.snapshot(), before);
});

test('body-free inventory admits only adopted identities even without exact refs and retains archived or withdrawn IDs', async (t) => {
  const f = await fixture(t);
  const laterDocument = authoredFixture('90002');
  laterDocument.recipe.photoKey = f.first.revision.document.recipe.photoKey;
  laterDocument.media = f.first.revision.document.media.map((media) => ({
    ...clone(media),
    recipeId: laterDocument.recipe.recipeId,
  }));
  const later = await published(laterDocument, 'inspection-later-identity');
  const one = await f.activate(null, [member(f.first)], [f.first]);
  const two = await f.activate(one, [member(f.first), member(later)], [later]);
  const three = await f.activate(two, [
    { ...member(f.first), state: 'archived', reason: 'Synthetic identity archive' },
    member(later),
  ]);
  await f.store.withVerifiedReferenceInspection(three, [], async (view) => {
    assert.deepEqual(
      view.adoptedRecipeIds,
      [f.base.ref.recipeId, f.first.revision.ref.recipeId, later.revision.ref.recipeId].sort(),
    );
    assert.deepEqual(view.entries, [], 'identity admission does not fetch a requested body');
  });
  const four = await f.activate(three, [
    { state: 'withdrawn', recipeId: f.first.revision.ref.recipeId, reason: 'Synthetic withdrawal' },
    member(later),
  ]);
  await f.reopen();
  const before = f.snapshot();
  for (const selected of [null, one, four]) {
    f.resetCounts();
    await f.store.withVerifiedReferenceInspection(selected, [], async (view) => {
      assert.deepEqual(
        view.adoptedRecipeIds,
        [
          f.base.ref.recipeId,
          ...(selected ? [f.first.revision.ref.recipeId] : []),
          ...(selected === four ? [later.revision.ref.recipeId] : []),
        ].sort(),
      );
      assert.equal(view.adoptedRecipeIds.includes('never-published'), false);
      assert.deepEqual(view.entries, []);
    });
    assert.equal(f.counts().signatures, 4, 'the inventory requires no extra chain verification');
  }
  assert.deepEqual(f.snapshot(), before);
});

test('historical refs outside the selected revision ancestry use only one additional selected-release verification', async (t) => {
  const f = await fixture(t);
  const one = await f.activate(null, [member(f.first)], [f.first]);
  const two = await f.activate(one, [member(f.second)], [f.second]);
  const rollback = await f.activate(two, [member(f.first)]);
  f.resetCounts();
  const refs = [
    f.first.revision.ref,
    f.second.revision.ref,
    f.base.ref,
    { ...f.second.revision.ref, contentFingerprint: 'c'.repeat(64) },
  ];
  await f.store.withVerifiedReferenceInspection(rollback, refs, async (view) => {
    assert.deepEqual(
      view.entries.map(({ lookup }) => (lookup.kind === 'readable' ? lookup.state : lookup.kind)),
      ['current', 'historical', 'current', 'missing'],
    );
  });
  assert.equal(
    f.counts().signatures,
    4,
    'three releases plus exactly one selected-release verification, independent of requested ref count',
  );
  assert.equal(
    f.counts().decodes,
    2,
    'the extra verification reuses exact media association facts',
  );
});

test('non-null adopted heads must exactly match a verified committed release', async (t) => {
  const f = await fixture(t);
  const one = await f.activate(null, [member(f.first)], [f.first]);
  for (const head of [
    { ...one, fingerprint: 'f'.repeat(64) },
    { ...one, releaseId: 'never-issued' },
    { ...one, sequence: 2 },
  ]) {
    await assert.rejects(
      f.store.withVerifiedReferenceInspection(head, [f.base.ref], async () =>
        assert.fail('unknown head admitted'),
      ),
      { code: 'content_store_retained_head_unavailable' },
    );
  }
});

test('inspection rejects a corrupt latest signature, media or activation receipt before exposing an older head', async (t) => {
  const f = await fixture(t);
  const one = await f.activate(null, [member(f.first)], [f.first]);
  const two = await f.activate(one, [member(f.second)], [f.second]);
  const savedRow = f.database
    .prepare('SELECT * FROM content_store_release WHERE release_id=?')
    .get(two.releaseId)!;
  const savedReceipt = f.database
    .prepare('SELECT * FROM content_store_operation WHERE release_id=?')
    .get(two.releaseId)!;
  await f.rewriteEnvelope(two.releaseId, (value) => {
    value.signature.value = '0'.repeat(128);
  });
  await assert.rejects(
    f.store.withVerifiedReferenceInspection(one, [f.base.ref], async () =>
      assert.fail('untrusted chain exposed'),
    ),
    { code: 'overlay_untrusted' },
  );
  f.database
    .prepare('UPDATE content_store_release SET envelope_json=?,fingerprint=? WHERE release_id=?')
    .run(savedRow.envelope_json!, savedRow.fingerprint!, two.releaseId);
  f.database
    .prepare('UPDATE content_store_operation SET fingerprint=?,receipt_json=? WHERE release_id=?')
    .run(savedReceipt.fingerprint!, savedReceipt.receipt_json!, two.releaseId);
  const media = f.database
    .prepare('SELECT hex FROM content_store_media WHERE hash=?')
    .get(f.hash)!.hex;
  f.database
    .prepare('UPDATE content_store_media SET hex=? WHERE hash=?')
    .run('00'.repeat((media as string).length / 2), f.hash);
  await assert.rejects(
    f.store.withVerifiedReferenceInspection(one, [f.base.ref], async () =>
      assert.fail('bad media exposed'),
    ),
  );
  f.database.prepare('UPDATE content_store_media SET hex=? WHERE hash=?').run(media!, f.hash);
  f.database.prepare('DELETE FROM content_store_operation WHERE release_id=?').run(two.releaseId);
  const before = f.snapshot();
  await assert.rejects(
    f.store.withVerifiedReferenceInspection(one, [f.base.ref], async () =>
      assert.fail('missing receipt exposed'),
    ),
  );
  assert.deepEqual(f.snapshot(), before);
});

test('reference admission rejects getters, oversized batches and malformed refs before SQL and owns immutable deduplicated input', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  const accessor = { ...f.base.ref };
  Object.defineProperty(accessor, 'recipeId', {
    enumerable: true,
    get() {
      reads++;
      throw new Error('getter invoked');
    },
  });
  f.resetCounts();
  for (const refs of [
    [accessor],
    Array.from({ length: 1001 }, () => f.base.ref),
    [{ ...f.base.ref, revisionId: 'x'.repeat(600_000) }],
    [{ ...f.base.ref, extra: true }],
  ]) {
    await assert.rejects(
      f.store.withVerifiedReferenceInspection(null, refs, async () =>
        assert.fail('invalid request admitted'),
      ),
    );
  }
  assert.equal(reads, 0);
  assert.equal(f.counts().queries, 0);
  assert.equal(f.counts().signatures, 0);
  const refs = [{ ...f.base.ref }, { ...f.base.ref }, { ...f.first.revision.ref }];
  let escaped!: Immutable<ContentReferenceInspectionView>;
  const pending = f.store.withVerifiedReferenceInspection(null, refs, async (view) => {
    escaped = view;
    assert.deepEqual(
      view.entries.map((entry) => entry.ref),
      [f.base.ref, f.first.revision.ref],
    );
    assert.ok(
      Object.isFrozen(view) &&
        Object.isFrozen(view.adoptedRecipeIds) &&
        Object.isFrozen(view.entries) &&
        Object.isFrozen(view.entries[0]!.ref),
    );
    assert.equal(Reflect.set(view.entries[0]!.ref, 'recipeId', 'different'), false);
    assert.equal(Reflect.set(view.adoptedRecipeIds, 0, 'different'), false);
    assert.equal(view.assertActive(), undefined);
  });
  refs[0]!.recipeId = '99999';
  refs.length = 0;
  await pending;
  assert.throws(() => escaped.assertActive());
  assert.throws(() => escaped.entries);
  assert.throws(() => escaped.adoptedRecipeIds);
});

test('inspection holds one real SQLite writer reservation and callback failure leaves every content row unchanged', async (t) => {
  const f = await fixture(t);
  f.database.exec('PRAGMA journal_mode=WAL');
  const one = await f.activate(null, [member(f.first)], [f.first]);
  const other = new DatabaseSync(f.filename);
  try {
    other.exec('PRAGMA busy_timeout=0');
    const before = f.snapshot();
    await assert.rejects(
      f.store.withVerifiedReferenceInspection(one, [f.first.revision.ref], async (view) => {
        assert.equal(view.assertActive(), undefined);
        assert.throws(() => other.exec('BEGIN IMMEDIATE'), /database is locked/);
        await Promise.resolve();
        assert.equal(view.assertActive(), undefined);
        throw new Error('fixture consumer failed');
      }),
      /fixture consumer failed/,
    );
    other.exec('BEGIN IMMEDIATE');
    other.exec('ROLLBACK');
    assert.deepEqual(f.snapshot(), before);
  } finally {
    other.close();
  }
});

test('store close invalidates active inspection and rejects post-commit acknowledgement exposure', async (t) => {
  const f = await fixture(t);
  let closing: Promise<void> | undefined;
  await assert.rejects(
    f.store.withVerifiedReferenceInspection(null, [f.base.ref], async (view) => {
      closing = f.store.close();
      assert.throws(() => view.assertActive());
      assert.throws(() => view.entries);
      assert.throws(() => view.adoptedRecipeIds);
      return 'must not escape';
    }),
  );
  await closing;
  await f.reopen();
  f.afterNextCommit(() => {
    closing = f.store.close();
  });
  await assert.rejects(
    f.store.withVerifiedReferenceInspection(null, [f.base.ref], async (view) => {
      assert.equal(view.assertActive(), undefined);
      return 'post-commit stale result';
    }),
  );
  await closing;
});
