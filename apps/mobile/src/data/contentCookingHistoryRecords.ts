import type { Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  validateRecipeContentRef,
  type RecipeContentRef,
  type RecipeContentRevision,
} from '@cookmate/catalogue/content';
import { isActualLocalDate, isUtcInstant } from '@cookmate/contracts';
import { COOKING_NOTE_MAX_CHARACTERS } from '@cookmate/domain';
import { isAppId, isRevision } from './conversationRecords';
import { validateContentCookingSession, type ContentCookingSession } from './contentCookingRecords';

/** Matches the existing cooking_event.receipt_json limit. No public history format is changed. */
export const CONTENT_COOKING_HISTORY_RECORD_MAX_BYTES = 32768;
export const CONTENT_COOKED_RECOVERY_MAX_BYTES = 2048;

export interface ContentCookingHistoryEntry {
  readerVersion: 2;
  recipeId: string;
  contentRef: RecipeContentRef;
  eventId: string;
  recipeTitle: string;
  /** Exact verified-revision media identity, or an explicit no-photo choice. */
  photoAssetId: string | null;
  cookedOn: string;
  timeZone: string;
  recordedAt: string;
  note: string | null;
  historyEpoch: number;
  revision: number;
}

/** Imported personal data only; neither this marker nor an exact pin grants operation authority. */
export type ImportedContentCookingHistoryEntry = ContentCookingHistoryEntry & { origin: 'backup' };

/** Data shape only. Only an explicit cooked action may authorize this request. */
export interface SaveContentCookedInput {
  eventId: string;
  contentRef: RecipeContentRef;
  expectedHistoryEpoch: number;
  cookedOn: string;
  timeZone: string;
  note?: string | null;
  session?: { sessionId: string; expectedRevision: number };
}

/** Recovery identity only. It cannot authorize a save and contains no private draft text. */
export interface ContentCookedRecoveryReference {
  formatVersion: 1;
  eventId: string;
  requestFingerprint: string;
  contentRef: RecipeContentRef;
  expectedHistoryEpoch: number;
  session: { sessionId: string; expectedRevision: number } | null;
}

export type ContentCookedReceipt =
  | {
      kind: 'saved';
      event: ContentCookingHistoryEntry;
      closedSession: ContentCookingSession | null;
    }
  | { kind: 'cleared' | 'cancelled'; eventId: string; historyEpoch: number };

function boundedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  try {
    // The shared encoder admits data-only properties, depth and bytes before string copying.
    canonicalContentJson(value, CONTENT_COOKING_HISTORY_RECORD_MAX_BYTES);
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
    );
  } catch {
    return false;
  }
}
const positive = (value: unknown): value is number => isRevision(value) && value > 0;
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
function note(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && [...value].length <= COOKING_NOTE_MAX_CHARACTERS)
  );
}
function zone(value: unknown): value is string {
  if (!text(value, 100)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function sameRef(left: RecipeContentRef, right: Immutable<RecipeContentRef>) {
  return (
    left.recipeId === right.recipeId &&
    left.revisionId === right.revisionId &&
    left.contentFingerprint === right.contentFingerprint
  );
}

const historyEntryFields = [
  'readerVersion',
  'recipeId',
  'contentRef',
  'eventId',
  'recipeTitle',
  'photoAssetId',
  'cookedOn',
  'timeZone',
  'recordedAt',
  'note',
  'historyEpoch',
  'revision',
] as const;

export function validateContentCookingHistoryEntry(
  value: unknown,
): value is ContentCookingHistoryEntry {
  return (
    boundedRecord(value, historyEntryFields) &&
    value.readerVersion === 2 &&
    validateRecipeContentRef(value.contentRef) &&
    value.recipeId === value.contentRef.recipeId &&
    isAppId(value.eventId) &&
    text(value.recipeTitle, 1000) &&
    (value.photoAssetId === null ||
      (typeof value.photoAssetId === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(value.photoAssetId))) &&
    typeof value.cookedOn === 'string' &&
    isActualLocalDate(value.cookedOn) &&
    zone(value.timeZone) &&
    typeof value.recordedAt === 'string' &&
    isUtcInstant(value.recordedAt) &&
    note(value.note) &&
    isRevision(value.historyEpoch) &&
    positive(value.revision)
  );
}

/** Keep local receipts strict: only the separate imported-data path accepts the origin field. */
export function validateImportedContentCookingHistoryEntry(
  value: unknown,
): value is ImportedContentCookingHistoryEntry {
  if (!boundedRecord(value, [...historyEntryFields, 'origin']) || value.origin !== 'backup')
    return false;
  const { origin: _origin, ...entry } = value;
  return validateContentCookingHistoryEntry(entry);
}

export function validateSaveContentCookedInput(value: unknown): value is SaveContentCookedInput {
  return (
    boundedRecord(
      value,
      ['eventId', 'contentRef', 'expectedHistoryEpoch', 'cookedOn', 'timeZone'],
      ['note', 'session'],
    ) &&
    isAppId(value.eventId) &&
    validateRecipeContentRef(value.contentRef) &&
    isRevision(value.expectedHistoryEpoch) &&
    typeof value.cookedOn === 'string' &&
    isActualLocalDate(value.cookedOn) &&
    zone(value.timeZone) &&
    (!Object.hasOwn(value, 'note') || note(value.note)) &&
    (!Object.hasOwn(value, 'session') ||
      (boundedRecord(value.session, ['sessionId', 'expectedRevision']) &&
        isAppId(value.session.sessionId) &&
        positive(value.session.expectedRevision)))
  );
}

export function validateContentCookedRecoveryReference(
  value: unknown,
): value is ContentCookedRecoveryReference {
  try {
    canonicalContentJson(value, CONTENT_COOKED_RECOVERY_MAX_BYTES);
    return (
      boundedRecord(value, [
        'formatVersion',
        'eventId',
        'requestFingerprint',
        'contentRef',
        'expectedHistoryEpoch',
        'session',
      ]) &&
      value.formatVersion === 1 &&
      isAppId(value.eventId) &&
      typeof value.requestFingerprint === 'string' &&
      /^[0-9a-f]{64}$/.test(value.requestFingerprint) &&
      validateRecipeContentRef(value.contentRef) &&
      isRevision(value.expectedHistoryEpoch) &&
      (value.session === null ||
        (boundedRecord(value.session, ['sessionId', 'expectedRevision']) &&
          isAppId(value.session.sessionId) &&
          positive(value.session.expectedRevision)))
    );
  } catch {
    return false;
  }
}

export function validateContentCookedReceipt(value: unknown): value is ContentCookedReceipt {
  if (!boundedRecord(value, ['kind'], ['event', 'closedSession', 'eventId', 'historyEpoch']))
    return false;
  if (value.kind === 'saved') {
    if (
      !boundedRecord(value, ['kind', 'event', 'closedSession']) ||
      !validateContentCookingHistoryEntry(value.event)
    )
      return false;
    if (value.closedSession === null) return true;
    return (
      validateContentCookingSession(value.closedSession) &&
      value.closedSession.state === 'completed' &&
      sameRef(value.closedSession.contentRef, value.event.contentRef) &&
      value.closedSession.lastOperationId === value.event.eventId &&
      value.closedSession.updatedAt === value.event.recordedAt
    );
  }
  return (
    (value.kind === 'cleared' || value.kind === 'cancelled') &&
    boundedRecord(value, ['kind', 'eventId', 'historyEpoch']) &&
    isAppId(value.eventId) &&
    isRevision(value.historyEpoch)
  );
}

/**
 * Exact local consistency only; the caller must authenticate this revision under the content
 * reservation and apply withdrawal policy. A match never establishes publication or action trust.
 */
export function matchesContentCookingHistoryRevision(
  value: unknown,
  verifiedRevision: Immutable<RecipeContentRevision>,
): boolean {
  const entry = validateContentCookingHistoryEntry(value);
  if (!entry && !validateSaveContentCookedInput(value)) return false;
  if (
    !sameRef(value.contentRef, verifiedRevision.ref) ||
    value.contentRef.recipeId !== verifiedRevision.document.recipe.recipeId
  )
    return false;
  return (
    !entry ||
    (value.recipeTitle === verifiedRevision.document.recipe.title &&
      (value.photoAssetId === null ||
        verifiedRevision.document.media.some(
          (media) => media.assetId === value.photoAssetId && media.recipeId === value.recipeId,
        )))
  );
}
