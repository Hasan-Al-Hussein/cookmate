import { canonicalContentJson, type RecipeContentRef } from '@cookmate/catalogue/content';
import { portablePersonalLimits, type Immutable } from '@cookmate/domain';
import {
  normalizeAccountContentCookingHistory,
  type AccountContentCookingHistory,
  type AccountContentHistoryRecord,
} from '../../../../packages/account-sync/src/contentSnapshot';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import { readAccountContentHistoryProjection } from './accountContentHistoryProjection';
import { fail, readBinding, revision as validRevision, uuid } from './accountReplicationRecords';
import type { ContentReferenceInspectionView } from './contentReleaseStore';
import {
  createLegacyCookingPinProof,
  retainCookingRevisionInSnapshot,
  withStoredCookingHistoryEntries,
} from './cookingContentRepository';
import { readHistoryWithdrawalIds } from './cookingHistoryRows';
import { freezeResult } from './query';
import { runBound, type SqlSession, type SqlValue } from './sql';

export interface AccountContentHistoryApplyOptions {
  /** Must be the still-held host-authenticated content inspection, never a stored trust flag. */
  view: ContentReferenceInspectionView;
  sha256(text: string): Promise<string>;
  /** Allocated by the enclosing account transaction; no imported clock is accepted. */
  revision: number;
}
export interface AccountContentHistoryApplyResult {
  changed: boolean;
  history: Immutable<AccountContentCookingHistory>;
  historyEpoch: number;
  historyRevision: number;
}
type RecordValue = Immutable<AccountContentHistoryRecord>;
const batchSize = 100;
const readOptions = Object.freeze({ contentSchema: true as const });
const canonical = (value: unknown) => canonicalPortableContentJson(value, 2 * 1024 * 1024);
const refKey = (ref: Immutable<RecipeContentRef>) => canonicalContentJson(ref, 512);

function ownedHistory(value: unknown): Immutable<AccountContentCookingHistory> {
  try {
    return normalizeAccountContentCookingHistory(value);
  } catch (error) {
    fail(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_input',
    );
  }
}
/** Storage origin/clock fields are not an immutable cooking event's content. */
function eventRecord(value: object, pin: unknown): RecordValue {
  const source = value as Record<string, unknown>;
  const entry = Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !['historyEpoch', 'revision'].includes(key) &&
        !(source.readerVersion === 2 && key === 'origin'),
    ),
  );
  return ownedHistory({
    entries: [
      entry.readerVersion === 2 ? { kind: 'exact', entry } : { kind: 'legacy', entry, pin },
    ],
    removedEventIds: [],
  }).entries[0]!;
}
function comparable(value: RecordValue): string {
  const entry = Object.fromEntries(Object.entries(value.entry).filter(([key]) => key !== 'origin'));
  return canonical(
    value.kind === 'exact' ? { kind: 'exact', entry } : { kind: 'legacy', entry, pin: value.pin },
  );
}
function sameEvent(left: RecordValue, right: RecordValue) {
  if (comparable(left) !== comparable(right)) fail('history_content_mismatch');
}

/**
 * Private schema8 transaction primitive. The caller owns scope consent, operation admission,
 * a serialized writer, the content reservation and final COMMIT checks. This does not apply
 * an account snapshot, advance store/journal/settings, or create local cooking authority.
 */
