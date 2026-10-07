import {
  canonicalContentJson,
  ContentValidationError,
  CONTENT_AUTHORING_LIMITS as limits,
  CONTENT_LIMITS,
  validateRecipeVideoUrl,
} from '@cookmate/catalogue/content';
import type { AdminDraftInput } from '../contracts';

// Leave room for immutable identity, source/approval evidence, reviewed metadata and inspected media.
// This is a conservative admission budget, not permission to shorten the editor's original text.
export const ADMIN_PUBLICATION_INPUT_BYTES = CONTENT_LIMITS.documentBytes - 64 * 1024;

/** Drafts may be incomplete or broader than the client format; approval may not truncate them. */
export function publicationInputIssues(input: AdminDraftInput): string[] {
  const issues: string[] = [];
  try {
    canonicalContentJson(input, ADMIN_PUBLICATION_INPUT_BYTES);
  } catch (error) {
    if (
      !(error instanceof ContentValidationError) ||
      !['json_size', 'json_bound'].includes(error.code)
    )
      throw error;
    issues.push(
      `Publication supports at most ${ADMIN_PUBLICATION_INPUT_BYTES / 1024} KiB of draft content, leaving room for provenance and media evidence. Reduce it explicitly; no content was truncated.`,
    );
  }
  if (input.description === '')
    issues.push('Use no description or enter a description before approval.');
  for (const key of ['recipePage', 'originalSourceUrl'] as const) {
    if (input[key] === '')
      issues.push(`${key}: use no link or a complete HTTP/HTTPS address before approval.`);
  }
  input.credits.forEach((row, index) => {
    if (row.url === '')
      issues.push(`Source credit ${index + 1}: use no link or a complete HTTP/HTTPS address.`);
  });
  for (const key of [
    'title',
    'description',
    'category',
    'cuisine',
    'rawTags',
    'changeSummary',
  ] as const) {
    if ((input[key]?.length ?? 0) > limits[key])
      issues.push(
        `${key}: publication supports at most ${limits[key]} characters. Shorten it explicitly; your saved draft is unchanged.`,
      );
  }
  if (input.ingredients.length > limits.ingredients)
    issues.push(`Publication supports at most ${limits.ingredients} ingredient rows.`);
  if (input.instructions.length > limits.instructions)
    issues.push(`Publication supports at most ${limits.instructions} instruction rows.`);
  if (input.credits.length > limits.credits)
    issues.push(`Publication supports at most ${limits.credits} source-credit rows.`);
  input.ingredients.forEach((row, index) => {
    if (
      row.rawName.length > limits.ingredientName ||
      (row.rawMeasure?.length ?? 0) > limits.measure
    )
      issues.push(
        `Ingredient ${index + 1}: names and measures support at most ${limits.ingredientName} characters each.`,
      );
  });
  input.instructions.forEach((row, index) => {
    if (row.rawText.length > limits.passage)
      issues.push(
        `Instruction ${index + 1}: publication supports at most ${limits.passage} characters.`,
      );
  });
  input.credits.forEach((row, index) => {
    if (row.label.length > limits.creditLabel)
      issues.push(
        `Source credit ${index + 1}: labels support at most ${limits.creditLabel} characters.`,
      );
  });
  if (!validateRecipeVideoUrl(input.videoUrl))
    issues.push(
      'Use one supported HTTPS YouTube video link without a fragment, custom port or duplicate video identity.',
    );
  return issues;
}
