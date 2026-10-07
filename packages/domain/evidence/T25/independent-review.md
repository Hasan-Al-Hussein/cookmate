# T25 independent construction review

28 September 2026. The initial review identified three medium-priority findings. All three were repaired by the owner and independently rechecked below; none remains open within this bounded review. The original reproductions and hashes are retained for traceability. This is desktop evidence, not native iPhone acceptance.

## Scope and verification

Read-only review covered `schemaCompatibility.ts`, the new `reference_set` and `assistant_intent_context` DDL in `schema.ts`, `conversationRecords.ts`, `conversationRepository.ts`, `assistantIntentRecords.ts`, `assistantRecovery.ts`, `assistantTurnRepository.ts`, both targeted test files, and `conversation-construction.md`. Shared SQL/query/port definitions were read only as needed to interpret these paths. Production and test files were not edited.

From the code root:

```powershell
.\node_modules\.bin\tsx.cmd --test packages/domain/test/conversation.test.ts packages/domain/test/schemaCompatibility.test.ts
```

Observed **9 tests passed, 0 failed**. These cover ordered transcript/reference paging, current-generation reference isolation, begin/accept/failure persistence, response-insertion rollback and retry, startup recovery and corruption rejection, immutable result snapshots, and genesis compatibility/FK/size constraints. Node emitted its expected experimental SQLite warning.

Three additional probes used `node --import tsx --input-type=module -`, with JavaScript supplied through a literal PowerShell here-string. Each used a separate `desktopConnection()` in-memory database, the actual `initializeDatabase`, `SerializedWriter`/`SerializedReader`, catalogue and turn repository. Calls were sequential. Each database was closed in `finally`; no fixture file, server or dependency was created. Probe setup matched `conversation.test.ts`: initial conversation/preference revision 0, connection generation 1, date 2026-09-28 / Asia/Dubai / UTC+240, valid random UUIDs, and a request for “Find Alfredo”.

## T25-IR-01 — Reconciliation never delivers a lost turn notification

**Medium; repaired and independently rechecked.** In the initial snapshot, `assistantTurnRepository.ts:86–106` only emitted after `writer.transaction` resolved. There was no notification reconciliation when that transaction committed but its acknowledgement failed. A later exact begin retry returned the durable intent at lines 205–208 without advancing the store revision, so `changed` was false and no event was delivered. `readIntent` likewise gave the caller the durable value without notifying other subscribers. The same shared write boundary is used by accept, failure and draft writes; only begin was fault-injected in the initial independent probe.

Reproduction:

1. Create the normal fixture with `onCommitted: event => events.push(event)`. Supply a delegating writer so its underlying `SerializedWriter` can be replaced after the injected connection fault.
2. Wrap `connection.exec` to first execute the real SQL, then throw once when `sql === 'COMMIT'`. Call `beginTurn` with a valid request and expected conversation revision 0. This commits the complete request/message/intent, then loses the acknowledgement. The attempted rollback cannot undo that commit.
3. Restore `connection.exec`; call `readIntent`. Replace the failed writer queue with a fresh `SerializedWriter` over the same in-memory connection, modelling writer recovery without erasing durable state. Retry the identical begin input.

Observed:

```json
{"probe":"lost-commit-ack","first":"failed","firstError":{"code":"storage_failure","messageKey":"conversation.write_failed","retry":"reconcile"},"readIntent":"ready","retry":"ready","events":[],"messages":1,"storeRevision":1}
```

The durable write is atomic and the retry does not duplicate it, but existing conversation subscribers can remain stale. Reconcile notifications using verified durable entity state for the specific attempted write. Do not infer that a write succeeded from the global revision alone; do not announce it while its outcome is uncertain. Include begin, accept, failure and draft cases in the repair tests.

## T25-IR-02 — Failed lifecycle with awaiting phase hydrates as valid

**Medium; repaired and independently rechecked.** In the initial snapshot, `assistantIntentRecords.ts:190–199` checked that `failed` had an error response and null guards, but did not constrain its pending-intent phase. SQL also allowed this cross-column contradiction. `readIntent` therefore exposed a failed request as `awaiting_response`; the active-turn query at `assistantTurnRepository.ts:214–217` then prevented another turn. Retrying `recordTurnFailure` could not normalize this state because line 411 returned immediately for an already-failed lifecycle.

