import { isActualLocalDate, isUtcInstant } from '@cookmate/contracts';
import { COOKING_NOTE_MAX_CHARACTERS } from './cooking';
import type { CookingHistoryEntry } from './cooking';
import { manualShoppingCategories, personalLimits } from './personal';
import type {
  CollectionMembership,
  ManualShoppingItem,
  PersonalCollection,
  RecipeNote,
} from './personal';
import type { Immutable } from './search';

/** Whole-record limits include redacted tombstones; the outer package also has an 8 MiB cap. */
export const portablePersonalLimits = {
  notes: 10000,
  collections: 10000,
  memberships: 50000,
  manualItems: 20000,
  history: 10000,
} as const;
export interface PortablePersonalData {
  notes: RecipeNote[];
  collections: PersonalCollection[];
  memberships: CollectionMembership[];
  manualItems: ManualShoppingItem[];
}
export interface PortablePersonalCounts {
  notes: number;
  noteTombstones: number;
  collections: number;
  collectionTombstones: number;
  memberships: number;
  removedMemberships: number;
  manualItems: number;
  manualTombstones: number;
  purchasedManualItems: number;
}
export interface PortableCookingHistory {
  entries: CookingHistoryEntry[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const recipe = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v);
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => count(v) && v > 0;
const instant = (v: unknown): v is string => typeof v === 'string' && isUtcInstant(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && [...v].length <= max;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const array = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
const unique = <T>(v: T[], key: (item: T) => string) => new Set(v.map(key)).size === v.length;
const dates = (v: Record<string, unknown>) => instant(v.createdAt) && instant(v.updatedAt);

export function validatePortablePersonal(value: unknown): value is PortablePersonalData {
  if (
    !exact(value, ['notes', 'collections', 'memberships', 'manualItems']) ||
    !array(value.notes, portablePersonalLimits.notes) ||
    !array(value.collections, portablePersonalLimits.collections) ||
    !array(value.memberships, portablePersonalLimits.memberships) ||
    !array(value.manualItems, portablePersonalLimits.manualItems)
  )
    return false;
  if (
    !value.notes.every(
      (v) =>
        exact(v, ['noteId', 'recipeId', 'text', 'deleted', 'revision', 'createdAt', 'updatedAt']) &&
        id(v.noteId) &&
        recipe(v.recipeId) &&
        typeof v.deleted === 'boolean' &&
        positive(v.revision) &&
        dates(v) &&
        (v.deleted ? v.text === null : text(v.text, personalLimits.noteCharacters)),
    )
  )
    return false;
  if (
    !value.collections.every(
      (v) =>
        exact(v, ['collectionId', 'name', 'deleted', 'revision', 'createdAt', 'updatedAt']) &&
        id(v.collectionId) &&
        typeof v.deleted === 'boolean' &&
        positive(v.revision) &&
        dates(v) &&
        (v.deleted ? v.name === null : text(v.name, personalLimits.collectionNameCharacters)),
    )
  )
    return false;
  if (
    !value.memberships.every(
      (v) =>
        exact(v, ['collectionId', 'recipeId', 'present', 'revision', 'updatedAt']) &&
        id(v.collectionId) &&
        recipe(v.recipeId) &&
        typeof v.present === 'boolean' &&
        positive(v.revision) &&
        instant(v.updatedAt),
    )
  )
    return false;
  if (
    !value.manualItems.every(
      (v) =>
        exact(v, [
          'kind',
          'itemId',
          'name',
          'amountText',
          'unitText',
          'category',
          'purchased',
          'deleted',
          'revision',
          'createdAt',
          'updatedAt',
        ]) &&
        v.kind === 'manual' &&
        id(v.itemId) &&
        typeof v.purchased === 'boolean' &&
        typeof v.deleted === 'boolean' &&
        positive(v.revision) &&
        dates(v) &&
        (v.deleted
          ? v.name === null &&
            v.amountText === null &&
            v.unitText === null &&
            v.category === null &&
            !v.purchased
          : text(v.name, personalLimits.itemNameCharacters) &&
            (v.amountText === null || text(v.amountText, personalLimits.amountCharacters)) &&
            (v.unitText === null || text(v.unitText, personalLimits.unitCharacters)) &&
            manualShoppingCategories.includes(
              v.category as (typeof manualShoppingCategories)[number],
            )),
    )
  )
    return false;
  const data = value as unknown as PortablePersonalData;
  const collections = new Map(data.collections.map((v) => [v.collectionId, v]));
  return (
    unique(data.notes, (v) => v.noteId) &&
    unique(data.notes, (v) => v.recipeId) &&
    unique(data.collections, (v) => v.collectionId) &&
    unique(data.memberships, (v) => `${v.collectionId}/${v.recipeId}`) &&
    unique(data.manualItems, (v) => v.itemId) &&
    data.collections.filter((v) => !v.deleted).length <= personalLimits.collections &&
    data.manualItems.filter((v) => !v.deleted).length <= personalLimits.manualItems &&
    data.memberships.every(
      (v) =>
        collections.has(v.collectionId) &&
        (!v.present || !collections.get(v.collectionId)!.deleted),
    )
  );
}
export function portablePersonalCounts(
  data: Immutable<PortablePersonalData>,
): PortablePersonalCounts {
  return {
    notes: data.notes.filter((v) => !v.deleted).length,
    noteTombstones: data.notes.filter((v) => v.deleted).length,
    collections: data.collections.filter((v) => !v.deleted).length,
    collectionTombstones: data.collections.filter((v) => v.deleted).length,
    memberships: data.memberships.filter((v) => v.present).length,
    removedMemberships: data.memberships.filter((v) => !v.present).length,
    manualItems: data.manualItems.filter((v) => !v.deleted).length,
    manualTombstones: data.manualItems.filter((v) => v.deleted).length,
    purchasedManualItems: data.manualItems.filter((v) => v.purchased).length,
  };
}
export function validatePortablePersonalCounts(v: unknown): v is PortablePersonalCounts {
  return (
    exact(v, [
      'notes',
      'noteTombstones',
      'collections',
      'collectionTombstones',
      'memberships',
      'removedMemberships',
      'manualItems',
      'manualTombstones',
      'purchasedManualItems',
    ]) &&
    Object.values(v).every(count) &&
    (v.notes as number) + (v.noteTombstones as number) <= portablePersonalLimits.notes &&
    (v.collections as number) + (v.collectionTombstones as number) <=
      portablePersonalLimits.collections &&
    (v.collections as number) <= personalLimits.collections &&
    (v.memberships as number) + (v.removedMemberships as number) <=
      portablePersonalLimits.memberships &&
    (v.manualItems as number) + (v.manualTombstones as number) <=
      portablePersonalLimits.manualItems &&
    (v.manualItems as number) <= personalLimits.manualItems &&
    (v.purchasedManualItems as number) <= (v.manualItems as number)
  );
}
/** Data only. A history entry has no executable request or operation receipt. */
export function validatePortableHistoryEntry(v: unknown): v is CookingHistoryEntry {
  if (
    !object(v) ||
    !exact(v, [
      'recipeId',
      'catalogue',
      'contentFingerprint',
      'readerVersion',
      'eventId',
      'recipeTitle',
      'photoKey',
      'cookedOn',
      'timeZone',
      'recordedAt',
      'note',
      'historyEpoch',
      'revision',
      ...(Object.hasOwn(v, 'origin') ? ['origin'] : []),
    ]) ||
    !recipe(v.recipeId) ||
    !id(v.eventId) ||
    !exact(v.catalogue, ['version', 'fingerprint']) ||
    !text(v.catalogue.version, 200) ||
    !hash(v.catalogue.fingerprint) ||
    !hash(v.contentFingerprint) ||
    v.readerVersion !== 1 ||
    !text(v.recipeTitle, 1000) ||
    !text(v.photoKey, 300) ||
    typeof v.cookedOn !== 'string' ||
    !isActualLocalDate(v.cookedOn) ||
    !text(v.timeZone, 100) ||
    !instant(v.recordedAt) ||
    !count(v.historyEpoch) ||
    !positive(v.revision) ||
    !(
      v.note === null ||
      (typeof v.note === 'string' && [...v.note].length <= COOKING_NOTE_MAX_CHARACTERS)
    ) ||
    (Object.hasOwn(v, 'origin') && v.origin !== 'backup')
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: v.timeZone });
    return true;
  } catch {
    return false;
  }
}
export function validatePortableHistory(v: unknown): v is PortableCookingHistory {
  return (
    exact(v, ['entries']) &&
    array(v.entries, portablePersonalLimits.history) &&
    v.entries.every(validatePortableHistoryEntry) &&
    unique(v.entries, (entry) => entry.eventId)
  );
}
