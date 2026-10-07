# T25 — durable assistant action plans

28 September 2026. Focused desktop SQLite evidence for the authorized action-plan persistence lane. This does not establish native iPhone, UI, provider, or whole-memory acceptance.

## Owned implementation

- `apps/mobile/src/data/actionPlanRecords.ts`: validates the exact accepted proposal order, supported payload mapping, origin, relative-date source, reserved UUID identities, frozen command prefix, lifecycle/cursor, actual receipts and matching receipt journal. Structural reads do not recurse into the assistant-intent reader. Repository and command hooks additionally recompute every frozen command fingerprint with the injected platform.
- `apps/mobile/src/data/assistantActionRepository.ts`: exposes current state, immutable plan freeze, legacy complete-intent freeze, sequential finalization, execution and cancellation. Exports the executor hooks that enforce assistant authority even through general command execution.
- `packages/domain/test/assistantActions.test.ts`: disk-backed, independent writer and query-only reader connections; schema-v2 initialization; real context/begin/accept envelopes and memory updates; real command preparation, handlers, receipts and recovery.

The lead owns the table, intent-reader integration, hook invocation in the executor, domain interfaces and local-store factory. This lane uses those interfaces without changing them. Source text and preference values are written through the real APIs; this test fixture has no direct inserts into the four internal JSON-text codec columns.

## Authority and recovery decisions

The reserved plan contains every authorized proposal in response order. Freeze requires the persisted accepted guards and actual current revisions/runtime. Retrying the exact plan or finalized slot returns its existing identities and current lifecycle without granting new authority. Changed plans conflict.

Only the exact next slot can be finalized or executed. A preference slot takes its expected preference revision from the current actual snapshot, retaining its reserved operation and entity IDs. Existing immutable slots never change. The receipt hook journals the actual receipt, advances the cursor and stores actual post-receipt conversation, preference, plan and shopping-scope revisions in the same transaction as the mutation and receipt. Date and connection authority never renew. A duplicate preference no-op therefore does not predict an increment; recipe replacement can rebuild shopping demand without changing the scope membership revision.

Receipt-first replay remains historical after runtime changes or cancellation. Failed or uncertain results never invent receipts, skip a prefix or authorize later actions. An uncertain prefix requires reconciliation. Cancellation preserves committed receipts and blocks undispatched authority. Draft edits preserve semantic authority; later conversation turns invalidate it.

Freeze/finalization write notifications recover from lost COMMIT acknowledgement only when their exact persisted plan or command proves the particular write. Receipt, result journal, cursor and authority writes roll back together. The last executor hook checks runtime after these writes and before commit. Legacy complete frozen intents are supported with at most one preference save; sequential plans support the contract's full eight slots.

## Checks actually run

Environment: Windows PowerShell, Node v24.13.0, `node:sqlite` SQLite 3.50.4. The standard experimental SQLite warning was emitted. Commands ran from the `cookmate-app` root.

```powershell
node --import tsx --test --test-concurrency=1 packages/domain/test/assistantActions.test.ts
```

Final focused result: **13 passed, 0 failed**, duration **4598.3234 ms**. Coverage includes duplicate-first-save actual revision chaining, reserved identity/finalization retry, malformed/reordered/changed plans, corruption rejection, unrelated preference/date/connection/conversation/scope changes, general-executor enforcement, atomic rollback at both hook writes, cancellation, disk reopen, uncertain prefix, lost freeze/finalize acknowledgement, draft semantics, final runtime rollback, legacy frozen compatibility, two relative-date add-plan actions and an occupied selected replacement followed by a second action.

The two additional plan tests initially exposed mistakes in the test expectations (scope revision was incorrectly expected to increment for unchanged selection, and `PlanSnapshot` was incorrectly assumed to contain a collection revision). Assertions now compare actual database revision rows and the unchanged membership scope. No production expectation was relaxed to hide a defect.

Scoped TypeScript checking used the compiler API with `tsconfig.base.json`, `types: ['node']`, and the three owned TypeScript files as roots: **0 diagnostics**. Prettier formatting/checks cover all four owned files. No broader build, installation, server, provider job or native test ran in this lane. Lead integration and independent review remain outside this focused evidence.
