import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountSnapshotOptions } from '@cookmate/account-sync';
import {
  createAppPreferencesController,
  decodeAppPreferences,
  defaultAppPreferences,
  encodeAppPreferences,
} from '../app-preferences/preferences';
import {
  createLocalAccountSettings,
  localAccountSettingsKey,
  LocalAccountSettingsError,
} from './localAccountSettings';
import type { LocalAccountSettingsStore } from './localAccountSettings';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const live = () => true;
const options = (
  theme: 'system' | 'light' | 'dark' = 'system',
  displayName: string | null = null,
): AccountSnapshotOptions => ({
  appPreferences: { ...defaultAppPreferences, theme },
  profile: { displayName },
});
const record = (value: AccountSnapshotOptions, ownerId = ownerA) =>
  JSON.stringify({ schemaVersion: 1, ownerId, options: value });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(localAccountSettingsKey(ownerA), initial);
  const reads: string[] = [];
  const writes: { key: string; value: string }[] = [];
  let current = true;
  let onRead: (() => Promise<void>) | null = null;
  let onWrite: ((key: string, value: string) => Promise<void>) | null = null;
  const port: LocalAccountSettingsStore = {
    read: async (key) => {
      reads.push(key);
      await onRead?.();
      return values.get(key) ?? null;
    },
    write: async (key, value) => {
      writes.push({ key, value });
      if (onWrite) await onWrite(key, value);
      else values.set(key, value);
    },
  };
  const controller = createLocalAccountSettings({
    ownerId: ownerA,
    store: port,
    isCurrent: () => current,
  });
  return {
    controller,
    port,
    values,
    reads,
    writes,
    setCurrent: (value: boolean) => {
      current = value;
    },
    onRead: (callback: typeof onRead) => {
      onRead = callback;
    },
    onWrite: (callback: typeof onWrite) => {
      onWrite = callback;
    },
  };
}

test('missing settings hydrate to frozen defaults without writing or touching another namespace', async () => {
  const f = fixture();
  assert.equal(f.controller.getSnapshot().kind, 'loading');
  const store = f.controller.preferenceStore;
  await f.controller.hydrate();
  assert.equal(f.controller.getSnapshot().kind, 'ready');
  assert.deepEqual(f.controller.getSnapshot().options, options());
  assert.ok(Object.isFrozen(f.controller.getSnapshot()));
  assert.ok(Object.isFrozen(f.controller.getSnapshot().options.appPreferences));
  assert.ok(Object.isFrozen(f.controller.getSnapshot().options.profile));
  assert.equal(f.controller.preferenceStore, store);
  assert.deepEqual(decodeAppPreferences(await store.read()), {
    ok: true,
    preferences: defaultAppPreferences,
  });
  assert.equal(f.writes.length, 0);
  assert.deepEqual([...new Set(f.reads)], [localAccountSettingsKey(ownerA)]);
});

test('whole settings and exact Unicode display name round-trip in one bounded owner record', async () => {
  const f = fixture();
  const next = options('dark', '  أمينة 🥘  ');
  next.appPreferences.motion = 'reduced';
  next.appPreferences.locale = 'ar';
  await f.controller.hydrate();
  assert.equal(await f.controller.replaceOptions(next, options(), live), true);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(JSON.parse(f.writes[0]!.value), {
    schemaVersion: 1,
    ownerId: ownerA,
    options: next,
  });
  const reopened = createLocalAccountSettings({ ownerId: ownerA, store: f.port, isCurrent: live });
  await reopened.hydrate();
  assert.deepEqual(reopened.getSnapshot().options, next);
});

test('schema1 preference writes preserve the latest profile in the same atomic record', async () => {
  const f = fixture(record(options('light', 'Original name')));
  await f.controller.preferenceStore.read();
  const named = options('light', 'Updated name');
  assert.equal(
    await f.controller.replaceOptions(named, options('light', 'Original name'), live),
    true,
  );
  const preferences = { theme: 'dark', motion: 'reduced', locale: 'en' } as const;
  await f.controller.preferenceStore.write(encodeAppPreferences(preferences));
  assert.deepEqual(f.controller.getSnapshot().options, {
    appPreferences: preferences,
    profile: named.profile,
  });
  assert.deepEqual(
    JSON.parse(f.values.get(localAccountSettingsKey(ownerA))!).options,
    f.controller.getSnapshot().options,
  );
});

