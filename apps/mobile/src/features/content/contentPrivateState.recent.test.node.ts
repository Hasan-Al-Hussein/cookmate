import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentPrivateState } from './contentPrivateState';

test('recent records stay in their exact owner/installation partition and outside other private stores', async () => {
  const installationId = '680a0000-0000-4000-8000-000000000001';
  const ownerId = '680b0000-0000-4000-8000-000000000001';
  const values = new Map<string, string>();
  const storage = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const scopes = [
    { installationId, ownerId },
    { installationId, ownerId: null },
    { installationId, ownerId: '680b0000-0000-4000-8000-000000000002' },
    { installationId: '680a0000-0000-4000-8000-000000000002', ownerId },
  ];
  const states = scopes.map((scope) => createContentPrivateState(scope, storage));
  for (const [index, state] of states.entries()) {
    await state.recentlyViewed.write(`recent-${index}`);
    await state.planningPreferences.write(`planning-${index}`);
  }
  for (const [index, state] of states.entries()) {
    assert.equal(await state.recentlyViewed.read(), `recent-${index}`);
    assert.equal(await state.planningPreferences.read(), `planning-${index}`);
    assert.equal(state.storageKeys.filter((key) => key.includes('recently-viewed')).length, 1);
  }
  assert.equal(values.size, 8);
  assert.equal(
    [...values.keys()].some((key) => /sync|auth|backup/.test(key)),
    false,
  );
});
