# T26 preference and conversation-clear review

28 September 2026. No concrete defect was established in this bounded independent review. Seven targeted tests and three additional in-memory probes passed. This is construction evidence, not full persistence-port, UI consent, projection or native iPhone acceptance.

## Reviewed surface

- `apps/mobile/src/data/preferenceCommands.ts`
- `apps/mobile/src/data/clearConversationCommand.ts`
- `packages/domain/test/preferences.test.ts`
- `packages/domain/test/clearConversation.test.ts`

The existing command preparer/executor, conversation repository and their previously closed findings were not re-audited. Supporting schema/read-helper definitions were consulted only to interpret the assigned handlers and construct isolated fixtures. No production or test file was changed. The quantity/projection lane was excluded.

## Supported behavior

`preferenceCommands.ts:8–14` reads the current preference snapshot and checks the exact collection revision before save, duplicate handling, removal or clear. Save preserves the explicit value as supplied. Equality uses both type and exact string value; an exact duplicate with a fresh preference ID returns a no-op effect naming the existing ID. An edit that collides with a different existing preference is rejected instead of overwriting it. The 100-item limit only blocks creation of a new distinct item; an existing item can still be edited. Successful mutations return the next safe preference revision, and the existing executor commits that revision and receipt together. Missing removal and empty clear return no-op receipts.

`clearConversationCommand.ts:9–17` requires the current conversation ID and generation and checks generation exhaustion before deletion. Its selection at lines 26–28 removes intents linked to the current conversation plus persisted assistant turn contexts; direct-screen intents without conversation origin remain independent. Deleting those pending rows cascades their command slots and assistant contexts. Deleting messages cascades reference sets/items. The header is retained with the next generation, an empty draft and sequence zero. The handler does not delete receipts or cooking/preference tables. The generation change invalidates old uncommitted chat authority, while an existing committed operation can still return its durable receipt.

These are handler-level observations. Upstream UI/assistant composition must still establish that a preference change or chat clear was deliberately authorized; that integration is outside this review.

## Checks actually run

From the code root:

```powershell
.\node_modules\.bin\tsx.cmd --test packages/domain/test/preferences.test.ts packages/domain/test/clearConversation.test.ts
```

Observed **7 passed, 0 failed**: four preference tests and three chat-clear tests. Node emitted its expected experimental SQLite warning.

The tests exercise preference creation/update/deduplication, stale revision rejection, removal/empty-clear no-ops, the 100-item cap, collision preservation, and receipt-insertion failure rolling back a multi-preference clear before an exact successful retry. The chat tests exercise real begin/response persistence and reference erasure, preservation of preferences/favourites and old receipts, old-origin command and late failure-record rejection, stale generation rejection, exact clear retry without a second generation increment, and receipt-insertion failure rolling back transcript/context deletion and generation changes.

Three additional probes ran as literal PowerShell here-strings piped to `node --import tsx --input-type=module -`. They used the actual initializer, command preparer, executor, assigned handlers and `desktopConnection()` in-memory SQLite fixtures. Each fixture was closed in `finally`; no file, server or dependency was created.

1. **Capacity and stale authority.** Seed 100 distinct preferences at collection revision 1. A fresh-ID exact duplicate returns `no_op` and names the original ID. Updating that original ID to a new value succeeds at capacity and advances preference revision to 2. A duplicate request and a removal still carrying expected revision 1 both return `stale_context`. Exactly 100 preference rows remain.

   ```json
   {"probe":"preference-cap","duplicate":"no_op","edit":"committed","staleDuplicate":"stale_context","staleRemove":"stale_context","rows":100,"revision":2}
   ```

2. **Exact values and types.** Four fresh commands at successive revisions persist cuisine values `Indian`, `indian`, and ` Indian `, plus ingredient-like value `Indian`. All four are distinct and all source strings remain unchanged. This confirms exact-value semantics rather than silently case-folding, trimming or merging across preference types.

3. **Clear scope beyond the existing tests.** Seed one row path through plan occurrence, shopping selection, group, contribution and purchase state, alongside favourite and preference rows. Capture ordered SQL row arrays from eight tables: `favourite`, `saved_preference`, `plan_occurrence`, `shopping_scope`, `shopping_selection`, `shopping_group`, `shopping_contribution`, `purchase_state`. Register a ready intent with a chat origin and a separate ready intent without an origin. Execute a real registered clear command. All eight captured row arrays remain deeply equal. The chat intent and its command slot disappear; the direct intent and its slot remain. Messages and both reference tables become empty. Generation becomes 1, exact retry returns the same receipt without another change, and exactly one conversation event is observed at store revision 1.

   The shopping rows are explicit SQL scope sentinels, not generated projection output. Their opaque quantity JSON was `{"test":"clear-scope-sentinel"}`. This probe establishes erasure boundaries and row preservation only; it does not claim those sentinels satisfy quantity semantics or that projection construction was validated.

## Limits

No broad build, new dependency, server, native run or full-factory check was performed. Receipt-acknowledgement reconciliation and conversation internals retain their separate reviewed evidence; this pass did not duplicate those audits. The seven tests cover injected receipt-insertion failures, not every possible storage fault. Corruption recovery, full context/memory composition, upstream confirmation UI, plan/shopping command correctness and projection behavior are outside the assigned slice. No whole-application or native acceptance claim follows from these checks.

## Reviewed source hashes

SHA-256, paths relative to the code root:

| Path | SHA-256 |
| --- | --- |
| apps/mobile/src/data/preferenceCommands.ts | 927E0239AD6128EEBDFBBA076F058BF902AB931374C5CF3390335A2BA682E9D4 |
| apps/mobile/src/data/clearConversationCommand.ts | B0077C159D70EFD30FC7F738ACA55F6D651BA8FB7A8C7EA262F377A2D0919060 |
| packages/domain/test/preferences.test.ts | EE5D439DDA9B7DF2A30113AA059C8E71029F6A3DA2FCDF6B3AE662E9EBAAD3D4 |
| packages/domain/test/clearConversation.test.ts | 130654D12FE0EBBA516232BD683D38DA80A70569C3D26328AB5DC806E7B48955 |
