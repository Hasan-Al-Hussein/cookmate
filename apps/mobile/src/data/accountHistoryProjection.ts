import { catalogueMatches } from '@cookmate/contracts';
import type { CatalogueIdentity, Recipe } from '@cookmate/contracts';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  canonicalAccountHistory,
  validateAccountHistory,
} from '@cookmate/account-sync';
import type { AccountCookingHistory, AccountCookingHistoryEntry } from '@cookmate/account-sync';
import {
  cookingContentIdentity,
  portableBackupByteLength,
  portablePersonalLimits,
} from '@cookmate/domain';
import type { Immutable } from '@cookmate/domain';
import { fail, readBinding, uuid } from './accountReplicationRecords';
import { freezeResult } from './query';
import { ACCOUNT_HISTORY_ENTRY_MAX_BYTES, ACCOUNT_HISTORY_SCHEMA_VERSION } from './schema';
import { COOKING_CONTENT_SCHEMA_VERSION } from './cookingContentSchema';
import { runBound } from './sql';
import type { SqlSession } from './sql';

interface ContentOptions {
  catalogue: Readonly<CatalogueIdentity>;
  readRecipe(id: string): Immutable<Recipe> | undefined;
  sha256(value: string): Promise<string>;
}

/** Read compatibility only; this never enables projection mutations or a new wire format. */
export interface AccountHistoryProjectionReadOptions {
  contentSchema: true;
}

async function owned(
  session: SqlSession,
  ownerId: string,
  options?: AccountHistoryProjectionReadOptions,
): Promise<void> {
  if (!uuid(ownerId)) fail('invalid_input');
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (
    version !== ACCOUNT_HISTORY_SCHEMA_VERSION &&
    !(options?.contentSchema === true && version === COOKING_CONTENT_SCHEMA_VERSION)
  )
    fail('stored_data_invalid');
  if ((await readBinding(session)) !== ownerId) fail('different_data_owner');
  // Detect a contaminated owner database without reading another owner's private values.
  for (const table of ['account_cooking_history', 'account_cooking_history_removed']) {
    if ((await session.all(`SELECT 1 FROM ${table} WHERE owner_id<>? LIMIT 1`, [ownerId])).length)
      fail('different_data_owner');
  }
}

function checked(value: unknown): AccountCookingHistory {
  if (!validateAccountHistory(value)) fail('invalid_input');
  const canonical = canonicalAccountHistory(value);
  if (portableBackupByteLength(canonical) > ACCOUNT_SNAPSHOT_MAX_BYTES) fail('too_large');
  const result = JSON.parse(canonical) as AccountCookingHistory;
  if (
    result.entries.some(
      (entry) => portableBackupByteLength(JSON.stringify(entry)) > ACCOUNT_HISTORY_ENTRY_MAX_BYTES,
    )
  )
    fail('too_large');
  return result;
}

/** Metadata-only admission. It does not validate entry content or grant sync authority. */
export async function admitAccountHistoryProjection(
  session: SqlSession,
  ownerId: string,
  options?: AccountHistoryProjectionReadOptions,
): Promise<{ entryCount: number; removalCount: number; entryBytes: number }> {
  await owned(session, ownerId, options);
  const totals = (
    await session.all<{ count: number; bytes: number; maximum: number }>(
      'SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(entry_json AS BLOB))),0) AS bytes,COALESCE(MAX(length(CAST(entry_json AS BLOB))),0) AS maximum FROM account_cooking_history WHERE owner_id=?',
      [ownerId],
    )
  )[0]!;
  const removals = (
    await session.all<{ count: number }>(
      'SELECT COUNT(*) AS count FROM account_cooking_history_removed WHERE owner_id=?',
      [ownerId],
    )
  )[0]!.count;
  const scopedBytes =
    totals.bytes +
    Math.max(0, totals.count - 1) +
    removals * 38 +
    Math.max(0, removals - 1) +
    portableBackupByteLength('{"entries":[],"removedEventIds":[]}');
  if (
    totals.count > portablePersonalLimits.history ||
    removals > portablePersonalLimits.history ||
    scopedBytes > ACCOUNT_SNAPSHOT_MAX_BYTES ||
    totals.maximum > ACCOUNT_HISTORY_ENTRY_MAX_BYTES
  )
    fail('too_large');
  for (const table of ['account_cooking_history', 'account_cooking_history_removed']) {
    if (
      (
        await session.all(
          `SELECT 1 FROM ${table} WHERE owner_id=? AND (typeof(event_id)<>'text' OR length(CAST(event_id AS BLOB))<>36 OR length(event_id)<>36 OR substr(event_id,9,1)<>'-' OR substr(event_id,14,1)<>'-' OR substr(event_id,19,1)<>'-' OR substr(event_id,24,1)<>'-' OR substr(event_id,15,1)<>'4' OR substr(event_id,20,1) NOT IN ('8','9','a','b') OR length(replace(event_id,'-',''))<>32 OR replace(event_id,'-','') GLOB '*[^0-9a-f]*') LIMIT 1`,
          [ownerId],
        )
      ).length
    )
      fail('stored_data_invalid');
  }
  if (
    (
      await session.all(
        `SELECT 1 FROM account_cooking_history h WHERE owner_id=? AND (NOT json_valid(entry_json) OR COALESCE(json_type(entry_json,'$.eventId')<>'text' OR json_extract(entry_json,'$.eventId')<>event_id,1) OR EXISTS (SELECT 1 FROM account_cooking_history_removed r WHERE r.owner_id=h.owner_id AND r.event_id=h.event_id)) LIMIT 1`,
        [ownerId],
      )
    ).length
  )
    fail('stored_data_invalid');
  return { entryCount: totals.count, removalCount: removals, entryBytes: totals.bytes };
}

