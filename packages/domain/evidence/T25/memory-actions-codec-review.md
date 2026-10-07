# T25 API2 memory, actions, text codec and restoration review

28 September 2026. Independent read-only review complete for the assigned integrated API2 persistence scope. Four concrete findings were reproduced, repaired by the owner and independently rechecked; all four are closed. No remaining concrete defect was found in this bounded review. The reviewer ran 65 targeted tests serially, plus the isolated probes below. This is desktop construction evidence, not native or full application acceptance.

## Confirmed findings

### T25-MAC-01 — Historical acceptance reads accept contradictory acknowledgement metadata

**Medium; closed after independent recheck.** The initial `apps/mobile/src/data/acceptanceRecords.ts:30–68` checked the acknowledgement's shape and fingerprinted its request, normalized response and envelope. Several fields outside that fingerprint were not correlated to those inputs. A valid-shape but contradictory intent phase, intent origin conversation/generation, or guard conversation/generation/connection/date was accepted by both `readAcceptance` and exact `acceptResponse` replay. An inflated guard context revision or an unexpected plan guard on a plain answer was also accepted. The following evidence records the pre-repair behavior.

The isolated probe begins a real API2 request, accepts a real answer with retained USER evidence, then changes one acknowledgement metadata field at a time in `assistant_acceptance.acknowledgement_json`. It leaves the input fingerprint, request, response, envelope and live intent/context rows unchanged. All nine modified acknowledgements return `ready` from both APIs, and the returned value is the modified value. Changing the protected response text instead returns failure, confirming the probe exercises the uncovered metadata rather than disabling fingerprint validation.

```json
{"probe":"acceptance-metadata-corruption","outcomes":[{"case":"phase","read":"ready","replay":"ready"},{"case":"intent-origin-conversation","read":"ready","replay":"ready"},{"case":"intent-origin-generation","read":"ready","replay":"ready"},{"case":"guard-conversation","read":"ready","replay":"ready"},{"case":"guard-generation","read":"ready","replay":"ready"},{"case":"guard-connection","read":"ready","replay":"ready"},{"case":"guard-date","read":"ready","replay":"ready"},{"case":"guard-context-revision","read":"ready","replay":"ready"},{"case":"unexpected-plan-guard","read":"ready","replay":"ready"}],"inputFingerprintUntouched":true,"protectedResponseChangeRejected":true}
```

This is a fail-closed/history-integrity defect: a supposedly immutable acknowledgement can report a different accepted phase or runtime/conversation authority. It is **not evidence of fresh action execution**. The action repository reads the separate live intent and accepted guards and compares current authority before freezing/dispatch. A historical read must remain valid after later lifecycle/runtime changes; validate its original metadata against its frozen request/response and immutable acceptance evidence, not against current runtime.

Initial source SHA-256: `acceptanceRecords.ts` = `6ECC162398354A649E20E7AAC80BEF208B50E00C734E8E14018312A1D9AEE4F6`.

The repaired reader derives the original empty-slot intent and phase from the frozen request/response, correlates response/runtime/optional guards, compares the envelope with its persisted original, and compares the acknowledgement guards with the original accepted guards. It does not substitute current runtime or current action-cursor authority. The same nine isolated mutations now return `storage_failure` from read and replay. Restoring the valid acknowledgement and changing the runtime date/connection still permits exact historical replay. Repaired hash: `2FC8D50EE013870ADC0444A986DD044D959A90FD76C3A8D306C2142D96541939`.

### T25-MAC-02 — A rolled-back scope retry emits the same notification twice

**Low; closed after independent recheck.** The initial `apps/mobile/src/data/assistantContextRepository.ts` recorded an attempted scope transition when COMMIT failed and the independent reader was unavailable. If that transaction actually rolled back, an exact successful retry reached the same context revision and selection. The success path notified the retry, then reconciled the old pending proof without first removing the matching entry. The old proof matched the retry's durable transition and emitted the same event a second time. The following evidence records the pre-repair behavior.

Reproduction: accept a real retained-memory answer at conversation/store revision 2; request a scope boundary change; inject a COMMIT exception before COMMIT is executed, and make the reader unavailable; verify the failed call produces no event. Restore storage and retry the exact input. The context advances once to revision 3, but observers receive two identical events:

