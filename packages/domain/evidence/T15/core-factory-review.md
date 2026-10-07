# T15 core factory independent review

28 September 2026. Both independent medium-priority findings below are **closed after repair and independent recheck**. The separate selection-review guard defect reported by Frontend is also closed within this bounded core-facade review. The repaired version passes 6 factory tests, 20 integration/composition tests and the additional probes described below. No remaining concrete defect was found in the reviewed scope. This is desktop construction evidence, not native storage or complete application acceptance.

## Scope and source state

Read-only review covered `data/localStore.ts`, `nativeStore.ts`, `directActionReview.ts`, domain `directActions.ts`, `services.ts`, `prepareCommand.ts`, and `localStore.test.ts`. Existing executor/plan/shopping code was consulted only to interpret composition and recovery; previously reviewed internals were not re-audited. The native connection wrapper was read to verify that distinct connections are requested. It was not executed on an iPhone.

The initial facade calls `prepareDirect(review.payload)`. During review, the lead announced a forthcoming Data-only change to accept the full review and persist a local plan-revision guard. The initial line references and hashes below identify the reproduced version; they must not be mistaken for evidence of the repaired interface. Assistant context/turn/memory construction, the new envelope table and the future assistant facade were outside scope.

No production/test files were edited. Only this report is owned by the reviewer.

## T15-IR-01 — One subscriber can falsify another subscriber's commit event

**Medium; closed after independent recheck.** In the initial version, `localStore.ts:102–109` sent the same mutable `StoreChange` object to every listener. Catching exceptions isolated thrown errors, but did not isolate mutation. `services.ts:69–72` also left both event properties writable, even though the collection array's element type was readonly. The reproduction below records the initial defect; the repair evidence appears later in this report.

Reproduction through the actual facade:

1. Subscribe listener A with `event.revision = 999; event.collections = ['plan'];`.
2. Subscribe listener B that copies the received event.
3. Review, prepare and execute a valid `setFavourite` for recipe 53064.
4. Read the actual SQLite store revision and listener B's copy.

Observed:

```json
{"probe":"subscriber-mutation","result":"receipt","actualStoreRevision":1,"secondSubscriber":[{"revision":999,"collections":["plan"]}]}
```

The favourite commit is durable, but a later subscriber is told a nonexistent revision and the wrong changed collection. A consumer can consequently miss its refresh or advance its revision cursor incorrectly. Freeze an owned event and its nested collections before fanout, or otherwise isolate each listener from others. Verify that a mutation attempt cannot alter another subscriber's event and that a throwing listener still cannot block delivery.

## T15-IR-02 — A supplied empty edit ID silently becomes an add

**Medium; closed after independent recheck.** In the initial version, `directActionReview.ts:62–64` tested `input.occurrenceId` by truthiness. An explicitly supplied empty string skipped `occurrenceById` and its AppId validation. `placeRecipe` was then interpreted as an add/replacement even though the caller supplied an edit identifier. Nonempty invalid IDs correctly took the rejecting validation path. The reproduction below records the initial defect; the repair evidence appears later in this report.

Reproduction:

```ts
await services.commands.reviewDirect({
  kind: 'placeRecipe',
  occurrenceId: '',
  recipeId: '53150',
  placement: { actualDate: '2026-09-29', mealKey: 'dinner' },
});
```

With that destination empty, observed:

```json
{"probe":"empty-edit-id","kind":"ready","payloadKind":"addPlan","inputId":"","source":null}
```

No command was executed in this probe. The defect is the successful review of a different action kind instead of visible invalid input. Distinguish an absent optional identifier from a present invalid identifier, and reject invalid supplied IDs before deriving the command or its consequences. Test both an empty destination and an occupied destination so malformed edit input cannot become a replacement either.

## Separately reported selection-review seam

Frontend reported that changing a named occurrence's recipe/date does not necessarily change the shopping selection's scope revision. A reviewed `setShoppingSelection` could therefore refer to changed named meals without its existing scope-only guard becoming stale. The lead accepted this finding and added a local `planRevision` guard, resolved selected-occurrence consequences, full-review preparation and receipt-first replay handling. This was not independently reproduced against the changing surface during the initial pass. The stable implementation is now independently rechecked and closed as described below. It is distinct from IR-01 and IR-02.

## Checks actually run

```powershell
.\node_modules\.bin\tsx.cmd --test packages/domain/test/localStore.test.ts
.\node_modules\.bin\tsx.cmd --test packages/domain/test/preferenceProvenance.test.ts packages/domain/test/combinedEdit.test.ts
```

Observed **4/4 core-factory tests** and **10/10 cross-check tests** pass. The latter are six preference-provenance and four combined-edit tests, used to check composition dependencies rather than repeat their complete review. The combined edit tests establish that the previously pending scope-guard amendment is now implemented in that dependency. No strict typecheck was run by this reviewer; the owner's reported typecheck is not counted as independent evidence. Node emitted the expected experimental SQLite warning.

