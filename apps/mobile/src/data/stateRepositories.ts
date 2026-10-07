import {
  isActualLocalDate,
  isUtcInstant,
  validatePlanOccurrence,
  validatePreferenceSnapshot,
  validateShoppingScope,
} from '@cookmate/contracts';
import type {
  CatalogueBoundary,
  LocalDate,
  OperationReceipt,
  PlanOccurrence,
  PreferenceSnapshot,
  SavedPreference,
  ShoppingScope,
} from '@cookmate/contracts';
import type { CookMateQueries, Favourite, PlanSnapshot } from '@cookmate/domain';
import { isSupportedPlanDate, validateReceiptSemantics } from '@cookmate/domain';
import { readRevision, readSnapshot } from './query';
import { StorageFault } from './sql';
import type { SerializedReader, SqlSession } from './sql';
import { decodeStoredText } from './storedText';

function requireStored(condition: boolean): asserts condition {
  if (!condition) throw new StorageFault('storage_failure', 'Stored state is invalid');
}

export async function readShoppingScopeInSnapshot(session: SqlSession): Promise<ShoppingScope> {
  const scopes = await session.all<{ scopeId: string; revision: number }>(
    'SELECT scope_id AS scopeId, revision FROM shopping_scope WHERE singleton = 1',
  );
  const row = scopes[0];
  requireStored(scopes.length === 1 && row !== undefined);
  const selections = await session.all<{ occurrenceId: string; existingId: string | null }>(
    'SELECT s.occurrence_id AS occurrenceId, p.occurrence_id AS existingId FROM shopping_selection s LEFT JOIN plan_occurrence p ON p.occurrence_id = s.occurrence_id WHERE s.scope_id = ? ORDER BY s.occurrence_id',
    [row.scopeId],
  );
  requireStored(selections.every((selection) => selection.existingId === selection.occurrenceId));
  const scope = { ...row, occurrenceIds: selections.map((selection) => selection.occurrenceId) };
  requireStored(validateShoppingScope(scope));
  return scope;
}

interface OccurrenceRow extends Omit<PlanOccurrence, 'placement'> {
  actualDate: LocalDate;
  mealKey: PlanOccurrence['placement']['mealKey'];
}

export async function readPlanInSnapshot(
  session: SqlSession,
  catalogue: CatalogueBoundary,
  startDate: LocalDate,
  endDate: LocalDate,
): Promise<PlanSnapshot> {
  const rows = await session.all<OccurrenceRow>(
    `SELECT occurrence_id AS occurrenceId, recipe_id AS recipeId, local_date AS actualDate,
       meal_key AS mealKey, revision, created_at AS createdAt, updated_at AS updatedAt
     FROM plan_occurrence WHERE local_date BETWEEN ? AND ?
     ORDER BY local_date, CASE meal_key WHEN 'breakfast' THEN 0 WHEN 'lunch' THEN 1 ELSE 2 END, occurrence_id`,
    [startDate, endDate],
  );
  const occurrences = rows.map(({ actualDate, mealKey, ...row }) => ({
    ...row,
    placement: { actualDate, mealKey },
  }));
  requireStored(
    occurrences.every(
      (item) =>
        validatePlanOccurrence(item) &&
        catalogue.recipeIds.has(item.recipeId) &&
        isActualLocalDate(item.placement.actualDate) &&
        isUtcInstant(item.createdAt) &&
        isUtcInstant(item.updatedAt),
    ),
  );
  return {
    startDate,
    endDate,
    occurrences,
    shoppingScope: await readShoppingScopeInSnapshot(session),
  };
}

export async function readPreferencesInSnapshot(session: SqlSession): Promise<PreferenceSnapshot> {
  const marker = (
    await session.all<{ lastRemovalRevision: number | null }>(
      'SELECT last_removal_revision AS lastRemovalRevision FROM preference_state WHERE singleton=1',
    )
  )[0];
  requireStored(marker !== undefined);
  const snapshot = {
    revision: await readRevision(session, 'preferences'),
    lastRemovalRevision: marker.lastRemovalRevision,
    items: (
      await session.all<SavedPreference>(
        'SELECT preference_id AS preferenceId, type, value, revision FROM saved_preference ORDER BY preference_id',
      )
    ).map((row) => ({ ...row, value: decodeStoredText(row.value) })),
  };
  requireStored(validatePreferenceSnapshot(snapshot));
  requireStored(
    snapshot.lastRemovalRevision === null || snapshot.lastRemovalRevision <= snapshot.revision,
  );
  return snapshot;
}

export async function readReceiptInSnapshot(
  session: SqlSession,
  operationId: string,
  catalogue: CatalogueBoundary,
): Promise<OperationReceipt | null> {
  const row = (
    await session.all<
      Omit<OperationReceipt, 'schemaVersion' | 'effects'> & { effectsJson: string }
    >(
      `SELECT operation_id AS operationId, user_intent_id AS userIntentId,
         payload_fingerprint AS payloadFingerprint, outcome, committed_at AS committedAt,
         shopping_projection AS shoppingProjection, effects_json AS effectsJson
       FROM operation_receipt WHERE operation_id = ?`,
      [operationId],
    )
  )[0];
  if (!row) return null;
  const { effectsJson, ...values } = row;
  const receipt = { schemaVersion: 1, ...values, effects: JSON.parse(effectsJson) as unknown };
  requireStored(validateReceiptSemantics(receipt, catalogue));
  return receipt;
}

export type StateQueries = Pick<
  CookMateQueries,
  'readFavourites' | 'readPlan' | 'readPreferences' | 'readReceipt'
>;

/** All related values are read in one serialized snapshot, including cross-week scope IDs. */
export function createStateRepositories(
  reader: SerializedReader,
  catalogue: CatalogueBoundary,
): StateQueries {
  return Object.freeze({
    readFavourites: () =>
      readSnapshot(reader, async (session) => {
        const favourites = await session.all<Favourite>(
          'SELECT recipe_id AS recipeId, revision, saved_at AS savedAt FROM favourite WHERE saved = 1 ORDER BY saved_at DESC, recipe_id',
        );
        requireStored(
          favourites.every(
            (item) =>
              catalogue.recipeIds.has(item.recipeId) &&
              Number.isSafeInteger(item.revision) &&
              item.revision >= 0 &&
              isUtcInstant(item.savedAt),
          ),
        );
        return favourites.map((row) => ({ ...row }));
      }),
    readPlan: async (startDate, endDate) => {
      if (!isSupportedPlanDate(startDate) || !isSupportedPlanDate(endDate) || startDate > endDate)
        return {
          kind: 'failed',
          error: {
            code: 'invalid_input',
            messageKey: 'plan.invalid_range',
            retry: 'after_correction',
          },
        };
      return readSnapshot(reader, (session) =>
        readPlanInSnapshot(session, catalogue, startDate, endDate),
      );
    },
    readPreferences: () => readSnapshot(reader, readPreferencesInSnapshot),
    readReceipt: (operationId) =>
      readSnapshot(reader, (session) => readReceiptInSnapshot(session, operationId, catalogue)),
  });
}
