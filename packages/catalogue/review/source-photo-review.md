# CookMate source/photo review — 28 September 2026

All **100 preserved photo frames** were visually reviewed against their exact workbook IDs/titles. **98 are broadly consistent at dish-form level; 53230 and 53208 have unresolved photo/text associations.** This is source evidence for T14, not native iPhone acceptance, culinary verification, or rights clearance.

The main deliverable is [photo-review.v1.json](photo-review.v1.json): one record per ID with a concrete visual observation, title-match limits, watermark/background-text findings, quality and crop caveats, inspection method, dimensions, hash and workbook provenance. [source-annotation-candidates.v1.json](source-annotation-candidates.v1.json) records 11 source-linked findings. [published-annotation-audit.v1.json](published-annotation-audit.v1.json) independently checks the lead's 17 published notices and their supplied source locators.

## Findings affecting presentation

| ID / exact source title | Observed evidence | Disposition |
| --- | --- | --- |
| 53262 — Adana kebab | The original has **© CHILI TO CHOC** near the lower right. `Recipes!J6` points to BBC Good Food; `I6` is a TheMealDB image URL. | Preserve the full frame and credit; retain image and recipe attribution separately. The evidence does not resolve authorship or permission. A centered 4:3 crop removes this mark. |
| 53230 — Purple sprouting broccoli tempura with nuoc cham | The original shows green broccoli stalks with thin sliced garnish and no obvious batter. `Instructions!D499/D501` describe battering and frying. | Preserve the supplied image with an association-uncertainty notice. Do not infer garnish ingredients or silently replace the photo. |
| 53208 — Thai coconut & veg broth | The original shows curled, segmented orange prawn-like forms. `Recipes!C99` is Vegetarian, while `Ingredients!D892:D904` contain no prawn/shrimp entry. | Preserve image, source category and ingredients with an association-uncertainty notice. Neither image nor category establishes dietary safety. Do not add ingredients from pixels. |
| 53281 — Algerian Kefta (Meatballs) | Strongly coarse detail and blocky edges in the original. | Retain source; avoid oversized hero treatment and inspect actual delivery size. |
| 53289 — Chorba Hamra bel Frik (Algerian Lamb, Tomato, and Freekeh Soup) | Strong pixelation obscures fine soup contents in the original. | Retain source; only soup-level visual matching is supported. Do not imply enhanced detail. |
| 53260 — Slow-roast lamb with cinnamon, fennel & citrus | Strong pixelation and blocky roast/herb edges in the original. | Retain source; avoid oversized treatment. The named species and seasonings cannot be verified visually. |

No other overlaid photo credit was observed at the inspected scale. Background print was separately checked on **52831** (placemat advertising), **53025** (paper beneath food), **52896** (branded condiment/drink labels), and **53030** (partial mat/menu lettering). Those observations are not additional photo-credit findings or endorsements. Faint/embedded marks could still be missed.

Tall subjects such as Alfajores **53138**, Beetroot pancakes **53316**, the glass bowl **53307**, and Salmon Eggs Eggs Benedict **52962** lose recognizable layers/base/top in wide crops. Individual caveats for every recipe are in the JSON. These are visual and geometry recommendations; no native crop was rendered. A centered 4:3 crop of a square removes 12.5% from both top and bottom; 16:9 removes approximately 21.9% from each.

## Verified workbook candidates

The workbook was reparsed read-only using standard-library ZIP/XML, rather than relying solely on the earlier extraction. Exact source values are retained in [workbook-cell-evidence.json](workbook-cell-evidence.json).

