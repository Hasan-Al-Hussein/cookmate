import {
  canonicalContentJson,
  validateRecipeContentRef,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { isUtcInstant } from '@cookmate/contracts';
import {
  PORTABLE_BACKUP_MAX_BYTES,
  portablePersonalLimits,
  validatePortableHistoryEntry,
  validatePortablePersonal,
  type CookingHistoryEntry,
  type Immutable,
  type PortableBackupHash,
} from '@cookmate/domain';
import type {
  PortableContentBackupEnvelope,
  PortableContentHistoryRecord,
} from '../../../../packages/domain/src/portableBackupContent';
import {
  validateContentCookingHistoryEntry,
  validateImportedContentCookingHistoryEntry,
  type ImportedContentCookingHistoryEntry,
} from './contentCookingHistoryRecords';
import { isAppId, isRevision } from './conversationRecords';
import { admitCookingClocks, requireCookingContentReadVersion } from './cookingContentRepository';
import {
  historyClearSnapshot,
  readAccountCookingScope,
  withdrawClearedHistory,
  type HistoryClearSnapshot,
} from './cookingHistoryRows';
import {
  preparePortablePersonalRestoreData,
  readPortablePersonalRestoreState,
} from './portablePersonalRestore';
import { writePreparedPortablePersonalRestoreData } from './portableRestoreExpanded';
import { freezeResult } from './query';
import { nextStoredRevision } from './shoppingRepository';
import { runBound, StorageFault, type SqlSession } from './sql';

const batchSize = 100;
function stored(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StorageFault('storage_failure', message);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function historyRef(record: Immutable<PortableContentHistoryRecord>): RecipeContentRef {
  if (record.kind === 'exact') {
    stored(
      exact(record, ['kind', 'entry']) && validateContentCookingHistoryEntry(record.entry),
      'Backup exact history is invalid',
    );
    return { ...record.entry.contentRef };
  }
  stored(
    exact(record, ['kind', 'entry', 'pin']) &&
      record.kind === 'legacy' &&
      validatePortableHistoryEntry(record.entry) &&
      exact(record.pin, ['kind', 'ref']) &&
      record.pin.kind === 'exact' &&
      validateRecipeContentRef(record.pin.ref) &&
      record.pin.ref.recipeId === record.entry.recipeId,
    'Backup history requires an exact resolved reference',
  );
  return { ...record.pin.ref };
}

/** Recheck original incoming IDs before this restore withdraws the history it replaces. */
async function requireNoKnownRemovals(
  session: SqlSession,
  ids: readonly string[],
  ownerId: string | null,
) {
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize),
      placeholders = batch.map(() => '?').join(',');
    const found = await session.all(
      `SELECT 1 FROM cooking_history_withdrawal WHERE event_id IN (${placeholders})
       UNION ALL SELECT 1 FROM account_cooking_history_removed WHERE owner_id=? AND event_id IN (${placeholders})
       UNION ALL SELECT 1 FROM cooking_event WHERE state IN ('cleared','cancelled') AND event_id IN (${placeholders})
       UNION ALL SELECT 1 FROM imported_cooking_history p WHERE source_event_id IN (${placeholders}) AND
         (EXISTS(SELECT 1 FROM cooking_history_withdrawal w WHERE w.event_id=p.event_id) OR
          EXISTS(SELECT 1 FROM account_cooking_history_removed w WHERE w.owner_id=? AND w.event_id=p.event_id)) LIMIT 1`,
      [...batch, ownerId, ...batch, ...batch, ...batch, ownerId],
    );
    stored(found.length === 0, 'Backup contains previously removed history');
  }
}
async function requireFreshIds(
  session: SqlSession,
  ids: readonly string[],
  ownerId: string | null,
) {
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize),
      placeholders = batch.map(() => '?').join(',');
    const found = await session.all(
      `SELECT 1 FROM cooking_event WHERE event_id IN (${placeholders})
       UNION ALL SELECT 1 FROM imported_cooking_history WHERE event_id IN (${placeholders}) OR source_event_id IN (${placeholders})
       UNION ALL SELECT 1 FROM account_cooking_history WHERE owner_id=? AND event_id IN (${placeholders})
       UNION ALL SELECT 1 FROM cooking_history_withdrawal WHERE event_id IN (${placeholders})
       UNION ALL SELECT 1 FROM account_cooking_history_removed WHERE owner_id=? AND event_id IN (${placeholders}) LIMIT 1`,
      [...batch, ...batch, ...batch, ownerId, ...batch, ...batch, ownerId, ...batch],
    );
    stored(found.length === 0, 'History import identity conflict');
  }
}
interface ImportedRow {
  entry: CookingHistoryEntry | ImportedContentCookingHistoryEntry;
  sourceEventId: string;
  ref: RecipeContentRef;
  json: string;
}
interface HistoryReplacement {
  snapshot: HistoryClearSnapshot;
  epoch: number;
  rows: ImportedRow[];
}

/**
 * Caller owns the authenticated content reservation and cooking transaction, retains verified
 * revisions, and inserts the restore ledger before final verification/commit. This helper never
 * grants body access, action authority, operation recovery, or changes the app's adopted head.
 */
