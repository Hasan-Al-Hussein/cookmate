import {
  canonicalContentJson,
  unknownReviewedMetadata,
  validateReviewedMetadata,
  type ReviewedMetadata,
} from '@cookmate/catalogue/content';
import type { AdminMetadataInput } from '../contracts';
import { requireAdmin } from '../auth/errors';
import { object } from './validation';

export function applyMetadataReview(
  current: ReviewedMetadata,
  raw: unknown,
  reviewerId: string,
  reviewedAt: string,
): ReviewedMetadata {
  let input: unknown;
  try {
    input = JSON.parse(canonicalContentJson(raw, 16 * 1024));
  } catch {
    requireAdmin(
      false,
      400,
      'invalid_metadata',
      'Optional metadata exceeds its supported format or size.',
    );
  }
  object(input, ['field', 'value', 'source']);
  requireAdmin(
    typeof input.field === 'string' && Object.hasOwn(unknownReviewedMetadata(), input.field),
    400,
    'invalid_metadata',
    'Choose a supported optional metadata field.',
  );
  requireAdmin(
    input.value === null
      ? input.source === null
      : typeof input.source === 'string' &&
          input.source.trim().length > 0 &&
          input.source.length <= 2048 &&
          !input.source.includes('\0'),
    400,
    'metadata_evidence_required',
    'Supply bounded source evidence for a value, or leave both value and evidence unknown.',
  );
  const reviewed = {
    value: input.value,
    review: input.value === null ? null : { reviewerId, reviewedAt, source: input.source },
  };
  const candidate = { ...current, [input.field]: reviewed };
  requireAdmin(
    validateReviewedMetadata(candidate),
    400,
    'invalid_metadata',
    'This optional value is outside the supported metadata format. Unknown values must remain blank.',
  );
  const change = input as unknown as AdminMetadataInput;
  if (
    change.field === 'servings' &&
    change.value !== current.servings.value &&
    current.nutrition.value?.basis === 'per_serving'
  )
    candidate.nutrition = { value: null, review: null };
  return candidate;
}
