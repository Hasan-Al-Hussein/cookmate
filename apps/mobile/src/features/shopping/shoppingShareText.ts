import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { ContentShoppingSnapshot } from '../../data/contentWorkspaceQueries';
import type { Immutable, ManualShoppingItem, ShoppingSnapshot } from '@cookmate/domain';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import { safeSourceUrl } from '../recipes/video/videoModel';

export const SHOPPING_SHARE_MAX_BYTES = 128 * 1024;

export class ShoppingShareError extends Error {
  constructor(
    public readonly reason:
      | 'too_large'
      | 'not_current'
      | 'incomplete_selection'
      | 'unavailable'
      | 'share_failed',
  ) {
    super(`Shopping list export: ${reason}`);
    this.name = 'ShoppingShareError';
  }
}

export interface ShoppingShareRecipe {
  /** Internal deduplication only; never printed. */
  identity?: string;
  creditLines?: readonly string[];
  title: string;
  sourceNotes: readonly string[];
  recipePage: string | null;
  originalSourceUrl: string | null;
}

export function shoppingShareByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function assertShoppingShareSize(text: string): void {
  if (
    text.length > SHOPPING_SHARE_MAX_BYTES ||
    shoppingShareByteLength(text) > SHOPPING_SHARE_MAX_BYTES
  ) {
    throw new ShoppingShareError('too_large');
  }
}

/** Formats the complete current selection without recomputing quantities or dropping warnings. */
export function formatShoppingShare(
  snapshot: Immutable<ShoppingSnapshot>,
  recipeInfo: (recipeId: string, occurrenceId: string) => ShoppingShareRecipe | null,
  manualItems: readonly Immutable<ManualShoppingItem>[] = [],
): string {
  if (snapshot.status !== 'current') throw new ShoppingShareError('not_current');
  const selected = new Set(snapshot.selectedOccurrences.map((meal) => meal.occurrenceId));
  if (
    selected.size !== snapshot.selectedOccurrences.length ||
    new Set(snapshot.scope.occurrenceIds).size !== snapshot.scope.occurrenceIds.length ||
    selected.size !== snapshot.scope.occurrenceIds.length ||
    snapshot.scope.occurrenceIds.some((id) => !selected.has(id))
  ) {
    throw new ShoppingShareError('incomplete_selection');
  }
  if (
    new Set(manualItems.map((item) => item.itemId)).size !== manualItems.length ||
    manualItems.some((item) => item.deleted || !item.name?.trim())
  )
    throw new ShoppingShareError('incomplete_selection');
  const lines: string[] = [];
  let bytes = 0;
  const add = (line = '') => {
    if (line.length > SHOPPING_SHARE_MAX_BYTES) throw new ShoppingShareError('too_large');
    bytes += shoppingShareByteLength(line) + (lines.length ? 1 : 0);
    if (bytes > SHOPPING_SHARE_MAX_BYTES) throw new ShoppingShareError('too_large');
    lines.push(line);
  };
  const purchased =
    snapshot.groups.filter((group) => group.purchased).length +
    manualItems.filter((item) => item.purchased).length;
  add('CookMate shopping list');
  add(`To buy ${snapshot.groups.length + manualItems.length - purchased} · Purchased ${purchased}`);
  add('[ ] To buy   [x] Purchased');
  add();
  if (!snapshot.groups.length)
    add('No ingredient rows are available. Review the selected recipes.');
  for (const group of snapshot.groups) {
    add(`${group.purchased ? '[x]' : '[ ]'} ${group.displayName} — ${group.quantityLabel}`);
    if (group.changed) add('    Changed — review');
    if (group.contributions.some((entry) => entry.quantity.kind === 'review_source')) {
      add('    This amount needs recipe-source review.');
    }
  }
  if (manualItems.length) {
    add();
    add(`Your own items (${manualItems.length}) — entered manually, separate from recipes`);
    for (const item of manualItems) {
      const amount =
        [item.amountText, item.unitText].filter(Boolean).join(' ') || 'Amount not specified';
      add(`${item.purchased ? '[x]' : '[ ]'} ${item.name} — ${amount}`);
    }
  }
  add();
  add(`Selected meals (${snapshot.selectedOccurrences.length}) — all shopping selections`);
  const mealOrder = { breakfast: 0, lunch: 1, dinner: 2 };
  const meals = [...snapshot.selectedOccurrences].sort(
    (a, b) =>
      a.placement.actualDate.localeCompare(b.placement.actualDate) ||
      mealOrder[a.placement.mealKey] - mealOrder[b.placement.mealKey],
  );
  const recipes = new Map<string, ShoppingShareRecipe | null>();
  for (const meal of meals) {
    const recipe = recipeInfo(meal.recipeId, meal.occurrenceId);
    const key = recipe?.identity ?? meal.recipeId;
    if (!recipes.has(key)) recipes.set(key, recipe);
    add(
      `- ${formatPlanDate(meal.placement.actualDate)} · ${mealLabel(meal.placement.mealKey)} — ${recipe?.title ?? `Unavailable recipe (${meal.recipeId})`}`,
    );
  }
  if (!meals.length) add('No meals selected.');
  const withNotes = [...recipes].filter(([, recipe]) => !recipe || recipe.sourceNotes.length);
  if (withNotes.length) {
    add();
    add('Recipe source notes — review before shopping');
    for (const [id, recipe] of withNotes) {
      add(recipe?.title ?? `Unavailable recipe (${id})`);
      if (!recipe)
        add(
          '  The recipe is unavailable in this catalogue. Review its original source before shopping.',
        );
      else for (const note of recipe.sourceNotes) add(`  ${note}`);
    }
  }
  const credited = [...recipes.values()].filter(
    (recipe): recipe is ShoppingShareRecipe => recipe !== null,
  );
  if (credited.length) {
    add();
    add('Recipe credits');
    for (const recipe of credited) {
      add(recipe.title);
      if (recipe.creditLines) {
        for (const line of recipe.creditLines) add(`  ${line}`);
        continue;
      }
      const collection = safeSourceUrl(recipe.recipePage);
      const publisher = safeSourceUrl(recipe.originalSourceUrl);
      add(
        collection ? `  TheMealDB — ${recipe.recipePage}` : '  Recipe collection link unavailable.',
      );
      add(
        publisher
          ? `  Original publisher (${publisher.hostname.replace(/^www\./, '')}) — ${recipe.originalSourceUrl}`
          : recipe.originalSourceUrl
            ? '  Original publisher link unavailable.'
            : '  Original publisher link not supplied.',
      );
    }
  }
  add();
  add(
    'Amounts are copied as displayed in CookMate. Unclear amounts and source-review notes are not estimates.',
  );
  add(
    'This is a snapshot. Later meal, quantity or purchased-status changes are not sent automatically.',
  );
  return lines.join('\n');
}

