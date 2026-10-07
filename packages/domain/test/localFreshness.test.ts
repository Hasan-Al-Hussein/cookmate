import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLocalStore } from '../../../apps/mobile/src/data/localStore';
import { desktopConnection, removeFixtureDirectory } from './helpers/sqlite';

test('store exposes positive creation once and preserves its identity across real disk reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-welcome-'));
  const path = join(directory, 'guest.db');
  const open = () =>
    createLocalStore({
      enablePortableRestore: true,
      enableCooking: true,
      enablePersonal: true,
      openConnection: async () => desktopConnection(path).connection,
      platform: {
        newId: randomUUID,
        sha256: async (text) => createHash('sha256').update(text).digest('hex'),
      },
      now: () => '2026-10-01T00:00:00.000Z',
      dateContext: () => ({
        localDate: '2026-10-01',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
    });
  try {
    const first = await open();
    assert.equal(first.kind, 'ready');
    if (first.kind !== 'ready') return;
    assert.equal(first.initialization, 'created');
    const installation = await first.services.queries.readInstallationId();
    await first.services.close();
    const second = await open();
    assert.equal(second.kind, 'ready');
    if (second.kind !== 'ready') return;
    try {
      assert.equal(second.initialization, 'existing');
      assert.deepEqual(await second.services.queries.readInstallationId(), installation);
    } finally {
      await second.services.close();
    }
  } finally {
    await removeFixtureDirectory(directory);
  }
});
