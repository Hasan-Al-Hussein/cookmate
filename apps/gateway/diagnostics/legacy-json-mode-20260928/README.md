# Historical grammar and JSON-mode diagnostics — 28 September 2026

This directory preserves the historical provider-grammar, MIME-only JSON proof, and generated-text diagnostic before the production JSON-mode candidate. It is archival context, not a production provider route or an automatic fallback.

`manifest.json` records source/destination paths, byte counts and SHA-256 hashes. All 27 checkpoint hashes from the three canonical documents matched the original files **before copying**. All 47 copied files matched afterward, and the originals were rechecked before production editing was released. Node was **v24.13.0** and the installed `@google/genai` SDK was **2.24.0**.

## Immutable originals and dependency context

- `src/`: byte-exact copies of all 25 original `apps/gateway/src/*.ts` files. Their relative imports remain unchanged and resolve within this archived source directory.
- `test/`: byte-exact copies of all 20 original `apps/gateway/test/*.ts` files, including helpers. These are evidence originals, not a relocated runnable test suite. Their historical CLI strings and working-directory assumptions remain untouched.
- `dependency-context/gateway-package.json`: byte-exact original `apps/gateway/package.json`.
- `dependency-context/package-lock.json`: byte-exact original repository-root lockfile.

The 27 explicit `checkpoints` in the manifest identify the precise live-execution freeze. The other 20 copied files provide surrounding source/test context; they are not additional claims about that live checkpoint. Never format or edit `src/`, `test/`, or `dependency-context/` copies.

This is not a standalone dependency installation. Workspace `@cookmate/*` packages and installed runtime dependencies resolve from the surrounding repository. The copied manifest and lockfile record dependency context; they do not authorize installation, lockfile replacement, or restoration over active work. Any future restoration should first verify every archived hash and use a separately authorized isolated checkout with the corresponding workspace dependencies. The `files` map identifies each original location without performing a restore.

## Separate offline verification adapters

`verification/` contains eight selected historical test adapters plus a copied `helpers.ts`:

- `provider-grammar.test.ts`
- `provider-schema.test.ts`
- `schema-control.test.ts`
- `memory-smoke.test.ts`
- `synthetic-output.test.ts`
- `synthetic-shape-diagnostic.test.ts`
- `json-mode-proof.test.ts`
- `json-mode-text-diagnostic.test.ts`

Their `../src/` imports already target archived source, and `./helpers` targets the copied helper. Only the two JSON-mode CLI tests need behavioral location adjustments: their child CLI paths point to archived `src/`, and `new URL('../../../../../', import.meta.url)` keeps the child working directory at the repository root. Adapter formatting is permitted; immutable `test/` originals remain unchanged. Adapter provenance and resulting hashes are recorded separately in the manifest.

The seven retired tests were removed from ordinary `apps/gateway/test/*.test.ts`; the active provider-schema test is owned by the production candidate. No active test imports this archive. Historical verification is an explicit separate offline command from the repository root:

```powershell
node --import tsx --test --test-concurrency=1 apps/gateway/diagnostics/legacy-json-mode-20260928/verification/*.test.ts
```

These selected adapters use fictional injected transports and fresh temporary CLI evidence paths. Snapshot creation and adapter preparation did not run this suite or make provider calls. The complete original `test/` directory also contains historical integration tests with location-dependent imports; it must not be treated as this selected runnable adapter suite.

## Historical CLI locations

The following are relocated historical entry points, shown for traceability only. They require separate explicit Root authorization before any live execution, an authorized `GEMINI_API_KEY` environment, and a fresh output path. Existing evidence must never be reused or overwritten. Importing these five diagnostic modules does not execute their guarded CLI main functions or make provider calls. The copied `main.ts` and launcher files are historical startup context, not diagnostic imports or production entry points.

Working directory for all examples: the repository root, `cookmate-app`.

```powershell
node --import tsx apps/gateway/diagnostics/legacy-json-mode-20260928/src/memory-smoke.ts --execute --models 'gemini-3.5-flash-lite' --output '<fresh-evidence-path>'
node --import tsx apps/gateway/diagnostics/legacy-json-mode-20260928/src/schema-control.ts --execute --model 'gemini-3.5-flash-lite' --output '<fresh-evidence-path>'
node --import tsx apps/gateway/diagnostics/legacy-json-mode-20260928/src/synthetic-shape-diagnostic.ts --execute --capture-fictional-model-json --model 'gemini-3.5-flash-lite' --output '<fresh-evidence-path>'
node --import tsx apps/gateway/diagnostics/legacy-json-mode-20260928/src/json-mode-proof.ts --execute --capture-fictional-model-json --model 'gemini-3.5-flash-lite' --output '<fresh-evidence-path>'
node --import tsx apps/gateway/diagnostics/legacy-json-mode-20260928/src/json-mode-text-diagnostic.ts --execute --capture-fictional-model-text --model 'gemini-3.5-flash-lite' --output '<fresh-evidence-path>'
```

The historical 3.8 comparison used the separately authorized `gemini-3.8-flash` model. These examples neither schedule nor authorize a repetition, model switch, retry, service start, or production activation. The archived diagnostic boundaries, sanitizers, request settings, budgets and validators are unchanged bytes; retained generated material remains untrusted data.

## Canonical documents and original evidence

All original reports remain at the canonical directory below; none were edited or copied over by this archival task:

```text
C:\Users\hp\OneDrive - ku.ac.ae\Desktop\CookMate\implementation\ai-gateway\
```

Checkpoint documents, whose own hashes are recorded in the manifest:

- `MEMORY_V2_GRAMMAR_SUPERSET_01.md` — the original 23 source/dependency rows.
- `MEMORY_V2_JSON_MODE_PROOF_01.md` — adds two rows for 25 total.
- `MEMORY_V2_JSON_MODE_TEXT_DIAGNOSTIC_01.md` — adds two rows for 27 total.

Original sanitized evidence paths within that same canonical directory:

- `memory-v2-grammar-superset-20260928-01.json`
- `memory-v2-json-mode-proof-20260928-01.json`
- `memory-v2-json-mode-text-diagnostic-20260928-01.json`
- `memory-v2-json-mode-text-diagnostic-20260928-02.json`

The snapshot records code provenance; it does not alter the conclusions, acceptance status, timing, or contents of these historical observations.
