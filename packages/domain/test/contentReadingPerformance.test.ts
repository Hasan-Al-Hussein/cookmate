import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import sharp from 'sharp';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledContentSnapshot,
  TRANSLATED_PUBLICATION_READER_VERSION,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { createContentOverlaySigner } from '../../../apps/admin/src/publishing/signer';
import { initializeDatabase } from '../../../apps/mobile/src/data/initialize';
import { migrateCookingContentDatabase } from '../../../apps/mobile/src/data/cookingContentMigration';
import { migrateAccountContentHistoryDatabase } from '../../../apps/mobile/src/data/accountContentHistoryMigration';
import { openContentCookingStore } from '../../../apps/mobile/src/data/contentCookingStore';
import {
  openContentReleaseStore,
  type ContentVerificationPorts,
} from '../../../apps/mobile/src/data/contentReleaseStore';
import {
  configureConnection,
  SerializedWriter,
  type SqlValue,
} from '../../../apps/mobile/src/data/sql';
import { desktopConnection } from './helpers/sqlite';

const at = '2026-10-02T00:00:00.000Z';
const enabled = process.env['COOKMATE_CONTENT_READING_PERFORMANCE'] === '1';
const rawHash = async (text: string) => createHash('sha256').update(text).digest('hex');
const rawByteHash = async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function counts() {
  return {
    bundledReads: 0,
    bundledBytes: 0,
    textHashes: 0,
    byteHashes: 0,
    hashedBytes: 0,
    imageDecodes: 0,
    signatureVerifications: 0,
    contentQueries: 0,
    cookingQueries: 0,
    contentTransactions: 0,
    cookingTransactions: 0,
  };
}
interface Sample {
  label: string;
  status: 'running' | 'passed' | 'failed';
  counts: ReturnType<typeof counts>;
  beforePhotoCounts: ReturnType<typeof counts> | null;
  started: number;
  reservationRequested: number | null;
  contentBegan: number | null;
  contentBeginOrder: number | null;
  verified: number | null;
  callbackFinished: number | null;
  finished: number | null;
  rssAtCompletion: number | null;
  heapUsedAtCompletion: number | null;
}
const elapsed = (end: number | null, start: number | null) =>
  end === null || start === null ? null : Math.round((end - start) * 1000) / 1000;

/**
 * Opt-in local work measurement, excluded from ordinary runs. It deliberately keeps the
 * real verification path and all installed recipes. Sharp decoding and node:sqlite timings
 * are not browser Image.decode, Expo/OPFS latency, rendering time, or an FPS measurement.
 */
