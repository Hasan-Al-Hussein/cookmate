import { catalogue } from '../index';
import { catalogueProvenance } from '../provenance';
import type { Immutable } from '../catalogue';
import { canonicalContentJson, freezeContent, requireContent } from './canonical';
import { createRecipeContentRevision } from './revision';
import type { ContentHash, ImportedSourceVerifier, MediaReference, RecipeContentRevision } from './types';
import { unknownReviewedMetadata, validateRecipeContentDocument } from './validation';

/** Original packaged evidence, not a published/signed release or a retrospective rights approval. */
function bundledDocument(recipeId: string) {
  const recipe = catalogue.getRecipe(recipeId);
  const source = catalogueProvenance.recipeSources.find((item) => item.recipeId === recipeId);
  const asset = catalogueProvenance.assets.find((item) => item.recipeId === recipeId);
  const treatment = catalogueProvenance.photoTreatments.find((item) => item.recipeId === recipeId);
  requireContent(recipe && source && asset && treatment && recipe.photoKey === asset.photoKey, 'bundled_recipe');
  return {
    formatVersion: 1,
    kind: 'imported',
    recipe,
    provenance: {
      kind: 'imported',
      catalogue: catalogue.identity,
      preparationRuleVersion: catalogueProvenance.ruleVersion,
      sourceRecordsSha256: catalogueProvenance.sourceRecordsSha256,
      sourceHashes: Object.entries(catalogueProvenance.sourceHashes).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, sha256]) => ({ name, sha256 })),
      recipeSource: source,
      photoTreatment: treatment,
      photoTreatmentRuleVersion: catalogueProvenance.photoTreatmentRuleVersion,
    },
    metadata: unknownReviewedMetadata(),
    media: [{
      assetId: `sha256:${asset.sha256}`,
      recipeId,
      photoKey: asset.photoKey,
      sha256: asset.sha256,
      bytes: asset.bytes,
      mimeType: 'image/jpeg',
      dimensions: null,
      rights: { status: 'unreviewed', statement: null, review: null },
      attribution: { text: null, url: source.originalImageUrl },
    }],
  };
}
export async function createBundledRecipeRevision(
  recipeId: string,
  sha256: ContentHash,
): Promise<Immutable<RecipeContentRevision>> {
  return createRecipeContentRevision(bundledDocument(recipeId), `bundled:${catalogue.identity.fingerprint}`, sha256);
}
function retainedMedia(media: readonly Immutable<MediaReference>[]) {
  return media.map(({ recipeId, assetId, photoKey, sha256, bytes, mimeType, attribution }) => ({
    recipeId, assetId, photoKey, sha256, bytes, mimeType, originalImageUrl: attribution.url,
  }));
}
/** Independently configured comparison against the packaged baseline, not caller-nominated hashes. */
export const bundledImportedSourceVerifier: ImportedSourceVerifier = Object.freeze({
  async verify(document: Parameters<ImportedSourceVerifier['verify']>[0]) {
    if (!validateRecipeContentDocument(document) || document.kind !== 'imported') return false;
    if (!catalogue.getRecipe(document.recipe.recipeId)) return false;
    const retained = bundledDocument(document.recipe.recipeId);
    requireContent(validateRecipeContentDocument(retained) && retained.kind === 'imported', 'bundled_source');
    // New reviewed metadata/rights/dimension evidence may be added, but original source/photo facts cannot change.
    return canonicalContentJson(document.recipe) === canonicalContentJson(retained.recipe) &&
      canonicalContentJson(document.provenance) === canonicalContentJson(retained.provenance) &&
      canonicalContentJson(retainedMedia(document.media)) === canonicalContentJson(retainedMedia(retained.media));
  },
});
export async function createBundledContentSnapshot(sha256: ContentHash) {
  const revisions: Immutable<RecipeContentRevision>[] = [];
  for (const recipe of catalogue.recipes) revisions.push(await createBundledRecipeRevision(recipe.recipeId, sha256));
  return freezeContent({ trust: 'packaged_baseline' as const, catalogue: { ...catalogue.identity }, revisions });
}
