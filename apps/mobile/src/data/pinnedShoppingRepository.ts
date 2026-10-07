import {
  canonicalContentJson,
  validateRecipeContentRef,
  type ReadingLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { isUtcInstant, validatePlanOccurrence, type PlanOccurrence } from '@cookmate/contracts';
import {
  isSupportedPlanDate,
  type Immutable,
  type ShoppingProjectionRecipe,
} from '@cookmate/domain';
import {
  admitPinnedShoppingRows,
  readSelectedShoppingOccurrencesInSnapshot,
  type StoredShoppingProjectionOptions,
} from './shoppingRepository';
import { readShoppingScopeInSnapshot } from './stateRepositories';
import {
  REVISION_SHOPPING_LIMITS,
  type PinnedShoppingOccurrence,
} from './revisionShoppingProjection';
import { freezeResult } from './query';
import { StorageFault, type SqlSession } from './sql';

export interface PinnedShoppingPorts {
  /** Must come from the host-verified content reader; never a newest-recipe fallback. */
  lookupExact(ref: RecipeContentRef): ReadingLookup;
  sha256(text: string): Promise<string>;
}
function valid(condition: unknown): asserts condition {
  if (!condition)
    throw new StorageFault('storage_failure', 'Pinned shopping content is unavailable or invalid');
}

/** Own all source fields synchronously. Later caller/reader mutation cannot rebind a calculation. */
export function createPinnedShoppingProjectionOptions(
  input: readonly Immutable<PinnedShoppingOccurrence>[],
  ports: PinnedShoppingPorts,
): StoredShoppingProjectionOptions {
  valid(Array.isArray(input) && input.length <= REVISION_SHOPPING_LIMITS.occurrences);
  const selected = JSON.parse(
    canonicalContentJson(input, 2 * 1024 * 1024),
  ) as PinnedShoppingOccurrence[];
  const refs = new Map<string, RecipeContentRef>();
  const sources = new Map<string, Immutable<ShoppingProjectionRecipe>>();
  let contributions = 0,
    bytes = 0;
  for (const item of selected) {
    valid(
      item &&
        validateRecipeContentRef(item.contentRef) &&
        validatePlanOccurrence(item.occurrence) &&
        isSupportedPlanDate(item.occurrence.placement.actualDate) &&
        isUtcInstant(item.occurrence.createdAt) &&
        isUtcInstant(item.occurrence.updatedAt) &&
        item.contentRef.recipeId === item.occurrence.recipeId &&
        !refs.has(item.occurrence.occurrenceId),
    );
    const reading = ports.lookupExact(item.contentRef);
    valid(reading.kind === 'readable');
    valid(
      canonicalContentJson(reading.recipe.contentRef) === canonicalContentJson(item.contentRef),
    );
    const recipe = reading.recipe;
    contributions +=
      recipe.ingredients.length +
      recipe.annotations.filter((note) => note.kind === 'instruction_only_ingredient').length;
    valid(contributions <= REVISION_SHOPPING_LIMITS.contributions);
    const json = canonicalContentJson(
      {
        recipeId: recipe.recipeId,
        ingredients: recipe.ingredients.map(({ recipeId, position, rawName, rawMeasure }) => ({
          recipeId,
          position,
          rawName,
          rawMeasure,
        })),
        annotations: recipe.annotations,
      },
      REVISION_SHOPPING_LIMITS.sourceBytes,
    );
    bytes += new TextEncoder().encode(json).byteLength;
    valid(bytes <= REVISION_SHOPPING_LIMITS.sourceBytes);
    refs.set(item.occurrence.occurrenceId, freezeResult(item.contentRef));
    sources.set(
      item.occurrence.occurrenceId,
      freezeResult(JSON.parse(json) as ShoppingProjectionRecipe),
    );
  }
  const sha256 = ports.sha256;
  return Object.freeze({
    sha256,
    readRecipe(recipeId: string, occurrence?: Immutable<PlanOccurrence>) {
      const recipe = occurrence ? sources.get(occurrence.occurrenceId) : undefined;
      return recipe?.recipeId === recipeId ? recipe : undefined;
    },
    contentRefForOccurrence(occurrenceId: string) {
      const ref = refs.get(occurrenceId);
      valid(ref);
      return ref;
    },
  });
}

/** No transaction or writes: caller keeps this read and its ledger/rebuild in one serialized snapshot. */
export async function readPinnedShoppingContextInSnapshot(
  session: SqlSession,
  ports: PinnedShoppingPorts,
) {
  await admitPinnedShoppingRows(session);
  const scope = await readShoppingScopeInSnapshot(session);
  const occurrences = await readSelectedShoppingOccurrencesInSnapshot(session, scope);
  const pins = await session.all<{
    occurrenceId: string;
    recipeId: string;
    revisionId: string;
    contentFingerprint: string;
  }>(
    `SELECT p.occurrence_id occurrenceId,p.recipe_id recipeId,p.revision_id revisionId,p.content_fingerprint contentFingerprint FROM shopping_selection s JOIN plan_content_pin p ON p.occurrence_id=s.occurrence_id WHERE s.scope_id=? ORDER BY p.occurrence_id`,
    [scope.scopeId],
  );
  valid(pins.length === occurrences.length);
  const byId = new Map(pins.map(({ occurrenceId, ...ref }) => [occurrenceId, ref]));
  const pinnedOccurrences = occurrences.map((occurrence) => {
    const contentRef = byId.get(occurrence.occurrenceId);
    valid(
      contentRef &&
        contentRef.recipeId === occurrence.recipeId &&
        validateRecipeContentRef(contentRef),
    );
    return { occurrence, contentRef };
  });
  return freezeResult({
    pinnedOccurrences,
    occurrences,
    options: createPinnedShoppingProjectionOptions(pinnedOccurrences, ports),
  });
}
