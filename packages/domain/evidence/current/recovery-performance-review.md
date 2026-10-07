# Incremental recovery performance — independent review

Date: 28 September 2026. Scope: the stable Data incremental recovery amendment and its owner repair. Reviewer owned only this report and the adjacent isolated probe; no production/test edits, recursive workers, native/provider/server/build jobs, or changes to earlier correctness reports.

**Result: one concrete finding (RPF-01) was reproduced, repaired by the owner, and independently closed. No further concrete defect was found in the bounded reviewed paths.** This is desktop persistence evidence, not native performance or full UI acceptance.

## RPF-01 — orphan recovery evidence omitted by cold discovery — closed

Severity: medium; a fail-closed corruption/coverage defect. Initial location: `apps/mobile/src/data/recoveryGate.ts`, the cold discovery CTE (now lines 309–318). Initial gate SHA-256: `a9fa29df6bd72971fd52c22e684576d131cd64d4b10af959f6b86fd44aea6c45`.

The initial CTE discovered only `pending_intent` and `assistant_intent_context` IDs. An assistant envelope, action plan, acceptance record, or command slot with no row in either discovery table was invisible. The freshness fences detected the SQL change and discarded old coverage correctly; nevertheless, the replacement cold audit returned complete readiness without detecting the orphan.

Independent reproduction used a fresh file SQLite fixture for each of four tables:

1. Create one real accepted, frozen, unexecuted action through the actual repositories. Complete the initial gate audit; it contains one unresolved candidate.
2. Temporarily disable foreign keys solely in the isolated corruption fixture. Insert a row under a new UUID into one of `assistant_acceptance_envelope`, `assistant_action_plan`, `assistant_acceptance`, or `command_slot`, copying valid structured contents where applicable. Restore foreign keys.
3. Confirm one actual `PRAGMA foreign_key_check` violation for the new row and call the gate again.

All four initial probes returned outer `ready`, gate `ready`, a changed token, and only the original candidate. Each used 37 SQL statements and one hash; the corrupt row was omitted. This demonstrates incomplete corruption detection, not an execution-authority bypass, data loss, or a supported way to create an orphan through public APIs.

The owner added indexed cold UNION branches for all four affected table IDs. Deliberately retained `operation_receipt` rows remain excluded. The unchanged inspection path now receives the orphan ID and rejects its missing owner rather than interpreting it as a no-plan result.

Recheck: all four independent cases now return `failed`, leave no unchanged certificate, and preserve the orphan for diagnosis. The new permanent four-case regression additionally verifies that the failed read does not change `total_changes()`. RPF-01 is closed against gate SHA-256 `9d917a06315fd64fc0f664c9b44c9fcb2187e53bd512cb9e2ca14cd4f2ce65d2`.

## Checks actually executed

All commands ran serially from the code root after the owner released the test lane.

- `.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 packages/domain/test/recoveryGate.test.ts packages/domain/test/writerObserver.test.ts`: initial **13/13 passed**, reported test duration **9,421.641 ms**. Repeated after the repair: **14/14 passed**, **8,200.0241 ms**.
- `.\node_modules\.bin\tsx.cmd packages/domain/evidence/current/recovery-performance-probe.ts`: initial orphan/EXPLAIN reproduction, then the repaired probe with assertions and additional cleanup/factory checks. Final exit code **0**, approximately **1.15 s command wall time**.
- Read-only SHA-256 capture of the reviewed sources, tests/helper and probe. The other seven initially hashed primary production files remained byte-identical during the gate repair.
- Read-only inspection of the adopted proposal, writer transaction observer, all declared mutation-impact wrappers, shared inventory/proof validators, public ports and factory notification/close integration. No independent full-suite, TypeScript or native run was made in this review. The owner's separately reported 168-case suite is not counted as reviewer execution.

The retained probe is [recovery-performance-probe.ts](recovery-performance-probe.ts). Its final version asserts repaired failure behavior; the four pre-repair outcomes above preserve the original observed defect.

## Measured work and query plan

