import { catalogue } from '../src/index';
import { createBundledRecipeRevision, createPublishedRecipeRevision, createRecipeContentRevision, fingerprintContentOverlay, publicationPermissionBinding } from '../src/content/index';
import type { ContentOverlayManifest, OverlayEntry, PublishedRecipeRevision, PublicationPermission, SignedContentOverlay, VerifyOverlayOptions } from '../src/content/overlay-types';
import type { RecipeContentDocument } from '../src/content/types';
import { authoredFixture, clone, evidence, sha256 } from './content-fixtures';

export async function published(document = authoredFixture(), revisionId = 'revision-1'): Promise<PublishedRecipeRevision> {
  const revision = await createRecipeContentRevision(document, revisionId, sha256);
  const records: PublicationPermission[] = [{ subject: { scope: 'recipe_text' }, status: 'permitted', statement: 'Fixture text permission.', sourceUrl: null, review: clone(evidence), contentBinding: '' }];
  for (const media of document.media) records.push({ subject: { scope: 'photo', assetId: media.assetId, photoKey: media.photoKey }, status: 'permitted', statement: media.rights.statement!, sourceUrl: null, review: clone(media.rights.review!), contentBinding: '' });
  if (document.recipe.videoUrl) records.push({ subject: { scope: 'video_embed', url: document.recipe.videoUrl }, status: 'permitted', statement: 'Fixture embed permission.', sourceUrl: null, review: clone(evidence), contentBinding: '' });
  for (const record of records) record.contentBinding = await publicationPermissionBinding(revision.ref, record.subject, sha256);
  return JSON.parse(JSON.stringify(await createPublishedRecipeRevision(revision, records, sha256))) as PublishedRecipeRevision;
}
export function member(publication: PublishedRecipeRevision): Extract<OverlayEntry, { state: 'current' }> {
  return { state: 'current', ref: clone(publication.revision.ref), publicationFingerprint: publication.publicationFingerprint };
}
export async function signed(manifest: ContentOverlayManifest): Promise<SignedContentOverlay> {
  return { manifest: clone(manifest), fingerprint: await fingerprintContentOverlay(manifest, sha256), signature: { keyId: 'fixture-key', scheme: 'fixture-only', value: 'synthetic_signature_no_crypto' } };
}
export async function overlayFixture(document?: RecipeContentDocument) {
  const base = await createBundledRecipeRevision('53262', sha256);
  const publication = await published(document);
  const manifest: ContentOverlayManifest = { formatVersion: 2, releaseId: 'overlay-1', sequence: 1, previous: null, createdAt: '2026-09-30T12:00:00.000Z', minimumReaderVersion: 1, baseline: { ...catalogue.identity }, entries: [member(publication)] };
  const envelope = await signed(manifest);
  const releases = new Map<string, { manifest: ContentOverlayManifest; fingerprint: string }>();
  const publications = new Map<string, PublishedRecipeRevision>();
  const options: VerifyOverlayOptions = {
    sha256, baseline: { identity: { ...catalogue.identity }, revisions: [base] },
    expectedCurrent: null, minimumSequence: 0, readerVersion: 1, publications: [publication],
    // Explicit fixture ports: these tests do not demonstrate actual cryptographic or native verification.
    trustVerifier: { async verify(input) { return input.keyId === 'fixture-key' && input.scheme === 'fixture-only' && input.signature === 'synthetic_signature_no_crypto'; } },
    mediaVerifier: { async verify() { return true; } },
    archive: {
      async readRelease(id) { return clone(releases.get(id) ?? null); },
      async readPublication(id, revisionId) { return clone(publications.get(`${id}|${revisionId}`) ?? null); },
    },
  };
  return { base, publication, manifest, envelope, options, releases, publications };
}
