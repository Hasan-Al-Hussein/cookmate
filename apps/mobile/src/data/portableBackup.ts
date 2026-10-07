import { catalogueMatches } from '@cookmate/contracts';
import type { CatalogueIdentity, PlanOccurrence, PreferenceSnapshot } from '@cookmate/contracts';
import {
  createPortableBackup,
  PortableBackupError,
  portableBackupLimits,
  portablePersonalLimits,
} from '@cookmate/domain';
import type {
  CookMateQueries,
  PortableBackupData,
  PortableBackupHash,
  PortableFavourite,
  PortablePreferenceRemoval,
  PortablePurchaseMark,
} from '@cookmate/domain';
import { readRevision, readSnapshot } from './query';
import { StorageFault } from './sql';
import type { SerializedReader, SqlSession } from './sql';
import { decodeStoredText } from './storedText';
import { readCookingHistoryForBackup } from './cookingRepository';
import {
  noteColumns,
  collectionColumns,
  membershipColumns,
  manualColumns,
  parseNote,
  parseCollection,
  parseMembership,
  parseManual,
} from './personalRecords';
import type { NoteRow, CollectionRow, MembershipRow, ManualRow } from './personalRecords';

function requireStored(condition: boolean): asserts condition {
  if (!condition) throw new StorageFault('storage_failure', 'Backup source data is invalid');
}

