# Native persistence boundary

Status: T15/T16 implementation exists with desktop SQLite evidence; actual iPhone acceptance remains pending. It consumes frozen shared contract v1 and Brain's adopted decisions, with the iPhone-only amendment. Brain accepted T13/T14 after the full photo/source review. The catalogue and17 separate source-backed annotations remain stable; T72/native display and rights acceptance remain open.

## Ownership and imports

`packages/domain` owns pure command preparation, retrieval and repository-facing types, including exact quantity parsing and source-linked shopping projection. It must not import Expo, React, filesystem, provider, or SQL adapters. `apps/mobile/src/data` owns native SQLite connections, statements, schema and the seed under the frozen contract. `apps/mobile/src/domain` supplies native hashing/IDs and will compose the service factory. Screens consume the facade rather than database handles. The gateway uses the same read-only catalogue/retrieval and cannot import the phone mutation facade.

## Connections and serialized writes

Implemented connection design: a privately held dedicated write connection opened with `useNewConnection: true`, plus a separate query-only read connection. All writes, initialization, clear and receipt reconciliation must pass through one queue. Nothing outside the data/domain adapter receives the write connection. Each fresh connection enables `PRAGMA foreign_keys = ON` and reads the value back before statements or transactions. A failure closes that connection and returns a typed storage failure. The read connection also receives foreign-key enforcement and its own snapshot queue; it is not used as a fallback writer.

The adapter controls `BEGIN IMMEDIATE`, callback-scoped repositories, `COMMIT` and `ROLLBACK` on that same initialized writer. Every repository method in a command receives the scoped handle. Do not call Expo's ordinary asynchronous transaction method on a shared connection. Do not assume an outer connection configures the fresh connection used by `withExclusiveTransactionAsync`. No provider/network/user wait occurs inside a transaction. Queue rejection must not poison subsequent work; a failed rollback invalidates the connection until explicitly reopened and checked.

Expo documents separate new connections and transaction-scoped handles, and recommends finalizing prepared statements. These support this proposed adapter design; they are not device evidence. [Expo SQLite API](https://docs.expo.dev/versions/latest/sdk/sqlite/). SQLite makes foreign-key configuration ineffective during an already-open transaction, so setting it inside a transaction callback is too late. [SQLite foreign_keys](https://www.sqlite.org/pragma.html#pragma_foreign_keys).

Raw `execAsync` is reserved for fixed application-authored schema/transaction/PRAGMA strings. Values always use bindings. Prepared statements are finalized in `finally`, including seed failures; the scoped transaction also closes leaked handles exactly once before commit/rollback. Cleanup failure invalidates the connection. A read snapshot runs in one serialized read transaction rather than combining independently changing revisions. WAL, busy timeout, synchronous settings and connection lifecycle require measured native proof before performance claims.

## Schema v1 tables and keys

| Table | Key and content | Integrity and lifecycle |
| --- | --- | --- |
| `catalogue_manifest` | singleton, catalogue version/fingerprint and expected counts; preparation/source hash details remain in packaged provenance | Published in the seed transaction only after counts/joins/identity validation. Immutable via ordinary commands. |
| `recipe` | source text ID, exact title/category/cuisine/tags, photo key, recipe/publisher/video URLs, source row | No title uniqueness/deduplication; nullable source fields remain null. Record photo provenance separately from recipe publisher. |
| `ingredient_entry` | `(recipe_id, position)`, raw name, nullable raw measure, source row/column | Foreign key to recipe, positive position, exact repeats retained. No parsed amount replaces raw text. |
| `instruction_passage` | `(recipe_id, sequence)`, raw text, heading/passage presentation, source row/column | Foreign key to recipe, positive sequence, source ordering remains intact. |
| `quality_annotation` | `(recipe_id, annotation_id)`, kind, note, rule version | Foreign key to recipe; runtime note distinct from raw recipe text. |
| `annotation_evidence` | `(recipe_id, annotation_id, ordinal)`, sheet/row/column | Composite foreign key to annotation. Seed verifies every locator belongs to that recipe. |
| `state_revision` | named collection key, monotonic nonnegative revision | Persist collection revisions across removals/clears. Do not reset a revision because a collection becomes empty. |
| `favourite` | recipe ID, saved boolean, revision, saved/updated timestamp | Recipe foreign key. Retain a false tombstone for revision continuity after unsave; do not delete plans or recipes. |
| `plan_occurrence` | UUID ID, recipe ID, local date, meal key, revision, created/updated timestamps | Recipe foreign key; unique `(local_date, meal_key)`. Validate real Gregorian date within 1900–2100 before SQL; database checks enforce shape/bounds and allowed meals. |
| `shopping_scope` | singleton scope UUID, revision, projection revision/status | One persistent deliberate selection; visible week is not a key. |
| `shopping_selection` | `(scope_id, occurrence_id)` | Foreign keys to scope and occurrence; occurrence deletion removes only its selection. New occurrences are never auto-selected. |
| `shopping_group` | `(scope_id, group_key)`, grouping version, demand fingerprint, projection revision, display form | Regenerated from exact selected occurrence/source identities. No implicit conversion/servings/pantry. |
| `shopping_contribution` | `(scope_id, occurrence_id, source_kind, source_key)`, recipe ID, ingredient position OR annotation ID, group key, raw measure, exact parsed numerator/denominator/unit if supported | Exclusive ingredient/annotation source columns with composite foreign keys prevent cross-recipe references; selected occurrence and group foreign keys. Repetition identity includes source position. Annotation demand has no inferred amount. |
| `purchase_state` | `(scope_id, group_key)`, applicable demand fingerprint, purchased, changed, revision | Foreign key to group; untouched demand retains status. Any fingerprint change unchecks with a visible review cue; deleted/re-added occurrence does not inherit credit. |
| `saved_preference` | UUID, fixed supported type, explicit value, revision | Snapshot revision stored independently. No arbitrary keys or implicit save; no dependency on a retained transcript. |
| `conversation` | current UUID, generation, composer draft, next message sequence | One current conversation. Clear advances generation and clears draft/history/references/uncommitted proposals, preserving committed state and receipts. |
| `message` | UUID, conversation ID/generation, sequence, role, text, lifecycle/status, timestamp | Unique `(conversation_id, generation, sequence)`. No automatic action replay from old text. |
| `reference_set` / `reference_item` | set ID, message ID, display-order position, recipe ID | Ordered actual shown IDs. Recipe FK; no replacement of an old set with a newly ranked set. |
| `pending_intent` / `command_slot` | intent UUID/revision/phase, optional origin, frozen slots/commands, relative-date guard | Strict contract-validated JSON for frozen commands. No network secrets. Clear/cancel invalidates uncommitted intent; dispatched work requires receipt reconciliation. |
| `operation_receipt` | operation UUID, intent ID, frozen fingerprint, outcome, committed timestamp, projection state, validated effects JSON | Written atomically with mutation. No foreign key to message/conversation/pending intent: direct UI receipts need no origin, and clear must retain receipts. |
| `app_metadata` | schema version, installation ID, view restoration data | Provider/pairing credentials excluded. View metadata never substitutes for domain truth. |

Source-referencing foreign keys use `RESTRICT` for recipe/content removal. No catalogue update may silently cascade into a user's saved work. Only relation cleanup explicitly authorized by a domain command may cascade (for example, one occurrence's selection); source replacement/migration needs a tested compatibility path.

