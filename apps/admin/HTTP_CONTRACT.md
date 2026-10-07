# Local admin draft slice

Shared types live in `src/contracts.ts`. Responses use those types directly. Errors are `{error:{code,message}}` with safe human-readable text, never stack traces, passwords, private paths or query bodies. All API output is no-store. This slice provides real drafts and reviewed media; it must not claim publication/client updates until that later pipeline exists.

`buildAdminServer(options: AdminServerOptions)` constructs Fastify without listening. Exact origin/Host and allowed scheme must be validated independently. Root owns launcher, configuration, contracts, package/lock and CLI. Backend owns server/auth/storage/drafts/media/tests; frontend owns web/ only.

## Sessions

- `GET /admin/api/session` -> `AdminSession`; anonymous sessions receive a CSRF token. Configured means an operator account exists. No HTTP bootstrap.
- `POST /admin/api/session` `{username,password}` -> regenerated `AdminSession`.
- `DELETE /admin/api/session` ->204; invalidate session.
- `POST /admin/api/reauth` `{password}` -> `AdminSession`; refresh recent-auth time without widening role.
- All POST/PUT/DELETE including login require session-bound `x-csrf-token` and exact Origin. No CORS credentials. Protect login rate/concurrent password work. Cookie HttpOnly,SameSite Strict,host-only; Secure on HTTPS. HTTP requires explicit `allowInsecureLoopback` and exact127.0.0.1 origin/listener; local development only.
- Session idle30min,absolute8h. Recheck user enabled/role/auth epoch on every protected request. First operator only through deliberate CLI. Backend expose `openAdminDatabase(filename)`, `.countUsers()`, `.createFirstAdministrator({userId,username,passwordHash})`, `.close()` and `hashPassword(password)` for root CLI. No default password or printed signing material.

## Library and drafts

- `GET /admin/api/library?query=&status=&cursor=` -> `AdminLibrary`; max50/page, includes100 actual bundled recipes and drafts. Status all/bundled/draft/reviewed. Stable opaque cursor bound to query, or fail409 if stale. Reject invalid criteria.
- `GET /admin/api/drafts/:id` -> `AdminDraft`.
- `POST /admin/api/drafts` `{operationId,fromRecipeId?:string}` -> `AdminMutation`. Server assigns draftId/numeric recipeId for new recipe; fromRecipeId preserves existing identity/exact bundled basedOn/original evidence. Repeat operation+payload recovers same result; changed payload with same operation409.
- `PUT /admin/api/drafts/:id` `{operationId,expectedRevision,input:AdminDraftInput}` -> `AdminMutation`. Incomplete drafts can save within strict bounds; validationIssues explain readiness. Each save is immutable new revision, invalidating approval. Stale revision409; existing draft intact. Max1MiB; reject unknown fields.
- `GET /admin/api/drafts/:id/history` -> `{items:AdminHistoryEntry[]}` capped100 newest.
- `GET /admin/api/drafts/:id/revisions/:revision` -> historical `AdminDraft`.
- `POST /admin/api/drafts/:id/restore` `{operationId,expectedRevision,sourceRevision}` -> new `AdminMutation`; history never overwritten, fresh review required.
- `POST /admin/api/drafts/:id/reviews` `{operationId,expectedRevision,decision:'approved'|'changes_requested',note:string}` -> `AdminMutation`; reviewer/admin only. Bind approval to exact input revision, record actor/time. Incomplete content/unreviewed media cannot pass. Own review permitted but never labelled independent.
- Review decisions, notes, reviewer ID, time and input revision are readable in draft/history/revision responses through `review`, including changes requested. Preserve separate review evidence and original content. Non-review revisions expose null; older documents may omit the field.
- `GET /admin/api/operations/:id` -> `AdminMutation` or404 (unknown does not prove no write; client retains ID). Scope receipts to authenticated actor; prohibit another user guessing IDs.
- `POST /admin/api/operations/:id/cancel` `{}` -> `AdminOperationResolution`. An actor-checked transaction returns the existing same-actor draft mutation if it committed, or records a durable cancellation tombstone if no mutation exists. Repeated cancellation returns the same cancelled outcome. No recipe revision is deleted. Existing upload operations/another actor are denied. All mutation paths check tombstones again inside their commit transaction, so an in-flight request cannot commit after cancellation wins. GET receipts exclude tombstones; this explicit reconciliation supports reload recovery when the original payload was never dispatched or is no longer retained.
- Enforce editor/reviewer/administrator in API. No publish/account-management controls before real workflows exist.

## Media

- `POST /admin/api/drafts/:id/media` single multipart `file`, headers `x-operation-id`,`x-draft-revision`; auth/CSRF before reading. Returns `AdminAsset`. Upload does NOT automatically replace photo; attach through PUT/CAS. Immutable IDs bind sanitized bytes. Duplicate operation+payload recovers or fails409; no anonymous asset list.
- `GET /admin/api/assets/:hash` authenticated bytes, strict hash lookup, no arbitrary path. `GET /admin/api/baseline/:recipeId/photo` only retained catalogue association.
- Input10MiB,decoded20MP,single-frame JPEG/PNG/WebP,one file,bounded timeout. Decode actual bytes,strip metadata,re-encode,measure/hash output,clean quarantine on all paths. No URL fetching. Rights initially unreviewed; first-slice approved review can remain unavailable with honest readiness issues until rights-review workflow exists.
- Later rights/metadata approval,publication,content activation,account administration require separate contracts; no invented ready status.

Frontend `/admin/`: focused sign-in,library,ordered draft editor,photo upload,video/credits,history,actual readiness. Preserve dirty forms on failure/401/conflict; retain original operation ID for uncertain save/recovery. Actual catalogue photos; no invented metadata. Local draft is distinct from published mobile content.