```json
{"probe":"scope-rollback-exact-retry-notification","events":[{"revision":3,"collections":["conversation"]},{"revision":3,"collections":["conversation"]}],"scopeChangedOnce":true}
```

The persisted scope is correct. The impact is duplicate subscriber invalidation/delivery, not a duplicate mutation or renewed command authority. Consume any matching pending candidate before announcing a successful transition, and preserve reconciliation for genuinely committed writes whose acknowledgement was lost.

Initial source SHA-256: `assistantContextRepository.ts` = `D5CAE872B3EAC56F30ECF52A32634849CC9A2560DC08437DC3CE38E8BCA6AF81`.

The success path now removes a matching pending candidate before notifying. The identical rollback/reader-outage/exact-retry probe produces one event at revision 3, with one scope transition. The targeted tests also preserve the complementary committed-but-lost-acknowledgement proof path. Repaired hash: `41889BCAD82323CB64F89BFD47BBD73D2C4C7B28C67E9C727B8C11BA8E89054F`.

### T25-MAC-03 — Recovery inventory trusts a command whose payload no longer matches its fingerprint

**Low; repaired and independently rechecked.** The initial `directRecoveryRepository.ts` structurally compared the redundant persisted intent/slot commands and matched receipt identity, but did not recompute their command fingerprint. In an isolated factory fixture, a committed favourite command was changed to a valid `clearPreferences` payload in both stored command copies while retaining its IDs, fingerprint and actual favourite receipt. The inventory reported `commandKind:clearPreferences`, `outcome:receipt`, and a favourite receipt effect. Acknowledgement removed the recovery row. This requires corruption of both redundant command copies, not one malformed field in one row. General execution correctly rejected the changed command with `operation_conflict`; no preferences were cleared and the favourite remained saved.

```json
{"probe":"direct-recovery-corrupt-fingerprint","displayedKind":"clearPreferences","receiptEffect":"favourite","outcome":"receipt","execution":"operation_conflict","acknowledgement":"ready","favouriteRetained":true}
```

This was a restoration-integrity defect, not an execution bypass. The repair recomputes the frozen fingerprint before inventory or acknowledgement trusts the row. Independent recheck now returns `storage_failure` from both APIs, preserves the recovery row, rejects the changed command, and still returns the original command's historical receipt. Initial source SHA-256: `2E7F7F92376C3FF946260EEE2DD46A34586E5856C7C71FB5CF9918547E82BA2A`; repaired source SHA-256: `C23ECD3037216D6986C779177D0D6B984A8A7A953D15B3B9073005D00A3403DA`.

### T25-MAC-04 — Assistant receipt transitions omit conversation invalidation

**Medium; closed after independent recheck.** The initial executor derived changed collections and its notification before the assistant receipt hook wrote the result journal, action cursor and resulting intent phase. Those conversation metadata writes were not added to the notification collections. For an assistant `saveRecipe` whose favourite already existed, the domain effect was a no-op, so no notification or store/conversation revision was produced at all. For a newly saved favourite, the event named only `favourites` even though the persisted assistant intent also settled. The following evidence records the pre-repair behavior.

The isolated action fixture uses the real accepted proposal, reserved plan, finalized command, executor, handlers and receipt hooks. Immediately before execution it clears captured events. Both cases end with cursor 1, a settled intent and a persisted slot receipt:

```json
{"probe":"assistant-receipt-conversation-notification","duplicate":true,"outcome":"no_op","phase":"settled","cursor":1,"events":[],"before":[{"collection":"conversation","revision":2},{"collection":"store","revision":5}],"after":[{"collection":"conversation","revision":2},{"collection":"store","revision":5}]}
{"probe":"assistant-receipt-conversation-notification","duplicate":false,"outcome":"committed","phase":"settled","cursor":1,"events":[{"revision":5,"collections":["favourites"]}],"before":[{"collection":"conversation","revision":2},{"collection":"store","revision":4}],"after":[{"collection":"conversation","revision":2},{"collection":"store","revision":5}]}
```

A conversation subscriber can therefore keep showing the pre-execution action state. Awaiting callers still receive the actual receipt; this does not prove an execution or receipt-atomicity failure. Announce the assistant journal/cursor/phase transition in the same transaction, including no-op recipe actions, while retaining the domain no-op outcome and historical replay semantics. Initial relevant hashes: `commandExecutor.ts` = `B6409D62C350B73297F52A1C4C1B93E13403A78E546577B260CC975DAF9E9B31`; `assistantActionRepository.ts` = `FCABCE7CB44A83258BFB3E3D03AB48F9333E450D6E4C407D363A476E7123BC6C`.

