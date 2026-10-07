# Assistant recovery proof amendment — 28 September 2026

Status: **Data amendment frozen for integration.** The final 154-test regression and independent review passed. This is an additive amendment to the historical 81-file Data checkpoint, not a replacement for it. Brain authorized the narrow repair for the app-wide write hold. No schema, catalogue, shared wire contract, operation identity or dispatch behavior changes.

## Problem and proof

Phase alone cannot classify recovery. A first action can still be `ready` while its reader/hash work is pending before writer enqueue. After startup cancellation, a finalized but never executed slot can be `cancelled` with no receipt. Treating every missing receipt as uncertain creates a permanent false hold; treating a writer barrier alone as proof can overlook pre-enqueue work.

`AssistantPersistencePort.readActionRecovery(userIntentId)` now returns `RepositoryResult<Immutable<AssistantActionRecovery> | null>` through the existing factory. It reads on the existing serialized writer, validates the entire persisted action plan/cursor/journal, recomputes finalized command fingerprints, and validates actual receipts. It does not dispatch, mutate lifecycle, allocate IDs or renew authority.

The proof contains current `conversationId`, `conversationGeneration`, `userIntentId`, `intentRevision`, `phase`, and every reserved plan slot in order. Each slot contains `slotId`, `operationId`, `outcome`, and nullable `receipt`:

- Matching durable receipt: `receipt`.
- Absent receipt with durable `cancelled` or `reconciling` authority: `not_executed`. Delayed execution must fail its existing in-transaction phase check.
- Absent receipt with active `ready` or `dispatched` authority: `unresolved`.
- Unknown/deleted intent, inconsistent plan/journal/receipt/fingerprint, or unavailable storage: typed failure. A retained intent with no reserved action plan returns successful `null`.

Settled action plans require actual receipts for every slot. Future reserved slots without a finalized command are included and classified by the same durable authority rule. Historical proofs remain readable after runtime date/connection changes and do not authorize new execution. Common stored-intent validation also rejects finalized commands whose retained action-plan row is missing, preventing both successful no-plan proof and false-negative inventory discovery after that corruption.

## Consumer contract

`readIntentPage` summaries add `hasActionPlan`. Discovery must traverse all pages, including older cancelled plans, with no newest-page shortcut. Both page and proof `RepositoryResult.revision` values are the existing store metadata revision. `header.revision` remains the semantic context revision and cannot detect journal-only drift.

Compare store revision and conversation identity/generation across every page, every proof, and a final `readIntentPage({ limit: 1 })` sentinel. Drift requires a bounded restart or explicit retry with the hold retained; do not loop indefinitely. Null for a candidate previously reporting a plan also requires rescan. Conversation commits invalidate discovery. Clear changes generation and deletes the old retained intent, so an old proof read must fail.

Frontend owns the shared construction hold and currently active operation ownership. Exclude only genuinely active owned work from restored recovery: a prepared plan legitimately awaits its first dispatch. An ongoing approve-through-dispatch operation must not block itself. Abandoned or uncertain work stays discoverable, new unrelated writes remain held on loading/error/unresolved proof, and read-only reconciliation remains available. AI owns mapping proven no-effect to its existing cancelled/not-dispatched outcome and retaining exact receipt matching. Data does not introduce another global state machine.

## Evidence and limits

Domain strict TypeScript and separate all-Data production TypeScript passed. The test worker ran `node --import tsx --test --test-concurrency=1 packages/domain/test/assistantActions.test.ts packages/domain/test/localStore.test.ts`: 33 passed, 0 failed, 4750.548 ms. Its two-file TypeScript check had 0 diagnostics and Prettier passed. Seven new regressions cover active prepare-to-dispatch, read-only results, finalized/unfinalized reopen cancellation, partial and lost-ACK receipts, a held writer, pre-enqueue hashing followed by durable cancellation, corrupt/unknown/unavailable records, 32 real accepted turns with older cancelled-plan discovery, journal-only store revision drift, and clear generation invalidation. The lead inspected the actual tests.

Final lead regression: `node --import tsx --test --test-concurrency=1 --test-reporter=tap packages/domain/test/*.test.ts packages/catalogue/test/*.test.ts` passed **154/154**, 0 failed, in **20280.5771 ms**. Raw TAP is `assistant-recovery-suite.tap`. Domain TypeScript, separate all-Data production TypeScript and seven-file Prettier checks passed again after all edits. Exact commands, TAP hash and before/after hashes for all seven source/test files are in `data-assistant-recovery-amendment.json`.

Independent review is complete in `assistant-recovery-review.md`: no concrete defect found in this bounded amendment. The reviewer independently ran **33/33** focused tests in **4032.7848 ms** and an additional real SQLite eight-slot probe. One committed receipt, one finalized but unexecuted command and six future reservations preserved exact identities and order; after cancellation the remaining seven effects were proven absent without writes/events/dispatch. Wrong receipt intent, unexpected receipt on an unfinalized future reservation, and missing prefix receipt each failed without mutation. The lead read the full report. Source hashes remained stable during review.

Rehash against the historical 81-file manifest found exactly seven changed files: the action repository, common assistant intent records, conversation repository, public conversation ports/exports, and two corresponding test files. The other 74 files match the historical baseline.

Amendment manifest SHA-256: `687beacd639110a3befa5335a4e3040e723f110624cdab4c2f1d1415c900dd5f`. Its seven file entries were rehashed with zero mismatches after review. AI and Frontend own their corresponding consumer changes; their checks are not counted as Data acceptance here. Brain's separate Security review and native/integrated UI gates remain open.

The historical checkpoint, `data-source-freeze.json` (SHA-256 `cd54f2f1cd71e6e2b416ab0574ef8696539a08c03501dbe720f2c04416e19e74`), remains intact. Catalogue fingerprint remains `1c564aed197f0ff13e0c8a81c95d775960f8c7f021cd3e948f116ae471b5e1ef`. Native iPhone SQLite/process termination, integrated UI ownership/hold behavior, provider semantics and final acceptance remain separate gates.
