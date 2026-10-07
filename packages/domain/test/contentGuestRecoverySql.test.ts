import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createBundledContentSnapshot } from '@cookmate/catalogue/content';
import { assertContentGuestRecoverySettled } from '../../../apps/mobile/src/features/content/contentGuestRecovery';
import { createContentPrivateState } from '../../../apps/mobile/src/features/content/contentPrivateState';
import { preparePrivateContentWorkspace } from '../../../apps/mobile/src/features/content/preparePrivateContentWorkspace';
import {
  openPrivateContentRuntime,
  type PrivateContentRuntimeOptions,
} from '../../../apps/mobile/src/features/content/privateContentRuntime';
import {
  readPrivateContentConfiguration,
  privateContentDatabaseNames,
} from '../../../apps/mobile/src/features/content/privateContentConfig';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-guest-recovery-'));
  const config = readPrivateContentConfiguration(
    JSON.stringify({
      version: 1,
      installationId: randomUUID(),
      origin: 'http://localhost:19093',
      releaseId: 'fixture',
      trustKeys: [{ keyId: 'test', publicKeyHex: '1'.repeat(64) }],
    }),
    'http://localhost:19093',
  )!;
  const sha256 = async (text: string) => createHash('sha256').update(text).digest('hex');
  const baseline = await createBundledContentSnapshot(sha256);
  const mediaFiles = new Map(
    baseline.revisions.flatMap((revision) =>
      revision.document.media.map(
        (media) =>
          [
            media.sha256,
            new URL(`../../catalogue/assets/photos/${revision.ref.recipeId}.jpg`, import.meta.url),
          ] as const,
      ),
    ),
  );
  const values = new Map<string, string>();
  const state = createContentPrivateState(
    { installationId: config.installationId, ownerId: null },
    {
      read: async (key) => values.get(key) ?? null,
      write: async (key, value) => {
        values.set(key, value);
      },
    },
  );
  const names = privateContentDatabaseNames(config.installationId);
  let live = 0;
  const options: PrivateContentRuntimeOptions = {
    config,
    platform: { newId: randomUUID, sha256 },
    async openConnection(name) {
      assert.ok(name === names.cooking || name === names.content);
      const raw = desktopConnection(join(directory, name)).connection;
      live++;
      return {
        ...raw,
        async close() {
          await raw.close();
          live--;
        },
      };
    },
    verification: async () => ({
      baseline: { identity: baseline.catalogue, revisions: baseline.revisions },
      readerVersion: 1,
      sha256,
      sha256Bytes: async (bytes) => createHash('sha256').update(bytes).digest('hex'),
      trustVerifier: { verify: async () => false },
      async inspectImage(bytes) {
        const image = sharp(bytes);
        try {
          const metadata = await image.metadata();
          return metadata.width && metadata.height && metadata.format === 'jpeg'
            ? { width: metadata.width, height: metadata.height, mimeType: 'image/jpeg' as const }
            : null;
        } finally {
          image.destroy();
        }
      },
      async readBundledMedia(media) {
        const path = mediaFiles.get(media.sha256);
        return path ? new Uint8Array(await readFile(path)) : null;
      },
    }),
    journal: {
      read: async () => null,
      save: async () => {
        throw new Error('No release changes in this test');
      },
      clear: async () => undefined,
    },
    now: () => '2026-10-02T12:00:00.000Z',
    dateContext: () => ({ localDate: '2026-10-02', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 }),
    fetch: async () => {
      throw new Error('Network forbidden');
    },
  };
  await preparePrivateContentWorkspace(options);
  t.after(async () => {
    assert.equal(live, 0);
    await removeFixtureDirectory(directory);
  });
  let permitted = true;
  const lease = () => {
    if (!permitted) throw new Error('Closed lease ended');
  };
  return {
    options,
    state,
    values,
    lease,
    retire() {
      permitted = false;
    },
    get live() {
      return live;
    },
  };
}

test('committed guest restore archives permit a read-only account copy preflight and retain original metadata', async (t) => {
  const f = await fixture(t);
  const guest = await openPrivateContentRuntime(f.options);
  const capture = await guest.host.backup.capture();
  assert.equal(capture.kind, 'ready');
  assert.ok(capture.kind === 'ready');
  const review = await guest.host.restore.review(JSON.stringify(capture.value));
  assert.ok(review.kind === 'ready', JSON.stringify(review));
  const prepared = await guest.host.restore.prepare(review.value);
  assert.ok(prepared.kind === 'ready', JSON.stringify(prepared));
  const receipt = await guest.host.restore.execute(prepared.value);
  assert.ok(receipt.kind === 'receipt', JSON.stringify(receipt));
  await f.state.references.restore.remember(f.options.config.installationId, {
    operationId: prepared.value.operationId,
    preparedAt: f.options.now(),
  });
  await guest.close();
  const before = [...f.values];
  await assertContentGuestRecoverySettled(f.options, f.state.references, f.lease);
  assert.deepEqual([...f.values], before);
  assert.equal(f.live, 0);
});
test('unconfirmed restore identity blocks a copy and closes its verification host', async (t) => {
  const f = await fixture(t);
  await f.state.references.restore.remember(f.options.config.installationId, {
    operationId: randomUUID(),
    preparedAt: f.options.now(),
  });
  await assert.rejects(
    assertContentGuestRecoverySettled(f.options, f.state.references, f.lease),
    /original guest restore/,
  );
  assert.equal(f.live, 0);
});
test('pending manual work and an expired closed lease never open a verification host', async (t) => {
  const f = await fixture(t);
  await f.state.references.manual.remember(f.options.config.installationId, randomUUID());
  await assert.rejects(
    assertContentGuestRecoverySettled(f.options, f.state.references, f.lease),
    /pending changes/,
  );
  assert.equal(f.live, 0);
  f.retire();
  await assert.rejects(
    assertContentGuestRecoverySettled(f.options, f.state.references, f.lease),
    /lease ended/,
  );
  assert.equal(f.live, 0);
});
