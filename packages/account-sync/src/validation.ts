import {
  record,
  exact,
  text,
  matches,
  instant,
  list,
  distinct,
  uuidPattern,
  fingerprintPattern,
  recipePattern,
} from './validationPrimitives';
import { validateAccountPersonal, validateAccountHistory } from './expandedValidation';
const preferenceTypes = ['cuisine', 'ingredient_like', 'ingredient_avoid', 'dietary_style'];
import { isSupportedPlanDate, portableBackupByteLength } from '@cookmate/domain';
import {
  ACCOUNT_SNAPSHOT_FORMAT,
  ACCOUNT_SNAPSHOT_VERSION,
  ACCOUNT_EXPANDED_SNAPSHOT_VERSION,
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  accountSnapshotLimits,
  AccountSnapshotError,
} from './types';
import type { AccountSnapshot, AccountCookingHistory } from './types';

/** Structural and intrinsic references only. Recipe existence is checked by the current catalogue adapter. */
function validShape(value: unknown): value is AccountSnapshot {
  if (!record(value)) return false;
  const version = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  const expanded =
    version &&
    Object.hasOwn(version, 'value') &&
    version.value === ACCOUNT_EXPANDED_SNAPSHOT_VERSION;
  if (
    !exact(value, [
      'format',
      'schemaVersion',
      'catalogue',
      'favourites',
      'plan',
      'shopping',
      'preferences',
      'appPreferences',
      'profile',
      ...(expanded
        ? ['personal', ...(Object.hasOwn(value, 'cookingHistory') ? ['cookingHistory'] : [])]
        : []),
    ]) ||
    value.format !== ACCOUNT_SNAPSHOT_FORMAT ||
    !(
      value.schemaVersion === ACCOUNT_SNAPSHOT_VERSION ||
      value.schemaVersion === ACCOUNT_EXPANDED_SNAPSHOT_VERSION
    ) ||
    !exact(value.catalogue, ['version', 'fingerprint']) ||
    !text(value.catalogue.version, 80) ||
    !matches(value.catalogue.fingerprint, fingerprintPattern)
  )
    return false;
  if (
    expanded &&
    (!validateAccountPersonal(value.personal) ||
      (Object.hasOwn(value, 'cookingHistory') && !validateAccountHistory(value.cookingHistory)))
  )
    return false;
  if (
    !list(value.favourites, accountSnapshotLimits.favourites) ||
    !value.favourites.every(
      (item) =>
        exact(item, ['recipeId', 'savedAt']) &&
        matches(item.recipeId, recipePattern) &&
        instant(item.savedAt),
    )
  )
    return false;
  if (
    !list(value.plan, accountSnapshotLimits.plan) ||
    !value.plan.every(
      (item) =>
        exact(item, ['occurrenceId', 'recipeId', 'placement', 'createdAt', 'updatedAt']) &&
        matches(item.occurrenceId, uuidPattern) &&
        matches(item.recipeId, recipePattern) &&
        exact(item.placement, ['actualDate', 'mealKey']) &&
        typeof item.placement.actualDate === 'string' &&
        isSupportedPlanDate(item.placement.actualDate) &&
        ['breakfast', 'lunch', 'dinner'].includes(item.placement.mealKey as string) &&
        instant(item.createdAt) &&
        instant(item.updatedAt),
    )
  )
    return false;
  const shopping = value.shopping;
  if (
    !exact(shopping, ['selectedOccurrenceIds', 'purchaseMarks']) ||
    !list(shopping.selectedOccurrenceIds, accountSnapshotLimits.selectedOccurrences) ||
    !shopping.selectedOccurrenceIds.every((item) => matches(item, uuidPattern)) ||
    !list(shopping.purchaseMarks, accountSnapshotLimits.purchaseMarks) ||
    !shopping.purchaseMarks.every(
      (item) =>
        exact(item, ['groupKey', 'groupingVersion', 'demandFingerprint', 'purchased', 'changed']) &&
        matches(item.groupKey, fingerprintPattern) &&
        text(item.groupingVersion, 80) &&
        matches(item.demandFingerprint, fingerprintPattern) &&
        typeof item.purchased === 'boolean' &&
        typeof item.changed === 'boolean',
    )
  )
    return false;
  if (
    !list(value.preferences, accountSnapshotLimits.preferences) ||
    !value.preferences.every(
      (item) =>
        exact(item, ['preferenceId', 'type', 'value']) &&
        matches(item.preferenceId, uuidPattern) &&
        preferenceTypes.includes(item.type as string) &&
        text(item.value, 256),
    )
  )
    return false;
  if (
    !exact(value.appPreferences, ['theme', 'motion', 'locale']) ||
    !['system', 'light', 'dark'].includes(value.appPreferences.theme as string) ||
    !['system', 'reduced'].includes(value.appPreferences.motion as string) ||
    !['system', 'en', 'ar'].includes(value.appPreferences.locale as string) ||
    !exact(value.profile, ['displayName']) ||
    !(value.profile.displayName === null || text(value.profile.displayName, 120))
  )
    return false;
  const typed = value as unknown as AccountSnapshot;
  const ids = new Set(typed.plan.map((item) => item.occurrenceId));
  return (
    distinct(typed.favourites, (item) => item.recipeId) &&
    distinct(typed.plan, (item) => item.occurrenceId) &&
    distinct(typed.plan, (item) =>
      JSON.stringify([item.placement.actualDate, item.placement.mealKey]),
    ) &&
    distinct(typed.shopping.selectedOccurrenceIds, (item) => item) &&
    typed.shopping.selectedOccurrenceIds.every((id) => ids.has(id)) &&
    distinct(typed.shopping.purchaseMarks, (item) => item.groupKey) &&
    distinct(typed.preferences, (item) => item.preferenceId) &&
    distinct(typed.preferences, (item) => JSON.stringify([item.type, item.value]))
  );
}

