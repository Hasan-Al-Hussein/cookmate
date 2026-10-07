import type { AdminDraftInput, AdminUser } from '../contracts';

/** A translation never replaces the original or changes its quantities/media/source locators. */
export interface AdminTranslationInput {
  title: string;
  description: string | null;
  category: string;
  cuisine: string;
  rawTags: string | null;
  ingredients: { rawName: string }[];
  instructions: { rawText: string }[];
  changeSummary: string;
  attribution: 'human' | 'machine' | 'mixed';
}
export interface AdminTranslationSource {
  draftId: string;
  revision: number;
  recipeId: string;
  inputFingerprint: string;
}
export interface AdminTranslationReview {
  decision: 'approved' | 'changes_requested';
  note: string;
  reviewerId: string;
  reviewedAt: string;
  inputRevision: number;
  binding: string;
  /** Records the authenticated operator's acknowledgement, not independent language certification. */
  evidence: 'operator_acknowledgement';
}
export interface AdminTranslationRecord {
  translationId: string;
  revision: number;
  source: AdminTranslationSource;
  originalLanguage: string;
  targetLanguage: string;
  input: AdminTranslationInput;
  translatedFingerprint: string;
  /** Once machine input has been declared, later edits/rebases cannot erase that history. */
  machineAssisted: boolean;
  status: 'draft' | 'reviewed' | 'changes_requested';
  review: AdminTranslationReview | null;
  updatedAt: string;
  updatedBy: AdminUser;
}
export interface AdminTranslation extends AdminTranslationRecord {
  sourceStatus: { kind: 'current' } | { kind: 'stale'; currentRevision: number };
  effectiveStatus: AdminTranslationRecord['status'] | 'stale';
}
export interface AdminTranslationOriginal {
  source: AdminTranslationSource;
  originalLanguage: string;
  input: AdminDraftInput;
}
export type AdminTranslationSummary = Omit<AdminTranslation, 'input'>;
export interface AdminTranslationMutation {
  operationId: string;
  requestFingerprint: string;
  translation: AdminTranslation;
}
export type AdminTranslationResolution =
  | { status: 'committed'; mutation: AdminTranslationMutation }
  | { status: 'cancelled'; operationId: string; requestFingerprint: string };
