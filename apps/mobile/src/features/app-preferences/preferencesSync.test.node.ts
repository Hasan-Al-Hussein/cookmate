import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAppPreferencesController,
  defaultAppPreferences,
  decodeAppPreferences,
} from './preferences';

test('sync display projection persists the complete preference set in one write', async () => {
  const writes: string[] = [];
  const controller = createAppPreferencesController({
    read: async () => null,
    write: async (value) => {
      writes.push(value);
    },
  });
  await controller.hydrate();
  const requested = { theme: 'dark', motion: 'reduced', locale: 'ar' } as const;
  assert.equal(await controller.replacePreferences(requested, defaultAppPreferences), true);
  assert.equal(writes.length, 1);
  assert.deepEqual(decodeAppPreferences(writes[0]!), { ok: true, preferences: requested });
  assert.deepEqual(controller.getSnapshot().preferences, requested);
});

test('late local display edits reject stale sync projection without overwriting them', async () => {
  const writes: string[] = [];
  const controller = createAppPreferencesController({
    read: async () => null,
    write: async (value) => {
      writes.push(value);
    },
  });
  await controller.hydrate();
  await controller.setPreference('theme', 'light');
  assert.equal(
    await controller.replacePreferences(
      { ...defaultAppPreferences, theme: 'dark' },
      defaultAppPreferences,
    ),
    false,
  );
  assert.equal(controller.getSnapshot().preferences.theme, 'light');
  assert.equal(writes.length, 1);
});

test('failed batch keeps current settings; exact recovered projection is idempotent', async () => {
  let fail = true,
    calls = 0;
  const controller = createAppPreferencesController({
    read: async () => null,
    write: async () => {
      calls++;
      if (fail) throw new Error('disk');
    },
  });
  const requested = { ...defaultAppPreferences, theme: 'dark' as const };
  assert.equal(await controller.replacePreferences(requested, defaultAppPreferences), false);
  assert.deepEqual(controller.getSnapshot().preferences, defaultAppPreferences);
  fail = false;
  assert.equal(await controller.replacePreferences(requested, defaultAppPreferences), true);
  assert.equal(await controller.replacePreferences(requested, defaultAppPreferences), true);
  assert.equal(calls, 2);
});

test('an account projection queued behind a local save cannot write after its owner changes', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: string[] = [];
  const controller = createAppPreferencesController({
    read: async () => null,
    write: async (value) => {
      writes.push(value);
      if (writes.length === 1) await wait;
    },
  });
  await controller.hydrate();
  let current = true;
  const save = controller.setPreference('theme', 'light');
  const projection = controller.replacePreferences(
    { ...defaultAppPreferences, theme: 'dark' },
    { ...defaultAppPreferences, theme: 'light' },
    () => current,
  );
  current = false;
  release();
  await save;
  assert.equal(await projection, false);
  assert.equal(writes.length, 1);
  assert.equal(controller.getSnapshot().preferences.theme, 'light');
});