export async function mergeAccountContentHistoryProjection(
  raw: SqlSession,
  ownerId: string,
  incoming: Immutable<AccountContentCookingHistory>,
  options: AccountContentHistoryApplyOptions,
): Promise<Immutable<AccountContentHistoryApplyResult>> {
  if (!uuid(ownerId) || !validRevision(options.revision)) fail('invalid_input');
  const candidate = ownedHistory(incoming),
    requestedRevision = options.revision;
  const view = options.view,
    hashPort = options.sha256;
  const active = () => view.assertActive();
  active();
  const session: SqlSession = {
    all: async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      active();
      const rows = await raw.all<Row>(sql, values);
      active();
      return rows;
    },
    exec: async (sql) => {
      active();
      await raw.exec(sql);
      active();
    },
    prepare: async (sql) => {
      active();
      const statement = await raw.prepare(sql);
      try {
        active();
      } catch (error) {
        await statement.finalize();
        throw error;
      }
      return {
        run: async (values) => {
          active();
          await statement.run(values);
          active();
        },
        // Always clean up even if the host reservation was revoked during the write.
        finalize: async () => {
          await statement.finalize();
          active();
        },
      };
    },
  };
  const sha256 = async (text: string) => {
    active();
    const digest = await hashPort(text);
    active();
    if (!/^[0-9a-f]{64}$/.test(digest)) fail('stored_data_invalid');
    return digest;
  };
  if (
    (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8 ||
    (await session.all<{ foreign_keys: number }>('PRAGMA foreign_keys'))[0]?.foreign_keys !== 1
  )
    fail('stored_data_invalid');
  if ((await readBinding(session)) !== ownerId) fail('different_data_owner');
  const [state] = await session.all<{ epoch: number | null; revision: number | null }>(
    "SELECT CASE WHEN typeof(history_epoch)='integer' THEN history_epoch END epoch,CASE WHEN typeof(history_revision)='integer' THEN history_revision END revision FROM cooking_state WHERE singleton=1",
  );
  if (!state || !validRevision(state.epoch) || !validRevision(state.revision))
    fail('stored_data_invalid');
  const historyEpoch = state.epoch,
    historyRevision = state.revision;
  const projected = await readAccountContentHistoryProjection(session, ownerId);
  const withdrawals = await readHistoryWithdrawalIds(session, readOptions);

  const result = await withStoredCookingHistoryEntries(session, sha256, async (read) => {
    // The shared reader admits every source's parent/pin metadata before these bounded reads.
    const before = new Map<string, RecordValue>();
    for (let offset = 0; offset < projected.entries.length; offset += batchSize) {
      const rows = await read(
        projected.entries
          .slice(offset, offset + batchSize)
          .map((entry) => ({ source: 'account' as const, eventId: entry.eventId })),
      );
      active();
      for (const row of rows) before.set(row.value.eventId, eventRecord(row.value, row.pin));
    }
    const known = new Map(before);
    for (const entry of candidate.entries) {
      const previous = known.get(entry.entry.eventId);
      // Account wire identity includes legacy origin; only local/backup mirrors normalize it.
      if (previous && canonical(previous) !== canonical(entry)) fail('history_content_mismatch');
      else known.set(entry.entry.eventId, entry);
    }
    const removed = new Set([
      ...projected.removedEventIds,
      ...candidate.removedEventIds,
      ...withdrawals,
    ]);
    const [count] = await session.all<{ count: number }>(
      "SELECT COUNT(*) count FROM cooking_event WHERE state IN ('cleared','cancelled')",
    );
    if (!count || !validRevision(count.count)) fail('stored_data_invalid');
    if (count.count > portablePersonalLimits.history) fail('too_large');
    for (const row of await session.all<{ eventId: string }>(
      "SELECT event_id eventId FROM cooking_event WHERE state IN ('cleared','cancelled')",
    )) {
      if (!uuid(row.eventId)) fail('stored_data_invalid');
      removed.add(row.eventId);
    }
    const lineage = await session.all<{ eventId: string; sourceEventId: string }>(
      'SELECT event_id eventId,source_event_id sourceEventId FROM imported_cooking_history',
    );
    const links = new Map<string, string[]>();
    for (const row of lineage) {
      if (!uuid(row.eventId) || !uuid(row.sourceEventId)) fail('stored_data_invalid');
      for (const [left, right] of [
        [row.eventId, row.sourceEventId],
        [row.sourceEventId, row.eventId],
      ]) {
        const targets = links.get(left!) ?? [];
        targets.push(right!);
        links.set(left!, targets);
      }
    }
    const pendingRemoved = [...removed];
    for (let index = 0; index < pendingRemoved.length; index++) {
      if (removed.size > portablePersonalLimits.history) fail('too_large');
      for (const related of links.get(pendingRemoved[index]!) ?? [])
        if (!removed.has(related)) {
          removed.add(related);
          pendingRemoved.push(related);
        }
    }
    const comparisons = new Map(known);
    const ids = [...new Set([...known.keys(), ...removed])];
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batch = ids.slice(offset, offset + batchSize),
        slots = batch.map(() => '?').join(',');
      for (const [source, table, predicate] of [
        ['local', 'cooking_event', " AND state='saved'"],
        ['backup', 'imported_cooking_history', ''],
      ] as const) {
        const matches = await session.all<{ eventId: string }>(
          `SELECT event_id eventId FROM ${table} WHERE event_id IN (${slots})${predicate}`,
          batch,
        );
        if (!matches.length) continue;
        const rows = await read(matches.map((row) => ({ source, eventId: row.eventId })));
        active();
        for (const row of rows) {
          const compared = eventRecord(row.value, row.pin),
            previous = comparisons.get(row.value.eventId);
          if (previous) sameEvent(previous, compared);
          else comparisons.set(row.value.eventId, compared);
        }
      }
    }
    const merged = ownedHistory({
      entries: [...known.values()].filter((row) => !removed.has(row.entry.eventId)),
      removedEventIds: [...removed],
    });
    const prior = ownedHistory({
      entries: [...before.values()],
      removedEventIds: projected.removedEventIds,
    });
    const changed = canonical(prior) !== canonical(merged);
    if (!changed) {
      active();
      return freezeResult({ changed: false, history: prior, historyEpoch, historyRevision });
    }
    if (requestedRevision <= historyRevision) fail('local_changed');

    const lookups = new Map(view.entries.map((row) => [refKey(row.ref), row.lookup]));
    const proveLegacy = createLegacyCookingPinProof(sha256);
    const additions = merged.entries.filter((row) => !before.has(row.entry.eventId));
    const retained = new Set<string>();
    for (const row of additions) {
      active();
      if (row.kind === 'legacy' && row.pin.kind !== 'exact') fail('history_content_mismatch');
      const ref =
        row.kind === 'exact' ? row.entry.contentRef : row.pin.kind === 'exact' ? row.pin.ref : null;
      if (!ref) fail('history_content_mismatch');
      const lookup = lookups.get(refKey(ref));
      if (
        !lookup ||
        lookup.kind !== 'readable' ||
        refKey(lookup.value.revision.ref) !== refKey(ref)
      )
        fail('history_content_mismatch');
      const document = lookup.value.revision.document;
      if (document.recipe.title !== row.entry.recipeTitle) fail('history_content_mismatch');
      if (row.kind === 'exact') {
        if (
          row.entry.photoAssetId !== null &&
          !document.media.some((media) => media.assetId === row.entry.photoAssetId)
        )
          fail('history_content_mismatch');
      } else {
        if (
          document.recipe.photoKey !== row.entry.photoKey ||
          canonical(await proveLegacy(row.entry)) !== canonical(row.pin)
        )
          fail('history_content_mismatch');
      }
      const key = refKey(ref);
      if (!retained.has(key)) {
        await retainCookingRevisionInSnapshot(session, lookup.value.revision, sha256);
        retained.add(key);
      }
    }
    for (const eventId of merged.removedEventIds) {
      await runBound(
        session,
        'INSERT OR IGNORE INTO account_cooking_history_removed(owner_id,event_id) VALUES (?,?)',
        [ownerId, eventId],
      );
      await runBound(
        session,
        'DELETE FROM account_cooking_history WHERE owner_id=? AND event_id=?',
        [ownerId, eventId],
      );
    }
    for (const row of additions) {
      await runBound(
        session,
        'INSERT INTO account_cooking_history(owner_id,event_id,entry_json) VALUES (?,?,?)',
        [ownerId, row.entry.eventId, canonical(row.entry)],
      );
      const pin =
        row.kind === 'exact' ? { kind: 'exact' as const, ref: row.entry.contentRef } : row.pin;
      if (pin.kind !== 'exact') fail('history_content_mismatch');
      await runBound(session, 'INSERT INTO account_history_content_pin VALUES (?,?,?,?,?,NULL)', [
        ownerId,
        row.entry.eventId,
        row.entry.recipeId,
        pin.ref.revisionId,
        pin.ref.contentFingerprint,
      ]);
    }
    await runBound(session, 'UPDATE cooking_state SET history_revision=? WHERE singleton=1', [
      requestedRevision,
    ]);
    // Validate the resulting account row/pin/byte bounds while caller rollback is still possible.
    await readAccountContentHistoryProjection(session, ownerId);
    if ((await session.all('SELECT 1 FROM pragma_foreign_key_check LIMIT 1')).length)
      fail('stored_data_invalid');
    active();
    return freezeResult({
      changed: true,
      history: merged,
      historyEpoch,
      historyRevision: requestedRevision,
    });
  });
  active();
  return result;
}
