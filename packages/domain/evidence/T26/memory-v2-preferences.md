# T26 — preference provenance and combined plan-edit regressions

28 September 2026. Focused desktop SQLite checks against the coordinated v2 contracts and current Data implementation. This bounded follow-up changed only:

- `packages/domain/test/preferenceProvenance.test.ts`
- `packages/domain/test/combinedEdit.test.ts`
- This evidence file.

No production, shared-contract, existing-fixture or root file was edited in this follow-up.

## Verified behavior

Six preference tests exercise actual prepare/register/execute handlers and public `readPreferences`, with fresh schema-2 databases, command schema 2 and receipt schema 1:

- A duplicate save after an unrelated save links the new USER source to the existing preference ID and its actual row revision 1, despite global preference revision 2 and a different requested ID. Exact replay is mutation-free; another successful duplicate from the same source does not create another link or replace its original supporting receipt. Assistant-origin and origin-free saves do not invent USER links.
- Replacement, removal, re-addition and clear mark exactly the withdrawn versions and preserve older removal markers. A re-added equal value creates a new version; it does not reactivate old links. Empty clear and nonexistent removal preserve a null watermark initially and preserve an existing watermark later. Withdrawal of a preference saved outside chat still advances the global watermark.
- The real clear-conversation command deletes messages, source context, reviews, memory, links and stored acceptance; resets memory generation/projection/boundary/carry state; and preserves saved preferences, removal watermark and successful receipts. Old saved-command replay returns the original receipt without recreating links. Uncommitted old-origin commands fail.
- Receipt-stage fault injection rolls back five command paths: create preference, replace preference, remove preference, clear preferences and clear conversation. Complete inspected snapshots, including rows, revisions, intents and receipts, remain unchanged; no event fires; the same operation can succeed and replay exactly after the fault is removed.
- NUL-only and embedded-NUL preference values round-trip exactly through public preference reads and same-source duplicate provenance comparisons. These assertions exercise the lead's current read-path fixes rather than relying only on raw stored bytes.

Four combined-edit tests exercise real `editPlan` with recipe, date and meal changed together:

- Selected and unselected occurrences keep their ID and selection. One command produces one plan revision increment, one event and one updated effect. The selected recipe change rebuilds demand and resets affected purchase credit; an unselected change leaves the entire shopping snapshot unchanged. Unrelated occurrences remain unchanged.
- Exact no-op preserves plan, demand, purchase marks, revisions and events. The current `expectedShoppingScopeRevision` is required even for an otherwise exact no-op.
- Stale occurrence revision, stale scope revision and an occupied target all reject without partial recipe/placement changes or a receipt.
- Failures at occurrence update, contribution rebuild and receipt insertion roll back all inspected plan, selection, demand, purchase, revision, intent and receipt rows. The exact operation then succeeds once. Exact replay remains mutation-free after later selection changes; a changed payload with the same operation ID and a valid recomputed fingerprint returns `operation_conflict`.

## Commands and results

Working directory: the `cookmate-app` root. Runtime: Node v24.13.0 with `node:sqlite` (SQLite 3.50.4). The standard experimental SQLite warning was emitted.

```powershell
node --import tsx --test --test-concurrency=1 packages/domain/test/preferenceProvenance.test.ts packages/domain/test/combinedEdit.test.ts
```

Final result: **10 passed, 0 failed**, reported duration **2011.9253 ms**. Fault matrices contain five preference/clear paths and three combined-edit failure stages inside those tests.

Focused TypeScript validation loaded the actual repository options and both new tests as roots, including their transitive imports. Final result: **2 root files, 0 diagnostics**.

```powershell
$regressionCheckScript = @'
import ts from 'typescript';
const config = ts.readConfigFile('tsconfig.base.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const roots = ['packages/domain/test/preferenceProvenance.test.ts', 'packages/domain/test/combinedEdit.test.ts'];
const program = ts.createProgram(roots, { ...parsed.options, types: ['node'] });
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: p => p, getNewLine: () => '\n' }));
console.log(JSON.stringify({ rootFiles: roots.length, diagnostics: diagnostics.length }));
process.exitCode = diagnostics.length ? 1 : 0;
'@
node --input-type=module -e $regressionCheckScript
```

```powershell
node node_modules/prettier/bin/prettier.cjs --check packages/domain/test/preferenceProvenance.test.ts packages/domain/test/combinedEdit.test.ts packages/domain/evidence/T26/memory-v2-preferences.md
```

Result: all matched files use Prettier code style.

## Limits and review notes

The fresh in-memory fixtures serialize reads and writes on one connection; they do not prove independent-connection commit-acknowledgement recovery, disk reopen, native Expo SQLite or iPhone behavior. USER messages and immutable source-context rows are explicitly seeded to isolate commands; these tests do not prove `beginTurn`, model interpretation, memory selection or assistant acceptance validation. The existing API-1 conversation fixtures were not reused. No full workspace suite, install, build, server, emulator or provider call ran.

One initial combined-edit test incorrectly counted every quality annotation as shopping demand. Its oracle was corrected to count only `instruction_only_ingredient` annotations, matching the established source policy; no production change was needed. Initial fixture-only type issues were corrected to use the existing snapshot receipt reader and immutable query return types. No remaining production defect or execution blocker was observed within this bounded matrix. Lead integration/review and native proof remain outstanding.