The focused tests use real desktop SQLite connections and real repositories. Instrumentation counts `all`, `exec`, and prepared statement **run** calls on both connections; hashes and materialized JSON/text fields are counted separately. Preparing/finalizing a statement is not counted as a second SQL execution.

| Scenario | 32 settled plans | 100 settled plans |
| --- | ---: | ---: |
| Cold gate calls / writer transactions | 1 / 1 | 4 / 4 |
| Cold SQL statements | 691 | 2,173 |
| Cold hashes | 32 | 100 |
| Cold JSON/text field reads | 928 | 2,900 |
| Cold decoded field bytes, including repeated reads | 616,022 | 2,024,580 |
| Warm gate calls / SQL / hashes / bodies | 1 / 17 / 0 / 0 | 1 / 17 / 0 / 0 |
| Draft write + explicit refresh: transactions / SQL / hashes / bodies | 2 / 41 / 0 / 0 | 2 / 41 / 0 / 0 |
| One journal mutation + refresh: transactions / SQL / hashes / bodies | 2 / 55 / 1 / 24 | 2 / 55 / 1 / 24 |

The repaired runs reproduced those counts. A warm call reuses the same immutable candidate array instead of walking/cloning historical proofs. Cold processing still uses existing duplicate validators; its SQL/body work remains O(history), and those costs are explicit.

The probe extracts the actual production cold CTE and inventory expression for `EXPLAIN QUERY PLAN`. Both initial branches and all six repaired branches use **covering index range searches `user_intent_id>?`**, merged as UNION. The command-slot branch uses its existing `(user_intent_id, position)` index. There was no temporary sort/b-tree in either query plan. `SCAN k` scans the bounded CTE output; correlated slot subqueries use indexed per-intent searches capped at nine. This verifies the keyset access plan on the exercised desktop SQLite engine rather than inferring it from statement counts.

The 32-ID and **2 MiB estimated encoded-evidence** limits are enforced before JSON bodies are returned for inspection; a single oversized receipt test failed before any body/hash work. The byte estimate is not a JavaScript heap limit or a cap on total decoded bytes: shared validators read some bodies repeatedly. SQL expression evaluation, scalar metadata, allocations and unmeasured native driver costs are not represented by that estimate. No 1,000/10,000-history run or phone latency/heap/transaction-occupancy measurement was performed here.

## Correctness boundaries checked

- **Coverage and exact proof:** cold inspection invokes the shared source/reply identity, role, generation and exact decoded-text validation, then the existing action-plan/frozen-command/journal/receipt validation. No-plan records remain covered. Missing contexts, missing finalized plans and deleted receipts fail. Partial receipt progress remains unresolved until durable cancellation/reconciliation proves the reserved remainder unexecuted. Candidate omission does not become historical receipt/no-effect evidence or new command authority.
- **Incremental changes:** impacts are copied before queueing. Missing/unknown declarations invalidate all coverage before the callback. Known IDs become dirty, including insertions before the cold cursor. Checking results retain the hold; draft certificates preserve the same checking token without manufacturing completion. A clear replaces generation coverage rather than accepting missing rows individually.
- **Fences and publication:** the observer begins after `BEGIN IMMEDIATE`; data/schema/total-change/header checks precede work. Final transaction checks precede COMMIT, and post-ACK fences precede cache publication/queue release. Tests exercise external writes before BEGIN and after COMMIT, unexpected same-handle updates/deletions, unavailable fences, schema changes, rollback, and lost COMMIT acknowledgement. Failed/uncertain settlement clears reusable coverage rather than publishing staged patches.
- **Cleanup:** the independent probe injects `SqlCleanupFault` after actual statement finalization during a draft mutation. The draft rolls back, the gate emits unknown invalidation, its certificate disappears, and the damaged writer rejects the next refresh. This supplements the permanent escaped-session/finalization and lost-ACK observer tests.
- **Actual factory events/lifecycle:** an independent public-facade probe reopens a file containing a real no-plan accepted turn. A changed draft produces exactly one deeply frozen committed event with the matching unchanged recovery token and no recovery invalidation. Explicit refresh preserves that token. Starting refresh and immediately closing lets the tracked refresh finish, then emits unknown gate invalidation; later calls fail. Repeated close does not emit another invalidation. Startup owns separate query-only reader/writer handles, and the gate is installed after initialization/recovery.

