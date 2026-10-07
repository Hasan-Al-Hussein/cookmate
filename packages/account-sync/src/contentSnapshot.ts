import {
  isActualLocalDate,
  validateRecipeContentRef,
  type RecipeContentRef,
} from '@cookmate/contracts';
import {
  COOKING_NOTE_MAX_CHARACTERS,
  PORTABLE_BACKUP_MAX_BYTES,
  portableBackupByteLength,
  portablePersonalLimits,
  type Immutable,
  type PortableBackupHash,
} from '@cookmate/domain';
import {
  canonicalPortableContentJson,
  validatePortableContentBackup,
  type PortableContentBackupEnvelope,
  type PortableExactHistoryEntry,
} from '../../domain/src/portableBackupContent';
import { validateAccountCookingHistoryEntry } from './expandedValidation';
import { assertAccountSnapshot, normalizeAccountSnapshot } from './validation';
import { exact, instant, list, matches, text, uuidPattern, distinct } from './validationPrimitives';
import {
  ACCOUNT_SNAPSHOT_FORMAT,
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  AccountSnapshotError,
  type AccountSnapshotFailure,
  type AccountSnapshotOptions,
  type AccountSnapshotV1,
  type AccountSnapshotV2,
  type AccountCookingHistoryEntry,
} from './types';

/** Private codec only: deliberately absent from the active AccountSnapshot union and package index. */
export const ACCOUNT_CONTENT_SNAPSHOT_VERSION = 3;
export type AccountExactCookingHistoryEntry = Omit<
  PortableExactHistoryEntry,
  'revision' | 'historyEpoch'
>;
export type AccountContentHistoryRecord =
  | {
      kind: 'legacy';
      entry: AccountCookingHistoryEntry;
      pin:
        | { kind: 'exact'; ref: RecipeContentRef }
        | {
            kind: 'unresolved';
            reason: 'catalogue_mismatch' | 'content_mismatch' | 'recipe_unavailable';
          };
    }
  | { kind: 'exact'; entry: AccountExactCookingHistoryEntry };
export interface AccountContentCookingHistory {
  entries: AccountContentHistoryRecord[];
  removedEventIds: string[];
}
export interface AccountContentSnapshot extends Omit<
  AccountSnapshotV2,
  'schemaVersion' | 'cookingHistory'
> {
  schemaVersion: typeof ACCOUNT_CONTENT_SNAPSHOT_VERSION;
  planReferences: { occurrenceId: string; contentRef: RecipeContentRef }[];
  cookingHistory?: AccountContentCookingHistory;
}
/** Conversion choices only. Neither these flags nor a backup checksum establish consent or trust. */
export interface AccountContentAdapterOptions {
  schemaVersion: 3;
  includeCookingHistory: boolean;
  removedHistoryEventIds?: readonly string[];
}
function fail(reason: AccountSnapshotFailure = 'invalid_structure'): never {
  throw new AccountSnapshotError(reason);
}
const requireData: (condition: unknown) => asserts condition = (condition) => {
  if (!condition) fail();
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function freeze<Value>(value: Value): Immutable<Value> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Immutable<Value>;
}
function bounded(value: unknown, maximumBytes = ACCOUNT_SNAPSHOT_MAX_BYTES): string {
  try {
    return canonicalPortableContentJson(value, maximumBytes);
  } catch (error) {
    if (error instanceof Error && 'reason' in error && error.reason === 'too_large')
      fail('too_large');
    return fail();
  }
}
function ref(value: unknown): value is RecipeContentRef {
  return (
    exact(value, ['recipeId', 'revisionId', 'contentFingerprint']) &&
    validateRecipeContentRef(value)
  );
}
export function validateAccountExactCookingHistoryEntry(
  value: unknown,
): value is AccountExactCookingHistoryEntry {
  if (
    !exact(value, [
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
    ]) ||
    value.readerVersion !== 2 ||
    !ref(value.contentRef) ||
    value.recipeId !== value.contentRef.recipeId ||
    !matches(value.eventId, uuidPattern) ||
    !text(value.recipeTitle, 1000) ||
    !(value.photoAssetId === null || matches(value.photoAssetId, /^sha256:[0-9a-f]{64}$/)) ||
    typeof value.cookedOn !== 'string' ||
    !isActualLocalDate(value.cookedOn) ||
    !text(value.timeZone, 100) ||
    !instant(value.recordedAt) ||
    !(
      value.note === null ||
      (typeof value.note === 'string' && [...value.note].length <= COOKING_NOTE_MAX_CHARACTERS)
    )
  )
    return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timeZone });
    return true;
  } catch {
    return false;
  }
}
function historyRecord(value: unknown): value is AccountContentHistoryRecord {
  if (exact(value, ['kind', 'entry']) && value.kind === 'exact')
    return validateAccountExactCookingHistoryEntry(value.entry);
  if (
    !exact(value, ['kind', 'entry', 'pin']) ||
    value.kind !== 'legacy' ||
    !validateAccountCookingHistoryEntry(value.entry)
  )
    return false;
  return (
    (exact(value.pin, ['kind', 'ref']) &&
      value.pin.kind === 'exact' &&
      ref(value.pin.ref) &&
      value.pin.ref.recipeId === value.entry.recipeId) ||
    (exact(value.pin, ['kind', 'reason']) &&
      value.pin.kind === 'unresolved' &&
      ['catalogue_mismatch', 'content_mismatch', 'recipe_unavailable'].includes(
        value.pin.reason as string,
      ))
  );
}
function history(value: unknown): value is AccountContentCookingHistory {
  if (
    !exact(value, ['entries', 'removedEventIds']) ||
    !list(value.entries, portablePersonalLimits.history) ||
    !value.entries.every(historyRecord) ||
    !list(value.removedEventIds, portablePersonalLimits.history) ||
    !value.removedEventIds.every((item) => matches(item, uuidPattern))
  )
    return false;
  const removed = new Set(value.removedEventIds);
  return (
    distinct(value.entries, (item) => item.entry.eventId) &&
    distinct(value.removedEventIds, (item) => item as string) &&
    value.entries.every((item) => !removed.has(item.entry.eventId))
  );
}

