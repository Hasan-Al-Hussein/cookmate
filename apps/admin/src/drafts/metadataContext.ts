import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { AdminDraftInput } from '../contracts';

/** Metadata evidence describes the saved recipe; a changed recipe requires fresh review. */
export function recipeMetadataContextChanged(before: AdminDraftInput, after: AdminDraftInput) {
  const { changeSummary: beforeSummary, ...previous } = before;
  const { changeSummary: afterSummary, ...next } = after;
  return canonicalContentJson(previous) !== canonicalContentJson(next);
}
