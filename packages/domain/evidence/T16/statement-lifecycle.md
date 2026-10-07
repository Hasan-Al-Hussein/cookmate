# Statement and transaction lifecycle

`SqlSession` is callback-scoped. Writer and reader each serialize their own transactions. The actual connection's foreign-key setting is verified before BEGIN; a separate connection's PRAGMA is insufficient.

Owned seed/query writes bind values; raw execution is reserved for fixed DDL, PRAGMA and transaction text. `runBound` and seed statement reuse finalize in finally blocks. The transaction boundary additionally tracks prepared handles and finalizes leaked handles exactly once on both success and callback failure, before commit/rollback. An escaped run/session fails after scope end. Finalize is idempotent. A cleanup or rollback failure invalidates that connection rather than accepting another transaction.

Desktop fixtures verify callback ordering, pending unawaited statement completion before commit, rollback on unawaited failure, leaked-handle cleanup, failed cleanup rollback/invalidation, and bound hostile-looking values. Prepared/finalized counters agree on tested paths. Queue rejection from a recoverable statement failure does not poison later work. Close waits for queued work and is idempotent.

Resource counters are an instrumented desktop adapter, not measurements of iOS native resources. Verify the same paths with the real Expo module on the target iPhone before claiming native lifecycle acceptance.

Independent review DSF-02 exposed an opaque cleanup path in Expo's convenience `getAllAsync` wrapper. `nativeAdapter.ts` now explicitly prepares/executes/finalizes reads and classifies finalizer failure as `SqlCleanupFault`. The serialized boundary invalidates on that signal during pre-BEGIN foreign-key checks and callback reads. Native-shape fixtures run this actual adapter code over desktop SQLite: both cleanup failure locations reject reuse, while ordinary SQL errors with successful cleanup allow subsequent queued reads. These are controlled adapter tests, not actual iPhone fault observations.
