import type {
  ContentOverlayManifest,
  OverlayEntry,
  OverlayHead,
  RecipeContentRef,
  ReviewedMetadata,
  SignedContentOverlay,
} from '@cookmate/catalogue/content';

export type AdminRole = 'editor' | 'reviewer' | 'administrator';
export interface AdminUser {
  userId: string;
  username: string;
  role: AdminRole;
}
export interface AdminSession {
  configured: boolean;
  user: AdminUser | null;
  csrfToken: string | null;
  expiresAt: string | null;
}
/** Editable draft values are not published/approved recipe facts. */
export interface AdminDraftInput {
  title: string;
  description: string | null;
  category: string;
  cuisine: string;
  rawTags: string | null;
  recipePage: string | null;
  originalSourceUrl: string | null;
  videoUrl: string | null;
  photoAssetId: string | null;
  ingredients: { rawName: string; rawMeasure: string | null }[];
  instructions: { rawText: string; presentation: 'heading' | 'passage' }[];
  credits: { label: string; url: string | null }[];
  changeSummary: string;
}
export interface AdminReviewRecord {
  decision: 'approved' | 'changes_requested';
  note: string;
  reviewerId: string;
  reviewedAt: string;
  inputRevision: number;
}
export type AdminRightsScope = 'recipe_text' | 'photo' | 'video_embed';
export type AdminRightsStatus = 'permitted' | 'restricted' | 'unreviewed';
export interface AdminRightsInput {
  scope: AdminRightsScope;
  status: AdminRightsStatus;
  statement: string;
  sourceUrl: string | null;
}
/** Operator-recorded evidence, bound by the server to this draft's exact scoped content. */
export interface AdminRightsRecord extends AdminRightsInput {
  reviewerId: string;
  reviewedAt: string;
  inputRevision: number;
  contentBinding: string;
}
export type AdminMetadataField = keyof ReviewedMetadata;
/** Operator evidence only; reviewer identity and time are always supplied by the server. */
export type AdminMetadataInput = {
  [Field in AdminMetadataField]: {
    field: Field;
    value: ReviewedMetadata[Field]['value'];
    source: string | null;
  };
}[AdminMetadataField];
export interface AdminDraft {
  draftId: string;
  recipeId: string;
  revision: number;
  status: 'draft' | 'reviewed';
  input: AdminDraftInput;
  basedOn: RecipeContentRef | null;
  updatedAt: string;
  updatedBy: AdminUser;
  metadata: ReviewedMetadata;
  approval: { reviewerId: string; reviewedAt: string; revision: number; note: string } | null;
  /** Historical draft documents may predate this response projection. */
  review?: AdminReviewRecord | null;
  /** Absent in older revisions means no permission has been recorded. */
  rights?: AdminRightsRecord[];
  validationIssues: string[];
  photoUrl: string | null;
}
export interface AdminLibraryItem {
  recipeId: string;
  draftId: string | null;
  title: string;
  category: string;
  cuisine: string;
  status: 'bundled' | 'draft' | 'reviewed';
  revision: number | null;
  photoUrl: string | null;
  updatedAt: string | null;
  /** Packages for this exact latest saved draft revision, not an earlier revision. */
  preparation: { draftRevision: number; packageCount: number } | null;
  /** Signed-head membership is separate from saved draft state and client adoption. */
  publication: {
    state: 'current' | 'archived' | 'withdrawn';
    releaseId: string;
    ref: RecipeContentRef | null;
    matchingDraftRevision: number | null;
  } | null;
}
export type AdminLibraryStatus =
  | 'all'
  | 'bundled'
  | 'draft'
  | 'reviewed'
  | 'prepared'
  | 'published'
  | 'archived';
export type AdminLibraryPublicationStatus =
  | { status: 'not_configured' }
  | { status: 'ready'; head: OverlayHead | null };
export interface AdminLibrary {
  items: AdminLibraryItem[];
  nextCursor: string | null;
  publicationStatus: AdminLibraryPublicationStatus;
}
export interface AdminMutation {
  operationId: string;
  draft: AdminDraft;
}
/** A durable cancellation wins against late requests, or returns an already committed receipt. */
export type AdminOperationResolution =
  | { operationId: string; status: 'committed'; mutation: AdminMutation }
  | { operationId: string; status: 'cancelled' };
export interface AdminHistoryEntry {
  revision: number;
  createdAt: string;
  author: AdminUser;
  changeSummary: string;
  status: 'draft' | 'reviewed';
  review?: AdminReviewRecord | null;
  rights?: AdminRightsRecord[];
}
export interface AdminAsset {
  assetId: string;
  photoUrl: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: number;
  width: number;
  height: number;
  rightsStatus: 'unreviewed' | 'permitted' | 'restricted';
}
export interface AdminError {
  error: { code: string; message: string };
}
/** Read-only preflight result. This is not a durable release or a publish receipt. */
export interface AdminPublicationPreview {
  status: 'prepared_not_published';
  draftId: string;
  draftRevision: number;
  recipeId: string;
  contentFingerprint: string;
  publicationFingerprint: string;
  documentBytes: number;
  permissionScopes: (AdminRightsScope | 'translated_recipe_text')[];
  originalEvidenceRetained: boolean;
}

/** An immutable private package receipt; still no signed release or client activation. */
export interface AdminPublicationPreparation extends AdminPublicationPreview {
  operationId: string;
  revisionId: string;
  retainedAt: string;
  translations?: {
    translationId: string;
    translationRevision: number;
    targetLanguage: string;
  }[];
}

/** Exact reviewed selection; permission is a separate, explicit operator assertion. */
export interface AdminPublicationTranslationSelection {
  translationId: string;
  translationRevision: number;
  rights: { statement: string; sourceUrl: string | null; acknowledge: true };
}

export interface AdminRetainedPublicationSummary {
  operationId: string;
  draftRevision: number;
  revisionId: string;
  translations: { translationId: string; translationRevision: number; targetLanguage: string }[];
}

/** Private issuance availability is separate from delivery and client adoption. */
export type AdminPublicationReleaseState =
  | { status: 'not_configured' }
  | { status: 'ready'; head: OverlayHead | null; manifest: ContentOverlayManifest | null };

export interface AdminPublicationIssueRequest {
  operationId: string;
  expectedHead: OverlayHead | null;
  /** Full cumulative membership, preserving prior archives and withdrawals. */
  entries: OverlayEntry[];
}

export interface AdminPublicationIssueReceipt {
  status: 'issued_not_activated';
  operationId: string;
  actorId: string;
  requestFingerprint: string;
  envelope: SignedContentOverlay;
}

/** Cancellation is a durable server decision; an absent receipt is not cancellation. */
export type AdminPublicationIssueResolution =
  | { status: 'committed'; receipt: AdminPublicationIssueReceipt }
  | {
      status: 'cancelled';
      operationId: string;
      actorId: string;
      requestFingerprint: string;
    };
