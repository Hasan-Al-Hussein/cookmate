import { isUtcInstant } from '@cookmate/contracts';
import type { Immutable } from '../catalogue';
import { canonicalContentJson, copyContent, freezeContent, jsonUtf8Bytes, requireContent } from './canonical';
import { hashContent, readRecipeContentRevision } from './revision';
import { CONTENT_LIMITS } from './types';
import type { ContentHash, ContentReleaseManifest, ImportedSourceVerifier, RecipeContentRevision, ReleaseTrustVerifier, SignedReleaseEnvelope } from './types';
import { exact, fingerprint, identity, integer, mediaPublicationBlockers, text, validateMediaReference, validateRecipeContentRef } from './validation';

export function validateContentReleaseManifest(value: unknown): value is ContentReleaseManifest {
  if (!exact(value, ['formatVersion', 'releaseId', 'sequence', 'previousReleaseId', 'createdAt', 'minimumReaderVersion', 'recipes', 'media']) || value.formatVersion !== 1 || !identity(value.releaseId) || !integer(value.sequence, 1, Number.MAX_SAFE_INTEGER) || !(value.previousReleaseId === null || (identity(value.previousReleaseId) && value.previousReleaseId !== value.releaseId)) || typeof value.createdAt !== 'string' || !isUtcInstant(value.createdAt) || !integer(value.minimumReaderVersion, 1, Number.MAX_SAFE_INTEGER)) return false;
  if (!Array.isArray(value.recipes) || value.recipes.length < 1 || value.recipes.length > CONTENT_LIMITS.recipesPerRelease || !value.recipes.every(validateRecipeContentRef) || new Set(value.recipes.map((ref) => ref.recipeId)).size !== value.recipes.length) return false;
  if (!Array.isArray(value.media) || value.media.length > CONTENT_LIMITS.recipesPerRelease * CONTENT_LIMITS.mediaPerRecipe || !value.media.every(validateMediaReference)) return false;
  const owners = new Set(value.recipes.map((ref) => ref.recipeId));
  const represented = new Set<string>();
  const associationCounts = new Map<string, number>();
  const assetFacts = new Map<string, string>();
  for (const media of value.media) {
    if (!owners.has(media.recipeId)) return false;
    const count = (associationCounts.get(media.recipeId) ?? 0) + 1;
    if (count > CONTENT_LIMITS.mediaPerRecipe) return false;
    associationCounts.set(media.recipeId, count);
    represented.add(media.recipeId);
    const facts = canonicalContentJson([media.bytes, media.mimeType, media.dimensions && [media.dimensions.width, media.dimensions.height]]);
    if (assetFacts.has(media.assetId) && assetFacts.get(media.assetId) !== facts) return false;
    assetFacts.set(media.assetId, facts);
  }
  return new Set(value.media.map((media) => `${media.recipeId}:${media.photoKey}`)).size === value.media.length && value.recipes.every((ref) => represented.has(ref.recipeId));
}
/** Manifest metadata only; complete eligibility also requires trusted recipe/source verification. */
export function releasePublicationBlockers(input: unknown): readonly string[] {
  if (!validateContentReleaseManifest(input)) return ['invalid_release_manifest'];
  return Object.freeze([...new Set(input.media.flatMap(mediaPublicationBlockers))]);
}
export async function fingerprintReleaseManifest(input: unknown, sha256: ContentHash): Promise<string> {
  const manifest = copyContent(input, CONTENT_LIMITS.releaseBytes);
  requireContent(validateContentReleaseManifest(manifest), 'release_manifest');
  return hashContent('cookmate-content-release-v1', manifest, sha256);
}
/** Signature covers the canonical manifest plus its integrity digest, with a protocol domain tag. */
export function releaseSignaturePayload(manifest: ContentReleaseManifest | Immutable<ContentReleaseManifest>, digest: string): string {
  requireContent(validateContentReleaseManifest(manifest) && fingerprint(digest), 'signature_payload');
  return canonicalContentJson(['cookmate-signed-release-v1', { manifest, fingerprint: digest }]);
}
export interface TrustedContentManifest {
  envelope: Immutable<SignedReleaseEnvelope>;
  revisions: readonly Immutable<RecipeContentRevision>[];
  trust: 'signature_verified';
  /** Metadata checks do not authenticate media bytes, download completeness or upload inspection. */
  mediaBytes: 'not_verified';
  /** basedOn references still require an independently trusted historical content archive. */
  historicalDependencies: 'not_verified';
  importedSourceEvidence: 'verified' | 'not_applicable';
}
export async function verifySignedContentRelease(
  input: unknown,
  options: {
    sha256: ContentHash;
    trustVerifier: ReleaseTrustVerifier;
    importedSourceVerifier?: ImportedSourceVerifier;
    readerVersion: number;
    revisions: readonly unknown[];
  },
): Promise<TrustedContentManifest> {
  const envelope = copyContent(input, CONTENT_LIMITS.releaseBytes);
  requireContent(exact(envelope, ['manifest', 'fingerprint', 'signature']) && validateContentReleaseManifest(envelope.manifest) && fingerprint(envelope.fingerprint), 'release_envelope');
  const signature = envelope.signature;
  requireContent(exact(signature, ['keyId', 'scheme', 'value']) && identity(signature.keyId) && identity(signature.scheme) && text(signature.value, 4096, 16) && /^[A-Za-z0-9_-]+$/.test(signature.value), 'release_signature');
  requireContent(integer(options.readerVersion, 1, Number.MAX_SAFE_INTEGER) && envelope.manifest.minimumReaderVersion <= options.readerVersion, 'reader_incompatible');
  requireContent(releasePublicationBlockers(envelope.manifest).length === 0, 'release_not_eligible');
  requireContent(Array.isArray(options.revisions) && options.revisions.length === envelope.manifest.recipes.length, 'release_revision_count');
  // Copy all dependencies before the first await; a provider cannot swap later recipe inputs.
  let bytes = 0;
  const candidates = options.revisions.map((input) => {
    const value = copyContent(input, CONTENT_LIMITS.documentBytes + 1024);
    bytes += jsonUtf8Bytes(canonicalContentJson(value));
    requireContent(bytes <= CONTENT_LIMITS.releaseBytes, 'release_content_size');
    return value;
  });
  const digest = await fingerprintReleaseManifest(envelope.manifest, options.sha256);
  requireContent(digest === envelope.fingerprint, 'release_integrity');
  const trusted = await options.trustVerifier.verify({ keyId: signature.keyId, scheme: signature.scheme, canonicalPayload: releaseSignaturePayload(envelope.manifest, digest), signature: signature.value });
  requireContent(trusted === true, 'release_untrusted');
  const revisions: Immutable<RecipeContentRevision>[] = [];
  const manifestRefs = new Map(envelope.manifest.recipes.map((ref) => [ref.recipeId, ref]));
  const manifestMedia = new Map<string, ContentReleaseManifest['media']>();
  for (const media of envelope.manifest.media) {
    const group = manifestMedia.get(media.recipeId) ?? [];
    group.push(media);
    manifestMedia.set(media.recipeId, group);
  }
  const seen = new Set<string>();
  let hasImported = false;
  for (const candidate of candidates) {
    const revision = await readRecipeContentRevision(candidate, options.sha256);
    const ref = manifestRefs.get(revision.ref.recipeId);
    requireContent(ref && !seen.has(ref.recipeId) && canonicalContentJson(ref) === canonicalContentJson(revision.ref), 'release_recipe_reference');
    seen.add(ref.recipeId);
    const media = manifestMedia.get(ref.recipeId);
    requireContent(canonicalContentJson(media) === canonicalContentJson(revision.document.media), 'release_media_reference');
    if (revision.document.kind === 'imported') {
      hasImported = true;
      requireContent(options.importedSourceVerifier, 'imported_source_unverified');
      const sourceMatches = await options.importedSourceVerifier.verify(revision.document);
      requireContent(sourceMatches === true, 'imported_source_mismatch');
    }
    revisions.push(revision);
  }
  // Publication must additionally resolve basedOn against an independently trusted dependency archive.
  // Return dependencies in the manifest's editorial order, not caller input order.
  const byId = new Map(revisions.map((revision) => [revision.ref.recipeId, revision]));
  const ordered = envelope.manifest.recipes.map((ref) => byId.get(ref.recipeId)!);
  return freezeContent({ envelope: envelope as unknown as SignedReleaseEnvelope, revisions: ordered, trust: 'signature_verified' as const, mediaBytes: 'not_verified' as const, historicalDependencies: 'not_verified' as const, importedSourceEvidence: hasImported ? 'verified' as const : 'not_applicable' as const });
}
