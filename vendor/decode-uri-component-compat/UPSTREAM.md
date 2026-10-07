# Private CookMate compatibility adaptation

Derived from exact npm decode-uri-component 0.5.0; upstream MIT license retained. This is not a published maintainer release.

Upstream: https://registry.npmjs.org/decode-uri-component/-/decode-uri-component-0.5.0.tgz
Integrity: sha512-1BiQVoK8C9gUbQU6NzAtO/tkz2qOFpEObMWpcFvhx4fYnj4Oc5yzaJN/LD36ihkVUdXyh5ZekzX+yM+ty/SrPg==

upstream.cjs is byte-identical index.js except an explicit strict-mode prefix and default-export to CommonJS assignment. No scanner/decoding algorithm change. index.js restores decoder 0.2.2's plus-to-space preprocessing, required by query-string 7 fragments and repeated delimiter decoding. index.d.ts uses export= for the callable CommonJS surface; upstream.d.ts preserves the original ESM declaration. Source derivation and compatibility tests live with CookMate's dependency compatibility evidence.
