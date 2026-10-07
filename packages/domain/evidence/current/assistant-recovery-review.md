# Independent assistant recovery amendment review

28 September 2026. **No concrete defect found in the bounded amendment.** Independent source inspection, 33 focused tests and the additional eight-slot/corruption probe below support the implemented Data proof contract. This is not acceptance of the consuming UI hold, native process recovery or provider behavior.

## Scope and contract

Read the actual amendment `ASSISTANT_RECOVERY_AMENDMENT_2026-09-28.md`, the three changed Data modules, public conversation port/export changes and both changed test files. Consulted the existing action-plan record validator, command fingerprint path and repository snapshot helper only as direct dependencies. No implementation, existing tests, AI/Frontend files or baseline manifest were changed. This report is the only file written for this review; the additional probe was compiled/executed in memory.

The amendment document received a coordination/evidence update during review. Its current text was reread; the proof/consumer boundary remained the same and the added missing-plan explanation matches the inspected code. The seven production/test file hashes below were unchanged between the initial read and final verification.

## Evidence-based conclusions

- **Writer settlement and pre-enqueue work:** `assistantActionRepository.ts:534` calls the common read wrapper with `options.writer`, so a queued proof cannot pass a live writer transaction. The wrapper reads the store revision in the same transaction and freezes the returned proof. The held-writer test waits until an actual receipt insertion is paused, verifies the proof has not completed, releases the transaction and observes the exact committed receipt. The separate pre-enqueue hash test proves why the phase rule matters: while execution is still hashing, missing receipt plus `ready` remains `unresolved`; after durable cancellation it is `not_executed`, and the delayed command is rejected without a receipt/effect.
- **Complete validated authority record:** `readIntent` at `:146` revalidates the complete stored plan/cursor/journal through the common intent reader and recomputes every finalized command fingerprint at `:158`. The existing action-plan validator checks reserved slot/operation identities, contiguous finalized prefix, actual receipts, matching receipt journal and absence of receipts for unfinalized future slots. Recovery iterates the reserved plan, not only finalized commands, and checks matching receipts again before returning them.
- **Failure versus no plan:** unknown ID returns `stale_context`, malformed ID returns `invalid_input`, and corrupt/unavailable storage fails with `storage_failure`. A valid retained proposal before plan freeze returns successful `null`. The new common invariant at `assistantIntentRecords.ts:161` rejects finalized commands with a missing plan; both inventory and proof fail instead of yielding a skippable no-plan result. Deleted intent after clear also fails.
- **No fresh authority or mutation:** receipt absence is classified as `not_executed` only for persisted `cancelled`/`reconciling` phase. Active `ready`/`dispatched` absence stays `unresolved`. Settled/prefix receipts remain validated against the frozen records. Recovery remains readable after date/connection changes, and performs no dispatch, ID allocation, phase/cursor update, revision increment or notification. The tests and independent probe compare snapshots, `total_changes()`, events and dispatch count.
- **Discovery and revision semantics:** `conversationRepository.ts:103` derives `hasActionPlan` from the validated stored intent. The actual factory regression creates 32 accepted turns: an older cancelled plan falls outside the newest 30, is found on the earlier page, and is classified correctly. A no-op assistant receipt changes the outer page/proof `RepositoryResult.revision` while the semantic `header.revision` stays unchanged. Clear changes generation, empties discovery, invalidates old proof IDs and preserves the historical operation receipt.
- **Consumer boundary:** bounded full-page scans, proof/page/final-sentinel store-revision and conversation-identity comparisons, rescan on candidate-null, and exclusion of genuinely active owned operations belong to the consuming AI/Frontend workflow. The Data amendment exposes the required values; this review does not assert that consumers implement the scan or hold correctly. A successful historical proof never authorizes another dispatch.

## Checks actually run

From the code root:

```powershell
node --import tsx --test --test-concurrency=1 packages/domain/test/assistantActions.test.ts packages/domain/test/localStore.test.ts
```

Observed **33 passed, 0 failed, 0 skipped**, duration **4032.7848 ms**: 20 action tests and 13 factory tests, including the seven new regressions. This is the reviewer's run, separate from the worker's reported run. Node emitted the expected experimental SQLite warning. No reviewer broad suite, build, server, provider or native job ran.

