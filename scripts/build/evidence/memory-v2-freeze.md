# Shared memory contract v2 freeze

Recorded 2026-09-28 04:13:56 UTC. Foundation's bounded shared-contract amendment is frozen for coordinated consumer adaptation. This is not application/native acceptance.

Schema fingerprint (SHA-256 of canonical generator schema serialization):
`af10dd470af0c2f68e02713d88dd2b21b655673dfedccde610e255a70c36d569`

The pretty-printed generated JSON has a different file hash; all 19 source/generated/fixture file hashes and command logs are linked from [verification evidence](memory-v2-verification.json). Generated validators: 19 roots, 445,786 bytes / 34,641 gzip bytes; compiler-free runtime imports remain unicode helper and fast-deep-equal.

## Frozen contract

- API string `"2"` across assistant, pair and health; shared schema2, LocalCommand2, separately coordinated database2; OperationReceipt1 and source catalogue identity unchanged.
- `context.memory` replaces facts. Full quote <=4,000 code points; items32, pending sources7, review targets8 including current, scope recipe IDs1..6, relations8, carry IDs32. Expanded request and response each <=128KiB UTF-8 JSON.
- `UserMemorySource`: sourceMessageId, sourceSequence, sourceDateContext, preferenceRevisionAtSource, quote, preferenceLinks. Current and USER history retain messageId/text with the same metadata. Assistant history has sourceSequence but no invented USER provenance.
- `MemoryItem` adds memoryId/revision/kind/scope/resolved relations. Scope is conversation | recipes | placement. Existing relations use memory targets; update proposals support selected exact-revision memory or another retained earlier source in the same batch.
- Normal answers/clarifications/proposals require `MemoryUpdate`; errors forbid it. Strict `ModelMemoryUpdate` omits quotes. Gateway copies complete exact source quotes from the frozen request, then Data independently verifies originals.
- Snapshot includes required nullable lastRemovalRevision. Links omit internal operation ID; no independent count cap/truncation. Current message links are empty. Live/removed links must agree with the supplied snapshot; a withdrawal follows its original source global revision.
- Working carry IDs contain fully expanded undirected relation groups, not roots only. Null boundary means scoped/total pending counts agree. Counts include current candidate once. Narrowing is local-only and cannot pass the sendable request helper.
- `EditPlanCommand.expectedShoppingScopeRevision` is required alongside occurrence guard, recipeId and complete placement.

## Consumer entry points

Import from `@cookmate/contracts`:

- Generated types/validators, including MemoryUpdate, ModelMemoryUpdate, WorkingContextSelection, AssistantAcceptanceInput and their `validate*` roots.
- `checkAssistantRequest(value, catalogue)`: strict shape, catalogue/date checks plus sendable memory consistency and expanded bytes.
- `checkAssistantResponse(value, catalogue)`: strict response shape, citations/dates/catalogue and expanded bytes.
- `checkMemoryRequest(value)`: disclosed source/provenance/count/scope consistency only.
- `checkMemoryResponseForRequest(value, frozenRequest)`: first-acceptance frozen correlation/bases, review-entry bijection, exact quotes and strictly backward relations. It permits error transport responses without accepting a memory sidecar; AssistantAcceptanceInput rejects errors.
- `assistantJsonByteLength(value)`, `sourcePredatesPreferenceRemoval(sourceRevision, watermark)`.
- `acceptanceFingerprintInput({normalizationVersion:1,frozenRequest,normalizedResponse,envelope:{assistantMessageId,expectedIntentRevision}})`: canonical full-object string for platform SHA-256. It rejects unknown/non-JSON values, preserves strings/array order, and intentionally does not apply current-state or first-acceptance correlation checks.

Canonicalize frozen schema/normalization input, locate the existing acceptance by stable intent key, and compare fingerprint BEFORE request-ID/current stale/day/connection checks. Exact replay returns immutable historical output, never renewed action authority. First acceptance then applies frozen and actual retained/state/CAS checks. ReferenceSet shape remains unchanged; Data must validate its retained origin and working scope. Narrowing/recovery ports and immutable acceptance acknowledgment persistence remain Data-owned.

## Verification and review

44/44 isolated tests passed: 18 existing contracts, 17 memory, 8 full-object fingerprint, 1 Fastify parity/transport fixture. Generated drift check, scoped contract TypeScript and owned-file Prettier checks passed. No root/consumer suites, installs, servers, live provider calls or native exports were run.

Independent read-only reviewer inspected the final source/fixture changes and found no remaining material defect in this scope. Lead reran the bounded checks. Detailed check commands, exact hashes and logs are in [memory-v2-verification.json](memory-v2-verification.json).

Pure checks do not prove retained same-generation provenance, semantic completeness, full relation closure, database atomicity/replay, provider interpretation or iPhone behavior. Brain owns subsequent lane activation and integration/native acceptance.

