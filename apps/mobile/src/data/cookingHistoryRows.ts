import {
  canonicalAccountHistory,
  validateAccountCookingHistoryEntry,
} from '@cookmate/account-sync';
import type { AccountCookingHistoryEntry } from '@cookmate/account-sync';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { portablePersonalLimits, validatePortableHistoryEntry } from '@cookmate/domain';
import type { CookingHistoryEntry } from '@cookmate/domain';
import {
  admitAccountHistoryProjection,
  readAccountHistoryProjection,
} from './accountHistoryProjection';
import { readBinding } from './accountReplicationRecords';
import {
  admitAccountContentHistoryProjection,
  hasUniqueHistoryJsonKeys,
  parseAccountContentHistoryEntry,
  readAccountContentHistoryProjection,
} from './accountContentHistoryProjection';
import {
  validateContentCookedReceipt,
  validateImportedContentCookingHistoryEntry,
} from './contentCookingHistoryRecords';
import { isAppId } from './conversationRecords';
import { admitLegacyHistoryRows, admitLocalCookingEvents } from './cookingContentRepository';
import { runBound, StorageFault } from './sql';
import type { SqlSession, SqlValue } from './sql';

/** Explicit private-schema compatibility. Legacy callers never silently omit account data. */
export interface HistoryContentReadOptions {
  contentSchema: true;
}

export interface HistoryRow {
  eventId: string;
  historyEpoch: number;
  state: 'saved';
  cookedOn: string;
  recordedAt: string;
  requestFingerprint: string | null;
  receiptJson: string | null;
  entryJson: string | null;
  sourceEventId: string | null;
  restoreOperationId: string | null;
  source?: 'local' | 'backup' | 'account';
  sourcePriority?: number;
  historyRevision?: number | null;
}

function valid(condition: unknown): asserts condition {
  if (!condition)
    throw new StorageFault('storage_failure', 'Stored cooking history identity is invalid');
}

const uuidGlob = `${'[0-9a-f]'.repeat(8)}-${'[0-9a-f]'.repeat(4)}-4${'[0-9a-f]'.repeat(3)}-[89ab]${'[0-9a-f]'.repeat(3)}-${'[0-9a-f]'.repeat(12)}`;
async function admitHistoryWithdrawals(session: SqlSession): Promise<void> {
  const totals = (
    await session.all<{ count: number; maximum: number }>(
      'SELECT COUNT(*) AS count,COALESCE(MAX(length(CAST(event_id AS BLOB))),0) AS maximum FROM cooking_history_withdrawal',
    )
  )[0];
  valid(
    totals &&
      Number.isSafeInteger(totals.count) &&
      totals.count >= 0 &&
      totals.count <= portablePersonalLimits.history &&
      totals.maximum <= 36,
  );
  valid(
    (
      await session.all(
        "SELECT 1 FROM cooking_history_withdrawal WHERE typeof(event_id)<>'text' OR length(CAST(event_id AS BLOB))<>36 OR event_id NOT GLOB ? LIMIT 1",
        [uuidGlob],
      )
    ).length === 0,
  );
}

/** Local-only deletion facts survive guest use and a later deliberate account approval. */
export async function readHistoryWithdrawalIds(
  session: SqlSession,
  options?: HistoryContentReadOptions,
): Promise<string[]> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== 6 && !((version === 7 || version === 8) && options?.contentSchema === true)) {
    valid(version !== 7 && version !== 8);
    return [];
  }
  await admitHistoryWithdrawals(session);
  const rows = await session.all<{ eventId: string }>(
    'SELECT event_id AS eventId FROM cooking_history_withdrawal ORDER BY event_id',
  );
  valid(rows.every((row) => isAppId(row.eventId)));
  return rows.map((row) => row.eventId);
}

/** A guest has no account authority; foreign rows are rejected before any private payload is read. */
export async function readAccountCookingScope(
  session: SqlSession,
  options?: HistoryContentReadOptions,
): Promise<{
  ownerId: string | null;
  entryCount: number;
} | null> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== 6 && !((version === 7 || version === 8) && options?.contentSchema === true)) {
    valid(version !== 7 && version !== 8);
    return null;
  }
  const ownerId = await readBinding(session);
  await admitHistoryWithdrawals(session);
  if (ownerId !== null)
    return {
      ownerId,
      entryCount: (version === 8
        ? await admitAccountContentHistoryProjection(session, ownerId)
        : await admitAccountHistoryProjection(session, ownerId, options)
      ).entryCount,
    };
  for (const table of [
    'account_cooking_history',
    'account_cooking_history_removed',
    ...(version === 8 ? ['account_history_content_pin'] : []),
  ])
    valid((await session.all(`SELECT 1 FROM ${table} LIMIT 1`)).length === 0);
  return {
    ownerId,
    entryCount: 0,
  };
}