export async function readBackupData(
  session: SqlSession,
  expanded = false,
  includeCookingHistory = false,
): Promise<PortableBackupData> {
  const favourites = await session.all<Omit<PortableFavourite, 'saved'> & { saved: number }>(
    `SELECT recipe_id AS recipeId, saved, revision, saved_at AS savedAt, updated_at AS updatedAt
     FROM favourite ORDER BY recipe_id LIMIT ${portableBackupLimits.favourites + 1}`,
  );
  requireStored(favourites.every((item) => item.saved === 0 || item.saved === 1));
  const occurrences = await session.all<
    Omit<PlanOccurrence, 'placement'> & {
      actualDate: string;
      mealKey: PlanOccurrence['placement']['mealKey'];
    }
  >(
    `SELECT occurrence_id AS occurrenceId, recipe_id AS recipeId, local_date AS actualDate,
       meal_key AS mealKey, revision, created_at AS createdAt, updated_at AS updatedAt
     FROM plan_occurrence ORDER BY local_date, meal_key, occurrence_id
     LIMIT ${portableBackupLimits.occurrences + 1}`,
  );
  const scopes = await session.all<{
    scopeId: string;
    revision: number;
    projectionRevision: number;
    projectionStatus: 'current' | 'pending';
  }>(
    `SELECT scope_id AS scopeId, revision, projection_revision AS projectionRevision,
       projection_status AS projectionStatus FROM shopping_scope WHERE singleton=1 LIMIT 2`,
  );
  requireStored(scopes.length === 1);
  const scope = scopes[0]!;
  const selections = await session.all<{ occurrenceId: string }>(
    `SELECT occurrence_id AS occurrenceId FROM shopping_selection WHERE scope_id=?
     ORDER BY occurrence_id LIMIT ${portableBackupLimits.selectedOccurrences + 1}`,
    [scope.scopeId],
  );
  const marks = await session.all<
    Omit<PortablePurchaseMark, 'purchased' | 'changed'> & {
      purchased: number;
      changed: number;
      groupFingerprint: string;
    }
  >(
    `SELECT p.group_key AS groupKey, g.grouping_version AS groupingVersion,
       p.demand_fingerprint AS demandFingerprint, g.demand_fingerprint AS groupFingerprint,
       g.projection_revision AS projectionRevision, p.purchased, p.changed, p.revision
     FROM purchase_state p LEFT JOIN shopping_group g
       ON p.scope_id=g.scope_id AND p.group_key=g.group_key
     WHERE p.scope_id=? ORDER BY p.group_key LIMIT ${portableBackupLimits.purchaseMarks + 1}`,
    [scope.scopeId],
  );
  requireStored(
    marks.every(
      (item) =>
        [0, 1].includes(item.purchased) &&
        [0, 1].includes(item.changed) &&
        item.demandFingerprint === item.groupFingerprint,
    ),
  );
  const preferenceState = await session.all<{ lastRemovalRevision: number | null }>(
    'SELECT last_removal_revision AS lastRemovalRevision FROM preference_state WHERE singleton=1 LIMIT 2',
  );
  requireStored(preferenceState.length === 1);
  const preferences = await session.all<PreferenceSnapshot['items'][number]>(
    `SELECT preference_id AS preferenceId, type, value, revision FROM saved_preference
     ORDER BY preference_id LIMIT ${portableBackupLimits.preferences + 1}`,
  );
  const removals = await session.all<PortablePreferenceRemoval>(
    `SELECT DISTINCT preference_id AS preferenceId, type, value,
       saved_revision AS savedRevision, removed_revision AS removedRevision
     FROM source_preference_link WHERE removed_revision IS NOT NULL
     ORDER BY preference_id, saved_revision, removed_revision, type, value
     LIMIT ${portableBackupLimits.preferenceRemovals + 1}`,
  );
  return {
    ...(expanded
      ? {
          personal: {
            notes: (
              await session.all<NoteRow>(
                `SELECT ${noteColumns} FROM recipe_note ORDER BY note_id LIMIT ${portablePersonalLimits.notes + 1}`,
              )
            ).map(parseNote),
            collections: (
              await session.all<CollectionRow>(
                `SELECT ${collectionColumns} FROM personal_collection ORDER BY collection_id LIMIT ${portablePersonalLimits.collections + 1}`,
              )
            ).map(parseCollection),
            memberships: (
              await session.all<MembershipRow>(
                `SELECT ${membershipColumns} FROM personal_collection_member ORDER BY collection_id,recipe_id LIMIT ${portablePersonalLimits.memberships + 1}`,
              )
            ).map(parseMembership),
            manualItems: (
              await session.all<ManualRow>(
                `SELECT ${manualColumns} FROM manual_shopping_item ORDER BY item_id LIMIT ${portablePersonalLimits.manualItems + 1}`,
              )
            ).map(parseManual),
          },
        }
      : {}),
    ...(includeCookingHistory
      ? { cookingHistory: { entries: await readCookingHistoryForBackup(session) } }
      : {}),
    favourites: favourites.map((item) => ({
      recipeId: item.recipeId,
      saved: item.saved === 1,
      revision: item.revision,
      savedAt: item.savedAt,
      updatedAt: item.updatedAt,
    })),
    occurrences: occurrences.map((item) => ({
      occurrenceId: item.occurrenceId,
      recipeId: item.recipeId,
      placement: { actualDate: item.actualDate, mealKey: item.mealKey },
      revision: item.revision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    shopping: {
      scope: {
        scopeId: scope.scopeId,
        revision: scope.revision,
        occurrenceIds: selections.map((item) => item.occurrenceId),
      },
      projectionRevision: scope.projectionRevision,
      projectionStatus: scope.projectionStatus,
      purchaseMarks: marks.map((item) => ({
        groupKey: item.groupKey,
        groupingVersion: item.groupingVersion,
        demandFingerprint: item.demandFingerprint,
        projectionRevision: item.projectionRevision,
        purchased: item.purchased === 1,
        changed: item.changed === 1,
        revision: item.revision,
      })),
    },
    preferences: {
      snapshot: {
        revision: await readRevision(session, 'preferences'),
        lastRemovalRevision: preferenceState[0]!.lastRemovalRevision,
        items: preferences.map((item) => ({
          preferenceId: item.preferenceId,
          type: item.type,
          value: decodeStoredText(item.value),
          revision: item.revision,
        })),
      },
      removals: removals.map((item) => ({
        preferenceId: item.preferenceId,
        type: item.type,
        value: decodeStoredText(item.value),
        savedRevision: item.savedRevision,
        removedRevision: item.removedRevision,
      })),
    },
  };
}

/** An allowlisted, read-only snapshot; hashing runs after releasing the database transaction. */
export function createPortableBackupReader(
  reader: SerializedReader,
  options: { catalogue: Readonly<CatalogueIdentity>; sha256: PortableBackupHash; now(): string },
): CookMateQueries['readPortableBackup'] {
  return async (input = {}) => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'includeCookingHistory') ||
      (Object.hasOwn(input, 'includeCookingHistory') &&
        typeof input.includeCookingHistory !== 'boolean')
    )
      return {
        kind: 'failed',
        error: {
          code: 'invalid_input',
          messageKey: 'backup.invalid_options',
          retry: 'after_correction',
        },
      };
    const snapshot = await readSnapshot(reader, async (session) => {
      const version = await session.all<{ user_version: number }>('PRAGMA user_version');
      const databaseSchemaVersion = version[0]?.user_version;
      requireStored(
        databaseSchemaVersion === 2 ||
          databaseSchemaVersion === 3 ||
          databaseSchemaVersion === 4 ||
          databaseSchemaVersion === 5 ||
          databaseSchemaVersion === 6,
      );
      if (input.includeCookingHistory && databaseSchemaVersion !== 5 && databaseSchemaVersion !== 6)
        throw new StorageFault('incompatible_version', 'Expanded backup is not activated');
      const manifests = await session.all<CatalogueIdentity>(
        'SELECT catalogue_version AS version, fingerprint FROM catalogue_manifest WHERE singleton=1 LIMIT 2',
      );
      requireStored(manifests.length === 1 && catalogueMatches(manifests[0]!, options.catalogue));
      return {
        schemaVersion:
          databaseSchemaVersion === 5 || databaseSchemaVersion === 6 ? (2 as const) : (1 as const),
        databaseSchemaVersion: databaseSchemaVersion as 2 | 3 | 4 | 5 | 6,
        createdAt: options.now(),
        catalogue: { version: manifests[0]!.version, fingerprint: manifests[0]!.fingerprint },
        data: await readBackupData(
          session,
          databaseSchemaVersion === 5 || databaseSchemaVersion === 6,
          input.includeCookingHistory === true,
        ),
      };
    });
    if (snapshot.kind !== 'ready') return snapshot;
    try {
      const value = await createPortableBackup(
        { ...snapshot.value, sourceRevision: snapshot.revision },
        options.sha256,
      );
      return { kind: 'ready', value, revision: snapshot.revision };
    } catch (error) {
      const tooLarge = error instanceof PortableBackupError && error.reason === 'too_large';
      return {
        kind: 'failed',
        error: {
          code: tooLarge ? 'too_large' : 'storage_failure',
          messageKey: tooLarge ? 'backup.too_large' : 'backup.export_failed',
          retry: 'after_correction',
        },
      };
    }
  };
}
