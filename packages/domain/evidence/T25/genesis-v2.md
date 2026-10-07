# T25 — unreleased SQLite genesis v2

28 September 2026. This is focused desktop storage evidence for the approved temporary-memory amendment. It is not full T25, memory integration, native iPhone, or provider acceptance.

## Owned changes

- `apps/mobile/src/data/schema.ts`: `SCHEMA_V2` adds eight separate tables for conversation memory state, immutable source context, source review, memory entries/relations, the preference removal watermark, source preference links, and immutable assistant acceptance acknowledgements. Existing message and assistant context columns retain their original INSERT shapes; the assistant context storage envelope remains version 1.
- `apps/mobile/src/data/initialize.ts`: fresh genesis creates memory state for the actual conversation ID with generation/revision 0, null boundary and empty carry IDs, plus the null preference removal watermark. `PRAGMA user_version` uses the shared `DATABASE_SCHEMA_VERSION`, now 2.
- `apps/mobile/src/data/schemaCompatibility.ts`: validates every normalized table/index definition and rejects missing, changed or extra application objects. SQLite-owned `sqlite_%` objects remain excluded.
- `packages/domain/test/schemaCompatibility.test.ts`: ten focused tests cover fresh and repeated initialization, incompatible storage preservation, new constraints and deletion behavior.

No existing database is migrated, reset, deleted or reseeded. Versions 1, unknown versions and unversioned databases with existing tables return incompatibility. The original catalogue identity and operation receipt schema version 1 remain unchanged.

## Storage decisions

JSON limits use UTF-8 byte length, not JavaScript string length: 4,096 bytes for source DateContext, memory scope and working carry selection; 524,288 bytes for the acceptance acknowledgement. Carry selection is a JSON array limited to 32 IDs. The application validates IDs, source role/generation/sequence/date, complete JSON structures, relation direction/cycles, source equality and semantic revisions.

Memory entries reference retained messages and never duplicate the original quote. Source preference links preserve the supported preference type and exact value. The DDL enforces a 1–1,024-byte UTF-8 envelope, accommodating at most four bytes per permitted code point; the shared application validator enforces the actual 1–256-code-point limit. SQLite `length(TEXT)` stops at NUL, so it would incorrectly reject a valid NUL-only value and incompletely enforce the upper limit. The byte envelope preserves embedded NUL without pretending to replace shared validation. Their identity is `(source_message_id, preference_id, saved_revision)`; there is deliberately no foreign key to the mutable saved-preference row. This permits retained removal provenance after a saved row is removed or replaced.

The source link's `save_operation_id` references `operation_receipt` with `DEFERRABLE INITIALLY DEFERRED`. A link can precede its successful receipt within one transaction, but commit fails if the receipt is absent. Deleting its source message removes the link, while deleting a linked receipt is rejected. Target-memory and preference/version indexes support relation traversal/cascades and version withdrawal lookup.

Source context, source review, entries and source links cascade from message deletion. Relations cascade from either memory endpoint. Acceptance and frozen assistant context cascade from pending-intent deletion. Conversation memory state cascades from conversation deletion. The preference watermark, saved preferences and committed operation receipts survive these deletions.

## Checks actually run

Environment: Windows PowerShell, Node **v24.13.0**, `node:sqlite` SQLite **3.50.4**. `node:sqlite` emitted its standard experimental warning. Working directory was the `cookmate-app` root.

```powershell
node --import tsx --test packages/domain/test/schemaCompatibility.test.ts
```

Final result after the byte-envelope/NUL correction: **10 tests passed, 0 failed**, reported duration 704.2259 ms. Checks covered:

1. Fresh database version 2, correct singleton defaults and repeat initialization without writes or replacement identities.
2. Version 1/3/99 and unversioned retained-state rejection, with `total_changes()` unchanged and no new/reseeded tables.
3. Missing/altered tables, missing indexes and extra application tables rejected without touching saved favourites/installation identity/version.
4. Working-state foreign key, negative revision/boundary, invalid JSON, non-array carry, 33 carry IDs and excessive UTF-8 bytes rejected; 32 carry IDs accepted.
5. Source context/review/entry/relation foreign keys, disposition/kind enums, nonnegative revisions, unique source identity/relation identity and bounded UTF-8 JSON.
6. Supported preference types and the 1–1,024-byte storage envelope, including 256 supplementary Unicode code points, exact NUL-only/embedded-NUL stored bytes and JSON-decoded reads, version identity, retained old versions without a live preference row and receipt-deletion rejection. The shared validator accepts both valid NUL examples and rejects 257 ASCII characters; raw SQL deliberately accepts the latter within its byte envelope.
7. Link-before-receipt transaction success, missing-receipt commit rejection and rollback of both the link and watermark write.
8. Acceptance intent ownership, fixed normalization version, fingerprint length, valid JSON, exact 512-KiB boundary and single acceptance per intent.
9. Message/intent/conversation deletion cascades, including deletion of a relation target, while saved preferences/watermark/receipt survive; no foreign-key violations remain.
10. Existing assistant context storage-version/lifecycle/byte bounds and intent cascade behavior independent of receipts.

Focused TypeScript compiler validation loaded the repository's actual `tsconfig.base.json` options and used only the four owned TypeScript files as roots, with their transitive imports. It reported **4 root files, 0 diagnostics**:

```powershell
$schemaCheckScript = @'
import ts from 'typescript';
const config = ts.readConfigFile('tsconfig.base.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const roots = ['apps/mobile/src/data/schema.ts', 'apps/mobile/src/data/initialize.ts', 'apps/mobile/src/data/schemaCompatibility.ts', 'packages/domain/test/schemaCompatibility.test.ts'];
const program = ts.createProgram(roots, { ...parsed.options, types: ['node'] });
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => process.cwd(), getCanonicalFileName: p => p, getNewLine: () => '\n' }));
console.log(JSON.stringify({ rootFiles: roots.length, diagnostics: diagnostics.length }));
process.exitCode = diagnostics.length ? 1 : 0;
'@
node --input-type=module -e $schemaCheckScript
```

```powershell
node node_modules/prettier/bin/prettier.cjs --check apps/mobile/src/data/schema.ts apps/mobile/src/data/initialize.ts apps/mobile/src/data/schemaCompatibility.ts packages/domain/test/schemaCompatibility.test.ts packages/domain/evidence/T25/genesis-v2.md
```

Result: **all matched files use Prettier code style**. The owned DDL, initializer and compatibility code were also read after editing.

## Integration boundaries and remaining proof

No full workspace suite, installation, server, build, emulator, native SQLite or iPhone check ran. Application-level source validation, working-context selection/reset, atomic acceptance/fingerprint replay, preference save/remove/clear behavior and real command receipts are owned by the integrating data lane. The direct SQL cascade fixture proves schema behavior, not the complete public conversation-clear command.

A NUL fixture initially failed an ordinary `SELECT value` assertion: Node v24.13.0's raw TEXT conversion returned an empty string for NUL-only text and `Italian` for `Italian\0tonight`. Underlying bytes were preserved (`00` and `4974616C69616E00746F6E69676874`), and `json_quote(value)` followed by `JSON.parse` returned the exact original strings. The final schema test asserts stored hex and the JSON extraction path, not raw-driver text fidelity. The lead was informed and owns the required application read-path adaptation; native Expo behavior remains untested.

At this check, the unowned `packages/domain/test/database.test.ts:55` still asserted `user_version === 1`. This was reported to the lead for the coordinated version update, and was not modified here. No unowned handler, repository, shared contract or root file was edited.