The `none` classification was checked at the direct-recovery acknowledgement call site: it validates the entry and deletes only a notice, without changing assistant proof evidence. Context/global writers conservatively retain the all-unknown default. No production raw connection is exposed through the facade.

## Limits

This review covers the named Data amendment, not Frontend ownership/hold behavior, historical display narration, the separate proposed draft-only transcript reload change, provider behavior, native iPhone execution, arbitrary out-of-band file tampering, or broad performance acceptance. Tokens remain snapshots; an external write after the last fence needs the next fresh writer boundary. Historical acceptance ACK validation remains the existing separate acceptance-reader contract; the gate's cold scope is current stored intent/source/reply/envelope and exact action recovery, not a new audit of every historical ACK body.

No unresolved concrete finding remains in this bounded reviewed scope. Earlier correctness reports and baseline manifests were not changed.

## Checked SHA-256 values

Paths are relative to `cookmate-app`. Final source values were captured after the repaired independent checks.

| File | SHA-256 |
| --- | --- |
| `apps/mobile/src/data/recoveryGate.ts` | `9d917a06315fd64fc0f664c9b44c9fcb2187e53bd512cb9e2ca14cd4f2ce65d2` |
| `apps/mobile/src/data/sql.ts` | `f301a04c8592c5b961c4c3ce68a5fe4e152a1f007909677a5f94a663038c3c55` |
| `apps/mobile/src/data/localStore.ts` | `8b63190debb37518785a3b17b63e098801d98f91e07fe31d7c7e924759217e16` |
| `apps/mobile/src/data/assistantActionRepository.ts` | `5abf66a981abc8b7f11832fe6d2807c5f793c92c27f41ef8b5d32ae9784d821a` |
| `apps/mobile/src/data/assistantTurnRepository.ts` | `5a2a4ca4e551e791c79b6b92c253d559a82117b28fddbb0af836e85bc2894375` |
| `apps/mobile/src/data/commandExecutor.ts` | `fec339a10bba8dd2350e6aaef6b7649176dd78349223e935f3e18cf7e4f38d68` |
| `apps/mobile/src/data/conversationRepository.ts` | `b33c0aad1aacf8995400d300f5e409a72eb8e9f5c22039c0d7af5d6d4b3633ab` |
| `apps/mobile/src/data/directRecoveryRepository.ts` | `5f356ffc5977be9138a3fd665ff7346fd9a675c1e57318f9791ed5806a4a3ff8` |
| `packages/domain/src/conversationPorts.ts` | `a9031b48957bdc1344494f310de79740f3f2e0bb6c78a8ecb1979d97ad38e0d1` |
| `packages/domain/src/services.ts` | `3e66651806edd5ec99fb77d79ba5b96f1f8cde53104aa4ad479f9261097b7a94` |
| `packages/domain/src/index.ts` | `003848f416c3eafe120e8fe2a378b34d55b767109ac1d4cdcee91a4f6288326f` |
| `packages/domain/test/recoveryGate.test.ts` | `d6c63b2443f6059dbba04f08d45625fb64e41d671c79e7cdc23028e4891a7f79` |
| `packages/domain/test/writerObserver.test.ts` | `d58dde09b1c6f070baed8122c09aa740bd766abf4068887524668aee2df66cd0` |
| `packages/domain/test/helpers/recoveryGate.ts` | `4e9f28bd1f2d9d9d6f5bdcf988ba18b75198536ba7e9b70fd6c9172e2a0133ff` |
| `packages/domain/evidence/current/recovery-performance-probe.ts` | `98d790c74128e0b9ea5462045ea401b872d86d5948ba0a8791b6a53c269c3e6e` |

