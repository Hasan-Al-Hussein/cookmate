import { isUtcInstant, validatePlanOccurrence } from '@cookmate/contracts';
import type { PlanOccurrence, Recipe } from '@cookmate/contracts';
import type { ShoppingContribution, ShoppingGroup } from './services';
import type { Immutable } from './search';
import { isSupportedPlanDate } from './dates';
import {
  formatExactQuantity,
  ingredientGroupingIdentity,
  parseSourceQuantity,
  QUANTITY_RULE_VERSION,
  sumCompatibleQuantities,
} from './quantities';

/** These names come from the individually reviewed instruction-only annotations, not prose parsing. */
const annotationIngredients: Readonly<Record<string, string>> = Object.freeze({
  '53262-instruction-only-salt': 'Flaky sea salt',
  '53064-instruction-only-salt': 'Salt',
  '52835-instruction-only-salt': 'Salt',
  '52835-instruction-only-black-pepper': 'Black Pepper',
  '53150-instruction-only-salt': 'Sea salt',
  '53230-instruction-only-salt': 'Salt',
});
export interface ProjectedShoppingGroup extends Pick<
  ShoppingGroup,
  'groupKey' | 'displayName' | 'quantityLabel' | 'contributions' | 'demandFingerprint'
> {
  groupingVersion: string;
}
export interface ShoppingProjectionOptions<RecipeType extends ShoppingProjectionRecipe = Recipe> {
  /** Exact-occurrence readers may use the pin; legacy packaged readers ignore the context. */
  readRecipe(
    recipeId: string,
    occurrence?: Immutable<PlanOccurrence>,
  ): Immutable<RecipeType> | undefined;
  sha256(text: string): Promise<string>;
}
/** Quantity projection needs source identity and exact text, never fabricated workbook rows. */
export type ShoppingProjectionRecipe = Pick<Recipe, 'recipeId' | 'annotations'> & {
  ingredients: Pick<
    Recipe['ingredients'][number],
    'recipeId' | 'position' | 'rawName' | 'rawMeasure'
  >[];
};
interface DraftGroup {
  identity: string;
  displayName: string;
  contributions: ShoppingContribution[];
}
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function groupingKey(contribution: ShoppingContribution): string {
  const quantity = contribution.quantity;
  return JSON.stringify([
    ingredientGroupingIdentity(contribution.rawName),
    quantity.kind,
    quantity.kind === 'exact' ? quantity.unit : contribution.rawMeasure,
  ]);
}
function quantityLabel(contributions: readonly ShoppingContribution[]): string {
  const first = contributions[0]!;
  if (first.quantity.kind === 'exact') {
    const values = contributions.map((item) => {
      if (item.quantity.kind !== 'exact') throw new Error('Incompatible projection group');
      return item.quantity;
    });
    return formatExactQuantity(sumCompatibleQuantities(values));
  }
  if (first.quantity.kind === 'review_source') return 'Review source instructions';
  if (first.quantity.kind === 'unknown') return 'Amount not supplied';
  return first.rawMeasure!;
}

