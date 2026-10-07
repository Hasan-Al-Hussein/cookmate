# T20 plan and shopping SQL review

28 September 2026. No new concrete defect was established in the stable implemented slice. Eighteen targeted/regression tests passed, followed by seven independent in-memory assertion scenarios. **Combined recipe/placement changes through `editPlan` remain explicitly unfinished pending the coordinated shared-contract amendment.** This report does not accept that gap or claim full factory/native readiness.

## Scope

Read-only review covered `apps/mobile/src/data/shoppingRepository.ts`, `shoppingCommands.ts`, `planCommands.ts`, and `packages/domain/test/planningShopping.test.ts`. The executor review was limited to the relative-date entry helper and final callback check. Existing transaction/receipt/conversation and pure quantity/projection internals were not re-audited; supporting definitions were read only as needed. No production or test file was edited.

At this snapshot, `planCommands.ts:157–158` rejects an `editPlan` recipe change because its shared command shape lacks `expectedShoppingScopeRevision`. Placement-only edit, explicit recipe replacement, and occupied move with a final recipe are implemented. Brain has assigned a required scope-revision field to Foundation and a later atomic combined edit to Data. That amendment and its tests require a subsequent review; the current rejection is recorded as known pending coordination rather than a newly discovered defect.

## Checks actually run

From the code root:

```powershell
.\node_modules\.bin\tsx.cmd --test packages/domain/test/planningShopping.test.ts packages/domain/test/commands.test.ts
```

Observed **18 passed, 0 failed**: 10 plan/shopping integration tests and 8 existing command regressions. Node emitted its expected experimental SQLite warning. The integrated tests create isolated file-backed SQLite fixtures with a separate read-only connection; their fixture cleanup completed normally. The additional reviewer probes used only `desktopConnection()` in-memory databases, closed in `finally`, through literal PowerShell here-strings piped to `node --import tsx --input-type=module -`.

The existing integrated tests establish:

- Adding a plan occurrence does not silently select it for shopping. Repeated recipe occurrences remain separately attributed; exact retries return the same receipt, while genuine selection/placement no-ops do not rebuild demand.
- Selected placement-only movement preserves group fingerprints, marks and projection revision. Explicit recipe replacement retains occurrence identity and selection while updating source contributions and resetting changed demand.
- All four occupied-move inclusion combinations preserve A's inclusion and identity, remove B, and never inherit B's selection. A-only unchanged demand keeps its marks; removal of B from combined demand resets affected marks.
- Stale source revision, destination revision or shopping-scope revision rejects the occupied command without replacing newer state.
- Projection insertion and receipt insertion failures roll back the move, selected IDs, purchased state, revisions and notifications. The exact command can subsequently succeed.
- Stale purchase revision/fingerprint rejects a toggle. Deselect/reselect and deletion of the sole selected occurrence do not restore purchase credit. Selection-first concurrent delivery rejects a purchase against obsolete demand.
- Actual shopping rows and receipts survive close/reopen without reseeding. Corrupted persisted quantity JSON produces failure and remains stored for diagnosis.
- A lost occupied-move acknowledgement reconciles the real receipt once without duplicating the move or notification.

## Independent occupied-move recipe-transition matrix

The existing matrix uses the same recipe before/after the move. The independent fixture instead created A = recipe 53150 on 28 September, B = 53064 on 29 September, and an unrelated selected C = 53049 on 30 September. It selected C plus each A/B combination, purchased all current groups through real commands, and issued `movePlanReplacing` with **final recipe 53320** at B's placement. Each case used the real preparer, registered intent, executor, plan/shopping handlers and shopping reader.

All four cases retained A's ID and original creation timestamp, incremented A's revision to 2, changed its recipe to 53320, removed B, retained C, and kept A selected exactly when it had been selected before. Scope revision advanced only when selected B was removed. An exact retry returned the same receipt. `PRAGMA foreign_key_check` returned no violations after each transition.

| A selected | B selected | Unaffected purchased groups retained | New/changed groups left unpurchased | Result |
| --- | --- | ---: | ---: | --- |
| No | No | 9 | 0 | A remains excluded; C unchanged |
| No | Yes | 9 | 0 | B removed from demand; A remains excluded |
| Yes | No | 7 | 11 | A's new recipe contributes; unaffected C demand retains credit |
| Yes | Yes | 7 | 11 | B removed; A's new recipe contributes with reset demand |

These counts describe the named fixture only. Unaffected groups were identified by exact matching demand fingerprints; each retained purchased=true and its previous purchase revision. Every different/new fingerprint was unpurchased. Contribution ownership was checked against C and, only when selected, A with recipe 53320. No B contribution survived.

