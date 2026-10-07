# Exact draft-only conversation notifications

28 September 2026. **DATA DRAFT NOTIFICATION FOLLOW-ON FROZEN FOR INTEGRATION.** Independent review found no concrete defect. This narrow follow-on was authorized by Brain after the incremental recovery gate freeze; earlier gate source manifests and reports remain historical evidence.

`StoreChange.conversationChange` optionally carries `{ kind: 'draft_only', header: Immutable<ConversationHeader> }`. Only an acknowledged, changed `saveDraft` transaction emits it. The header is the exact saved result and the outer `revision` is the persisted store revision. The factory deep-clones/freezes the event. No new port, schema, command authority or dependency was added.

The semantic header revision and next sequence do not advance for typing; the store revision does. Consumers must guard against older/duplicate events and older in-flight reads, match the loaded conversation ID/generation/semantic revision/next sequence, require their matching recovery certificate, and preserve newer local edits. Persisted store revisions advance monotonically, but deferred historical notifications can arrive later with older revisions. Frontend owns these consumer conditions and falls back to its ordinary refresh when they do not hold.

The existing recovery unchanged certificate retains its separate meaning. An unchanged draft emits no event. Rejected saves cannot emit a draft tag. Deferred or lost-acknowledgement proof notifications omit the classification, as do begin, reply, action freeze/journal/cancellation, clear and every other mutation. The exception optimizes one known transaction, not all conversation events or all recovery-unchanged events.

## Actual checks

- Final serial catalogue/domain suite: **170/170 passed**, 28,658.2629 ms, `draft-notification-suite.tap`.
- Focused local store/conversation/memory/recovery suite: **50/50 passed**, 14,947.9282 ms, `draft-notification-focused.tap`.
- Domain TypeScript, strict all-Data production TypeScript and four-file Prettier check passed. A test-only initial TypeScript error used command-only clear guard fields on the direct review input; those extra fixture fields were removed before test execution.
- Independent follow-on review: **2/2 focused tests passed**, 1,467.1559 ms; isolated concurrent-draft and delayed-reader/lost-ACK probes passed. The lead read the complete report and probe. Report `draft-notification-review.md` SHA-256: `35d38eeccfd8b7e653d9516f148a6228d9c8f335b49a005f01cbe822b8278565`. No concrete defect remains in the bounded Data scope; this is separate evidence from the frozen gate review.

Actual public-factory tests saved 20 distinct drafts against both **1 and 33 retained assistant intents**. Both scenarios executed **480 SQL statements total (24 per draft)** and returned **zero historical JSON/text bodies**. Instrumentation counts all reads, execs and prepared runs on both connections; setup/explicit test inspection is excluded. Event publication added no SQL. These counts cover persistence/event work; Frontend measures the reduction in transcript/intent reload calls separately.

The tests compare complete retained message/intent rows before and after typing, check exact saved header/store revision/recovery token, attempt subscriber mutation, verify nested freeze, and exercise no-op/rejected saves. Subsequent begin/reply/freeze/cancel/clear events omit the draft tag. A COMMIT acknowledged by SQLite but not the caller produces a plain reconciled event, without either the draft-only tag or an unchanged recovery certificate.

## Scope and provenance

Only `packages/domain/src/services.ts`, `apps/mobile/src/data/assistantTurnRepository.ts`, `apps/mobile/src/data/localStore.ts` and `packages/domain/test/localStore.test.ts` changed from the gate freeze. Gate validation, SQL observer, schema, catalogue, API2, LocalCommand2 and receipt schema1 remain unchanged. The separate `data-draft-notification-amendment.json` overlay records before/after hashes against gate manifest SHA-256 `b9baf700335b84197bffad8af566878cebf17a53f8f99f0e171463f8639c0fd3`.

Frontend reports its runtime **46/46** tests passing and a 20-event synthetic-port measurement at 30/120 loaded intents: prior 40 conversation-page reads, 20 intent-page reads and 600/2,400 intent body reads become zero, with no extra gate scans or holds. Those are Frontend-reported controller counts, separately reviewed there; Data did not independently rerun that harness. Its actual factory/runtime integration and reviewer finalization remain owned by Frontend.

Remaining: Frontend final consumer acceptance, Brain integration/Security recheck, and native iPhone acceptance. No provider, native, server, install or heavy build ran in this follow-on.
