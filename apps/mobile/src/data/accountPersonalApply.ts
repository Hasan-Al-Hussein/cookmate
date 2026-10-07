import { ACCOUNT_SNAPSHOT_MAX_BYTES, validateAccountPersonal } from '@cookmate/account-sync';
import type { AccountPersonalData } from '@cookmate/account-sync';
import { portableBackupByteLength, portablePersonalLimits } from '@cookmate/domain';
import type { Immutable, PortablePersonalData } from '@cookmate/domain';
import {
  collectionColumns,
  manualColumns,
  membershipColumns,
  noteColumns,
  parseCollection,
  parseManual,
  parseMembership,
  parseNote,
  readPersonalState,
} from './personalRecords';
import type {
  CollectionRow,
  ManualRow,
  MembershipRow,
  NoteRow,
  PersonalState,
} from './personalRecords';
import { nextStoredRevision } from './shoppingRepository';
import { runBound, StorageFault } from './sql';
import type { SqlSession, SqlValue } from './sql';
import { encodeStoredText } from './storedText';

export interface AccountPersonalApplyResult {
  changed: boolean;
  revision: number;
  epoch: number;
}

function requireValid(condition: unknown): asserts condition {
  if (!condition)
    throw new StorageFault('storage_failure', 'Reviewed account personal data is invalid');
}

function ownedCandidate(personal: Immutable<AccountPersonalData>): AccountPersonalData {
  requireValid(validateAccountPersonal(personal));
  const serialized = JSON.stringify(personal);
  requireValid(portableBackupByteLength(serialized) <= ACCOUNT_SNAPSHOT_MAX_BYTES);
  return JSON.parse(serialized) as AccountPersonalData;
}

const noteKey = (row: AccountPersonalData['notes'][number]) => row.recipeId;
const collectionKey = (row: AccountPersonalData['collections'][number]) => row.collectionId;
const memberKey = (row: AccountPersonalData['memberships'][number]) =>
  `${row.collectionId}/${row.recipeId}`;
const manualKey = (row: AccountPersonalData['manualItems'][number]) => row.itemId;

function sameRows<Row extends object>(
  before: readonly Row[],
  after: readonly Row[],
  key: (row: Row) => string,
): boolean {
  if (before.length !== after.length) return false;
  const rows = new Map(after.map((row) => [key(row), row]));
  return before.every((row) => {
    const next = rows.get(key(row));
    return next && (Object.keys(row) as (keyof Row)[]).every((field) => row[field] === next[field]);
  });
}

function retainsRemovals<Row>(
  before: readonly Row[],
  after: readonly Row[],
  key: (row: Row) => string,
  removed: (row: Row) => boolean,
): boolean {
  const keys = new Set(after.map(key));
  return before.every((row) => !removed(row) || keys.has(key(row)));
}

async function requireKnownRecipes(session: SqlSession, personal: AccountPersonalData) {
  const ids = [...new Set([...personal.notes, ...personal.memberships].map((row) => row.recipeId))];
  // Stay below SQLite's older 999-variable limit without trusting an unbounded IN clause.
  const batchSize = 400;
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize);
    const rows = await session.all<{ recipeId: string }>(
      `SELECT recipe_id AS recipeId FROM recipe WHERE recipe_id IN (${batch.map(() => '?').join(',')})`,
      batch,
    );
    requireValid(rows.length === batch.length);
  }
}

async function insertRows<Row>(
  session: SqlSession,
  sql: string,
  rows: readonly Row[],
  values: (row: Row) => readonly SqlValue[],
) {
  if (!rows.length) return;
  const statement = await session.prepare(sql);
  try {
    for (const row of rows) await statement.run(values(row));
  } finally {
    await statement.finalize();
  }
}

/** Internal primitive for the account repository's existing guarded writer transaction.
 * The caller must validate the full candidate, its exact review/owner/scope and commit admission.
 * This helper is not approval authority and must never receive an unreviewed remote snapshot.
 * It neither starts/commits a transaction nor publishes events. An outer failure rolls it back.
 */
