import { createHash } from 'node:crypto';
import { catalogue, catalogueProvenance } from '@cookmate/catalogue';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { RecipeContentRevision } from '@cookmate/catalogue/content';
import type { AdminAsset, AdminDraft, AdminRightsRecord, AdminRightsScope } from '../contracts';
import type { Actor, AdminDatabase } from '../storage/database';
import { requireAdmin } from '../auth/errors';

export const RIGHTS_RECENT_AUTH_MS = 15 * 60 * 1000;
const scopes: readonly AdminRightsScope[] = ['recipe_text', 'photo', 'video_embed'];

/** Called only inside the mutation transaction, after actor validation and committed-receipt lookup. */
export function requireRecentReviewIdentity(db: AdminDatabase, actor: Actor, now: number): void {
  const row = db.get<{ data: string }>(
    'SELECT data FROM admin_session WHERE session_id=?',
    actor.sessionId,
  );
  const recent: unknown = row
    ? (JSON.parse(row.data) as { recentAuthAt?: unknown }).recentAuthAt
    : null;
  requireAdmin(
    typeof recent === 'number' &&
      Number.isFinite(recent) &&
      recent <= now &&
      now - recent <= RIGHTS_RECENT_AUTH_MS,
    403,
    'reauth_required',
    'Confirm your identity again before recording permissions or approving this draft.',
  );
}

export function scopedRightsContent(
  db: AdminDatabase,
  draft: AdminDraft,
  originalEvidence?: string | null,
) {
  let photoUrl: string | null = null;
  let photo: unknown = null;
  if (draft.input.photoAssetId) {
    const row = db.get<{ document: string }>(
      'SELECT document FROM admin_asset WHERE hash=?',
      draft.input.photoAssetId.slice(7),
    );
    requireAdmin(row, 400, 'photo_not_found', 'The uploaded photo is not available.');
    const asset = JSON.parse(row.document) as AdminAsset;
    requireAdmin(
      asset.assetId === draft.input.photoAssetId,
      409,
      'photo_identity',
      'The photo reference does not match its retained asset.',
    );
    photo = {
      assetId: asset.assetId,
      bytes: asset.bytes,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
    };
    photoUrl = asset.photoUrl;
  } else if (draft.basedOn) {
    const retained =
      originalEvidence === undefined
        ? db.get<{ original_evidence: string | null }>(
            'SELECT original_evidence FROM admin_draft_revision WHERE draft_id=? AND revision=1',
            draft.draftId,
          )?.original_evidence
        : originalEvidence;
    requireAdmin(
      retained,
      409,
      'source_evidence_missing',
      'The original recipe photo evidence is unavailable.',
    );
    const baseline = JSON.parse(retained) as RecipeContentRevision;
    requireAdmin(
      canonicalContentJson(baseline.ref) === canonicalContentJson(draft.basedOn) &&
        baseline.document.recipe.recipeId === draft.recipeId,
      409,
      'source_identity',
      'The original recipe evidence does not match this draft.',
    );
    const media = baseline.document.media.find((item) => item.recipeId === draft.recipeId);
    requireAdmin(
      media,
      409,
      'photo_not_found',
      'The original recipe photo evidence is unavailable.',
    );
    const packaged = catalogueProvenance.assets.find((item) => item.recipeId === draft.recipeId);
    const recipe = catalogue.getRecipe(draft.recipeId);
    requireAdmin(
      packaged &&
        recipe &&
        recipe.photoKey === packaged.photoKey &&
        media.photoKey === packaged.photoKey &&
        media.sha256 === packaged.sha256 &&
        media.assetId === `sha256:${packaged.sha256}` &&
        media.bytes === packaged.bytes,
      409,
      'baseline_photo_unavailable',
      'The retained recipe photo is unavailable in this package. Its original permission evidence is unchanged.',
    );
    // Retain the real packaged hash/dimensions/attribution; unknown rights never become permission here.
    photo = media;
    photoUrl = `/admin/api/baseline/${draft.recipeId}/photo`;
  }
  const { input } = draft;
  const common = {
    bindingVersion: 1,
    draftId: draft.draftId,
    recipeId: draft.recipeId,
    basedOn: draft.basedOn,
    recipePage: input.recipePage,
    originalSourceUrl: input.originalSourceUrl,
    credits: input.credits,
  };
  const bind = (scope: AdminRightsScope, content: unknown) =>
    createHash('sha256')
      .update(canonicalContentJson({ ...common, scope, content }, 1024 * 1024 + 16_384))
      .digest('hex');
  const bindings: Record<AdminRightsScope, string | null> = {
    recipe_text: bind('recipe_text', {
      title: input.title,
      description: input.description,
      category: input.category,
      cuisine: input.cuisine,
      rawTags: input.rawTags,
      ingredients: input.ingredients,
      instructions: input.instructions,
    }),
    photo: photo === null ? null : bind('photo', photo),
    video_embed: input.videoUrl ? bind('video_embed', { videoUrl: input.videoUrl }) : null,
  };
  return { bindings, photoUrl };
}

/** Only server-retained records with an exact current binding remain effective. Historical revisions are untouched. */
export function effectiveRights(
  records: readonly AdminRightsRecord[] | undefined,
  bindings: Record<AdminRightsScope, string | null>,
): AdminRightsRecord[] {
  return scopes.flatMap((scope) => {
    const record = records?.filter((item) => item.scope === scope).at(-1);
    return record && bindings[scope] !== null && record.contentBinding === bindings[scope]
      ? [record]
      : [];
  });
}
