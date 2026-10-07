# Incremental recovery performance amendment

28 September 2026. **DATA GATE AMENDMENT FROZEN FOR INTEGRATION.** Independent review is complete; RPF-01 was repaired and independently closed. This record covers the Data lane's desktop implementation and verification, not native iPhone or full application acceptance. Preserve this checkpoint when adding the separately authorized draft-only conversation event.

## Result and contract

`refreshRecoveryGate` audits cold storage in bounded batches, then reuses its validated coverage and rechecks only dirty intent IDs. A ready result replaces the complete, unfiltered unresolved candidate snapshot. Omitted candidates provide no historical outcome proof. The existing per-ID `readActionRecovery` remains the historical proof API. Tokens and continuations are freshness identifiers, never execution authority.

The shared serialized writer captures each impact before queuing and invalidates relevant coverage before the mutation callback. Unknown impacts reset all coverage. `subscribeRecoveryInvalidation` is independent of ordinary committed change events. A matching `StoreChange.recovery` unchanged certificate preserves an existing ready state or checking continuation; it never creates cold completeness. Frontend owns admission, active-owner exclusion and hold behavior.

Cold discovery uses a primary-key cursor over pending intents, assistant contexts, acceptance envelopes, action plans, acceptance records and command slots. Genuine originless direct intents are classified separately; missing or orphan assistant evidence fails. Deliberately retained receipts are excluded from orphan discovery. Existing validation checks no-plan intents, source/reply identity and text, action plans, all reserved slots, command hashes and exact receipts. Insertions before the cursor stay dirty. Clear/unknown/external changes discard coverage.

Freshness checks run after `BEGIN IMMEDIATE`: `main.data_version`, `main.schema_version`, `total_changes()` and the validated conversation header. The initial boundary checks the canonical schema; its identity survives failed coverage. Cache changes remain staged until the acknowledged commit and final fences. Rollback, cleanup, unavailable fences or ambiguous acknowledgement discard coverage. A damaged connection cannot reuse its old proof.

## Measured work

These are real Node SQLite executions from the focused fixture. SQL includes `all`, `exec` and prepared `run`, including writer fences, transaction statements and measured mutations. Reader SQL was zero in these probes. Body counts measure returned JSON/text fields, including duplicate reads by existing validators; they are not JavaScript heap measurements. Setup is excluded.

| Scenario | Gate calls | SQL statements | Hashes | Returned historical JSON/text bodies | Transactions |
|---|---:|---:|---:|---:|---:|
| Cold, 32 settled one-slot plans | 1 | 691 | 32 | 928 | 1 |
| Cold, 100 settled one-slot plans | 4 | 2,173 | 100 | 2,900 | 4 |
| Unchanged, either history | 1 | 17 | 0 | 0 | 1 |
| Draft save plus refresh, either history | 1 | 41 | 0 | 0 | 2 |
| One declared failed-journal update plus refresh | 1 | 55 | 1 | 24 | 2 |

Cold body bytes were 616,022 and 2,024,580 respectively. The journal probes returned 19,352 / 19,408 bytes. Candidate array identity is reused on an unchanged warm check. The cache retains unresolved candidates, dirty IDs and coverage progress, without a settled-history proof map.

The per-call limits are 32 inspected IDs and a 2 MiB estimate of encoded retained evidence. Existing validators can read a body twice, so this is not a total decoded-byte/heap cap. Cold validation remains O(history); no claim is made that statement count alone proves phone latency, query occupancy or sublinear whole-store startup. All writer failures conservatively reset coverage, including a proven rollback.

The original controller baseline remains untouched at Desktop `implementation/reviews/quality/recovery-work`: 10 / 100 / 1,000 / 10,000 settled plans required 12 / 102 / 1,011 / 10,101 port calls on both cold and repeat scans. Those are controller-to-mock port counts, not this table's SQL counts. Frontend is collecting the corresponding new controller measurements separately. Its loaded-message reload behavior is outside this gate benchmark.

## Verification

- Final repaired serial catalogue/domain suite: **168 passed, 0 failed**, 24,235.816 ms, saved in `recovery-performance-suite-repaired.tap`. The earlier 167-test candidate run remains preserved in `recovery-performance-suite.tap`.
- Gate-focused suite: **11 passed**, 9,058.2456 ms, saved in `recovery-performance-focused.txt` with actual metric diagnostics.
- Writer observer-focused suite: **2 passed**, 283.1387 ms; both also ran in the full suite.
- Domain TypeScript, separate strict all-Data production TypeScript and the 15 amended-file Prettier check passed.
- Independent review: **14/14 repaired focused tests passed**, 8,200.0241 ms; four orphan probes, six-branch indexed query-plan analysis and actual factory/cleanup/lifecycle probes passed. `recovery-performance-review.md` SHA-256: `5ee293b7dbdc79081cdc24c4858f1f5535bb2aa2eb8d9127c4a3449964ed3120`. The lead read the complete report and actual probe/repair. No unresolved concrete finding remains in this bounded scope.

Regressions cover cold progress/draft certificates, insertion before cursor, partial receipt plus cancellation, clear during cold batching, no-plan corruption, missing context, external and same-handle raw writes, mutation between scheduling and `BEGIN`, changes at commit, unknown impacts, failed rollback work, lost acknowledgement, malformed read-only/draft behavior, first-use and post-failure schema changes, unavailable fences, oversized evidence and close. Writer regressions check caller-owned impact mutation, default unknown impact, statement cleanup before validation, scope closure and publication ordering. Independent finding RPF-01 exposed four orphan table types omitted by the initial two-table inventory. The repaired six-table discovery and four-case no-mutation regression are included in the final 168-test run and independently rechecked. All six cold discovery branches use covering indexed key ranges; retained receipt rows are intentionally excluded.

## Source provenance and remaining gates

`data-recovery-performance-amendment.json` records 85 source/test files: 70 unchanged and 15 changed/new against the original baseline plus historical correctness overlay. Four files are new. The original baseline manifest remains SHA-256 `cd54f2f1cd71e6e2b416ab0574ef8696539a08c03501dbe720f2c04416e19e74`; the prior correctness amendment remains `687beacd639110a3befa5335a4e3040e723f110624cdab4c2f1d1415c900dd5f`. Earlier reports and test outputs are preserved.

API2, LocalCommand2, database schema2 and receipt schema1 remain unchanged. Schema fingerprint: `af10dd470af0c2f68e02713d88dd2b21b655673dfedccde610e255a70c36d569`. Catalogue `cookmate-2026-09-27.v1`, fingerprint `1c564aed197f0ff13e0c8a81c95d775960f8c7f021cd3e948f116ae471b5e1ef`. No catalogue regeneration occurred. `assistantRecovery.ts` has only the separately authorized formatting cleanup.

Remaining: Frontend integration/hold/ownership verification and paired controller counts, Brain's stable-source Security recheck, the separately authorized draft-only event/consumer follow-on, and native iPhone persistence/concurrency/performance acceptance. No native, provider, server, install or heavy build job ran in this Data amendment.
