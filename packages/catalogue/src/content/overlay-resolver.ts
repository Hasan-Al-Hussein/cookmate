import type { Immutable } from '../catalogue';
import { canonicalContentJson, copyContent, freezeContent, jsonUtf8Bytes, requireContent } from './canonical';
import { OVERLAY_LIMITS } from './overlay-types';
import type { ContentMediaVerifier, OverlayTrustArchive, PublishedRecipeRevision, ReadableRecipeView, RetainedSourceNotice } from './overlay-types';
import { PUBLICATION_MAX_BYTES, readPublishedRecipeRevision } from './publication';
import type { ContentHash, MediaReference, RecipeContentRef, RecipeContentRevision } from './types';

export const referenceKey = (ref: Immutable<RecipeContentRef>) => canonicalContentJson(ref);
export const revisionIdentity = (ref: Immutable<RecipeContentRef>) => `${ref.recipeId}|${ref.revisionId}`;
const same = (left: unknown, right: unknown) => canonicalContentJson(left) === canonicalContentJson(right);
function retainedMedia(media: readonly Immutable<MediaReference>[]) {
  return media.map(({ recipeId, assetId, photoKey, sha256, bytes, mimeType, attribution }) => ({ recipeId, assetId, photoKey, sha256, bytes, mimeType, originalImageUrl: attribution.url }));
}