The executor now includes conversation invalidation when the assistant receipt hook changes its journal/cursor/phase. It increments the store version once even when the domain effect is a no-op; internal journal progress does not invent a semantic context change. Both independent cases now emit exactly one event containing `conversation`, increment store revision once, preserve conversation semantic revision 2, and add no event on exact receipt retry. Domain outcomes remain respectively `no_op` and `committed`. Repaired executor hash: `CE9693B81529B7895E6621A09B92987C0C72F28360DCAE51F4B293F9C932406B`.

## Reproduction artifacts

Owned isolated fixture script: `packages/domain/evidence/T25/review-probes.ts`. It copies the existing memory test fixture setup, with imports adjusted to its evidence directory, and adds MAC-01/MAC-02 scenarios. Its SQLite databases are in memory and closed after each scenario. The script now asserts repaired behavior; the pre-repair outputs and initial hash remain in this report. No production or existing test files were modified by the reviewer.

```powershell
.\node_modules\.bin\tsx.cmd packages/domain/evidence/T25/review-probes.ts
```

Observed initially: both reproductions completed with all assertions satisfied. Original probe SHA-256: `BD84274CAE362DD84FD81A0A4BEFD1F79373842943850AE3C513BA63F7CDF06E`. Repaired assertions also all pass; final hashes are below. The sibling `direct-recovery-probe.mjs` and `action-notification-probe.ts` preserve the MAC-03/MAC-04 rechecks. Their small file-backed SQLite fixtures live under randomly allocated, guarded temporary directories and are closed and removed. `codec-probe.mjs` uses one closed in-memory database.

```powershell
node --import tsx packages/domain/evidence/T25/direct-recovery-probe.mjs
.\node_modules\.bin\tsx.cmd packages/domain/evidence/T25/action-notification-probe.ts
node --import tsx packages/domain/evidence/T25/codec-probe.mjs
```

## Verified scope and actual test evidence

**Text codec.** Inspected every encoded column's production writer, reader and exact-value comparison found by a bounded search of `apps/mobile/src/data`. `message.text`, `conversation.composer_draft`, `saved_preference.value` and `source_preference_link.value` are JSON-escaped on writing and parsed once in JavaScript on reading. Header/transcript reads, retained USER evidence, preference snapshots and provenance comparisons use decoded values. Initialization and clear reset the draft using the codec. No source recipe field is routed through this new representation.

The independent codec probe generated all **65,536 UTF-16 code units**, inserted separators to keep surrogate units unpaired, bound JSON strings through desktop SQLite, decoded them and compared their UTF-16LE bytes with the originals. It also checked NUL, lone high/low surrogates, NFD and NFC text, emoji, literal JSON, and literal backslash-u text. All passed. Against the actual genesis DDL, each of the four columns rejected plain text and non-string JSON; maximum six-byte-escaped envelopes passed and the next code unit failed. These are encoded byte-envelope tests; application code-point limits are separately validated by repository/contracts tests. This does not assert native Expo binding behavior.

**Actions and immutable authority.** Read structural proposal matching, reserved identity/placement validation, frozen prefix checks, current guards, actual receipt/journal correlation, cursor advancement, legacy freeze compatibility and final runtime hooks. The targeted tests exercise actual preference revision after a duplicate no-op, altered/reordered/colliding plans, missing assistant context, unrelated preference/conversation/scope/runtime changes, cancelled and uncertain prefixes, atomic hook rollback, lost acknowledgement, disk reopen, and historical replay. The factory binds one live connection-generation function and tracks assistant operations through close. No new action-authority defect was found beyond the observable notification omission that is now repaired.

**Memory, scope and historical acceptance.** The targeted tests cover full original USER quotes beyond the short history window, exact Unicode evidence, omitted-review rejection, linked correction groups, explicit scope carry, fresh-scope exclusion, pending/UTF-8 budgets, 33-entry group rejection, memory/envelope rollback, explicit retry, persisted draft/transcript/evidence after reopen and historical acknowledgement replay. MAC-01/MAC-02 extend those checks with independently reproduced corruption and unavailable-reader retry cases.

