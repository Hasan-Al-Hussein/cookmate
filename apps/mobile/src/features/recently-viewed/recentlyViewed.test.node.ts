import assert from 'node:assert/strict';
import test from 'node:test';
import type { RecipeContentRef } from '@cookmate/contracts';
import {
  createRecentlyViewedController,
  decodeRecentlyViewed,
  encodeRecentlyViewed,
  RECENTLY_VIEWED_LIMIT,
  RECENTLY_VIEWED_MAXIMUM_LENGTH,
  RECENTLY_VIEWED_RETENTION_MS,
} from './recentlyViewed';

const instant = Date.UTC(2026, 9, 2);
const ref = (id = '1', revisionId = 'revision-1'): RecipeContentRef => ({
  recipeId: id,
  revisionId,
  contentFingerprint: 'a'.repeat(64),
});
const entry = (id = '1', openedAt = instant) => ({ ref: ref(id), openedAt });
const saved = (enabled = true, entries = [entry()]) => encodeRecentlyViewed({ enabled, entries });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(initial: string | null = null) {
  const state = {
    text: initial,
    time: instant,
    reads: 0,
    writes: [] as string[],
    failRead: false,
    failWrite: false,
    loseAck: false,
    beforeWrite: async (_text: string) => {},
  };
  const controller = createRecentlyViewedController(
    {
      async read() {
        state.reads++;
        if (state.failRead) throw new Error('private path');
        return state.text;
      },
      async write(text) {
        state.writes.push(text);
        await state.beforeWrite(text);
        if (state.failWrite) throw new Error('private path');
        state.text = text;
        if (state.loseAck) throw new Error('lost ACK');
      },
    },
    { now: () => state.time },
  );
  return { state, controller };
}

test('absent history is opt-in and neither hydration nor disabled opens create a record', async () => {
  const f = fixture();
  await Promise.all([f.controller.hydrate(), f.controller.hydrate()]);
  assert.deepEqual(f.controller.getSnapshot(), {
    enabled: false,
    entries: [],
    hydrated: true,
    saving: false,
    error: null,
  });
  assert.equal(await f.controller.recordOpen(ref()), false);
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.writes.length, 0);
});

test('exact versions deduplicate independently, move newest first and own mutable input', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  const original = ref();
  const recording = f.controller.recordOpen(original);
  original.revisionId = 'tampered-after-call';
  assert.equal(await recording, true);
  f.state.time++;
  await f.controller.recordOpen(ref('1', 'revision-2'));
  f.state.time++;
  await f.controller.recordOpen(ref());
  const snapshot = f.controller.getSnapshot();
  assert.deepEqual(
    snapshot.entries.map((value) => value.ref.revisionId),
    ['revision-1', 'revision-2'],
  );
  assert.equal(snapshot.entries[0]!.openedAt, instant + 2);
  assert.ok(
    Object.isFrozen(snapshot) &&
      Object.isFrozen(snapshot.entries) &&
      Object.isFrozen(snapshot.entries[0]!) &&
      Object.isFrozen(snapshot.entries[0]!.ref),
  );
  assert.deepEqual(Object.keys(JSON.parse(f.state.text!)), ['schemaVersion', 'enabled', 'entries']);
  assert.deepEqual(Object.keys(JSON.parse(f.state.text!).entries[0]), ['ref', 'openedAt']);
});

test('history retains only the newest twenty exact references', async () => {
  const f = fixture();
  await f.controller.setEnabled(true);
  for (let id = 1; id <= 23; id++) {
    f.state.time++;
    await f.controller.recordOpen(ref(String(id)));
  }
  assert.equal(f.controller.getSnapshot().entries.length, RECENTLY_VIEWED_LIMIT);
  assert.deepEqual(
    f.controller.getSnapshot().entries.map((item) => item.ref.recipeId),
    Array.from({ length: 20 }, (_, index) => String(23 - index)),
  );
});

test('hydrate and refresh expire entries at thirty days, including when collection is disabled', async () => {
  const f = fixture(
    saved(false, [entry('2', instant - 1), entry('1', instant - RECENTLY_VIEWED_RETENTION_MS)]),
  );
  await f.controller.hydrate();
  assert.equal(f.controller.getSnapshot().enabled, false);
  assert.deepEqual(
    f.controller.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['2'],
  );
  assert.equal(f.state.writes.length, 1);
  f.state.time += RECENTLY_VIEWED_RETENTION_MS;
  await f.controller.refresh();
  assert.deepEqual(f.controller.getSnapshot().entries, []);
  assert.equal(f.state.writes.length, 2);
  await f.controller.refresh();
  assert.equal(f.state.writes.length, 2);
});

test('a backward clock preserves confirmed entries and never rewrites them with a newer timestamp', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  const text = f.state.text;
  f.state.time--;
  assert.equal(await f.controller.recordOpen(ref('2')), false);
  assert.equal(await f.controller.clear(), false);
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().entries.length, 1);
  assert.match(f.controller.getSnapshot().error!, /clock/);
  assert.equal(f.state.text, text);
  assert.equal(f.state.writes.length, 0);
  f.state.time = instant + 1;
  await f.controller.refresh();
  assert.equal(await f.controller.clear(), true);
});

