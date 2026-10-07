import { isUtcInstant } from '@cookmate/contracts';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { accountSnapshotFromBackup } from '@cookmate/account-sync';
import type { AccountLocalCapture, AccountSnapshotOptions } from '@cookmate/account-sync';
import { createPortableBackup, portablePersonalLimits } from '@cookmate/domain';
import type { ShoppingProjectionOptions } from '@cookmate/domain';
import { readAccountScopeApproval } from './accountScopeApproval';
import { fail, readBinding } from './accountReplicationRecords';
import { verifyAccountHistoryContent } from './accountHistoryProjection';
import { readBackupData } from './portableBackup';
import { readRevision, freezeResult } from './query';
import type { SqlSession } from './sql';

export interface AccountExpandedCaptureOptions extends ShoppingProjectionOptions {
  catalogue: Readonly<CatalogueIdentity>;
  now(): string;
}

/** Caller owns one serialized snapshot and auth guard. No approval means no expanded read. */
export async function captureAccountExpandedLocal(
  session: SqlSession,
  ownerId: string,
  settings: AccountSnapshotOptions,
  options: AccountExpandedCaptureOptions,
): Promise<AccountLocalCapture> {
  const schema = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (schema !== 6) fail('scope_review_required');
  const evidence = await readAccountScopeApproval(session, ownerId, options.sha256);
  if (!evidence) fail('scope_review_required');
  const binding = await readBinding(session);
  if (binding !== null && binding !== ownerId) fail('different_data_owner');
  const at = options.now();
  if (!isUtcInstant(at)) fail('invalid_input');
  const includeHistory = evidence.record.historyIncluded;
  const data = await readBackupData(session, true, includeHistory);
  let removedHistoryEventIds: string[] = [];
  if (includeHistory) {
    // Only a history-approved snapshot reads history identifiers. Local withdrawals survive a
    // guest's first sign-in; account removals remain bound to this workspace's accepted owner.
    if (
      (
        await session.all(
          'SELECT 1 FROM account_cooking_history_removed WHERE owner_id<>? LIMIT 1',
          [ownerId],
        )
      ).length
    )
      fail('different_data_owner');
    const removed = await session.all<{ eventId: string }>(
      `SELECT event_id AS eventId FROM cooking_history_withdrawal
       UNION SELECT event_id AS eventId FROM account_cooking_history_removed WHERE owner_id=?
       UNION SELECT event_id AS eventId FROM cooking_event WHERE state='cleared'
       ORDER BY eventId LIMIT ${portablePersonalLimits.history + 1}`,
      [ownerId],
    );
    if (removed.length > portablePersonalLimits.history) fail('too_large');
    removedHistoryEventIds = removed.map((row) => row.eventId);
  }
  const source = await createPortableBackup(
    {
      schemaVersion: 2,
      databaseSchemaVersion: 6,
      createdAt: at,
      catalogue: { ...options.catalogue },
      sourceRevision: await readRevision(session, 'store'),
      data,
    },
    options.sha256,
  );
  const snapshot = accountSnapshotFromBackup(source, settings, {
    schemaVersion: 2,
    includeCookingHistory: includeHistory,
    ...(includeHistory ? { removedHistoryEventIds } : {}),
  });
  if (snapshot.cookingHistory) await verifyAccountHistoryContent(snapshot.cookingHistory, options);
  return freezeResult({
    storeRevision: source.sourceRevision,
    snapshot,
    scope: { version: 2, approvalDigest: evidence.digest, historyIncluded: includeHistory },
  }) as AccountLocalCapture;
}