export async function applyReviewedAccountPersonal(
  session: SqlSession,
  personal: Immutable<AccountPersonalData>,
): Promise<AccountPersonalApplyResult> {
  // Own the exact validated values before the first await; caller mutation cannot alter the write.
  const candidate = ownedCandidate(personal);
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== 5 && version !== 6)
    throw new StorageFault('incompatible_version', 'Personal storage is not activated');
  const state = await readPersonalState(session);
  const notes = (
    await session.all<NoteRow>(
      `SELECT ${noteColumns} FROM recipe_note LIMIT ${portablePersonalLimits.notes + 1}`,
    )
  ).map(parseNote);
  const collections = (
    await session.all<CollectionRow>(
      `SELECT ${collectionColumns} FROM personal_collection LIMIT ${portablePersonalLimits.collections + 1}`,
    )
  ).map(parseCollection);
  const memberships = (
    await session.all<MembershipRow>(
      `SELECT ${membershipColumns} FROM personal_collection_member LIMIT ${portablePersonalLimits.memberships + 1}`,
    )
  ).map(parseMembership);
  const manualItems = (
    await session.all<ManualRow>(
      `SELECT ${manualColumns} FROM manual_shopping_item LIMIT ${portablePersonalLimits.manualItems + 1}`,
    )
  ).map(parseManual);
  return applyAdmittedAccountPersonal(
    session,
    candidate,
    state,
    { notes, collections, memberships, manualItems },
    () => requireKnownRecipes(session, candidate),
  );
}

/** Shared transaction-local replacement only. Both callers admit schema, own the candidate,
 * validate stored rows and provide their distinct recipe identity policy before entering here.
 * Retaining a removal key permits an explicitly reviewed live counterpart; this is not consent.
 */
export async function applyAdmittedAccountPersonal(
  session: SqlSession,
  candidate: AccountPersonalData,
  state: PersonalState,
  current: PortablePersonalData,
  admitRecipeIdentities: () => Promise<void>,
): Promise<AccountPersonalApplyResult> {
  const { notes, collections, memberships, manualItems } = current;
  let previousRevision = state.revision;
  const wireRow = <Row extends { revision: number }>(row: Row): Omit<Row, 'revision'> => {
    const { revision, ...wire } = row;
    previousRevision = Math.max(previousRevision, revision);
    return wire;
  };
  const before: AccountPersonalData = {
    notes: notes.map(wireRow),
    collections: collections.map(wireRow),
    memberships: memberships.map(wireRow),
    manualItems: manualItems.map(wireRow),
  };
  requireValid(validateAccountPersonal(before));
  requireValid(
    retainsRemovals(before.notes, candidate.notes, noteKey, (row) => row.deleted) &&
      retainsRemovals(
        before.collections,
        candidate.collections,
        collectionKey,
        (row) => row.deleted,
      ) &&
      retainsRemovals(
        before.memberships,
        candidate.memberships,
        memberKey,
        (row) => !row.present,
      ) &&
      retainsRemovals(before.manualItems, candidate.manualItems, manualKey, (row) => row.deleted),
  );
  await admitRecipeIdentities();
  if (
    sameRows(before.notes, candidate.notes, noteKey) &&
    sameRows(before.collections, candidate.collections, collectionKey) &&
    sameRows(before.memberships, candidate.memberships, memberKey) &&
    sameRows(before.manualItems, candidate.manualItems, manualKey)
  )
    return { changed: false, ...state };

  const revision = nextStoredRevision(previousRevision);
  const epoch = nextStoredRevision(state.epoch);
  const encode = (value: string | null) => (value === null ? null : encodeStoredText(value));
  await session.exec('DELETE FROM personal_collection_member');
  await session.exec('DELETE FROM recipe_note');
  await session.exec('DELETE FROM personal_collection');
  await session.exec('DELETE FROM manual_shopping_item');
  await insertRows(
    session,
    'INSERT INTO recipe_note VALUES (?,?,?,?,?,?,?)',
    candidate.notes,
    (row) => [
      row.noteId,
      row.recipeId,
      encode(row.text),
      row.deleted ? 1 : 0,
      revision,
      row.createdAt,
      row.updatedAt,
    ],
  );
  await insertRows(
    session,
    'INSERT INTO personal_collection VALUES (?,?,?,?,?,?)',
    candidate.collections,
    (row) => [
      row.collectionId,
      encode(row.name),
      row.deleted ? 1 : 0,
      revision,
      row.createdAt,
      row.updatedAt,
    ],
  );
  await insertRows(
    session,
    'INSERT INTO personal_collection_member VALUES (?,?,?,?,?)',
    candidate.memberships,
    (row) => [row.collectionId, row.recipeId, row.present ? 1 : 0, revision, row.updatedAt],
  );
  await insertRows(
    session,
    'INSERT INTO manual_shopping_item VALUES (?,?,?,?,?,?,?,?,?,?)',
    candidate.manualItems,
    (row) => [
      row.itemId,
      encode(row.name),
      encode(row.amountText),
      encode(row.unitText),
      row.category,
      row.purchased ? 1 : 0,
      row.deleted ? 1 : 0,
      revision,
      row.createdAt,
      row.updatedAt,
    ],
  );
  await runBound(session, 'UPDATE personal_state SET revision=?,epoch=? WHERE singleton=1', [
    revision,
    epoch,
  ]);
  return { changed: true, revision, epoch };
}
