import type {
  AccountSnapshotV2,
  AccountRecipeNote,
  AccountCollection,
  AccountCollectionMembership,
  AccountManualItem,
  AccountCookingHistoryEntry,
} from '../src';
import { snapshot, catalogue, id, timestamp } from './fixtures';
export const expandedSnapshot = (): AccountSnapshotV2 => ({
  ...snapshot(),
  schemaVersion: 2,
  personal: { notes: [], collections: [], memberships: [], manualItems: [] },
});
export const note = (n = 1, recipeId = '52819', text = 'Less salt'): AccountRecipeNote => ({
  noteId: id(n),
  recipeId,
  text,
  deleted: false,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const collection = (n = 2, name = 'Dinners'): AccountCollection => ({
  collectionId: id(n),
  name,
  deleted: false,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const membership = (n = 2, recipeId = '52819'): AccountCollectionMembership => ({
  collectionId: id(n),
  recipeId,
  present: true,
  updatedAt: timestamp,
});
export const manual = (n = 3): AccountManualItem => ({
  kind: 'manual',
  itemId: id(n),
  name: 'Lemons',
  amountText: '2',
  unitText: null,
  category: 'produce',
  purchased: false,
  deleted: false,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const history = (n = 4): AccountCookingHistoryEntry => ({
  eventId: id(n),
  recipeId: '52819',
  catalogue,
  contentFingerprint: 'b'.repeat(64),
  readerVersion: 1,
  recipeTitle: 'Cajun spiced fish tacos',
  photoKey: '52819.jpg',
  cookedOn: '2026-09-30',
  timeZone: 'Asia/Dubai',
  recordedAt: timestamp,
  note: null,
});
