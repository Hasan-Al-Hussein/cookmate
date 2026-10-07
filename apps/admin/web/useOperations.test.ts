import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { unknownReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminMutation, AdminUser } from '../src/contracts';
import { AdminApi } from './api';
import { useOperations } from './useOperations';

const userA: AdminUser = { userId: 'owner-a', username: 'Fixture A', role: 'administrator' };
const userB: AdminUser = { userId: 'owner-b', username: 'Fixture B', role: 'administrator' };
function mutation(operationId: string): AdminMutation {
  return {
    operationId,
    draft: {
      draftId: 'fixture-draft',
      recipeId: '1000000',
      revision: 2,
      status: 'draft',
      input: {
        title: 'Fixture recipe',
        description: null,
        category: '',
        cuisine: '',
        rawTags: null,
        recipePage: null,
        originalSourceUrl: null,
        videoUrl: null,
        photoAssetId: null,
        ingredients: [],
        instructions: [],
        credits: [],
        changeSummary: '',
      },
      basedOn: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
      updatedBy: userA,
      metadata: unknownReviewedMetadata(),
      approval: null,
      validationIssues: [],
      photoUrl: null,
    },
  };
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext) {
  const stored = new Map<string, string>();
  const previous = ['sessionStorage', 'IS_REACT_ACT_ENVIRONMENT'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  let authenticated = userA;
  let uncertain = true;
  let response: Promise<Response> | null = null;
  const calls: string[] = [];
  const commits: AdminMutation[] = [];
  const api = new AdminApi(
    () => {},
    async (url, init) => {
      const path = String(url);
      if (path.endsWith('/session'))
        return Response.json({
          configured: true,
          user: authenticated,
          csrfToken: authenticated.userId,
          expiresAt: null,
        });
      calls.push(path);
      if (response) {
        const pending = response;
        response = null;
        return pending;
      }
      if (path.endsWith('/metadata')) {
        if (uncertain) throw new Error('Fixture lost acknowledgement');
        return Response.json(mutation(JSON.parse(String(init?.body)).operationId));
      }
      const operationId = path.split('/')[4]!;
      return Response.json(
        path.endsWith('/cancel') ? { operationId, status: 'cancelled' } : mutation(operationId),
      );
    },
  );
  await api.session();
  let latest!: ReturnType<typeof useOperations>;
  function Harness({ user }: { user: AdminUser }) {
    latest = useOperations(api, user, (result) => {
      commits.push(result);
    });
    return null;
  }
  let view: ReactTestRenderer;
  let mounted = true;
  await act(async () => {
    view = create(createElement(Harness, { user: userA }));
  });
  async function unmount() {
    if (mounted) {
      mounted = false;
      await act(async () => view.unmount());
    }
  }
  t.after(async () => {
    await unmount();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return {
    api,
    calls,
    commits,
    stored,
    unmount,
    get operations() {
      return latest;
    },
    async update(user: AdminUser, refresh = false) {
      authenticated = user;
      if (refresh) await api.session();
      await act(async () => view.update(createElement(Harness, { user })));
    },
    allowReceipt() {
      uncertain = false;
    },
    delay(value: Promise<Response>) {
      response = value;
    },
    async start() {
      await act(async () =>
        latest.run('metadata', 'fixture-draft', (operationId) =>
          api.metadata('fixture-draft', operationId, 1, {
            field: 'prepMinutes',
            value: 0,
            source: 'Synthetic fixture evidence',
          }),
        ),
      );
      assert.ok(latest.pending);
      assert.equal(stored.size, 1);
    },
  };
}

test('retained recovery and run callbacks cannot send under a replacement owner; the original owner can explicitly recover', async (t) => {
  const f = await fixture(t);
  const run = f.operations.run;
  await f.start();
  const old = f.operations;
  const pending = old.pending;
  await f.update(userB, true);
  await act(async () => {
    await old.retry();
    await old.resolve();
    await old.check();
    await f.operations.retry();
    await run('metadata', 'fixture-draft', async () => {
      throw new Error('Stale run dispatched');
    });
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.commits.length, 0);
  assert.deepEqual(f.operations.pending, pending);
  assert.equal(f.stored.size, 1);
  await f.update(userA, true);
  f.allowReceipt();
  await act(async () => {
    await old.retry();
    await old.resolve();
  });
  assert.equal(f.calls.length, 1);
  await act(async () => f.operations.retry());
  assert.equal(f.calls.length, 2);
  assert.equal(f.commits.length, 1);
  assert.equal(f.stored.size, 0);
});

test('same-owner session refresh invalidates retained callbacks even before a rerender, then fresh recovery is allowed', async (t) => {
  const f = await fixture(t);
  await f.start();
  const old = f.operations;
  await f.api.session();
  await act(async () => {
    await old.retry();
    await old.resolve();
    await old.check();
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.stored.size, 1);
  await f.update(userA);
  await act(async () => f.operations.check());
  assert.equal(f.calls.length, 2);
  assert.equal(f.commits.length, 1);
  assert.equal(f.stored.size, 0);
});

test('a receipt returning after owner replacement never commits into that owner or clears the retained journal', async (t) => {
  const f = await fixture(t);
  await f.start();
  const pending = f.operations.pending!;
  const response = deferred();
  f.delay(response.promise);
  let checking!: Promise<void>;
  await act(async () => {
    checking = f.operations.check();
  });
  await f.update(userB);
  await act(async () => {
    response.resolve(Response.json(mutation(pending.operationId)));
    await checking;
  });
  assert.equal(f.commits.length, 0);
  assert.equal(f.stored.size, 1);
  assert.deepEqual(f.operations.pending, pending);
  assert.equal(f.operations.busy, false);
  await f.update(userA);
  await act(async () => f.operations.check());
  assert.equal(f.commits.length, 1);
  assert.equal(f.stored.size, 0);
});

test('a dispatched mutation completing after an owner change keeps its exact journal without applying the result', async (t) => {
  const f = await fixture(t);
  const response = deferred();
  f.delay(response.promise);
  let saving!: Promise<void>;
  await act(async () => {
    saving = f.operations.run('metadata', 'fixture-draft', (operationId) =>
      f.api.metadata('fixture-draft', operationId, 1, {
        field: 'prepMinutes',
        value: 0,
        source: 'Synthetic fixture evidence',
      }),
    );
  });
  const pending = f.operations.pending!;
  assert.ok(pending);
  await f.update(userB);
  await act(async () => {
    response.resolve(Response.json(mutation(pending.operationId)));
    await saving;
  });
  assert.equal(f.commits.length, 0);
  assert.equal(f.stored.size, 1);
  assert.deepEqual(f.operations.pending, pending);
  assert.equal(f.operations.busy, false);
});

test('a cancellation response from an earlier session retains recovery until a fresh explicit resolution', async (t) => {
  const f = await fixture(t);
  await f.start();
  const pending = f.operations.pending!;
  const response = deferred();
  f.delay(response.promise);
  let resolving!: Promise<void>;
  await act(async () => {
    resolving = f.operations.resolve();
  });
  await f.api.session();
  await act(async () => {
    response.resolve(Response.json({ operationId: pending.operationId, status: 'cancelled' }));
    await resolving;
  });
  assert.deepEqual(f.operations.pending, pending);
  assert.equal(f.stored.size, 1);
  assert.equal(f.commits.length, 0);
  await f.update(userA);
  await act(async () => f.operations.resolve());
  assert.equal(f.operations.pending, null);
  assert.equal(f.stored.size, 0);
  assert.match(f.operations.resolutionNotice!, /cancelled its identifier/);
});

test('unmounted recovery callbacks remain inert and keep the exact operation reference', async (t) => {
  const f = await fixture(t);
  await f.start();
  const old = f.operations;
  await f.unmount();
  await old.retry();
  await old.resolve();
  await old.check();
  assert.equal(f.calls.length, 1);
  assert.equal(f.stored.size, 1);
  assert.equal(f.commits.length, 0);
});
