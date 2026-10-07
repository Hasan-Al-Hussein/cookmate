import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { catalogue } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  CONTENT_LIMITS,
  createBundledRecipeRevision,
  type ContentOverlayManifest,
  type OverlayEntry,
  type OverlayHead,
  type SignedContentOverlay,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { createContentOverlaySigner } from '../../../apps/admin/src/publishing/signer';
import {
  openContentReleaseStore,
  CONTENT_STORE_LIMITS,
  type ContentReleaseStageInput,
  type ContentVerificationPorts,
} from '../../../apps/mobile/src/data/contentReleaseStore';
import { packageFingerprint } from '../../../apps/mobile/src/data/contentReleaseStoreSchema';
import { authoredFixture } from '../../catalogue/test/content-fixtures';
import { published } from '../../catalogue/test/content-overlay-fixtures';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
const sha256Bytes = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const at = '2026-10-01T12:00:00.000Z';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-'));
  const filename = join(directory, 'content.sqlite');
  const base = await createBundledRecipeRevision(catalogue.recipes[0]!.recipeId, sha256);
  const baseline = { identity: { ...catalogue.identity }, revisions: [base] };
  const baselineBytes = await readFile(
    fileURLToPath(
      new URL(`../../catalogue/assets/photos/${base.ref.recipeId}.jpg`, import.meta.url),
    ),
  );
  const media = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#72974b' } })
    .png()
    .toBuffer();
  const mediaHash = await sha256Bytes(media);
  const document = authoredFixture('90001');
  document.recipe.photoKey = `photos/${mediaHash}.png`;
  document.media[0] = {
    ...document.media[0]!,
    assetId: `sha256:${mediaHash}`,
    sha256: mediaHash,
    bytes: media.length,
    mimeType: 'image/png',
    photoKey: document.recipe.photoKey,
    dimensions: { ...document.media[0]!.dimensions!, width: 2, height: 2 },
  };
  const publication = await published(document);
  const pair = generateKeyPairSync('ed25519');
  const trust = [
    {
      keyId: 'fixture-consumer-key',
      publicKeyHex: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
        'hex',
      ),
    },
  ];
  const signer = createContentOverlaySigner({
    keyId: trust[0]!.keyId,
    privateKey: pair.privateKey,
  });
  let decodes = 0,
    hashes = 0;
  const ports: ContentVerificationPorts = {
    baseline,
    readerVersion: 1,
    trustVerifier: createContentTrustVerifier(trust),
    sha256,
    async sha256Bytes(bytes) {
      hashes++;
      return sha256Bytes(bytes);
    },
    async inspectImage(bytes) {
      decodes++;
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
    async readBundledMedia(reference) {
      return reference.sha256 === base.document.media[0]!.sha256 ? baselineBytes : null;
    },
  };
  const connections: { close(): Promise<void> }[] = [];
  let database: ReturnType<typeof desktopConnection>['database'];
  let failCommit = false;
  let rejectCommit = false;
  let materializedTextBytes = 0;
  async function open() {
    const writer = desktopConnection(filename),
      reader = desktopConnection(filename);
    database = writer.database;
    const originalExec = writer.connection.exec;
    writer.connection.exec = async (sql) => {
      if (rejectCommit && sql === 'COMMIT') {
        rejectCommit = false;
        throw new Error('fixture failed commit');
      }
      await originalExec(sql);
      if (failCommit && sql === 'COMMIT') {
        failCommit = false;
        throw new Error('fixture lost commit acknowledgement');
      }
    };
    const originalAll = reader.connection.all;
    reader.connection.all = async <Row extends object>(
      sql: string,
      values?: Parameters<typeof originalAll>[1],
    ) => {
      const rows = await originalAll<Row>(sql, values);
      for (const row of rows)
        for (const value of Object.values(row))
          if (typeof value === 'string') materializedTextBytes += Buffer.byteLength(value);
      return rows;
    };
    const store = await openContentReleaseStore({
      ...ports,
      readConnection: reader.connection,
      writeConnection: writer.connection,
      now: () => new Date(at),
    });
    connections.push(store);
    return store;
  }
  let store = await open();
  t.after(async () => {
    for (const connection of connections) await connection.close();
    await removeFixtureDirectory(directory);
  });
  const entry: OverlayEntry = {
    state: 'current',
    ref: publication.revision.ref,
    publicationFingerprint: publication.publicationFingerprint,
  };
  async function release(
    previous: OverlayHead | null = null,
    entries: OverlayEntry[] = [entry],
    minimumReaderVersion = 1,
  ) {
    const manifest: ContentOverlayManifest = {
      formatVersion: 2,
      releaseId: `fixture-release-${(previous?.sequence ?? 0) + 1}`,
      sequence: (previous?.sequence ?? 0) + 1,
      previous,
      createdAt: at,
      minimumReaderVersion,
      baseline: baseline.identity,
      entries,
    };
    return signer.signManifest(manifest);
  }
  function input(
    envelope: SignedContentOverlay,
    stageId = `stage-${envelope.manifest.sequence}`,
    includePublication = true,
  ): ContentReleaseStageInput {
    return {
      stageId,
      envelope,
      publications: includePublication ? [publication] : [],
      media: includePublication ? [{ sha256: mediaHash, bytes: media }] : [],
    };
  }
  return {
    ports,
    baseline,
    base,
    media,
    mediaHash,
    publication,
    entry,
    filename,
    release,
    input,
    open,
    get store() {
      return store;
    },
    get database() {
      return database;
    },
    counters() {
      return { decodes, hashes, materializedTextBytes };
    },
    resetCounters() {
      decodes = 0;
      hashes = 0;
      materializedTextBytes = 0;
    },
    loseCommitAcknowledgement() {
      failCommit = true;
    },
    failNextCommit() {
      rejectCommit = true;
    },
    async reopen() {
      await store.close();
      store = await open();
    },
    async activate(envelope: SignedContentOverlay, includePublication = true) {
      const staged = await store.stage(input(envelope, undefined, includePublication));
      const review = await store.reviewStage(staged.stageId, {
        expectedHead: envelope.manifest.previous,
        retainedRefs: [],
      });
      return store.activate(review, `activate-${envelope.manifest.sequence}`);
    },
  };
}