test('whole-options CAS rejects stale profile, stale preferences and already-next stale expected values', async () => {
  const current = options('light', 'New name');
  const f = fixture(record(current));
  await f.controller.hydrate();
  for (const expected of [options('light', 'Old name'), options('dark', 'New name'), options()]) {
    assert.equal(await f.controller.replaceOptions(current, expected, live), false);
    assert.equal(f.controller.getSnapshot().error, 'stale_options');
    assert.deepEqual(f.controller.getSnapshot().options, current);
  }
  assert.equal(f.writes.length, 0);
  assert.equal(await f.controller.replaceOptions(current, current, live), true);
  assert.equal(f.controller.getSnapshot().kind, 'ready');
  assert.equal(f.writes.length, 0);
});

test('sync preference replacement fences a stale preferences-controller edit until refresh', async () => {
  const f = fixture();
  const preferences = createAppPreferencesController(f.controller.preferenceStore);
  await preferences.hydrate();
  const synced = options('dark', 'Synced name');
  synced.appPreferences.motion = 'reduced';
  synced.appPreferences.locale = 'ar';
  assert.equal(await f.controller.replaceOptions(synced, options(), live), true);
  assert.equal(await preferences.setPreference('theme', 'light'), false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.controller.getSnapshot().error, 'stale_options');
  await preferences.refresh();
  assert.equal(await preferences.setPreference('theme', 'light'), true);
  assert.deepEqual(f.controller.getSnapshot().options, {
    ...synced,
    appPreferences: { ...synced.appPreferences, theme: 'light' },
  });
});

test('hydrate, reads and queued saves serialize; queued options are copied before caller mutation', async () => {
  const f = fixture();
  const started = deferred(),
    release = deferred();
  let first = true;
  f.onRead(async () => {
    if (first) {
      first = false;
      started.resolve();
      await release.promise;
    }
  });
  const hydration = f.controller.hydrate();
  await started.promise;
  const expected = options();
  const requested = options('light', 'Requested');
  const saved = f.controller.replaceOptions(requested, expected, live);
  requested.appPreferences.theme = 'dark';
  requested.profile.displayName = 'Mutated';
  expected.profile.displayName = 'Mutated baseline';
  assert.equal(f.writes.length, 0);
  release.resolve();
  await hydration;
  assert.equal(await saved, true);
  assert.deepEqual(f.controller.getSnapshot().options, options('light', 'Requested'));
});

test('concurrent guarded saves run in order against the preceding confirmed whole options', async () => {
  const f = fixture();
  const started = deferred(),
    release = deferred();
  let active = 0,
    peak = 0;
  f.onWrite(async (key, value) => {
    active++;
    peak = Math.max(peak, active);
    if (f.writes.length === 1) {
      started.resolve();
      await release.promise;
    }
    f.values.set(key, value);
    active--;
  });
  const first = f.controller.replaceOptions(options('light', 'First'), options(), live);
  await started.promise;
  const second = f.controller.replaceOptions(
    options('dark', 'Second'),
    options('light', 'First'),
    live,
  );
  assert.equal(f.writes.length, 1);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(peak, 1);
  assert.deepEqual(f.controller.getSnapshot().options, options('dark', 'Second'));
});

test('failed physical save retains prior options and the queue permits a deliberate retry', async () => {
  const f = fixture(record(options('light', 'Kept')));
  await f.controller.preferenceStore.read();
  f.onWrite(async () => {
    throw new Error('private disk diagnostic');
  });
  assert.equal(
    await f.controller.replaceOptions(options('dark', 'Not saved'), options('light', 'Kept'), live),
    false,
  );
  assert.deepEqual(f.controller.getSnapshot().options, options('light', 'Kept'));
  assert.equal(f.controller.getSnapshot().error, 'storage_unavailable');
  f.onWrite(null);
  await f.controller.preferenceStore.write(
    encodeAppPreferences({ ...defaultAppPreferences, motion: 'reduced' }),
  );
  assert.equal(f.controller.getSnapshot().options.profile.displayName, 'Kept');
  assert.equal(f.controller.getSnapshot().kind, 'ready');
});

