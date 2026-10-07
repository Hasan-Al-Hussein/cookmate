import type { Immutable } from '@cookmate/domain';
import {
  ACCOUNT_CONTENT_JOURNAL_MAX_BYTES,
  parseAccountContentJournal,
  type AccountContentReplicationJournal,
} from '../../../../packages/account-sync/src/contentReplicationRecords';
import {
  ACCOUNT_JOURNAL_MAX_BYTES,
  fail,
  journalKey,
  readBinding,
  revision,
  uuid,
} from './accountReplicationRecords';
import type { SqlSession } from './sql';

export const accountContentJournalKey = (ownerId: string) => {
  if (!uuid(ownerId)) fail('invalid_input');
  return `account-replication:content-journal:${ownerId}`;
};
export const accountContentGuestKey = (ownerId: string) => {
  if (!uuid(ownerId)) fail('invalid_input');
  return `account-replication:content-initial-guest:${ownerId}`;
};

/** Reject foreign namespace keys without reading their private values. */
export async function assertAccountContentJournalOwner(session: SqlSession, ownerId: string) {
  for (const [prefix, key] of [
    ['account-replication:content-journal:*', accountContentJournalKey(ownerId)],
    ['account-replication:content-initial-guest:*', accountContentGuestKey(ownerId)],
    ['account-replication:journal:*', journalKey(ownerId)],
  ]) {
    if (
      (
        await session.all('SELECT 1 FROM app_metadata WHERE key GLOB ? AND key<>? LIMIT 1', [
          prefix!,
          key!,
        ])
      ).length
    )
      fail('different_data_owner');
  }
}

export async function readAccountContentJournalState(
  session: SqlSession,
  ownerId: string,
  sha256: (text: string) => Promise<string>,
): Promise<{ journal: Immutable<AccountContentReplicationJournal> | null; digest: string | null }> {
  await assertAccountContentJournalOwner(session, ownerId);
  if (
    !(
      await session.all('SELECT 1 FROM app_metadata WHERE key=?', [
        accountContentJournalKey(ownerId),
      ])
    ).length
  )
    return { journal: null, digest: null };
  if ((await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8)
    fail('stored_data_invalid');
  if ((await readBinding(session)) !== ownerId) fail('different_data_owner');
  const [installation] = await session.all<{ id: string | null }>(
    "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
  );
  if (!installation || !uuid(installation.id)) fail('stored_data_invalid');
  const rows = await session.all<{ bytes: number; value: string | null }>(
    "SELECT length(CAST(value AS BLOB)) bytes,CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END value FROM app_metadata WHERE key=?",
    [ACCOUNT_CONTENT_JOURNAL_MAX_BYTES, accountContentJournalKey(ownerId)],
  );
  const row = rows[0];
  if (row && row.bytes > ACCOUNT_CONTENT_JOURNAL_MAX_BYTES) fail('too_large');
  if (!row || typeof row.value !== 'string' || rows.length !== 1) fail('stored_data_invalid');
  const journal = await parseAccountContentJournal(row.value, ownerId, installation.id, sha256);
  // All consumers, including recovery without a transition marker, require the original
  // legacy bytes bound at staging. Removing both legacy keys cannot erase this obligation.
  const [legacy] = await session.all<{ bytes: number; value: string | null }>(
    "SELECT length(CAST(value AS BLOB)) bytes,CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END value FROM app_metadata WHERE key=?",
    [ACCOUNT_JOURNAL_MAX_BYTES, journalKey(ownerId)],
  );
  if (legacy && legacy.bytes > ACCOUNT_JOURNAL_MAX_BYTES) fail('too_large');
  if ((journal.legacyJournalDigest === null) !== (legacy === undefined)) fail('local_changed');
  if (legacy) {
    if (typeof legacy.value !== 'string') fail('stored_data_invalid');
    const legacyDigest = await sha256(legacy.value);
    if (!/^[0-9a-f]{64}$/.test(legacyDigest)) fail('stored_data_invalid');
    if (legacyDigest !== journal.legacyJournalDigest) fail('local_changed');
  }
  const [clock] = await session.all<{ value: number | null }>(
    "SELECT CASE WHEN typeof(revision)='integer' THEN revision END value FROM state_revision WHERE collection='store'",
  );
  if (!clock || !revision(clock.value)) fail('stored_data_invalid');
  const storeRevision = clock.value;
  if (
    (journal.lastApply?.storeRevision ?? 0) > storeRevision ||
    (journal.pending?.capturedLocal.storeRevision ?? 0) > storeRevision
  )
    fail('stored_data_invalid');
  const digest = await sha256(row.value);
  if (!/^[0-9a-f]{64}$/.test(digest)) fail('stored_data_invalid');
  return { journal, digest };
}
