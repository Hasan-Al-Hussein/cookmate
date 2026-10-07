import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createAccountSessionStorage, AccountCredentialStorageError } from './sessionStorage';

const key = 'cookmate.account.auth';
const hash = async (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const values = new Map<string, string>();
  let fault: ((key: string, value: string) => void) | null = null;
  const port = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      fault?.(key, value);
      values.set(key, value);
    },
    remove: async (key: string) => {
      values.delete(key);
    },
  };
  return {
    values,
    port,
    storage: createAccountSessionStorage(port, hash),
    fail: (value: typeof fault) => {
      fault = value;
    },
  };
}
test('session chunks round-trip long Unicode without exceeding SecureStore item size', async () => {
  const f = fixture(),
    value = 'a'.repeat(349) + '🥘مرحبا'.repeat(1000);
  await f.storage.setItem(key, value);
  assert.equal(await f.storage.getItem(key), value);
  for (const part of f.values.values()) assert.ok(new TextEncoder().encode(part).byteLength < 2048);
});
test('interrupted session refresh preserves the previous committed session', async () => {
  const f = fixture();
  await f.storage.setItem(key, 'previous-session');
  f.fail((name) => {
    if (name.endsWith('.b.1')) throw new Error('storage interrupted');
  });
  await assert.rejects(f.storage.setItem(key, 'x'.repeat(2000)), AccountCredentialStorageError);
  assert.equal(await f.storage.getItem(key), 'previous-session');
  f.fail(null);
  await f.storage.setItem(key, 'new-session');
  assert.equal(await f.storage.getItem(key), 'new-session');
  assert.equal([...f.values.values()].includes('previous-session'), false);
});
test('lost pointer acknowledgement leaves a complete readable new session after reopen', async () => {
  const f = fixture();
  await f.storage.setItem(key, 'old');
  const root = `cookmate.auth.${await hash(key)}`;
  f.fail((name, value) => {
    if (name === root) {
      f.values.set(name, value);
      throw new Error('lost receipt');
    }
  });
  await assert.rejects(f.storage.setItem(key, 'new'), AccountCredentialStorageError);
  const reopened = createAccountSessionStorage(f.port, hash);
  assert.equal(await reopened.getItem(key), 'new');
});
test('remove clears active and stale encrypted chunks; refreshes are serialized', async () => {
  const f = fixture();
  await Promise.all([f.storage.setItem(key, 'first'), f.storage.setItem(key, 'second')]);
  assert.equal(await f.storage.getItem(key), 'second');
  await f.storage.removeItem(key);
  assert.equal(await f.storage.getItem(key), null);
  assert.equal(f.values.size, 0);
});
test('missing chunks, oversized credentials and unrelated namespaces fail closed', async () => {
  const f = fixture();
  await f.storage.setItem(key, 'hello');
  const chunk = [...f.values.keys()].find((name) => name.endsWith('.a.0'))!;
  f.values.delete(chunk);
  await assert.rejects(f.storage.getItem(key), AccountCredentialStorageError);
  await assert.rejects(f.storage.setItem(key, 'x'.repeat(65537)), AccountCredentialStorageError);
  await assert.rejects(
    f.storage.setItem('cookmate.pairing-secret', 'value'),
    AccountCredentialStorageError,
  );
});
