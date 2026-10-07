# CookMate private gateway

This Windows/Node 24 service is the narrow boundary between paired iPhone installations and
the configured Gemini model. It contains no phone database or executable model tools.
Controlled verification uses Fastify injection and the real official SDK with a **fake fetch**.
The current provider candidate uses MIME-only JSON with the full output contract in its trusted
instruction and strict local validation. One fixed-fictional 3.8 control passed; two 3.5 controls
failed syntax or full shape. This is limited compatibility evidence, not a model-quality decision.
No trusted iPhone HTTPS route has been verified. Canonical implementation notes retain the exact
live attempt and its bounded diagnostic preparation.

## Operator launch

Launch only after the coordinated transport/provider activation. Load `GEMINI_API_KEY` from
the private Windows file using Node `--env-file`; never copy it into source, OneDrive, phone
configuration, shell arguments or diagnostics. The launcher reads `GEMINI_API_KEY` explicitly,
ignoring `GOOGLE_API_KEY`. Provide these non-secret configuration names in the process:

- `COOKMATE_MODEL`: explicit `gemini-3.5-flash-lite` or `gemini-3.8-flash`; no automatic fallback.
- `COOKMATE_TLS_CERT`, `COOKMATE_TLS_KEY`: absolute paths to the operator-managed trusted
  certificate and private key. The certificate must match the endpoint used by the iPhone.
- `COOKMATE_BIND_HOST`: explicit local IPv4 interface for iPhone access; defaults to loopback.
- `COOKMATE_PORT`: 1024–65535, default 3443. Phone localhost cannot reach the laptop.

From the repository root, the entry point is `node --env-file=<private-file> --import tsx
apps/gateway/src/main.ts`. No plain HTTP launcher, certificate bypass, tunnel, firewall change
or automatic certificate installation is provided.

The interactive local terminal accepts `pair`, `close-pairing`, `clients`, `revoke <client-id>`
and `quit`. Pairing opens a five-minute window with five valid-format failed attempts. The
12-character random code is displayed only in a TTY, used once, and not written to logs.
Paired credentials last seven days; the phone can revoke itself. Operator client listings
contain IDs, expiry and revocation state, never bearer tokens or token hashes.

The credential registry lives at `%LOCALAPPDATA%/CookMate/registry`, outside the project and
OneDrive. Only SHA-256 token hashes are stored. Windows current-user ACLs, atomic replacement
and an exclusive `credentials.lock` prevent permissive files and simultaneous registry writers.
Invalid registry state or write failure denies access. An abrupt process death can leave the
lock. The lock stores only a process ID, random instance ID and creation time. Recovery is an
explicit local operator procedure:

1. Keep all gateway launch commands stopped while recovering this one registry directory.
2. Read only `%LOCALAPPDATA%/CookMate/registry/credentials.lock`, and note its `pid` and
   `instanceId`. Check `Get-Process -Id <pid> -ErrorAction SilentlyContinue`. If that process exists,
   even if its identity is uncertain or the PID was reused, do not remove the lock or kill it.
3. If the owner process is absent, reread the lock and verify the same instance ID/PID, with no
   concurrent gateway start. Remove only this exact `credentials.lock` file. An empty, malformed,
   changed or uncertain-owner lock needs inspection; do not guess that it is stale.
4. Relaunch the gateway. The existing `credentials.json` must load unchanged, including revoked
   tokens. The controlled test uses an abruptly exiting owned child, verifies its PID is absent,
   then performs this recovery in a disposable directory and checks exact registry bytes.

Never delete `credentials.json` as a lock-recovery shortcut. A clean `quit`
or handled termination releases the lock. The OS account/operator can still inspect process data.

## Protocol and boundaries

Routes are `GET /health`, `POST /v2/pair`, `DELETE /v2/pairing` and
`POST /v2/assistant/turn`. Every assistant request and self-revocation requires one bearer token.
Health reveals API version and readiness only. Queries are rejected. Shared schema and semantic
checks reject unknown fields, incompatible catalogue/API versions and unsupported source IDs.
Request payloads are limited to 128 KiB (pairing 1 KiB); provider responses to 128 KiB.
There is no arbitrary URL, SQL, filesystem, remote tool or caller model selection route.
Logging is disabled; failures expose controlled category keys, never stack or provider bodies.

One turn per authenticated client and two global turns are admitted. Each has a single 45-second
deadline; revoke/disconnect cancels waiting. A separate provider transport lease remains held
until the actual fetch/body promise settles, so an abort-ignoring adapter cannot free physical
request capacity early. Two stuck transports fail closed with `busy` for new provider requests.
Whether Google continues computing after a network cancellation is not observable or guaranteed.
Equal request IDs from different clients retain
separate state. There is no gateway conversation persistence or completed-request replay cache.
Interruption does not prove a provider request was unsent or erase committed phone effects.

