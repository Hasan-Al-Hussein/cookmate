# CookMate domain

Pure TypeScript shared behavior. Runtime dependencies: shared contracts only. No React, Expo, SQL, filesystem, network or provider import belongs here.

## Search, available now

```ts
import { catalogue } from '@cookmate/catalogue';
import { createRecipeSearch } from '@cookmate/domain';

const recipes = createRecipeSearch(catalogue);
const result = recipes.search({
  query: 'peppers',
  category: 'Vegan',
  cuisine: 'Spanish',
  ingredients: ['Olive Oil', 'Padron peppers'],
});
```

Create one search index for the installed catalogue, then reuse it. `facets` contains source category/cuisine/ingredient labels. `matches` contains actual IDs and source-citable reasons. Render `suggestions` separately as possible spelling matches; they never confer authority to act on a recipe. Retain the user's requested text/filters while showing suggestions. Invalid criteria throw rather than silently ignoring an unsupported filter. An empty matches list is successful retrieval, not a storage failure.

Rules: Unicode NFKD accent/case/spacing normalization; title substrings and ingredient/cuisine/category word prefixes; AND across query tokens and active filters. Multiple ingredient filters require all exact normalized source ingredient labels. Those labels reflect structured source rows and do not certify an exhaustive recipe, pantry completeness or dietary safety. Relevant annotations/instructions must accompany recipe answers. Ingredient search normalization does not authorize quantity grouping or substitutions.

Country/demonym aliases are explicitly listed in `CUISINE_ALIASES`; match reasons expose the original source cuisine. For example, Indian resolves the source label India. A supplied Vegan or Vegetarian category remains a source label, not a health/allergy guarantee. No rating, duration, nutrition or popularity ranking exists.

Ranking favors exact title, title fragments, then matched source fields; ties retain workbook recipe order. Approximate candidates are available only when exact matching found none and preserve all explicit filters. Adjacent transpositions and bounded edit distance are suggestions. Both consumers receive catalogue identity, rule version and an exact search-implementation fingerprint. After an intentional search change, run `scripts/content/fingerprint_search.py` and the source oracle tests. Source fingerprints are not native/provider parity proof.

## Calendar helpers, available now

`getPlanWeek(date)` returns a Monday-based supported week, its explicit day values and nullable previous/next week anchors. `PLAN_MIN_DATE`/`PLAN_MAX_DATE` are 1900-01-01 and 2100-12-31; the last partial week remains usable. `shiftPlanDate(date, days)` returns null across those bounds. These helpers use Gregorian calendar arithmetic without creating a timestamp. `relativeDateContextChanged` flags changed day, timezone or offset for a pending relative-date action; it never changes a committed placement.

## Native service ports, integration pending

`services.ts` exports `CookMateQueries`, `CookMateCommands`, `CookMateServices` and their snapshot types. Consumers can type against them now. Catalogue/favourites/plan/shopping/preferences/receipt repositories, schema initialization, the internal command executor, favourites/preferences/clear and plan/shopping handlers exist under the mobile data boundary with real desktop SQLite fixtures. The complete native service factory and assistant persistence composition are pending. Combined recipe/placement editing awaits the coordinated shared scope-guard amendment. Source catalogue/search is available independently.

Queries return `RepositoryResult`: ready includes a snapshot/revision (empty/null are valid), failed includes the shared typed error. Plan snapshots include persistent shopping scope beyond the visible date range. Shopping snapshots expose selected occurrences, projection status, traceable contributions, group demand fingerprint and purchase/review state. The UI renders domain-computed `quantityLabel`; it does not recompute shopping arithmetic. A pending projection must be visible as pending.

Commands consume frozen app-owned `LocalCommand` and return actual shared `CommandResult`. The internal executor revalidates authority/context/revisions, commits state with receipts, and emits `StoreChange` only after commit is proven. An uncertain delivery retains its pending notification for exact-command reconciliation without duplicate effects or announcements. Transcript/model proposals are not executable command authority. Pending/error UI may acknowledge input promptly, but committed success requires a receipt. `close()` belongs to provider lifecycle, not individual screen cleanup.

`createCommandPreparer(platform, catalogueBoundary)` now creates a new app-owned operation and intent, copies/validates the payload before hashing, and returns a frozen `LocalCommand` using Foundation's canonical fingerprint input. Retain that exact command for a retry. `CommandPlatform` provides UUID and SHA-256; the mobile adapter is `src/domain/commandPlatform.ts`. This helper does not authorize an action, choose state guards or execute it. State-aware confirmation and complete factory integration remain required before enabling mutations in the UI.

`AssistantPersistencePort` in `conversationPorts.ts` is the canonical AI integration contract. Internal conversation repositories now provide validated transcript pagination, old-reference lookup, drafts, durable begin/accept/failure records and accepted guard baselines. Reply reference sets retain their IDs/order and are bound to the actual app-owned assistant message ID. Startup recovery cancels unfinished authority or leaves dispatched work reconciling; it never dispatches restored actions. Conversation clear advances generation and preserves committed receipts/cooking data. These pieces have desktop SQLite tests. Source-linked memory/context assembly, guarded action freezing/slot journaling/cancellation and full port/factory composition remain pending under a coordinated contract amendment.

## Shopping calculations

`parseSourceQuantity` preserves unsupported measures as unparsed and absent measures as unknown. Supported exact values use rational BigInt arithmetic with lexical unit aliases only. `buildShoppingProjection` creates one traceable contribution per selected occurrence/source row plus the six reviewed instruction-only demands. Grouping never imports search aliases or invents servings/conversions. Display/source order does not change demand identity; different contributing occurrences or rule versions do. `reconcilePurchaseState` retains a checkbox only for identical active demand. SQL adapters commit plan/scope, projection, purchase reconciliation and receipt together. Dormant identities prevent removed/re-added demand inheriting credit. Actual iPhone performance remains to be measured.

See `design/native-repository-boundary.md` for the implemented schema/connection boundary and remaining native proof. No iPhone persistence, performance, process-restoration or actual gateway parity is claimed by the current source and desktop tests.