test('actual SQLite stage readback stays untrusted, then exact activation atomically survives reopen and revalidates bytes', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.hydrate(), { kind: 'baseline', head: null, highWater: 0 });
  const envelope = await f.release();
  const staged = await f.store.stage(f.input(envelope));
  assert.deepEqual(await f.store.readStage(), staged);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM content_store_release').get()!.n, 0);
  await f.reopen();
  assert.deepEqual(await f.store.readStage(), staged);
  const review = await f.store.reviewStage(staged.stageId, {
    expectedHead: null,
    retainedRefs: [],
  });
  assert.equal(Object.isFrozen(review.manifest.entries), true);
  await assert.rejects(f.store.activate(structuredClone(review), 'cloned'), {
    code: 'review_invalid',
  });
  const receipt = await f.store.activate(review, 'activate-one');
  assert.equal(receipt.status, 'activated_in_content_store');
  assert.equal(await f.store.readStage(), null);
  assert.deepEqual(
    await f.store.recoverActivation('activate-one', staged.packageFingerprint),
    receipt,
  );
  await f.reopen();
  f.resetCounters();
  const hydrated = await f.store.hydrate();
  assert.equal(hydrated.kind, 'active');
  if (hydrated.kind !== 'active') assert.fail();
  assert.equal(hydrated.snapshot.lookupCurrent('90001').kind, 'readable');
  assert.deepEqual(hydrated.head, receipt.head);
  assert.equal(f.counters().decodes, 2);
  assert.deepEqual(
    await f.store.recoverActivation('activate-one', staged.packageFingerprint),
    receipt,
  );
  await assert.rejects(f.store.recoverActivation('activate-one', '0'.repeat(64)), {
    code: 'operation_conflict',
  });
  f.database
    .prepare('UPDATE content_store_operation SET receipt_json=?')
    .run(JSON.stringify({ ...receipt, head: { ...receipt.head, fingerprint: '0'.repeat(64) } }));
  await assert.rejects(f.store.hydrate(), { code: 'content_store_invalid' });
  f.database.prepare('DELETE FROM content_store_operation').run();
  await assert.rejects(f.store.hydrate(), { code: 'content_store_invalid' });
  f.database
    .prepare('INSERT INTO content_store_operation VALUES(?,?,?,?)')
    .run(
      receipt.operationId,
      receipt.head.releaseId,
      receipt.packageFingerprint,
      JSON.stringify(receipt),
    );
  assert.equal((await f.store.hydrate()).kind, 'active');
});

