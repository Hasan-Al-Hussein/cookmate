# CookMate Recipe Studio

A separate, private browser workspace for real recipe drafts. It uses the existing React/TypeScript toolchain, a Fastify API, operator-only SQLite storage and content-addressed photo files. It never edits the bundled mobile catalogue in place.

## Local operator setup

Run these commands from the `cookmate-app` root with the project's supported Node 24 runtime:

```powershell
npm run admin:build
npm run admin:bootstrap -- --username your.operator
npm run admin:start -- --local-http
```

Bootstrap requires an interactive terminal. Choose a private password of 12–128 characters at the hidden prompts; never put it in a command, environment variable, URL or source file. There is no shared default account or web bootstrap. Bootstrap refuses to replace an existing operator. It does not create a CookMate client account or sign the user into the mobile app.

Open `http://127.0.0.1:3444/admin/` on this computer. Local HTTP is a deliberate development option, bound to this exact loopback address. It is not a public deployment or a remote-access configuration. For local TLS with a certificate trusted by the browser:

```powershell
npm run admin:start -- --tls-cert C:\path\certificate.pem --tls-key C:\path\private-key.pem
```

The process still binds only to `127.0.0.1:3444`. Do not bypass browser certificate warnings. The HTTPS certificate must cover the actual configured address.

State is kept under `%LOCALAPPDATA%\CookMate\admin`, outside the source checkout and OneDrive project documents. A process lock prevents two launchers from owning the database. Startup does not automatically erase malformed secrets or stale locks. Stop the owner cleanly with Ctrl+C; after an abnormal interruption, verify no owner remains before investigating the lock. Keep the SQLite database, media files and private signing material together when making an operator-managed private backup. These files contain administrator authentication state and must not be committed or attached to diagnostics.

## Current workflow

- Sign in using the configured operator; sessions have idle and absolute expiry, request tokens, exact-origin checks and server-side role enforcement.
- Search the actual bundled recipes or create a new local draft. Starting from a bundled recipe retains its stable identity, exact original evidence, ordered ingredients and passages.
- Edit title, description, category, cuisine, original measures, ordered instruction headings/passages, video and source-credit fields. An incomplete draft can be saved; the readiness panel explains remaining issues.
- Upload one JPEG, PNG or WebP. The server validates decoded content, bounds file/pixel size, removes metadata and creates an immutable WebP asset. An upload is attached only when the draft is saved.
- Save a new revision, inspect history, or restore a historical version as a new draft. Concurrent edits are rejected instead of silently overwriting newer work.
- Review a draft as an authorized reviewer/administrator. Unresolved rights/content issues prevent approval. Review notes remain readable for the editor.
- A lost save response retains its operation reference. Resolve it explicitly to recover a stored result or cancel an uncommitted operation safely. Reloading never replays a write automatically.

Draft text stays in memory until saved. An unconfirmed operation reference, containing identifiers rather than recipe text or credentials, is retained in this browser tab's session storage. Keep the tab open while an unsaved draft is valuable. Signing back into the same account preserves the in-memory form; switching accounts cannot submit the previous account's operation.

## Deliberate boundaries

The signed issuance, delivery and consumer staging/adoption modules have local integration evidence. Prepared, published, available to a client and adopted by a client remain separate states. Ordinary-app content integration and configured operational signing/delivery are still incomplete; the existence of these modules does not authorize a real publication or certify media rights. The normal client workspace is not migrated or updated by starting this admin server.

The translation API and editor store separate revisions bound to an exact saved source revision and original/target language. The editor compares the original text, preserves original quantities, photos and source evidence, tracks declared machine assistance, and records an authenticated reviewer's explicit acknowledgement. Source edits make translations stale; deliberate rebasing creates an unreviewed revision. A separate recovery reference survives reload without storing translated text or automatically resending a write. The editor has local component/real-route evidence; its browser layout and signed translation publication remain unverified. Recorded operator acknowledgement is not independent language-quality certification.

## Verification

```powershell
npm run typecheck --workspace @cookmate/admin
npm test --workspace @cookmate/admin
```

`test/browser-fixture.ts --browser-review` starts an explicit temporary review environment on loopback port 3445. It uses disposable synthetic credentials, never the operator database, and shuts down after 30 minutes. It is test support, not a production account or launcher. Actual check outcomes and screenshots are recorded in the canonical CookMate `implementation/product-upgrade` directory.
