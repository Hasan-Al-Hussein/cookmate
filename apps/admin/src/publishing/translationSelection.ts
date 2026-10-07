import {
  canonicalContentJson,
  MAX_PUBLICATION_TRANSLATIONS,
  publicationPermissionBinding,
  type PublishedRecipeTranslation,
  type RecipeContentRef,
  type ReviewEvidence,
} from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/catalogue';
import type { AdminDraft, AdminPublicationTranslationSelection } from '../contracts';
import type { AdminDatabase } from '../storage/database';
import type {
  AdminTranslation,
  AdminTranslationReview,
  AdminTranslationSource,
} from '../translations/contracts';
import { TranslationRepository } from '../translations/repository';
import { requireAdmin } from '../auth/errors';
import { identifier, object, revision, text } from '../drafts/validation';
import { sha256 } from '../drafts/repository';

export const PREPARATION_REQUEST_BYTES = 128 * 1024;
export interface TranslationPreparationEvidence {
  translationId: string;
  translationRevision: number;
  source: AdminTranslationSource;
  translatedFingerprint: string;
  approval: AdminTranslationReview;
}
const same = (a: unknown, b: unknown) => canonicalContentJson(a) === canonicalContentJson(b);
const hash = async (value: string) => sha256(value);

/** Request assertions are owned data, not a substitute for the authenticated operator check. */
export function ownTranslationSelections(input: unknown): AdminPublicationTranslationSelection[] {
  const value: unknown = JSON.parse(canonicalContentJson(input, PREPARATION_REQUEST_BYTES));
  requireAdmin(
    Array.isArray(value) && value.length > 0 && value.length <= MAX_PUBLICATION_TRANSLATIONS,
    400,
    'invalid_translation_selection',
    'Select between one and eight exact reviewed translations.',
  );
  const ids = new Set<string>();
  return value.map((item): AdminPublicationTranslationSelection => {
    object(item, ['translationId', 'translationRevision', 'rights']);
    identifier(item.translationId);
    revision(item.translationRevision);
    object(item.rights, ['statement', 'sourceUrl', 'acknowledge']);
    text(item.rights.statement, 2000);
    text(item.rights.sourceUrl, 2048, true);
    let validUrl = item.rights.sourceUrl === null;
    if (typeof item.rights.sourceUrl === 'string' && item.rights.sourceUrl) {
      try {
        const url = new URL(item.rights.sourceUrl);
        validUrl = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
      } catch {
        /* Rejected below. */
      }
    }
    requireAdmin(
      item.rights.acknowledge === true &&
        typeof item.rights.statement === 'string' &&
        item.rights.statement.trim().length > 0 &&
        validUrl,
      400,
      'translation_rights_required',
      'Explicitly acknowledge permission for this exact translated text, with a statement and an optional evidence URL.',
    );
    requireAdmin(
      !ids.has(item.translationId),
      400,
      'invalid_translation_selection',
      'Select each translation once.',
    );
    ids.add(item.translationId);
    return {
      translationId: item.translationId,
      translationRevision: item.translationRevision,
      rights: {
        statement: item.rights.statement,
        sourceUrl: item.rights.sourceUrl,
        acknowledge: true,
      },
    };
  });
}
function reviewed(record: AdminTranslation) {
  requireAdmin(
    record.status === 'reviewed' &&
      record.review?.decision === 'approved' &&
      record.review.evidence === 'operator_acknowledgement',
    409,
    'translation_approval_required',
    'Approve this exact translation before preparing it.',
  );
  return record.review;
}
export function translationEvidence(
  records: readonly AdminTranslation[],
): TranslationPreparationEvidence[] {
  return records.map((record) => ({
    translationId: record.translationId,
    translationRevision: record.revision,
    source: { ...record.source },
    translatedFingerprint: record.translatedFingerprint,
    approval: { ...reviewed(record) },
  }));
}
export function readTranslationSelections(
  db: AdminDatabase,
  now: () => Date,
  draft: AdminDraft,
  selections: readonly AdminPublicationTranslationSelection[],
): AdminTranslation[] {
  const repository = new TranslationRepository(db, now);
  const records = selections.map((selection) => {
    const record = repository.read(selection.translationId);
    requireAdmin(
      record.revision === selection.translationRevision,
      409,
      'translation_revision_conflict',
      'A selected translation changed. Review its current version before preparing it.',
    );
    reviewed(record);
    requireAdmin(
      record.sourceStatus.kind === 'current' &&
        record.source.draftId === draft.draftId &&
        record.source.revision === draft.revision &&
        record.source.recipeId === draft.recipeId &&
        record.source.inputFingerprint === sha256(canonicalContentJson(draft.input)),
      409,
      'translation_source_stale',
      'Rebase and review this translation against the exact approved original draft.',
    );
    return record;
  });
  requireAdmin(
    new Set(records.map((record) => record.targetLanguage)).size === records.length &&
      new Set(records.map((record) => record.originalLanguage)).size === 1,
    409,
    'translation_languages',
    'Select one translation per target language with the same original language.',
  );
  return records;
}
export function assertTranslationAuthority(
  db: AdminDatabase,
  now: () => Date,
  draft: AdminDraft,
  selections: readonly AdminPublicationTranslationSelection[] | undefined,
  evidence: readonly TranslationPreparationEvidence[] | undefined,
) {
  if (selections === undefined) {
    requireAdmin(
      evidence === undefined,
      500,
      'preparation_integrity',
      'Retained translation evidence is inconsistent.',
    );
    return;
  }
  requireAdmin(
    evidence &&
      same(translationEvidence(readTranslationSelections(db, now, draft, selections)), evidence),
    409,
    'translation_approval_changed',
    'A selected translation or its approval changed before the operation committed.',
  );
}
function translatedContent(record: AdminTranslation): PublishedRecipeTranslation['content'] {
  return {
    title: record.input.title,
    description: record.input.description,
    category: record.input.category,
    cuisine: record.input.cuisine,
    rawTags: record.input.rawTags,
    ingredients: record.input.ingredients.map((row, index) => ({
      position: index + 1,
      rawName: row.rawName,
    })),
    instructions: record.input.instructions.map((row, index) => ({
      sequence: index + 1,
      rawText: row.rawText,
    })),
  };
}
function reviewSource(record: AdminTranslation) {
  return `cookmate-admin:translation:${record.translationId}:revision:${record.revision}`;
}
export function translationRightsSource(record: AdminTranslation) {
  return `cookmate-admin:translation-rights:${record.translationId}:revision:${record.revision}`;
}
export async function createPublicationTranslations(
  records: readonly AdminTranslation[],
  selections: readonly AdminPublicationTranslationSelection[],
  ref: RecipeContentRef,
  reviewer: { reviewerId: string; reviewedAt: string },
): Promise<PublishedRecipeTranslation[]> {
  const translations: PublishedRecipeTranslation[] = [];
  for (const [index, record] of records.entries()) {
    const approval = reviewed(record),
      selection = selections[index]!;
    const subject = {
      scope: 'translated_recipe_text' as const,
      translationId: record.translationId,
      translationRevision: record.revision,
      language: record.targetLanguage,
    };
    const rightsReview: ReviewEvidence = { ...reviewer, source: translationRightsSource(record) };
    translations.push({
      translationId: record.translationId,
      translationRevision: record.revision,
      sourceRef: { ...ref },
      originalLanguage: record.originalLanguage,
      targetLanguage: record.targetLanguage,
      content: translatedContent(record),
      attribution: record.input.attribution,
      machineAssisted: record.machineAssisted,
      review: {
        reviewerId: approval.reviewerId,
        reviewedAt: approval.reviewedAt,
        source: reviewSource(record),
        evidence: 'operator_acknowledgement',
      },
      permission: {
        subject,
        status: 'permitted',
        statement: selection.rights.statement,
        sourceUrl: selection.rights.sourceUrl,
        review: rightsReview,
        contentBinding: await publicationPermissionBinding(ref, subject, hash),
      },
    });
  }
  return translations;
}