test('untrusted signature, incompatible reader, out-of-order head and missing media cannot affect last-known-good', async (t) => {
  const f = await fixture(t);
  for (const kind of ['signature', 'reader', 'sequence', 'missing'] as const) {
    const envelope = await f.release(
      kind === 'sequence' ? { releaseId: 'prior', sequence: 1, fingerprint: 'a'.repeat(64) } : null,
      [f.entry],
      kind === 'reader' ? 2 : 1,
    );
    if (kind === 'signature') envelope.signature.value = '0'.repeat(128);
    const input = f.input(envelope, `invalid-${kind}`);
    if (kind === 'missing') input.media = [];
    const staged = await f.store.stage(input);
    await assert.rejects(
      f.store.reviewStage(staged.stageId, { expectedHead: null, retainedRefs: [] }),
    );
    assert.deepEqual(await f.store.hydrate(), { kind: 'baseline', head: null, highWater: 0 });
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM content_store_operation').get()!.n, 0);
    await f.store.discardStage(staged.stageId, staged.packageFingerprint, staged.stageEpoch);
  }
});

test('staged and committed tampering is detected from persisted data on review and independent restart', async (t) => {
  const f = await fixture(t);
  const envelope = await f.release();
  const staged = await f.store.stage(f.input(envelope));
  f.database.prepare('UPDATE content_store_stage_media SET hex=?').run('00'.repeat(f.media.length));
  await assert.rejects(
    f.store.reviewStage(staged.stageId, { expectedHead: null, retainedRefs: [] }),
  );
  await f.store.discardStage(staged.stageId, staged.packageFingerprint, staged.stageEpoch);
  const receipt = await f.activate(envelope);
  const original = f.database
    .prepare('SELECT envelope_json,publications_json,media_json FROM content_store_release')
    .get()!;
  const corrupted = JSON.parse(original.envelope_json as string) as SignedContentOverlay;
  corrupted.signature.value = '0'.repeat(128);
  const json = canonicalContentJson(corrupted);
  const fingerprint = await packageFingerprint(
    sha256,
    json,
    original.publications_json as string,
    JSON.parse(original.media_json as string),
  );
  f.database
    .prepare('UPDATE content_store_release SET envelope_json=?,fingerprint=?')
    .run(json, fingerprint);
  await f.reopen();
  await assert.rejects(f.store.hydrate(), /overlay_untrusted/);
  assert.equal(
    f.database.prepare('SELECT high_water FROM content_store_meta').get()!.high_water,
    receipt.head.sequence,
  );
  f.database
    .prepare('UPDATE content_store_release SET envelope_json=?,fingerprint=?')
    .run(original.envelope_json as string, staged.packageFingerprint);
  const repeated = await f.activate(await f.release(receipt.head));
  const second = f.database
    .prepare(
      'SELECT envelope_json,publications_json,media_json FROM content_store_release WHERE release_id=?',
    )
    .get(repeated.head.releaseId)!;
  const incorrectMedia = JSON.parse(second.media_json as string) as {
    sha256: string;
    bytes: number;
  }[];
  incorrectMedia[0]!.bytes++;
  const incorrectFingerprint = await packageFingerprint(
    sha256,
    second.envelope_json as string,
    second.publications_json as string,
    incorrectMedia,
  );
  f.database
    .prepare('UPDATE content_store_release SET media_json=?,fingerprint=? WHERE release_id=?')
    .run(canonicalContentJson(incorrectMedia), incorrectFingerprint, repeated.head.releaseId);
  f.database
    .prepare('UPDATE content_store_operation SET fingerprint=?,receipt_json=? WHERE release_id=?')
    .run(
      incorrectFingerprint,
      canonicalContentJson({ ...repeated, packageFingerprint: incorrectFingerprint }),
      repeated.head.releaseId,
    );
  await f.reopen();
  // Both releases contain the same genuine bytes and signed reference. A cached hash must
  // still reject the later package's contradictory byte count, even with rebound local checksums.
  await assert.rejects(f.store.hydrate(), { code: 'content_store_invalid' });
  f.database
    .prepare('UPDATE content_store_release SET media_json=?,fingerprint=? WHERE release_id=?')
    .run(second.media_json as string, repeated.packageFingerprint, repeated.head.releaseId);
  f.database
    .prepare('UPDATE content_store_operation SET fingerprint=?,receipt_json=? WHERE release_id=?')
    .run(repeated.packageFingerprint, canonicalContentJson(repeated), repeated.head.releaseId);
  f.database.prepare('DELETE FROM content_store_media').run();
  await f.reopen();
  await assert.rejects(f.store.hydrate());
});

