# CookMate catalogue

The offline preparation reads the preserved workbook and checks its hash plus all 100 photo hashes. It copies photos unchanged, retains source cell values/storage types separately, and emits contract-shaped recipes. The source workbook, PDF and images are never edited. There are no network imports.

## Consumer surface

`@cookmate/catalogue` exports `catalogue`, `catalogueBoundary`, `getRecipe(recipeId)`, `identity`, `createCatalogue` and immutable catalogue types. `getRecipe` uses exact IDs and returns `undefined` for unknown IDs. It never falls back to a similar title. `catalogue.recipes` retains source order. Source records and nested children are frozen, and the validation boundary does not expose mutable membership.

`catalogueBoundary` implements the Foundation `CatalogueBoundary` contract. A citation must belong to the named recipe and match its discriminated shape. Ingredient positions and instruction sequences are local to that recipe. Annotation IDs cannot be borrowed from another recipe.

The separate `@cookmate/catalogue/photos` export supplies `recipePhotoAssets`, a literal native `require` map. Gateway code must not import this native asset module. The map refers to packaged files, without the source author's absolute paths. Decode/render only visible images. Preserve full frames where the review identifies marks or crop risks.

Catalogue/domain workspace wiring was coordinated through Brain/Foundation. This lane owns its granted package manifest; root lockfile/dependency refresh remains coordinated.

## Reproduction

Run the Python utilities from the workspace root with the canonical documentation folder as the source argument:

```powershell
python scripts/content/prepare_catalogue.py --source-dir '<canonical CookMate folder>' --output-dir '<new-empty-package-dir>' --annotations packages/catalogue/reviewed-annotations.json --photo-treatment packages/catalogue/reviewed-photo-treatment.json
python scripts/content/verify_catalogue.py --source-dir '<canonical CookMate folder>' --package-dir '<same-output-package-dir>' --annotations packages/catalogue/reviewed-annotations.json --photo-treatment packages/catalogue/reviewed-photo-treatment.json
```

Preparation automatically includes the canonical `reviewed-annotations.json` when present; an explicit `--annotations` argument selects a reviewed input for a controlled fixture. No timestamp or machine path enters the content fingerprint. The fingerprint covers recipes, annotations, provenance, raw-source-record fingerprint and image hashes. Version and fingerprint must match between phone and gateway. A reviewed content change requires regeneration and matching consumer deployment; never retain a stale identity.

The immutable cell archive includes all 8,824 source cells and preserves a missing cell separately from a present blank/text cell. Excel numeric fetched-date serials stay in that archive; the provenance view expresses the column explicitly labelled UTC as ISO timestamps. Display/search normalization must not overwrite source fields. Repeated ingredients and all 124 heading-only passages remain separate ordered records.

## Evidence and limits

`evidence/T13` contains source reconciliation, source records, packaged asset paths and independent repeatability checks. `review` contains the specialist's visual and annotation review. No content hash, Node test or desktop SQLite check proves native iPhone behavior. Photo inspection cannot prove hidden ingredients, culinary correctness, safety or publication rights. The all-100 review and runtime annotation publication are separate gates from faithful preparation.

The v2 source-note amendment retains the original 17 notes and appends three source gaps, with two additional full-frame photo exceptions. Raw source text, quantities, demands and photo bytes remain unchanged. Existing databases with a different version or fingerprint must be preserved and rejected; no migration or reset is supplied. Use fresh disposable state for new-identity checks and keep phone/gateway/pairing identities coherent.

Versioned T14 publication requires explicit selected inputs: `record_annotation_evidence.py --package-dir <prepared-package> --annotation-audit <versioned-audit>` and `publish_photo_evidence.py --package-dir <prepared-package> --publication-inputs <versioned-input-manifest>`. The prepared package must contain the exact reviewed annotation and photo-treatment input files used for generation. The v2 outputs have `.v2` filenames. Preserve the v1 audit, review, CSV, annotation register and publication as historical evidence; the v2 addendum does not claim a fresh all-100/full-size inspection. Do not run the historical v1-hardcoded `review/build_review.py` against v2 inputs. The amendment's off-tree package under canonical docs `implementation/data/source-amendment-v2-20260928` records the selected input hashes, preservation and serial promotion procedure.
