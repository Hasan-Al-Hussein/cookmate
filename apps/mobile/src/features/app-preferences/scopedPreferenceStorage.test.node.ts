import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  contentPreferenceScope,
  createScopedPreferenceStores,
  preferenceStorageKey,
} from './scopedPreferenceStorage';
import { createAppPreferencesController, defaultAppPreferences } from './preferences';
const a = 'account:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'account:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('account preference stores isolate an already-dispatched save from the next owner', async () => {
  const values = new Map<string, string>();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stores = createScopedPreferenceStores({
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      if (key === preferenceStorageKey(a)) await wait;
      values.set(key, value);
    },
  });
  assert.equal(stores(a), stores(a));
  const old = createAppPreferencesController(stores(a)),
    next = createAppPreferencesController(stores(b));
  await old.hydrate();
  await next.hydrate();
  let current = true;
  const pending = old.replacePreferences(
    { ...defaultAppPreferences, theme: 'dark' },
    defaultAppPreferences,
    () => current,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  current = false;
  release();
  assert.equal(await pending, false);
  assert.equal(await stores(b).read(), null);
  assert.equal(await stores('guest').read(), null);
  assert.equal(next.getSnapshot().preferences.theme, 'system');
  assert.ok(await stores(a).read());
});
test('guest keeps its original key and malformed scopes cannot target another store', () => {
  assert.equal(preferenceStorageKey('guest'), 'cookmate.presentation-preferences');
  assert.equal(
    preferenceStorageKey(a),
    'cookmate.presentation-preferences.account.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  assert.equal(
    preferenceStorageKey('account:aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa'),
    'cookmate.presentation-preferences.account.aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa',
  );
  for (const scope of ['account:../../guest', 'account:', 'cookmate.account.auth'])
    assert.throws(() => preferenceStorageKey(scope));
});

const installationA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const installationB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('content installation preferences retain stable separate stores and exact persisted values', async () => {
  const values = new Map<string, string>();
  const stores = createScopedPreferenceStores({
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      values.set(key, value);
    },
  });
  const scope = contentPreferenceScope(installationA);
  assert.equal(scope, `content:${installationA}`);
  assert.equal(
    preferenceStorageKey(scope),
    `cookmate.presentation-preferences.content.${installationA}`,
  );
  assert.equal(stores(scope), stores(contentPreferenceScope(installationA)));
  const raw = '{"schemaVersion":1,"theme":"dark","motion":"reduced","locale":"ar"}';
  await stores(scope).write(raw);
  assert.equal(await stores(scope).read(), raw);
  assert.equal(await stores(contentPreferenceScope(installationB)).read(), null);
  assert.equal(await stores(a).read(), null);
  assert.equal(await stores('guest').read(), null);
  assert.deepEqual([...values.keys()], [preferenceStorageKey(scope)]);
});

test('content installation rejects malformed identifiers before any storage read or write', () => {
  let accessed = false;
  const stores = createScopedPreferenceStores({
    read: async () => {
      accessed = true;
      return null;
    },
    write: async () => {
      accessed = true;
    },
  });
  for (const id of [
    '',
    'guest',
    '../../guest',
    ` ${installationA}`,
    installationA.toUpperCase(),
    'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa',
    `${installationA}:guest`,
  ]) {
    assert.throws(() => contentPreferenceScope(id));
    assert.throws(() => stores(`content:${id}`));
  }
  assert.equal(accessed, false);
});

test('a dispatched content preference save cannot write into a replacement installation or main workspace', async () => {
  const oldScope = contentPreferenceScope(installationA),
    nextScope = contentPreferenceScope(installationB);
  const values = new Map<string, string>([
    [preferenceStorageKey('guest'), 'untouched guest bytes'],
    [preferenceStorageKey(a), 'untouched account bytes'],
  ]);
  let started!: () => void, release!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stores = createScopedPreferenceStores({
    read: async (key) => values.get(key) ?? null,
    write: async (key, value) => {
      started();
      await wait;
      values.set(key, value);
    },
  });
  const old = createAppPreferencesController(stores(oldScope));
  const next = createAppPreferencesController(stores(nextScope));
  await old.hydrate();
  await next.hydrate();
  let current = true;
  const saving = old.replacePreferences(
    { ...defaultAppPreferences, theme: 'dark', motion: 'reduced' },
    defaultAppPreferences,
    () => current,
  );
  await dispatched;
  current = false;
  release();
  assert.equal(await saving, false);
  assert.equal(await stores(nextScope).read(), null);
  assert.equal(next.getSnapshot().preferences.theme, 'system');
  assert.equal(await stores('guest').read(), 'untouched guest bytes');
  assert.equal(await stores(a).read(), 'untouched account bytes');
  const reopened = createAppPreferencesController(stores(oldScope));
  await reopened.hydrate();
  assert.equal(reopened.getSnapshot().preferences.theme, 'dark');
  assert.equal(reopened.getSnapshot().preferences.motion, 'reduced');
});
