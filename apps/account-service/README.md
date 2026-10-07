# CookMate account service

This server-only package implements authenticated snapshot storage, compare-and-swap commits and account-deletion admission behind Supabase Auth and PostgreSQL. It is a local engineering foundation, **not a production acceptance or deployment record**. Building or testing it does not create a cloud project, configure Apple/Google, migrate a live database or deploy a function.

## Boundaries

- The mobile/browser client supplies its access token, never an owner ID or service credential. The adapter verifies it with Supabase Auth, then binds the verified user and token session to the SQL RPC.
- Private tables and privileged RPCs are unavailable to `anon` and `authenticated`. The service role can call only the explicitly granted RPC boundary for this schema. RPCs additionally check that the session belongs to the owner.
- The handler uses the strict `@cookmate/account-sync` snapshot allowlist. Conversations, action receipts, pairing credentials and API keys are outside this format. Account authentication does not grant AI consent.
- A snapshot is limited to **2 MiB of UTF-8 wire JSON**. PostgreSQL permits **4 MiB of JSONB text** because its serialization inserts whitespace. The adapter bounds formatted RPC responses at **6 MiB**; the handler revalidates the returned snapshot against the original domain limit.
- Each successful commit increments the account revision exactly once. `(owner, operationId)` identifies an immutable receipt tied to its base revision and payload digest. Retries recover that receipt; changed payloads or stale bases fail. Receipts and snapshot changes commit or roll back together.
- Shopping purchase marks still require local catalogue reprojection and exact demand-fingerprint matching before being applied. A server save does not prove an ingredient demand is unchanged.

## Local build and checks

From the repository root, after the existing workspace dependencies have been installed:

```text
npm run typecheck --workspace @cookmate/account-service
npm run test --workspace @cookmate/account-service
npm run build --workspace @cookmate/account-service
```

The build writes `handler.js` for both `cookmate-account` and `cookmate-account-deletion-status`. Both contain server code, not configured credentials. Their fixed-length digest comparison imports `node:crypto` externally for the Edge runtime's Node compatibility layer; local checks do not establish hosted runtime acceptance. Do not import the service package or generated bundles into the Expo application.

Tests use injected HTTP responses and a disposable in-memory PGlite database with synthetic users/sessions. They cover the real migration SQL, ownership, role permissions, rollback, stale-base admission, replay, revocation, pending-deletion recovery and large valid snapshots. PGlite queues work through its connection; this does not prove independent hosted PostgreSQL transaction contention or live Supabase provider behavior. Consult retained run logs for actual pass counts; this file does not assert that a command was executed.

## Configuration required before any authorized hosted trial

The Edge entrypoint expects server environment variables:

| Variable                    | Purpose                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `SUPABASE_URL`              | HTTPS origin of the intended Supabase project.                                       |
| `SUPABASE_ANON_KEY`         | Project client key used to call Auth for user verification.                          |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only credential for privileged RPCs and Auth account deletion.                |
| `COOKMATE_ALLOWED_ORIGINS`  | Comma-separated exact permitted browser origins. Native requests may have no Origin. |

Do not place the service key in an `EXPO_PUBLIC_` variable, browser storage, checked-in configuration, logs or screenshots. The configured endpoint must use HTTPS. Configure Apple/Google providers, approved OAuth redirects, platform application identifiers, session policy and function authentication settings separately in the intended project. Do not infer that the example domains in tests are real endpoints. The migration is `supabase/migrations/202609300001_account_sync.sql`; applying it to a real project and deploying the function remain separate, explicitly authorized operations. No live migration/deployment command is part of this README's local workflow.

The checked-in `supabase/config.toml` keeps `verify_jwt = true` for authenticated user calls. Platform JWT verification supplements the handler's Auth user verification and owner/session SQL checks; it does not replace them. Relevant primary documentation, checked 30 September 2026:

