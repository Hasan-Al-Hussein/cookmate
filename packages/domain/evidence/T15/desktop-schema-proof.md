# Schema construction evidence

Environment: Windows, Node 24.13.0, Node's experimental desktop SQLite adapter. This is not Expo/iOS device evidence and does not close T15 or T37 acceptance.

The schema and seed are `apps/mobile/src/data/schema.ts` and `initialize.ts`. `packages/domain/test/database.test.ts` exercises the actual DDL and parameterized seed against real SQLite, using the same serialized connection boundary as the native adapter.

Checked: 100 recipe rows, 960 ingredient rows, 706 ordered passages, six null measures, current annotation count, foreign-key enforcement on the actual writer before BEGIN, rejected orphan references, actual Gregorian dates and unique date/meal slots. A fault during ingredient insertion rolls back the entire new schema and version marker. A file-backed close/reopen retains existing state and installation ID. A newer schema, mismatched catalogue or nonempty unversioned database is rejected without reset/reseed. Both same-titled Alfredo IDs remain separate.

The Expo adapter opens an independent connection, enables/verifies foreign keys before any transaction, and configures the reader query-only. These calls have been typechecked against the installed Expo API but have not executed on a named iPhone/build. Native seed counts, interruption/resource behavior, process termination, file protection, two-installation isolation and performance remain unverified. No native-schema-proof or native seed-counts PASS is fabricated.
