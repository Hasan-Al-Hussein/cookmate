import type { CatalogueIdentity, Recipe } from '@cookmate/contracts';
import type { RecipePhotoTreatment, RecipeProvenance } from '../provenance';
import type { Immutable } from '../catalogue';
import type { RecipeContentRef } from '@cookmate/contracts';
export type { RecipeContentRef } from '@cookmate/contracts';

/** These are content data contracts, not the existing assistant wire contracts. */
export interface ReviewEvidence {
  reviewerId: string;
  reviewedAt: string;
  source: string;
}
export interface ReviewedValue<Value> {
  value: Value | null;
  review: ReviewEvidence | null;
}
export interface ReviewedMetadata {
  servings: ReviewedValue<number>;
  prepMinutes: ReviewedValue<number>;
  cookMinutes: ReviewedValue<number>;
  dietaryTags: ReviewedValue<string[]>;
  nutrition: ReviewedValue<{
    basis: 'per_serving' | 'per_recipe';
    energyKcal: number | null;
    proteinGrams: number | null;
    carbohydrateGrams: number | null;
    fatGrams: number | null;
  }>;
}
export interface MediaReference {
  /** Exactly sha256:<sha256>; identity never contains a mutable URL or filesystem path. */
  assetId: string;
  recipeId: string;
  photoKey: string;
  sha256: string;
  bytes: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** null means no measured dimensions are recorded; it does not mean zero. */
  dimensions: { width: number; height: number; review: ReviewEvidence } | null;
  rights: {
    status: 'unreviewed' | 'permitted' | 'restricted';
    statement: string | null;
    review: ReviewEvidence | null;
  };
  attribution: { text: string | null; url: string | null };
}
export interface ImportedContentProvenance {
  kind: 'imported';
  catalogue: CatalogueIdentity;
  preparationRuleVersion: string;
  sourceRecordsSha256: string;
  sourceHashes: { name: string; sha256: string }[];
  recipeSource: RecipeProvenance;
  photoTreatment: RecipePhotoTreatment;
  photoTreatmentRuleVersion: string;
}
export interface AuthoredContentProvenance {
  kind: 'authored';
  authorId: string;
  createdAt: string;
  changeSummary: string;
  /** A structural reference only. Publication must resolve it against trusted content. */
  basedOn: RecipeContentRef | null;
  credits: { label: string; url: string | null }[];
}
export interface AuthoredRecipe {
  recipeId: string;
  title: string;
  description: string | null;
  category: string;
  cuisine: string;
  rawTags: string | null;
  photoKey: string;
  recipePage: string | null;
  originalSourceUrl: string | null;
  videoUrl: string | null;
  ingredients: { position: number; rawName: string; rawMeasure: string | null }[];
  instructions: {
    sequence: number;
    rawText: string;
    presentation: 'heading' | 'passage';
  }[];
}
export type RecipeContentDocument = {
  formatVersion: 1;
  metadata: ReviewedMetadata;
  media: MediaReference[];
} & (
  | { kind: 'imported'; recipe: Recipe; provenance: ImportedContentProvenance }
  | { kind: 'authored'; recipe: AuthoredRecipe; provenance: AuthoredContentProvenance }
);
export interface RecipeContentRevision {
  ref: RecipeContentRef;
  document: RecipeContentDocument;
  /** Binds the revision identity as well as the immutable content. Not a signature. */
  revisionFingerprint: string;
}
export interface ContentReleaseManifest {
  formatVersion: 1;
  releaseId: string;
  sequence: number;
  previousReleaseId: string | null;
  createdAt: string;
  minimumReaderVersion: number;
  /** Ordered catalogue membership. Ordering is meaningful and is included in the signature. */
  recipes: RecipeContentRef[];
  media: MediaReference[];
}
export interface SignedReleaseEnvelope {
  manifest: ContentReleaseManifest;
  fingerprint: string;
  signature: { keyId: string; scheme: string; value: string };
}
/** The host must configure trusted keys/schemes independently of the supplied envelope. */
export interface ReleaseTrustVerifier {
  verify(input: {
    keyId: string;
    scheme: string;
    canonicalPayload: string;
    signature: string;
  }): Promise<boolean>;
}
/** Configured by the host, never supplied by an imported document or its release manifest. */
export interface ImportedSourceVerifier {
  verify(document: Immutable<Extract<RecipeContentDocument, { kind: 'imported' }>>): Promise<boolean>;
}
export type ContentHash = (canonicalText: string) => Promise<string>;

/** Existing authored format-1 bounds; editing drafts may use broader limits before publication. */
export const CONTENT_AUTHORING_LIMITS = Object.freeze({
  title: 512, description: 4000, category: 128, cuisine: 128, rawTags: 2048,
  ingredients: 100, instructions: 200, ingredientName: 512, measure: 512,
  passage: 12000, credits: 20, creditLabel: 256, changeSummary: 2000, url: 2048,
});

export const CONTENT_LIMITS = Object.freeze({
  documentBytes: 1024 * 1024,
  releaseBytes: 8 * 1024 * 1024,
  recipesPerRelease: 10_000,
  mediaPerRecipe: 8,
  mediaBytes: 20 * 1024 * 1024,
  imageDimension: 16_384,
});
