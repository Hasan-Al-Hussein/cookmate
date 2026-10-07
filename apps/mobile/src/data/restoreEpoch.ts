import { StorageFault } from './sql';
import type { SqlSession } from './sql';

/** Restores and account adoption fence pre-registration reviews across independently opened facades. */
export async function readRestoreEpoch(session: SqlSession): Promise<number> {
  const epoch = (
    await session.all<{ epoch: number }>(
      'SELECT COALESCE(MAX(committed_revision), 0) AS epoch FROM portable_restore_operation',
    )
  )[0]?.epoch;
  if (epoch === undefined || !Number.isSafeInteger(epoch) || epoch < 0)
    throw new StorageFault('storage_failure', 'Restore epoch is invalid');
  const accountRow = (
    await session.all<{ value: string | null }>(
      `SELECT CASE WHEN length(CAST(value AS BLOB))<=32 THEN value ELSE NULL END AS value
     FROM app_metadata WHERE key='account-replication:apply-epoch'`,
    )
  )[0];
  if (!accountRow) return epoch;
  if (typeof accountRow.value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(accountRow.value))
    throw new StorageFault('storage_failure', 'Account apply epoch is invalid');
  const accountEpoch = Number(accountRow.value);
  if (!Number.isSafeInteger(accountEpoch) || accountEpoch < 0)
    throw new StorageFault('storage_failure', 'Account apply epoch is invalid');
  return Math.max(epoch, accountEpoch);
}
