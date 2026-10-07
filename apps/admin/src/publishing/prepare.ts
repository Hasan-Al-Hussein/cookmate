import sharp from 'sharp';
import type { Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  ContentValidationError,
  createBundledRecipeRevision,
  createPublishedRecipeRevision,
  createTranslatedPublishedRecipeRevision,
  createRecipeContentRevision,
  publicationPermissionBinding,
  validateRecipeContentDocument,
} from '@cookmate/catalogue/content';
import type {
  MediaReference,
  PermissionSubject,
  PublicationPermission,
  RecipeContentDocument,
  RecipeContentRevision,
  ReviewEvidence,
  PublishedRecipeRevision,
} from '@cookmate/catalogue/content';
import type {
  AdminAsset,
  AdminDraft,
  AdminRightsRecord,
  AdminPublicationTranslationSelection,
} from '../contracts';
import { requireAdmin } from '../auth/errors';
import { DraftRepository, sha256 } from '../drafts/repository';
import { requireRecentReviewIdentity } from '../drafts/rights';
import type { AdminMedia } from '../media/service';
import type { Actor, AdminDatabase } from '../storage/database';
import { publicationInputIssues } from './readiness';
import {
  assertTranslationAuthority,
  createPublicationTranslations,
  ownTranslationSelections,
  readTranslationSelections,
  translationEvidence,
} from './translationSelection';

const hash = async (value: string) => sha256(value);
const evidence = (draft: AdminDraft, record: AdminRightsRecord): ReviewEvidence => ({
  reviewerId: record.reviewerId,
  reviewedAt: record.reviewedAt,
  source: `cookmate-admin:draft:${draft.draftId}:revision:${record.inputRevision + 1}`,
});