for (const [label, raw] of [
  ['malformed JSON', '{'],
  ['too large', ' '.repeat(RECENTLY_VIEWED_MAXIMUM_LENGTH + 1)],
  ['future version', JSON.stringify({ schemaVersion: 2, enabled: true, entries: [] })],
  [
    'unknown top-level field',
    JSON.stringify({ schemaVersion: 1, enabled: true, entries: [], notes: 'private' }),
  ],
  ['wrong enabled scalar', JSON.stringify({ schemaVersion: 1, enabled: 1, entries: [] })],
  [
    'future timestamp',
    JSON.stringify({ schemaVersion: 1, enabled: true, entries: [entry('1', instant + 1)] }),
  ],
  [
    'negative timestamp',
    JSON.stringify({ schemaVersion: 1, enabled: true, entries: [entry('1', -1)] }),
  ],
  [
    'fractional timestamp',
    JSON.stringify({ schemaVersion: 1, enabled: true, entries: [entry('1', 0.5)] }),
  ],
  [
    'unsafe timestamp',
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      entries: [entry('1', Number.MAX_SAFE_INTEGER + 1)],
    }),
  ],
  [
    'duplicate reference',
    JSON.stringify({ schemaVersion: 1, enabled: true, entries: [entry(), entry()] }),
  ],
  [
    'wrong order',
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      entries: [entry('1', instant - 1), entry('2')],
    }),
  ],
  [
    'too many entries',
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      entries: Array.from({ length: 21 }, (_, id) => entry(String(id))),
    }),
  ],
  [
    'unbound reference',
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      entries: [{ ...entry(), ref: { recipeId: '1' } }],
    }),
  ],
  [
    'private metadata',
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      entries: [{ ...entry(), title: 'Do not persist' }],
    }),
  ],
] as const)
  test(`${label} remains preserved and cannot be overwritten by enable, clear or recording`, async () => {
    const f = fixture(raw);
    await f.controller.hydrate();
    assert.ok(f.controller.getSnapshot().error);
    assert.equal(await f.controller.setEnabled(true), false);
    assert.equal(await f.controller.clear(), false);
    assert.equal(await f.controller.recordOpen(ref()), false);
    assert.equal(f.state.text, raw);
    assert.equal(f.state.writes.length, 0);
  });

test('read failure is retryable and never replaces unknown history', async () => {
  const f = fixture(saved());
  f.state.failRead = true;
  assert.equal(await f.controller.setEnabled(false), false);
  assert.match(f.controller.getSnapshot().error!, /storage is unavailable/);
  assert.doesNotMatch(f.controller.getSnapshot().error!, /private path/);
  assert.equal(f.state.writes.length, 0);
  f.state.failRead = false;
  await f.controller.refresh();
  assert.equal(await f.controller.recordOpen(ref('2')), false);
  assert.equal(await f.controller.setEnabled(false), true);
  assert.equal(f.controller.getSnapshot().enabled, false);
  assert.equal(f.controller.getSnapshot().entries.length, 1);
});

test('an unconfirmed disable blocks further recording until explicitly enabled, including after refresh', async () => {
  const f = fixture(saved());
  f.state.failWrite = true;
  assert.equal(await f.controller.setEnabled(false), false);
  assert.equal(f.controller.getSnapshot().enabled, true);
  assert.match(f.controller.getSnapshot().error!, /could not be confirmed/);
  f.state.failWrite = false;
  await f.controller.refresh();
  assert.equal(await f.controller.recordOpen(ref('2')), false);
  assert.equal(await f.controller.setEnabled(true), true);
  assert.equal(await f.controller.recordOpen(ref('2')), true);
});

test('refresh cannot hide an unconfirmed privacy pause; an explicit successful retry clears it', async () => {
  for (const action of ['disable', 'clear'] as const) {
    const f = fixture(saved());
    await f.controller.hydrate();
    f.state.failWrite = true;
    const change = () => action === 'disable' ? f.controller.setEnabled(false) : f.controller.clear();
    assert.equal(await change(), false);
    f.state.failWrite = false;
    await f.controller.refresh();
    assert.equal(f.controller.getSnapshot().enabled, true);
    assert.match(f.controller.getSnapshot().error!, /Recording is paused/);
    assert.equal(await f.controller.recordOpen(ref('2')), false);
    assert.equal(await change(), true);
    assert.equal(f.controller.getSnapshot().error, null);
  }
});

test('a lost recording acknowledgement is read back before another mutation, preserving the committed entry', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  f.state.loseAck = true;
  f.state.time++;
  assert.equal(await f.controller.recordOpen(ref('2')), false);
  assert.deepEqual(
    f.controller.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['1'],
  );
  f.state.loseAck = false;
  f.state.time++;
  assert.equal(await f.controller.recordOpen(ref('3')), true);
  assert.deepEqual(
    f.controller.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['3', '2', '1'],
  );
  assert.equal(f.state.reads, 2);
});