**Restoration.** The final read-only additions were included: `readInstallationId` validates the actual metadata UUID; `readIntentPage` pages current summaries while validating their retained source role, conversation, generation, sequence and exact decoded quote, plus original reply presence/text. The executed factory tests restore completed, failed and interrupted intents across reopen; verify bounded paging and zero implicit receipts; preserve installation identity after chat clear; and fail visibly on missing installation metadata, corrupted source role or corrupted reply text. Direct recovery queries queue behind the writer, distinguish durable receipt/no-effect/unresolved state, and never dispatch on read/acknowledgement. MAC-03 verifies the additional frozen-fingerprint boundary.

One serial targeted command was actually run by the reviewer after the fixes:

```powershell
node --import tsx --test --test-concurrency=1 packages/domain/test/assistantActions.test.ts packages/domain/test/memoryPersistence.test.ts packages/domain/test/localStore.test.ts packages/domain/test/preferenceProvenance.test.ts packages/domain/test/conversation.test.ts packages/domain/test/schemaCompatibility.test.ts
```

Observed **65 passed, 0 failed, 0 skipped**, duration **8518.6535 ms**: 14 action, 12 memory, 12 factory/restoration, 6 provenance, 11 conversation and 10 genesis-schema tests. This is not the owner's full-suite count. Node's expected experimental SQLite warning appeared. No reviewer strict typecheck or whole-workspace suite/build was run.

The immutable workbook SHA-256 remains `C30B9AD983A0CDE05F3263A088D0B9A640AFCC5ACFF9B1FCA8515A1E8FAFFE65`; generated catalogue SHA-256 remains `F153EB9E31928233602109A2CBAE5D7598475D7DC5F641D9B47074FAC8062193`, both matching the previously verified source review. No source/annotation edits were made; the deferred Carbonara annotation remains outside this assignment.

## Limits

This review covers the assigned implemented API2 persistence wave and its stated restoration additions. It does not claim a complete security audit, exhaustive corruption detection under coordinated rewriting of all authority records, provider/model correctness, UI acceptance, native iPhone SQLite behavior, performance/load testing, or full application acceptance. Direct/assistant execution and historical acknowledgement are distinct: the original metadata findings demonstrated misleading reads/notifications, not unauthorized execution. All four reproduced findings are closed only for the repaired source snapshot below.


## Checked final hashes

SHA-256 values for the reviewed implementation, supporting codec/recovery call sites, actual targeted tests and isolated probes. Paths are relative to the code root. These final values supersede the explicitly labelled pre-repair hashes above.

