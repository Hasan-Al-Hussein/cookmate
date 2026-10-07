import assert from 'node:assert/strict';
import test from 'node:test';
import { bundledRecentlyViewedKey, createRecentlyViewedOwners } from './recentlyViewedOwners';
import { decodeRecentlyViewed } from './recentlyViewed';

const ownerA = '720a0000-0000-4000-8000-000000000001';
const ownerB = '720a0000-0000-4000-8000-000000000002';
const instant = Date.UTC(2026, 9, 2);
const ref = (id: string) => ({
  recipeId: id,
  revisionId: 'revision-1',
  contentFingerprint: 'a'.repeat(64),
});
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
  const owners = createRecentlyViewedOwners(
    (ownerId) => {
      const key = bundledRecentlyViewedKey(ownerId);
      return {
        read: async () => values.get(key) ?? null,
        async write(text) {
          entered.resolve();
          if (delay) await delay.promise;
          values.set(key, text);
        },
      };
    },
    (ownerId) => ownerId === selected,
    { now: () => instant },
  );
  return {
    owners,
    values,
    select(ownerId: string | null) {
      owners.retire();
      selected = ownerId;
    },
    delay() {
      delay = gate();
      entered = gate();
      return { entered: entered.promise, release: delay.resolve };
    },
  };
}

test('guest and selected local accounts retain independent opt-ins/history across sign-out and reopen', async () => {
  const f = fixture();
  const guest = f.owners.current(null);
  await guest.setEnabled(true);
  await guest.recordOpen(ref('1'));
  f.select(ownerA);
  const a = f.owners.current(ownerA);
  await a.hydrate();
  assert.equal(a.getSnapshot().enabled, false);
  await a.setEnabled(true);
  await a.recordOpen(ref('2'));
  // Losing authentication does not change the still-selected local workspace.
  assert.equal(f.owners.current(ownerA), a);
  assert.throws(() => f.owners.current(null), /workspace changed/);
  f.select(ownerB);
  const b = f.owners.current(ownerB);
  await b.hydrate();
  assert.equal(b.getSnapshot().enabled, false);
  assert.deepEqual(b.getSnapshot().entries, []);
  f.select(ownerA);
  const reopenedA = f.owners.current(ownerA);
  await reopenedA.hydrate();
  assert.deepEqual(
    reopenedA.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['2'],
  );
  assert.equal(await a.recordOpen(ref('3')), false);
  f.select(null);
  const reopenedGuest = f.owners.current(null);
  await reopenedGuest.hydrate();
  assert.deepEqual(
    reopenedGuest.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['1'],
  );
  f.owners.retire();
  await f.owners.drain();
});

test("A to B to A drains a started physical write before reopening A and suppresses B's late read", async () => {
  const f = fixture();
  f.select(ownerA);
  const a = f.owners.current(ownerA);
  await a.setEnabled(true);
  const paused = f.delay();
  const opening = a.recordOpen(ref('1'));
  await paused.entered;
  f.select(ownerB);
  const b = f.owners.current(ownerB);
  const bRead = b.hydrate();
  f.select(ownerA);
  const nextA = f.owners.current(ownerA);
  const nextRead = nextA.hydrate();
  await Promise.resolve();
  assert.equal(nextA.getSnapshot().hydrated, false);
  paused.release();
  assert.equal(await opening, false);
  await Promise.all([bRead, nextRead]);
  assert.deepEqual(
    nextA.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['1'],
  );
  assert.equal(b.getSnapshot().hydrated, false);
  f.owners.retire();
  await f.owners.drain();
});

test('removal drains recording and blocks retained callbacks and same-owner recreation until erased', async () => {
  const f = fixture();
  f.select(ownerA);
  const a = f.owners.current(ownerA);
  await a.setEnabled(true);
  f.values.set(bundledRecentlyViewedKey(null), 'guest remains');
  f.values.set(bundledRecentlyViewedKey(ownerB), 'other owner remains');
  const paused = f.delay();
  const opening = a.recordOpen(ref('1'));
  await paused.entered;
  let erased = false;
  const removing = f.owners.remove(ownerA, async () => {
    erased = true;
    f.values.delete(bundledRecentlyViewedKey(ownerA));
  });
  assert.throws(() => f.owners.current(ownerA), /workspace changed/);
  assert.equal(await a.setEnabled(true), false);
  assert.equal(await a.recordOpen(ref('2')), false);
  assert.equal(erased, false);
  paused.release();
  await Promise.all([opening, removing]);
  assert.equal(f.values.has(bundledRecentlyViewedKey(ownerA)), false);
  assert.equal(f.values.get(bundledRecentlyViewedKey(null)), 'guest remains');
  assert.equal(f.values.get(bundledRecentlyViewedKey(ownerB)), 'other owner remains');
  const reopened = f.owners.current(ownerA);
  await reopened.hydrate();
  assert.equal(reopened.getSnapshot().enabled, false);
  assert.deepEqual(reopened.getSnapshot().entries, []);
  f.owners.retire();
  await f.owners.drain();
});

test('failed deletion remains retryable without enabling retired callbacks', async () => {
  const f = fixture();
  f.select(ownerA);
  const a = f.owners.current(ownerA);
  await a.setEnabled(true);
  await a.recordOpen(ref('1'));
  await assert.rejects(
    f.owners.remove(ownerA, async () => {
      throw new Error('disk');
    }),
    /disk/,
  );
  assert.equal(await a.recordOpen(ref('2')), false);
  assert.ok(decodeRecentlyViewed(f.values.get(bundledRecentlyViewedKey(ownerA))!, instant).ok);
  await f.owners.remove(ownerA, async () => {
    f.values.delete(bundledRecentlyViewedKey(ownerA));
  });
  assert.equal(f.values.has(bundledRecentlyViewedKey(ownerA)), false);
});

test('malformed owner IDs cannot alias the guest or another storage partition', () => {
  for (const value of ['', 'guest', '../guest', 'account:guest'])
    assert.throws(() => bundledRecentlyViewedKey(value), /Invalid/);
  assert.notEqual(bundledRecentlyViewedKey(ownerA), bundledRecentlyViewedKey(ownerB));
  assert.notEqual(bundledRecentlyViewedKey(ownerA), bundledRecentlyViewedKey(null));
});