Each turn permits at most two distinct retrieval/generation rounds, three generation attempts
including one explicit retry for HTTP 500/502/503/504, two token-count preflights, and five total
Google requests. SDK retries are disabled. Authentication, quota, malformed output and preflight
failures are not retried. Count results are reused for a retry of the same generation input.
Each generation caps output at 2,000 tokens; reported output plus thought usage must fit that
combined cap. Missing, null or malformed thought usage is unknown and fails closed, never zero.

The Developer API in SDK 2.24.0 rejects `systemInstruction` and `generationConfig` in countTokens.
The preflight counts the exact full-schema-bearing system instruction once and serialized
turn/evidence once, as two content parts. Generation receives those same strings and an
application/json MIME format with no API schema field. The preflight adds 256 for framing
against the unchanged 12,000-token input cap. This remains an admission
estimate, **not an exact Interactions token count or proven
tokenization upper bound**. Actual reported input usage is checked after completion; this cannot
prevent a charge already incurred if actual usage exceeds the estimate. Provider-input token/byte
limits return controlled context-recovery markers to the mobile coordinator; retrieval-only limits
can ask for a smaller recipe comparison. Ingredients/instructions/warnings are not silently truncated.

`store:false`, no previous interaction ID, no background execution and no provider tools are
sent through official `@google/genai` 2.24.0. A fixed-origin fetch wrapper rejects redirects and
unregistered paths. Complete evidence uses the shared catalogue/search identity at runtime.
Only app-defined read-only retrieval is interpreted. Model output can propose saveRecipe,
addPlan or savePreference; it cannot execute anything or establish action success. The phone
requires current explicit authority, frozen commands and real receipts. Search metadata preserves
the actual total, returned subset and count basis; direct IDs have separate provenance.
Completed-write prose screening is defense in depth only. The mobile coordinator returns
app-owned `actionStatus` and `actionStatusText` for every reply; the UI must display those and
use trusted action templates/receipts for mutation narration. Free recipe prose remains model
output, whose semantic reliability needs the T36 evaluation; no regex proves its truth.

## Data disclosure and verification limits

Phone → laptop → Google carries the current cooking question, bounded relevant history/memory,
ordered references, current preferences/relevant plan context and full selected source evidence.
Photos, provider/pairing credentials, unrelated records and whole database exports are excluded
from model content. Saved preferences must come from the current phone snapshot; older text is
not permission to restore cleared preferences. Provider data retention/training/cost behavior
depends on the actual selected Google project/tier; `store:false` is not a no-retention guarantee.
Local clear controls do not erase an already delivered provider request or OS backups.

API 2 requires a same-generation memory sidecar on normal replies. The model supplies explicit
review dispositions and quote-free entries; the gateway copies exact complete USER quotes from
the frozen current/pending sources and checks the expanded response against that request.
Same-batch backward source relations and original date/preference provenance are preserved.
Removed preference markers do not delete unrelated temporary clauses. Locally generated
clarifications mark every source unresolved; they never pretend a model reviewed it. The phone
owns retained originals, full projection/review backlog, explicit working-context recovery,
atomic acceptance and durable retry/receipt authority. These are not gateway persistence.

Node fixtures include real disposable file SQLite source/acceptance state through the mobile
context builder and gateway, including reopen and immutable replay. They do not prove the full
action adapter, model factual reliability, source interpretation, native SecureStore/reinstall,
iPhone TLS/redirect behavior or full UI journeys. Those gates and the balanced model evaluation
remain explicitly open. Structured
unanswerable replies can disclose limitations; blocked/incomplete/non-JSON provider output maps
to `invalid_model_result`, while quotas, deadlines and upstream/auth availability are distinct.

Run the bounded suite with `node --import tsx --test apps/gateway/test/*.test.ts` and the targeted
typecheck with `node node_modules/typescript/bin/tsc -p apps/gateway/tsconfig.json` from root.

The separately named current acceptance harness is `diagnostics/candidate-memory-smoke.ts`.
It imports the production provider directly and requires explicit execution and a fresh evidence
path. Root owns all live activation. Older schema compilers and diagnostic chains are retired to
`diagnostics/legacy-json-mode-20260928`; its manifest preserves byte-exact source/test snapshots
and dependency context, and its README lists separate historical verification commands.
Historical tests are excluded from the ordinary gateway suite and production import graph.