| Path | SHA-256 |
| --- | --- |
| apps/mobile/src/data/storedText.ts | DD4A570737846353F4628ADAE66890F414C8F389FCBD374D440092A2D1FF14D3 |
| apps/mobile/src/data/schema.ts | 9BF45ABC61F1CCA2B77CBBBF2A0EA02DBD867883939C89148CB82E5666B0E72A |
| apps/mobile/src/data/schemaCompatibility.ts | 39A0652FD2509508B87662633AF54FEB685C9AB7845226A2E09D923487569D7B |
| apps/mobile/src/data/conversationRecords.ts | 883598329155A31C176807C7502A1C006F0629FC82688F8A4C1E81FC00A737D2 |
| apps/mobile/src/data/conversationRepository.ts | A4FDFE9559550A29790856254867445E4E603035DB5BAB72F7E60813C41874CC |
| apps/mobile/src/data/assistantRecordValidation.ts | 5A7B6248759921F8132CE3635108FF6C6CF257F883A9C671B3A350A3E72713C3 |
| apps/mobile/src/data/assistantIntentRecords.ts | 99665C7866C586B7982D360FE944E96B3259A411112E9D514D25730BF274AA1B |
| apps/mobile/src/data/assistantTurnRepository.ts | A65DA4170F6CC5FFE8E57703037950074EE41BDE4CD79800A78E9036BA1D8B0A |
| apps/mobile/src/data/preferenceCommands.ts | 0210615C0630A893E5217F190D762A817ADB4F045377DB9C7CC5616B6FDD6A5D |
| apps/mobile/src/data/preferenceProvenance.ts | E9BE23E89D05E7CF2247383670D051941978ACA422CF47836068EA3FB7B45A1F |
| apps/mobile/src/data/stateRepositories.ts | 39F33FE6969045632AE8166BAC1908DB98F49F143B35F178BC94F2D794ACD60D |
| apps/mobile/src/data/memoryRecords.ts | E13A2BD34E1E9D78BA6E75B21DF1B10C62985E2A449479DC1C1C0240EE60D39A |
| apps/mobile/src/data/memoryAcceptance.ts | DB8C6E3B447B7C8714DF84A021132A00A94840714F492FB6DD9D8D912DDD6488 |
| apps/mobile/src/data/acceptanceRecords.ts | 2FC8D50EE013870ADC0444A986DD044D959A90FD76C3A8D306C2142D96541939 |
| apps/mobile/src/data/assistantContextRepository.ts | 41889BCAD82323CB64F89BFD47BBD73D2C4C7B28C67E9C727B8C11BA8E89054F |
| apps/mobile/src/data/actionPlanRecords.ts | 3E8E991F3B1E4B18FD771F61212B099EA98622BF61352C66315A4DFD173B23D5 |
| apps/mobile/src/data/assistantActionRepository.ts | FCABCE7CB44A83258BFB3E3D03AB48F9333E450D6E4C407D363A476E7123BC6C |
| apps/mobile/src/data/directRecoveryRepository.ts | C23ECD3037216D6986C779177D0D6B984A8A7A953D15B3B9073005D00A3403DA |
| apps/mobile/src/data/localStore.ts | B0EC1460FC65A159111DA5F90942845F67E52C0442C12854C2BB11D0945DCA41 |
| apps/mobile/src/data/commandExecutor.ts | CE9693B81529B7895E6621A09B92987C0C72F28360DCAE51F4B293F9C932406B |
| apps/mobile/src/data/initialize.ts | C5BDB0E13B443DC40D55252D40FD51F95282C001D0D78F7003624DBA3805DA53 |
| apps/mobile/src/data/clearConversationCommand.ts | 64564EB129FBA9392AB9CB7C8EE0998DB666DEE11C7706DCC4FC5B36134E1BBA |
| apps/mobile/src/data/assistantRecovery.ts | A70A7EC9BC054D70C7258C96326675566A75AC78F5B2A3E0E9772764E07B8304 |
| packages/domain/src/conversationPorts.ts | 4C2A680C384F07C8541A18E8088A54CBA2EA873EA0D4105E903F65296B826F8A |
| packages/domain/src/services.ts | 3AC31069C639C63788568FBC53549247D14104B061FF600D89163E2A9B50C4A0 |
| packages/domain/test/assistantActions.test.ts | 3926D8BE42F0E7FF1D945DEF144DDC45BCFB1393B5D56B8EB40D2F14AA8FF653 |
| packages/domain/test/memoryPersistence.test.ts | 45E840FEDF6CFE8FE8330915A76DD715EAB5778D793602DEFE8FF53956324EDA |
| packages/domain/test/localStore.test.ts | 8163EE55C98BE4C49C881E60BF47F70DAB88906734C2ED267E3B332BB00B6978 |
| packages/domain/test/preferenceProvenance.test.ts | EBCF8BB126703936EE007FF7B575EFF8F4C099D0786CE4B5E2F91E3C824C11E9 |
| packages/domain/test/conversation.test.ts | E7A3339F3AC8A0FE048A1DF5F4ED58ADCA8D1C1BFA5CE86D6B2256EF500B16C7 |
| packages/domain/test/schemaCompatibility.test.ts | 3AE5A238540CA810426CA84CE1585F0E543657316E642866AFA97A32189EFD89 |
| packages/domain/evidence/T25/review-probes.ts | F5AC8DD134006AE524004D6801ED14AF65ED0B129FE3EE75C2D27D6BEB641053 |
| packages/domain/evidence/T25/direct-recovery-probe.mjs | 8CD68131B79D936F4541E9C97620ADB3F751DEB449D0851B02066FB73EE109E8 |
| packages/domain/evidence/T25/codec-probe.mjs | D52A7621659EFC2C81AFA6CB0D2DCC3AC309752DA861498A844C5B523887DC8E |
| packages/domain/evidence/T25/action-notification-probe.ts | 1D16573A0B97651F4A4B6E73038F9719A6FA3F799449AC93F9DDFE040FBCF222 |
