import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountRemoteError } from '../src/remote';
import { AccountReplicationError } from '../src/replicationTypes';
import { AccountSnapshotError } from '../src/types';
import { createAccountSyncExecution } from '../src/syncExecution';

type Review = { kind: 'review'; operationId: string; requiresRemovalChoice: boolean };
function deferred<Value = void>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const changed = (error: unknown) =>
  error instanceof AccountRemoteError && error.reason === 'account_changed';

test('execution publishes common and typed review states, retaining observer isolation and unsubscribe', async () => {
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => false,
  });
  assert.deepEqual(execution.getSnapshot(), { kind: 'local' });
  const states: string[] = [];
  execution.subscribe(() => {
    throw new Error('Observer failed');
  });
  const unsubscribe = execution.subscribe(() => states.push(execution.getSnapshot().kind));
  const review: Review = {
    kind: 'review',
    operationId: 'fixture-review',
    requiresRemovalChoice: true,
  };
  await execution.run(async () => execution.publish(review));
  assert.equal(execution.getSnapshot(), review);
  assert.deepEqual(states, ['working', 'review']);
  unsubscribe();
  execution.publish({ kind: 'synced', at: null });
  assert.deepEqual(execution.getSnapshot(), { kind: 'synced', at: null });
  assert.deepEqual(states, ['working', 'review']);
});

test('execution runs one job immediately and drops duplicate or reentrant calls without queueing', async () => {
  const finish = deferred();
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => false,
  });
  let calls = 0;
  execution.subscribe(() => {
    if (execution.getSnapshot().kind === 'working')
      void execution.run(async () => {
        calls += 100;
      });
  });
  const first = execution.run(async () => {
    calls++;
    await finish.promise;
  });
  assert.equal(calls, 1);
  assert.equal(execution.isRunning(), true);
  await execution.run(async () => {
    calls += 10;
  });
  assert.equal(calls, 1);
  finish.resolve();
  await first;
  assert.equal(execution.isRunning(), false);
  assert.equal(calls, 1);
  await execution.run(async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

test('working-state invalidation receives the current job drain before any task can start', async () => {
  let calls = 0,
    pendingReads = 0;
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => {
      pendingReads++;
      return false;
    },
  });
  const drains: Promise<void>[] = [];
  execution.subscribe(() => {
    if (execution.getSnapshot().kind === 'working') drains.push(execution.invalidate());
  });
  const job = execution.run(async () => {
    calls++;
  });
  assert.equal(drains.length, 1);
  assert.equal(drains[0], job);
  await job;
  assert.equal(calls, 0);
  assert.equal(pendingReads, 0);
  assert.equal(execution.isActive(), false);
  assert.equal(execution.isRunning(), false);
});

test('invalidation aborts the owned request, drains ignored aborts and suppresses late response use', async () => {
  const response = deferred<number>();
  const signals: AbortSignal[] = [];
  let pendingReads = 0,
    delivered = false;
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => {
      pendingReads++;
      return true;
    },
  });
  const states: string[] = [];
  execution.subscribe(() => states.push(execution.getSnapshot().kind));
  const job = execution.run(async () => {
    await execution.withRequest(async (signal) => {
      signals.push(signal);
      return response.promise;
    });
    delivered = true;
    execution.publish({ kind: 'synced', at: null });
  });
  const drain = execution.invalidate();
  assert.equal(drain, job);
  assert.equal(execution.invalidate(), drain);
  assert.equal(signals[0]?.aborted, true);
  let finished = false;
  void drain.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  response.resolve(7);
  await drain;
  assert.equal(delivered, false);
  assert.equal(pendingReads, 0);
  assert.deepEqual(states, ['working']);
});

test('invalidation drains in-flight non-network work without publishing its late completion', async () => {
  const sql = deferred();
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => false,
  });
  let finished = false,
    callbacks = 0;
  execution.subscribe(() => {
    callbacks++;
  });
  const job = execution.run(async () => {
    await sql.promise;
    finished = true;
    execution.publish({ kind: 'synced', at: null });
  });
  const drain = execution.invalidate();
  assert.equal(drain, job);
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(execution.isRunning(), true);
  sql.resolve();
  await drain;
  assert.equal(finished, true);
  assert.equal(callbacks, 1);
  assert.equal(execution.isRunning(), false);
  assert.deepEqual(execution.getSnapshot(), { kind: 'working' });
});

