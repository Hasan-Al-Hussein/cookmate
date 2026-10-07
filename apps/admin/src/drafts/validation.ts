import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { AdminDraftInput, AdminRightsInput, AdminRightsRecord } from '../contracts';
import { requireAdmin } from '../auth/errors';
import { publicationInputIssues } from '../publishing/readiness';

export function object(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  requireAdmin(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      keys.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => keys.includes(key) || optional.includes(key)),
    400,
    'invalid_input',
    'Request fields are invalid.',
  );
}
export function text(
  value: unknown,
  maximum: number,
  nullable = false,
): asserts value is string | null {
  requireAdmin(
    (nullable && value === null) ||
      (typeof value === 'string' && value.length <= maximum && !value.includes('\0')),
    400,
    'invalid_input',
    'A text field exceeds its supported bounds.',
  );
}
export function identifier(value: unknown): asserts value is string {
  requireAdmin(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value),
    400,
    'invalid_id',
    'The operation or record identifier is invalid.',
  );
}
export function revision(value: unknown): asserts value is number {
  requireAdmin(
    Number.isSafeInteger(value) && (value as number) > 0,
    400,
    'invalid_revision',
    'The revision is invalid.',
  );
}
/** Server-derived preparation IDs are reserved from externally selected mutation IDs. */
export function publicOperationIdentifier(value: unknown): asserts value is string {
  identifier(value);
  requireAdmin(
    !value.startsWith('prepare-'),
    400,
    'reserved_operation_id',
    'This operation identifier is reserved for publication preparation.',
  );
}
function url(value: unknown) {
  text(value, 2048, true);
  if (value === null || value === '') return;
  let valid = false;
  try {
    const parsed = new URL(value);
    valid = ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    /* Validated below. */
  }
  requireAdmin(
    valid,
    400,
    'invalid_url',
    'Links must be absolute HTTP or HTTPS addresses without credentials.',
  );
}
export function draftInput(value: unknown): AdminDraftInput {
  object(value, [
    'title',
    'description',
    'category',
    'cuisine',
    'rawTags',
    'recipePage',
    'originalSourceUrl',
    'videoUrl',
    'photoAssetId',
    'ingredients',
    'instructions',
    'credits',
    'changeSummary',
  ]);
  text(value.title, 500);
  text(value.description, 10_000, true);
  text(value.category, 200);
  text(value.cuisine, 200);
  text(value.rawTags, 2000, true);
  text(value.changeSummary, 2000);
  url(value.recipePage);
  url(value.originalSourceUrl);
  url(value.videoUrl);
  requireAdmin(
    value.photoAssetId === null ||
      (typeof value.photoAssetId === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.photoAssetId)),
    400,
    'invalid_photo',
    'The photo reference is invalid.',
  );
  requireAdmin(
    Array.isArray(value.ingredients) && value.ingredients.length <= 200,
    400,
    'invalid_ingredients',
    'Use at most 200 ingredient rows.',
  );
  for (const ingredient of value.ingredients) {
    object(ingredient, ['rawName', 'rawMeasure']);
    text(ingredient.rawName, 1000);
    text(ingredient.rawMeasure, 1000, true);
  }
  requireAdmin(
    Array.isArray(value.instructions) && value.instructions.length <= 500,
    400,
    'invalid_instructions',
    'Use at most 500 instruction rows.',
  );
  for (const instruction of value.instructions) {
    object(instruction, ['rawText', 'presentation']);
    text(instruction.rawText, 20_000);
    requireAdmin(
      ['heading', 'passage'].includes(instruction.presentation as string),
      400,
      'invalid_instructions',
      'Instruction presentation is invalid.',
    );
  }
  requireAdmin(
    Array.isArray(value.credits) && value.credits.length <= 30,
    400,
    'invalid_credits',
    'Use at most 30 credit rows.',
  );
  for (const credit of value.credits) {
    object(credit, ['label', 'url']);
    text(credit.label, 500);
    url(credit.url);
  }
  try {
    canonicalContentJson(value, 1024 * 1024);
  } catch {
    requireAdmin(false, 413, 'draft_too_large', 'The draft exceeds the supported size.');
  }
  return value as unknown as AdminDraftInput;
}
export function rightsInput(value: unknown): AdminRightsInput {
  object(value, ['scope', 'status', 'statement', 'sourceUrl']);
  requireAdmin(
    ['recipe_text', 'photo', 'video_embed'].includes(value.scope as string) &&
      ['permitted', 'restricted', 'unreviewed'].includes(value.status as string),
    400,
    'invalid_rights',
    'Choose a supported permission scope and decision.',
  );
  text(value.statement, 2000);
  requireAdmin(
    typeof value.statement === 'string' && value.statement.trim().length > 0,
    400,
    'invalid_rights',
    'Describe the permission evidence or why it remains restricted or unreviewed.',
  );
  url(value.sourceUrl);
  requireAdmin(value.sourceUrl !== '', 400, 'invalid_url', 'Use an evidence URL or no URL.');
  return value as unknown as AdminRightsInput;
}
export function readiness(
  input: AdminDraftInput,
  hasPhoto: boolean,
  rights: readonly AdminRightsRecord[],
): string[] {
  const issues = publicationInputIssues(input);
  if (!input.title.trim()) issues.push('Add a recipe title.');
  if (!input.category.trim()) issues.push('Add a category.');
  if (!input.cuisine.trim()) issues.push('Add a cuisine.');
  if (!input.ingredients.length || input.ingredients.some((row) => !row.rawName.trim()))
    issues.push('Add named ingredients; preserve unknown quantities rather than inventing them.');
  if (
    !input.instructions.some((row) => row.presentation === 'passage' && row.rawText.trim()) ||
    input.instructions.some((row) => !row.rawText.trim())
  )
    issues.push('Add the original cooking instructions.');
  if (!input.changeSummary.trim()) issues.push('Describe this change before review.');
  if (!hasPhoto) issues.push('Attach a recipe photo.');
  for (const [scope, label, applicable] of [
    ['recipe_text', 'Recipe text', true],
    ['photo', 'Photo', hasPhoto],
    ['video_embed', 'Video embedding', !!input.videoUrl],
  ] as const) {
    if (!applicable) continue;
    const status = rights.find((record) => record.scope === scope)?.status ?? 'unreviewed';
    if (status !== 'permitted')
      issues.push(`${label} permission is ${status}. Record permission evidence before approval.`);
  }
  if (!input.credits.length || input.credits.some((row) => !row.label.trim()))
    issues.push('Add clear source or author credits.');
  return issues;
}
