import type { CatalogueIdentity } from '@cookmate/contracts';
import type { Immutable, PortableBackupEnvelope } from '@cookmate/domain';
import { ACCOUNT_SNAPSHOT_FORMAT, ACCOUNT_SNAPSHOT_VERSION, AccountSnapshotError } from './types';
import type {
  AccountSnapshot,
  AccountSnapshotV1,
  AccountSnapshotV2,
  AccountSnapshotOptions,
  AccountExpandedAdapterOptions,
} from './types';
import { normalizeAccountSnapshot } from './validation';

export function emptyAccountSnapshot(
  catalogue: Readonly<CatalogueIdentity>,
  options: AccountSnapshotOptions,
): AccountSnapshotV1 {
  return normalizeAccountSnapshot({
    format: ACCOUNT_SNAPSHOT_FORMAT,
    schemaVersion: ACCOUNT_SNAPSHOT_VERSION,
    catalogue: { version: catalogue.version, fingerprint: catalogue.fingerprint },
    favourites: [],
    plan: [],
    shopping: { selectedOccurrenceIds: [], purchaseMarks: [] },
    preferences: [],
    appPreferences: {
      theme: options.appPreferences.theme,
      motion: options.appPreferences.motion,
      locale: options.appPreferences.locale,
    },
    profile: { displayName: options.profile.displayName },
  });
}

/** Accept a trusted local export or an already inspected backup; this does not authenticate backup checksums. */
export function accountSnapshotFromBackup(
  backup: Immutable<PortableBackupEnvelope>,
  options: AccountSnapshotOptions,
): AccountSnapshotV1;
export function accountSnapshotFromBackup(
  backup: Immutable<PortableBackupEnvelope>,
  options: AccountSnapshotOptions,
  expanded: AccountExpandedAdapterOptions,
): AccountSnapshotV2;
export function accountSnapshotFromBackup(
  backup: Immutable<PortableBackupEnvelope>,
  options: AccountSnapshotOptions,
  expanded?: AccountExpandedAdapterOptions,
): AccountSnapshot {
  const snapshot = emptyAccountSnapshot(backup.catalogue, options);
  snapshot.favourites = backup.data.favourites
    .filter((item) => item.saved)
    .map((item) => ({ recipeId: item.recipeId, savedAt: item.savedAt }));
  snapshot.plan = backup.data.occurrences.map((item) => ({
    occurrenceId: item.occurrenceId,
    recipeId: item.recipeId,
    placement: { actualDate: item.placement.actualDate, mealKey: item.placement.mealKey },
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
  snapshot.shopping.selectedOccurrenceIds = [...backup.data.shopping.scope.occurrenceIds];
  // Dormant groups are device-local safety history, not current shopping demand.
  snapshot.shopping.purchaseMarks = backup.data.shopping.purchaseMarks
    .filter((item) => item.projectionRevision === backup.data.shopping.projectionRevision)
    .map((item) => {
      const current =
        backup.data.shopping.projectionStatus === 'current' &&
        item.projectionRevision === backup.data.shopping.projectionRevision;
      return {
        groupKey: item.groupKey,
        groupingVersion: item.groupingVersion,
        demandFingerprint: item.demandFingerprint,
        purchased: current && item.purchased,
        changed: !current || item.changed,
      };
    });
  snapshot.preferences = backup.data.preferences.snapshot.items.map((item) => ({
    preferenceId: item.preferenceId,
    type: item.type,
    value: item.value,
  }));
  if (!expanded) return normalizeAccountSnapshot(snapshot);
  if (
    expanded.schemaVersion !== 2 ||
    typeof expanded.includeCookingHistory !== 'boolean' ||
    backup.schemaVersion !== 2 ||
    !backup.data.personal ||
    (expanded.includeCookingHistory && !backup.data.cookingHistory) ||
    (!expanded.includeCookingHistory && expanded.removedHistoryEventIds !== undefined)
  )
    throw new AccountSnapshotError('invalid_structure');
  const personal = backup.data.personal;
  const value: AccountSnapshotV2 = {
    ...snapshot,
    schemaVersion: 2,
    personal: {
      notes: personal.notes.map((item) => ({
        noteId: item.noteId,
        recipeId: item.recipeId,
        text: item.text,
        deleted: item.deleted,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      collections: personal.collections.map((item) => ({
        collectionId: item.collectionId,
        name: item.name,
        deleted: item.deleted,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      memberships: personal.memberships.map((item) => ({
        collectionId: item.collectionId,
        recipeId: item.recipeId,
        present: item.present,
        updatedAt: item.updatedAt,
      })),
      manualItems: personal.manualItems.map((item) => ({
        kind: item.kind,
        itemId: item.itemId,
        name: item.name,
        amountText: item.amountText,
        unitText: item.unitText,
        category: item.category,
        purchased: item.purchased,
        deleted: item.deleted,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    },
  };
  if (expanded.includeCookingHistory) {
    const removedEventIds = [...(expanded.removedHistoryEventIds ?? [])];
    const removed = new Set(removedEventIds);
    value.cookingHistory = {
      entries: backup.data
        .cookingHistory!.entries.filter((item) => !removed.has(item.eventId))
        .map((item) => ({
          eventId: item.eventId,
          recipeId: item.recipeId,
          catalogue: { version: item.catalogue.version, fingerprint: item.catalogue.fingerprint },
          contentFingerprint: item.contentFingerprint,
          readerVersion: item.readerVersion,
          ...(item.origin === undefined ? {} : { origin: item.origin }),
          recipeTitle: item.recipeTitle,
          photoKey: item.photoKey,
          cookedOn: item.cookedOn,
          timeZone: item.timeZone,
          recordedAt: item.recordedAt,
          note: item.note,
        })),
      removedEventIds,
    };
  }
  return normalizeAccountSnapshot(value);
}
