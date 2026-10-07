import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COOKMATE_WEB_STORAGE_LOCK_NAME,
  createWebStorageLease,
  type WebStorageLockManager,
  type WebStorageLeaseStatus,
} from './webStorageLease';

function controlledLocks() {
  const requests: Array<{
    name: string;
    options: { mode: 'exclusive'; ifAvailable: true };
    callback(lock: object | null): Promise<void>;
    complete(): void;
    fail(): void;
  }> = [];
  const locks: WebStorageLockManager = {
    request(name, options, callback) {
      return new Promise<void>((resolve, reject) => {
        requests.push({
          name,
          options,
          callback,
          complete: resolve,
          fail: () => reject(new Error('Synthetic lock request failure')),
        });
      });
    },
  };
  function requestAt(index: number) {
    const request = requests[index];
    assert.ok(request, `Expected lock request at index ${index}`);
    return request;
  }
  return { locks, requests, requestAt };
}

test('concurrent acquisition shares one request and retains an immutable owned snapshot', async () => {
  const f = controlledLocks();
  const lease = createWebStorageLease(f.locks);
  const initial = lease.getSnapshot();
  assert.equal(initial.status, 'checking');
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(lease.getSnapshot(), initial);
  const first = lease.acquire();
  assert.equal(lease.acquire(), first);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requestAt(0).name, COOKMATE_WEB_STORAGE_LOCK_NAME);
  assert.deepEqual(f.requestAt(0).options, { mode: 'exclusive', ifAvailable: true });
  let released = false;
  void f
    .requestAt(0)
    .callback({})
    .then(() => {
      released = true;
    });
  const owned = await first;
  assert.equal(owned.status, 'owned');
  assert.equal(Object.isFrozen(owned), true);
  assert.equal(await lease.acquire(), owned);
  assert.equal(f.requests.length, 1);
  assert.equal(released, false);
  assert.equal('release' in lease, false);
  assert.equal('dispose' in lease, false);
});

test('separate documents compete for the same origin-wide lock rather than opening two pools', async () => {
  let held = false;
  const names: string[] = [];
  const locks: WebStorageLockManager = {
    request(name, _options, callback) {
      names.push(name);
      if (held) return callback(null);
      held = true;
      return callback({}).finally(() => {
        held = false;
      });
    },
  };
  const first = createWebStorageLease(locks);
  const second = createWebStorageLease(locks);
  assert.equal((await first.acquire()).status, 'owned');
  assert.equal((await second.acquire()).status, 'elsewhere');
  assert.deepEqual(names, [COOKMATE_WEB_STORAGE_LOCK_NAME, COOKMATE_WEB_STORAGE_LOCK_NAME]);
  assert.equal(held, true);
  assert.equal(first.getSnapshot().status, 'owned');
});

test('denied acquisition retries only when explicitly requested', async () => {
  const f = controlledLocks();
  const lease = createWebStorageLease(f.locks);
  const first = lease.acquire();
  await f.requestAt(0).callback(null);
  f.requestAt(0).complete();
  assert.equal((await first).status, 'elsewhere');
  assert.equal(f.requests.length, 1);
  const retry = lease.acquire();
  assert.equal(lease.getSnapshot().status, 'checking');
  assert.equal(f.requests.length, 2);
  void f.requestAt(1).callback({});
  assert.equal((await retry).status, 'owned');
});

test('unsupported Web Locks fails closed without a takeover fallback or repeated checking state', async () => {
  const lease = createWebStorageLease(undefined);
  const changes: WebStorageLeaseStatus[] = [];
  lease.subscribe(() => changes.push(lease.getSnapshot().status));
  const unavailable = await lease.acquire();
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(await lease.acquire(), unavailable);
  assert.deepEqual(changes, ['unavailable']);
});

for (const failure of ['throw', 'reject'] as const)
  test(`a ${failure} request fails closed and can retry explicitly`, async () => {
    const f = controlledLocks();
    let failFirst = true;
    const lease = createWebStorageLease({
      request(name, options, callback) {
        if (failFirst) {
          failFirst = false;
          if (failure === 'throw') throw new Error('Synthetic access failure');
          return Promise.reject(new Error('Synthetic access failure'));
        }
        return f.locks.request(name, options, callback);
      },
    });
    assert.equal((await lease.acquire()).status, 'unavailable');
    assert.equal(f.requests.length, 0);
    const retry = lease.acquire();
    void f.requestAt(0).callback({});
    assert.equal((await retry).status, 'owned');
  });

test('a request that completes without granting or denying ownership fails closed', async () => {
  const lease = createWebStorageLease({ request: async () => undefined });
  assert.equal((await lease.acquire()).status, 'unavailable');
});

test('subscription cleanup never releases ownership and a failed observer cannot reject its lifetime callback', async () => {
  const f = controlledLocks();
  const lease = createWebStorageLease(f.locks);
  const changes: WebStorageLeaseStatus[] = [];
  const unsubscribe = lease.subscribe(() => changes.push(lease.getSnapshot().status));
  lease.subscribe(() => {
    throw new Error('Synthetic observer failure');
  });
  const pending = lease.acquire();
  let ended = false;
  void f
    .requestAt(0)
    .callback({})
    .finally(() => {
      ended = true;
    });
  assert.equal((await pending).status, 'owned');
  unsubscribe();
  assert.equal(await lease.acquire(), lease.getSnapshot());
  assert.deepEqual(changes, ['owned']);
  assert.equal(ended, false);
  assert.equal(f.requests.length, 1);
});

test('unexpected loss of a granted request fails closed instead of claiming ongoing ownership', async () => {
  const f = controlledLocks();
  const lease = createWebStorageLease(f.locks);
  const pending = lease.acquire();
  void f.requestAt(0).callback({});
  assert.equal((await pending).status, 'owned');
  f.requestAt(0).fail();
  await Promise.resolve();
  assert.equal(lease.getSnapshot().status, 'unavailable');
});

test('a superseded denied request cannot overwrite the result of its explicit retry', async () => {
  const f = controlledLocks();
  const lease = createWebStorageLease(f.locks);
  const first = lease.acquire();
  await f.requestAt(0).callback(null);
  assert.equal((await first).status, 'elsewhere');
  const retry = lease.acquire();
  void f.requestAt(1).callback({});
  assert.equal((await retry).status, 'owned');
  f.requestAt(0).fail();
  await Promise.resolve();
  assert.equal(lease.getSnapshot().status, 'owned');
});