test('failed transaction retains previous activation and stage; lost commit acknowledgement recovers after independent reopen', async (t) => {
  const f = await fixture(t);
  const envelope = await f.release();
  const staged = await f.store.stage(f.input(envelope));
  const review = await f.store.reviewStage(staged.stageId, {
    expectedHead: null,
    retainedRefs: [],
  });
  f.database.exec(
    "CREATE TRIGGER fixture_activation_fault BEFORE INSERT ON content_store_operation BEGIN SELECT RAISE(ABORT,'fixture interrupted activation'); END;",
  );
  await assert.rejects(f.store.activate(review, 'interrupted'), /fixture interrupted activation/);
  assert.deepEqual(await f.store.hydrate(), { kind: 'baseline', head: null, highWater: 0 });
  assert.deepEqual(await f.store.readStage(), staged);
  assert.equal(await f.store.recoverActivation('interrupted', staged.packageFingerprint), null);
  f.database.exec('DROP TRIGGER fixture_activation_fault');
  f.failNextCommit();
  await assert.rejects(f.store.activate(review, 'interrupted'), /fixture failed commit/);
  assert.deepEqual(await f.store.hydrate(), { kind: 'baseline', head: null, highWater: 0 });
  assert.deepEqual(await f.store.readStage(), staged);
  f.loseCommitAcknowledgement();
  await assert.rejects(
    f.store.activate(review, 'interrupted'),
    /fixture lost commit acknowledgement/,
  );
  await f.reopen();
  const recovered = await f.store.recoverActivation('interrupted', staged.packageFingerprint);
  assert.equal(recovered?.head.sequence, 1);
  assert.equal(await f.store.readStage(), null);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM content_store_operation').get()!.n, 1);
});

test('concurrent activation CAS and separate connection stale/discarded capabilities cannot replace a newer decision', async (t) => {
  const f = await fixture(t);
  const envelope = await f.release();
  const staged = await f.store.stage(f.input(envelope));
  const a = await f.store.reviewStage(staged.stageId, { expectedHead: null, retainedRefs: [] });
  const second = await f.open();
  const b = await second.reviewStage(staged.stageId, { expectedHead: null, retainedRefs: [] });
  await f.store.discardStage(staged.stageId, staged.packageFingerprint, staged.stageEpoch);
  const replacement = await f.store.stage(f.input(envelope));
  assert.notEqual(replacement.stageEpoch, staged.stageEpoch);
  await assert.rejects(
    second.discardStage(staged.stageId, staged.packageFingerprint, staged.stageEpoch),
    { code: 'stage_changed' },
  );
  assert.deepEqual(await f.store.readStage(), replacement);
  await assert.rejects(second.activate(b, 'old-discarded'), { code: 'stage_changed' });
  await assert.rejects(f.store.activate(a, 'old-local'), { code: 'stage_changed' });
  const first = await f.store.reviewStage(staged.stageId, { expectedHead: null, retainedRefs: [] });
  const rival = await f.store.reviewStage(staged.stageId, { expectedHead: null, retainedRefs: [] });
  const results = await Promise.allSettled([
    f.store.activate(first, 'first'),
    f.store.activate(rival, 'rival'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected');
  assert.equal(failed?.status === 'rejected' && failed.reason.code, 'head_changed');
  await assert.rejects(second.activate(b, 'late-other-connection'), { code: 'head_changed' });
});

test('rollback needs a newer signed sequence, archives retain exact references and withdrawals remain sticky', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release());
  const archived = await f.activate(
    await f.release(first.head, [
      { ...f.entry, state: 'archived', reason: 'Synthetic archived fixture.' },
    ]),
    false,
  );
  const hidden = await f.store.hydrate([f.publication.revision.ref]);
  assert.equal(hidden.kind, 'active');
  if (hidden.kind !== 'active') assert.fail();
  assert.equal(hidden.snapshot.lookupDiscoverable('90001').kind, 'missing');
  assert.equal(hidden.snapshot.lookupExact(f.publication.revision.ref).kind, 'readable');
  const rollback = await f.activate(await f.release(archived.head, [f.entry]), false);
  assert.equal(rollback.head.sequence, 3);
  f.resetCounters();
  await f.store.hydrate([f.publication.revision.ref]);
  assert.equal(
    f.counters().decodes,
    2,
    'one decode per exact association across all historical releases',
  );
  const withdrawal = await f.activate(
    await f.release(rollback.head, [
      { state: 'withdrawn', recipeId: '90001', reason: 'Synthetic withdrawal.' },
    ]),
    false,
  );
  const removed = await f.store.hydrate([f.publication.revision.ref]);
  assert.equal(removed.kind, 'active');
  if (removed.kind !== 'active') assert.fail();
  assert.equal(removed.snapshot.lookupExact(f.publication.revision.ref).kind, 'withdrawn');
  const invalid = await f.store.stage(
    f.input(await f.release(withdrawal.head, [f.entry]), 'resurrection', false),
  );
  await assert.rejects(
    f.store.reviewStage(invalid.stageId, { expectedHead: withdrawal.head, retainedRefs: [] }),
    /overlay_not_cumulative/,
  );
  assert.equal((await f.store.hydrate()).highWater, 4);
});

test('exact retained head survives later activation and reopen without changing latest head, stage or receipts', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release());
  const latest = await f.activate(
    await f.release(first.head, [
      { ...f.entry, state: 'archived', reason: 'Synthetic archived fixture.' },
    ]),
    false,
  );
  const pending = await f.store.stage(f.input(await f.release(latest.head), 'pending', false));
  await f.reopen();
  const meta = f.database.prepare('SELECT * FROM content_store_meta').get();
  const receipts = f.database
    .prepare('SELECT * FROM content_store_operation ORDER BY release_id')
    .all();
  const changes = f.database.prepare('SELECT total_changes() n').get()!.n;
  f.resetCounters();
  const retained = await f.store.readRetainedHead(first.head, [f.publication.revision.ref]);
  assert.equal(retained.kind, 'retained');
  assert.deepEqual(retained.selectedHead, first.head);
  assert.deepEqual(retained.latestHead, latest.head);
  assert.equal(retained.highWater, 2);
  assert.equal(retained.snapshot.lookupDiscoverable('90001').kind, 'readable');
  assert.equal(retained.snapshot.lookupExact(f.publication.revision.ref).kind, 'readable');
  assert.equal(Object.isFrozen(retained), true);
  assert.equal(Object.isFrozen(retained.selectedHead), true);
  assert.equal(Object.isFrozen(retained.snapshot.envelope), true);
  assert.equal(
    f.counters().decodes,
    2,
    'retained selection reuses the same full-chain media verification',
  );
  assert.equal(f.database.prepare('SELECT total_changes() n').get()!.n, changes);
  assert.deepEqual(f.database.prepare('SELECT * FROM content_store_meta').get(), meta);
  assert.deepEqual(
    f.database.prepare('SELECT * FROM content_store_operation ORDER BY release_id').all(),
    receipts,
  );
  assert.deepEqual(await f.store.readStage(), pending);
  const current = await f.store.hydrate();
  assert.equal(current.kind, 'active');
  if (current.kind !== 'active') assert.fail();
  assert.deepEqual(current.head, latest.head);
  assert.equal(current.snapshot.lookupDiscoverable('90001').kind, 'missing');
  for (const head of [
    { ...first.head, fingerprint: '0'.repeat(64) },
    { ...first.head, sequence: 2 },
    { ...first.head, releaseId: 'unknown-committed-release' },
  ])
    await assert.rejects(f.store.readRetainedHead(head), {
      code: 'content_store_retained_head_unavailable',
    });
});

