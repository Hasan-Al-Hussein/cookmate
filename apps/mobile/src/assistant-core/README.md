# Mobile assistant integration

These modules implement offline-testable transport, bounded context, proposal preparation and
coordination. They do not implement SQLite, screen wiring, a provider, or a second authority store.

## Public entry points

- `connection/native.ts`: `createNativeGatewayConnection()` uses the installed `expo/fetch` and
  device-only Expo SecureStore. Call `restore(installationId)` with a stable per-install marker from
  ordinary native app storage, **not Keychain**. A missing/different marker erases surviving pairing
  credentials. Do not pass a Gemini key to any mobile API.
- `connection/index.ts`: injectable `createGatewayConnection` for controlled tests. `pair`, `health`,
  `turn`, `cancel`, `forget`, `revokeAndForget` use API 2: `GET /health`, `POST /v2/pair`,
  `POST /v2/assistant/turn`, and `DELETE /v2/pairing`. `getState` contains
  no token. `cancel` increments the connection generation while retaining a valid pairing;
  `forget` removes the local credential. Only a successful DELETE/204 confirms server revocation.
- `assistant-core/index.ts`: `createAssistantCoordinator({ persistence, services, connection,
platform, currentDate })`. Use Data's `AssistantPersistencePort`, the real `CookMateServices`
  queries and the native `CommandPlatform`. `ports.ts` only reexports canonical domain types.
  Compose one retained Data adapter with `services.assistant({ connectionGeneration })`, where
  the stable callback reads the retained connection's current generation. Get the installation
  marker from `services.queries.readInstallationId()` before `connection.restore`; a failed read
  is a storage error, not a missing marker and not permission to erase credentials.

## Frontend and Data obligations

1. `send(text, selection)` allocates the current USER message ID before
   `readContext({text, selection, messageId})`. Data supplies the proposed sequence, date, original
   USER provenance, selected memory, complete review targets and coverage. The coordinator keeps
   this snapshot intact, persists the sent message and pending intent before networking, then
   CAS-accepts the correlated response using Data's durable acceptance envelope.
   A reply reports `actionStatus: not_executed` and app-owned `actionStatusText`. Always display that
   status beside every reply, including ordinary answers; never derive action status from model text.
   When trusted UI intent identifies an action-handling turn, use app-owned proposal/confirmation/
   receipt templates for action narration. General free text is untrusted for action completion.
   Proposal prose is replaced with an explicit review
   sentence, never a save receipt. Ordinary answer/clarification prose remains provider output;
   only action outcomes establish that a mutation happened.
2. Show the exact proposed actions, actual dates/meals and any occupied-slot consequences. Call
   `approve(intentId, authority)` only for explicit user authority from trusted UI/intent code.
   Include the named old/new recipe, occurrence/revision, scope revision and inclusion state for
   every replacement. `approve` returns an `AuthorizedActionPlan`: stable operation/entity IDs and
   exact response-order payloads, with no guessed future preference revision. Commands are only
   finalized through Data. `prepareAuthorizedIntent` remains a compatibility helper for at most
   one preference save; the coordinator uses `prepareAuthorizedActionPlan`.
   Model content is never an `ExplicitActionAuthority`.
3. `dispatch(intentId)` asks Data to `finalizeNextIntentSlot` and then `executeIntentSlot`; it never calls a
   provider-generated command. Finalization uses the actual current preference revision after the
   preceding durable receipt, including no-op saves, and retains the exact frozen command on retry.
   Data owns transactional current guard checks, frozen-slot identity,
   receipt lookup and result journaling. Returned successes are checked against durable receipts.
   Outcomes produce complete/partial/failed/uncertain summaries. Unfinalized reservations are
   reported as not dispatched, without inventing commands or receipts. Completed slots do
   not execute again; failure or uncertainty stops later dispatch. No startup/network automatic replay exists.
4. Use `reconcile(intentId)` on reopen, lost acknowledgement or uncertain outcomes. This only reads
   intents and receipts. A missing receipt is not permission to fabricate success or replay an
   uncertain operation. Explicit dispatch can retry a known failure only for after-delay/reconnect
   policy while Data still accepts its phase and guards; changed intent/confirmation needs a fresh
   decision. Multiple preference writes use the persisted action plan and actual receipt chain.
5. Call `cancel` to abort waiting and persist cancellation through Data. On clear-chat or context
   replacement call `invalidate()` synchronously, then use the real Data clear command. Invalidate
   alone does not clear durable history. Cancellation preserves any receipt already committed.
