import { AccountRemoteError } from './remote';
import { AccountReplicationError } from './replicationTypes';
import { AccountSnapshotError } from './types';

export type SyncExecutionState<Review extends { kind: 'review' }> =
  | { kind: 'local' }
  | { kind: 'working' }
  | { kind: 'synced'; at: string | null }
  | { kind: 'failed'; reason: string; pending: boolean }
  | Review;

/** Shared execution lifetime only; callers retain all review, persistence and retry authority. */
export function createAccountSyncExecution<Review extends { kind: 'review' }>(options: {
  isCurrent(): boolean;
  hasPending(): Promise<boolean>;
}) {
  const { isCurrent, hasPending } = options;
  let state: SyncExecutionState<Review> = { kind: 'local' };
  let running = false;
  let retired = false;
  let request: AbortController | null = null;
  let completion: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const isActive = () => !retired && isCurrent();
  function assertCurrent() {
    if (!isActive()) throw new AccountRemoteError('account_changed');
  }
  function publish(next: SyncExecutionState<Review>) {
    if (!isActive()) return;
    state = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot undo persistence. */
      }
    }
  }
  /** One job, with no queue or implicit retry. The task must await all of its work. */
  function run(task: () => Promise<void>): Promise<void> {
    if (running || retired) return Promise.resolve();
    running = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const owned = new Promise<void>((resolveJob, rejectJob) => {
      resolve = resolveJob;
      reject = rejectJob;
    });
    // A synchronous working-state observer may invalidate. Its drain must own this job already.
    completion = owned;
    void (async () => {
      try {
        publish({ kind: 'working' });
        assertCurrent();
        await task();
      } catch (error) {
        const reason =
          error instanceof AccountRemoteError ||
          error instanceof AccountReplicationError ||
          error instanceof AccountSnapshotError
            ? error.reason
            : 'unavailable';
        let pending = false;
        if (isActive()) {
          try {
            pending = await hasPending();
          } catch {
            /* Preserve the original failure. This display flag is not recovery authority. */
          }
        }
        publish({ kind: 'failed', reason, pending });
      } finally {
        running = false;
      }
    })().then(resolve, reject);
    return owned;
  }
  async function withRequest<Value>(task: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
    assertCurrent();
    if (!running) throw new AccountReplicationError('invalid_input');
    if (request) throw new AccountReplicationError('operation_pending');
    const owned = new AbortController();
    request = owned;
    try {
      const value = await task(owned.signal);
      assertCurrent();
      return value;
    } finally {
      request = null;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isRunning: () => running,
    isActive,
    assertCurrent,
    publish,
    run,
    withRequest,
    /** Retire immediately; awaited non-network work must still finish through its own guards. */
    invalidate() {
      retired = true;
      request?.abort();
      listeners.clear();
      return completion;
    },
  };
}