export async function replacePortableContentExpandedData(
  session: SqlSession,
  source: Immutable<PortableContentBackupEnvelope>,
  operationId: string,
  revision: number,
  sha256: PortableBackupHash,
  restoredAt: string,
  options: { cookingSchemaVersion?: 8 } = {},
): Promise<{
  personal: true;
  historyIncluded: boolean;
  importedHistoryCount: number;
  historyEpoch: number | null;
}> {
  stored(
    isAppId(operationId) &&
      isRevision(revision) &&
      revision > 0 &&
      isUtcInstant(restoredAt) &&
      (options.cookingSchemaVersion === undefined || options.cookingSchemaVersion === 8),
    'Invalid content restore operation',
  );
  const contentOptions = Object.freeze({
    contentSchema: true as const,
    ...(options.cookingSchemaVersion === 8 ? { cookingSchemaVersion: 8 as const } : {}),
  });
  // The caller has validated the format/checksum. Own bounded data before any awaited port so
  // callers cannot change an admitted personal/history record while IDs are being derived.
  const owned = freezeResult(
    JSON.parse(
      canonicalContentJson(source, PORTABLE_BACKUP_MAX_BYTES),
    ) as PortableContentBackupEnvelope,
  );
  stored(
    owned.format === 'cookmate-local-backup' &&
      owned.schemaVersion === 3 &&
      (owned.databaseSchemaVersion === 7 || owned.databaseSchemaVersion === 8) &&
      validatePortablePersonal(owned.data.personal),
    'Invalid content backup scope',
  );
  stored(
    (await requireCookingContentReadVersion(session)) ===
      (contentOptions.cookingSchemaVersion ?? 7),
    'Content restore storage is not activated',
  );
  const currentPersonal = await readPortablePersonalRestoreState(session, contentOptions);
  stored(revision > currentPersonal.revision, 'Personal restore revision must advance');
  const personal = await preparePortablePersonalRestoreData(
    session,
    owned,
    restoredAt,
    contentOptions,
  );
  stored(personal, 'Content backup requires personal data');
  canonicalContentJson(personal, PORTABLE_BACKUP_MAX_BYTES);
  let replacement: HistoryReplacement | null = null;
  if (owned.data.cookingHistory !== undefined) {
    await admitCookingClocks(session);
    const history = owned.data.cookingHistory;
    stored(
      exact(history, ['entries']) &&
        Array.isArray(history.entries) &&
        history.entries.length <= portablePersonalLimits.history,
      'Backup history exceeds supported bounds',
    );
    const references = history.entries.map(historyRef),
      sourceIds = history.entries.map((row) => row.entry.eventId);
    stored(new Set(sourceIds).size === sourceIds.length, 'Backup history IDs are duplicated');
    const states = await session.all<{ epoch: number; revision: number }>(
      'SELECT history_epoch epoch,history_revision revision FROM cooking_state WHERE singleton=1',
    );
    stored(
      states.length === 1 &&
        isRevision(states[0]!.epoch) &&
        isRevision(states[0]!.revision) &&
        revision > states[0]!.revision,
      'History restore revision must advance',
    );
    const epoch = nextStoredRevision(states[0]!.epoch),
      scope = await readAccountCookingScope(session, contentOptions);
    stored(scope, 'History restore scope is unavailable');
    await requireNoKnownRemovals(session, sourceIds, scope.ownerId);
    const snapshot = await historyClearSnapshot(session, states[0]!.epoch, contentOptions);
    stored(snapshot && snapshot.ownerId === scope.ownerId, 'History restore scope changed');
    const rows: ImportedRow[] = [],
      importedIds = new Set<string>(),
      unavailable = new Set([...snapshot.withdrawalIds, ...sourceIds]);
    for (const [index, record] of history.entries.entries()) {
      const digest = await sha256(
        canonicalContentJson([
          'cookmate-imported-history-v3',
          operationId,
          index,
          record.entry.eventId,
        ]),
      );
      stored(
        typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest),
        'History import identity unavailable',
      );
      const eventId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      stored(
        isAppId(eventId) && !importedIds.has(eventId) && !unavailable.has(eventId),
        'History import identity conflict',
      );
      importedIds.add(eventId);
      const entry = {
        ...record.entry,
        eventId,
        origin: 'backup' as const,
        historyEpoch: epoch,
        revision,
      };
      stored(
        record.kind === 'exact'
          ? validateImportedContentCookingHistoryEntry(entry)
          : validatePortableHistoryEntry(entry),
        'Imported history entry is invalid',
      );
      rows.push({
        entry,
        sourceEventId: record.entry.eventId,
        ref: references[index]!,
        json: canonicalContentJson(entry, 32768),
      });
    }
    await requireFreshIds(session, [...importedIds], scope.ownerId);
    // A later explicit clear must be able to retain every imported ID and its source lineage.
    stored(
      new Set([...snapshot.withdrawalIds, ...sourceIds, ...importedIds]).size <=
        portablePersonalLimits.history,
      'History restore withdrawals exceed supported bounds',
    );
    replacement = { snapshot, epoch, rows };
  }

  await writePreparedPortablePersonalRestoreData(session, personal, revision, contentOptions);
  if (replacement) {
    await withdrawClearedHistory(session, replacement.snapshot, contentOptions);
    await session.exec('DELETE FROM imported_cooking_history');
    // Local action receipts and their pins remain immutable; the new epoch hides older history.
    await runBound(
      session,
      'UPDATE cooking_state SET history_epoch=?,history_revision=? WHERE singleton=1',
      [replacement.epoch, revision],
    );
    for (const row of replacement.rows) {
      await runBound(session, 'INSERT INTO imported_cooking_history VALUES (?,?,?,?,?,?,?)', [
        row.entry.eventId,
        row.sourceEventId,
        operationId,
        replacement.epoch,
        row.entry.cookedOn,
        row.entry.recordedAt,
        row.json,
      ]);
      await runBound(session, 'INSERT INTO imported_history_content_pin VALUES (?,?,?,?,NULL)', [
        row.entry.eventId,
        row.ref.recipeId,
        row.ref.revisionId,
        row.ref.contentFingerprint,
      ]);
    }
  }
  return {
    personal: true,
    historyIncluded: replacement !== null,
    importedHistoryCount: replacement?.rows.length ?? 0,
    historyEpoch: replacement?.epoch ?? null,
  };
}
