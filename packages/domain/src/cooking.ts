import type { CatalogueIdentity, ContractError, Recipe } from '@cookmate/contracts';
import type { Immutable } from './search';
import type { RepositoryResult } from './services';

export const COOKING_READER_VERSION = 1;
export const COOKING_NOTE_MAX_CHARACTERS = 2000;
export const COOKING_HISTORY_PAGE_LIMIT = 50;
export interface CookingContentIdentity {
  recipeId: string;
  catalogue: CatalogueIdentity;
  /** Derived from the actual recipe content; this is NOT a publisher's revision. */
  contentFingerprint: string;
  readerVersion: typeof COOKING_READER_VERSION;
}
export interface CookingSession extends CookingContentIdentity {
  sessionId: string;
  revision: number;
  passageSequence: number;
  state: 'active' | 'dismissed' | 'completed';
  updatedAt: string;
  lastOperationId: string;
}
export interface CookingSessionView {
  currentContent: CookingContentIdentity;
  passageSequences: number[];
  /** Includes the last closed session, so new sessions can retain its revision guard. */
  session: CookingSession | null;
  resume: 'none' | 'matching' | 'content_changed';
}
export interface SaveCookingSessionInput {
  operationId: string;
  sessionId: string;
  recipeId: string;
  /** null only when readSession returned no stored session. Restart uses a new sessionId. */
  expectedRevision: number | null;
  contentFingerprint: string;
  readerVersion: typeof COOKING_READER_VERSION;
  /** An original source passage sequence, never a rendered section index. */
  passageSequence: number;
}
export interface DismissCookingSessionInput {
  operationId: string;
  recipeId: string;
  sessionId: string;
  expectedRevision: number;
}
export interface SaveCookedInput {
  eventId: string;
  recipeId: string;
  contentFingerprint: string;
  readerVersion: typeof COOKING_READER_VERSION;
  expectedHistoryEpoch: number;
  /** The user-selected cooked date, distinct from the app-recorded UTC save timestamp. */
  cookedOn: string;
  timeZone: string;
  note?: string | null;
  /** Omit when marking cooked independently of a reading session. */
  session?: { sessionId: string; expectedRevision: number };
}
export interface CookingHistoryEntry extends CookingContentIdentity {
  /** Imported data has no authority as a local saveCooked receipt. */
  origin?: 'backup';
  eventId: string;
  recipeTitle: string;
  photoKey: string;
  cookedOn: string;
  timeZone: string;
  recordedAt: string;
  note: string | null;
  historyEpoch: number;
  revision: number;
}
export type CookedReceipt =
  | { kind: 'saved'; event: CookingHistoryEntry; closedSession: CookingSession | null }
  | { kind: 'cleared'; eventId: string; historyEpoch: number }
  | { kind: 'cancelled'; eventId: string; historyEpoch: number };
export interface CookingHistoryPage {
  items: CookingHistoryEntry[];
  historyRevision: number;
  historyEpoch: number;
  nextCursor: string | null;
}
export interface ClearCookingHistoryReview {
  reviewId: string;
  expectedHistoryRevision: number;
  historyEpoch: number;
  count: number;
}
export interface ClearCookingHistoryReceipt {
  operationId: string;
  outcome: 'cleared' | 'cancelled';
  clearedCount: number;
  previousHistoryEpoch: number;
  historyEpoch: number;
  historyRevision: number;
  committedAt: string;
}
export type CookingMutationResult<Value> =
  | RepositoryResult<Immutable<Value>>
  | { kind: 'uncertain'; operationId: string; error: ContractError };
export interface CookingChange {
  recipeId: string | null;
  historyChanged: boolean;
  revision: number;
}
export interface CookingService {
  readResumeSession(): Promise<RepositoryResult<Immutable<CookingSessionView> | null>>;
  readSession(recipeId: string): Promise<RepositoryResult<Immutable<CookingSessionView>>>;
  saveSession(
    input: Immutable<SaveCookingSessionInput>,
  ): Promise<CookingMutationResult<CookingSession>>;
  dismissSession(
    input: Immutable<DismissCookingSessionInput>,
  ): Promise<CookingMutationResult<CookingSession>>;
  readHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<RepositoryResult<Immutable<CookingHistoryPage>>>;
  saveCooked(input: Immutable<SaveCookedInput>): Promise<CookingMutationResult<CookedReceipt>>;
  readCookedReceipt(eventId: string): Promise<RepositoryResult<Immutable<CookedReceipt> | null>>;
  /** Explicit recovery: returns the committed result or durably fences an uncommitted ID. */
  resolveCookedOperation(eventId: string): Promise<CookingMutationResult<CookedReceipt>>;
  reviewClearHistory(): Promise<RepositoryResult<Immutable<ClearCookingHistoryReview>>>;
  /** Retain the exact issued review and operationId through confirmation/recovery. */
  clearHistory(
    review: Immutable<ClearCookingHistoryReview>,
    operationId: string,
  ): Promise<CookingMutationResult<ClearCookingHistoryReceipt>>;
  readClearHistoryReceipt(
    operationId: string,
  ): Promise<RepositoryResult<Immutable<ClearCookingHistoryReceipt> | null>>;
  /** Cancellation does not clear entries or advance the history revision/epoch. */
  resolveClearHistoryOperation(
    operationId: string,
  ): Promise<CookingMutationResult<ClearCookingHistoryReceipt>>;
  subscribe(listener: (change: CookingChange) => void): () => void;
}

/** Stable explicit fields, preserving source order, quantities and warning text. */
export async function cookingContentIdentity(
  recipe: Immutable<Recipe>,
  catalogue: Readonly<CatalogueIdentity>,
  sha256: (value: string) => Promise<string>,
): Promise<CookingContentIdentity> {
  const fingerprint = await sha256(
    JSON.stringify([
      'cookmate-cooking-content-v1',
      recipe.recipeId,
      recipe.title,
      recipe.photoKey,
      recipe.ingredients.map((item) => [item.position, item.rawName, item.rawMeasure]),
      recipe.instructions.map((item) => [item.sequence, item.presentation, item.rawText]),
      recipe.annotations.map((item) => [item.annotationId, item.kind, item.note, item.ruleVersion]),
    ]),
  );
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('Cooking fingerprint unavailable');
  return {
    recipeId: recipe.recipeId,
    catalogue: { ...catalogue },
    contentFingerprint: fingerprint,
    readerVersion: COOKING_READER_VERSION,
  };
}
