import {
  ACCOUNT_SETTINGS_KEY,
  fail,
  journalKey,
  readBinding,
  readJournal,
} from './accountReplicationRecords';
import type { SqlSession } from './sql';

/**
 * Read-only precondition for physical6→7 or7→8. A durable server acknowledgement
 * does not settle the local legacy operation; its original handler must finish first.
 */
export async function assertLegacyAccountSettledForContentMigration(
  session: SqlSession,
  sha256: (text: string) => Promise<string>,
): Promise<void> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== 6 && version !== 7) fail('stored_data_invalid');
  const binding = await readBinding(session);
  const key = binding === null ? null : journalKey(binding);
  // A guest cannot own a journal. Foreign/malformed owner keys fail without
  // selecting their payload, even when the body is huge or invalid JSON.
  if (
    (
      await session.all(
        "SELECT 1 FROM app_metadata WHERE key GLOB 'account-replication:journal:*' AND (? IS NULL OR key<>?) LIMIT 1",
        [key, key],
      )
    ).length
  )
    fail('stored_data_invalid');
  if ((await session.all('SELECT 1 FROM app_metadata WHERE key=?', [ACCOUNT_SETTINGS_KEY])).length)
    fail('settings_pending');
  if (binding === null || key === null) return;
  const present = (await session.all('SELECT 1 FROM app_metadata WHERE key=?', [key])).length > 0;
  if (!present) return;
  // Existing strict1/2 decoding validates identity, checksums and retained receipt
  // consistency without rewriting bytes or promoting the stored format.
  const journal = await readJournal(session, binding, sha256);
  if (!journal) fail('stored_data_invalid');
  if (journal.pending !== null) fail('operation_pending');
}