6. Data must populate accepted `StoredAssistantIntent.guards`, including the post-response context
   revision and real current date/connection/preference authority. `freezeActionPlan` must compare the
   accepted baseline and actual state atomically, and never overwrite earlier frozen slots.
   `executeIntentSlot` must load its own command and atomically journal dispatch/results. Failures
   cannot masquerade as empty reads. Current source-message-linked memory, references, draft,
   generation and immutable receipts stay in the canonical store.
   `persistence.readIntentPage` discovers persisted intent IDs and USER/assistant message links
   after reopen. Its summaries grant no authority: read the current intent and use `reconcile`
   for receipts, while `readAcceptance` recovers historical display only. No UI-owned ID index
   or restoration-time dispatch is required.
7. Before exposing restored services, Data must cancel old draft/awaiting/clarification/confirmation/
   ready intents, retain dispatched/reconciling intents for receipt reconciliation and mark sending
   messages interrupted. Connection generations are runtime counters; coincidental equality after
   a process restart does not restore authority. Ordinary composer typing must not advance semantic
   context revisions or invalidate an in-flight turn.
8. An acceptance failure returns `acceptanceRetry: {userIntentId, response}`. Retain that exact
   normalized response and pass it unchanged to `retryAcceptance`. No new assistant message ID or
   request is allocated. `readAcceptance(intentId)` recovers the immutable historical acknowledgement
   after reopen. Replies with `historicalAcknowledgement: true` are display/reconciliation evidence;
   they do not renew confirmation or dispatch authority. Data compares the full normalized fingerprint
   before mutable current-state guards, and the coordinator never records a network failure after an
   acceptance acknowledgement was lost.
9. `retryTurn(intentId)` is an explicit user-requested provider retry. It first returns any historical
   acceptance without networking. Otherwise Data must rearm the eligible frozen turn under its current
   guards; request/message/intent IDs, envelope, source evidence and original context are retained.
   Cancelled or changed-state requests require a new user decision; no automatic retries are scheduled.
10. `send` can return typed `narrowing` before `beginTurn` or network activity. Display local recovery
    options, load established evidence using `readMemoryPage`, then invoke `setWorkingContext` only
    for an explicit boundary/carry choice with its `expectedContextRevision`. Data expands connected
    correction/conflict groups and rejects stale/oversized choices atomically. Successful scope changes
    abort the current wait; rejected changes leave it intact. A new brief is a later ordinary `send`.
    A provider-discovered context token/byte limit can also return narrowing after the failed turn
    is journalled. The coordinator previews a possible fresh brief using a new unused message ID
    and authoritative Data revision/coverage. It does not begin another turn, rewrite the original
    frozen request or automatically resend it. Use the returned current revision for the explicit
    boundary/carry decision.

## Bounds and privacy

Requests and replies are capped at 128 KiB; current message/schema bounds are generated contracts.
Recent outbound history is capped at 20 messages independently of local retention. The full local
projection may exceed the outbound 32-memory-entry budget. Required source groups and reference sets
are never silently truncated; insufficient entry/expanded-byte/review evidence budgets return local
narrowing, while ambiguous ordinal metadata returns clarification. Shared validators check exact
USER quotes, sequence/date/preference provenance, review membership and correction relations.
Current saved preferences and withdrawal links are copied from the authoritative
snapshot, never recreated from older history. `readContext` must supply only relevant
plan/context; the gateway owns complete recipe ingredients/instructions/annotation evidence.

Every request has a maximum 45-second deadline, AbortController cancellation and zero mobile
retries. HTTP uses only a configured HTTPS origin, bearer authorization and body payloads. Query
credentials, URL user-info, application prefixes, redirects and phone localhost are rejected.
No certificate override, provider key, diagnostic logger or whole-database upload is implemented.
Wire error messages/fields are normalized to local category keys before surfacing. Only the
allowlisted `context.token_limit` and `context.byte_limit` fields survive a `too_large` error.

## Evidence and remaining gates

The installed Expo iOS source was inspected: `expo/ios/Fetch/NativeResponse.swift` declines redirected
URLSession requests when `redirect: error`; `ExpoURLSessionTask.swift` omits cookies for `credentials:
omit`; Expo fetch streams and cancels bodies. This is code-source evidence, **not an iPhone test**.
The fallback injectable fetch reader checks size after native buffering if streams are unavailable.
Opaque native fetch errors map to network-unavailable unless a supplied platform classifier can
positively distinguish trust failure; no certificate error is bypassed.

Controlled Node fixtures cover old references, bounded current context and memory, exact acceptance
retry/reopen, retained-ID provider retries, explicit working-context recovery, multiple preferences
with actual no-op revisions, explicit authority, date/
revision/occupied consequences, transport correlation, cancel/forget, timeout, body limits, strict
credentials, redaction, partial results, receipt identity and no execution during restoration.
The gateway suite additionally exercises actual file SQLite source/context/acceptance records and
reopen. Full action-adapter SQLite integration, iPhone Keychain survival/reinstall behavior, native
TLS/redirect/stream behavior, screen UX and provider quality remain required. Test doubles do not
prove real saves.