- [Supabase Edge Function authentication](https://supabase.com/docs/guides/functions/auth) recommends retaining platform JWT verification for signed-in user calls. This implementation uses its own bounded adapter, not the documentation's optional wrapper.
- [Supabase user sessions](https://supabase.com/docs/guides/auth/sessions) documents the JWT `session_id` relationship to `auth.sessions` and row removal on sign-out. Configured timeout policies are evaluated around refresh and cleanup; row existence alone does not establish every policy is current. The service's ten-minute recent-sign-in rule is an explicit CookMate deletion policy, not a claimed provider default.
- [Supabase admin user deletion](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser) requires server-side service-role authority and documents the soft-delete option. CookMate requests hard deletion; its own foreign keys define snapshot/receipt cascading.

## Wire actions

All actions use POST with a bearer token and `application/json`:

- `read`: `{ action: 'read' }`. Response projects only `ownerId`, `revision`, `schemaVersion`, `snapshot`, `updatedAt`, `deletionPending`, `deletionOperationId`. Revision zero requires a null snapshot/time; a positive revision requires a valid snapshot/time. The deletion flag and nullable operation ID must agree.
- `commit`: `{ action: 'commit', operationId, expectedRevision, snapshot }`. The returned receipt contains only `ownerId`, `operationId`, `revision`, `committedAt`, and the revision must equal `expectedRevision + 1`.
- `delete`: `{ action: 'delete', operationId, expectedRevision, confirmation: 'DELETE_COOKMATE_ACCOUNT', recoveryToken }`. The recovery token is exactly 64 lowercase hex characters from 32 cryptographically random bytes and must be durably stored/read-verified by the client before dispatch. Admission requires a sign-in session created within ten minutes, explicit confirmation and the immutable reviewed revision. The deletion marker freezes further commits before Auth deletes the user. Auth user deletion cascades the stored snapshot and sync receipts while an Auth-row trigger completes the independent deletion receipt in the same transaction. Success requires that durable receipt, including after a lost Auth response. This action does not erase the local device copy.

## Deletion result recovery

If deletion fails before Auth removes the user, a new session of the **same owner** can read the pending `deletionOperationId`. The client must show an explicit resumed-deletion review and use that exact operation ID and base revision. It must not silently initiate deletion just because a marker exists, and it must not generate a replacement operation ID. Other owners cannot read or resume that marker. Recent sign-in is required again where necessary. If the previous secret journal was lost, the explicitly confirming same owner may register another digest for the same pending operation. All earlier capabilities remain valid. A maximum of eight distinct registrations is enforced; exact repeats are free and quota failure occurs before Auth deletion. Exhausting this ceiling after repeated journal loss is a recovery limitation, never a reason to invalidate a still-valid capability.

The separate `cookmate-account-deletion-status` function has `verify_jwt=false` because deleted or expired Auth sessions cannot authorize recovery. The original function stays JWT gated. Status POST accepts exactly `{ operationId, recoveryToken }`, with a 2 KiB body cap and no owner identifier. It returns only `{ operationId, status: 'pending' }` or `{ operationId, status: 'deleted', deletedAt, expiresAt }`. It cannot read account content, resume deletion, call Auth deletion, or create an account. Service-only lookup responses are bounded to 4 KiB. Digests are checked using `timingSafeEqual` across eight padded 32-byte slots and are never returned publicly or logged.

Completed receipts retain only operation/timing metadata and capability digests for 30 days; owner/base fields are cleared in the Auth deletion transaction. Pending records remain while the account is frozen. Missing, expired and incorrect credentials receive the same `404/deletion_receipt_unavailable`; a later `401` also remains unconfirmed. Neither absence nor failed reauthentication proves deletion. Clients must preserve unconfirmed journals, distinguish the local copy, and fence recovery against unrelated signed-in owners.

Apply `202609300002_account_deletion_receipts.sql` after the original migration. It removes the obsolete capability-free delete RPC overload and adds the private independent proof tables, Auth trigger and service-only lookup. `cookmate_account_prune_deletions(p_limit)` deletes only expired completed records and their capability rows, with a limit of 1–1,000 (default 100). No pruning schedule or deployment is created by this source change. Retention expiry is an honest proof limit; deleting the last receipt cannot become a fabricated confirmation.

## Remaining acceptance

### Expanded personal-scope rollout (C03)

The additive `202610010001_personal_snapshot_v2.sql` migration follows the two migrations above. It admits the strict snapshot2 format, rejects new snapshot1 downgrades after snapshot2, and still replays exact historical snapshot1 receipts. No migration in this repository has been applied to a hosted project by these local checks.

The separate `202610010002_content_snapshot_v3.sql` migration prepares storage for exact-content snapshot 3. The handler accepts this format only when its server composition explicitly sets `enableContentSnapshots: true`; the checked-in entrypoint remains unchanged and the option defaults off. The transport envelope remains 1 and the snapshot limit remains 2 MiB. Stored format 3 encountered by a disabled handler returns `stored_data_needs_review`, never an empty account. New 3→1/2 and 2→1 writes are refused, while exact historical receipts remain recoverable before that downgrade guard. This capability validates the private format 3 allowlist and full reference relationships; it does not authenticate recipe publications, resolve media, grant history consent, convert legacy account observations or activate a client. Those remain separately reviewed client/content-host responsibilities. No hosted deployment or configuration is performed by this preparation.

The mobile composition has an explicit `EXPO_PUBLIC_COOKMATE_PERSONAL_SYNC=1` rollout flag, currently unset. It selects local physical schema6 and the expanded repository/coordinator together. It is not user consent: each owner must first review private notes, collections/memberships and manual items; cooking history starts off. An initial merge review remains separate. Conversations, drafts, credentials, AI consent and household access remain excluded.

Enable this flag only for the authorized private acceptance build after configuring the intended snapshot2-capable service. A migrated schema6 workspace needs a schema6-capable reader; removing the flag is not a database downgrade strategy. Preserve backups and use disposable test owners/stores for the first configured run. Local SQLite and in-memory remote tests do not establish hosted synchronization or native credential behavior.

This package does not implement or prove the client account screens, secure token storage, provider linking/cancellation, partitioned offline outbox, guest-data review, transactional local apply, account switching or sign-out cleanup. Those adapters must preserve local recovery and keep different owners isolated. Hosted SQL concurrency/auth behavior, Apple/Google native login, real multi-device restore, user-visible deletion recovery and final browser/native screenshots remain separate acceptance work. Do not label the overall account feature complete based on these package tests alone.