test('clear fences queued and in-flight opens, then preserves enabled choice for a genuinely later open', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  const entered = gate(),
    release = gate();
  f.state.beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  const running = f.controller.recordOpen(ref('2'));
  await entered.promise;
  const queued = f.controller.recordOpen(ref('3'));
  const clearing = f.controller.clear();
  assert.equal(await f.controller.recordOpen(ref('4')), false);
  release.resolve();
  assert.equal(await running, false);
  assert.equal(await queued, false);
  assert.equal(await clearing, true);
  assert.equal(f.state.writes.length, 2);
  assert.deepEqual(f.controller.getSnapshot().entries, []);
  assert.equal(f.controller.getSnapshot().enabled, true);
  assert.equal(await f.controller.recordOpen(ref('5')), true);
  assert.deepEqual(
    f.controller.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['5'],
  );
});

test('disable fences an in-flight open, retains confirmed history and does not resume collection', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  const entered = gate(),
    release = gate();
  f.state.beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  const running = f.controller.recordOpen(ref('2'));
  await entered.promise;
  const disabling = f.controller.setEnabled(false);
  release.resolve();
  assert.equal(await running, false);
  assert.equal(await disabling, true);
  assert.equal(f.controller.getSnapshot().enabled, false);
  assert.deepEqual(
    f.controller.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['2', '1'],
  );
  assert.equal(await f.controller.recordOpen(ref('3')), false);
});

test('clear followed immediately by enable still durably removes the old entries', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  const clearing = f.controller.clear();
  const enabling = f.controller.setEnabled(true);
  await Promise.all([clearing, enabling]);
  assert.deepEqual(decodeRecentlyViewed(f.state.text, instant), {
    ok: true,
    value: { enabled: true, entries: [] },
  });
});

test('route guard prevents delayed work before write, including throwing predicates', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  let active = true;
  const recording = f.controller.recordOpen(ref('2'), () => active);
  active = false;
  assert.equal(await recording, false);
  assert.equal(
    await f.controller.recordOpen(ref('2'), () => {
      throw new Error('departed');
    }),
    false,
  );
  assert.equal(f.state.writes.length, 0);
});

test('route departure during a physical write returns false without erasing history; refresh reconciles it', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  const entered = gate(),
    release = gate();
  f.state.beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  let active = true;
  const recording = f.controller.recordOpen(ref('2'), () => active);
  await entered.promise;
  active = false;
  release.resolve();
  assert.equal(await recording, false);
  assert.deepEqual(
    f.controller.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['1'],
  );
  await f.controller.refresh();
  assert.deepEqual(
    f.controller.getSnapshot().entries.map((item) => item.ref.recipeId),
    ['2', '1'],
  );
});

test('disposal drains a started write, rejects queued callbacks and suppresses late snapshots', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  const entered = gate(),
    release = gate();
  f.state.beforeWrite = async () => {
    entered.resolve();
    await release.promise;
  };
  const running = f.controller.recordOpen(ref('2'));
  await entered.promise;
  const queued = f.controller.recordOpen(ref('3'));
  const snapshot = f.controller.getSnapshot();
  f.controller.dispose();
  let finished = false;
  const draining = f.controller.drain().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  release.resolve();
  assert.equal(await running, false);
  assert.equal(await queued, false);
  await draining;
  assert.equal(f.controller.getSnapshot(), snapshot);
  assert.equal(f.state.writes.length, 1);
  assert.equal(await f.controller.clear(), false);
});

test('runtime-invalid inputs do not reach storage and observer errors do not poison the writer', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  assert.equal(await f.controller.recordOpen({ ...ref(), revisionId: '' }), false);
  assert.equal(await f.controller.setEnabled(1 as unknown as boolean), false);
  assert.equal(f.state.writes.length, 0);
  f.controller.subscribe(() => {
    throw new Error('observer');
  });
  assert.equal(await f.controller.recordOpen(ref('2')), true);
  assert.equal(await f.controller.clear(), true);
});

test('accessor recipe references are rejected without invoking code', async () => {
  const f = fixture(saved());
  await f.controller.hydrate();
  let called = 0;
  const input = ref();
  Object.defineProperty(input, 'recipeId', {
    enumerable: true,
    get() {
      called++;
      return '1';
    },
  });
  assert.equal(await f.controller.recordOpen(input), false);
  assert.equal(called, 0);
  assert.equal(f.state.writes.length, 0);
});

test('an invalid injected clock cannot mutate or erase the saved history', async () => {
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    const f = fixture(saved());
    f.state.time = value;
    assert.equal(await f.controller.setEnabled(false), false);
    assert.match(f.controller.getSnapshot().error!, /clock/);
    assert.equal(f.state.text, saved());
    assert.equal(f.state.writes.length, 0);
  }
});
