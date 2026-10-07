import type { Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  validateRecipeContentRef,
  type RecipeContentRef,
  type RecipeContentRevision,
} from '@cookmate/catalogue/content';
import { isUtcInstant } from '@cookmate/contracts';
import { isAppId, isRevision } from './conversationRecords';

/** Matches the existing cooking_session.session_json storage limit. */
export const CONTENT_COOKING_RECORD_MAX_BYTES = 8192;

/** Private exact-content format; legacy readerVersion: 1 records retain their original meaning. */
export interface ContentCookingSession {
  readerVersion: 2;
  recipeId: string;
  contentRef: RecipeContentRef;
  sessionId: string;
  revision: number;
  /** Original instruction sequence, including original headings; never a rendered section index. */
  passageSequence: number;
  state: 'active' | 'dismissed' | 'completed';
  updatedAt: string;
  lastOperationId: string;
}

export interface SaveContentCookingSessionInput {
  operationId: string;
  sessionId: string;
  contentRef: RecipeContentRef;
  expectedRevision: number | null;
  passageSequence: number;
}

export interface DismissContentCookingSessionInput {
  operationId: string;
  recipeId: string;
  sessionId: string;
  expectedRevision: number;
}

function boundedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  try {
    // This core encoder checks byte/depth budgets and data-only properties before making string
    // copies. No JSON clone or property accessor executes on an unadmitted caller value.
    canonicalContentJson(value, CONTENT_COOKING_RECORD_MAX_BYTES);
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key))
    );
  } catch {
    return false;
  }
}
const positive = (value: unknown): value is number => isRevision(value) && value > 0;
const recipeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value);

export function validateContentCookingSession(value: unknown): value is ContentCookingSession {
  return (
    boundedRecord(value, [
      'readerVersion',
      'recipeId',
      'contentRef',
      'sessionId',
      'revision',
      'passageSequence',
      'state',
      'updatedAt',
      'lastOperationId',
    ]) &&
    value.readerVersion === 2 &&
    validateRecipeContentRef(value.contentRef) &&
    value.recipeId === value.contentRef.recipeId &&
    isAppId(value.sessionId) &&
    positive(value.revision) &&
    positive(value.passageSequence) &&
    (value.state === 'active' || value.state === 'dismissed' || value.state === 'completed') &&
    typeof value.updatedAt === 'string' &&
    isUtcInstant(value.updatedAt) &&
    isAppId(value.lastOperationId)
  );
}

export function validateSaveContentCookingSessionInput(
  value: unknown,
): value is SaveContentCookingSessionInput {
  return (
    boundedRecord(value, [
      'operationId',
      'sessionId',
      'contentRef',
      'expectedRevision',
      'passageSequence',
    ]) &&
    isAppId(value.operationId) &&
    isAppId(value.sessionId) &&
    validateRecipeContentRef(value.contentRef) &&
    (value.expectedRevision === null || positive(value.expectedRevision)) &&
    positive(value.passageSequence)
  );
}

export function validateDismissContentCookingSessionInput(
  value: unknown,
): value is DismissContentCookingSessionInput {
  return (
    boundedRecord(value, ['operationId', 'recipeId', 'sessionId', 'expectedRevision']) &&
    isAppId(value.operationId) &&
    recipeId(value.recipeId) &&
    isAppId(value.sessionId) &&
    positive(value.expectedRevision)
  );
}

/**
 * Consistency only: the caller must already have authenticated the retained revision under its
 * content reservation. Neither an exact reference nor this helper establishes signature trust.
 */
export function matchesContentCookingRevision(
  value: unknown,
  verifiedRevision: Immutable<RecipeContentRevision>,
): boolean {
  if (!validateContentCookingSession(value) && !validateSaveContentCookingSessionInput(value))
    return false;
  const ref = value.contentRef;
  return (
    ref.recipeId === verifiedRevision.ref.recipeId &&
    ref.revisionId === verifiedRevision.ref.revisionId &&
    ref.contentFingerprint === verifiedRevision.ref.contentFingerprint &&
    ref.recipeId === verifiedRevision.document.recipe.recipeId &&
    verifiedRevision.document.recipe.instructions.some(
      (passage) => passage.sequence === value.passageSequence,
    )
  );
}
