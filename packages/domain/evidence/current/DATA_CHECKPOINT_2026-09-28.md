# Data and Domain integration checkpoint

28 September2026. Current data source is frozen for the shared provider diagnostic and Frontend integration. This is a construction/verification checkpoint, not acceptance of unfinished native/product tasks. Brain acceptedT13/T14 previously; only Brain updates the task ledger.

## Source identity

`data-source-freeze.json` hashes81 owned production/test/catalogue/content-script files. Manifest SHA-256: `cd54f2f1cd71e6e2b416ab0574ef8696539a08c03501dbe720f2c04416e19e74`.

API2; LocalCommand2; database genesis2; OperationReceipt1. Shared contract schema fingerprint `af10dd470af0c2f68e02713d88dd2b21b655673dfedccde610e255a70c36d569`. Catalogue `cookmate-2026-09-27.v1`, fingerprint `1c564aed197f0ff13e0c8a81c95d775960f8c7f021cd3e948f116ae471b5e1ef`. Source search `source-search-v1`, fingerprint `cb51b70b1412cc091b2dc3402132aaeff3233f7f504c68b8e772e53fe3e39450`. No catalogue regeneration occurred in this wave.

## Callable integration surfaces

Exact TypeScript declarations are in `packages/domain/src/services.ts`, `conversationPorts.ts`, `directActions.ts` and their index exports. `apps/mobile/src/data/nativeStore.ts` composes the native adapter; `localStore.ts` is the tested factory. No SQL handle is exposed to UI/provider code.

- Root owns one opened store and closes it after outstanding operations settle. `services.assistant({connectionGeneration})` binds one stable live callback per store.
- Direct mutations use `reviewDirect(userChoices)`, `prepareDirect(full immutable review)` and `execute(exact command)`. Selection review guards plan and shopping scope together. Receipt lookup/retry preserves identities.
- `queries.readInstallationId()` reads the existing ordinary-storage installation marker. It fails on missing/invalid data without creating an identity or touching credentials.
- `assistant.readIntentPage({beforeSequence?,limit?})` returns current-conversation discovery summaries in source sequence order, plus header/paging. Summary fields: userIntentId, revision, phase, userMessageId, assistantMessageId|null, sourceSequence. Existing `readIntent(id)` supplies current full state; discovery and immutable acknowledgement do not grant action authority.
- Transcript/reference/draft, context/memory paging/explicit scope, begin/accept/failure/rearm, reserved action plan/finalize-next-slot/execute/cancel methods are all implemented. Complete relation groups are preserved; over-budget context returns narrowing instead of silent truncation. Exact historical acknowledgement remains separate from mutable action state.
- `readDirectRecovery({afterSequence?,limit?})` proves receipt/no-effect/unresolved on the settled writer queue. `acknowledgeDirectRecovery(operationId)` removes only a proven notice. Neither dispatches an action.
- Preference and conversation clears are explicit direct commands. Conversation clear preserves preferences/cooking/receipts/ordinary installation identity, increments generation and removes chat-derived state. There is no reset-all API.

## Verification actually run

Node24.13.0 on Windows; desktop SQLite3.50.4. Full serial catalogue/domain suite: **147 passed,0 failed**,20.434s, saved `frozen-data-suite.tap`:

```powershell
node --import tsx --test --test-concurrency=1 --test-reporter=tap packages/domain/test/*.test.ts packages/catalogue/test/*.test.ts
node_modules\.bin\tsc.cmd --noEmit -p packages/domain/tsconfig.json
$dataSourceFiles = @(rg --files apps/mobile/src/data -g '*.ts')
& node_modules\.bin\tsc.cmd --noEmit --strict --target ES2022 --module Preserve --moduleResolution Bundler --skipLibCheck --types node @dataSourceFiles
```

Both TypeScript checks produced0 diagnostics. Focused Prettier checks passed; exact file lists and commands are recorded in the manifest. The final action notification repair additionally passed34 affected tests. These are desktop proofs; the native-shaped test adapter does not establish actual iPhone behavior.

Independent review is documented in `../T25/memory-actions-codec-review.md`. The reviewer reports65 independently run targeted tests and isolated corruption/notification/codec probes. Four findings were repaired and rechecked: original ACK metadata correlation, duplicate scope-retry notification, recovery command fingerprint validation, and missing conversation invalidation for assistant receipt journals. Receipt metadata advances store revision and notifies conversation even for no-op domain effects, while semantic context authority remains unchanged unless source/provenance/content actually changes.

## Remaining gates

Actual iPhone Expo SQLite Unicode/binding, independent connections, process termination/reopen and concurrent-open behavior; native rendering/performance/accessibility; provider semantic grounding and action quality; paired trusted transport; signing/distribution and end-to-end UI acceptance remain unverified here. No native emulator/device, provider/server/build/install job was run by Data.

The controlled Carbonara52982 follow-up remains **proposed evidence**, documented at Desktop CookMate `analysis/carbonara-52982-follow-up.md`. Source-conflict and omitted-ingredient annotations require a coordinated content amendment and regenerated verification after the provider diagnostic. Original workbook/PDF/photos remain immutable; no silent reset/migration is authorized to accommodate a future catalogue change.
