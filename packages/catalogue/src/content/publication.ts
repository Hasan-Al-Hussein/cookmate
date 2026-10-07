import { isUtcInstant } from '@cookmate/contracts';
import type { Immutable } from '../catalogue';
import { canonicalContentJson, copyContent, freezeContent, requireContent } from './canonical';
import { hashContent, readRecipeContentRevision } from './revision';
import { CONTENT_LIMITS } from './types';
import type { ContentHash, RecipeContentRef } from './types';
import { MAX_PUBLICATION_TRANSLATIONS, OVERLAY_LIMITS } from './overlay-types';
import type {
  PermissionSubject,
  PublicationPermission,
  PublishedRecipeRevision,
  PublishedRecipeRevisionV2,
  PublishedRecipeRevisionV3,
  PublishedRecipeTranslation,
} from './overlay-types';
import { validateTranslationContent, validateTranslationLanguage } from './translation';
import {
  exact,
  fingerprint,
  identity,
  integer,
  mediaPublicationBlockers,
  text,
  validateRecipeContentRef,
  validateRecipeVideoUrl,
  webUrl,
} from './validation';

export const PUBLICATION_MAX_BYTES = CONTENT_LIMITS.documentBytes + 64 * 1024;
export function validatePermissionSubject(value: unknown): value is PermissionSubject {
  if (exact(value, ['scope']) && value.scope === 'recipe_text') return true;
  if (
    exact(value, ['scope', 'translationId', 'translationRevision', 'language']) &&
    value.scope === 'translated_recipe_text'
  )
    return (
      identity(value.translationId) &&
      integer(value.translationRevision, 1, Number.MAX_SAFE_INTEGER) &&
      validateTranslationLanguage(value.language)
    );
  if (exact(value, ['scope', 'url']) && value.scope === 'video_embed')
    return typeof value.url === 'string' && validateRecipeVideoUrl(value.url);
  return (
    exact(value, ['scope', 'assetId', 'photoKey']) &&
    value.scope === 'photo' &&
    typeof value.assetId === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(value.assetId) &&
    text(value.photoKey, 256) &&
    !value.photoKey.includes('..') &&
    /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:jpg|jpeg|png|webp)$/.test(value.photoKey)
  );
}
function permission(value: unknown): value is PublicationPermission {
  return (
    exact(value, ['subject', 'status', 'statement', 'sourceUrl', 'review', 'contentBinding']) &&
    validatePermissionSubject(value.subject) &&
    ['permitted', 'restricted', 'unreviewed'].includes(String(value.status)) &&
    text(value.statement, 4000) &&
    value.statement.trim().length > 0 &&
    (value.sourceUrl === null || webUrl(value.sourceUrl)) &&
    exact(value.review, ['reviewerId', 'reviewedAt', 'source']) &&
    identity(value.review.reviewerId) &&
    typeof value.review.reviewedAt === 'string' &&
    isUtcInstant(value.review.reviewedAt) &&
    text(value.review.source, 2048) &&
    value.review.source.trim().length > 0 &&
    fingerprint(value.contentBinding)
  );
}
export async function publicationPermissionBinding(
  ref: RecipeContentRef | Immutable<RecipeContentRef>,
  subject: PermissionSubject | Immutable<PermissionSubject>,
  sha256: ContentHash,
): Promise<string> {
  const owned = copyContent({ ref, subject }, 4096);
  requireContent(
    exact(owned, ['ref', 'subject']) &&
      validateRecipeContentRef(owned.ref) &&
      validatePermissionSubject(owned.subject),
    'permission_subject',
  );
  return hashContent('cookmate-publication-permission-v2', owned, sha256);
}
export async function createPublishedRecipeRevision(
  revisionInput: unknown,
  permissionInput: unknown,
  sha256: ContentHash,
): Promise<Immutable<PublishedRecipeRevisionV2>> {
  // Copy every caller-owned input before hashing or consulting asynchronous ports.
  const source = copyContent(revisionInput, CONTENT_LIMITS.documentBytes + 1024);
  const evidence = copyContent(permissionInput, 64 * 1024);
  requireContent(
    Array.isArray(evidence) &&
      evidence.length >= 2 &&
      evidence.length <= OVERLAY_LIMITS.permissionsPerRevision &&
      evidence.every(permission),
    'publication_permissions',
  );
  const revision = await readRecipeContentRevision(source, sha256);
  const document = revision.document;
  requireContent(
    document.media.every((media) => mediaPublicationBlockers(media).length === 0),
    'publication_media_not_eligible',
  );
  requireContent(validateRecipeVideoUrl(document.recipe.videoUrl), 'publication_video');
  const expected: PermissionSubject[] = [
    { scope: 'recipe_text' },
    ...document.media.map((media) => ({
      scope: 'photo' as const,
      assetId: media.assetId,
      photoKey: media.photoKey,
    })),
    ...(document.recipe.videoUrl
      ? [{ scope: 'video_embed' as const, url: document.recipe.videoUrl }]
      : []),
  ];
  const bySubject = new Map(
    evidence.map((record) => [canonicalContentJson(record.subject), record]),
  );
  requireContent(
    bySubject.size === evidence.length && evidence.length === expected.length,
    'publication_permission_scope',
  );
  for (const subject of expected) {
    const record = bySubject.get(canonicalContentJson(subject));
    requireContent(record && record.status === 'permitted', 'publication_permission_missing');
    requireContent(
      record.contentBinding === (await publicationPermissionBinding(revision.ref, subject, sha256)),
      'publication_permission_binding',
    );
    if (subject.scope === 'photo') {
      const media = document.media.find(
        (item) => item.assetId === subject.assetId && item.photoKey === subject.photoKey,
      )!;
      requireContent(
        media.rights.statement === record.statement &&
          canonicalContentJson(media.rights.review) === canonicalContentJson(record.review),
        'publication_permission_contradiction',
      );
    }
  }
  const value = { formatVersion: 2 as const, revision, permissions: evidence };
  const publicationFingerprint = await hashContent('cookmate-published-recipe-v2', value, sha256);
  const publication = { ...value, publicationFingerprint };
  // The individually valid document and evidence must also fit the reader's complete envelope.
  canonicalContentJson(publication, PUBLICATION_MAX_BYTES);
  return freezeContent(publication) as Immutable<PublishedRecipeRevisionV2>;
}

