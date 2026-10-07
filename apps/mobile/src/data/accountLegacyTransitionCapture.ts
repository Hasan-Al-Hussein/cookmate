import { catalogueMatches } from '@cookmate/contracts';
import {
  canonicalAccountSnapshot,
  type AccountRemoteState,
  type AccountReplicationScope,
  type AccountSnapshotOptions,
} from '@cookmate/account-sync';
import type { Immutable } from '@cookmate/domain';
import {
  canonicalPortableContentJson,
  type PortableContentBackupEnvelope,
} from '../../../../packages/domain/src/portableBackupContent';
import {
  captureAccountContentLocalBundle,
  type AccountContentCaptureOptions,
  type AccountContentLocalCapture,
} from './accountContentCapture';
import { readAccountContentCaptureFence } from './accountContentScopeApproval';
import {
  convertBundledLegacyAccountSnapshot,
  type BundledLegacyAccountConversion,
} from './accountLegacyContentConversion';
import {
  ACCOUNT_JOURNAL_MAX_BYTES,
  exact,
  fail,
  journalKey,
  readJournal,
  remoteState,
  revision,
  uuid,
} from './accountReplicationRecords';
import { freezeResult } from './query';
import type { SqlSession, SqlValue } from './sql';
import {
  ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX,
  accountLegacyContentTransitionKey,
} from './accountLegacyTransitionKeys';
export { accountLegacyContentTransitionKey } from './accountLegacyTransitionKeys';
export interface AccountLegacyTransitionCapture {
  local: AccountContentLocalCapture;
  /** Same-snapshot local evidence only; never included in the upload sidecar. */
  backup: PortableContentBackupEnvelope;
  hasRestoreArchive: boolean;
  legacy: {
    journalDigest: string;
    journalRevision: number;
    base: AccountRemoteState | null;
    observed: { revision: number; snapshotDigest: string | null; updatedAt: string | null };
  };
  /** Original wire observation, never its locally converted projection. */
  remote: AccountRemoteState;
  baseConversion: BundledLegacyAccountConversion | null;
  remoteConversion: BundledLegacyAccountConversion;
}

/**
 * Read-only preparation for the FIRST legacy1/2→3 upgrade. Caller owns one serialized SQL
 * snapshot. Real service authentication, review, staging, CAS and local apply remain separate.
 * A different client already publishing3 requires a distinct adoption path, never a fake legacy
 * observation. No original journal bytes, metadata, recipes or cooking state are written here.
 */