Reproduction:

1. Begin a normal request, then call `recordTurnFailure` with `network_unavailable`, `assistant.disconnected`, `after_reconnect`. Both operations return ready; semantic conversation revision is 2.
2. Read `pending_intent.intent_json`, change only its `phase` to `awaiting_response`, and update both the row `phase` and JSON to that value. Leave its valid persisted error response and `assistant_intent_context.lifecycle = 'failed'` untouched. This mutation satisfies the database constraints and the PendingIntent JSON schema.
3. Call `readIntent`, then begin a different valid request using expected conversation revision 2.

Observed:

```json
{"probe":"failed-lifecycle-awaiting-phase","read":"ready","publicPhase":"awaiting_response","responseKind":"error","newTurn":"failed","error":{"code":"already_pending","messageKey":"conversation.already_waiting","retry":"after_correction"},"lifecycle":"failed"}
```

This is a corruption-injection case, not a claim that ordinary writes create this combination. Hydration should reject contradictory lifecycle/phase/response combinations as storage failure. Preserve the legitimate distinctions: accepted response errors currently settle the intent, while transport failure recording cancels it. Cancelled recovery records must still allow the documented cancelled/reconciling states. A full valid-state matrix is preferable to rejecting one isolated combination.

## T25-IR-03 — Runtime authority can change after validation and before persistence

**Medium; repaired and independently rechecked.** In the initial snapshot, `assistantTurnRepository.ts:114–125` captured connection/date authority near the start of the callback. `acceptResponse` then awaited several SQL operations before inserting the assistant message and storing guards at lines 319–397; it did not recheck the runtime at callback completion. A connection-generation change during that interval was accepted and an obsolete guard baseline was persisted.

Reproduction:

1. Begin a valid request at connection generation 1.
2. Wrap `connection.prepare` so that, on the first subsequent SQL beginning `INSERT INTO message`, it increments the runtime connection generation to 2, then delegates to the original prepare. This changes authority after the existing check and before the assistant-message write.
3. Accept a valid proposal response with no reference sets, one `saveRecipe` proposal for 53064, and a fresh app-owned assistant message ID.

Observed:

```json
{"probe":"connection-change-before-response-insert","accepted":"ready","phase":"confirmation","storedConnectionGeneration":1,"currentConnectionGeneration":2,"messages":2}
```

Recheck the relevant runtime authority at the end of the transaction callback and reject/roll back if it changed during awaited work. An action still needs its separate current-state guard at dispatch. This probe established stale reply acceptance, not execution of any recipe/plan/preference action. Date-context changes have the same unchecked interval by inspection but were not separately injected.

## Repair recheck

The same bounded test command was rerun against the owner's stable repair: **13 passed, 0 failed** (11 conversation and 2 schema tests). The four added tests cover all four write kinds with lost acknowledgement plus reader outage, failed-lifecycle phase combinations, a rolled-back turn followed by an unrelated durable revision, and connection/day changes during both begin and accept. Those tests use real SQLite transactions with targeted hooks, not native iPhone storage.

The repaired notification code at `assistantTurnRepository.ts:87–184` retains proofs only after the transaction settles, checks durable request identity and response/guards or the actual draft value, and deletes a proven entry before notifying. Successful `readIntent` at lines 235–240 and writes attempt reconciliation. A global revision alone cannot establish the attempted turn. The lifecycle matrix at `assistantIntentRecords.ts:190–211` rejects the reproduced contradiction while preserving error-settled, failure-cancelled and recovery states. The callback completion check at `assistantTurnRepository.ts:169–170` revalidates connection/date authority after the awaited write and final store-revision read.

Four independent in-memory assertion probes also ran via the same stdin Node command mechanism used initially. These repeated the original fault cases and added a second reconciliation route:

```json
{"probe":"IR-01","reconcile":"exact-retry","events":[{"revision":1,"collections":["conversation"]}],"messages":1}
{"probe":"IR-01","reconcile":"concurrent-reads","events":[{"revision":1,"collections":["conversation"]}],"messages":1}
{"probe":"IR-02","result":"failed","code":"storage_failure","corruptRowPreserved":true}
{"probe":"IR-03","result":"failed","code":"stale_context","messages":1,"response":null,"events":[]}
```