type CurrentContentShopping = Extract<ContentShoppingSnapshot, { kind: 'current' }>;
const refKey = (ref: CurrentContentShopping['selected'][number]['contentRef']) =>
  canonicalContentJson(ref, 1024);
function creditUrl(label: string, url: string | null): string {
  return url === null
    ? `${label} — link not supplied.`
    : safeSourceUrl(url)
      ? `${label} — ${url}`
      : `${label} — link unavailable.`;
}
/** Exact refs join trusted metadata internally; readable exports contain no workspace IDs or hashes. */
export function formatContentShoppingShare(
  value: Immutable<CurrentContentShopping>,
  manualItems: readonly Immutable<ManualShoppingItem>[] = [],
): string {
  if (value.share.kind !== 'ready') throw new ShoppingShareError('too_large');
  const metadata = new Map(
    value.share.recipes.map((recipe) => [refKey(recipe.contentRef), recipe]),
  );
  if (metadata.size !== value.share.recipes.length)
    throw new ShoppingShareError('incomplete_selection');
  const selected = new Map(value.selected.map((row) => [row.occurrence.occurrenceId, row]));
  if (
    selected.size !== value.selected.length ||
    selected.size !== value.snapshot.selectedOccurrences.length
  )
    throw new ShoppingShareError('incomplete_selection');
  const versions = new Map<string, string[]>();
  const titles = new Map<string, string>();
  for (const meal of value.snapshot.selectedOccurrences) {
    const row = selected.get(meal.occurrenceId),
      key = row ? refKey(row.contentRef) : null;
    if (
      !row ||
      !key ||
      row.content.kind !== 'readable' ||
      row.contentRef.recipeId !== meal.recipeId ||
      canonicalContentJson(row.occurrence, 2048) !== canonicalContentJson(meal, 2048) ||
      !metadata.has(key)
    )
      throw new ShoppingShareError('incomplete_selection');
    const refs = versions.get(meal.recipeId) ?? [];
    if (!refs.includes(key)) refs.push(key);
    versions.set(meal.recipeId, refs);
    titles.set(key, metadata.get(key)!.title);
  }
  if (titles.size !== metadata.size) throw new ShoppingShareError('incomplete_selection');
  const notes = new Map<string, string[]>();
  const seenNotes = new Set<string>();
  for (const notice of value.notices) {
    const row = selected.get(notice.occurrenceId);
    if (!row) throw new ShoppingShareError('incomplete_selection');
    const key = refKey(row.contentRef),
      recipe = metadata.get(key)!;
    const sourceKey = refKey(notice.contentRef);
    const inherited = notice.disposition === 'inherited_unresolved';
    const source = inherited
      ? recipe.retainedSources.find(
          (source) =>
            refKey(source.ref) === sourceKey && source.disposition === 'inherited_unresolved',
        )
      : null;
    if (inherited ? !source : sourceKey !== key)
      throw new ShoppingShareError('incomplete_selection');
    const bucket = notes.get(key) ?? [];
    for (const annotation of notice.annotations) {
      const noteKey = canonicalContentJson(
        [key, sourceKey, notice.disposition, annotation],
        32 * 1024,
      );
      if (seenNotes.has(noteKey)) continue;
      seenNotes.add(noteKey);
      bucket.push(
        inherited
          ? `Inherited unresolved source — ${source!.title}: ${annotation.note}`
          : annotation.note,
      );
    }
    notes.set(key, bucket);
  }
  return formatShoppingShare(
    value.snapshot,
    (recipeId, occurrenceId) => {
      const row = selected.get(occurrenceId)!;
      const key = refKey(row.contentRef),
        recipe = metadata.get(key)!;
      const refs = versions.get(recipeId)!;
      const title =
        refs.length > 1
          ? `${recipe.title} (selected version ${refs.indexOf(key) + 1})`
          : recipe.title;
      const creditLines: string[] = [];
      if (recipe.contentKind === 'imported') {
        creditLines.push(creditUrl('TheMealDB', recipe.recipePage));
        const publisher = safeSourceUrl(recipe.originalSourceUrl);
        creditLines.push(
          creditUrl(
            publisher
              ? `Original publisher (${publisher.hostname.replace(/^www\./, '')})`
              : 'Original publisher',
            recipe.originalSourceUrl,
          ),
        );
      } else {
        for (const credit of recipe.credits) creditLines.push(creditUrl(credit.label, credit.url));
        if (recipe.recipePage !== null)
          creditLines.push(creditUrl('Recipe source', recipe.recipePage));
        if (recipe.originalSourceUrl !== null)
          creditLines.push(creditUrl('Original publisher', recipe.originalSourceUrl));
        if (!creditLines.length)
          creditLines.push('No source credits supplied for this authored version.');
      }
      for (const source of recipe.retainedSources) {
        creditLines.push(
          `${source.disposition === 'inherited_unresolved' ? 'Retained source — inherited unresolved' : 'Retained original source'}: ${source.title}`,
        );
        creditLines.push(creditUrl('Recipe source', source.recipePage));
        creditLines.push(creditUrl('Original publisher', source.originalSourceUrl));
      }
      return {
        identity: key,
        title,
        sourceNotes: notes.get(key) ?? [],
        recipePage: null,
        originalSourceUrl: null,
        creditLines,
      };
    },
    manualItems,
  );
}

export interface ShoppingShareTransfer {
  share(text: string): Promise<'sheet_closed' | 'cancelled' | 'download_requested'>;
  dispose(): void;
}

export function shoppingShareFilename(): string {
  return `CookMate-shopping-${new Date().toISOString().replace(/[-:.]/g, '')}.txt`;
}
