import { AccountAuthError } from './authTypes';

/** A replacement client must wait for this lifetime, including late SDK storage writes. */
export function createAuthLifetime() {
  let retired = false;
  let sealed = false;
  const pending = new Set<Promise<unknown>>();
  function track<T>(task: Promise<T>): Promise<T> {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  return {
    get retired() {
      return retired;
    },
    check() {
      if (retired) throw new AccountAuthError('account_changed');
    },
    track,
    storage<T>(task: () => Promise<T>) {
      if (sealed) return Promise.reject(new AccountAuthError('account_changed'));
      return track(task());
    },
    retire() {
      retired = true;
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
      sealed = true;
    },
  };
}