export function assertAccountSnapshot(value: unknown): asserts value is AccountSnapshot {
  if (record(value)) {
    const format = Object.getOwnPropertyDescriptor(value, 'format');
    const version = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
    if (
      format &&
      version &&
      Object.hasOwn(format, 'value') &&
      Object.hasOwn(version, 'value') &&
      (format.value !== ACCOUNT_SNAPSHOT_FORMAT ||
        (version.value !== ACCOUNT_SNAPSHOT_VERSION &&
          version.value !== ACCOUNT_EXPANDED_SNAPSHOT_VERSION))
    )
      throw new AccountSnapshotError('unsupported_version');
  }
  if (!validShape(value)) throw new AccountSnapshotError('invalid_structure');
  if (portableBackupByteLength(JSON.stringify(value)) > ACCOUNT_SNAPSHOT_MAX_BYTES)
    throw new AccountSnapshotError('too_large');
}

export function validateAccountSnapshot(value: unknown): value is AccountSnapshot {
  try {
    assertAccountSnapshot(value);
    return true;
  } catch {
    return false;
  }
}

export function parseAccountSnapshot(serialized: string): AccountSnapshot {
  if (typeof serialized !== 'string') throw new AccountSnapshotError('invalid_structure');
  if (
    serialized.length > ACCOUNT_SNAPSHOT_MAX_BYTES ||
    portableBackupByteLength(serialized) > ACCOUNT_SNAPSHOT_MAX_BYTES
  )
    throw new AccountSnapshotError('too_large');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new AccountSnapshotError('invalid_json');
  }
  assertAccountSnapshot(value);
  return value;
}

/** Use only for bounded, validated JSON values. Object order never acts as a change clock. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Canonical data-only history for the owner-bound projection; no synthetic core snapshot. */
export function canonicalAccountHistory(history: AccountCookingHistory): string {
  if (!validateAccountHistory(history)) throw new AccountSnapshotError('invalid_structure');
  const serialized = canonicalJson({
    entries: [...history.entries].sort((a, b) => compare(a.eventId, b.eventId)),
    removedEventIds: [...history.removedEventIds].sort(compare),
  });
  if (portableBackupByteLength(serialized) > ACCOUNT_SNAPSHOT_MAX_BYTES)
    throw new AccountSnapshotError('too_large');
  return serialized;
}
export function normalizeAccountSnapshot<T extends AccountSnapshot>(snapshot: T): T {
  assertAccountSnapshot(snapshot);
  const value = JSON.parse(JSON.stringify(snapshot)) as T;
  value.favourites.sort((a, b) => compare(a.recipeId, b.recipeId));
  value.plan.sort((a, b) => compare(a.occurrenceId, b.occurrenceId));
  value.shopping.selectedOccurrenceIds.sort(compare);
  value.shopping.purchaseMarks.sort((a, b) => compare(a.groupKey, b.groupKey));
  value.preferences.sort((a, b) => compare(a.preferenceId, b.preferenceId));
  if (value.schemaVersion === ACCOUNT_EXPANDED_SNAPSHOT_VERSION) {
    value.personal.notes.sort((a, b) => compare(a.recipeId, b.recipeId));
    value.personal.collections.sort((a, b) => compare(a.collectionId, b.collectionId));
    value.personal.memberships.sort(
      (a, b) => compare(a.collectionId, b.collectionId) || compare(a.recipeId, b.recipeId),
    );
    value.personal.manualItems.sort((a, b) => compare(a.itemId, b.itemId));
    value.cookingHistory?.entries.sort((a, b) => compare(a.eventId, b.eventId));
    value.cookingHistory?.removedEventIds.sort(compare);
  }
  return value;
}
export function canonicalAccountSnapshot(snapshot: AccountSnapshot): string {
  return canonicalJson(normalizeAccountSnapshot(snapshot));
}
export function accountSnapshotsEqual(left: AccountSnapshot, right: AccountSnapshot): boolean {
  return canonicalAccountSnapshot(left) === canonicalAccountSnapshot(right);
}