/** Bounded data-only history for the private exact-content path; no receipt or sync authority. */
export function normalizeAccountContentCookingHistory(
  input: unknown,
): Immutable<AccountContentCookingHistory> {
  const value: unknown = JSON.parse(bounded(input));
  requireData(history(value));
  value.entries.sort((a, b) => compare(a.entry.eventId, b.entry.eventId));
  value.removedEventIds.sort(compare);
  return freeze(value);
}

/** Own bounded inert data before any validator or clone; no getters/toJSON execute. */
export function normalizeAccountContentSnapshot(input: unknown): Immutable<AccountContentSnapshot> {
  const value: unknown = JSON.parse(bounded(input));
  requireData(value && typeof value === 'object' && !Array.isArray(value));
  if (
    ('schemaVersion' in value && value.schemaVersion !== 3) ||
    ('format' in value && value.format !== ACCOUNT_SNAPSHOT_FORMAT)
  )
    fail('unsupported_version');
  requireData(
    exact(value, [
      'format',
      'schemaVersion',
      'catalogue',
      'favourites',
      'plan',
      'shopping',
      'preferences',
      'appPreferences',
      'profile',
      'personal',
      'planReferences',
      ...(Object.hasOwn(value, 'cookingHistory') ? ['cookingHistory'] : []),
    ]),
  );
  requireData(value.schemaVersion === 3 && value.format === ACCOUNT_SNAPSHOT_FORMAT);
  const { planReferences, cookingHistory, ...core } = value;
  // Reuse the complete existing core/personal contract, not a second replica of its validators.
  const legacyCore = { ...core, schemaVersion: 2 };
  assertAccountSnapshot(legacyCore);
  requireData(legacyCore.schemaVersion === 2);
  const normalized = normalizeAccountSnapshot(legacyCore);
  requireData(
    list(planReferences, normalized.plan.length) &&
      planReferences.length === normalized.plan.length,
  );
  const planned = new Map(normalized.plan.map((item) => [item.occurrenceId, item.recipeId]));
  const seen = new Set<string>();
  for (const row of planReferences) {
    requireData(
      exact(row, ['occurrenceId', 'contentRef']) &&
        matches(row.occurrenceId, uuidPattern) &&
        ref(row.contentRef) &&
        !seen.has(row.occurrenceId) &&
        planned.get(row.occurrenceId) === row.contentRef.recipeId,
    );
    seen.add(row.occurrenceId);
  }
  if (Object.hasOwn(value, 'cookingHistory')) requireData(history(cookingHistory));
  const { cookingHistory: _legacyHistory, ...normalizedCore } = normalized;
  const result: AccountContentSnapshot = {
    ...normalizedCore,
    schemaVersion: 3,
    planReferences: planReferences as AccountContentSnapshot['planReferences'],
    ...(Object.hasOwn(value, 'cookingHistory')
      ? { cookingHistory: cookingHistory as AccountContentCookingHistory }
      : {}),
  };
  result.planReferences.sort((a, b) => compare(a.occurrenceId, b.occurrenceId));
  result.cookingHistory?.entries.sort((a, b) => compare(a.entry.eventId, b.entry.eventId));
  result.cookingHistory?.removedEventIds.sort(compare);
  return freeze(result);
}
export function validateAccountContentSnapshot(value: unknown): value is AccountContentSnapshot {
  try {
    normalizeAccountContentSnapshot(value);
    return true;
  } catch {
    return false;
  }
}
export function canonicalAccountContentSnapshot(value: unknown): string {
  return bounded(normalizeAccountContentSnapshot(value));
}
export function parseAccountContentSnapshot(serialized: string): Immutable<AccountContentSnapshot> {
  if (typeof serialized !== 'string') fail();
  if (
    serialized.length > ACCOUNT_SNAPSHOT_MAX_BYTES ||
    portableBackupByteLength(serialized) > ACCOUNT_SNAPSHOT_MAX_BYTES
  )
    fail('too_large');
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail('invalid_json');
  }
  return normalizeAccountContentSnapshot(value);
}