test('lost acknowledgement confirms only an exact whole candidate readback', async () => {
  const f = fixture();
  await f.controller.hydrate();
  f.onWrite(async (key, value) => {
    f.values.set(key, value);
    throw new Error('lost acknowledgement');
  });
  const next = options('dark', 'Confirmed by readback');
  assert.equal(await f.controller.replaceOptions(next, options(), live), true);
  assert.equal(f.controller.getSnapshot().kind, 'ready');
  assert.deepEqual(f.controller.getSnapshot().options, next);
  assert.equal(f.writes.length, 1);
});

test('unknown acknowledgement fences writes until explicit reconciliation and a fresh preference read', async () => {
  const f = fixture();
  await f.controller.preferenceStore.read();
  f.onWrite(async (key, value) => {
    f.values.set(key, value);
    f.onRead(async () => {
      throw new Error('unavailable readback');
    });
    throw new Error('lost acknowledgement');
  });
  const next = options('dark', 'Durable but unconfirmed');
  assert.equal(await f.controller.replaceOptions(next, options(), live), false);
  assert.equal(f.controller.getSnapshot().error, 'save_unconfirmed');
  assert.deepEqual(f.controller.getSnapshot().options, options());
  f.onRead(null);
  f.onWrite(null);
  assert.equal(await f.controller.replaceOptions(options('light'), next, live), false);
  await assert.rejects(
    f.controller.preferenceStore.write(encodeAppPreferences(defaultAppPreferences)),
    (error: unknown) =>
      error instanceof LocalAccountSettingsError && error.reason === 'save_unconfirmed',
  );
  assert.equal(f.writes.length, 1);
  await f.controller.hydrate();
  assert.deepEqual(f.controller.getSnapshot().options, next);
  await assert.rejects(
    f.controller.preferenceStore.write(encodeAppPreferences(defaultAppPreferences)),
    (error: unknown) =>
      error instanceof LocalAccountSettingsError && error.reason === 'stale_options',
  );
  await f.controller.preferenceStore.read();
  await f.controller.preferenceStore.write(
    encodeAppPreferences({ ...next.appPreferences, motion: 'reduced' }),
  );
  assert.equal(f.controller.getSnapshot().options.profile.displayName, next.profile.displayName);
});

test('mismatched or malformed readback never publishes success or overwrites uncertainty', async () => {
  for (const raw of [record(options('dark', 'Different profile')), '{broken']) {
    const f = fixture();
    await f.controller.preferenceStore.read();
    f.onWrite(async (key) => {
      f.values.set(key, raw);
      throw new Error('uncertain write');
    });
    assert.equal(
      await f.controller.replaceOptions(options('dark', 'Requested profile'), options(), live),
      false,
    );
    assert.equal(f.controller.getSnapshot().error, 'save_unconfirmed');
    assert.deepEqual(f.controller.getSnapshot().options, options());
    await assert.rejects(
      f.controller.preferenceStore.write(encodeAppPreferences(defaultAppPreferences)),
      LocalAccountSettingsError,
    );
    assert.equal(f.writes.length, 1);
    assert.equal(f.values.get(localAccountSettingsKey(ownerA)), raw);
  }
});

test('corrupt, extra-field, wrong-owner, oversized and newer records remain byte-for-byte untouched', async () => {
  const invalid = [
    '{',
    JSON.stringify({ schemaVersion: 2, ownerId: ownerA, options: options() }),
    record(options(), ownerB),
    JSON.stringify({
      schemaVersion: 1,
      ownerId: ownerA,
      options: { ...options(), token: 'not allowed' },
    }),
    `${' '.repeat(2049)}${record(options())}`,
    JSON.stringify({
      schemaVersion: 1,
      ownerId: ownerA,
      options: { ...options(), profile: { displayName: '' } },
    }),
  ];
  for (const raw of invalid) {
    const f = fixture(raw);
    await f.controller.hydrate();
    assert.equal(f.controller.getSnapshot().kind, 'failed');
    await assert.rejects(f.controller.preferenceStore.read(), LocalAccountSettingsError);
    assert.equal(await f.controller.replaceOptions(options('dark'), options(), live), false);
    assert.equal(f.writes.length, 0);
    assert.equal(f.values.get(localAccountSettingsKey(ownerA)), raw);
  }
});

