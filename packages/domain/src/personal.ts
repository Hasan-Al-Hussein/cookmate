import type { ContractError } from '@cookmate/contracts';
import type { Immutable } from './search';
import type { RepositoryResult } from './services';

export const personalLimits = Object.freeze({
  noteCharacters: 4000,
  collectionNameCharacters: 80,
  itemNameCharacters: 160,
  amountCharacters: 80,
  unitCharacters: 80,
  collections: 100,
  manualItems: 5000,
  pageSize: 50,
});
export const manualShoppingCategories = [
  'produce',
  'dairy',
  'meat_fish',
  'pantry',
  'other',
] as const;
export type ManualShoppingCategory = (typeof manualShoppingCategories)[number];
export interface RecipeNote {
  noteId: string;
  recipeId: string;
  text: string | null;
  deleted: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface PersonalCollection {
  collectionId: string;
  name: string | null;
  deleted: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CollectionMembership {
  collectionId: string;
  recipeId: string;
  present: boolean;
  revision: number;
  updatedAt: string;
}
export interface PersonalCollectionSummary extends PersonalCollection {
  memberCount: number;
}
export interface ManualShoppingItem {
  kind: 'manual';
  itemId: string;
  name: string | null;
  amountText: string | null;
  unitText: string | null;
  category: ManualShoppingCategory | null;
  purchased: boolean;
  deleted: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface ManualShoppingFields {
  name: string;
  amountText: string | null;
  unitText: string | null;
  category: ManualShoppingCategory;
}
interface MutationIdentity {
  operationId: string;
  expectedEpoch: number;
}
/** App-local commands only; never part of the AI command schema or provider context. */
export type PersonalCommand = MutationIdentity &
  (
    | {
        kind: 'saveNote';
        noteId: string;
        recipeId: string;
        expectedRevision: number | null;
        text: string;
      }
    | { kind: 'deleteNote'; noteId: string; expectedRevision: number }
    | { kind: 'createCollection'; collectionId: string; name: string }
    | { kind: 'renameCollection'; collectionId: string; expectedRevision: number; name: string }
    | {
        kind: 'setCollectionMembership';
        collectionId: string;
        recipeId: string;
        expectedCollectionRevision: number;
        expectedRevision: number | null;
        present: boolean;
      }
    | { kind: 'addManualItem'; itemId: string; fields: ManualShoppingFields }
    | {
        kind: 'editManualItem';
        itemId: string;
        expectedRevision: number;
        fields: ManualShoppingFields;
      }
    | { kind: 'setManualPurchased'; itemId: string; expectedRevision: number; purchased: boolean }
    | { kind: 'deleteManualItem'; itemId: string; expectedRevision: number }
  );
export interface PersonalReceipt {
  operationId: string;
  outcome: 'committed' | 'no_op' | 'cancelled';
  commandKind: PersonalCommand['kind'] | 'deleteCollection' | null;
  entityId: string | null;
  revision: number;
  epoch: number;
  committedAt: string;
  affectedMemberships: number;
}
export interface DeleteCollectionReview {
  reviewId: string;
  collectionId: string;
  name: string;
  expectedRevision: number;
  epoch: number;
  /** Exact current members affected, in stable recipe-ID order; favourites remain untouched. */
  affectedRecipeIds: string[];
}
export interface RecipePersonalSnapshot {
  epoch: number;
  note: RecipeNote | null;
  /** Includes removed memberships for active collections so edits retain their revision guards. */
  memberships: CollectionMembership[];
}
export interface PersonalCollectionsSnapshot {
  epoch: number;
  items: PersonalCollectionSummary[];
}
export interface PersonalCollectionPage {
  epoch: number;
  collection: PersonalCollectionSummary;
  items: CollectionMembership[];
  nextCursor: string | null;
}
export interface ManualShoppingPage {
  epoch: number;
  items: ManualShoppingItem[];
  nextCursor: string | null;
  total: number;
}
export type PersonalMutationResult =
  | RepositoryResult<Immutable<PersonalReceipt>>
  | { kind: 'uncertain'; operationId: string; error: ContractError };
export interface PersonalChange {
  revision: number;
  notes: boolean;
  collections: boolean;
  manualShopping: boolean;
}
export interface PersonalService {
  readRecipePersonal(
    recipeId: string,
  ): Promise<RepositoryResult<Immutable<RecipePersonalSnapshot>>>;
  readCollections(): Promise<RepositoryResult<Immutable<PersonalCollectionsSnapshot>>>;
  readCollection(
    collectionId: string,
    input?: { cursor?: string; limit?: number },
  ): Promise<RepositoryResult<Immutable<PersonalCollectionPage>>>;
  readManualShopping(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<RepositoryResult<Immutable<ManualShoppingPage>>>;
  execute(command: Immutable<PersonalCommand>): Promise<PersonalMutationResult>;
  reviewDeleteCollection(
    collectionId: string,
  ): Promise<RepositoryResult<Immutable<DeleteCollectionReview>>>;
  deleteCollection(
    review: Immutable<DeleteCollectionReview>,
    operationId: string,
  ): Promise<PersonalMutationResult>;
  readReceipt(operationId: string): Promise<RepositoryResult<Immutable<PersonalReceipt> | null>>;
  /** Explicit recovery: serialize existing result or cancellation against delayed same-ID writes. */
  resolveOperation(operationId: string): Promise<PersonalMutationResult>;
  subscribe(listener: (change: PersonalChange) => void): () => void;
}