/** Data conversion only; source integrity checks do not authenticate any referenced recipe. */
export async function accountContentSnapshotFromBackup(
  backup: Immutable<PortableContentBackupEnvelope>,
  settings: AccountSnapshotOptions,
  choices: AccountContentAdapterOptions,
  sha256: PortableBackupHash,
): Promise<Immutable<AccountContentSnapshot>> {
  // Own all caller values synchronously, including choices/settings, before the checksum await.
  const sourceBytes = bounded(backup, PORTABLE_BACKUP_MAX_BYTES);
  const ownedSettings: unknown = JSON.parse(bounded(settings));
  requireData(exact(ownedSettings, ['appPreferences', 'profile']));
  const ownedChoices: unknown = JSON.parse(bounded(choices));
  requireData(
    exact(ownedChoices, [
      'schemaVersion',
      'includeCookingHistory',
      ...(ownedChoices &&
      typeof ownedChoices === 'object' &&
      Object.hasOwn(ownedChoices, 'removedHistoryEventIds')
        ? ['removedHistoryEventIds']
        : []),
    ]) &&
      ownedChoices.schemaVersion === 3 &&
      typeof ownedChoices.includeCookingHistory === 'boolean',
  );
  const removed = ownedChoices.removedHistoryEventIds ?? [];
  requireData(
    list(removed, portablePersonalLimits.history) &&
      removed.every((value) => matches(value, uuidPattern)) &&
      distinct(removed, (item) => item as string) &&
      (ownedChoices.includeCookingHistory ||
        !Object.hasOwn(ownedChoices, 'removedHistoryEventIds')),
  );
  const inspected = await validatePortableContentBackup(sourceBytes, { sha256 });
  if (inspected.kind !== 'ready')
    fail(inspected.reason === 'too_large' ? 'too_large' : 'invalid_structure');
  const source = inspected.value,
    data = source.data;
  requireData(!ownedChoices.includeCookingHistory || data.cookingHistory);
  const coreInput = {
    format: ACCOUNT_SNAPSHOT_FORMAT,
    schemaVersion: 1,
    catalogue: source.catalogue,
    favourites: [],
    plan: [],
    preferences: [],
    shopping: { selectedOccurrenceIds: [], purchaseMarks: [] },
    ...ownedSettings,
  };
  assertAccountSnapshot(coreInput);
  requireData(coreInput.schemaVersion === 1);
  const core: AccountSnapshotV1 = normalizeAccountSnapshot(coreInput);
  core.favourites = data.favourites
    .filter((item) => item.saved)
    .map(({ recipeId, savedAt }) => ({ recipeId, savedAt }));
  core.plan = data.occurrences.map(({ revision: _revision, ...item }) => ({
    ...item,
    placement: { ...item.placement },
  }));
  core.preferences = data.preferences.snapshot.items.map(({ revision: _revision, ...item }) => ({
    ...item,
  }));
  core.shopping.selectedOccurrenceIds = [...data.shopping.scope.occurrenceIds];
  core.shopping.purchaseMarks = data.shopping.purchaseMarks
    .filter((item) => item.projectionRevision === data.shopping.projectionRevision)
    .map(({ projectionRevision: _projection, revision: _revision, ...item }) => ({
      ...item,
      purchased: data.shopping.projectionStatus === 'current' && item.purchased,
      changed: data.shopping.projectionStatus !== 'current' || item.changed,
    }));
  const personal = {
    notes: data.personal.notes.map(({ revision: _revision, ...item }) => ({ ...item })),
    collections: data.personal.collections.map(({ revision: _revision, ...item }) => ({ ...item })),
    memberships: data.personal.memberships.map(({ revision: _revision, ...item }) => ({ ...item })),
    manualItems: data.personal.manualItems.map(({ revision: _revision, ...item }) => ({ ...item })),
  };
  const removedIds = new Set(removed);
  const entries = ownedChoices.includeCookingHistory
    ? data
        .cookingHistory!.entries.filter((row) => !removedIds.has(row.entry.eventId))
        .map((row) => {
          const { revision: _revision, historyEpoch: _epoch, ...entry } = row.entry;
          return row.kind === 'exact'
            ? { kind: 'exact' as const, entry }
            : { kind: 'legacy' as const, entry, pin: row.pin };
        })
    : undefined;
  return normalizeAccountContentSnapshot({
    ...core,
    schemaVersion: 3,
    personal,
    planReferences: data.planReferences,
    ...(entries === undefined ? {} : { cookingHistory: { entries, removedEventIds: removed } }),
  });
}