test('input validation rejects extra/accessor/non-string fields and aligns displayName with 120 UTF-16 units', async () => {
  const f = fixture();
  await f.controller.hydrate();
  const bad: unknown[] = [
    { ...options(), extra: true },
    { ...options(), profile: { displayName: '🥘'.repeat(61) } },
    { ...options(), profile: { displayName: '' } },
    { ...options(), appPreferences: { ...defaultAppPreferences, theme: { toJSON: () => 'dark' } } },
  ];
  let getterCalls = 0;
  bad.push({
    ...options(),
    profile: Object.defineProperty({}, 'displayName', {
      enumerable: true,
      get() {
        getterCalls++;
        return 'Getter';
      },
    }),
  });
  for (const value of bad)
    assert.equal(
      await f.controller.replaceOptions(value as AccountSnapshotOptions, options(), live),
      false,
    );
  assert.equal(getterCalls, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(
    await f.controller.replaceOptions(options('dark', '🥘'.repeat(60)), options(), live),
    true,
  );
  assert.equal(f.controller.getSnapshot().options.profile.displayName?.length, 120);
});

test('preference adapter rejects invalid schemas and cannot write without a read baseline', async () => {
  const f = fixture();
  await f.controller.hydrate();
  await assert.rejects(
    f.controller.preferenceStore.write(encodeAppPreferences(defaultAppPreferences)),
    LocalAccountSettingsError,
  );
  await f.controller.preferenceStore.read();
  for (const raw of [
    '{}',
    JSON.stringify({ schemaVersion: 2, preferences: defaultAppPreferences }),
    JSON.stringify({ schemaVersion: 1, preferences: { ...defaultAppPreferences, extra: true } }),
  ])
    await assert.rejects(f.controller.preferenceStore.write(raw), LocalAccountSettingsError);
  assert.equal(f.writes.length, 0);
});

test('owner guard rejects before enqueue and again after a blocked read without dispatching writes', async () => {
  const f = fixture();
  f.setCurrent(false);
  assert.equal(await f.controller.replaceOptions(options('dark'), options(), live), false);
  await assert.rejects(f.controller.preferenceStore.read(), LocalAccountSettingsError);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  f.setCurrent(true);
  const started = deferred(),
    release = deferred();
  f.onRead(async () => {
    started.resolve();
    await release.promise;
  });
  const saving = f.controller.replaceOptions(options('dark'), options(), live);
  await started.promise;
  f.setCurrent(false);
  release.resolve();
  assert.equal(await saving, false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.controller.getSnapshot().kind, 'loading');
});

test('operation guard invalidation while queued cannot dispatch a later write', async () => {
  const f = fixture();
  const started = deferred(),
    release = deferred();
  f.onWrite(async (key, raw) => {
    started.resolve();
    await release.promise;
    f.values.set(key, raw);
  });
  const first = f.controller.replaceOptions(options('light'), options(), live);
  await started.promise;
  let valid = true;
  const second = f.controller.replaceOptions(options('dark'), options('light'), () => valid);
  valid = false;
  release.resolve();
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.controller.getSnapshot().options.appPreferences.theme, 'light');
});

test('already-dispatched write stays in its original owner key across A→B→A workspace generations', async () => {
  const values = new Map<string, string>();
  const started = deferred(),
    release = deferred();
  let generation = 1;
  const port = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, raw: string) => {
      started.resolve();
      await release.promise;
      values.set(key, raw);
    },
  };
  const a = createLocalAccountSettings({
    ownerId: ownerA,
    store: port,
    isCurrent: () => generation === 1,
  });
  await a.hydrate();
  let publications = 0;
  a.subscribe(() => {
    publications++;
  });
  const saving = a.replaceOptions(options('dark', 'Owner A'), options(), live);
  await started.promise;
  generation = 2;
  const b = createLocalAccountSettings({
    ownerId: ownerB,
    store: port,
    isCurrent: () => generation === 2,
  });
  await b.hydrate();
  generation = 3;
  release.resolve();
  assert.equal(await saving, false);
  assert.equal(publications, 0);
  assert.equal(values.has(localAccountSettingsKey(ownerB)), false);
  assert.deepEqual(b.getSnapshot().options, options());
  const reopened = createLocalAccountSettings({
    ownerId: ownerA,
    store: port,
    isCurrent: () => generation === 3,
  });
  await reopened.hydrate();
  assert.deepEqual(reopened.getSnapshot().options, options('dark', 'Owner A'));
  assert.deepEqual(a.getSnapshot().options, options());
});

