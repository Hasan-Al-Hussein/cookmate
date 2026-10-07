# Source preparation and repeatability

Prepared directly from the immutable original workbook with Python standard-library ZIP/XML parsing. All source workbook/PDF/photo hashes matched preservation manifests before preparation and were rechecked afterwards. Source formulas are rejected rather than evaluated. The current workbook's declared columns, record counts, ID joins and per-recipe positions are asserted before writing derivatives.

An independent preserved extraction was then compared against all 8,824 cells. The 100 numeric Excel fetched-date serials were reconciled to the preserved interpreted timestamps; raw serials remain intact. No other field differences occurred. Runtime fields, raw ingredient measures, passage text/order and heading presentation were also compared against that extraction.

A second preparation in an isolated temporary directory matched all six generated source/runtime/evidence/module files byte for byte. All 100 packaged image hashes matched both the original manifest and the second build. See independent-reconciliation.json for the checked identity. The export has no build timestamp or absolute input path in its fingerprint.

The first verifier run exposed its incorrect historical JSON key assumption; this was corrected to `complete_values`/`integrity`. Its next run exposed the expected Excel numeric-date versus interpreted-string representation, now explicitly reconciled without changing raw source records. No original was modified to make either check pass.

No native iPhone test, semantic image acceptance, URL reachability or rights clearance is implied. Annotations change the content fingerprint and require repeating these checks.
