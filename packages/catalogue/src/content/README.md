# Immutable content foundation

This directory defines plain-data contracts only. It does not publish, download, activate or migrate content. The existing `Recipe` and assistant wire schemas and the package's public exports are unchanged.

## Identities and encoding

`RecipeContentRef` has the stable numeric recipe ID, a bounded opaque revision ID, and a SHA-256 content fingerprint. The content fingerprint covers the entire document: exact source strings, ordered ingredients/passages, provenance, metadata, photo identity and rights records. It excludes the revision ID. `revisionFingerprint` separately binds the complete reference, so identical content can belong to distinct revisions without conflating their revision identities. A later repository must prevent rebinding a published revision ID; this pure module is not that repository.

Canonical JSON sorts object keys by UTF-16 code units. Arrays retain their declared order. Text is not trimmed, translated or Unicode-normalized. Non-JSON values, accessors, cycles, sparse arrays, non-finite numbers, negative zero, symbols and non-plain objects are rejected. Byte/node budgets apply during traversal: strings/keys are size-checked before escaping/copying, array cardinality is checked before enumeration or secondary allocation, and final JSON parsing occurs only after bounded encoding. All asynchronous operations first copy caller inputs. Returned content is recursively frozen.

## Source truth

Imported documents contain a `Recipe` and workbook locators, source hashes, recipe provenance and reviewed photo-treatment flags. Structural validation alone does not prove those values match the claimed source. Signed-release verification requires a host-configured `ImportedSourceVerifier` for every imported document and rejects unknown or mismatched evidence. `bundledImportedSourceVerifier` compares recipe content, provenance and immutable original photo facts against the retained packaged baseline; the manifest cannot nominate its own authority. New reviewed metadata/rights/dimension evidence does not permit changes to those retained facts. Authored documents have ordered source-free ingredient/instruction fields and explicit author/credit provenance; they cannot manufacture a workbook locator. A `basedOn` reference is structurally checked for the same recipe ID but still requires resolution against an independently trusted historical archive before publication.

Unknown reviewed metadata remains null with no reviewer record. A non-null value, including a genuine zero-minute duration, requires review evidence. That shape check does not authenticate the reviewer. Media identities bind the SHA-256 hash; the association also names the recipe and exact photo key. Recorded dimensions require review evidence. Rights are explicitly unreviewed, permitted or restricted.

The bundled adapter preserves the recorded source/photo hashes and byte counts. It labels output `packaged_baseline`. It does not measure image bytes or establish photo rights. Since the retained manifest has neither dimensions nor rights approval, those values remain null/unreviewed. This faithfully readable baseline intentionally fails new-release publication eligibility until independent evidence exists.

## Release trust

Release manifests bind ordered recipe references and complete associated media metadata. Fingerprints establish integrity only. `verifySignedContentRelease` requires the host's separately configured `ReleaseTrustVerifier`, receiving a domain-separated canonical manifest payload, key ID, scheme and signature. The envelope cannot supply its own trusted key. No native or production cryptographic implementation is provided here.

The result is a signature-verified manifest with matched recipe documents. It reports `importedSourceEvidence: 'verified'` only after the configured retained-source adapter accepts every import, or `not_applicable` for an authored-only release. It explicitly reports `mediaBytes: 'not_verified'` and `historicalDependencies: 'not_verified'`. It is not permission to activate a release. A future publishing/activation layer must authenticate author/reviewer rights, verify original uploads and media bytes, resolve trusted ancestry, enforce release sequencing/rollback policy, stage all assets, and commit an activation journal. Recorded evidence alone must not become a claim that those actions happened.

## Bounds

- Recipe document: 1 MiB canonical UTF-8; release envelope and total supplied revision dependencies: 8 MiB each.
- Release: at most 10,000 unique recipe IDs; at most eight media associations per recipe.
- Media: at most 20 MiB recorded bytes; measured width/height from 1 to 16,384; JPEG, PNG or WebP only, with matching filename extension. These metadata bounds are not an image decoder or upload validator.
- Recipe: at most 100 ingredients and 200 passages; existing imported text bounds retained. Authored titles: 512 characters; description: 4,000; passage: 12,000; raw ingredient name/measure: 512.
- Metadata: servings greater than zero and at most 1,000; duration from zero to 43,200 minutes; at most 30 distinct dietary tags. All non-null fields need recorded review evidence.
- Canonical traversal: depth at most 32 and at most 500,000 values. Revision IDs, author/reviewer IDs and scheme/key IDs use the same bounded 120-character token grammar.

Tests use a clearly labelled fake trust verifier. They establish validation and delegation behavior, not real cryptographic verification, native compatibility, uploaded-media safety or a working publishing pipeline.