/** This existence check denies new operations; metadata alone never grants receipt authority. */
export async function hasAccountCookingEventId(
  session: SqlSession,
  eventId: string,
): Promise<boolean> {
  valid(isAppId(eventId));
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  let scope: { ownerId: string | null } | null;
  if (version === 7 || version === 8) {
    // Metadata may deny an operation; it never activates an older projection writer
    // or confers authority over exact published content.
    const ownerId = await readBinding(session);
    await admitHistoryWithdrawals(session);
    for (const table of ['account_cooking_history', 'account_cooking_history_removed']) {
      valid(
        (
          await session.all(
            `SELECT 1 FROM ${table} ${ownerId === null ? '' : 'WHERE owner_id IS NOT ?'} LIMIT 1`,
            ownerId === null ? [] : [ownerId],
          )
        ).length === 0,
      );
    }
    scope = { ownerId };
  } else scope = await readAccountCookingScope(session);
  if (!scope) return false;
  return (
    (
      await session.all(
        'SELECT 1 FROM account_cooking_history WHERE owner_id=? AND event_id=? UNION ALL SELECT 1 FROM account_cooking_history_removed WHERE owner_id=? AND event_id=? UNION ALL SELECT 1 FROM cooking_history_withdrawal WHERE event_id=? LIMIT 1',
        [scope.ownerId, eventId, scope.ownerId, eventId, eventId],
      )
    ).length > 0
  );
}

const localRows =
  "SELECT event_id AS eventId,cooked_on AS cookedOn,recorded_at AS recordedAt,'local' AS source,0 AS sourcePriority FROM cooking_event WHERE state='saved' AND history_epoch=?";
const importedRows =
  "SELECT event_id AS eventId,cooked_on AS cookedOn,recorded_at AS recordedAt,'backup' AS source,1 AS sourcePriority FROM imported_cooking_history WHERE history_epoch=?";

interface HistoryQuery {
  sql: string;
  values: SqlValue[];
  epoch: number;
  revision: number;
  ownerId: string | null;
}
async function selectedRows(
  session: SqlSession,
  query: HistoryQuery,
  selection: string,
  parameters: SqlValue[],
): Promise<HistoryRow[]> {
  // Only selected metadata keys enter these joins; count/order queries never materialize receipt blobs.
  return session.all<HistoryRow>(
    `${query.sql},selected AS (${selection}) SELECT k.*,COALESCE(e.history_epoch,p.history_epoch,?) AS historyEpoch,'saved' AS state,e.request_fingerprint AS requestFingerprint,e.receipt_json AS receiptJson,COALESCE(p.entry_json,a.entry_json) AS entryJson,p.source_event_id AS sourceEventId,p.restore_operation_id AS restoreOperationId,CASE WHEN k.sourcePriority=2 THEN ? ELSE NULL END AS historyRevision FROM selected k LEFT JOIN cooking_event e ON k.sourcePriority=0 AND e.event_id=k.eventId LEFT JOIN imported_cooking_history p ON k.sourcePriority=1 AND p.event_id=k.eventId LEFT JOIN account_cooking_history a ON k.sourcePriority=2 AND a.event_id=k.eventId AND a.owner_id=? ORDER BY k.cookedOn DESC,k.recordedAt DESC,k.eventId DESC`,
    [...query.values, ...parameters, query.epoch, query.revision, query.ownerId],
  );
}