test('retained pins cannot acquire recipe revisions first published after the selected head', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release(null, []), false);
  const latest = await f.activate(await f.release(first.head));
  await f.reopen();
  const selected = await f.store.readRetainedHead(first.head, [f.base.ref]);
  assert.equal(selected.snapshot.lookupCurrent('90001').kind, 'missing');
  assert.equal(selected.snapshot.lookupExact(f.base.ref).kind, 'readable');
  await assert.rejects(f.store.readRetainedHead(first.head, [f.publication.revision.ref]), {
    code: 'overlay_dependency_missing',
  });
  const current = await f.store.readRetainedHead(latest.head, [f.publication.revision.ref]);
  assert.equal(current.snapshot.lookupExact(f.publication.revision.ref).kind, 'readable');
  assert.equal(current.highWater, 2);
  await f.activate(
    await f.release(latest.head, [
      { state: 'withdrawn', recipeId: '90001', reason: 'Synthetic withdrawal.' },
    ]),
    false,
  );
  assert.equal(
    (await f.store.readRetainedHead(first.head, [f.base.ref])).highWater,
    3,
    'a withdrawal of content absent from the selected snapshot does not expose an old body',
  );
});

test('retained read validates the entire later committed chain including signatures, receipts and media descriptors', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release());
  const latest = await f.activate(await f.release(first.head));
  const row = f.database
    .prepare('SELECT * FROM content_store_release WHERE release_id=?')
    .get(latest.head.releaseId)!;
  for (const kind of ['receipt', 'signature', 'media'] as const) {
    const envelope = JSON.parse(row.envelope_json as string) as SignedContentOverlay;
    const media = JSON.parse(row.media_json as string) as { sha256: string; bytes: number }[];
    if (kind === 'signature') envelope.signature.value = '0'.repeat(128);
    if (kind === 'media') media[0]!.bytes++;
    const envelopeJson = canonicalContentJson(envelope);
    const fingerprint = await packageFingerprint(
      sha256,
      envelopeJson,
      row.publications_json as string,
      media,
    );
    f.database
      .prepare(
        'UPDATE content_store_release SET envelope_json=?,media_json=?,fingerprint=? WHERE release_id=?',
      )
      .run(envelopeJson, canonicalContentJson(media), fingerprint, latest.head.releaseId);
    f.database
      .prepare('UPDATE content_store_operation SET fingerprint=?,receipt_json=? WHERE release_id=?')
      .run(
        fingerprint,
        canonicalContentJson({
          ...latest,
          packageFingerprint: fingerprint,
          ...(kind === 'receipt' ? { head: first.head } : {}),
        }),
        latest.head.releaseId,
      );
    await f.reopen();
    await assert.rejects(f.store.readRetainedHead(first.head), {
      code: kind === 'signature' ? 'overlay_untrusted' : 'content_store_invalid',
    });
  }
  f.database
    .prepare(
      'UPDATE content_store_release SET envelope_json=?,media_json=?,fingerprint=? WHERE release_id=?',
    )
    .run(
      row.envelope_json as string,
      row.media_json as string,
      latest.packageFingerprint,
      latest.head.releaseId,
    );
  f.database
    .prepare('UPDATE content_store_operation SET fingerprint=?,receipt_json=? WHERE release_id=?')
    .run(latest.packageFingerprint, canonicalContentJson(latest), latest.head.releaseId);
  assert.deepEqual((await f.store.readRetainedHead(first.head)).latestHead, latest.head);
});

