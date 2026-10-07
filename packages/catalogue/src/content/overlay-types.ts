import type { CatalogueIdentity } from '@cookmate/contracts';
import type { Immutable } from '../catalogue';
import type {
  ContentHash,
  MediaReference,
  RecipeContentDocument,
  RecipeContentRef,
  RecipeContentRevision,
  ReviewEvidence,
  ReleaseTrustVerifier,
} from './types';

export type PermissionSubject =
  | { scope: 'recipe_text' }
  | {
      scope: 'translated_recipe_text';
      translationId: string;
      translationRevision: number;
      language: string;
    }
  | { scope: 'photo'; assetId: string; photoKey: string }
  | { scope: 'video_embed'; url: string };
/** Signed operator evidence is a recorded assertion, not independent proof of a licence. */
export interface PublicationPermission {
  subject: PermissionSubject;
  status: 'unreviewed' | 'permitted' | 'restricted';
  statement: string;
  sourceUrl: string | null;
  review: ReviewEvidence;
  /** Domain-separated hash of the exact immutable reference and scoped subject. */
  contentBinding: string;
}
export interface PublishedRecipeRevisionV2 {
  formatVersion: 2;
  revision: RecipeContentRevision;
  permissions: PublicationPermission[];
  /** Binds revision and all evidence; signed indirectly by overlay membership. */
  publicationFingerprint: string;
}
/** Separate reviewed text; source quantities, media, row roles and warnings stay original. */
export interface PublishedRecipeTranslation {
  translationId: string;
  translationRevision: number;
  sourceRef: RecipeContentRef;
  originalLanguage: string;
  targetLanguage: string;
  content: {
    title: string;
    description: string | null;
    category: string;
    cuisine: string;
    rawTags: string | null;
    ingredients: { position: number; rawName: string }[];
    instructions: { sequence: number; rawText: string }[];
  };
  attribution: 'human' | 'machine' | 'mixed';
  machineAssisted: boolean;
  review: ReviewEvidence & { evidence: 'operator_acknowledgement' };
  permission: PublicationPermission;
}
export interface PublishedRecipeRevisionV3 extends Omit<
  PublishedRecipeRevisionV2,
  'formatVersion'
> {
  formatVersion: 3;
  translations: PublishedRecipeTranslation[];
}
export type PublishedRecipeRevision = PublishedRecipeRevisionV2 | PublishedRecipeRevisionV3;
export const TRANSLATED_PUBLICATION_READER_VERSION = 2;
export const MAX_PUBLICATION_TRANSLATIONS = 8;
export interface OverlayHead {
  releaseId: string;
  sequence: number;
  fingerprint: string;
}
export type OverlayEntry =
  | { state: 'current'; ref: RecipeContentRef; publicationFingerprint: string | null }
  | {
      state: 'archived';
      ref: RecipeContentRef;
      publicationFingerprint: string | null;
      reason: string;
    }
  | { state: 'withdrawn'; recipeId: string; reason: string };
export interface ContentOverlayManifest {
  formatVersion: 2;
  releaseId: string;
  sequence: number;
  previous: OverlayHead | null;
  createdAt: string;
  minimumReaderVersion: number;
  baseline: CatalogueIdentity;
  /** Cumulative overrides. Omission inherits only the packaged baseline, never the previous overlay. */
  entries: OverlayEntry[];
}
export interface SignedContentOverlay {
  manifest: ContentOverlayManifest;
  fingerprint: string;
  signature: { keyId: string; scheme: string; value: string };
}
export interface PackagedContentBaseline {
  identity: CatalogueIdentity;
  revisions: readonly Immutable<RecipeContentRevision>[];
}
/** Host-owned durable trust archive. Downloaded manifests cannot nominate these ports or their keys. */
export interface OverlayTrustArchive {
  readRelease(
    releaseId: string,
  ): Promise<{ manifest: ContentOverlayManifest; fingerprint: string } | null>;
  /** Lookup by identity, not caller fingerprint, so existing immutable IDs cannot be rebound. */
  readPublication(recipeId: string, revisionId: string): Promise<PublishedRecipeRevision | null>;
}
export interface ContentMediaVerifier {
  /** Validate actual retained bytes/hash/type/dimensions for this exact association; never fetch arbitrary attribution URLs. */
  verify(media: Immutable<MediaReference>): Promise<boolean>;
}
export interface VerifyOverlayOptions {
  sha256: ContentHash;
  trustVerifier: ReleaseTrustVerifier;
  mediaVerifier: ContentMediaVerifier;
  archive: OverlayTrustArchive;
  /** Independently configured packaged snapshot, never taken from the downloaded payload. */
  baseline: PackagedContentBaseline;
  /** Exact current head plus durable high-water prevents replay/branch rollback. null is first activation only. */
  expectedCurrent: OverlayHead | null;
  minimumSequence: number;
  readerVersion: number;
  publications: readonly unknown[];
  /** Host-selected existing plan/history pins to materialize, not additional discovery membership. */
  retainedRefs?: readonly RecipeContentRef[];
}
export interface RetainedSourceNotice {
  ref: RecipeContentRef;
  document: Extract<RecipeContentDocument, { kind: 'imported' }>;
  /** Authored descendants never implicitly resolve the original annotations/photo-treatment warnings. */
  disposition: 'original' | 'inherited_unresolved';
}
export type ReadableRecipeView = (
  | { origin: 'packaged_baseline'; revision: Immutable<RecipeContentRevision>; publication: null }
  | {
      origin: 'published';
      revision: Immutable<RecipeContentRevision>;
      publication: Immutable<PublishedRecipeRevision>;
    }
) & { retainedSources: readonly Immutable<RetainedSourceNotice>[] };
export type ContentLookup =
  | {
      kind: 'readable';
      value: Immutable<ReadableRecipeView>;
      state: 'current' | 'archived' | 'historical';
    }
  | { kind: 'withdrawn'; recipeId: string; reason: string }
  | { kind: 'missing' };
export interface EffectiveContentSnapshot {
  readonly envelope: Immutable<SignedContentOverlay>;
  readonly identity: Readonly<CatalogueIdentity>;
  readonly trust: 'signature_verified';
  readonly mediaBytes: 'verified_by_host';
  readonly ancestry: 'resolved_by_host';
  readonly entries: readonly Immutable<OverlayEntry>[];
  readonly discoverable: readonly Immutable<ReadableRecipeView>[];
  lookupExact(ref: RecipeContentRef): ContentLookup;
  lookupCurrent(recipeId: string): ContentLookup;
  lookupDiscoverable(recipeId: string): ContentLookup;
}
export const OVERLAY_LIMITS = Object.freeze({
  publications: 1000,
  overrides: 10_000,
  permissionsPerRevision: 10,
  ancestryDepth: 32,
  resolvedPublications: 2000,
  retainedRefs: 1000,
  reasonCharacters: 2000,
  aggregateContentBytes: 8 * 1024 * 1024,
});
