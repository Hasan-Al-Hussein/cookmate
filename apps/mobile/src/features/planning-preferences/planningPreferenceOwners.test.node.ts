import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bundledPlanningPreferenceKey,
  createPlanningPreferenceOwners,
} from './planningPreferenceOwners';
import { decodePlanningPreferences } from './planningPreferences';
import { createContentPrivateState } from '../content/contentPrivateState';

const ownerA = '710a0000-0000-4000-8000-000000000001';
const ownerB = '710a0000-0000-4000-8000-000000000002';
const installationA = '710b0000-0000-4000-8000-000000000001';
const installationB = '710b0000-0000-4000-8000-000000000002';
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const values = new Map<string, string>();
  let selected: string | null = null;
  let delay: ReturnType<typeof gate> | null = null;
  let entered = gate();
  const storage = {
    read: async (key: string) => values.get(key) ?? null,
    async write(key: string, text: string) {
      entered.resolve();
      if (delay) await delay.promise;
      values.set(key, text);
    },
  };
  const owners = createPlanningPreferenceOwners(
    (ownerId) => {
      const key = bundledPlanningPreferenceKey(ownerId);
      return { read: () => storage.read(key), write: (text) => storage.write(key, text) };
    },
    (ownerId) => selected === ownerId,
  );
  return {
    values,
    storage,
    owners,
    select(ownerId: string | null) {
      owners.retire();
      selected = ownerId;
    },
    delayWrite() {
      delay = gate();
      entered = gate();
      return { entered: entered.promise, release: delay.resolve };
    },
  };
}

test('local guest and selected account preferences reopen independently; identity loss does not imply guest', async () => {
  const f = fixture();
  const guest = f.owners.current(null);
  await guest.hydrate();
  assert.equal(await guest.setPreference('weekStart', 'sunday'), true);
  f.select(ownerA);
  const a = f.owners.current(ownerA);
  await a.hydrate();
  assert.equal(a.getSnapshot().preferences.weekStart, 'monday');
  await a.setPreference('defaultMealSlot', 'lunch');
  // Auth can disappear while the explicitly retained local account remains selected.
  assert.equal(f.owners.current(ownerA), a);
  assert.throws(() => f.owners.current(null), /workspace changed/);
  f.select(ownerB);
  const b = f.owners.current(ownerB);
  await b.hydrate();
  assert.equal(b.getSnapshot().preferences.defaultMealSlot, 'dinner');
  f.select(ownerA);
  const reopened = f.owners.current(ownerA);
  await reopened.hydrate();
  assert.equal(reopened.getSnapshot().preferences.defaultMealSlot, 'lunch');
  assert.equal(await a.setPreference('weekStart', 'sunday'), false);
  f.select(null);
  const reopenedGuest = f.owners.current(null);
  await reopenedGuest.hydrate();
  assert.equal(reopenedGuest.getSnapshot().preferences.weekStart, 'sunday');
  f.owners.retire();
  await f.owners.drain();
});

test('A to B to A waits for an already-started physical write before hydrating A', async () => {
  const f = fixture();
  f.select(ownerA);
  const a = f.owners.current(ownerA);
  await a.hydrate();
  const write = f.delayWrite();
  const saved = a.setPreference('weekStart', 'sunday');
  await write.entered;
  f.select(ownerB);
  const b = f.owners.current(ownerB);
  const bHydration = b.hydrate();
  f.select(ownerA);
  const nextA = f.owners.current(ownerA);
  const hydration = nextA.hydrate();
  await Promise.resolve();
  assert.equal(nextA.getSnapshot().hydrated, false);
  write.release();
  await Promise.all([saved, bHydration, hydration]);
  assert.equal(nextA.getSnapshot().preferences.weekStart, 'sunday');
  assert.equal(b.getSnapshot().hydrated, false);
  f.owners.retire();
  await f.owners.drain();
});

test('removal fences retained callbacks and controller recreation, then drains before exact-key deletion', async () => {
  const f = fixture();
  f.select(ownerA);
  const a = f.owners.current(ownerA);
  await a.hydrate();
  const write = f.delayWrite();
  const save = a.setPreference('defaultMealSlot', 'breakfast');
  await write.entered;
  let erased = false;
  const removal = f.owners.remove(ownerA, async () => {
    erased = true;
    f.values.delete(bundledPlanningPreferenceKey(ownerA));
  });
  assert.throws(() => f.owners.current(ownerA), /workspace changed/);
  assert.equal(await a.setPreference('weekStart', 'sunday'), false);
  assert.equal(erased, false);
  write.release();
  await Promise.all([save, removal]);
  assert.equal(f.values.has(bundledPlanningPreferenceKey(ownerA)), false);
  assert.equal(erased, true);
  const fresh = f.owners.current(ownerA);
  await fresh.hydrate();
  assert.equal(fresh.getSnapshot().preferences.defaultMealSlot, 'dinner');
  f.owners.retire();
  await f.owners.drain();
});

test('configured planning bytes are isolated by owner and installation and registered for exact cleanup', async () => {
  const f = fixture();
  const a = createContentPrivateState(
    { installationId: installationA, ownerId: ownerA },
    f.storage,
  );
  const peers = [
    createContentPrivateState({ installationId: installationA, ownerId: null }, f.storage),
    createContentPrivateState({ installationId: installationA, ownerId: ownerB }, f.storage),
    createContentPrivateState({ installationId: installationB, ownerId: ownerA }, f.storage),
  ];
  const text = JSON.stringify({
    schemaVersion: 1,
    preferences: { weekStart: 'sunday', defaultMealSlot: 'lunch' },
  });
  // The storage partition preserves bytes; admission belongs to the shared controller codec.
  await a.planningPreferences.write(text);
  const reopened = createContentPrivateState(
    { installationId: installationA, ownerId: ownerA },
    f.storage,
  );
  assert.equal(await reopened.planningPreferences.read(), text);
  for (const peer of peers) assert.equal(await peer.planningPreferences.read(), null);
  assert.ok([...f.values.keys()].every((key) => a.storageKeys.includes(key)));
  assert.equal(f.values.has(bundledPlanningPreferenceKey(ownerA)), false);
});

test('malformed bundled owner IDs cannot alias another owner or the guest key', () => {
  for (const owner of ['', 'guest', '../guest', 'account:guest'])
    assert.throws(() => bundledPlanningPreferenceKey(owner), /Invalid/);
  assert.equal(decodePlanningPreferences(null).ok, true);
});