## Independent failure, ordering and final-guard probes

**Recipe-transition rollback.** With A and B both selected and every group purchased, inject a failure at `INSERT INTO shopping_contribution` during the recipe-changing occupied move. The source and destination rows, complete shopping snapshot and event list exactly matched their pre-command values after the failure; no receipt for that operation existed. Removing the fault and retrying the identical command succeeded, with no foreign-key violation. This exercises rollback after removal of old recipe-pair contributions and the occurrence's actual recipe change, beyond the same-recipe fault case in the existing test.

**Purchase-first ordering and corruption.** Register a purchase against one selected occurrence's current group and a selection change adding a second occurrence of the same recipe. Dispatch purchase first and selection second concurrently through the serialized writer. Both commands return receipts, and the final projection has every affected group unpurchased and marked changed. This complements the existing selection-first test. Then change one persisted purchase fingerprint to a different valid 64-character hash. `readShopping` returns failure and leaves all corrupted rows untouched; it does not silently reset/rebuild them.

**Timezone change at the final boundary.** An independent `addPlan` command carried a valid relative-date guard interpreted on 28 September in Asia/Dubai. Immediately after the actual receipt INSERT, a statement hook changed the runtime timezone to Europe/London and offset to UTC+60 while leaving the calendar day unchanged. The final callback check returned `stale_context`; plan-row count, receipt count and store revision all remained zero, and no event was emitted. The existing test separately changes the calendar day at that same boundary and verifies exact retry after restoration.

## Code observations supporting the result

`shoppingRepository.ts:75–200` rebuilds expected demand from authoritative selected occurrences and the immutable recipe source, then verifies persisted active groups, purchase fingerprints, contribution ownership/raw values and exact quantity JSON before hydration. Active and dormant groups are distinguished by projection revision. Dormant purchase rows must be unpurchased and marked changed. `rebuildShoppingInSnapshot` retains dormant group identities so deselection/re-add cannot revive old credit, and reconstructs contributions within the command transaction.

`shoppingCommands.ts` checks the selection revision before changes, verifies every selected occurrence exists, and binds purchase updates to scope ID, group key, demand fingerprint and purchase revision. An explicit checkbox action clears the changed marker. No-op selection and unchanged checkbox actions preserve revisions as intended.

`planCommands.ts:100–116` removes old contribution rows before changing an occurrence's recipe, avoiding the recipe-pair foreign-key conflict. Occupied move validates A, B and the scope before mutation, removes B's selection/row, retains A's identity/inclusion, and rebuilds shopping when either affected occurrence was selected. The independent recipe-transition matrix and fault probe exercised that path.

`commandExecutor.ts:89–95` performs the relative-date equality guard; the final call at line 298 runs after receipt/intent writes and before callback success/notification bookkeeping. The injected date and timezone changes rolled back the entire transaction. This does not claim a cross-process runtime lock or native commit timing proof.

## Limits and pending work

No new defect was found in the implemented paths under these checks. The combined `editPlan` amendment remains open and must not be inferred from the working `replacePlanRecipe`/`movePlanReplacing` commands. The review did not exhaust every corruption pattern or storage-failure point. Only the existing targeted test exercised file reopen; independent extra probes were in memory. Native iPhone performance, lifecycle/resource acceptance, complete factory composition and UI confirmation/consequence rendering remain unverified.

## Stable reviewed hashes

SHA-256 values captured before and after the initial review remained identical. Paths are relative to the code root. The executor hash identifies the file snapshot; only the assigned relative-date additions were inspected here.

| Path | SHA-256 |
| --- | --- |
| apps/mobile/src/data/shoppingRepository.ts | 8E130CAB7A6B3089DACB98A0BD3BB4A83ACDAC5638C11D3D66CF22B21E8459D4 |
| apps/mobile/src/data/shoppingCommands.ts | 0C73253F13659C937761795DAFC207892B3DCF8F4998055A57B532B11925F677 |
| apps/mobile/src/data/planCommands.ts | AB9DC6C8A98002FB9F1EDBACDA159D4BF6716D78EB465C60E8B32E5C1C753829 |
| apps/mobile/src/data/commandExecutor.ts | 94711F8F0D331F61AD662DA58B731972693B1D518AE7FA6A2DE7221FE77466A2 |
| packages/domain/test/planningShopping.test.ts | F1B2A71B5D9C4115FE42D0C64D76B403206455591A1BB3E46973A13C23DF0ECB |