export async function captureAccountLegacyTransitionInSnapshot(
  session: SqlSession,
  inputScope: AccountReplicationScope,
  inputRemote: unknown,
  inputOptions: AccountContentCaptureOptions,
): Promise<Immutable<AccountLegacyTransitionCapture>> {
  if (
    !exact(inputScope, ['ownerId', 'authGeneration']) ||
    !uuid(inputScope.ownerId) ||
    !revision(inputScope.authGeneration) ||
    !uuid(inputOptions.installationId)
  )
    fail('invalid_input');
  const scope = Object.freeze({ ...inputScope });
  const options = { ...inputOptions };
  const remote = remoteState(
    JSON.parse(canonicalPortableContentJson(inputRemote, 2 * 1024 * 1024 + 8192)),
    scope.ownerId,
  );
  if (remote.deletionOperationId !== null) fail('deletion_pending');
  if (!remote.snapshot || remote.revision === 0) fail('stale_server_revision');
  function checkOwner(): undefined {
    const current = options.currentScope();
    if (
      !current ||
      current.ownerId !== scope.ownerId ||
      current.authGeneration !== scope.authGeneration
    )
      fail('account_changed');
    return undefined;
  }
  checkOwner();
  const settingsText = canonicalPortableContentJson(options.getLocalSettings(), 4096);
  const settings = JSON.parse(settingsText) as AccountSnapshotOptions;
  function check(): undefined {
    checkOwner();
    let latest: string;
    try {
      latest = canonicalPortableContentJson(options.getLocalSettings(), 4096);
    } catch {
      return fail('settings_changed');
    }
    if (latest !== settingsText) fail('settings_changed');
    return undefined;
  }
  const hash = async (text: string) => {
    check();
    const result = await options.sha256(text);
    check();
    if (typeof result !== 'string' || !/^[0-9a-f]{64}$/.test(result)) fail('stored_data_invalid');
    return result;
  };
  const guarded: SqlSession = {
    all: async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      check();
      const rows = await session.all<Row>(sql, values);
      check();
      return rows;
    },
    exec: async () => fail('invalid_input'),
    prepare: async () => fail('invalid_input'),
  };
  async function admitNewTransition() {
    const transitionKey = accountLegacyContentTransitionKey(scope.ownerId);
    if (
      (
        await guarded.all('SELECT 1 FROM app_metadata WHERE key GLOB ? AND key<>? LIMIT 1', [
          `${ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX}*`,
          transitionKey,
        ])
      ).length
    )
      fail('different_data_owner');
    if ((await guarded.all('SELECT 1 FROM app_metadata WHERE key=?', [transitionKey])).length)
      fail('operation_pending');
  }
  try {
    if ((await guarded.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8)
      fail('stored_data_invalid');
    await admitNewTransition();
    const { capture: local, backup } = await captureAccountContentLocalBundle(guarded, scope, {
      ...options,
      sha256: hash,
    });
    const hasRestoreArchive =
      (await guarded.all('SELECT 1 FROM portable_restore_operation LIMIT 1')).length !== 0;
    check();
    if (local.fence.binding !== scope.ownerId) fail('different_data_owner');
    if (local.fence.contentJournalDigest !== null) fail('operation_changed');
    if (local.fence.journalDigest === null) fail('recovery_required');
    const journal = await readJournal(guarded, scope.ownerId, hash);
    if (!journal || journal.pending || !journal.observed) fail('recovery_required');
    if ((journal.lastApply?.storeRevision ?? 0) > local.storeRevision) fail('stored_data_invalid');
    const [raw] = await guarded.all<{ value: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END value FROM app_metadata WHERE key=?",
      [ACCOUNT_JOURNAL_MAX_BYTES, journalKey(scope.ownerId)],
    );
    if (typeof raw?.value !== 'string' || (await hash(raw.value)) !== local.fence.journalDigest)
      fail('journal_changed');
    if (journal.observed.revision === 0) fail('recovery_required');
    if (remote.revision < journal.observed.revision) fail('stale_server_revision');
    const remoteDigest = await hash(canonicalAccountSnapshot(remote.snapshot));
    if (
      remote.revision === journal.observed.revision &&
      (remote.updatedAt !== journal.observed.updatedAt ||
        remoteDigest !== journal.observed.snapshotDigest)
    )
      fail('stale_server_revision');
    if (journal.base?.snapshot?.schemaVersion === 2 && remote.snapshot.schemaVersion === 1)
      fail('stale_server_revision');
    if (!catalogueMatches(local.snapshot.catalogue, remote.snapshot.catalogue))
      fail('catalogue_mismatch');
    const baseConversion = journal.base?.snapshot
      ? await convertBundledLegacyAccountSnapshot(journal.base.snapshot, hash)
      : null;
    const remoteConversion = await convertBundledLegacyAccountSnapshot(remote.snapshot, hash);
    const after = await readAccountContentCaptureFence(
      guarded,
      scope.ownerId,
      options.installationId,
      hash,
      settings,
    );
    const { authGeneration: _generation, ...before } = local.fence;
    if (canonicalPortableContentJson(before, 32768) !== canonicalPortableContentJson(after, 32768))
      fail('local_changed');
    await admitNewTransition();
    const result = freezeResult({
      local,
      backup,
      hasRestoreArchive,
      legacy: {
        journalDigest: local.fence.journalDigest,
        journalRevision: journal.revision,
        base: journal.base,
        observed: journal.observed,
      },
      remote,
      baseConversion,
      remoteConversion,
    });
    check();
    return result;
  } catch (error) {
    // Nested codecs can wrap hash errors. A current lifetime/settings failure takes precedence.
    check();
    throw error;
  }
}