/** Historical receipt checks read the selected immutable revision, never the current translation. */
export function validateRetainedTranslationEvidence(
  db: AdminDatabase,
  now: () => Date,
  input: {
    draftId: string;
    draftRevision: number;
    recipeId: string;
    reviewerId: string;
    preparedAt: string;
    selections: readonly AdminPublicationTranslationSelection[];
    evidence: unknown;
    translations: readonly Immutable<PublishedRecipeTranslation>[];
  },
): boolean {
  const repository = new TranslationRepository(db, now);
  const records = input.selections.map((selection) =>
    repository.read(selection.translationId, selection.translationRevision),
  );
  if (
    !same(translationEvidence(records), input.evidence) ||
    records.length !== input.translations.length
  )
    return false;
  return records.every((record, index) => {
    const translation = input.translations[index]!,
      selection = input.selections[index]!,
      approval = reviewed(record);
    return (
      record.source.draftId === input.draftId &&
      record.source.revision === input.draftRevision &&
      record.source.recipeId === input.recipeId &&
      translation.translationId === record.translationId &&
      translation.translationRevision === record.revision &&
      translation.originalLanguage === record.originalLanguage &&
      translation.targetLanguage === record.targetLanguage &&
      same(translation.content, translatedContent(record)) &&
      translation.attribution === record.input.attribution &&
      translation.machineAssisted === record.machineAssisted &&
      same(translation.review, {
        reviewerId: approval.reviewerId,
        reviewedAt: approval.reviewedAt,
        source: reviewSource(record),
        evidence: 'operator_acknowledgement',
      }) &&
      translation.permission.statement === selection.rights.statement &&
      translation.permission.sourceUrl === selection.rights.sourceUrl &&
      translation.permission.review.reviewerId === input.reviewerId &&
      translation.permission.review.source === translationRightsSource(record) &&
      translation.permission.review.reviewedAt <= input.preparedAt
    );
  });
}
