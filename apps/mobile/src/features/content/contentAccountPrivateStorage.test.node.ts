import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthClient } from '@supabase/auth-js';
import { createContentAccountPrivateStorage } from './contentAccountPrivateStorage';

test('configured account sessions, recovery and settings stay in their installation', async () => {
  const values = new Map<string, string>([['cookmate.account.auth', 'original-session']]);
  const storage = {
    async read(key: string) {
      return values.get(key) ?? null;
    },
    async write(key: string, value: string) {
      values.set(key, value);
    },
    async remove(key: string) {
      values.delete(key);
    },
  };
  const credentials = { getItem: storage.read, setItem: storage.write, removeItem: storage.remove };
  const first = createContentAccountPrivateStorage(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    storage,
    credentials,
  );
  const second = createContentAccountPrivateStorage(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    storage,
    credentials,
  );
  for (const key of [
    'cookmate.account.auth',
    'cookmate.account.auth-code-verifier',
    'cookmate.account.auth-web-pending',
    'cookmate.account.auth-deletion-recovery',
  ]) {
    await first.credentials.setItem(key, 'private-test-value');
    assert.equal(await first.credentials.getItem(key), 'private-test-value');
    assert.equal(await second.credentials.getItem(key), null);
    await second.credentials.removeItem(key);
    assert.equal(await first.credentials.getItem(key), 'private-test-value');
  }
  for (const key of [
    'cookmate.account-workspace.v1',
    'cookmate.account-settings.owner',
    'cookmate.account-removal.intent',
  ]) {
    await first.metadata.write(key, 'first');
    assert.equal(await second.metadata.read(key), null);
    await second.metadata.remove(key);
    assert.equal(await first.metadata.read(key), 'first');
  }
  assert.equal(values.get('cookmate.account.auth'), 'original-session');
  assert.ok(
    [...values.keys()]
      .filter((key) => key.startsWith('cookmate.account.auth-'))
      .every((key) => /^cookmate\.account\.auth(?:-[A-Za-z0-9_-]{1,160})?$/.test(key)),
  );
});

test('partition rejects invalid installation and credential names before accessing storage', () => {
  const storage = {
    read: async () => {
      throw new Error('touched');
    },
    write: async () => {
      throw new Error('touched');
    },
    remove: async () => {
      throw new Error('touched');
    },
  };
  const credentials = { getItem: storage.read, setItem: storage.write, removeItem: storage.remove };
  assert.throws(
    () => createContentAccountPrivateStorage('../other', storage, credentials),
    /Invalid/,
  );
  const scoped = createContentAccountPrivateStorage(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    storage,
    credentials,
  );
  assert.throws(() => scoped.credentials.getItem('cookmate.other'), /unavailable/);
  assert.throws(
    () => scoped.credentials.getItem('cookmate.account.auth-' + 'x'.repeat(101)),
    /unavailable/,
  );
  assert.throws(() => scoped.metadata.read('../other'), /Invalid/);
});

test('actual auth SDK broadcasts are isolated between configured installations and the default app', async () => {
  const originals = new Map(
    ['window', 'document', 'BroadcastChannel'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const channels = new Set<TestChannel>();
  const pending: Promise<unknown>[] = [];
  class TestChannel {
    listeners: ((event: { data: unknown }) => unknown)[] = [];
    constructor(readonly name: string) {
      channels.add(this);
    }
    addEventListener(_name: string, listener: (event: { data: unknown }) => unknown) {
      this.listeners.push(listener);
    }
    postMessage(data: unknown) {
      for (const other of channels)
        if (other !== this && other.name === this.name)
          for (const listener of other.listeners) pending.push(Promise.resolve(listener({ data })));
    }
    close() {
      channels.delete(this);
    }
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { href: 'https://cookmate.example.test' } },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: TestChannel });
  const values = new Map<string, string>();
  const metadata = {
    read: async (key: string) => values.get(key) ?? null,
    write: async (key: string, value: string) => {
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
  const credentials = {
    getItem: metadata.read,
    setItem: metadata.write,
    removeItem: metadata.remove,
  };
  const first = createContentAccountPrivateStorage(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    metadata,
    credentials,
  );
  const second = createContentAccountPrivateStorage(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    metadata,
    credentials,
  );
  const seen: string[][] = [[], [], []];
  const clients: InstanceType<typeof AuthClient>[] = [];
  try {
    for (const [index, partition] of [
      first,
      second,
      { authStorageKey: 'cookmate.account.auth', credentials },
    ].entries()) {
      const client = new AuthClient({
        url: 'https://account.example.test/auth/v1',
        storageKey: partition.authStorageKey,
        storage: partition.credentials,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        skipAutoInitialize: true,
        fetch: async () => {
          throw new Error('No provider request permitted in this test');
        },
      });
      clients.push(client);
      client.onAuthStateChange((event) => {
        if (event !== 'INITIAL_SESSION') seen[index]!.push(event);
      });
      await client.initialize();
    }
    new TestChannel(first.authStorageKey).postMessage({ event: 'SIGNED_OUT', session: null });
    await Promise.all(pending.splice(0));
    assert.deepEqual(seen, [['SIGNED_OUT'], [], []]);
    new TestChannel(second.authStorageKey).postMessage({ event: 'TOKEN_REFRESHED', session: null });
    await Promise.all(pending.splice(0));
    assert.deepEqual(seen, [['SIGNED_OUT'], ['TOKEN_REFRESHED'], []]);
    assert.equal(await first.credentials.getItem(first.authStorageKey), null);
  } finally {
    for (const client of clients) await client.dispose();
    for (const channel of channels) channel.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