/** One verification's bounded resolver. Neither downloaded keys nor candidate documents establish ancestry trust. */
export function createOverlayResolver(options: {
  sha256: ContentHash;
  archive: OverlayTrustArchive;
  mediaVerifier: ContentMediaVerifier;
  baseline: readonly Immutable<RecipeContentRevision>[];
  candidates: readonly unknown[];
  previousRecipeIds: ReadonlySet<string>;
}) {
  const baselineById = new Map(options.baseline.map((item) => [item.ref.recipeId, item]));
  const baselineByIdentity = new Map(options.baseline.map((item) => [revisionIdentity(item.ref), item]));
  const resolved = new Map<string, Immutable<ReadableRecipeView>>();
  const archived = new Map<string, Immutable<PublishedRecipeRevision> | null>();
  const candidates = new Map<string, Immutable<PublishedRecipeRevision>>();
  const candidateUse = new Set<string>();
  const assetFacts = new Map<string, { bytes: number; mimeType: string; dimensions: string | null }>();
  const checkedMedia = new Set<string>();
  let totalBytes = 0;
  let archiveReads = 0;
  function checkAsset(media: Immutable<MediaReference>): void {
    const dimensions = media.dimensions ? canonicalContentJson([media.dimensions.width, media.dimensions.height]) : null;
    const known = assetFacts.get(media.assetId);
    requireContent(!known || (known.bytes === media.bytes && known.mimeType === media.mimeType && (!known.dimensions || !dimensions || known.dimensions === dimensions)), 'overlay_media_contradiction');
    assetFacts.set(media.assetId, { bytes: media.bytes, mimeType: media.mimeType, dimensions: dimensions ?? known?.dimensions ?? null });
  }
  function account(value: unknown): void {
    totalBytes += jsonUtf8Bytes(canonicalContentJson(value));
    requireContent(totalBytes <= OVERLAY_LIMITS.aggregateContentBytes, 'overlay_content_size');
  }
  for (const revision of options.baseline) {
    const document = revision.document;
    requireContent(document.kind === 'imported', 'baseline_origin');
    resolved.set(referenceKey(revision.ref), freezeContent({ origin: 'packaged_baseline', revision, publication: null, retainedSources: [{ ref: revision.ref, document, disposition: 'original' }] }) as Immutable<ReadableRecipeView>);
  }
  async function initialize(): Promise<void> {
    // Packaged rights remain unknown, but the host must still attest the packaged bytes.
    for (const revision of options.baseline) {
      for (const media of revision.document.media) {
        checkAsset(media);
        requireContent(await options.mediaVerifier.verify(media) === true, 'overlay_media_unverified');
        checkedMedia.add(canonicalContentJson(media));
      }
    }
    for (const raw of options.candidates) {
      account(raw);
      const publication = await readPublishedRecipeRevision(raw, options.sha256);
      const key = revisionIdentity(publication.revision.ref);
      requireContent(!candidates.has(key) && !baselineByIdentity.has(key), 'overlay_duplicate_revision');
      candidates.set(key, publication);
    }
  }
  async function readArchive(ref: Immutable<RecipeContentRef>): Promise<Immutable<PublishedRecipeRevision> | null> {
    const key = revisionIdentity(ref);
    if (archived.has(key)) return archived.get(key)!;
    requireContent(++archiveReads <= OVERLAY_LIMITS.resolvedPublications, 'overlay_archive_bound');
    const incoming = await options.archive.readPublication(ref.recipeId, ref.revisionId);
    // Copy the port's returned record immediately, before any hashing/other await.
    const raw = incoming === null ? null : copyContent(incoming, PUBLICATION_MAX_BYTES);
    if (raw === null) { archived.set(key, null); return null; }
    account(raw);
    const publication = await readPublishedRecipeRevision(raw, options.sha256);
    requireContent(revisionIdentity(publication.revision.ref) === key, 'archive_identity');
    archived.set(key, publication);
    return publication;
  }
  async function verifyMedia(media: Immutable<MediaReference>): Promise<void> {
    checkAsset(media);
    const key = canonicalContentJson(media);
    if (checkedMedia.has(key)) return;
    requireContent(await options.mediaVerifier.verify(media) === true, 'overlay_media_unverified');
    checkedMedia.add(key);
  }
  async function resolve(ref: Immutable<RecipeContentRef>, expectedPublication: string | null | undefined, archiveOnly = false, stack = new Set<string>()): Promise<Immutable<ReadableRecipeView>> {
    const key = referenceKey(ref);
    const identityKey = revisionIdentity(ref);
    requireContent(stack.size < OVERLAY_LIMITS.ancestryDepth && !stack.has(identityKey), 'overlay_ancestry_bound');
    const baseline = baselineByIdentity.get(identityKey);
    if (baseline) {
      requireContent(same(baseline.ref, ref) && (expectedPublication === null || expectedPublication === undefined), 'overlay_baseline_reference');
      return resolved.get(key)!;
    }
    requireContent(expectedPublication !== null, 'overlay_packaged_exception');
    const trusted = await readArchive(ref);
    const candidate = candidates.get(identityKey);
    if (candidate && trusted) requireContent(same(candidate, trusted), 'overlay_revision_rebound');
    const publication = archiveOnly ? trusted : candidate ?? trusted;
    requireContent(publication && same(publication.revision.ref, ref), 'overlay_dependency_missing');
    requireContent(expectedPublication === undefined || expectedPublication === publication.publicationFingerprint, 'overlay_publication_reference');
    if (!archiveOnly && candidate) candidateUse.add(identityKey);
    const cached = resolved.get(key);
    if (cached) return cached;
    const revision = publication.revision;
    const document = revision.document;
    const notices: Immutable<RetainedSourceNotice>[] = [];
    const original = baselineById.get(ref.recipeId);
    if (document.kind === 'imported') {
      requireContent(original?.document.kind === 'imported' && same(original.document.recipe, document.recipe) && same(original.document.provenance, document.provenance) && same(retainedMedia(original.document.media), retainedMedia(document.media)), 'overlay_imported_source_mismatch');
      notices.push(freezeContent({ ref: original.ref, document: original.document, disposition: 'original' }));
    } else {
      const parent = document.provenance.basedOn;
      requireContent(parent !== null || (!original && (trusted !== null || !options.previousRecipeIds.has(ref.recipeId))), 'overlay_lineage_required');
      if (parent) {
        const ancestry = await resolve(parent, undefined, true, new Set([...stack, identityKey]));
        notices.push(...ancestry.retainedSources.map((notice) => freezeContent({ ...notice, disposition: 'inherited_unresolved' as const })));
      }
      // A known imported identity cannot be laundered through an unrelated authored root.
      requireContent(!original || notices.some((notice) => same(notice.ref, original.ref)), 'overlay_source_lineage');
    }
    for (const media of document.media) await verifyMedia(media);
    const view = freezeContent({ origin: 'published', revision, publication, retainedSources: notices }) as Immutable<ReadableRecipeView>;
    resolved.set(key, view);
    return view;
  }
  return {
    initialize,
    resolve,
    resolved,
    assertAllCandidatesUsed() { requireContent(candidateUse.size === candidates.size, 'overlay_unused_publication'); },
  };
}