test(
  'measure signed adopted reads over the full installed catalogue and queued card photos',
  { skip: !enabled, timeout: 300_000 },
  async (t) => {
    sharp.concurrency(1);
    sharp.cache(false);
    const context = new AsyncLocalStorage<Sample>();
    const samples: Sample[] = [];
    let beginOrder = 0;
    const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-content-reading-performance-'));
    const handles: ReturnType<typeof desktopConnection>['connection'][] = [];
    let delivery: Awaited<ReturnType<typeof openContentReleaseStore>> | undefined;
    let cooking: Awaited<ReturnType<typeof openContentCookingStore>> | undefined;
    const setupStarted = performance.now();
    let setupFinished: number | null = null;
    t.after(async () => {
      // Retain only this new owned fixture for inspection; never delete an old/blocked path.
      const failures: unknown[] = [];
      for (const owned of [cooking, delivery, ...handles]) {
        try {
          await owned?.close();
        } catch (error) {
          failures.push(error);
        }
      }
      const report = {
        formatVersion: 1,
        environment: 'local Node SQLite + serial Sharp full decode; not browser timings/FPS',
        fixtureRoot: directory,
        fixture:
          'One genuinely signed baseline-only release; no publication/translation payload cost',
        baselineRecipes: catalogue.recipes.length,
        baselineIdentity: catalogue.identity,
        setupMs: elapsed(setupFinished, setupStarted),
        repetitions: 3,
        queuedPhotos: 6,
        batchRepetitions: 3,
        cachePolicy: 'No fixture media-byte cache; OS file cache may be warm; Sharp cache disabled',
        byteHashPolicy:
          'Includes bundled-delivery hash (matching web contract) and verifier hashes',
        samples: samples.map((sample) => ({
          label: sample.label,
          status: sample.status,
          counts: sample.counts,
          hydrationCounts: sample.beforePhotoCounts,
          contentBeginOrder: sample.contentBeginOrder,
          timingsMs: {
            total: elapsed(sample.finished, sample.started),
            beforeReservation: elapsed(sample.reservationRequested, sample.started),
            reservationToBegin: elapsed(sample.contentBegan, sample.reservationRequested),
            beginToVerifiedView: elapsed(sample.verified, sample.contentBegan),
            verifiedViewToCallbackEnd: elapsed(sample.callbackFinished, sample.verified),
            callbackEndToResult: elapsed(sample.finished, sample.callbackFinished),
          },
          rssAtCompletion: sample.rssAtCompletion,
          heapUsedAtCompletion: sample.heapUsedAtCompletion,
        })),
        cleanupFailures: failures.length,
      };
      const encoded = JSON.stringify(report, null, 2);
      await writeFile(join(directory, 'measurement.json'), encoded);
      const output = process.env['COOKMATE_CONTENT_READING_PERFORMANCE_OUTPUT'];
      if (output) await writeFile(output, encoded);
      t.diagnostic(JSON.stringify(report));
      assert.deepEqual(failures, [], 'All disposable database handles must close');
    });

    function open(path: string, kind: 'content' | 'cooking') {
      const { connection } = desktopConnection(path);
      const { exec, all, close } = connection;
      let closed = false;
      connection.close = async () => {
        if (closed) return;
        await close();
        closed = true;
      };
      connection.exec = async (sql) => {
        const sample = context.getStore();
        if (sample && (sql === 'BEGIN' || sql === 'BEGIN IMMEDIATE')) {
          sample.counts[kind === 'content' ? 'contentTransactions' : 'cookingTransactions']++;
          if (kind === 'content') {
            sample.contentBegan = performance.now();
            sample.contentBeginOrder = ++beginOrder;
          }
        }
        await exec(sql);
      };
      connection.all = async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
        const sample = context.getStore();
        if (sample) sample.counts[kind === 'content' ? 'contentQueries' : 'cookingQueries']++;
        return all<Row>(sql, values);
      };
      handles.push(connection);
      return connection;
    }

    const baseline = await createBundledContentSnapshot(rawHash);
    assert.equal(baseline.revisions.length, 100);
    const media = new Map(
      baseline.revisions.flatMap((revision) =>
        revision.document.media.map(
          (reference) => [canonicalContentJson(reference), reference] as const,
        ),
      ),
    );
    assert.equal(media.size, 100);
    const pair = generateKeyPairSync('ed25519');
    const keyId = 'local-reading-measurement';
    const trust = createContentTrustVerifier([
      {
        keyId,
        publicKeyHex: Buffer.from(
          pair.publicKey.export({ format: 'jwk' }).x!,
          'base64url',
        ).toString('hex'),
      },
    ]);
    const hashBytes: ContentVerificationPorts['sha256Bytes'] = async (bytes) => {
      const sample = context.getStore();
      if (sample) {
        sample.counts.byteHashes++;
        sample.counts.hashedBytes += bytes.byteLength;
      }
      return rawByteHash(bytes);
    };
    const hashText: ContentVerificationPorts['sha256'] = async (text) => {
      const sample = context.getStore();
      if (sample) sample.counts.textHashes++;
      return rawHash(text);
    };
    const ports: ContentVerificationPorts = {
      baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
      readerVersion: TRANSLATED_PUBLICATION_READER_VERSION,
      sha256: hashText,
      sha256Bytes: hashBytes,
      trustVerifier: {
        async verify(input) {
          const sample = context.getStore();
          if (sample) sample.counts.signatureVerifications++;
          return trust.verify(input);
        },
      },
      async readBundledMedia(reference) {
        const owned = media.get(canonicalContentJson(reference));
        if (!owned) return null;
        const sample = context.getStore();
        if (sample) sample.counts.bundledReads++;
        const bytes = await readFile(
          new URL(`../../catalogue/assets/photos/${owned.recipeId}.jpg`, import.meta.url),
        );
        if (sample) sample.counts.bundledBytes += bytes.length;
        if (bytes.length !== owned.bytes || (await hashBytes(bytes)) !== owned.sha256) return null;
        return bytes;
      },
      async inspectImage(bytes) {
        const sample = context.getStore();
        if (sample) sample.counts.imageDecodes++;
        const image = sharp(bytes, { failOn: 'error' });
        try {
          const metadata = await image.metadata();
          if (
            !metadata.width ||
            !metadata.height ||
            !['jpeg', 'png', 'webp'].includes(metadata.format ?? '')
          )
            return null;
          // Force actual decoding, not just a header/metadata inspection.
          const decoded = await image.raw().toBuffer({ resolveWithObject: true });
          assert.equal(decoded.info.width, metadata.width);
          assert.equal(decoded.info.height, metadata.height);
          return {
            mimeType: `image/${metadata.format}` as 'image/jpeg' | 'image/png' | 'image/webp',
            width: metadata.width,
            height: metadata.height,
          };
        } finally {
          image.destroy();
        }
      },
    };
    const contentPath = join(directory, 'content.sqlite');
    const content = await openContentReleaseStore({
      ...ports,
      readConnection: open(contentPath, 'content'),
      writeConnection: open(contentPath, 'content'),
      now: () => new Date(at),
    });
    delivery = content;
    const signer = createContentOverlaySigner({ keyId, privateKey: pair.privateKey });
    const envelope = await signer.signManifest({
      formatVersion: 2,
      releaseId: 'local-reading-measurement-release',
      sequence: 1,
      previous: null,
      createdAt: at,
      minimumReaderVersion: TRANSLATED_PUBLICATION_READER_VERSION,
      baseline: catalogue.identity,
      entries: [],
    });
    const stage = await content.stage({
      stageId: 'local-reading-measurement-stage',
      envelope,
      publications: [],
      media: [],
    });
    const activation = await content.activate(
      await content.reviewStage(stage.stageId, { expectedHead: null, retainedRefs: [] }),
      'local-reading-measurement-activation',
    );

    const cookingPath = join(directory, 'cooking.sqlite');
    const seedConnection = open(cookingPath, 'cooking');
    await configureConnection(seedConnection);
    const writer = new SerializedWriter(seedConnection);
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
    await migrateCookingContentDatabase(writer, { sha256: rawHash });
    await migrateAccountContentHistoryDatabase(writer, { sha256: rawHash });
    await writer.close();
    const access = Object.freeze({ ownerId: null, authGeneration: 1 });
    const observed: Parameters<typeof openContentCookingStore>[0]['contentStore'] = {
      ...content,
      async withVerifiedReading(head, refs, work) {
        const sample = context.getStore();
        if (sample) sample.reservationRequested = performance.now();
        return content.withVerifiedReading(head, refs, async (view) => {
          if (sample) {
            sample.verified = performance.now();
            sample.beforePhotoCounts = { ...sample.counts };
          }
          try {
            return await work(view);
          } finally {
            if (sample) sample.callbackFinished = performance.now();
          }
        });
      },
    };
    const store = await openContentCookingStore({
      schemaVersion: 8,
      installationId: ids.installationId,
      openConnection: async () => open(cookingPath, 'cooking'),
      contentStore: observed,
      platform: { newId: randomUUID, sha256: hashText },
      now: () => at,
      dateContext: () => ({
        localDate: '2026-10-02',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
      getAccess: () => access,
      assertAccess(scope) {
        assert.deepEqual(scope, access);
        return undefined;
      },
    });
    cooking = store;
    const adopted = await store.adoption.adopt(
      await store.adoption.review({ candidateHead: activation.head }),
    );
    assert.deepEqual(adopted.head, activation.head);
    setupFinished = performance.now();

    async function measure<Value>(label: string, operation: () => Promise<Value>): Promise<Value> {
      const sample: Sample = {
        label,
        status: 'running',
        counts: counts(),
        beforePhotoCounts: null,
        started: performance.now(),
        reservationRequested: null,
        contentBegan: null,
        contentBeginOrder: null,
        verified: null,
        callbackFinished: null,
        finished: null,
        rssAtCompletion: null,
        heapUsedAtCompletion: null,
      };
      samples.push(sample);
      return context.run(sample, async () => {
        try {
          const value = await operation();
          sample.status = 'passed';
          return value;
        } catch (error) {
          sample.status = 'failed';
          throw error;
        } finally {
          sample.finished = performance.now();
          const memory = process.memoryUsage();
          sample.rssAtCompletion = memory.rss;
          sample.heapUsedAtCompletion = memory.heapUsed;
          t.diagnostic(
            `${label}: ${elapsed(sample.finished, sample.started)} local ms; ${JSON.stringify(sample.counts)}`,
          );
        }
      });
    }
    const first = baseline.revisions[0]!;
    for (let repetition = 1; repetition <= 3; repetition++) {
      const prefix = `sequential-${repetition}`;
      const discovery = await measure(`${prefix}-discover`, () => store.content.discover());
      assert.equal(discovery.value.length, 100);
      assert.deepEqual(discovery.head, activation.head);
      const current = await measure(`${prefix}-current`, () =>
        store.content.readCurrent(first.ref.recipeId),
      );
      assert.equal(current.value.kind, 'readable');
      if (current.value.kind !== 'readable') assert.fail();
      assert.deepEqual(current.value.recipe.contentRef, first.ref);
      const photo = await measure(`${prefix}-photo`, () =>
        store.content.readPhoto(first.ref, first.document.media[0]!.assetId),
      );
      assert.deepEqual(photo.value.contentRef, first.ref);
      assert.equal(await rawByteHash(photo.value.bytes), first.document.media[0]!.sha256);
    }
    const queued = baseline.revisions
      .slice(0, 6)
      .map((revision, index) =>
        measure(`queued-photo-${index + 1}`, () =>
          store.content.readPhoto(revision.ref, revision.document.media[0]!.assetId),
        ),
      );
    const opening = measure('queued-current', () => store.content.readCurrent(first.ref.recipeId));
    await Promise.all([...queued, opening]);

    const batchRequests = baseline.revisions.slice(0, 6).map((revision) => ({
      ref: revision.ref,
      assetId: revision.document.media[0]!.assetId,
    }));
    for (let repetition = 1; repetition <= 3; repetition++) {
      const photos = measure(`batch-photos-${repetition}`, () =>
        store.content.readPhotos(batchRequests),
      );
      const current = measure(`batch-current-${repetition}`, () =>
        store.content.readCurrent(first.ref.recipeId),
      );
      const [result, lookup] = await Promise.all([photos, current]);
      assert.equal(lookup.value.kind, 'readable');
      assert.equal(result.value.length, 6);
      for (const [index, item] of result.value.entries()) {
        assert.equal(item.kind, 'ready');
        if (item.kind !== 'ready') assert.fail();
        assert.deepEqual(item.photo.contentRef, batchRequests[index]!.ref);
        assert.equal(await rawByteHash(item.photo.bytes), item.photo.sha256);
      }
    }

    // Deterministic counts, not timing budgets. Every operation must retain genuine verification.
    for (const sample of samples.filter((entry) => !entry.label.startsWith('batch-'))) {
      const photo = sample.label.includes('photo');
      assert.equal(sample.status, 'passed');
      assert.equal(sample.counts.signatureVerifications, 1, sample.label);
      assert.equal(sample.counts.bundledReads, 100 + Number(photo), sample.label);
      assert.equal(sample.counts.imageDecodes, 100 + Number(photo), sample.label);
      assert.equal(sample.counts.byteHashes, 200 + 2 * Number(photo), sample.label);
      assert.equal(sample.counts.contentTransactions, 1, sample.label);
      assert.equal(sample.counts.cookingTransactions, 2, sample.label);
      assert.equal(sample.beforePhotoCounts?.imageDecodes, 100, sample.label);
      const kind = photo ? 'photo' : sample.label.endsWith('discover') ? 'discover' : 'current';
      const reference = samples.find((entry) => entry.label === `sequential-1-${kind}`)!;
      // Photo byte totals differ with each real image; all operation counts must agree.
      const { bundledBytes: _bundled, hashedBytes: _hashed, ...actualCounts } = sample.counts;
      const {
        bundledBytes: _referenceBundled,
        hashedBytes: _referenceHashed,
        ...referenceCounts
      } = reference.counts;
      assert.deepEqual(actualCounts, referenceCounts, sample.label);
    }
    for (const sample of samples.filter((entry) => entry.label.startsWith('batch-'))) {
      const photos = sample.label.startsWith('batch-photos') ? 6 : 0;
      assert.equal(sample.status, 'passed');
      assert.equal(sample.counts.signatureVerifications, 1, sample.label);
      assert.equal(sample.counts.bundledReads, 100 + photos, sample.label);
      assert.equal(sample.counts.imageDecodes, 100 + photos, sample.label);
      assert.equal(sample.counts.byteHashes, 200 + 2 * photos, sample.label);
      assert.equal(sample.counts.contentTransactions, 1, sample.label);
      assert.equal(sample.counts.cookingTransactions, 2, sample.label);
      assert.equal(sample.beforePhotoCounts?.imageDecodes, 100, sample.label);
    }
    const queuedOrder = samples
      .filter((sample) => sample.label.startsWith('queued-'))
      .sort((a, b) => a.contentBeginOrder! - b.contentBeginOrder!)
      .map((sample) => sample.label);
    assert.deepEqual(queuedOrder, [
      ...Array.from({ length: 6 }, (_, index) => `queued-photo-${index + 1}`),
      'queued-current',
    ]);
  },
);
