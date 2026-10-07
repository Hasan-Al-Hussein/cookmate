/** One name for every CookMate database sharing the origin's Expo SQLite file pool. */
export const COOKMATE_WEB_STORAGE_LOCK_NAME = 'cookmate:expo-sqlite:storage-owner';

export type WebStorageLeaseStatus = 'checking' | 'owned' | 'elsewhere' | 'unavailable';
export interface WebStorageLeaseSnapshot {
  readonly status: WebStorageLeaseStatus;
}

/** Structural Web Locks port; this module has no browser or React dependency. */
export interface WebStorageLockManager {
  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: object | null) => Promise<void>,
  ): Promise<unknown>;
}

const snapshots: Record<WebStorageLeaseStatus, WebStorageLeaseSnapshot> = {
  checking: Object.freeze({ status: 'checking' }),
  owned: Object.freeze({ status: 'owned' }),
  elsewhere: Object.freeze({ status: 'elsewhere' }),
  unavailable: Object.freeze({ status: 'unavailable' }),
};

/**
 * Retain this controller on the document, including across React remounts.
 * There is deliberately no release method: only document teardown releases ownership.
 */
export function createWebStorageLease(locks: WebStorageLockManager | undefined) {
  let snapshot = snapshots.checking;
  let acquiring: Promise<WebStorageLeaseSnapshot> | null = null;
  let attempt = 0;
  const listeners = new Set<() => void>();
  const documentLifetime = new Promise<void>(() => {});

  function publish(next: WebStorageLeaseSnapshot) {
    if (snapshot === next) return;
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // An observer must never reject the callback that retains the storage lock.
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquire(): Promise<WebStorageLeaseSnapshot> {
      if (snapshot.status === 'owned') return Promise.resolve(snapshot);
      if (acquiring) return acquiring;
      if (!locks) {
        publish(snapshots.unavailable);
        return Promise.resolve(snapshots.unavailable);
      }
      const currentAttempt = ++attempt;
      let resolve!: (value: WebStorageLeaseSnapshot) => void;
      const decision = new Promise<WebStorageLeaseSnapshot>((done) => {
        resolve = done;
      });
      acquiring = decision;
      publish(snapshots.checking);
      let called = false;

      function decide(status: WebStorageLeaseStatus) {
        if (attempt !== currentAttempt) return;
        acquiring = null;
        const result = snapshots[status];
        publish(result);
        resolve(result);
      }

      try {
        const requested = locks.request(
          COOKMATE_WEB_STORAGE_LOCK_NAME,
          { mode: 'exclusive', ifAvailable: true },
          (lock) => {
            called = true;
            if (lock === null) {
              decide('elsewhere');
              return Promise.resolve();
            }
            decide('owned');
            return documentLifetime;
          },
        );
        void requested.then(
          () => {
            // A granted request cannot settle while its lifetime callback remains pending.
            if (!called || snapshot.status === 'owned') decide('unavailable');
          },
          () => decide('unavailable'),
        );
      } catch {
        decide('unavailable');
      }
      return decision;
    },
  };
}

export type WebStorageLease = ReturnType<typeof createWebStorageLease>;
