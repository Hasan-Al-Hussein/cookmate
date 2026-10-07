import { isUtcInstant, validateRecipe, validateRecipeContentRef } from '@cookmate/contracts';
export { validateRecipeContentRef } from '@cookmate/contracts';
import { requireContent } from './canonical';
import { CONTENT_AUTHORING_LIMITS as AUTHORING, CONTENT_LIMITS } from './types';
import type { AuthoredRecipe, MediaReference, RecipeContentDocument, ReviewedMetadata } from './types';

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
export const text = (value: unknown, max: number, min = 1): value is string =>
  typeof value === 'string' && value.length >= min && value.length <= max;
export const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value);
export const recipeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
export const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const optionalText = (value: unknown, max: number) => value === null || text(value, max);
export function webUrl(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}
const optionalUrl = (value: unknown) => value === null || webUrl(value);
function photoKey(value: unknown): value is string {
  return text(value, 256) && !value.includes('..') && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/.test(value);
}
function review(value: unknown): boolean {
  return exact(value, ['reviewerId', 'reviewedAt', 'source']) && identity(value.reviewerId) &&
    typeof value.reviewedAt === 'string' && isUtcInstant(value.reviewedAt) && text(value.source, 2048);
}
function reviewed(value: unknown, validate: (item: unknown) => boolean): boolean {
  return exact(value, ['value', 'review']) && (value.value === null
    ? value.review === null
    : validate(value.value) && review(value.review));
}
const finite = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
export function validateReviewedMetadata(value: unknown): value is ReviewedMetadata {
  if (!exact(value, ['servings', 'prepMinutes', 'cookMinutes', 'dietaryTags', 'nutrition'])) return false;
  return reviewed(value.servings, (item) => typeof item === 'number' && item > 0 && finite(item, 1000)) &&
    reviewed(value.prepMinutes, (item) => finite(item, 43_200)) &&
    reviewed(value.cookMinutes, (item) => finite(item, 43_200)) &&
    reviewed(value.dietaryTags, (item) => Array.isArray(item) && item.length <= 30 && item.every((tag) => text(tag, 80)) && new Set(item).size === item.length) &&
    reviewed(value.nutrition, (item) => {
      if (!exact(item, ['basis', 'energyKcal', 'proteinGrams', 'carbohydrateGrams', 'fatGrams']) || !['per_serving', 'per_recipe'].includes(String(item.basis))) return false;
      const measures = [item.energyKcal, item.proteinGrams, item.carbohydrateGrams, item.fatGrams];
      return measures.some((measure) => measure !== null) && measures.every((measure) => measure === null || finite(measure, 1_000_000));
    });
}
export function unknownReviewedMetadata(): ReviewedMetadata {
  return { servings: { value: null, review: null }, prepMinutes: { value: null, review: null }, cookMinutes: { value: null, review: null }, dietaryTags: { value: null, review: null }, nutrition: { value: null, review: null } };
}
export function validateMediaReference(value: unknown): value is MediaReference {
  if (!exact(value, ['assetId', 'recipeId', 'photoKey', 'sha256', 'bytes', 'mimeType', 'dimensions', 'rights', 'attribution'])) return false;
  if (!fingerprint(value.sha256) || value.assetId !== `sha256:${value.sha256}` || !recipeId(value.recipeId) || !photoKey(value.photoKey) || !integer(value.bytes, 1, CONTENT_LIMITS.mediaBytes) || !['image/jpeg', 'image/png', 'image/webp'].includes(String(value.mimeType))) return false;
  const extension = value.photoKey.slice(value.photoKey.lastIndexOf('.') + 1);
  if (value.mimeType !== (extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg')) return false;
  if (value.dimensions !== null && !(exact(value.dimensions, ['width', 'height', 'review']) && integer(value.dimensions.width, 1, CONTENT_LIMITS.imageDimension) && integer(value.dimensions.height, 1, CONTENT_LIMITS.imageDimension) && review(value.dimensions.review))) return false;
  const rights = value.rights;
  if (!exact(rights, ['status', 'statement', 'review']) || !optionalText(rights.statement, 4000)) return false;
  if (rights.status === 'unreviewed' ? rights.review !== null : !['permitted', 'restricted'].includes(String(rights.status)) || !text(rights.statement, 4000) || !review(rights.review)) return false;
  return exact(value.attribution, ['text', 'url']) && optionalText(value.attribution.text, 2000) && optionalUrl(value.attribution.url);
}
/** Structural validity does not prove that an upload was inspected or its rights evidence is true. */
export function mediaPublicationBlockers(value: unknown): readonly string[] {
  if (!validateMediaReference(value)) return ['invalid_media'];
  const blockers: string[] = [];
  if (value.dimensions === null) blockers.push('dimensions_unverified');
  if (value.rights.status !== 'permitted') blockers.push('rights_not_permitted');
  return Object.freeze(blockers);
}
export function validateRecipeVideoUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (!webUrl(value)) return false;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.hash) return false;
  if (url.hostname === 'youtu.be') return /^\/[A-Za-z0-9_-]{11}$/.test(url.pathname);
  if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return false;
  return (url.pathname === '/watch' && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') ?? '') && url.searchParams.getAll('v').length === 1) || /^\/(?:shorts|embed)\/[A-Za-z0-9_-]{11}$/.test(url.pathname);
}
export function validateAuthoredRecipe(value: unknown): value is AuthoredRecipe {
  if (!exact(value, ['recipeId', 'title', 'description', 'category', 'cuisine', 'rawTags', 'photoKey', 'recipePage', 'originalSourceUrl', 'videoUrl', 'ingredients', 'instructions'])) return false;
  return recipeId(value.recipeId) && text(value.title, AUTHORING.title) && optionalText(value.description, AUTHORING.description) && text(value.category, AUTHORING.category) && text(value.cuisine, AUTHORING.cuisine) && (value.rawTags === null || text(value.rawTags, AUTHORING.rawTags, 0)) && photoKey(value.photoKey) && optionalUrl(value.recipePage) && optionalUrl(value.originalSourceUrl) && validateRecipeVideoUrl(value.videoUrl) &&
    Array.isArray(value.ingredients) && value.ingredients.length > 0 && value.ingredients.length <= AUTHORING.ingredients && value.ingredients.every((entry, index) => exact(entry, ['position', 'rawName', 'rawMeasure']) && entry.position === index + 1 && text(entry.rawName, AUTHORING.ingredientName) && (entry.rawMeasure === null || text(entry.rawMeasure, AUTHORING.measure, 0))) &&
    Array.isArray(value.instructions) && value.instructions.length > 0 && value.instructions.length <= AUTHORING.instructions && value.instructions.every((entry, index) => exact(entry, ['sequence', 'rawText', 'presentation']) && entry.sequence === index + 1 && text(entry.rawText, AUTHORING.passage) && ['heading', 'passage'].includes(String(entry.presentation)));
}
function imported(value: Record<string, unknown>): boolean {
  const recipe = value.recipe;
  const p = value.provenance;
  if (!validateRecipe(recipe) || !exact(p, ['kind', 'catalogue', 'preparationRuleVersion', 'sourceRecordsSha256', 'sourceHashes', 'recipeSource', 'photoTreatment', 'photoTreatmentRuleVersion']) || p.kind !== 'imported') return false;
  if (!exact(p.catalogue, ['version', 'fingerprint']) || !text(p.catalogue.version, 80) || !fingerprint(p.catalogue.fingerprint) || !fingerprint(p.sourceRecordsSha256) || !identity(p.preparationRuleVersion) || !identity(p.photoTreatmentRuleVersion)) return false;
  if (!Array.isArray(p.sourceHashes) || p.sourceHashes.length < 1 || p.sourceHashes.length > 20 || !p.sourceHashes.every((source) => exact(source, ['name', 'sha256']) && text(source.name, 256) && fingerprint(source.sha256)) || new Set(p.sourceHashes.map((source) => source.name)).size !== p.sourceHashes.length) return false;
  const source = p.recipeSource;
  if (!exact(source, ['recipeId', 'source', 'originalImageUrl', 'fetchedUtc', 'declaredIngredientEntries']) || source.recipeId !== recipe.recipeId || !exact(source.source, ['sheet', 'row']) || source.source.sheet !== 'Recipes' || !integer(source.source.row, 6, Number.MAX_SAFE_INTEGER) || !webUrl(source.originalImageUrl) || typeof source.fetchedUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(source.fetchedUtc) || !isUtcInstant(source.fetchedUtc.length === 20 ? source.fetchedUtc.replace('Z', '.000Z') : source.fetchedUtc) || source.declaredIngredientEntries !== recipe.ingredients.length) return false;
  const sourceRow = source.source.row;
  const treatment = p.photoTreatment;
  if (!exact(treatment, ['recipeId', 'preserveFullFrame', 'warningAnnotationId', 'creditAnnotationId']) || treatment.recipeId !== recipe.recipeId || typeof treatment.preserveFullFrame !== 'boolean' || ![treatment.warningAnnotationId, treatment.creditAnnotationId].every((id) => id === null || recipe.annotations.some((annotation) => annotation.annotationId === id))) return false;
  if (!recipe.ingredients.every((entry, index) => entry.recipeId === recipe.recipeId && entry.position === index + 1 && entry.source.sheet === 'Ingredients' && entry.source.row >= 6) || !recipe.instructions.every((entry, index) => entry.recipeId === recipe.recipeId && entry.sequence === index + 1 && entry.source.sheet === 'Instructions' && entry.source.row >= 6)) return false;
  return new Set(recipe.annotations.map((annotation) => annotation.annotationId)).size === recipe.annotations.length && recipe.annotations.every((annotation) => annotation.recipeId === recipe.recipeId && annotation.evidence.every((locator) => locator.sheet === 'Recipes' ? locator.row === sourceRow : locator.sheet === 'Ingredients' ? recipe.ingredients.some((entry) => entry.source.row === locator.row) : recipe.instructions.some((entry) => entry.source.row === locator.row)));
}
function authored(value: Record<string, unknown>): boolean {
  const p = value.provenance;
  return validateAuthoredRecipe(value.recipe) && exact(p, ['kind', 'authorId', 'createdAt', 'changeSummary', 'basedOn', 'credits']) && p.kind === 'authored' && identity(p.authorId) && typeof p.createdAt === 'string' && isUtcInstant(p.createdAt) && text(p.changeSummary, AUTHORING.changeSummary) && (p.basedOn === null || (validateRecipeContentRef(p.basedOn) && record(value.recipe) && p.basedOn.recipeId === value.recipe.recipeId)) && Array.isArray(p.credits) && p.credits.length <= AUTHORING.credits && p.credits.every((credit) => exact(credit, ['label', 'url']) && text(credit.label, AUTHORING.creditLabel) && optionalUrl(credit.url));
}
export function validateRecipeContentDocument(value: unknown): value is RecipeContentDocument {
  if (!exact(value, ['formatVersion', 'kind', 'recipe', 'provenance', 'metadata', 'media']) || value.formatVersion !== 1 || !validateReviewedMetadata(value.metadata)) return false;
  if (!(value.kind === 'imported' ? imported(value) : value.kind === 'authored' && authored(value))) return false;
  if (!record(value.recipe) || !Array.isArray(value.media) || value.media.length < 1 || value.media.length > CONTENT_LIMITS.mediaPerRecipe || !value.media.every(validateMediaReference)) return false;
  return value.media.every((media) => media.recipeId === (value.recipe as Record<string, unknown>).recipeId) && value.media.some((media) => media.photoKey === (value.recipe as Record<string, unknown>).photoKey) && new Set(value.media.map((media) => media.photoKey)).size === value.media.length && new Set(value.media.map((media) => media.assetId)).size === value.media.length;
}
export function assertRecipeContentDocument(value: unknown): asserts value is RecipeContentDocument {
  requireContent(validateRecipeContentDocument(value), 'recipe_document');
}