test('newer verified withdrawals block old exposed bodies including archived recipes', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release());
  const archived = await f.activate(
    await f.release(first.head, [{ ...f.entry, state: 'archived', reason: 'Synthetic archive.' }]),
    false,
  );
  const latest = await f.activate(
    await f.release(archived.head, [
      { state: 'withdrawn', recipeId: '90001', reason: 'Synthetic authored withdrawal.' },
    ]),
    false,
  );
  await f.reopen();
  for (const selected of [first.head, archived.head]) {
    await assert.rejects(f.store.readRetainedHead(selected), {
      code: 'content_store_adoption_policy_changed',
    });
    await assert.rejects(f.store.readRetainedHead(selected, [f.publication.revision.ref]), {
      code: 'content_store_adoption_policy_changed',
    });
  }
  const current = await f.store.readRetainedHead(latest.head);
  assert.equal(current.snapshot.lookupExact(f.publication.revision.ref).kind, 'withdrawn');
  assert.equal(current.highWater, 3);
  await assert.rejects(f.store.readRetainedHead(latest.head, [f.publication.revision.ref]), {
    code: 'content_store_retained_ref_unavailable',
  });
});

test('retained-head withdrawal policy also covers inherited packaged recipes', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release(null, []), false);
  const latest = await f.activate(
    await f.release(first.head, [
      {
        state: 'withdrawn',
        recipeId: f.base.ref.recipeId,
        reason: 'Synthetic baseline withdrawal.',
      },
    ]),
    false,
  );
  await f.reopen();
  await assert.rejects(f.store.readRetainedHead(first.head), {
    code: 'content_store_adoption_policy_changed',
  });
  assert.equal(
    (await f.store.readRetainedHead(latest.head)).snapshot.lookupExact(f.base.ref).kind,
    'withdrawn',
  );
});

test('bounds precede large media copies and corrupt archive payload materialization; unrelated databases are preserved', async (t) => {
  const f = await fixture(t);
  const envelope = await f.release();
  f.resetCounters();
  await assert.rejects(
    f.store.stage({
      ...f.input(envelope),
      media: [
        { sha256: 'a'.repeat(64), bytes: new Uint8Array(17 * 1024 * 1024) },
        { sha256: 'b'.repeat(64), bytes: new Uint8Array(17 * 1024 * 1024) },
      ],
    }),
    { code: 'content_store_limit' },
  );
  assert.equal(f.counters().hashes, 0);
  assert.equal(await f.store.readStage(), null);
  await f.activate(envelope);
  f.database
    .prepare('UPDATE content_store_release SET envelope_json=zeroblob(?)')
    .run(CONTENT_LIMITS.releaseBytes + 1);
  f.resetCounters();
  await assert.rejects(f.store.hydrate(), { code: 'content_store_limit' });
  assert.equal(f.counters().materializedTextBytes, 0);
  f.database
    .prepare('UPDATE content_store_release SET envelope_json=?')
    .run(canonicalContentJson(envelope));
  const insert = f.database.prepare('INSERT INTO content_store_release VALUES(?,?,?,?,?,?)');
  for (let sequence = 2; sequence <= CONTENT_STORE_LIMITS.releases + 1; sequence++)
    insert.run(`over-bound-${sequence}`, sequence, 'a'.repeat(64), '{}', '[]', '[]');
  f.resetCounters();
  await assert.rejects(f.store.hydrate(), { code: 'content_store_limit' });
  assert.equal(f.counters().materializedTextBytes, 0);
  const otherFile = join(dirname(f.filename), 'cooking.sqlite');
  const unrelated = new DatabaseSync(otherFile);
  unrelated.exec(
    "CREATE TABLE cooking_fixture(original TEXT); INSERT INTO cooking_fixture VALUES('preserve')",
  );
  unrelated.close();
  const writer = desktopConnection(otherFile),
    reader = desktopConnection(otherFile);
  await assert.rejects(
    openContentReleaseStore({
      ...f.ports,
      readConnection: reader.connection,
      writeConnection: writer.connection,
      now: () => new Date(at),
    }),
    { code: 'content_store_incompatible' },
  );
  const preserved = new DatabaseSync(otherFile);
  assert.equal(
    preserved.prepare('SELECT original FROM cooking_fixture').get()!.original,
    'preserve',
  );
  preserved.close();
});

