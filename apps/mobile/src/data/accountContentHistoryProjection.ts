import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  validateAccountCookingHistoryEntry,
  type AccountCookingHistoryEntry,
} from '@cookmate/account-sync';
import { portableBackupByteLength, portablePersonalLimits, type Immutable } from '@cookmate/domain';
import {
  validateAccountExactCookingHistoryEntry,
  type AccountExactCookingHistoryEntry,
} from '../../../../packages/account-sync/src/contentSnapshot';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import { fail, readBinding } from './accountReplicationRecords';
import { freezeResult } from './query';
import { ACCOUNT_HISTORY_ENTRY_MAX_BYTES } from './schema';
import type { SqlSession } from './sql';

export type AccountContentHistoryEntry =
  | AccountCookingHistoryEntry
  | AccountExactCookingHistoryEntry;
export interface AccountContentHistoryProjection {
  entries: AccountContentHistoryEntry[];
  removedEventIds: string[];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && uuidPattern.test(value);
const uuidSql = (column: string) =>
  `typeof(${column})='text' AND length(CAST(${column} AS BLOB))=36 AND instr(${column},char(0))=0 AND substr(${column},9,1)='-' AND substr(${column},14,1)='-' AND substr(${column},19,1)='-' AND substr(${column},24,1)='-' AND substr(${column},15,1)='4' AND substr(${column},20,1) IN ('8','9','a','b') AND length(replace(${column},'-',''))=32 AND replace(${column},'-','') NOT GLOB '*[^0-9a-f]*'`;
const envelopeBytes = portableBackupByteLength('{"entries":[],"removedEventIds":[]}');
const pinBytes = 36 + 36 + 20 + 120 + 64 + 20;
const safeCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Reject bounded ambiguous keys, including escaped spellings; not a JSON syntax or shape validator. */
export function hasUniqueHistoryJsonKeys(serialized: string): boolean {
  if (
    typeof serialized !== 'string' ||
    serialized.length > ACCOUNT_HISTORY_ENTRY_MAX_BYTES ||
    portableBackupByteLength(serialized) > ACCOUNT_HISTORY_ENTRY_MAX_BYTES
  )
    return false;
  try {
    const frames: (Set<string> | null)[] = [];
    for (const token of serialized.matchAll(
      /("(?:[^"\\]|\\.)*")\s*:|"(?:[^"\\]|\\.)*"|[{}\[\]]/g,
    )) {
      if (token[0] === '{') frames.push(new Set());
      else if (token[0] === '[') frames.push(null);
      else if (token[0] === '}' || token[0] === ']') frames.pop();
      else if (token[1]) {
        const keys = frames.at(-1),
          key = JSON.parse(token[1]) as string;
        if (!keys || keys.has(key)) return false;
        keys.add(key);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Caller owns one SQL snapshot. Admission does not parse bodies, authorize sync, or grant release trust. */
export async function admitAccountContentHistoryProjection(
  session: SqlSession,
  ownerId: string,
): Promise<{ entryCount: number; removalCount: number; entryBytes: number }> {
  if (!uuid(ownerId)) fail('invalid_input');
  // Keep private physical8 admission independent of the migration/repository dependency graph.
  if ((await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8)
    fail('stored_data_invalid');
  if ((await readBinding(session)) !== ownerId) fail('different_data_owner');
  for (const table of [
    'account_cooking_history',
    'account_cooking_history_removed',
    'account_history_content_pin',
  ]) {
    if (
      (await session.all(`SELECT 1 FROM ${table} WHERE owner_id IS NOT ? LIMIT 1`, [ownerId]))
        .length
    )
      fail('different_data_owner');
  }
  const totals = (
    await session.all<{ count: number; bytes: number; maximum: number; invalid: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(entry_json AS BLOB))),0) bytes,
      COALESCE(MAX(length(CAST(entry_json AS BLOB))),0) maximum,
      COALESCE(MAX(CASE WHEN typeof(entry_json)='text' AND ${uuidSql('event_id')} THEN 0 ELSE 1 END),0) invalid
      FROM account_cooking_history WHERE owner_id=?`,
      [ownerId],
    )
  )[0];
  const removed = (
    await session.all<{ count: number; invalid: number }>(
      `SELECT COUNT(*) count,COALESCE(MAX(CASE WHEN ${uuidSql('event_id')} THEN 0 ELSE 1 END),0) invalid
      FROM account_cooking_history_removed WHERE owner_id=?`,
      [ownerId],
    )
  )[0];
  if (
    !totals ||
    !removed ||
    ![totals.count, totals.bytes, totals.maximum, removed.count].every(safeCount) ||
    totals.invalid !== 0 ||
    removed.invalid !== 0
  )
    fail('stored_data_invalid');
  if (
    totals.count > portablePersonalLimits.history ||
    removed.count > portablePersonalLimits.history ||
    totals.maximum > ACCOUNT_HISTORY_ENTRY_MAX_BYTES ||
    totals.bytes +
      Math.max(0, totals.count - 1) +
      removed.count * 38 +
      Math.max(0, removed.count - 1) +
      envelopeBytes >
      ACCOUNT_SNAPSHOT_MAX_BYTES
  )
    fail('too_large');
  const pins = (
    await session.all<{ count: number; bytes: number; invalid: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(owner_id AS BLOB))+length(CAST(event_id AS BLOB))+length(CAST(recipe_id AS BLOB))+COALESCE(length(CAST(revision_id AS BLOB)),0)+COALESCE(length(CAST(content_fingerprint AS BLOB)),0)+COALESCE(length(CAST(unresolved_reason AS BLOB)),0)),0) bytes,
      COALESCE(MAX(CASE WHEN ${uuidSql('event_id')} AND typeof(recipe_id)='text' AND length(CAST(recipe_id AS BLOB)) BETWEEN 1 AND 20 AND instr(recipe_id,char(0))=0 AND recipe_id NOT GLOB '*[^0-9]*' AND
      ((unresolved_reason IS NULL AND typeof(revision_id)='text' AND length(CAST(revision_id AS BLOB)) BETWEEN 1 AND 120 AND instr(revision_id,char(0))=0 AND substr(revision_id,1,1) GLOB '[A-Za-z0-9]' AND revision_id NOT GLOB '*[^A-Za-z0-9._:-]*' AND typeof(content_fingerprint)='text' AND length(CAST(content_fingerprint AS BLOB))=64 AND instr(content_fingerprint,char(0))=0 AND content_fingerprint NOT GLOB '*[^0-9a-f]*') OR
      (unresolved_reason IN ('catalogue_mismatch','content_mismatch','recipe_unavailable') AND revision_id IS NULL AND content_fingerprint IS NULL)) THEN 0 ELSE 1 END),0) invalid
      FROM account_history_content_pin WHERE owner_id=?`,
      [ownerId],
    )
  )[0];
  if (
    !pins ||
    !safeCount(pins.count) ||
    !safeCount(pins.bytes) ||
    pins.count !== totals.count ||
    pins.invalid !== 0 ||
    pins.bytes > portablePersonalLimits.history * pinBytes
  )
    fail('stored_data_invalid');
  // Separate JSON admission prevents SQLite malformed-JSON exceptions from reaching later expressions.
  if (
    (
      await session.all(
        'SELECT 1 FROM account_cooking_history WHERE owner_id=? AND NOT json_valid(entry_json) LIMIT 1',
        [ownerId],
      )
    ).length
  )
    fail('stored_data_invalid');
  if (
    (
      await session.all(
        `SELECT 1 FROM account_cooking_history h WHERE owner_id=? AND
      (COALESCE(json_type(entry_json,'$.eventId')='text' AND json_extract(entry_json,'$.eventId')=event_id,0)=0 OR
      EXISTS (SELECT 1 FROM account_cooking_history_removed r WHERE r.owner_id=h.owner_id AND r.event_id=h.event_id)) LIMIT 1`,
        [ownerId],
      )
    ).length
  )
    fail('stored_data_invalid');
  if (
    (
      await session.all(
        `SELECT 1 FROM account_cooking_history h LEFT JOIN account_history_content_pin p ON p.owner_id=h.owner_id AND p.event_id=h.event_id
      LEFT JOIN recipe_identity i ON i.recipe_id=p.recipe_id
      LEFT JOIN recipe_content_revision v ON v.recipe_id=p.recipe_id AND v.revision_id=p.revision_id AND v.content_fingerprint=p.content_fingerprint
      WHERE h.owner_id=? AND (p.event_id IS NULL OR i.recipe_id IS NULL OR p.recipe_id IS NOT json_extract(h.entry_json,'$.recipeId') OR
      (p.unresolved_reason IS NULL AND v.recipe_id IS NULL) OR
      (json_extract(h.entry_json,'$.readerVersion')=2 AND (p.unresolved_reason IS NOT NULL OR p.revision_id IS NOT json_extract(h.entry_json,'$.contentRef.revisionId') OR p.content_fingerprint IS NOT json_extract(h.entry_json,'$.contentRef.contentFingerprint')))) LIMIT 1`,
        [ownerId],
      )
    ).length
  )
    fail('stored_data_invalid');
  if (
    (
      await session.all(
        `SELECT 1 FROM account_history_content_pin p LEFT JOIN account_cooking_history h ON h.owner_id=p.owner_id AND h.event_id=p.event_id WHERE p.owner_id=? AND h.event_id IS NULL LIMIT 1`,
        [ownerId],
      )
    ).length
  )
    fail('stored_data_invalid');
  return { entryCount: totals.count, removalCount: removed.count, entryBytes: totals.bytes };
}

/** Strict data-only parsing. An exact ref is persisted identity, never a local action receipt. */
export function parseAccountContentHistoryEntry(
  eventId: string,
  serialized: string,
): Immutable<AccountContentHistoryEntry> {
  if (!uuid(eventId) || typeof serialized !== 'string') fail('stored_data_invalid');
  if (
    serialized.length > ACCOUNT_HISTORY_ENTRY_MAX_BYTES ||
    portableBackupByteLength(serialized) > ACCOUNT_HISTORY_ENTRY_MAX_BYTES
  )
    fail('too_large');
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !hasUniqueHistoryJsonKeys(serialized) ||
      !(
        validateAccountCookingHistoryEntry(value) || validateAccountExactCookingHistoryEntry(value)
      ) ||
      value.eventId !== eventId
    )
      fail('stored_data_invalid');
    canonicalPortableContentJson(value, ACCOUNT_HISTORY_ENTRY_MAX_BYTES);
    return freezeResult(value);
  } catch {
    return fail('stored_data_invalid');
  }
}

/** Call inside the same caller-owned SQL snapshot as surrounding reads; no writes or content-body reads. */
export async function readAccountContentHistoryProjection(
  session: SqlSession,
  ownerId: string,
): Promise<Immutable<AccountContentHistoryProjection>> {
  await admitAccountContentHistoryProjection(session, ownerId);
  const rows = await session.all<{ eventId: string; entryJson: string }>(
    'SELECT event_id eventId,entry_json entryJson FROM account_cooking_history WHERE owner_id=? ORDER BY event_id',
    [ownerId],
  );
  const removed = await session.all<{ eventId: string }>(
    'SELECT event_id eventId FROM account_cooking_history_removed WHERE owner_id=? ORDER BY event_id',
    [ownerId],
  );
  return freezeResult({
    entries: rows.map((row) => parseAccountContentHistoryEntry(row.eventId, row.entryJson)),
    removedEventIds: removed.map((row) => row.eventId),
  });
}
