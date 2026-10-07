import { catalogueMatches } from '@cookmate/contracts';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { cookingContentIdentity } from '@cookmate/domain';
import type {
  CookingHistoryEntry,
  Immutable,
  PortableBackupEnvelope,
  PortableBackupHash,
  ShoppingProjectionOptions,
  CookingContentIdentity,
  PortablePersonalData,
} from '@cookmate/domain';
import { isAppId } from './conversationRecords';
import {
  preparePortablePersonalRestoreData,
  readPortablePersonalRestoreState,
  type PortablePersonalRestoreOptions,
} from './portablePersonalRestore';
export { checkPortablePersonalRestore } from './portablePersonalRestore';
export type {
  PortablePersonalRestoreCheck,
  PortablePersonalRestoreConflict,
} from './portablePersonalRestore';
import { nextStoredRevision } from './shoppingRepository';
import { encodeStoredText } from './storedText';
import { runBound, StorageFault } from './sql';
import type { SqlSession } from './sql';
import {
  historyClearSnapshot,
  readAccountCookingScope,
  withdrawClearedHistory,
} from './cookingHistoryRows';

const encode = (v: string | null) => (v === null ? null : encodeStoredText(v));
/** A file cannot quietly revive history already removed from this workspace. */
export async function portableHistoryHasKnownRemovals(
  session: SqlSession,
  source: Immutable<PortableBackupEnvelope>,
): Promise<boolean> {
  if (!source.data.cookingHistory) return false;
  const scope = await readAccountCookingScope(session);
  if (!scope) return false;
  const ids = source.data.cookingHistory.entries.map((entry) => entry.eventId);
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    const placeholders = batch.map(() => '?').join(',');
    const found = await session.all(
      `SELECT 1 FROM cooking_history_withdrawal WHERE event_id IN (${placeholders})
      UNION ALL SELECT 1 FROM account_cooking_history_removed WHERE owner_id=? AND event_id IN (${placeholders})
      UNION ALL SELECT 1 FROM cooking_event WHERE state='cleared' AND event_id IN (${placeholders}) LIMIT 1`,
      [...batch, scope.ownerId, ...batch, ...batch],
    );
    if (found.length) return true;
  }
  return false;
}
/** No trusted historical content archive exists yet. A checksum is not provenance: history
 * must name the exact currently known recipe/content, or the whole import remains blocked. */
export async function portableHistoryMatchesCatalogue(
  source: Immutable<PortableBackupEnvelope>,
  options: ShoppingProjectionOptions & { catalogue: Readonly<CatalogueIdentity> },
): Promise<boolean> {
  const identities = new Map<string, Promise<CookingContentIdentity>>();
  for (const entry of source.data.cookingHistory?.entries ?? []) {
    const recipe = options.readRecipe(entry.recipeId);
    if (
      !recipe ||
      entry.recipeTitle !== recipe.title ||
      entry.photoKey !== recipe.photoKey ||
      !catalogueMatches(entry.catalogue, options.catalogue)
    )
      return false;
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
      return false;
  }
  return true;
}
/** Transaction-local SQL shared by reviewed legacy and private exact-content restores. */
export async function writePreparedPortablePersonalRestoreData(
  session: SqlSession,
  personal: Immutable<PortablePersonalData>,
  revision: number,
  options?: PortablePersonalRestoreOptions,
) {
  const current = await readPortablePersonalRestoreState(session, options);
  await session.exec('DELETE FROM personal_collection_member');
  await session.exec('DELETE FROM recipe_note');
  await session.exec('DELETE FROM personal_collection');
  await session.exec('DELETE FROM manual_shopping_item');
  for (const row of personal.notes)
    await runBound(session, 'INSERT INTO recipe_note VALUES (?,?,?,?,?,?,?)', [
      row.noteId,
      row.recipeId,
      encode(row.text),
      row.deleted ? 1 : 0,
      revision,
      row.createdAt,
      row.updatedAt,
    ]);
  for (const row of personal.collections)
    await runBound(session, 'INSERT INTO personal_collection VALUES (?,?,?,?,?,?)', [
      row.collectionId,
      encode(row.name),
      row.deleted ? 1 : 0,
      revision,
      row.createdAt,
      row.updatedAt,
    ]);
  for (const row of personal.memberships)
    await runBound(session, 'INSERT INTO personal_collection_member VALUES (?,?,?,?,?)', [
      row.collectionId,
      row.recipeId,
      row.present ? 1 : 0,
      revision,
      row.updatedAt,
    ]);
  for (const row of personal.manualItems)
    await runBound(session, 'INSERT INTO manual_shopping_item VALUES (?,?,?,?,?,?,?,?,?,?)', [
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
    ]);
  await runBound(session, 'UPDATE personal_state SET revision=?,epoch=? WHERE singleton=1', [
    revision,
    nextStoredRevision(current.epoch),
  ]);
}

/** Atomic data replacement, retaining every real local operation receipt and cancellation fence. */
export async function replaceExpandedBackupData(
  session: SqlSession,
  source: Immutable<PortableBackupEnvelope>,
  operationId: string,
  revision: number,
  sha256: PortableBackupHash,
  restoredAt: string,
) {
  if (await portableHistoryHasKnownRemovals(session, source))
    throw new StorageFault('storage_failure', 'Backup contains previously removed history');
  const personal = await preparePortablePersonalRestoreData(session, source, restoredAt);
  if (!personal) return;
  await writePreparedPortablePersonalRestoreData(session, personal, revision);
  if (!source.data.cookingHistory) return;
  const history = (
    await session.all<{ epoch: number; revision: number }>(
      'SELECT history_epoch AS epoch,history_revision AS revision FROM cooking_state WHERE singleton=1',
    )
  )[0]!;
  const epoch = nextStoredRevision(history.epoch);
  const withdrawal = await historyClearSnapshot(session, history.epoch);
  if (withdrawal) await withdrawClearedHistory(session, withdrawal);
  await session.exec('DELETE FROM imported_cooking_history');
  // Old local events stay immutable as receipt authority. Their earlier epoch is no longer visible.
  await runBound(
    session,
    'UPDATE cooking_state SET history_epoch=?,history_revision=? WHERE singleton=1',
    [epoch, revision],
  );
  for (const [index, row] of source.data.cookingHistory.entries.entries()) {
    const hash = await sha256(
      JSON.stringify(['cookmate-imported-history-v1', operationId, index, row.eventId]),
    );
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new StorageFault('storage_failure', 'History import identity unavailable');
    const eventId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    if (
      !isAppId(eventId) ||
      (await session.all('SELECT 1 FROM cooking_event WHERE event_id=?', [eventId])).length
    )
      throw new StorageFault('storage_failure', 'History import identity conflict');
    if (
      withdrawal &&
      (await session.all('SELECT 1 FROM cooking_history_withdrawal WHERE event_id=?', [eventId]))
        .length
    )
      throw new StorageFault('storage_failure', 'History import identity was withdrawn');
    const entry: CookingHistoryEntry = {
      ...row,
      eventId,
      origin: 'backup',
      historyEpoch: epoch,
      revision,
    };
    await runBound(session, 'INSERT INTO imported_cooking_history VALUES (?,?,?,?,?,?,?)', [
      eventId,
      row.eventId,
      operationId,
      epoch,
      row.cookedOn,
      row.recordedAt,
      JSON.stringify(entry),
    ]);
  }
}
