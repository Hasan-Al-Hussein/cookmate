import type { CatalogueIdentity, MealKey, PreferenceType } from '@cookmate/contracts';
import type { ManualShoppingCategory } from '@cookmate/domain';

export const ACCOUNT_SNAPSHOT_FORMAT = 'cookmate-account-snapshot';
export const ACCOUNT_SNAPSHOT_VERSION = 1;
export const ACCOUNT_EXPANDED_SNAPSHOT_VERSION = 2;
export const ACCOUNT_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const accountSnapshotLimits = {
  favourites: 10000,
  plan: 20000,
  selectedOccurrences: 1000,
  purchaseMarks: 40000,
  preferences: 100,
} as const;

export interface AccountFavourite {
  recipeId: string;
  savedAt: string;
}
export interface AccountPlanOccurrence {
  occurrenceId: string;
  recipeId: string;
  placement: { actualDate: string; mealKey: MealKey };
  createdAt: string;
  updatedAt: string;
}
export interface AccountPurchaseMark {
  groupKey: string;
  groupingVersion: string;
  demandFingerprint: string;
  purchased: boolean;
  changed: boolean;
}
export interface AccountPreference {
  preferenceId: string;
  type: PreferenceType;
  value: string;
}
export interface AccountAppPreferences {
  theme: 'system' | 'light' | 'dark';
  motion: 'system' | 'reduced';
  locale: 'system' | 'en' | 'ar';
}
export interface AccountProfile {
  displayName: string | null;
}
export interface AccountSnapshotOptions {
  appPreferences: AccountAppPreferences;
  profile: AccountProfile;
}

/** Wire allowlist. Local revisions, conversations, credentials and receipts never belong here. */
interface AccountSnapshotCore extends AccountSnapshotOptions {
  format: typeof ACCOUNT_SNAPSHOT_FORMAT;
  catalogue: CatalogueIdentity;
  favourites: AccountFavourite[];
  plan: AccountPlanOccurrence[];
  shopping: { selectedOccurrenceIds: string[]; purchaseMarks: AccountPurchaseMark[] };
  preferences: AccountPreference[];
}
export interface AccountSnapshotV1 extends AccountSnapshotCore {
  schemaVersion: typeof ACCOUNT_SNAPSHOT_VERSION;
}
export interface AccountRecipeNote {
  noteId: string;
  recipeId: string;
  text: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AccountCollection {
  collectionId: string;
  name: string | null;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AccountCollectionMembership {
  collectionId: string;
  recipeId: string;
  present: boolean;
  updatedAt: string;
}
export interface AccountManualItem {
  kind: 'manual';
  itemId: string;
  name: string | null;
  amountText: string | null;
  unitText: string | null;
  category: ManualShoppingCategory | null;
  purchased: boolean;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AccountPersonalData {
  notes: AccountRecipeNote[];
  collections: AccountCollection[];
  memberships: AccountCollectionMembership[];
  manualItems: AccountManualItem[];
}
export interface AccountCookingHistoryEntry {
  eventId: string;
  recipeId: string;
  catalogue: CatalogueIdentity;
  contentFingerprint: string;
  readerVersion: 1;
  origin?: 'backup';
  recipeTitle: string;
  photoKey: string;
  cookedOn: string;
  timeZone: string;
  recordedAt: string;
  note: string | null;
}
export interface AccountCookingHistory {
  entries: AccountCookingHistoryEntry[];
  removedEventIds: string[];
}
export interface AccountSnapshotV2 extends AccountSnapshotCore {
  schemaVersion: typeof ACCOUNT_EXPANDED_SNAPSHOT_VERSION;
  personal: AccountPersonalData;
  cookingHistory?: AccountCookingHistory;
}
export type AccountSnapshot = AccountSnapshotV1 | AccountSnapshotV2;

/** Pure projection/merge input, not proof of a user's durable scope approval. */
export interface AccountExpandedScope {
  historyIncluded: boolean;
}
export interface AccountExpandedAdapterOptions {
  schemaVersion: 2;
  includeCookingHistory: boolean;
  removedHistoryEventIds?: readonly string[];
}
export interface AccountCollectionSubtree {
  collection: AccountCollection;
  memberships: AccountCollectionMembership[];
}

export type AccountSnapshotFailure =
  | 'invalid_json'
  | 'unsupported_version'
  | 'invalid_structure'
  | 'too_large'
  | 'scope_review_required'
  | 'history_identity_collision'
  | 'invalid_resolution';
export class AccountSnapshotError extends Error {
  constructor(public readonly reason: AccountSnapshotFailure) {
    super(`Account snapshot: ${reason}`);
    this.name = 'AccountSnapshotError';
  }
}

export type AccountConflictKind =
  | 'occurrence_edit'
  | 'delete_edit'
  | 'slot_collision'
  | 'preference_edit'
  | 'preference_collision'
  | 'purchase_state'
  | 'note_edit'
  | 'collection_edit'
  | 'collection_subtree'
  | 'membership_edit'
  | 'manual_item_edit'
  | 'setting';
export type AccountConflictValue =
  | null
  | string
  | boolean
  | AccountPlanOccurrence
  | AccountPlanOccurrence[]
  | AccountPreference
  | AccountPreference[]
  | AccountPurchaseMark
  | AccountRecipeNote
  | AccountCollection
  | AccountCollectionMembership
  | AccountManualItem
  | AccountCollectionSubtree;
export interface AccountMergeConflict {
  /** Includes the exact conflicting values; a decision for an older comparison is rejected. */
  id: string;
  kind: AccountConflictKind;
  path: string;
  base: AccountConflictValue;
  local: AccountConflictValue;
  account: AccountConflictValue;
}
export type AccountMergeResolution = 'local' | 'account';
export type AccountMergeResolutions = Readonly<Record<string, AccountMergeResolution>>;
export interface AccountMergeNotice {
  kind: 'deduplicated_occurrence' | 'deduplicated_preference' | 'purchase_requires_reprojection';
  fromId: string;
  toId: string;
}
export type AccountMergeResult =
  | { status: 'merged'; snapshot: AccountSnapshot; notices: AccountMergeNotice[] }
  | { status: 'needs_review'; conflicts: AccountMergeConflict[]; notices: AccountMergeNotice[] }
  | { status: 'incompatible_catalogue' };
export interface AccountMergeInput {
  base: AccountSnapshot;
  local: AccountSnapshot;
  account: AccountSnapshot;
  resolutions?: AccountMergeResolutions;
  expandedScope?: AccountExpandedScope;
  /** A broad account preference cannot approve revival of known personal removals. */
  reviewPersonalRemovals?: boolean;
}