test('close stops writer admission immediately and still closes it after reader cleanup fails', async (t) => {
  const f = await fixture(t);
  const filename = join(dirname(f.filename), 'close-failure.sqlite');
  const reader = desktopConnection(filename),
    writer = desktopConnection(filename);
  const closeReader = reader.connection.close,
    closeWriter = writer.connection.close;
  let releaseReader!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseReader = resolve;
  });
  let writerCloses = 0;
  reader.connection.close = async () => {
    await blocked;
    await closeReader();
    throw new Error('fixture reader close failure');
  };
  writer.connection.close = async () => {
    writerCloses++;
    await closeWriter();
  };
  const store = await openContentReleaseStore({
    ...f.ports,
    readConnection: reader.connection,
    writeConnection: writer.connection,
    now: () => new Date(at),
  });
  const envelope = await f.release();
  const closing = store.close();
  void closing.catch(() => undefined);
  let admissionRejected = false;
  const lateStage = store.stage(f.input(envelope)).then(
    () => assert.fail('closing store admitted a write'),
    (error) => {
      assert.match(String(error), /Store is closing/);
      admissionRejected = true;
    },
  );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      admissionRejected,
      true,
      'writer admissions stop before waiting for the reader to close',
    );
    releaseReader();
    await assert.rejects(
      closing,
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 1 &&
        String(error.errors[0]).includes('fixture reader close failure'),
    );
    await lateStage;
    assert.equal(writerCloses, 1);
  } finally {
    releaseReader();
    await Promise.allSettled([closing, lateStage]);
    await closeWriter().catch(() => undefined);
  }
});

test('verified adoption holds content writes until the cooking callback settles and releases after failure', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release());
  const next = await f.release(first.head, [f.entry]);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const comparing = f.store.withVerifiedAdoption(
    {
      previousHead: null,
      candidateHead: first.head,
      previousRefs: [f.base.ref],
      retainedRefs: [f.base.ref, f.publication.revision.ref],
    },
    async (views) => {
      assert.equal(views.previous, null);
      assert.deepEqual(views.head, first.head);
      assert.equal(views.candidate.lookupExact(f.publication.revision.ref).kind, 'readable');
      entered();
      await wait;
      throw new Error('fixture cooking rollback');
    },
  );
  void comparing.catch(() => undefined);
  await started;
  let staged = false;
  const staging = f.store.stage(f.input(next, 'queued-stage', false)).then((value) => {
    staged = true;
    return value;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(staged, false);
    assert.equal(f.database.prepare('SELECT COUNT(*) n FROM content_store_stage').get()!.n, 0);
  } finally {
    finish();
  }
  await assert.rejects(comparing, /fixture cooking rollback/);
  await staging;
  assert.equal(staged, true);
  assert.equal((await f.store.hydrate()).head?.sequence, 1, 'staging is not activation');
});

