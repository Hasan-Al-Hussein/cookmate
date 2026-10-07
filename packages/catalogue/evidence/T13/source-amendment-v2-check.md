# Source amendment v2 — staged execution result

28 September 2026. Brain authorized only the off-tree README steps 1–7. Those six staging commands passed once on the frozen candidate, with no candidate repair, retry or promotion. The sole local execution slot was released after completion; the remaining handoff work is read-only evidence review and reporting.

**Staged identity:** `cookmate-2026-09-28.v2`  
**Fingerprint:** `383be590385bea53149d7697ae7faed6b6098efda12e7679a0524cfaab2df217`

The output is `runs/run-01/package` in the canonical `implementation/data/source-amendment-v2-20260928` folder. It is a prepared content package, not a deployed or accepted app bundle.

## Executed evidence

| Step | Exit | Process duration | Result |
| --- | ---: | ---: | --- |
| `01-prepare` | 0 | 1,751 ms | 100 recipes, 960 ingredients, 706 passages, 124 headings, 100 photos, 20 notes; new identity computed |
| `02-verify` | 0 | 1,515 ms | 8,824 source cells, zero differences, 100 date serials, six reproducible derivatives and 100 reproducible photos |
| `03-exact-delta` | 0 | 194 ms | Complete raw recipe data unchanged; only the approved note, treatment and identity changes |
| `04-publication-rejections` | 0 | 1,252 ms | All four controls rejected at their expected reason before writing publication evidence |
| `05-annotation-register` | 0 | 181 ms | Versioned register with all 20 notes, exact source excerpts and retained metadata gaps |
| `06-photo-publication` | 0 | 190 ms | Versioned 100-row CSV and publication metadata; two later photo dispositions applied |

Each named step directory records the exact executable and argument array, runtime executable hash, working directory, relevant environment overrides, timestamps, exit code, stdout/stderr hashes, protected-input hashes before/after and an output-file manifest. All six stderr files are empty. Python is 3.11.9; Node 24.13.0 was recorded only, with no Node application checks. Process duration excludes the surrounding hashing/reporting time.

Preflight compared the final 19-file candidate manifest, all 84 preserved source/copy entries, preservation ledgers and source/production/original photo locations. All **496 unique protected paths** matched. Every command's before/after snapshot matched the same expected hashes, with **zero drift**. Candidate source, originals, production catalogue/evidence and historical review files stayed unchanged. The verifier's repeat build and rejection-control temporary fixtures were confined to this run's `temp/` directory and cleaned by their context managers. `-B` and `PYTHONDONTWRITEBYTECODE=1` prevented candidate bytecode writes.

## Exact permitted difference

Three of six preparation derivatives changed:

- `generated/catalogue.json`: new identity and the three approved source-gap notes.
- `generated/provenance.json`: exactly two appended photo-treatment exceptions.
- `evidence/T13/source-to-derived-reconciliation.json`: new identity and 20-note count.

`evidence/T13/source-records.json`, `evidence/T13/asset-path-manifest.json` and `src/photo-assets.ts` are byte-identical to v1. All 100 staged photos match the original asset manifest. The first 17 reviewed annotations retain their full objects and order; the appended notes are exactly 53389 photo uncertainty, 53318 photo uncertainty and 52982 ingredient/method conflict. The original three photo exceptions, existing warnings and CHILI TO CHOC credit remain unchanged. No ingredient, measure, passage, source URL, category, photo, instruction-only demand or source rule changed.

The four rejection controls cover pending review, changed original annotation text despite a renewed annotation hash, removed credit treatment, and wrong-owner prepared annotation despite a recomputed catalogue fingerprint. The checker asserted each specific error and absence of a T14 output directory. These temporary negative fixtures were deleted after checking; their stdout names, checked source code and process receipt are retained, not separate per-control traceback artifacts.

## Versioned publication and limits

Only new staged T14 filenames were written: `annotation-register.v2.json`, `all-100-photo-review.v2.csv`, and `photo-review-publication.v2.json`. The CSV has separate historical inspection/result and current disposition fields. Recipes 53389/53318 retain their original historical results and receive the addendum's uncertainty disposition. In particular, 53318's historical individual-original field remains false; it was not relabelled as a new inspection. Existing 53208/53230 warnings and 53262 credit remain. The publication explicitly records `freshAll100Inspection: false`, `nativeAcceptance: false`, and `rightsClearance: false`.

One console-only setup display issue is retained in `copy-console-note.md`: `Select-Object` over ordered dictionaries displayed null summary fields. Work paused and the complete saved copy receipt was inspected; both real file paths and hashes matched. No application failure, source correction, copy repeat or oracle change occurred. Brain was informed before verification continued.

The final package has **112 files**, including the unchanged 100 photos. `06-photo-publication/output-manifest.json` SHA-256 is `5f29e71d6d8228938e56213e915e6ecf70673c6cda5a72a3aed03e6803e30e07`. The original candidate manifest remains unchanged at `5d150f8fee31f03bc5da951719debc5d5369a534554f482516afa26bf9b7b2e5`; its earlier NOT_RUN status is a historical authoring checkpoint, superseded only by this separate run evidence.

No live files were promoted. Catalogue/domain/UI tests, typechecks, SQLite/database behavior, actual 966-contribution/601-group shopping execution, consumer identity/pairing/fixture consistency, provider use, native display and release acceptance remain **NOT_RUN in this lease**. Identical raw inputs and unchanged instruction-only notes support the intended demand boundary; they do not replace the separately authored shopping/database tests. Existing databases remain preserved under their original identity, with no migration/reset or filename workaround.

`promotion-manifest.json` lists the exact proposed next source/destination paths and hashes for Brain review. It is an inventory, not an executed copy plan or promotion authorization. Keep all historical T13/T14 evidence intact; the new independent reconciliation has a versioned promotion filename. Brain must inspect the staged delta and coordinate coherent phone/gateway/fixture identities before authorizing any later live promotion and checks.
