import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalStore } from './localStore';

for (const [message, reload] of [
  ["Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle'", true],
  ['Invalid VFS state', true],
  ['Access Handles cannot be created if there is another open Access Handle', true],
  ['Unrelated transient file error', false],
] as const) {
  test(`storage startup classifies ${message}`, async () => {
    let opens = 0;
    const result = await createLocalStore({
      openConnection: async () => {
        opens++;
        throw new Error(message);
      },
      platform: {
        newId: () => {
          throw new Error('No schema initialization allowed');
        },
        sha256: async () => '',
      },
      now: () => '2026-10-01T00:00:00.000Z',
      dateContext: () => ({
        localDate: '2026-10-01',
        timeZone: 'Asia/Dubai',
        utcOffsetMinutes: 240,
      }),
    });
    assert.equal(opens, 1);
    assert.deepEqual(result, {
      kind: 'failed',
      error: {
        code: 'storage_failure',
        messageKey: reload ? 'storage.web_restart_required' : 'storage.open_failed',
        retry: reload ? 'never' : 'after_correction',
      },
    });
  });
}