test('adoption verifies old and new exact pins separately, rejecting stale head and withdrawn target before work', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release(null, []), false);
  const second = await f.activate(await f.release(first.head));
  let calls = 0;
  const input = {
    previousHead: first.head,
    candidateHead: second.head,
    previousRefs: [f.base.ref],
    retainedRefs: [f.base.ref, f.publication.revision.ref],
  };
  await f.store.withVerifiedAdoption(input, async (views) => {
    calls++;
    assert.equal(views.previous!.lookupExact(f.base.ref).kind, 'readable');
    assert.notEqual(views.previous!.lookupExact(f.publication.revision.ref).kind, 'readable');
    assert.equal(views.candidate.lookupExact(f.publication.revision.ref).kind, 'readable');
  });
  await assert.rejects(
    f.store.withVerifiedAdoption({ ...input, candidateHead: first.head }, async () => {
      calls++;
    }),
    { code: 'head_changed' },
  );
  await assert.rejects(
    f.store.withVerifiedAdoption(
      { ...input, previousHead: { ...first.head, fingerprint: 'f'.repeat(64) } },
      async () => {
        calls++;
      },
    ),
    { code: 'content_store_retained_head_unavailable' },
  );
  const withdrawn = await f.activate(
    await f.release(second.head, [
      {
        state: 'withdrawn',
        recipeId: f.publication.revision.ref.recipeId,
        reason: 'Synthetic withdrawal',
      },
    ]),
    false,
  );
  await assert.rejects(
    f.store.withVerifiedAdoption({ ...input, candidateHead: withdrawn.head }, async () => {
      calls++;
    }),
    { code: 'content_store_retained_ref_unavailable' },
  );
  assert.equal(calls, 1);
});

for (const mode of ['adoption', 'reading'] as const)
  test(`${mode} reservation excludes an independent WAL writer until the cooking callback settles`, async (t) => {
    const f = await fixture(t);
    f.database.exec('PRAGMA journal_mode=WAL');
    const first = await f.activate(await f.release());
    const other = await f.open();
    f.database.exec('PRAGMA busy_timeout=0');
    const next = await f.release(first.head, [f.entry]);
    const staged = await other.stage(f.input(next, 'independent-stage', false));
    const review = await other.reviewStage(staged.stageId, {
      expectedHead: first.head,
      retainedRefs: [],
    });
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const hold = async () => {
      entered();
      await wait;
    };
    const cooking =
      mode === 'reading'
        ? f.store.withVerifiedReading(first.head, [f.base.ref], hold)
        : f.store.withVerifiedAdoption(
            {
              previousHead: first.head,
              candidateHead: first.head,
              previousRefs: [f.base.ref],
              retainedRefs: [f.base.ref],
            },
            hold,
          );
    await started;
    try {
      await assert.rejects(other.activate(review, 'independent-activate'), /database is locked/);
      assert.equal(
        f.database.prepare('SELECT high_water FROM content_store_meta').get()!.high_water,
        1,
      );
    } finally {
      finish();
    }
    await cooking;
    assert.equal((await other.activate(review, 'independent-activate')).head.sequence, 2);
  });

test('explicit historical withdrawal preserves only an authenticated older exact identity, never its body', async (t) => {
  const f = await fixture(t);
  const first = await f.activate(await f.release());
  const ref = f.publication.revision.ref;
  const withdrawn = await f.activate(
    await f.release(first.head, [
      { state: 'withdrawn', recipeId: ref.recipeId, reason: 'Synthetic rights withdrawal' },
    ]),
    false,
  );
  const input = {
    previousHead: first.head,
    candidateHead: withdrawn.head,
    previousRefs: [ref],
    retainedRefs: [ref],
    preserveWithdrawnRefs: [ref],
  };
  await f.store.withVerifiedAdoption(input, async (views) => {
    assert.deepEqual(views.withdrawnRefs, [ref]);
    assert.equal(views.candidate.lookupExact(ref).kind, 'withdrawn');
    assert.equal(
      views.candidate.discoverable.some((value) => value.revision.ref.recipeId === ref.recipeId),
      false,
    );
  });
  // Already adopted withdrawal also retains the historical identity without restoring access.
  await f.store.withVerifiedAdoption({ ...input, previousHead: withdrawn.head }, async (views) => {
    assert.equal(views.previous!.lookupExact(ref).kind, 'withdrawn');
    assert.deepEqual(views.withdrawnRefs, [ref]);
  });
  const forged = { ...ref, contentFingerprint: 'f'.repeat(64) };
  let calls = 0;
  await assert.rejects(
    f.store.withVerifiedAdoption(
      {
        ...input,
        previousHead: withdrawn.head,
        previousRefs: [forged],
        retainedRefs: [forged],
        preserveWithdrawnRefs: [forged],
      },
      async () => {
        calls++;
      },
    ),
    { code: 'content_store_retained_ref_unavailable' },
  );
  await assert.rejects(
    f.store.withVerifiedAdoption({ ...input, previousRefs: [] }, async () => {
      calls++;
    }),
    { code: 'content_store_retained_ref_unavailable' },
  );
  await assert.rejects(
    f.store.withVerifiedAdoption({ ...input, preserveWithdrawnRefs: [] }, async () => {
      calls++;
    }),
    { code: 'content_store_retained_ref_unavailable' },
  );
  assert.equal(calls, 0);
});
