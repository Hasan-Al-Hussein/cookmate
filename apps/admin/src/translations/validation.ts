import { canonicalContentJson } from '@cookmate/catalogue/content';
import { requireAdmin } from '../auth/errors';
import { object, text } from '../drafts/validation';
import type { AdminDraftInput } from '../contracts';
import type { AdminTranslationInput } from './contracts';

export const TRANSLATION_INPUT_BYTES = 1024 * 1024;
export const TRANSLATION_RECORD_BYTES = TRANSLATION_INPUT_BYTES + 16 * 1024;
export const TRANSLATION_SOURCE_BYTES = 2 * 1024 * 1024;

/** Own inert data before validation; callers cannot supply getters or retain mutable references. */
export function ownTranslationData(value: unknown, maximum = TRANSLATION_INPUT_BYTES): unknown {
  try {
    return JSON.parse(canonicalContentJson(value, maximum)) as unknown;
  } catch {
    requireAdmin(
      false,
      400,
      'invalid_translation',
      'Translation data is invalid or exceeds its supported bounds.',
    );
  }
}
export function language(value: unknown): asserts value is string {
  let canonical: string | undefined;
  if (
    typeof value === 'string' &&
    value.length <= 35 &&
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/.test(value)
  ) {
    try {
      canonical = Intl.getCanonicalLocales(value)[0];
    } catch {
      /* Rejected below. */
    }
  }
  requireAdmin(
    canonical === value && value !== undefined && value !== 'und',
    400,
    'invalid_language',
    'Use a canonical language tag, for example en, ar or pt-BR.',
  );
}
export function fingerprint(value: unknown): asserts value is string {
  requireAdmin(
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
    400,
    'invalid_fingerprint',
    'Use the exact request fingerprint.',
  );
}
export function translationInput(value: unknown, source: AdminDraftInput): AdminTranslationInput {
  const input = ownTranslationData(value);
  object(input, [
    'title',
    'description',
    'category',
    'cuisine',
    'rawTags',
    'ingredients',
    'instructions',
    'changeSummary',
    'attribution',
  ]);
  text(input.title, 500);
  text(input.description, 10_000, true);
  text(input.category, 200);
  text(input.cuisine, 200);
  text(input.rawTags, 2000, true);
  text(input.changeSummary, 2000);
  requireAdmin(
    ['human', 'machine', 'mixed'].includes(input.attribution as string),
    400,
    'invalid_translation',
    'Declare how the translation was produced.',
  );
  requireAdmin(
    Array.isArray(input.ingredients) &&
      input.ingredients.length === source.ingredients.length &&
      input.ingredients.length <= 200,
    400,
    'translation_alignment',
    'Keep one translated ingredient name for every original ingredient row.',
  );
  for (const row of input.ingredients) {
    object(row, ['rawName']);
    text(row.rawName, 1000);
  }
  requireAdmin(
    Array.isArray(input.instructions) &&
      input.instructions.length === source.instructions.length &&
      input.instructions.length <= 500,
    400,
    'translation_alignment',
    'Keep one translated passage for every original instruction row.',
  );
  for (const row of input.instructions) {
    object(row, ['rawText']);
    text(row.rawText, 20_000);
  }
  return input as unknown as AdminTranslationInput;
}
export function requireCompleteTranslation(input: AdminTranslationInput): void {
  requireAdmin(
    input.title.trim() &&
      input.ingredients.every((row) => row.rawName.trim()) &&
      input.instructions.every((row) => row.rawText.trim()),
    409,
    'translation_incomplete',
    'Complete the translated title and every source row before recording approval.',
  );
}