/** Build immutable content from a server-owned, exactly approved draft. No publication or client write. */
export async function prepareReviewedPublication(options: {
  db: AdminDatabase;
  media: Pick<AdminMedia, 'asset' | 'baseline'>;
  actor: Actor;
  draftId: string;
  expectedRevision: number;
  /** Allocate once for a future durable publication operation; never rebind an existing ID. */
  revisionId: string;
  translations?: readonly AdminPublicationTranslationSelection[];
  now(): Date;
}) {
  const { db, actor, now } = options;
  const selections =
    options.translations === undefined ? undefined : ownTranslationSelections(options.translations);
  const drafts = new DraftRepository(db, now);
  const assertReady = () => {
    db.assertActor(actor, now().getTime(), ['reviewer', 'administrator']);
    requireRecentReviewIdentity(db, actor, now().getTime());
    const draft = drafts.read(options.draftId);
    requireAdmin(
      draft.revision === options.expectedRevision,
      409,
      'revision_conflict',
      'This draft changed before publication preparation.',
    );
    requireAdmin(
      draft.status === 'reviewed' &&
        draft.approval?.revision === draft.revision &&
        draft.review?.decision === 'approved',
      409,
      'approval_required',
      'Approve this exact draft before preparing content.',
    );
    requireAdmin(
      draft.validationIssues.length === 0 && publicationInputIssues(draft.input).length === 0,
      409,
      'publication_blocked',
      'Resolve this draft’s readiness issues before preparing content.',
    );
    return draft;
  };
  const snapshot = db.transaction(() => {
    const draft = assertReady();
    const original = db.get<{ original_evidence: string | null }>(
      'SELECT original_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=1',
      draft.draftId,
    )?.original_evidence;
    const edited = db.get<{ result: string }>(
      "SELECT result FROM admin_operation WHERE kind IN ('create','save','restore') AND json_extract(result,'$.draft.draftId')=? AND json_extract(result,'$.draft.revision')<=? ORDER BY CAST(json_extract(result,'$.draft.revision') AS INTEGER) DESC LIMIT 1",
      draft.draftId,
      draft.revision,
    );
    requireAdmin(
      edited,
      409,
      'author_evidence_missing',
      'The saved editorial revision is unavailable.',
    );
    const editorial = (JSON.parse(edited.result) as { draft: AdminDraft }).draft;
    requireAdmin(
      canonicalContentJson(editorial.input) === canonicalContentJson(draft.input),
      409,
      'author_evidence_mismatch',
      'The saved editorial revision does not match this approved content.',
    );
    const assetRow = draft.input.photoAssetId
      ? db.get<{ document: string }>(
          'SELECT document FROM admin_asset WHERE hash=?',
          draft.input.photoAssetId.slice(7),
        )
      : null;
    return {
      draft,
      original: original ? (JSON.parse(original) as RecipeContentRevision) : null,
      editorial,
      asset: assetRow ? (JSON.parse(assetRow.document) as AdminAsset) : null,
      translations: selections ? readTranslationSelections(db, now, draft, selections) : undefined,
      rightsReviewedAt: now().toISOString(),
    };
  });
  const { draft, editorial, asset } = snapshot;
  let original = null;
  if (draft.basedOn) {
    original = await createBundledRecipeRevision(draft.recipeId, hash);
    requireAdmin(
      snapshot.original &&
        canonicalContentJson(original) === canonicalContentJson(snapshot.original) &&
        canonicalContentJson(original.ref) === canonicalContentJson(draft.basedOn),
      409,
      'source_evidence_mismatch',
      'The original source evidence is not the independently trusted bundled revision.',
    );
  } else {
    requireAdmin(
      snapshot.original === null,
      409,
      'source_evidence_mismatch',
      'A new recipe cannot claim unrelated imported evidence.',
    );
  }
  const photoRecord = draft.rights!.find((record) => record.scope === 'photo')!;
  const rightsReview = evidence(draft, photoRecord);
  const retained = original?.document.media.find(
    (item) => item.photoKey === original.document.recipe.photoKey,
  );
  requireAdmin(asset || retained, 409, 'photo_required', 'A reviewed photo is required.');
  const photo = asset
    ? await options.media.asset(asset.assetId.slice(7))
    : await options.media.baseline(draft.recipeId);
  const expectedHash = asset?.assetId.slice(7) ?? retained!.sha256;
  requireAdmin(
    photo.bytes.length === (asset?.bytes ?? retained!.bytes) &&
      sha256(photo.bytes) === expectedHash &&
      photo.mimeType === (asset?.mimeType ?? retained!.mimeType),
    409,
    'photo_integrity',
    'The selected photo failed its immutable content check.',
  );
  const decoder = sharp(photo.bytes, { limitInputPixels: 20_000_000, failOn: 'warning' }).timeout({
    seconds: 15,
  });
  let dimensions;
  try {
    dimensions = await decoder.metadata();
  } finally {
    decoder.destroy();
  }
  requireAdmin(
    dimensions.width &&
      dimensions.height &&
      (dimensions.pages ?? 1) === 1 &&
      (!asset || (dimensions.width === asset.width && dimensions.height === asset.height)),
    409,
    'photo_dimensions',
    'The selected photo does not match its inspected dimensions.',
  );
  const measuredAt = now().toISOString();
  const media: MediaReference = {
    assetId: `sha256:${expectedHash}`,
    recipeId: draft.recipeId,
    photoKey: asset ? `photos/${expectedHash}.webp` : retained!.photoKey,
    sha256: expectedHash,
    bytes: photo.bytes.length,
    mimeType: asset?.mimeType ?? retained!.mimeType,
    dimensions: {
      width: dimensions.width,
      height: dimensions.height,
      review: {
        reviewerId: 'cookmate-media-inspector',
        reviewedAt: measuredAt,
        source: `cookmate-admin:asset:sha256:${expectedHash}`,
      },
    },
    rights: { status: 'permitted', statement: photoRecord.statement, review: rightsReview },
    attribution: retained && !asset ? { ...retained.attribution } : { text: null, url: null },
  };
  const input = draft.input;
  const document: RecipeContentDocument = {
    formatVersion: 1,
    kind: 'authored',
    recipe: {
      recipeId: draft.recipeId,
      title: input.title,
      description: input.description,
      category: input.category,
      cuisine: input.cuisine,
      rawTags: input.rawTags,
      photoKey: media.photoKey,
      recipePage: input.recipePage,
      originalSourceUrl: input.originalSourceUrl,
      videoUrl: input.videoUrl,
      ingredients: input.ingredients.map((row, index) => ({ position: index + 1, ...row })),
      instructions: input.instructions.map((row, index) => ({ sequence: index + 1, ...row })),
    },
    provenance: {
      kind: 'authored',
      authorId: editorial.updatedBy.userId,
      createdAt: editorial.updatedAt,
      changeSummary: input.changeSummary,
      basedOn: draft.basedOn,
      credits: input.credits,
    },
    metadata: draft.metadata,
    media: [media],
  };
  requireAdmin(
    validateRecipeContentDocument(document),
    409,
    'publication_document',
    'This draft cannot be represented by the supported client format. No text or quantities were changed.',
  );
  const revision = await createRecipeContentRevision(document, options.revisionId, hash);
  const permissions: PublicationPermission[] = [];
  for (const record of draft.rights!) {
    const subject: PermissionSubject =
      record.scope === 'photo'
        ? { scope: 'photo', assetId: media.assetId, photoKey: media.photoKey }
        : record.scope === 'video_embed'
          ? { scope: 'video_embed', url: input.videoUrl! }
          : { scope: 'recipe_text' };
    permissions.push({
      subject,
      status: record.status,
      statement: record.statement,
      sourceUrl: record.sourceUrl,
      review: evidence(draft, record),
      contentBinding: await publicationPermissionBinding(revision.ref, subject, hash),
    });
  }
  const selectedEvidence = snapshot.translations
    ? translationEvidence(snapshot.translations)
    : undefined;
  let publication: Immutable<PublishedRecipeRevision>;
  try {
    publication =
      snapshot.translations && selections
        ? await createTranslatedPublishedRecipeRevision(
            revision,
            permissions,
            await createPublicationTranslations(snapshot.translations, selections, revision.ref, {
              reviewerId: actor.user.userId,
              reviewedAt: snapshot.rightsReviewedAt,
            }),
            hash,
          )
        : await createPublishedRecipeRevision(revision, permissions, hash);
  } catch (error) {
    if (selections && error instanceof ContentValidationError)
      requireAdmin(
        false,
        409,
        'translation_publication_blocked',
        'The selected translations exceed the supported publication format or size. Review them explicitly; no text or quantities were truncated.',
      );
    throw error;
  }
  // File inspection/hashing are asynchronous. Recheck authority and exact approval before returning.
  db.transaction(() => {
    const latest = assertReady();
    requireAdmin(
      canonicalContentJson(latest) === canonicalContentJson(draft),
      409,
      'revision_conflict',
      'The approved draft changed during content preparation.',
    );
    assertTranslationAuthority(db, now, latest, selections, selectedEvidence);
  });
  return Object.freeze({
    publication,
    draftId: draft.draftId,
    draftRevision: draft.revision,
    approval: Object.freeze({ ...draft.approval! }),
    /** Preserve original warnings/evidence for the later reader; edits do not resolve them implicitly. */
    originalEvidence: original,
    status: 'prepared_not_published' as const,
    ...(selectedEvidence ? { translationEvidence: selectedEvidence } : {}),
  });
}