Schema checks alone do not establish authorization. JSON payloads are validated on both write and read; malformed stored rows become typed failures instead of empty defaults. Recipe IDs remain strings. Dates stay calendar strings; UTC timestamps are separate and cannot be used to shift meal placement.

## Query and command facade

The canonical typed ports are `packages/domain/src/services.ts`: `CookMateQueries`, `CookMateCommands`, `CookMateServices` and their versioned snapshots. The schema and interfaces are separate from a completed service factory. Catalogue, favourites, plan (with persistent cross-week scope), shopping, preferences, receipt and conversation reads are implemented. Registered execution and concrete command handlers exist with desktop SQLite proof. Full assistant memory/intent and provider-level composition remain pending; combined editing awaits the coordinated scope-guard field. Screens must keep unavailable mutations unavailable until those adapters exist.

`createCommandPreparer` assigns app IDs, clones before asynchronous hashing, validates intrinsic/source facts, and freezes one exact command for retries. It does not read current state or grant authority. Loading/initialization lives in the facade/hook lifecycle; `ready` with an empty list is distinct from `failed`. Unknown IDs return explicit not-found, never a similarly named recipe. Initial reads never write defaults over a failed/corrupt collection. Related read values and the global store revision share one serialized snapshot. Malformed saved state fails only its affected query and never causes a reset.

Execution order is fixed: strict intrinsic command validation → recompute frozen SHA-256 input → receipt lookup/conflict check → current local intent/generation/date/target/shopping/preference guards → mutation/projection/revision → receipt → commit. A hash is an equality guard, not permission. Return committed/no-op only after confirmed commit. A lost acknowledgement is uncertain and must reconcile the actual receipt, without applying the command again under a new ID.

Occupied add updates B in place under its guards. Occupied move atomically removes B and moves A, keeping A's ID and validated selected/unselected state, never inheriting B's selection. Both occurrence revisions and the relevant shopping-scope revision must match. Test all four selection combinations. Same-identity no-op preserves purchases/revisions as documented; unrelated occupied add remains a conflict.

## Initialization and proof gates

Initialize schema, source seed, annotation version, empty collection metadata and manifest in one controlled write transaction. Inspect the existing schema/version before creating anything. A newer/unknown version or mismatched installed catalogue yields explicit incompatibility; no reset, reseed-over-state, or delete-and-recreate recovery. Only a genuinely fresh database receives initial defaults. Atomically validate all 100/960/706 counts, foreign-key checks, source locators and identity before exposing ready.

Required later evidence on a named iPhone/native build: orphan rejection on the actual writer, rejected malformed dates and duplicate slots, interrupted seed/reopen, ordinary no-reseed reopen, out-of-callback write isolation, rollback at each mutation stage, committed receipt after lost acknowledgement, clear/commit ordering, hostile bound values, statement cleanup after exceptions, two independent installations, process termination/reopen and compatible-schema updates preserving state. Desktop/pure fixtures can aid implementation but cannot close T15/T16/T37 or performance acceptance.