Core tests exercised two distinct connections, read-only review, frozen commands, command/receipt replay across reopen, occupied destination resolution, stale selection rejection for combined edit, incompatible older database rejection with failed-start cleanup, and close waiting for an in-flight command.

Additional probes used four isolated file-backed desktop SQLite fixtures because the actual factory requires two independently owned connections. Each fixture lived under a randomly allocated `cookmate-repository-T15-` temporary directory and was cleaned with the existing guarded fixture helper. No persistent fixture or implementation file was created. Scripts were supplied through literal PowerShell here-strings to `node --import tsx --input-type=module -`.

Besides the two findings, those probes confirmed:

- **Close during preparation:** block platform hashing with a promise, start `prepareDirect`, then call `close`. Both connection-close counters remain zero while preparation is pending; new queries fail as closed. Release hashing: preparation completes, then each connection closes exactly once. Reopen and try the prepared but unexecuted command: startup recovery has cancelled it, execution returns `cancelled`, and no favourite exists.
- **Failed read-open:** after saving a favourite and closing, throw when opening the read connection. Factory initialization returns failure, closes its newly owned writer, and leaves the favourite intact. A normal subsequent reopen reads the saved favourite.
- **Close failures:** wrap both connection closes to perform the actual close and then reject their acknowledgements. The facade returns one shared rejected close promise, attempts both releases once, and rejects subsequent queries as closed. This tests visible failure and both-release attempts; it does not simulate a native close that leaves a handle open.
- **Newer database generation:** set `PRAGMA user_version=999` after saving a favourite, close and reopen. Initialization returns `incompatible_version`, closes the failed-start connection, retains version 999 and preserves the favourite. No reset/reseed occurs. The existing core test separately covers older version 1.

## Independent repair recheck

The owner declared the repaired core files stable before this recheck. The eight final core/executor/test hashes below were unchanged between the beginning and end of the recheck. No production or test edits were made by the reviewer.

The actual repaired facade requires `prepareDirect(review)`. `localStore.ts:153` snapshots the full review before asynchronous preparation and rejects missing, `none`, malformed or payload-inconsistent shopping-selection guards. `directActionReview.ts:157` resolves every selected occurrence; `:268` captures the plan revision in the same reader transaction. The frozen result includes the guard and resolved `afterOccurrences`.

`registerReadyIntent` in `commandExecutor.ts:363` checks the supplied plan and scope revisions inside the writer transaction and inserts the command slot plus its `command_review_guard` row atomically. At first execution, `:176` requires the persisted scope guard to match the frozen payload and its plan revision to match current plan state. The selection handler separately requires the current scope revision. Existing receipt lookup remains earlier than these first-mutation checks. The local guard table has an operation-ID foreign key with cascade deletion and nonnegative revision checks. Low-level non-facade registration can capture a registration-time guard; this does not bypass the production facade's full-review requirement.

Commands independently run against the repaired version:

```powershell
.\node_modules\.bin\tsx.cmd --test packages/domain/test/localStore.test.ts
.\node_modules\.bin\tsx.cmd --test packages/domain/test/planningShopping.test.ts packages/domain/test/preferenceProvenance.test.ts packages/domain/test/combinedEdit.test.ts
```

Observed **6/6 factory tests and 20/20 cross-check tests pass**, with no skips or failures. The 20 comprise ten plan/shopping tests, six preference-provenance tests and four combined-edit tests. The factory regression executes recipe, date and remove/re-add changes between review and preparation/execution, checks resolved recipe consequences, and verifies historical receipt replay after a later recipe edit. These tests were actually executed by the reviewer; no owner's test count is substituted.

Three additional isolated file-backed fixture scenarios checked cases beyond the new test assertions:

1. **IR-01 and IR-02 closure.** The first listener checks `Object.isFrozen` on both event and collection array, attempts `Reflect.set` on the revision, collection property and collection element, then throws. All three writes return `false`; a later listener receives exactly `{revision:1, collections:['favourites']}`. An empty supplied occurrence ID returns `invalid_input` both before and after a valid occurrence occupies the requested destination. That occurrence retains recipe 53064 and the plan retains exactly one occurrence. The fix is an owned deeply frozen event at `localStore.ts:102` and `occurrenceId !== undefined` at `directActionReview.ts:63`.
2. **Scope-only staleness and facade guard requirement.** Add A and B, review and prepare selecting A, then select B through a separate confirmed command. The plan revision remains 2 while the scope revision changes from 0 to 1. Preparing the old full review and executing its already-prepared command both return `stale_context`. Counts of pending intents, slots, guard rows and receipts are identical before/after the failed preparation and execution; the complete shopping snapshot is unchanged. Missing guard, `guard:{kind:'none'}` and the former payload-only calling convention each return `invalid_input` without inserting rows. The returned guard and resolved occurrence are frozen.
3. **Persisted guard corruption and receipt precedence.** For separate fresh unexecuted commands, delete the guard row, alter only its scope revision, or alter only its plan revision. Execution returns respectively `storage_failure`, `storage_failure` and `stale_context`, with no new receipt or shopping change. A successfully committed selection still returns its identical historical receipt after deleting its guard row and editing the selected meal's recipe; no new mutation is performed for this replay. This probes missing/mismatched guards, not adversarial rewriting of every mutually consistent authority record.

