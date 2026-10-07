# Repository construction checks

Evidence source: real desktop SQLite cases in `packages/domain/test/database.test.ts`; this is not native acceptance.

- All 100 recipes reconstruct exactly, including ingredient measures, passage order/headings, annotation order/evidence and raw optional fields.
- Concurrent read requests serialize snapshots on the dedicated read connection. Each ready result contains one coherent global store revision. Plan retains persistent shopping selection outside the queried week.
- Empty favourites/preferences are successful empty results. Unknown recipe/receipt IDs return null; hostile-looking strings are bound data. No similar-title fallback or dynamically built value SQL exists.
- Stored rows become ordinary immutable caller records. Favourites exclude unsaved tombstones and order by saved time; meals order by date and Breakfast/Lunch/Dinner; IDs stay stable.
- Invalid date ranges are rejected without querying/mutation. A malformed preference or receipt produces a typed failure without erasing it, while healthy favourites/plan queries remain readable. Missing revision metadata fails visibly. The reader is query-only.
- Independent review DSF-01 found a missing nested receipt semantic check. The repaired boundary rejects impossible/out-of-range plan-effect dates and unknown immutable recipe IDs while preserving valid historical effects after their live occurrences are removed. No live-row dependency was added to historical receipts.

Remaining: shopping/conversation repositories, post-commit subscription integration, guarded command execution and service factory; native query/statement/resource/reopen checks on an actual iPhone. Loading state belongs to the consuming provider/hook. These repository functions never write defaults during a failed read.