function wireEntry(row: HistoryRow): AccountCookingHistoryEntry {
  let value: unknown;
  if (row.source === 'account') {
    value = row.entryJson && JSON.parse(row.entryJson);
  } else {
    if (row.source === 'backup') value = parseImportedHistory(row);
    else {
      const receipt: unknown = row.receiptJson && JSON.parse(row.receiptJson);
      valid(
        !!receipt &&
          typeof receipt === 'object' &&
          'kind' in receipt &&
          receipt.kind === 'saved' &&
          'event' in receipt,
      );
      value = receipt.event;
      valid(validatePortableHistoryEntry(value) && value.origin === undefined);
    }
    valid(validatePortableHistoryEntry(value) && value.historyEpoch === row.historyEpoch);
    const { historyEpoch: _epoch, revision: _revision, ...entry } = value;
    value = entry;
  }
  valid(
    validateAccountCookingHistoryEntry(value) &&
      value.eventId === row.eventId &&
      value.cookedOn === row.cookedOn &&
      value.recordedAt === row.recordedAt,
  );
  return value;
}

function validAccountRow(row: HistoryRow): asserts row is HistoryRow & { historyRevision: number } {
  valid(
    row.source === 'account' &&
      row.receiptJson === null &&
      row.requestFingerprint === null &&
      row.sourceEventId === null &&
      row.restoreOperationId === null &&
      typeof row.historyRevision === 'number' &&
      Number.isSafeInteger(row.historyRevision) &&
      row.historyRevision > 0,
  );
}
/** Local projection guards are assigned here; the result is never an operation receipt. */
export function parseAccountHistory(row: HistoryRow): CookingHistoryEntry {
  validAccountRow(row);
  return { ...wireEntry(row), historyEpoch: row.historyEpoch, revision: row.historyRevision };
}

/** Private schema8 data comparison; clocks and local receipt authority never enter account data. */
function contentWireEntry(row: HistoryRow) {
  if (row.source === 'account') {
    validAccountRow(row);
    valid(typeof row.entryJson === 'string');
    const entry = parseAccountContentHistoryEntry(row.eventId, row.entryJson);
    valid(entry.cookedOn === row.cookedOn && entry.recordedAt === row.recordedAt);
    return entry;
  }
  const serialized = row.source === 'backup' ? row.entryJson : row.receiptJson;
  valid(typeof serialized === 'string' && hasUniqueHistoryJsonKeys(serialized));
  const value: unknown = JSON.parse(serialized);
  const entry =
    row.source === 'backup' && validateImportedContentCookingHistoryEntry(value)
      ? value
      : row.source === 'local' && validateContentCookedReceipt(value) && value.kind === 'saved'
        ? value.event
        : null;
  if (!entry) return wireEntry(row);
  valid(
    entry.eventId === row.eventId &&
      entry.historyEpoch === row.historyEpoch &&
      entry.cookedOn === row.cookedOn &&
      entry.recordedAt === row.recordedAt,
  );
  if (row.source === 'backup')
    valid(
      isAppId(row.sourceEventId) &&
        isAppId(row.restoreOperationId) &&
        row.receiptJson === null &&
        row.requestFingerprint === null,
    );
  const {
    historyEpoch: _epoch,
    revision: _revision,
    origin: _origin,
    ...flat
  } = { origin: undefined, ...entry };
  return parseAccountContentHistoryEntry(row.eventId, canonicalContentJson(flat));
}