/** Reviewed translations are signed alongside the original; they never rewrite its body. */
export async function createTranslatedPublishedRecipeRevision(
  revisionInput: unknown,
  basePermissionsInput: unknown,
  translationsInput: unknown,
  sha256: ContentHash,
): Promise<Immutable<PublishedRecipeRevisionV3>> {
  // Own every input before the base publication's first hash/await.
  const source = copyContent(revisionInput, CONTENT_LIMITS.documentBytes + 1024);
  const evidence = copyContent(basePermissionsInput, 64 * 1024);
  const translations = copyContent(translationsInput, PUBLICATION_MAX_BYTES);
  requireContent(
    Array.isArray(translations) &&
      translations.length > 0 &&
      translations.length <= MAX_PUBLICATION_TRANSLATIONS,
    'publication_translations',
  );
  const base = await createPublishedRecipeRevision(source, evidence, sha256);
  const targets = new Set<string>(),
    identities = new Set<string>();
  let originalLanguage: string | undefined;
  for (const translation of translations) {
    requireContent(
      exact(translation, [
        'translationId',
        'translationRevision',
        'sourceRef',
        'originalLanguage',
        'targetLanguage',
        'content',
        'attribution',
        'machineAssisted',
        'review',
        'permission',
      ]) &&
        identity(translation.translationId) &&
        integer(translation.translationRevision, 1, Number.MAX_SAFE_INTEGER) &&
        validateRecipeContentRef(translation.sourceRef) &&
        canonicalContentJson(translation.sourceRef) === canonicalContentJson(base.revision.ref) &&
        validateTranslationLanguage(translation.originalLanguage) &&
        validateTranslationLanguage(translation.targetLanguage) &&
        translation.originalLanguage !== translation.targetLanguage &&
        validateTranslationContent(translation.content, base.revision) &&
        ['human', 'machine', 'mixed'].includes(String(translation.attribution)) &&
        typeof translation.machineAssisted === 'boolean' &&
        (translation.attribution === 'human' || translation.machineAssisted) &&
        exact(translation.review, ['reviewerId', 'reviewedAt', 'source', 'evidence']) &&
        identity(translation.review.reviewerId) &&
        typeof translation.review.reviewedAt === 'string' &&
        isUtcInstant(translation.review.reviewedAt) &&
        text(translation.review.source, 2048) &&
        translation.review.source.trim().length > 0 &&
        translation.review.evidence === 'operator_acknowledgement',
      'publication_translation',
    );
    requireContent(
      !targets.has(translation.targetLanguage) &&
        !identities.has(translation.translationId) &&
        (originalLanguage === undefined || originalLanguage === translation.originalLanguage),
      'publication_translation_languages',
    );
    targets.add(translation.targetLanguage);
    identities.add(translation.translationId);
    originalLanguage = translation.originalLanguage;
    const subject: PermissionSubject = {
      scope: 'translated_recipe_text',
      translationId: translation.translationId,
      translationRevision: translation.translationRevision,
      language: translation.targetLanguage,
    };
    requireContent(
      permission(translation.permission) &&
        translation.permission.status === 'permitted' &&
        canonicalContentJson(translation.permission.subject) === canonicalContentJson(subject),
      'publication_translation_permission',
    );
    requireContent(
      translation.permission.contentBinding ===
        (await publicationPermissionBinding(base.revision.ref, subject, sha256)),
      'publication_permission_binding',
    );
  }
  const value = {
    formatVersion: 3 as const,
    revision: base.revision,
    permissions: base.permissions,
    translations: translations as PublishedRecipeTranslation[],
  };
  const publicationFingerprint = await hashContent('cookmate-published-recipe-v3', value, sha256);
  const publication = { ...value, publicationFingerprint };
  canonicalContentJson(publication, PUBLICATION_MAX_BYTES);
  return freezeContent(publication);
}

export async function readPublishedRecipeRevision(
  input: unknown,
  sha256: ContentHash,
): Promise<Immutable<PublishedRecipeRevision>> {
  const publication = copyContent(input, PUBLICATION_MAX_BYTES);
  requireContent(
    ((exact(publication, ['formatVersion', 'revision', 'permissions', 'publicationFingerprint']) &&
      publication.formatVersion === 2) ||
      (exact(publication, [
        'formatVersion',
        'revision',
        'permissions',
        'translations',
        'publicationFingerprint',
      ]) &&
        publication.formatVersion === 3)) &&
      fingerprint(publication.publicationFingerprint),
    'published_revision',
  );
  const expected =
    publication.formatVersion === 3
      ? await createTranslatedPublishedRecipeRevision(
          publication.revision,
          publication.permissions,
          publication.translations,
          sha256,
        )
      : await createPublishedRecipeRevision(publication.revision, publication.permissions, sha256);
  requireContent(
    expected.publicationFingerprint === publication.publicationFingerprint,
    'publication_integrity',
  );
  return expected;
}
