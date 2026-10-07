import { isActualLocalDate } from '@cookmate/contracts';
import {
  COOKING_NOTE_MAX_CHARACTERS,
  manualShoppingCategories,
  personalLimits,
  portablePersonalLimits,
} from '@cookmate/domain';
import type {
  AccountPersonalData,
  AccountCookingHistory,
  AccountCookingHistoryEntry,
} from './types';
import {
  record,
  exact,
  matches,
  instant,
  list,
  distinct,
  uuidPattern,
  recipePattern,
  fingerprintPattern,
} from './validationPrimitives';

const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && [...value].length <= maximum;
const dates = (value: Record<string, unknown>) =>
  instant(value.createdAt) && instant(value.updatedAt);

export function validateAccountPersonal(value: unknown): value is AccountPersonalData {
  if (
    !exact(value, ['notes', 'collections', 'memberships', 'manualItems']) ||
    !list(value.notes, portablePersonalLimits.notes) ||
    !list(value.collections, portablePersonalLimits.collections) ||
    !list(value.memberships, portablePersonalLimits.memberships) ||
    !list(value.manualItems, portablePersonalLimits.manualItems)
  )
    return false;
  if (
    !value.notes.every(
      (item) =>
        exact(item, ['noteId', 'recipeId', 'text', 'deleted', 'createdAt', 'updatedAt']) &&
        matches(item.noteId, uuidPattern) &&
        matches(item.recipeId, recipePattern) &&
        typeof item.deleted === 'boolean' &&
        dates(item) &&
        (item.deleted ? item.text === null : text(item.text, personalLimits.noteCharacters)),
    )
  )
    return false;
  if (
    !value.collections.every(
      (item) =>
        exact(item, ['collectionId', 'name', 'deleted', 'createdAt', 'updatedAt']) &&
        matches(item.collectionId, uuidPattern) &&
        typeof item.deleted === 'boolean' &&
        dates(item) &&
        (item.deleted
          ? item.name === null
          : text(item.name, personalLimits.collectionNameCharacters)),
    )
  )
    return false;
  if (
    !value.memberships.every(
      (item) =>
        exact(item, ['collectionId', 'recipeId', 'present', 'updatedAt']) &&
        matches(item.collectionId, uuidPattern) &&
        matches(item.recipeId, recipePattern) &&
        typeof item.present === 'boolean' &&
        instant(item.updatedAt),
    )
  )
    return false;
  if (
    !value.manualItems.every(
      (item) =>
        exact(item, [
          'kind',
          'itemId',
          'name',
          'amountText',
          'unitText',
          'category',
          'purchased',
          'deleted',
          'createdAt',
          'updatedAt',
        ]) &&
        item.kind === 'manual' &&
        matches(item.itemId, uuidPattern) &&
        typeof item.deleted === 'boolean' &&
        typeof item.purchased === 'boolean' &&
        dates(item) &&
        (item.deleted
          ? item.name === null &&
            item.amountText === null &&
            item.unitText === null &&
            item.category === null &&
            !item.purchased
          : text(item.name, personalLimits.itemNameCharacters) &&
            (item.amountText === null || text(item.amountText, personalLimits.amountCharacters)) &&
            (item.unitText === null || text(item.unitText, personalLimits.unitCharacters)) &&
            manualShoppingCategories.includes(
              item.category as (typeof manualShoppingCategories)[number],
            )),
    )
  )
    return false;
  const data = value as unknown as AccountPersonalData;
  const collections = new Map(data.collections.map((item) => [item.collectionId, item]));
  return (
    distinct(data.notes, (item) => item.noteId) &&
    distinct(data.notes, (item) => item.recipeId) &&
    distinct(data.collections, (item) => item.collectionId) &&
    distinct(data.memberships, (item) => `${item.collectionId}/${item.recipeId}`) &&
    distinct(data.manualItems, (item) => item.itemId) &&
    data.collections.filter((item) => !item.deleted).length <= personalLimits.collections &&
    data.manualItems.filter((item) => !item.deleted).length <= personalLimits.manualItems &&
    data.memberships.every(
      (item) =>
        collections.has(item.collectionId) &&
        (!item.present || !collections.get(item.collectionId)!.deleted),
    )
  );
}

export function validateAccountCookingHistoryEntry(
  value: unknown,
): value is AccountCookingHistoryEntry {
  if (
    !record(value) ||
    !exact(value, [
      'eventId',
      'recipeId',
      'catalogue',
      'contentFingerprint',
      'readerVersion',
      'recipeTitle',
      'photoKey',
      'cookedOn',
      'timeZone',
      'recordedAt',
      'note',
      ...(Object.hasOwn(value, 'origin') ? ['origin'] : []),
    ]) ||
    !matches(value.eventId, uuidPattern) ||
    !matches(value.recipeId, recipePattern) ||
    !exact(value.catalogue, ['version', 'fingerprint']) ||
    !text(value.catalogue.version, 200) ||
    !matches(value.catalogue.fingerprint, fingerprintPattern) ||
    !matches(value.contentFingerprint, fingerprintPattern) ||
    value.readerVersion !== 1 ||
    !text(value.recipeTitle, 1000) ||
    !text(value.photoKey, 300) ||
    typeof value.cookedOn !== 'string' ||
    !isActualLocalDate(value.cookedOn) ||
    !text(value.timeZone, 100) ||
    !instant(value.recordedAt) ||
    !(
      value.note === null ||
      (typeof value.note === 'string' && [...value.note].length <= COOKING_NOTE_MAX_CHARACTERS)
    ) ||
    (Object.hasOwn(value, 'origin') && value.origin !== 'backup')
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timeZone });
    return true;
  } catch {
    return false;
  }
}

export function validateAccountHistory(value: unknown): value is AccountCookingHistory {
  if (
    !exact(value, ['entries', 'removedEventIds']) ||
    !list(value.entries, portablePersonalLimits.history) ||
    !value.entries.every(validateAccountCookingHistoryEntry) ||
    !list(value.removedEventIds, portablePersonalLimits.history) ||
    !value.removedEventIds.every((item) => matches(item, uuidPattern))
  )
    return false;
  const removed = new Set(value.removedEventIds);
  return (
    distinct(value.entries, (item) => item.eventId) &&
    distinct(value.removedEventIds, (item) => item as string) &&
    value.entries.every((item) => !removed.has(item.eventId))
  );
}
