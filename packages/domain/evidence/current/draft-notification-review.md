# Draft notification follow-on — independent review

28 September 2026. Bounded read-only review of the four-file additive draft event change. Only this report and the distinct adjacent probe were written. The preceding recovery gate implementation, report and freeze were not altered.

**Outcome: no concrete defect found in the reviewed Data event classification.** This conclusion covers the exercised desktop persistence paths; it does not accept Frontend consumption or native performance.

## Implemented behavior checked

- `packages/domain/src/services.ts:82` adds optional `conversationChange: { kind: 'draft_only'; header: Immutable<ConversationHeader> }`. It identifies the exact acknowledged save transaction and grants no new command or recovery authority.
- `apps/mobile/src/data/assistantTurnRepository.ts:212` supplies the header only after the serialized transaction returns successfully, its store revision changed, and its write kind is `draft`. The value is the transaction's already-owned, recursively frozen result. A failed transaction, unchanged draft, or other write kind cannot enter that classification path.
- `saveDraft` captures the caller's guard before awaiting, validates conversation/generation/semantic revision in the transaction, changes only the encoded composer draft and store revision, then returns the original semantic header with the new exact text. The event's outer revision equals the returned repository store revision. Header revision, generation and nextSequence remain unchanged for that draft commit.
- Deferred reconciliation at `assistantTurnRepository.ts:177` calls `notify(entry.revision)` without a header. Proof of a historical durable draft does not acquire a fresh draft-only classification.
- `apps/mobile/src/data/localStore.ts:127` creates a new owned event object and collections array and recursively freezes the optional payload before subscriber delivery. Its nested header can safely share the repository's already-owned frozen result; it is not an unfrozen caller object. A throwing/mutating subscriber cannot change the event seen by later subscribers.

The ordinary begin/accept/freeze/cancel/clear notification paths retain their existing broader semantics. Recovery certification remains separate from the new conversation classification.

## Checks actually run

The owner released the test lane before execution. Commands ran serially from `cookmate-app`.

1. `.\node_modules\.bin\tsx.cmd --test --test-concurrency=1 --test-name-pattern='acknowledged draft events|lost draft commit acknowledgement' packages/domain/test/localStore.test.ts`

   **2/2 passed**, reported test duration **1,467.1559 ms**. The nonempty-history test performs 20 changed drafts at each of 1 and 33 retained intents. Both cases measured **480 SQL executions (24 per changed draft)** and **zero historical JSON/text bodies**. Instrumentation includes connection reads/execs and prepared statement runs. It checks exact returned/event headers, matching store revisions, deep freezing, transcript/intent preservation, unchanged-draft and rejected-save omission, and omission on begin/reply/freeze/cancel/clear events. The second test confirms that a durable draft with lost COMMIT acknowledgement reconciles as a plain event, with no draft-only classification or recovery certificate.

2. `.\node_modules\.bin\tsx.cmd packages/domain/evidence/current/draft-notification-probe.ts`

   Exit **0**, approximately **0.91 seconds command wall time**. This independent probe uses the actual public factory and separately owned connections to isolated temporary file SQLite stores:

   - **Two concurrent drafts:** exactly two committed events, each matched by store revision to its own returned header; consecutive store revisions; semantic header fields unchanged. The first caller guard is mutated immediately after dispatch and the captured guard still succeeds. NUL, lone high/low surrogates, combining text, emoji and literal JSON characters are preserved exactly. Returned headers and event payloads reject attempted mutation. The durable final draft is the second queued value.
   - **Lost ACK plus delayed reader outage:** zero events while independent durable proof is unavailable. After reader recovery, a later successful intent read proves the draft and emits exactly one event without `conversationChange` or recovery certificate. A second read emits no duplicate; the stored draft remains durable.

3. Static review of the actual four-file implementation and supporting frozen-result/header semantics. Initial and final hashes of the four files match. Read-only hashes also confirm the preceding gate source, review report and frozen manifest remain unchanged.

The probe is [draft-notification-probe.ts](draft-notification-probe.ts). No production/test edits, full-suite repeat, typecheck, native/provider/server/build job, or additional worker was performed by this reviewer. The owner's separately reported 170-test full suite is not counted as independent execution.

## Race and acceptance boundaries

The payload describes its own acknowledged transaction. It is not a promise that no later transaction has committed before a consumer processes the event. Deferred events can carry older store revisions, so global delivery order must not be inferred.

Frontend remains responsible for its outer store-revision watermark, matching conversation/generation/semantic revision/nextSequence and recovery token, plus the local-edit guard before applying a draft header without transcript reload. Matching a checking recovery token preserves checking; this payload cannot manufacture complete recovery coverage or overwrite newer local editing safely on its own. This review did not inspect or accept the separately owned consumer changes.

The SQL/body counts demonstrate constant work only at the two exercised history sizes. They are not phone latency, heap, throughput or whole-UI performance measurements. No broad event redesign is proposed, and no unresolved concrete Data defect was found in this narrow follow-on.

## Checked SHA-256 values

Paths are relative to `cookmate-app`; final values were captured after the independent tests/probes.

| File | SHA-256 |
| --- | --- |
| `packages/domain/src/services.ts` | `45481fb25c05f9692c2ba0dad03fa88f047565c672218ea867fe41e430b28b1b` |
| `apps/mobile/src/data/assistantTurnRepository.ts` | `50085331a2176e1487ca5e17e9711dea33e31147597bf8e0cb55075c6eb731f5` |
| `apps/mobile/src/data/localStore.ts` | `614c62c7298aa1991020f99f940e9946d73b3378c4c61d6886730e55addf3312` |
| `packages/domain/test/localStore.test.ts` | `abe5ebac3ca45a4859b64dd14cec9954ec596f601a5630af53fe0daac3d735a5` |
| `packages/domain/evidence/current/draft-notification-probe.ts` | `da1895953d9c7f85cc1f5ec7568635dd8914b48af81099bb4a9a8c628a04fa2e` |
| `packages/domain/evidence/current/recovery-performance-review.md` | `5ee293b7dbdc79081cdc24c4858f1f5535bb2aa2eb8d9127c4a3449964ed3120` |
| `packages/domain/evidence/current/data-recovery-performance-amendment.json` | `b9baf700335b84197bffad8af566878cebf17a53f8f99f0e171463f8639c0fd3` |
| `apps/mobile/src/data/recoveryGate.ts` | `9d917a06315fd64fc0f664c9b44c9fcb2187e53bd512cb9e2ca14cd4f2ce65d2` |