async function combinedHistory(
  session: SqlSession,
  epoch: number,
  options?: HistoryContentReadOptions,
) {
  const scope = await readAccountCookingScope(session, options);
  if (!scope) return null;
  const accountExact =
    (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version === 8;
  if (options?.contentSchema === true) {
    // Bound every parent before duplicate detection or selected payload hydration.
    await admitLocalCookingEvents(session);
    await admitLegacyHistoryRows(session, 'backup');
  }
  const current = (
    await session.all<{ revision: number; epoch: number }>(
      'SELECT history_revision AS revision,history_epoch AS epoch FROM cooking_state WHERE singleton=1',
    )
  )[0];
  valid(
    current &&
      Number.isSafeInteger(current.revision) &&
      current.revision >= 0 &&
      current.epoch === epoch &&
      (!scope.entryCount || current.revision > 0),
  );
  const accountRows = `SELECT a.event_id AS eventId,json_extract(a.entry_json,'$.cookedOn') AS cookedOn,json_extract(a.entry_json,'$.recordedAt') AS recordedAt,'account' AS source,2 AS sourcePriority FROM account_cooking_history a WHERE a.owner_id=? AND NOT EXISTS (SELECT 1 FROM cooking_event old WHERE old.event_id=a.event_id AND (old.state<>'saved' OR old.history_epoch<>?)) AND NOT EXISTS (SELECT 1 FROM imported_cooking_history old WHERE old.event_id=a.event_id AND old.history_epoch<>?)`;
  const sql = `WITH candidates AS (${localRows} UNION ALL ${importedRows} UNION ALL ${accountRows}),visible AS (SELECT * FROM candidates c WHERE NOT EXISTS (SELECT 1 FROM account_cooking_history_removed r WHERE r.owner_id=? AND r.event_id=c.eventId) AND NOT EXISTS (SELECT 1 FROM cooking_history_withdrawal r WHERE r.event_id=c.eventId))`;
  const values: SqlValue[] = [epoch, epoch, scope.ownerId, epoch, epoch, scope.ownerId];
  const query = { sql, values, epoch, revision: current.revision, ownerId: scope.ownerId };
  const maximumKeys = portablePersonalLimits.history * 3;
  const duplicateKeys = await session.all<
    Pick<HistoryRow, 'eventId' | 'sourcePriority' | 'source' | 'cookedOn' | 'recordedAt'>
  >(
    `${sql},duplicates AS (SELECT eventId FROM visible GROUP BY eventId HAVING COUNT(*)>1 ORDER BY eventId LIMIT ?) SELECT v.* FROM visible v JOIN duplicates d ON d.eventId=v.eventId ORDER BY v.eventId,v.sourcePriority LIMIT ?`,
    [...values, portablePersonalLimits.history + 1, maximumKeys + 1],
  );
  valid(
    duplicateKeys.length <= maximumKeys &&
      new Set(duplicateKeys.map((row) => row.eventId)).size <= portablePersonalLimits.history &&
      duplicateKeys.every(
        (row) =>
          isAppId(row.eventId) &&
          typeof row.sourcePriority === 'number' &&
          [0, 1, 2].includes(row.sourcePriority) &&
          ['local', 'backup', 'account'].includes(row.source ?? '') &&
          typeof row.cookedOn === 'string' &&
          typeof row.recordedAt === 'string',
      ),
  );
  if (duplicateKeys.length) {
    let previous: { eventId: string; bytes: string } | null = null;
    // Compute duplicate keys once; hydrate only indexed batches, never rerun the full union per batch.
    for (let offset = 0; offset < duplicateKeys.length; offset += 32) {
      const keys = duplicateKeys.slice(offset, offset + 32);
      const batch: HistoryRow[] = await selectedRows(
        session,
        {
          ...query,
          sql: `WITH picked(eventId,sourcePriority,source,cookedOn,recordedAt) AS (VALUES ${keys.map(() => '(?,?,?,?,?)').join(',')})`,
          values: keys.flatMap((row) => [
            row.eventId,
            row.sourcePriority!,
            row.source!,
            row.cookedOn,
            row.recordedAt,
          ]),
        },
        'SELECT * FROM picked',
        [],
      );
      valid(batch.length === keys.length);
      batch.sort((left, right) =>
        left.eventId < right.eventId
          ? -1
          : left.eventId > right.eventId
            ? 1
            : left.sourcePriority! - right.sourcePriority!,
      );
      for (const row of batch) {
        // Compare immutable payloads, never IDs alone. Only schema8's explicit private
        // path understands exact mirrors; the earlier wire/parser remains strict.
        const entry = accountExact ? contentWireEntry(row) : wireEntry(row);
        const bytes =
          entry.readerVersion === 2
            ? canonicalContentJson(entry)
            : canonicalAccountHistory({ entries: [entry], removedEventIds: [] });
        valid(!previous || previous.eventId !== row.eventId || previous.bytes === bytes);
        previous = { eventId: row.eventId, bytes };
      }
    }
  }
  return { scope, accountExact, ...query };
}

export interface HistoryClearSnapshot {
  ownerId: string | null;
  eventIds: string[];
  withdrawalIds: string[];
}

async function withdrawalIds(
  session: SqlSession,
  scope: NonNullable<Awaited<ReturnType<typeof readAccountCookingScope>>>,
  additionalEventIds: readonly string[],
  options?: HistoryContentReadOptions,
) {
  // Destructive clear/restore review retains full semantic validation; fast page/count admission
  // is deliberately insufficient authority to withdraw an account projection.
  if (scope.ownerId !== null) {
    const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
      ?.user_version;
    if (version === 8 && options?.contentSchema === true)
      await readAccountContentHistoryProjection(session, scope.ownerId);
    else await readAccountHistoryProjection(session, scope.ownerId, options);
  }
  valid(
    additionalEventIds.length <= portablePersonalLimits.history &&
      additionalEventIds.every(isAppId),
  );
  const totals = (
    await session.all<{ count: number; maximum: number }>(
      'SELECT COUNT(*) AS count,COALESCE(MAX(MAX(length(CAST(event_id AS BLOB)),length(CAST(source_event_id AS BLOB)))),0) AS maximum FROM imported_cooking_history',
    )
  )[0];
  valid(
    totals &&
      Number.isSafeInteger(totals.count) &&
      totals.count >= 0 &&
      totals.count <= portablePersonalLimits.history &&
      totals.maximum <= 36,
  );
  const lineage = await session.all<{ eventId: string; sourceEventId: string }>(
    'SELECT event_id AS eventId,source_event_id AS sourceEventId FROM imported_cooking_history',
  );
  valid(lineage.every((row) => isAppId(row.eventId) && isAppId(row.sourceEventId)));
  const saved = (
    await session.all<{ count: number; maximum: number }>(
      "SELECT COUNT(*) AS count,COALESCE(MAX(length(CAST(event_id AS BLOB))),0) AS maximum FROM cooking_event WHERE state='saved'",
    )
  )[0];
  valid(
    saved &&
      Number.isSafeInteger(saved.count) &&
      saved.count >= 0 &&
      saved.count <= portablePersonalLimits.history &&
      saved.maximum <= 36,
  );
  const existing = await session.all<{ eventId: string }>(
    "SELECT event_id AS eventId FROM cooking_history_withdrawal UNION SELECT event_id FROM account_cooking_history WHERE owner_id=? UNION SELECT event_id FROM account_cooking_history_removed WHERE owner_id=? UNION SELECT event_id FROM cooking_event WHERE state='saved' LIMIT ?",
    [scope.ownerId, scope.ownerId, portablePersonalLimits.history + 1],
  );
  valid(
    existing.length <= portablePersonalLimits.history &&
      existing.every((row) => isAppId(row.eventId)),
  );
  const result = [
    ...new Set([
      ...existing.map((row) => row.eventId),
      ...additionalEventIds,
      ...lineage.flatMap((row) => [row.eventId, row.sourceEventId]),
    ]),
  ].sort();
  valid(result.length <= portablePersonalLimits.history);
  return result;
}

/** Before deleting imported rows, retain both their visible IDs and original export lineage. */
export async function captureHistoryWithdrawalIds(
  session: SqlSession,
  additionalEventIds: readonly string[],
  options?: HistoryContentReadOptions,
): Promise<string[]> {
  const scope = await readAccountCookingScope(session, options);
  valid(scope);
  return withdrawalIds(session, scope, additionalEventIds, options);
}
/** Exact reviewed IDs remain private and do not become a caller-controlled clear command. */
export async function historyClearSnapshot(
  session: SqlSession,
  epoch: number,
  options?: HistoryContentReadOptions,
): Promise<HistoryClearSnapshot | null> {
  const combined = await combinedHistory(session, epoch, options);
  if (!combined) return null;
  const rows = await session.all<{ eventId: string }>(
    `${combined.sql} SELECT DISTINCT eventId FROM visible ORDER BY eventId LIMIT ?`,
    [...combined.values, portablePersonalLimits.history + 1],
  );
  valid(rows.length <= portablePersonalLimits.history && rows.every((row) => isAppId(row.eventId)));
  const eventIds = rows.map((row) => row.eventId);
  return {
    ownerId: combined.scope.ownerId,
    eventIds,
    withdrawalIds: await withdrawalIds(session, combined.scope, eventIds, options),
  };
}

export async function withdrawClearedHistory(
  session: SqlSession,
  snapshot: HistoryClearSnapshot,
  options?: HistoryContentReadOptions,
): Promise<void> {
  const current = await readAccountCookingScope(session, options);
  valid(current && current.ownerId === snapshot.ownerId);
  for (const eventId of snapshot.withdrawalIds)
    await runBound(
      session,
      'INSERT OR IGNORE INTO cooking_history_withdrawal(event_id) VALUES (?)',
      [eventId],
    );
  if (snapshot.ownerId === null) return;
  for (const eventId of snapshot.withdrawalIds)
    await runBound(
      session,
      'INSERT OR IGNORE INTO account_cooking_history_removed(owner_id,event_id) VALUES (?,?)',
      [snapshot.ownerId, eventId],
    );
  await runBound(session, 'DELETE FROM account_cooking_history WHERE owner_id=?', [
    snapshot.ownerId,
  ]);
}
export async function historyRows(
  session: SqlSession,
  epoch: number,
  limit: number,
  cursor?: { cookedOn: string; recordedAt: string; eventId: string },
  options?: HistoryContentReadOptions,
): Promise<HistoryRow[]> {
  const combined = await combinedHistory(session, epoch, options);
  if (combined) {
    const values: SqlValue[] = [];
    if (cursor) values.push(cursor.cookedOn, cursor.recordedAt, cursor.eventId);
    values.push(limit);
    const rows = await selectedRows(
      session,
      combined,
      `SELECT v.* FROM visible v WHERE NOT EXISTS (SELECT 1 FROM visible preferred WHERE preferred.eventId=v.eventId AND preferred.sourcePriority<v.sourcePriority) ${cursor ? 'AND (cookedOn,recordedAt,eventId)<(?,?,?)' : ''} ORDER BY cookedOn DESC,recordedAt DESC,eventId DESC LIMIT ?`,
      values,
    );
    for (const row of rows)
      if (row.source === 'account') {
        if (combined.accountExact) contentWireEntry(row);
        else parseAccountHistory(row);
      }
    return rows;
  }
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  const local = `SELECT event_id AS eventId,history_epoch AS historyEpoch,state,cooked_on AS cookedOn,recorded_at AS recordedAt,request_fingerprint AS requestFingerprint,receipt_json AS receiptJson,NULL AS entryJson,NULL AS sourceEventId,NULL AS restoreOperationId FROM cooking_event WHERE state='saved' AND history_epoch=?`;
  const imported = `SELECT event_id AS eventId,history_epoch AS historyEpoch,'saved' AS state,cooked_on AS cookedOn,recorded_at AS recordedAt,NULL AS requestFingerprint,NULL AS receiptJson,entry_json AS entryJson,source_event_id AS sourceEventId,restore_operation_id AS restoreOperationId FROM imported_cooking_history WHERE history_epoch=?`;
  const values: SqlValue[] = version === 5 ? [epoch, epoch] : [epoch];
  if (cursor) values.push(cursor.cookedOn, cursor.recordedAt, cursor.eventId);
  values.push(limit);
  return session.all<HistoryRow>(
    `SELECT * FROM (${local}${version === 5 ? ` UNION ALL ${imported}` : ''}) ${cursor ? 'WHERE (cookedOn,recordedAt,eventId) < (?,?,?)' : ''} ORDER BY cookedOn DESC,recordedAt DESC,eventId DESC LIMIT ?`,
    values,
  );
}
export function parseImportedHistory(row: HistoryRow): CookingHistoryEntry {
  const value: unknown = row.entryJson && JSON.parse(row.entryJson);
  if (
    !validatePortableHistoryEntry(value) ||
    value.origin !== 'backup' ||
    value.eventId !== row.eventId ||
    value.historyEpoch !== row.historyEpoch ||
    value.cookedOn !== row.cookedOn ||
    value.recordedAt !== row.recordedAt ||
    !isAppId(row.sourceEventId) ||
    !isAppId(row.restoreOperationId) ||
    row.receiptJson !== null ||
    row.requestFingerprint !== null
  )
    throw new StorageFault('storage_failure', 'Imported cooking history is invalid');
  return value;
}
export async function historyCount(
  session: SqlSession,
  epoch: number,
  options?: HistoryContentReadOptions,
): Promise<number> {
  const combined = await combinedHistory(session, epoch, options);
  if (combined) {
    const result = (
      await session.all<{ count: number }>(
        `${combined.sql} SELECT COUNT(DISTINCT eventId) AS count FROM visible`,
        combined.values,
      )
    )[0]?.count;
    valid(typeof result === 'number' && Number.isSafeInteger(result) && result >= 0);
    return result;
  }
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  const local = (
    await session.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM cooking_event WHERE state='saved' AND history_epoch=?",
      [epoch],
    )
  )[0]!.count;
  const imported =
    version === 5
      ? (
          await session.all<{ count: number }>(
            'SELECT COUNT(*) AS count FROM imported_cooking_history WHERE history_epoch=?',
            [epoch],
          )
        )[0]!.count
      : 0;
  return local + imported;
}