For IR-01, a real COMMIT was followed by a thrown acknowledgement and an unavailable reader. Events stayed empty while uncertain. After writer/reader recovery, an exact begin retry without a preceding read delivered one revision-1 event; a separate fixture reconciled through two concurrent `readIntent` calls and also delivered exactly one event. A further exact retry in both fixtures did not add an event or message. Concurrent reads used the one serialized reader only after the writer settled; no simultaneous transactions were run on the shared in-memory connection.

For IR-02, the identical SQL-valid failed/error plus awaiting-response corruption now returns `failed/storage_failure`; the stored row remains available for diagnosis. For IR-03, changing the connection generation at the assistant-message INSERT now returns `failed/stale_context`, leaves only the original user message, retains a null stored response, and emits no notification. The added test also verifies day changes and the begin path. No production/test files were changed by this reviewer.

No remaining concrete defect was established in these three repaired paths. This closes the bounded findings, not the unfinished persistence port or native acceptance.

Repaired snapshot hashes (SHA-256):

| Path | SHA-256 |
| --- | --- |
| apps/mobile/src/data/assistantTurnRepository.ts | A1B635FB1B891DC5FAED32ECDB4EA7A77E31D410F4E6FE1D40B1E71A6D2B1542 |
| apps/mobile/src/data/assistantIntentRecords.ts | EB287787960E878F4A1CCFE50B7E4173CC1C71F0CB668FDA99550AB89FC7F112 |
| packages/domain/test/conversation.test.ts | 942D7DCFC18CF44600A5043AF794AE8040CA3D9CA89FF3075281E395C5D892CC |

The other seven files in the initial hash table remained identical at recheck. Preference, clear and quantity work added in disjoint files was explicitly excluded and was not inspected or tested.

## Review limits

No additional concrete defect was established in the bounded paging, startup-recovery or genesis-DDL checks. This is not exhaustive corruption or concurrency coverage. Unexpected schema objects, native driver behavior, resource-release/performance acceptance and real app rendering were not audited here. The fault hook deliberately simulates a lost native commit acknowledgement; replacing its invalid writer queue is a desktop test technique, not a claim that a production recovery factory exists.

Full readContext/current-state/freeze/execute-slot/cancel/clear/factory implementation and request-context provenance comparisons were explicitly outside this slice. Their absence is not included among these findings. Commands/favourites and the earlier schema/connection review were not re-audited.

## Initial reviewed source hashes

SHA-256 captured before the owner began repairing these findings. Paths are relative to the code root; the full `schema.ts` hash identifies the file snapshot, although only the two assigned DDL additions were reviewed.

| Path | SHA-256 |
| --- | --- |
| apps/mobile/src/data/schemaCompatibility.ts | D824F59CF6F432F7B10F71737069A5BB7187D7BC6B34ACA5130B231D7062B390 |
| apps/mobile/src/data/schema.ts | 8B72C81E5722ADCB46D9788CA23B721F358E13D9ECD5D90DDAD275841359508D |
| apps/mobile/src/data/conversationRecords.ts | AB2AF7D454DAC229B87DDB0CBFFC01B631AF1A8871A2CCAC62DF332AECA6F448 |
| apps/mobile/src/data/conversationRepository.ts | 59E82284BD21A285B3450B33CA48F01BFA0336886A199CC766F7EA7731A8F4B1 |
| apps/mobile/src/data/assistantIntentRecords.ts | 4AA44530EE1659F0912E629BF87B6B194E58C8EF71FF9B50221C5BC864D35B09 |
| apps/mobile/src/data/assistantRecovery.ts | F9650CDCD461F6E2F007DD4B595459EDD30596726DAEBB1F1BFD5545ECCC4B94 |
| apps/mobile/src/data/assistantTurnRepository.ts | 2F91D9A837C810DB77BB42AC1614D3CC0249827B428336B42AD17E54684297C9 |
| packages/domain/test/schemaCompatibility.test.ts | 49E7E2B5364ADE274E995DA968C4517A3261E107D9161F3AA4C785D5F7C2FC31 |
| packages/domain/test/conversation.test.ts | 3F286E54EA229DCEEBD3E64E0B2533267F79C324A7B2589D6AE74394F02C6AF6 |
| packages/domain/evidence/T25/conversation-construction.md | A3EBC78EAC55FC6873ECB7400157B81F4A3631A1E7BCB31C46AD616E4A04E86D |
