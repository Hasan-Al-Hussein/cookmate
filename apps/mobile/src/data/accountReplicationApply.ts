import type { AccountSnapshot } from '@cookmate/account-sync';
import type { PortableBackupData, ShoppingProjectionOptions, StoreChange } from '@cookmate/domain';
import { withdrawPreferenceVersions } from './preferenceProvenance';
import { readRevision } from './query';
import {
  nextStoredRevision,
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from './shoppingRepository';
import { runBound } from './sql';
import type { SqlSession } from './sql';
import { encodeStoredText } from './storedText';
import {
  fail,
  revision as validRevision,
  ACCOUNT_APPLY_EPOCH_KEY,
  writeMetadata,
} from './accountReplicationRecords';

async function nextRevision(session: SqlSession): Promise<number> {
  const rows = await session.all<{
    value: number | null;
  }>(`SELECT MAX(revision) AS value FROM state_revision
    UNION ALL SELECT MAX(revision) FROM favourite UNION ALL SELECT MAX(revision) FROM plan_occurrence
    UNION ALL SELECT MAX(revision) FROM purchase_state UNION ALL SELECT MAX(revision) FROM saved_preference
    UNION ALL SELECT MAX(revision) FROM shopping_scope UNION ALL SELECT MAX(projection_revision) FROM shopping_scope
    UNION ALL SELECT MAX(saved_revision) FROM source_preference_link UNION ALL SELECT MAX(removed_revision) FROM source_preference_link
    UNION ALL SELECT MAX(last_removal_revision) FROM preference_state`);
  const schema = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (schema === 4 || schema === 5 || schema === 6)
    rows.push(
      ...(await session.all<{ value: number | null }>(
        'SELECT MAX(session_revision,history_revision) AS value FROM cooking_state',
      )),
    );
  if (schema === 5 || schema === 6)
    rows.push(
      ...(await session.all<{ value: number | null }>(
        'SELECT revision AS value FROM personal_state UNION ALL SELECT MAX(revision) FROM recipe_note UNION ALL SELECT MAX(revision) FROM personal_collection UNION ALL SELECT MAX(revision) FROM personal_collection_member UNION ALL SELECT MAX(revision) FROM manual_shopping_item',
      )),
    );
  if (rows.some((row) => row.value !== null && !validRevision(row.value)))
    fail('stored_data_invalid');
  return nextStoredRevision(rows.reduce((max, row) => Math.max(max, row.value ?? 0), 0));
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Only the account allowlist is changed. Receipt, history, personal and conversation rows stay local. */
export async function applyAccountCookingData(
  session: SqlSession,
  snapshot: AccountSnapshot,
  before: PortableBackupData,
  beforeSnapshot: AccountSnapshot,
  options: ShoppingProjectionOptions,
  now: string,
): Promise<StoreChange> {
  const revision = await nextRevision(session);
  const collections: StoreChange['collections'][number][] = [];
  if (!same(beforeSnapshot.favourites, snapshot.favourites)) {
    const next = new Map(snapshot.favourites.map((item) => [item.recipeId, item]));
    const previous = new Map(before.favourites.map((item) => [item.recipeId, item]));
    for (const item of before.favourites) {
      if (item.saved && !next.has(item.recipeId))
        await runBound(
          session,
          'UPDATE favourite SET saved=0,revision=?,updated_at=? WHERE recipe_id=?',
          [revision, now, item.recipeId],
        );
    }
    for (const item of snapshot.favourites) {
      const old = previous.get(item.recipeId);
      if (old?.saved && old.savedAt === item.savedAt) continue;
      await runBound(
        session,
        `INSERT INTO favourite VALUES (?,?,?,?,?) ON CONFLICT(recipe_id) DO UPDATE SET
        saved=1,revision=excluded.revision,saved_at=excluded.saved_at,updated_at=excluded.updated_at`,
        [item.recipeId, 1, revision, item.savedAt, now],
      );
    }
    collections.push('favourites');
  }
  const planChanged = !same(beforeSnapshot.plan, snapshot.plan);
  const selectionChanged = !same(
    beforeSnapshot.shopping.selectedOccurrenceIds,
    snapshot.shopping.selectedOccurrenceIds,
  );
  const marksChanged = !same(
    beforeSnapshot.shopping.purchaseMarks,
    snapshot.shopping.purchaseMarks,
  );
  if (planChanged || selectionChanged || marksChanged) {
    const ledger = await readShoppingLedgerInSnapshot(session, options);
    const scopeId = ledger.snapshot.scope.scopeId;
    if (planChanged || selectionChanged) {
      // Delete dependent rows first, permitting atomic moves/swaps without transient slot collisions.
      await runBound(session, 'DELETE FROM shopping_contribution WHERE scope_id=?', [scopeId]);
      await runBound(session, 'DELETE FROM shopping_selection WHERE scope_id=?', [scopeId]);
      if (planChanged) {
        const oldPlan = new Map(before.occurrences.map((item) => [item.occurrenceId, item]));
        await session.exec('DELETE FROM plan_occurrence');
        for (const item of snapshot.plan) {
          const old = oldPlan.get(item.occurrenceId);
          const unchanged =
            old &&
            old.recipeId === item.recipeId &&
            same(old.placement, item.placement) &&
            old.createdAt === item.createdAt &&
            old.updatedAt === item.updatedAt;
          await runBound(session, 'INSERT INTO plan_occurrence VALUES (?,?,?,?,?,?,?)', [
            item.occurrenceId,
            item.recipeId,
            item.placement.actualDate,
            item.placement.mealKey,
            unchanged ? old.revision : revision,
            item.createdAt,
            item.updatedAt,
          ]);
        }
        collections.push('plan');
      }
      for (const occurrenceId of snapshot.shopping.selectedOccurrenceIds)
        await runBound(session, 'INSERT INTO shopping_selection VALUES (?,?)', [
          scopeId,
          occurrenceId,
        ]);
      await rebuildShoppingInSnapshot(session, ledger, options);
    }
    // An imported check only applies to this device's freshly validated, exact source demand.
    const rebuilt = await readShoppingLedgerInSnapshot(session, options);
    const marks = new Map(snapshot.shopping.purchaseMarks.map((item) => [item.groupKey, item]));
    for (const group of rebuilt.groups) {
      const mark = marks.get(group.groupKey);
      const matches =
        group.projectionRevision === rebuilt.snapshot.projectionRevision &&
        mark &&
        mark.groupingVersion === group.groupingVersion &&
        mark.demandFingerprint === group.demandFingerprint;
      const purchased = matches && mark.purchased ? 1 : 0;
      const changed = matches ? (mark.changed ? 1 : 0) : 1;
      if (group.purchased !== purchased || group.changed !== changed)
        await runBound(
          session,
          'UPDATE purchase_state SET purchased=?,changed=?,revision=? WHERE scope_id=? AND group_key=?',
          [purchased, changed, revision, scopeId, group.groupKey],
        );
    }
    await runBound(session, 'UPDATE shopping_scope SET revision=? WHERE scope_id=?', [
      revision,
      scopeId,
    ]);
    collections.push('shopping');
  }
  if (!same(beforeSnapshot.preferences, snapshot.preferences)) {
    const next = new Map(snapshot.preferences.map((item) => [item.preferenceId, item]));
    const previous = new Map(
      before.preferences.snapshot.items.map((item) => [item.preferenceId, item]),
    );
    const withdrawn = before.preferences.snapshot.items.filter((item) => {
      const incoming = next.get(item.preferenceId);
      return !incoming || incoming.type !== item.type || incoming.value !== item.value;
    });
    const conversationChanged = await withdrawPreferenceVersions(session, withdrawn, revision);
    for (const old of withdrawn)
      await runBound(session, 'DELETE FROM saved_preference WHERE preference_id=?', [
        old.preferenceId,
      ]);
    for (const item of snapshot.preferences) {
      const old = previous.get(item.preferenceId);
      if (old && old.type === item.type && old.value === item.value) continue;
      await runBound(session, 'INSERT INTO saved_preference VALUES (?,?,?,?)', [
        item.preferenceId,
        item.type,
        encodeStoredText(item.value),
        revision,
      ]);
    }
    collections.push('preferences');
    if (conversationChanged) collections.push('conversation');
  }
  // Even an identical cooking snapshot invalidates previously reviewed commands across facades.
  for (const collection of ['store', ...collections])
    await runBound(session, 'UPDATE state_revision SET revision=? WHERE collection=?', [
      revision,
      collection,
    ]);
  await writeMetadata(session, ACCOUNT_APPLY_EPOCH_KEY, revision, 32);
  await readShoppingLedgerInSnapshot(session, options);
  if (
    (await session.all('PRAGMA foreign_key_check')).length ||
    (await readRevision(session, 'store')) !== revision
  )
    fail('stored_data_invalid');
  return { revision, collections };
}