/** Data-only rows. This does not read local cooked receipts or grant permission to sync. */
export async function readAccountHistoryProjection(
  session: SqlSession,
  ownerId: string,
  options?: AccountHistoryProjectionReadOptions,
): Promise<Immutable<AccountCookingHistory>> {
  await admitAccountHistoryProjection(session, ownerId, options);
  const rows = await session.all<{ eventId: string; entryJson: string }>(
    'SELECT event_id AS eventId,entry_json AS entryJson FROM account_cooking_history WHERE owner_id=? ORDER BY event_id',
    [ownerId],
  );
  const removed = await session.all<{ eventId: string }>(
    'SELECT event_id AS eventId FROM account_cooking_history_removed WHERE owner_id=? ORDER BY event_id',
    [ownerId],
  );
  try {
    const entries = rows.map((row) => {
      const entry: unknown = JSON.parse(row.entryJson);
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('eventId' in entry) ||
        entry.eventId !== row.eventId
      )
        fail('stored_data_invalid');
      return entry;
    });
    // Persisted overlap is corruption; withdrawal-first overlap exists only inside the apply transaction.
    return freezeResult(checked({ entries, removedEventIds: removed.map((row) => row.eventId) }));
  } catch {
    fail('stored_data_invalid');
  }
}

/** Current trusted catalogue only. Archive resolution must be connected explicitly later. */
export async function verifyAccountHistoryContent(
  history: Immutable<AccountCookingHistory>,
  options: ContentOptions,
): Promise<void> {
  const checkedHistory = checked(history);
  const identities = new Map<string, ReturnType<typeof cookingContentIdentity>>();
  for (const entry of checkedHistory.entries) {
    const recipe = options.readRecipe(entry.recipeId);
    if (
      !recipe ||
      !catalogueMatches(entry.catalogue, options.catalogue) ||
      entry.recipeTitle !== recipe.title ||
      entry.photoKey !== recipe.photoKey
    )
      fail('history_content_mismatch');
    let identity = identities.get(entry.recipeId);
    if (!identity) {
      identity = cookingContentIdentity(recipe, options.catalogue, options.sha256);
      identities.set(entry.recipeId, identity);
    }
    const current = await identity;
    if (
      entry.contentFingerprint !== current.contentFingerprint ||
      entry.readerVersion !== current.readerVersion
    )
      fail('history_content_mismatch');
  }
}

const entryBytes = (entry: AccountCookingHistoryEntry | Immutable<AccountCookingHistoryEntry>) =>
  canonicalAccountHistory({ entries: [entry as AccountCookingHistoryEntry], removedEventIds: [] });

/**
 * Transaction primitive for a reviewed same-owner apply. Caller must own a serialized writer
 * transaction, scope approval and auth-generation COMMIT guard. This never creates a cooking
 * receipt, changes an event ID, installs incoming revisions or erases genuine local receipts.
 * Production ports remain disabled until the complete atomic apply is integrated.
 */
export async function mergeAccountHistoryProjection(
  session: SqlSession,
  ownerId: string,
  incoming: Immutable<AccountCookingHistory>,
  options: ContentOptions,
): Promise<{ changed: boolean; history: Immutable<AccountCookingHistory> }> {
  const candidate = checked(incoming); // Own the input before asynchronous reads.
  const before = await readAccountHistoryProjection(session, ownerId);
  const removed = new Set([...before.removedEventIds, ...candidate.removedEventIds]);
  const entries = new Map(before.entries.map((entry) => [entry.eventId, entry]));
  for (const entry of candidate.entries) {
    if (removed.has(entry.eventId)) continue;
    const prior = entries.get(entry.eventId);
    if (prior && entryBytes(prior) !== entryBytes(entry)) fail('history_content_mismatch');
    entries.set(entry.eventId, entry);
  }
  const merged = checked({
    entries: [...entries.values()].filter((entry) => !removed.has(entry.eventId)),
    removedEventIds: [...removed],
  });
  await verifyAccountHistoryContent(merged, options);
  const changed =
    canonicalAccountHistory(before as AccountCookingHistory) !== canonicalAccountHistory(merged);
  if (!changed) return { changed: false, history: freezeResult(merged) };
  // Withdrawal facts are monotonic. They precede projection removal in this transaction.
  for (const eventId of merged.removedEventIds) {
    await runBound(
      session,
      'INSERT OR IGNORE INTO account_cooking_history_removed(owner_id,event_id) VALUES (?,?)',
      [ownerId, eventId],
    );
    await runBound(session, 'DELETE FROM account_cooking_history WHERE owner_id=? AND event_id=?', [
      ownerId,
      eventId,
    ]);
  }
  const existing = new Set(before.entries.map((entry) => entry.eventId));
  for (const entry of merged.entries) {
    if (!existing.has(entry.eventId)) {
      await runBound(
        session,
        'INSERT INTO account_cooking_history(owner_id,event_id,entry_json) VALUES (?,?,?)',
        [ownerId, entry.eventId, JSON.stringify(entry)],
      );
    }
  }
  await owned(session, ownerId);
  return { changed: true, history: freezeResult(merged) };
}