/** One source recipe copy per selected occurrence. Every source row remains a traceable contribution. */
export async function buildShoppingProjection(
  input: readonly Immutable<PlanOccurrence>[],
  options: ShoppingProjectionOptions<ShoppingProjectionRecipe>,
): Promise<readonly ProjectedShoppingGroup[]> {
  if (input.length > 1000) throw new Error('Shopping selection exceeds supported bound');
  const seen = new Set<string>();
  const contributionIds = new Set<string>();
  const groups = new Map<string, DraftGroup>();
  const add = (contribution: ShoppingContribution) => {
    if (contributionIds.has(contribution.contributionId))
      throw new Error('Duplicate source contribution');
    contributionIds.add(contribution.contributionId);
    const identity = groupingKey(contribution);
    const group = groups.get(identity) ?? {
      identity,
      displayName: contribution.rawName,
      contributions: [],
    };
    // A deterministic label does not depend on selection order or random occurrence IDs.
    if (compare(contribution.rawName, group.displayName) < 0)
      group.displayName = contribution.rawName;
    group.contributions.push(contribution);
    groups.set(identity, group);
  };
  for (const occurrence of input) {
    if (
      !validatePlanOccurrence(occurrence) ||
      !isSupportedPlanDate(occurrence.placement.actualDate) ||
      !isUtcInstant(occurrence.createdAt) ||
      !isUtcInstant(occurrence.updatedAt) ||
      seen.has(occurrence.occurrenceId)
    )
      throw new Error('Invalid selected occurrence');
    seen.add(occurrence.occurrenceId);
    const recipe = options.readRecipe(occurrence.recipeId, occurrence);
    if (!recipe || recipe.recipeId !== occurrence.recipeId)
      throw new Error('Selected recipe is unavailable');
    for (const ingredient of recipe.ingredients) {
      if (
        ingredient.recipeId !== recipe.recipeId ||
        !Number.isSafeInteger(ingredient.position) ||
        ingredient.position < 1
      )
        throw new Error('Ingredient source owner changed');
      add({
        contributionId: `${occurrence.occurrenceId}:ingredient:${ingredient.position}`,
        occurrenceId: occurrence.occurrenceId,
        recipeId: recipe.recipeId,
        source: { recipeId: recipe.recipeId, section: 'ingredient', position: ingredient.position },
        rawName: ingredient.rawName,
        rawMeasure: ingredient.rawMeasure,
        quantity: parseSourceQuantity(ingredient.rawMeasure),
      });
    }
    for (const annotation of recipe.annotations) {
      if (annotation.kind !== 'instruction_only_ingredient') continue;
      const rawName = annotationIngredients[annotation.annotationId];
      if (!rawName || annotation.recipeId !== recipe.recipeId)
        throw new Error('Instruction-only demand needs review');
      add({
        contributionId: `${occurrence.occurrenceId}:annotation:${annotation.annotationId}`,
        occurrenceId: occurrence.occurrenceId,
        recipeId: recipe.recipeId,
        source: {
          recipeId: recipe.recipeId,
          section: 'annotation',
          annotationId: annotation.annotationId,
        },
        rawName,
        rawMeasure: null,
        quantity: { kind: 'review_source' },
      });
    }
  }
  // All caller/source data above is copied before the first asynchronous hash call.
  const projected: ProjectedShoppingGroup[] = [];
  for (const group of groups.values()) {
    group.contributions.sort((a, b) => compare(a.contributionId, b.contributionId));
    const groupKey = await options.sha256(JSON.stringify(['shopping-group', group.identity]));
    const demandFingerprint = await options.sha256(
      JSON.stringify({ ruleVersion: QUANTITY_RULE_VERSION, contributions: group.contributions }),
    );
    if (!/^[0-9a-f]{64}$/.test(groupKey) || !/^[0-9a-f]{64}$/.test(demandFingerprint))
      throw new Error('Invalid projection fingerprint');
    projected.push({
      groupKey,
      groupingVersion: QUANTITY_RULE_VERSION,
      displayName: group.displayName,
      quantityLabel: quantityLabel(group.contributions),
      contributions: group.contributions,
      demandFingerprint,
    });
  }
  return projected.sort(
    (a, b) =>
      compare(a.displayName.toLowerCase(), b.displayName.toLowerCase()) ||
      compare(a.groupKey, b.groupKey),
  );
}

/** A purchased checkbox is a review state; only unchanged complete demand retains it. */
export function reconcilePurchaseState(
  next: Pick<ProjectedShoppingGroup, 'demandFingerprint'>,
  previous?: Pick<ShoppingGroup, 'demandFingerprint' | 'purchased' | 'changed' | 'revision'> & {
    active?: boolean;
  },
  relatedPreviousDemand = false,
): Pick<ShoppingGroup, 'purchased' | 'changed' | 'revision'> {
  if (!/^[0-9a-f]{64}$/.test(next.demandFingerprint)) throw new Error('Invalid demand identity');
  if (!previous) return { purchased: false, changed: relatedPreviousDemand, revision: 0 };
  if (
    !/^[0-9a-f]{64}$/.test(previous.demandFingerprint) ||
    !Number.isSafeInteger(previous.revision) ||
    previous.revision < 0 ||
    typeof previous.purchased !== 'boolean' ||
    typeof previous.changed !== 'boolean'
  )
    throw new Error('Invalid previous purchase state');
  if (previous.active !== false && previous.demandFingerprint === next.demandFingerprint)
    return {
      purchased: previous.purchased,
      changed: previous.changed,
      revision: previous.revision,
    };
  if (!Number.isSafeInteger(previous.revision + 1)) throw new Error('Purchase revision exhausted');
  return { purchased: false, changed: true, revision: previous.revision + 1 };
}
