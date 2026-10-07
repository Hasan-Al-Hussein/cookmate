import {
  canonicalContentJson,
  validateRecipeContentRef,
  type ReadingLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import type { PlanOccurrence, QualityAnnotation } from '@cookmate/contracts';
import {
  buildShoppingProjection,
  type Immutable,
  type ProjectedShoppingGroup,
  type ShoppingContribution,
} from '@cookmate/domain';
import { freezeResult } from './query';

export const REVISION_SHOPPING_LIMITS = Object.freeze({
  occurrences: 1000,
  contributions: 20_000,
  sourceBytes: 8 * 1024 * 1024,
});

export interface PinnedShoppingOccurrence {
  occurrence: PlanOccurrence;
  contentRef: RecipeContentRef;
}
export interface RevisionShoppingContribution extends ShoppingContribution {
  contentRef: RecipeContentRef;
}
export interface RevisionShoppingGroup extends Omit<ProjectedShoppingGroup, 'contributions'> {
  contributions: readonly RevisionShoppingContribution[];
  /** Exact provenance changes even when the quantities a shopper needs remain unchanged. */
  sourceFingerprint: string;
}
export interface ShoppingRevisionNotice {
  occurrenceId: string;
  contentRef: RecipeContentRef;
  disposition: 'current_revision' | 'inherited_unresolved';
  annotations: QualityAnnotation[];
}

/**
 * Inactive adoption integration: resolve saved pins against a host-verified content reader.
 * Never fall back to the newest recipe for a missing/withdrawn historical reference.
 * This computes a review only; it does not activate content or change purchase marks.
 */
export async function buildRevisionShoppingProjection(
  input: readonly Immutable<PinnedShoppingOccurrence>[],
  options: {
    lookupExact(ref: RecipeContentRef): ReadingLookup;
    sha256(text: string): Promise<string>;
  },
): Promise<Immutable<{ groups: RevisionShoppingGroup[]; notices: ShoppingRevisionNotice[] }>> {
  if (!Array.isArray(input) || input.length > REVISION_SHOPPING_LIMITS.occurrences)
    throw new Error('Shopping selection exceeds supported bound');
  const selected: PinnedShoppingOccurrence[] = JSON.parse(
    canonicalContentJson(input, 2 * 1024 * 1024),
  );
  const pins = new Map<string, RecipeContentRef>();
  const resolved = new Map<string, Extract<ReadingLookup, { kind: 'readable' }>['recipe']>();
  const notices: ShoppingRevisionNotice[] = [];
  let contributionCount = 0;
  for (const item of selected) {
    if (
      !item ||
      !validateRecipeContentRef(item.contentRef) ||
      !item.occurrence ||
      item.contentRef.recipeId !== item.occurrence.recipeId ||
      pins.has(item.occurrence.occurrenceId)
    )
      throw new Error('Invalid pinned shopping occurrence');
    const reading = options.lookupExact(item.contentRef);
    if (reading.kind !== 'readable')
      throw new Error(
        reading.kind === 'withdrawn'
          ? 'Pinned recipe was withdrawn'
          : 'Pinned recipe is unavailable',
      );
    if (canonicalContentJson(reading.recipe.contentRef) !== canonicalContentJson(item.contentRef))
      throw new Error('Pinned recipe identity changed');
    contributionCount +=
      reading.recipe.ingredients.length +
      reading.recipe.annotations.filter((note) => note.kind === 'instruction_only_ingredient')
        .length;
    if (contributionCount > REVISION_SHOPPING_LIMITS.contributions)
      throw new Error('Shopping source demand exceeds supported bound');
    pins.set(item.occurrence.occurrenceId, item.contentRef);
    resolved.set(item.occurrence.occurrenceId, reading.recipe);
  }
  // Bound expanded source text before copying notices, building groups, or asynchronous hashes.
  canonicalContentJson(
    [...resolved.values()].map((recipe) => ({
      ingredients: recipe.ingredients.map(({ recipeId, position, rawName, rawMeasure }) => ({
        recipeId,
        position,
        rawName,
        rawMeasure,
      })),
      annotations: recipe.annotations,
      inherited: recipe.retainedSources
        .filter((source) => source.disposition === 'inherited_unresolved')
        .map((source) => source.document.recipe.annotations),
    })),
    REVISION_SHOPPING_LIMITS.sourceBytes,
  );
  for (const item of selected) {
    const recipe = resolved.get(item.occurrence.occurrenceId)!;
    if (recipe.annotations.length)
      notices.push({
        occurrenceId: item.occurrence.occurrenceId,
        contentRef: item.contentRef,
        disposition: 'current_revision',
        annotations: JSON.parse(canonicalContentJson(recipe.annotations)),
      });
    // Original ingredient warnings are preserved for review, not reinterpreted as quantities
    // in a newer authored recipe. Its original pinned revision still projects its own demands.
    for (const source of recipe.retainedSources) {
      if (
        source.disposition !== 'inherited_unresolved' ||
        !source.document.recipe.annotations.length
      )
        continue;
      notices.push({
        occurrenceId: item.occurrence.occurrenceId,
        contentRef: JSON.parse(canonicalContentJson(source.ref)),
        disposition: source.disposition,
        annotations: JSON.parse(canonicalContentJson(source.document.recipe.annotations)),
      });
    }
  }
  // The existing arithmetic copies raw contributions before its first asynchronous hash.
  const quantityGroups = await buildShoppingProjection(
    selected.map((item) => item.occurrence),
    {
      readRecipe: (recipeId, occurrence) => {
        const value = occurrence ? resolved.get(occurrence.occurrenceId) : undefined;
        return value?.recipeId === recipeId ? value : undefined;
      },
      sha256: options.sha256,
    },
  );
  const groups: RevisionShoppingGroup[] = [];
  for (const group of quantityGroups) {
    const contributions = group.contributions.map((contribution) => ({
      ...contribution,
      contentRef: pins.get(contribution.occurrenceId)!,
    }));
    // The demand hash already binds each contribution to its occurrence. Bind each occurrence's
    // exact revision once, rather than repeating its full reference for every ingredient row.
    const groupPins = [...new Set(contributions.map((item) => item.occurrenceId))]
      .sort()
      .map((occurrenceId) => [occurrenceId, pins.get(occurrenceId)!]);
    const sourceFingerprint = await options.sha256(
      canonicalContentJson([
        'cookmate-revision-shopping-sources-v1',
        group.demandFingerprint,
        groupPins,
      ]),
    );
    if (!/^[0-9a-f]{64}$/.test(sourceFingerprint)) throw new Error('Invalid source fingerprint');
    groups.push({ ...group, contributions, sourceFingerprint });
  }
  notices.sort((left, right) => {
    const a = canonicalContentJson([left.occurrenceId, left.contentRef]);
    const b = canonicalContentJson([right.occurrenceId, right.contentRef]);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return freezeResult({ groups, notices });
}
