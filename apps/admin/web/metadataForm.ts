import type { ReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminMetadataField, AdminMetadataInput } from '../src/contracts';

export const metadataLabels: Record<AdminMetadataField, string> = {
  servings: 'Servings',
  prepMinutes: 'Preparation time',
  cookMinutes: 'Cooking time',
  dietaryTags: 'Dietary tags',
  nutrition: 'Nutrition',
};
export const nutritionLabels = {
  energyKcal: 'Energy · kcal',
  proteinGrams: 'Protein · grams',
  carbohydrateGrams: 'Carbohydrate · grams',
  fatGrams: 'Fat · grams',
} as const;
export interface MetadataForm {
  field: AdminMetadataField;
  unknown: boolean;
  text: string;
  source: string;
  basis: 'per_serving' | 'per_recipe';
  nutrition: Record<keyof typeof nutritionLabels, string>;
}
export function metadataForm(metadata: ReviewedMetadata, field: AdminMetadataField): MetadataForm {
  const row = metadata[field];
  const nutrition = metadata.nutrition.value;
  return {
    field,
    unknown: row.value === null,
    text:
      field === 'dietaryTags'
        ? (metadata.dietaryTags.value?.join('\n') ?? '')
        : field === 'nutrition'
          ? ''
          : String(row.value ?? ''),
    source: row.review?.source ?? '',
    basis: nutrition?.basis ?? 'per_serving',
    nutrition: {
      energyKcal: String(nutrition?.energyKcal ?? ''),
      proteinGrams: String(nutrition?.proteinGrams ?? ''),
      carbohydrateGrams: String(nutrition?.carbohydrateGrams ?? ''),
      fatGrams: String(nutrition?.fatGrams ?? ''),
    },
  };
}
function number(text: string, maximum: number): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > maximum)
    throw new Error(`Enter a number from 0 to ${maximum.toLocaleString()}, or leave it unknown.`);
  return value;
}
export function metadataInput(form: MetadataForm): AdminMetadataInput {
  if (form.unknown) return { field: form.field, value: null, source: null };
  if (!form.source.trim() || form.source.length > 2048 || form.source.includes('\0'))
    throw new Error('Describe the source evidence for this value, using at most 2,048 characters.');
  if (form.field === 'nutrition') {
    const value = {
      basis: form.basis,
      energyKcal: number(form.nutrition.energyKcal, 1_000_000),
      proteinGrams: number(form.nutrition.proteinGrams, 1_000_000),
      carbohydrateGrams: number(form.nutrition.carbohydrateGrams, 1_000_000),
      fatGrams: number(form.nutrition.fatGrams, 1_000_000),
    };
    if (
      Object.keys(nutritionLabels).every(
        (key) => value[key as keyof typeof nutritionLabels] === null,
      )
    )
      throw new Error('Supply at least one reviewed nutrition measure, or mark nutrition unknown.');
    return { field: 'nutrition', value, source: form.source };
  }
  if (form.field === 'dietaryTags') {
    const value = form.text
      .split('\n')
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (
      value.length > 30 ||
      value.some((tag) => tag.length > 80) ||
      new Set(value).size !== value.length
    )
      throw new Error('Use at most 30 distinct dietary tags, each at most 80 characters.');
    return { field: 'dietaryTags', value, source: form.source };
  }
  const value = number(form.text, form.field === 'servings' ? 1000 : 43_200);
  if (value === null || (form.field === 'servings' && value === 0))
    throw new Error(
      form.field === 'servings'
        ? 'Supply servings greater than zero, or mark them unknown.'
        : 'Supply a reviewed time, or mark it unknown.',
    );
  return { field: form.field, value, source: form.source };
}
