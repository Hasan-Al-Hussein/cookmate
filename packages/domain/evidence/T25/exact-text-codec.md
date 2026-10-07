# Exact local text preservation

28 September 2026. Desktop SQLite evidence, not native iPhone acceptance.

A direct Node24/SQLite3.50.4 probe showed raw TEXT retrieval stopping at embedded NUL. Selecting json_quote preserved the stored NUL. A second probe showed the input `before\ud800after` changed to U+FFFD during raw TEXT binding itself; selecting JSON afterward could not recover it.

The unreleased genesis2 implementation now stores JSON.stringify(string) in message.text, conversation.composer_draft, saved_preference.value and source_preference_link.value. Reads parse these columns exactly once through storedText.ts. Writes use encodeStoredText. The JSON envelope escapes NUL and unpaired UTF-16 surrogates before the SQLite binding; literal JSON-looking user strings stay literal. Schema constraints require a JSON string and bound the encoded bytes. Shared contract validation still owns semantic/code-point limits. Existing JSON request/response/command/acknowledgement columns are unchanged and are not double-decoded. Source catalogue text/search/photo identity is untouched. No migration, reset, dependency or shared contract change was made.

The full serial catalogue/domain suite passed142/142,29.252s, saved `evidence/current/memory-v2-integrated.tap`. The focused memory/localStore/preference suite passed25/25,11.937s, saved `evidence/current/text-codec-roundtrip.tap`; subsequent scope regression passed in the10-case memory run. Domain TypeScript passed. These are saved intermediate checkpoints; independent review and later fixes have their own evidence.

Tests cover exact NUL, lone high/low surrogates (including256 worst-case escaped code points), NFD combining text, emoji and literal JSON-looking values; real preference save/read/no-op duplicate/provenance comparisons; USER history/memory quote, assistant reply, draft, immutable acknowledgement and carry scope after disk reopen; acceptance rollback before exact retry. The disk-reopen USER fixture was subsequently strengthened by separating an adjacent surrogate pair; its isolated rerun passed1/1. Factory preference reopen also checks unchanged command receipt replay and duplicate no-op comparison.

All four raw-column production reads/writes were searched. There is no user-text FTS or SQL value-comparison path; preference duplicate matching uses decoded public values. Catalogue search is source-only and unchanged. Source annotations remain a separate deferred follow-up.

Native Expo SQLite binding and process-kill behavior still require actual iPhone proof. Independent integrated review is recorded separately in `memory-actions-codec-review.md` when complete.