test('owner change during uncertain readback cannot publish a recovered success', async () => {
  const f = fixture();
  await f.controller.hydrate();
  const started = deferred(),
    release = deferred();
  let publications = 0;
  f.controller.subscribe(() => {
    publications++;
  });
  f.onWrite(async (key, raw) => {
    f.values.set(key, raw);
    f.onRead(async () => {
      started.resolve();
      await release.promise;
    });
    throw new Error('lost ack');
  });
  const saving = f.controller.replaceOptions(options('dark'), options(), live);
  await started.promise;
  f.setCurrent(false);
  release.resolve();
  assert.equal(await saving, false);
  assert.equal(publications, 0);
  assert.deepEqual(f.controller.getSnapshot().options, options());
});

test('throwing and unsubscribed observers cannot poison committed results or later work', async () => {
  const f = fixture();
  let observed = 0,
    removed = 0;
  f.controller.subscribe(() => {
    throw new Error('observer');
  });
  f.controller.subscribe(() => {
    observed++;
  });
  const unsubscribe = f.controller.subscribe(() => {
    removed++;
  });
  unsubscribe();
  await f.controller.hydrate();
  assert.equal(await f.controller.replaceOptions(options('light'), options(), live), true);
  assert.equal(await f.controller.replaceOptions(options('dark'), options('light'), live), true);
  assert.equal(observed, 3);
  assert.equal(removed, 0);
  assert.equal(f.controller.getSnapshot().kind, 'ready');
});

test('unsafe owner names cannot reach injected storage', () => {
  for (const ownerId of ['guest', '../../guest', ownerA.toUpperCase(), '', 'account:' + ownerA])
    assert.throws(() => localAccountSettingsKey(ownerId), LocalAccountSettingsError);
});

test('drain waits for a retired owner’s dispatched write before storage removal', async () => {
  const f = fixture();
  const started = deferred(),
    release = deferred();
  f.onWrite(async (key, raw) => {
    started.resolve();
    await release.promise;
    f.values.set(key, raw);
  });
  const first = f.controller.replaceOptions(options('light'), options(), live);
  await started.promise;
  const queued = f.controller.replaceOptions(options('dark'), options('light'), live);
  f.setCurrent(false);
  let drained = false;
  const completion = f.controller.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release.resolve();
  await completion;
  assert.deepEqual(await Promise.all([first, queued]), [false, false]);
  assert.equal(drained, true);
  assert.equal(f.writes.length, 1);
  assert.ok(f.values.has(localAccountSettingsKey(ownerA)));
  // Only the caller removes storage, after retiring the epoch and awaiting the drain.
  f.values.delete(localAccountSettingsKey(ownerA));
  await f.controller.drain();
  assert.equal(f.values.size, 0);
});

test('subscribed preference refresh reaches a stable snapshot without notification loops', async () => {
  const f = fixture();
  const preferences = createAppPreferencesController(f.controller.preferenceStore);
  let notifications = 0;
  const stop = f.controller.subscribe(() => {
    notifications++;
    void preferences.refresh();
  });
  await preferences.hydrate();
  await preferences.refresh();
  const ready = f.controller.getSnapshot();
  await f.controller.hydrate();
  assert.equal(f.controller.getSnapshot(), ready);
  const next = options('dark', 'Synced');
  next.appPreferences.locale = 'ar';
  assert.equal(await f.controller.replaceOptions(next, options(), live), true);
  await preferences.refresh();
  assert.deepEqual(preferences.getSnapshot().preferences, next.appPreferences);
  assert.equal(notifications, 2);
  assert.equal(f.writes.length, 1);
  stop();
});