| ID | Independent source check | Annotation consequence |
| --- | --- | --- |
| 53262 | `Instructions!D7` explicitly says **1½ tsp flaky sea salt**; none of `Ingredients!D6:D10` names salt. | Missing structured row; preserve the actual prose amount. DEC-10 shopping review policy remains separate from source quantity. |
| 53150 | `Instructions!D466` says **some sea salt**; `Ingredients!D678:D679` list oil and peppers. | Missing structured salt row; no exact amount supplied. |
| 53064 | `Instructions!D327` calls for salt in the pasta water and seasoning; no salt in `Ingredients!D507:D512`. | Missing structured salt row; no exact amount supplied. Black Pepper is listed at D512 with blank E512. |
| 52835 | `D329` calls for black pepper but says not to add salt **at that stage**. `D330` positively calls for **2 tsp salt**. Both lack structured rows in `Ingredients!D513:D519`. | Separate pepper and salt notices; do not interpret the earlier prohibition as salt demand. |
| 52835 | `Instructions!D331` offers **chives or parsley**. Parsley **is present** at `Ingredients!D519`, measure **Chopped** at E519. | Reject a parsley-omission claim. Chives is an alternative, not a requirement to purchase both. |
| 53076 | `Instructions!D149` is the sole instruction: **Make and enjoy**. Original publisher/video cells `Recipes!J27/K27` are blank; the TheMealDB recipe page remains populated. | Limited-guidance notice; the photo cannot supply the missing method. |
| 53230 | `Instructions!D499` calls for **a large pinch of salt**; none of `Ingredients!D725:D734` names salt. | Missing structured salt row; retain the phrase without inventing a numeric conversion. |

All six known blank measures were independently rechecked: **53138 E22**, **53064 E512**, and **52957 E565/E567/E568/E569**, with their corresponding ingredient names in column D. Blank is unprovided, not zero. Similar Alfredo titles and the three eggs-in-sauce records remain distinct IDs; no source title, repetition or measure was normalized by this review.

The 17 current annotation texts and every supplied cell locator are supported by this bounded review. The audit pins their file SHA-256 so later changes do not inherit this review automatically. The lead's declared full-frame exceptions for **53262/53230/53208** match the evidence. Actual UI publication, notice visibility and credit-preserving rendering remain the implementing/reviewing lanes' responsibility.

## Checks actually performed

- Opened **25 labeled 2×2 inspection sheets** with `view_image(detail="original")`, covering all 100 full frames. Panels are 700×700; 98 originals have that size. The 698×698 image **52968** and 800×800 image **52982** were resized only in inspection sheets, then opened directly at original detail.
- Directly opened **17 originals** for watermark, background text, uncertain association, quality or exceptional dimensions: 52831, 52896, 52968, 52982, 53006, 53011, 53025, 53030, 53053, 53092, 53208, 53230, 53260, 53262, 53281, 53289, 53389.
- Matched all **100 photo SHA-256 values** to the photo manifest before and after review. Decoded all 100; checked their sizes. Joined all 100 ID/title/photo-path/image-URL/publisher-URL records to freshly parsed workbook cells.
- Checked JSON parsing, exactly 100 unique review IDs, exact inventory coverage, 11 annotation candidates, all 17 published annotation IDs/locators, six blank measure cells and the three declared photo-treatment exceptions.
- Rechecked workbook SHA-256 after review: `C30B9AD983A0CDE05F3263A088D0B9A640AFCC5ACFF9B1FCA8515A1E8FAFFE65`.

Evidence controls and actual-view inventory are in [review-validation.json](review-validation.json) and [source-inventory.json](source-inventory.json). [visual-observations.tsv](visual-observations.tsv) contains the authored per-ID observations used to assemble the JSON; they are manual visual judgments, not computer-generated image classifications.

Reproduction from `cookmate-app` in PowerShell uses the bundled runtime:

```powershell
& 'C:\Users\hp\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' 'scripts/content/review/inspect_sources.py'
& 'C:\Users\hp\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' 'scripts/content/review/build_review.py'
```

The first command makes read-only source inventories and labeled inspection derivatives. The second validates/packages the authored observations and source checks. It does **not** perform visual inspection; reproducing that part requires opening the recorded sheets/originals. Both scripts write only within `packages/catalogue/review/` and live within `scripts/content/review/`.

## Limits

Contact sheets are high-quality JPEG inspection derivatives, not delivery assets or pixel-identical source copies. Direct-original follow-ups supplement them. This review does not verify hidden ingredients, species, recipe authenticity, cooking correctness, taste, servings, nutrition, allergens, or image-generation provenance. It is not an exhaustive ingredient-versus-method audit of every recipe. No remote publisher, URL reachability, current license, or reuse permission was investigated. No app, server, install, native render, iPhone journey or crop acceptance test was run. All original source files remain unchanged.
