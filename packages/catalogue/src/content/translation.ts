import type { Immutable } from '../catalogue';
import type { PublishedRecipeTranslation } from './overlay-types';
import { CONTENT_AUTHORING_LIMITS as LIMITS, type RecipeContentRevision } from './types';
import { exact, text } from './validation';

/** Same bounded canonical language grammar as the private editorial translation workflow. */
export function validateTranslationLanguage(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 35 ||
    value === 'und' ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/.test(value)
  )
    return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}
const complete = (value: unknown, maximum: number): value is string =>
  text(value, maximum) && value.trim().length > 0;
const optional = (value: unknown, maximum: number) => value === null || complete(value, maximum);

/** Row association follows the exact original, not an independently numbered translation. */
export function validateTranslationContent(
  value: unknown,
  source: Immutable<RecipeContentRevision>,
): value is PublishedRecipeTranslation['content'] {
  if (
    !exact(value, [
      'title',
      'description',
      'category',
      'cuisine',
      'rawTags',
      'ingredients',
      'instructions',
    ])
  )
    return false;
  const original = source.document.recipe;
  return (
    complete(value.title, LIMITS.title) &&
    optional(value.description, LIMITS.description) &&
    complete(value.category, LIMITS.category) &&
    complete(value.cuisine, LIMITS.cuisine) &&
    optional(value.rawTags, LIMITS.rawTags) &&
    Array.isArray(value.ingredients) &&
    value.ingredients.length > 0 &&
    value.ingredients.length <= LIMITS.ingredients &&
    value.ingredients.length === original.ingredients.length &&
    value.ingredients.every(
      (row, index) =>
        exact(row, ['position', 'rawName']) &&
        row.position === original.ingredients[index]!.position &&
        complete(row.rawName, LIMITS.ingredientName),
    ) &&
    Array.isArray(value.instructions) &&
    value.instructions.length > 0 &&
    value.instructions.length <= LIMITS.instructions &&
    value.instructions.length === original.instructions.length &&
    value.instructions.every(
      (row, index) =>
        exact(row, ['sequence', 'rawText']) &&
        row.sequence === original.instructions[index]!.sequence &&
        complete(row.rawText, LIMITS.passage),
    )
  );
}
