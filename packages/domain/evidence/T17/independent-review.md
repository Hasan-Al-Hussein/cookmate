# Independent command-construction review

28 September 2026. Read-only review by the source/photo specialist, reassigned to the bounded T17 command lane. Used the code-quality skill. Reviewed only `commandExecutor.ts`, `favouriteCommands.ts`, `prepareCommand.ts`, `receipts.ts`, `commands.test.ts`, and `command-construction.md`. Imported existing fixture/runtime helpers for a small desktop probe; did not audit their implementations or duplicate Brain's schema/connection/read-repository review.

**Result:** one concrete notification defect was reproduced, repaired by the lead, and independently rechecked. No remaining concrete defect was identified in the reviewed implemented command/favourite path. This is bounded desktop evidence, not full T17 or native acceptance.

## T17-IR-01 — recovered durable command could remain unannounced

**Initial severity:** medium. **Status:** repaired and rechecked for exact-command retries within the same executor lifetime.

Before repair, `commandExecutor.ts:244` returned `{ receipt: existing, change: null }` for any existing receipt. The only retained notification data, `attemptedChange`, belonged to the earlier `execute()` call. When COMMIT completed but its acknowledgement was lost, and the independent receipt reader was temporarily unavailable, that call correctly returned `uncertain`. A later exact retry found the durable receipt but had no change notification to emit. The favourite and revisions were already committed; subscribers relying on `onCommitted` could remain stale until another refresh/change.

The independent desktop fixture injected the same two failures as the existing uncertainty fixture: the writer performed `COMMIT` and then threw; the independent reader threw until explicitly restored. The observed output before repair was:

```json
{"probe":"lost_ack_then_same_command_retry","firstKind":"uncertain","retryKind":"receipt","durableFavourite":{"saved":1,"revision":1},"storeRevision":1,"notifications":0}
```

The relevant reproducible sequence using the existing `commandFixture()` helper is:

```ts
const command = await prepare({ kind: 'setFavourite', recipeId: '53064', saved: true });
await fixture.register(command);
fixture.faults.commitAck = true;
fixture.faults.reader = true;
const uncertain = await fixture.execute(command);
fixture.faults.reader = false;
const recovered = await fixture.execute(command);
// Before repair: uncertain.kind === 'uncertain'; recovered.kind === 'receipt';
// favourite.saved === 1; favourite.revision === 1; store revision === 1;
// fixture.events.length === 0 (defect).
```

The lead repaired the executor with an operation-keyed map of pending notifications. At the reviewed repaired lines 293–294, a completed transaction callback retains the change. A confirmed transaction result or matching durable receipt consumes it at lines 297/306. The notifier deletes the entry before calling the observer at lines 201–208, preventing two concurrent exact retries from announcing it twice. A conclusive independent read with no receipt clears the unproven change at line 315. No notification is emitted merely because a write was attempted.

The updated uncertainty fixture now verifies: no event during uncertainty; independent durable receipt recovery; two concurrent exact retries returning the same receipt; exactly one `{ revision: 1, collections: ['favourites'] }` event; favourite revision still 1. I read the repair and independently reran the complete narrow command suite: **8 tests passed, 0 failed**.

## Other reviewed behavior

- Preparation copies the payload/context before asynchronous hashing and returns a deeply frozen command. Execution also snapshots before awaiting. A black-box fingerprint probe confirmed that changing operation ID, user-intent ID or intent revision changes the canonical fingerprint input; identity changes are not omitted from equality checks.
- New effects require a registered ready/dispatched intent, matching revision and frozen slot, matching persisted slot JSON, matching conversation origin/current generation/message where applicable, and current relative-date context. Existing matching receipts are checked first, allowing historical committed effects to remain recoverable after cancellation/context changes.
- The source checks both the pending-intent JSON shape and row revision/phase consistency, then the separately stored command slot's identity/content. Missing/invalid/inconsistent stored authority is rejected before invoking the handler. Malformed JSON exceptions occur inside the transaction error path. This corruption assessment is code inspection, not a completed corruption-injection test.
- The favourite handler validates existing saved/revision/timestamp values, handles real no-ops, retains increasing entity revisions across remove/re-add, and rejects revision exhaustion. The executor places mutation, collection/store revisions, receipt and intent phase in the same writer transaction.
- Executed tests cover duplicate delivery, new no-op intent, remove/re-add revisions, altered operation content, cancellation/stale revision, receipt-insert rollback, lost acknowledgement with/without reader, stale chat/day context, close/reopen persistence, and cancellation after one committed slot. The partial-batch test retains the committed receipt while rejecting the remaining slot.
- Receipt validation checks structural/timestamp validity and relevant catalogue/date semantics without requiring historical live occurrences to remain present. This is appropriate for the tested historical receipt recovery path; it is not a review of unfinished domain handlers.

## Actual checks and artifact identity

Executed from `cookmate-app`, once before the repair and once after:

```powershell
.\node_modules\.bin\tsx.cmd --test packages/domain/test/commands.test.ts
```

Both runs completed with **8 passed / 0 failed**. The first run lacked the repaired retry-notification assertions; the second included them. Also ran one inline TypeScript/desktop SQLite probe and a small fingerprint-input comparison. The inline probe printed the reproduced notification result before a later exploratory fixture/cleanup error. That error was not treated as a production defect or a completed corruption test. Its exact temporary database and empty directory were subsequently removed; no production file was edited. The post-repair suite completed cleanly using its normal fixture cleanup.

Reviewed SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `commandExecutor.ts`, before repair | `5F237EE0693E9753738459D360DCFA617F4589F56E0983347CBDBED86C6D4C35` |
| `commandExecutor.ts`, repaired | `1A849D0BC05069DE69492F15EA1823A948879C13FEA15FD42EB94D5F497236B6` |
| `commands.test.ts`, repaired | `2C8FB1A3B983C3150246843C1E95EC107783D945B60DCC62D8734C3AAD0B1466` |
| `favouriteCommands.ts` | `ABF1417AC32A0A7E602D98C8CBCEAB13F4BD74E92DF9EB1EF4F9964DF80CB371` |
| `prepareCommand.ts` | `079C776855AEAC644B003C4EA401B3E8626F8DE7CE95ECD4773354B344E44D7A` |
| `receipts.ts` | `0B7537DA18A5B157E4955E68EE59CA7FFD0B6EC03B37439280140D2DFF4BEEB6` |

## Limits

Plan, shopping, preferences and conversation mutation handlers, canonical assistant persistence adapters, complete native factory/authority exposure, and native iPhone acceptance were explicitly unfinished and excluded. They are not reported as newly discovered defects. No broad build, typecheck, install or server was run. Corrupted-row guards were inspected but not comprehensively fault-injected. Pending notifications are in memory; process restoration must reload durable state rather than replay these events, as the repaired source states. Receipt recovery through future adapters and their state-invalidation behavior still require integration proof. The single closed finding and passing desktop suite do not establish every error ordering, future handler, or native transport/storage behavior.