Actual probe output:

```json
{"probe":"repair-event-and-empty-id","ownedEventAndArrayFrozen":true,"mutationResults":[false,false,false],"firstDeliveredEvent":{"revision":1,"collections":["favourites"]},"emptyAndOccupiedEditId":"invalid_input","existingRecipePreserved":true}
{"probe":"scope-only-review-staleness","planRevisionUnchanged":2,"scopeRevisionBefore":0,"scopeRevisionAfter":1,"prepare":"stale_context","execute":"stale_context","registrationRollback":true,"shoppingUnchanged":true,"missingNonePayloadOnlyReview":"invalid_input"}
{"probe":"stored-selection-guard-corruption","outcomes":[{"corruption":"missing","error":"storage_failure"},{"corruption":"scope_mismatch","error":"storage_failure"},{"corruption":"plan_mismatch","error":"stale_context"}],"noMutationOrNewReceipt":true,"receiptFirstAfterGuardRemovalAndMealEdit":true}
```

The three lifecycle fixture scenarios from the initial review were also rerun with `prepareDirect(review)`: hashing-gated preparation versus close and startup cancellation, failed read-open plus both close acknowledgements failing, and newer database version 999 retaining its favourite. All assertions passed again. In total, the repair pass used six additional temporary fixture scenarios. All fixtures were isolated and cleaned with the guarded existing helper; scripts used literal PowerShell here-strings and `node --import tsx --input-type=module -`.

## Limits

Native Expo connection ownership is supported by code inspection only, not actual device execution. No native restart/resource/performance acceptance, complete assistant exposure, schema acceptance for the separate active assistant lane, strict typecheck or whole-workspace build is claimed. Arbitrary cancellation during an already-dispatched direct command is not exposed by this core facade; startup cancellation/reconciliation behavior was checked only for the prepared-not-executed path and existing receipt replay. The initial defects and line references remain above to preserve the before/after evidence; their status is closed for the repaired hashes below.

## Rechecked core hashes

SHA-256 values, unchanged during the repair recheck. Paths are relative to the code root. The actively developed assistant/schema surface is excluded from this stability statement; only the new local guard DDL was inspected as a supporting dependency.

| Path | SHA-256 |
| --- | --- |
| apps/mobile/src/data/localStore.ts | A05DBE802FF5D1F19059888A4610775632AA23B3197820C62879441CD440EB26 |
| apps/mobile/src/data/nativeStore.ts | 039C7099B84719DC85C3A6FA5C2FC3B2F4CC50FA577B94B60A36DE22CF8450A5 |
| apps/mobile/src/data/directActionReview.ts | 725081030C591FB80BCA0F8FCD82C23EAD6DAA948B0642C0D7568F45CCDCF209 |
| apps/mobile/src/data/commandExecutor.ts | 6EABE892A321376A0BCE7AC671D40CB5C6CE9DDC3225052BDFB0DA58119373A5 |
| packages/domain/src/directActions.ts | D76BC38600A76E285ACAB875DE9600DE94EBF67C24E442A6919FE246E1D902E1 |
| packages/domain/src/services.ts | 7083C8DB1FA12F3A6C4E749BA37D3D367157EC26902BE2A2583421223D86A367 |
| packages/domain/src/prepareCommand.ts | CFC471E7D279806D3541A814ECF2580593F7C14BC89BDE0849AF7F052884652D |
| packages/domain/test/localStore.test.ts | D2E98E76C98058F20A2B7DC404FBDCB8109F79B00951021046514F5C8823CFEA |

## Initial reviewed hashes

SHA-256 values captured before the coordinated core review-guard amendment. Paths are relative to the code root.

| Path | SHA-256 |
| --- | --- |
| apps/mobile/src/data/localStore.ts | BFF4158F72B48D1DDB3265F20C98433E04588E87F7E0467F4C9394F28353934E |
| apps/mobile/src/data/nativeStore.ts | 683A0BF7DD07F4B54B5C5B3618D632CE33F6438FFD1AB5D9878B169F98EFDA48 |
| apps/mobile/src/data/directActionReview.ts | 75EE1C7EC745F5413B3B89D9AEEC7683EC72A779E5D3CED6E85EC8B4AEA6CE78 |
| packages/domain/src/directActions.ts | C0B891334ED52D46E80244A04EA3A29399ED9D0354B6B0D64255260CF1D9DBD2 |
| packages/domain/src/services.ts | 8ABFB869267F78EFBCD652B748CD4386DC17714954D1CA79C05B66B2C378A44D |
| packages/domain/src/prepareCommand.ts | A5C0EE45E162B379072C65BE64133A4BA413B341C94A63E29EC9E70B1F456CC1 |
| packages/domain/test/localStore.test.ts | 9C71BA4B956980243A69D45E4C532BE5757B87A826895156DEAE9E71274856E9 |