test('owner change rejects a late request response before the algorithm can use it', async () => {
  const response = deferred<number>();
  let current = true,
    delivered = false,
    pendingReads = 0;
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => current,
    hasPending: async () => {
      pendingReads++;
      return true;
    },
  });
  const job = execution.run(async () => {
    await execution.withRequest(async () => response.promise);
    delivered = true;
  });
  current = false;
  response.resolve(7);
  await job;
  assert.equal(delivered, false);
  assert.equal(pendingReads, 0);
  assert.equal(execution.isActive(), false);
  assert.throws(execution.assertCurrent, changed);
  assert.deepEqual(execution.getSnapshot(), { kind: 'working' });
});

test('execution retains known error reasons and never exposes arbitrary error prose', async () => {
  for (const [error, reason] of [
    [new AccountRemoteError('needs_review'), 'needs_review'],
    [new AccountReplicationError('journal_changed'), 'journal_changed'],
    [new AccountSnapshotError('invalid_structure'), 'invalid_structure'],
    [new Error('Private provider response'), 'unavailable'],
  ] as const) {
    let reads = 0;
    const execution = createAccountSyncExecution<Review>({
      isCurrent: () => true,
      hasPending: async () => {
        reads++;
        return true;
      },
    });
    await execution.run(async () => {
      throw error;
    });
    assert.deepEqual(execution.getSnapshot(), { kind: 'failed', reason, pending: true });
    assert.equal(reads, 1);
    assert.equal(execution.isRunning(), false);
  }
});

test('failed pending inspection preserves the original error and legacy display flag', async () => {
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => {
      throw new AccountReplicationError('stored_data_invalid');
    },
  });
  await execution.run(async () => {
    throw new AccountRemoteError('unavailable');
  });
  assert.deepEqual(execution.getSnapshot(), {
    kind: 'failed',
    reason: 'unavailable',
    pending: false,
  });
});

test('retirement while inspecting pending state drains the lookup and cannot publish its result', async () => {
  const pending = deferred<boolean>();
  let reads = 0;
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => {
      reads++;
      return pending.promise;
    },
  });
  const job = execution.run(async () => {
    throw new AccountRemoteError('unavailable');
  });
  await Promise.resolve();
  assert.equal(reads, 1);
  const drain = execution.invalidate();
  assert.equal(drain, job);
  let finished = false;
  void drain.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  pending.resolve(true);
  await drain;
  assert.deepEqual(execution.getSnapshot(), { kind: 'working' });
});

test('request failures have no hidden retry and release the controller for the next explicit request', async () => {
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => false,
  });
  const signals: AbortSignal[] = [];
  let calls = 0;
  await execution.run(async () => {
    await assert.rejects(
      execution.withRequest(async (signal) => {
        calls++;
        signals.push(signal);
        throw new AccountRemoteError('unavailable');
      }),
      (error: unknown) => error instanceof AccountRemoteError && error.reason === 'unavailable',
    );
    const value = await execution.withRequest(async (signal) => {
      calls++;
      signals.push(signal);
      return 7;
    });
    assert.equal(value, 7);
  });
  assert.equal(calls, 2);
  assert.notEqual(signals[0], signals[1]);
  await execution.invalidate();
  assert.equal(signals[0]?.aborted, false);
  assert.equal(signals[1]?.aborted, false);
});

test('one job cannot overlap requests or dispatch outside its owned execution', async () => {
  const execution = createAccountSyncExecution<Review>({
    isCurrent: () => true,
    hasPending: async () => false,
  });
  const response = deferred<number>();
  let calls = 0;
  await assert.rejects(
    execution.withRequest(async () => {
      calls++;
    }),
    (error: unknown) =>
      error instanceof AccountReplicationError && error.reason === 'invalid_input',
  );
  const job = execution.run(async () => {
    const first = execution.withRequest(async () => {
      calls++;
      return response.promise;
    });
    await assert.rejects(
      execution.withRequest(async () => {
        calls++;
      }),
      (error: unknown) =>
        error instanceof AccountReplicationError && error.reason === 'operation_pending',
    );
    response.resolve(7);
    assert.equal(await first, 7);
  });
  await job;
  assert.equal(calls, 1);
  await execution.invalidate();
  await assert.rejects(
    execution.withRequest(async () => {
      calls++;
    }),
    changed,
  );
  await execution.run(async () => {
    calls++;
  });
  assert.equal(calls, 1);
});