An additional bounded fixture used the real test setup, accepted eight distinct `saveRecipe` proposals, froze all eight reservations, finalized/executed slot 0, finalized but did not execute slot 1, then cancelled the remaining authority. The proof retained all eight exact reserved slot IDs and operation IDs in order: one actual receipt plus seven proven absent effects, including all six unfinalized future reservations. The proof and nested receipt effects were frozen; snapshots, revisions, SQL change count, notifications and dispatch count did not change.

Three separate fixture corruptions were then tested: a committed receipt assigned to the wrong intent, a receipt inserted for an unfinalized future reservation, and deletion of the committed prefix receipt. Each proof failed with `storage_failure` and made no changes.

Actual output:

```json
{"probe":"wrong-receipt-intent","error":"storage_failure","readOnly":true}
{"probe":"unexpected-future-reservation-receipt","error":"storage_failure","readOnly":true}
{"probe":"missing-prefix-receipt","error":"storage_failure","readOnly":true}
{"probe":"eight-slot-recovery","slots":8,"finalized":2,"committed":1,"futureUnfinalized":6,"phase":"reconciling","outcomes":["receipt","not_executed","not_executed","not_executed","not_executed","not_executed","not_executed","not_executed"],"frozen":true,"unchangedRowsRevisionsEvents":true,"dispatched":1}
```

The fixture declarations were selected from the actual action test module through TypeScript's AST, excluding test registration expressions, transpiled to an in-memory CommonJS module and invoked through `node --import tsx --input-type=commonjs -`. No source or probe module was saved. Its randomly allocated `cookmate-commands-` temporary SQLite directory was closed and removed by the existing guarded helper. The lead was notified after execution finished, before its full serial regression began.

## Source hashes and preserved baseline

Final SHA-256 values for the seven amended implementation/test files and the two directly inspected support modules:

| Path | SHA-256 |
| --- | --- |
| apps/mobile/src/data/assistantActionRepository.ts | D4F00E808D74F3E178970C4D41E0A4C8C1D20D2698564609E4EB26929846794F |
| apps/mobile/src/data/assistantIntentRecords.ts | EC942CB09FBB0CF52732453801F03BD92BFB8AFCBF0F8F1FE3ECC53E99F357FA |
| apps/mobile/src/data/conversationRepository.ts | 70A3CE0EC952B37DCC35C6B5B7E1B47750D4081F93A5D87F75FE53123499B99B |
| packages/domain/src/conversationPorts.ts | 83207EF36BD3D5A9D058ABBD16CEC2EA4F3EE9A5F75DD4D958CC30799651C7F6 |
| packages/domain/src/index.ts | 4DBB9CF7A130D75F5066CC1A28D25513C67560440BB8EECDCE01593FEFE8BCF6 |
| packages/domain/test/assistantActions.test.ts | EB9F7F7EB3105AF4A8BC9D3237D5EBBA25B1E153207CCDE38906B3D229743805 |
| packages/domain/test/localStore.test.ts | A9280866EF05068281725AC28D90B7EDDC552E6BB1F2E823FB71D42940A02444 |
| apps/mobile/src/data/actionPlanRecords.ts | 3E8E991F3B1E4B18FD771F61212B099EA98622BF61352C66315A4DFD173B23D5 |
| apps/mobile/src/data/query.ts | 87A838FC61820F1A6F333483EF1C21BCE6843A44663504AB9A5BEC07DD3081DC |

The reread amendment document hash was `F36DC8A0C2F802AF1CF1C74F299092D3F8ED7C09F16903B19412C6F78B1E3A4B`; it may subsequently receive the lead's final evidence/status update. The historical 81-file manifest itself was independently rehashed and remains `CD54F2F1CD71E6E2B416AB0574EF8696539A08C03501DBE720F2C04416E19E74`. It was not rewritten. This review did not independently repeat the lead's full 81-entry comparison.

## Limits

These checks use desktop Node SQLite and deterministic injected pauses/faults. They do not establish native iPhone crash/termination semantics, operating-system scheduling behavior, integrated UI ownership/hold behavior, provider semantics, performance or final application acceptance. The owner retains responsibility for the broader regression because the missing-plan invariant is shared by other assistant-intent readers. No such owner-run result is counted as independent evidence here.

