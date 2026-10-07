import type { Immutable } from '@cookmate/domain';
import {
  ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES,
  parseAccountLegacyContentTransition,
  type AccountLegacyContentTransition,
} from '../../../../packages/account-sync/src/contentLegacyTransition';
import { canonicalAccountContentSnapshot } from '../../../../packages/account-sync/src/contentSnapshot';
import { accountContentCaptureScopesEqual } from '../../../../packages/account-sync/src/contentScope';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import {
  assertAccountContentJournalOwner,
  readAccountContentJournalState,
} from './accountContentJournalStorage';
import { convertBundledLegacyAccountSnapshot } from './accountLegacyContentConversion';
import {
  ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX,
  accountLegacyContentTransitionKey,
} from './accountLegacyTransitionKeys';
import {
  ACCOUNT_JOURNAL_MAX_BYTES,
  fail,
  journalKey,
  readBinding,
  readJournal,
  revision,
  uuid,
} from './accountReplicationRecords';
import { freezeResult } from './query';
import type { SqlSession } from './sql';

const snapshotEvidenceBytes = 2 * 1024 * 1024 + 8192;
const same = (left: unknown, right: unknown, maximum = snapshotEvidenceBytes) =>
  canonicalPortableContentJson(left, maximum) === canonicalPortableContentJson(right, maximum);

async function storedText(session: SqlSession, key: string, maximum: number): Promise<string> {
  const rows = await session.all<{ bytes: number; value: string | null }>(
    "SELECT length(CAST(value AS BLOB)) bytes,CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END value FROM app_metadata WHERE key=?",
    [maximum, key],
  );
  const row = rows[0];
  if (row && row.bytes > maximum) fail('too_large');
  if (rows.length !== 1 || typeof row?.value !== 'string') fail('stored_data_invalid');
  return row.value;
}

/**
 * Read-only integrity evidence. Caller owns one SQL snapshot and supplies guarded SQL/hash
 * ports when owner or lifetime admission is required. Checksums and installed-catalogue
 * conversion do not authenticate a server, approve a review or permit a transition.
 */
export async function readAccountLegacyContentTransitionState(
  session: SqlSession,
  ownerId: string,
  installationId: string,
  sha256: (text: string) => Promise<string>,
): Promise<{
  transition: Immutable<AccountLegacyContentTransition> | null;
  digest: string | null;
}> {
  const hash = sha256;
  if (!uuid(ownerId) || !uuid(installationId) || typeof hash !== 'function') fail('invalid_input');
  const key = accountLegacyContentTransitionKey(ownerId),
    oldKey = journalKey(ownerId);
  const digest = async (text: string) => {
    const value = await hash(text);
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('stored_data_invalid');
    return value;
  };
  // Namespace checks select no private values, including when this owner's sidecar is absent.
  for (const [prefix, ownedKey] of [
    [`${ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX}*`, key],
    ['account-replication:journal:*', oldKey],
  ]) {
    if (
      (
        await session.all('SELECT 1 FROM app_metadata WHERE key GLOB ? AND key<>? LIMIT 1', [
          prefix!,
          ownedKey!,
        ])
      ).length
    )
      fail('different_data_owner');
  }
  await assertAccountContentJournalOwner(session, ownerId);
  if (!(await session.all('SELECT 1 FROM app_metadata WHERE key=?', [key])).length)
    return freezeResult({ transition: null, digest: null });
  if ((await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8)
    fail('stored_data_invalid');
  if ((await readBinding(session)) !== ownerId) fail('different_data_owner');
  const [installation] = await session.all<{ id: string | null }>(
    "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
  );
  if (!installation || installation.id !== installationId) fail('stored_data_invalid');
  const [clock] = await session.all<{ value: number | null }>(
    "SELECT CASE WHEN typeof(revision)='integer' THEN revision END value FROM state_revision WHERE collection='store'",
  );
  if (!clock || !revision(clock.value)) fail('stored_data_invalid');
  const storeRevision = clock.value;
  const raw = await storedText(session, key, ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES);
  const transition = await parseAccountLegacyContentTransition(
    raw,
    ownerId,
    installationId,
    digest,
  );
  if (
    transition.capturedLocal.storeRevision > storeRevision ||
    (transition.lastApply?.storeRevision ?? 0) > storeRevision
  )
    fail('stored_data_invalid');

  // The exact original bytes stay in their original key; never substitute conversion evidence.
  const oldRaw = await storedText(session, oldKey, ACCOUNT_JOURNAL_MAX_BYTES);
  if ((await digest(oldRaw)) !== transition.legacy.journalDigest) fail('stored_data_invalid');
  const old = await readJournal(session, ownerId, digest);
  if (!old || !old.observed) fail('stored_data_invalid');
  if (old.pending !== null) fail('operation_pending');
  if (
    (old.lastApply?.storeRevision ?? 0) > storeRevision ||
    old.revision !== transition.legacy.journalRevision ||
    !same(old.base, transition.legacy.base) ||
    !same(old.observed, transition.legacy.observed, 4096)
  )
    fail('stored_data_invalid');

  const baseConversion = old.base?.snapshot
    ? await convertBundledLegacyAccountSnapshot(old.base.snapshot, digest)
    : null;
  const remoteConversion = await convertBundledLegacyAccountSnapshot(
    transition.remote.snapshot,
    digest,
  );
  if (
    (baseConversion?.convertedDigest ?? null) !== transition.legacy.baseProjectionDigest ||
    remoteConversion.sourceDigest !== transition.remoteDigest ||
    remoteConversion.convertedDigest !== transition.remoteProjectionDigest
  )
    fail('stored_data_invalid');
  if (!transition.capturedLocal.scope.historyIncluded) {
    const remote = remoteConversion.snapshot,
      proposed = transition.proposed;
    if (
      Object.hasOwn(remote, 'cookingHistory') !== Object.hasOwn(proposed, 'cookingHistory') ||
      (Object.hasOwn(remote, 'cookingHistory') &&
        !same(remote.cookingHistory, proposed.cookingHistory))
    )
      fail('stored_data_invalid');
  }

  const { journal } = await readAccountContentJournalState(session, ownerId, digest);
  if (transition.handoff === null) {
    if (journal !== null) fail('stored_data_invalid');
  } else {
    const acknowledgement = transition.acknowledgement!;
    if (
      !journal ||
      journal.installationId !== installationId ||
      journal.legacyJournalDigest !== transition.legacy.journalDigest
    )
      fail('stored_data_invalid');
    if (transition.lastApply === null) {
      const pending = journal.pending;
      if (
        journal.base !== null ||
        journal.lastApply !== null ||
        !pending ||
        pending.operationId !== transition.localApplyOperationId ||
        pending.requestFingerprint !== transition.handoff.requestFingerprint ||
        pending.mode !== 'pull' ||
        pending.acknowledgement !== null ||
        pending.remote.revision !== acknowledgement.revision ||
        pending.remote.updatedAt !== acknowledgement.committedAt ||
        pending.proposedDigest !== transition.proposedDigest ||
        !accountContentCaptureScopesEqual(journal.scope, transition.capturedLocal.scope) ||
        !same(pending.capturedLocal, transition.capturedLocal) ||
        canonicalAccountContentSnapshot(pending.proposed) !==
          canonicalAccountContentSnapshot(transition.proposed)
      )
        fail('stored_data_invalid');
      // The private journal codec also binds its pull's exact remote snapshot and observation.
    } else {
      const completed = transition.lastApply,
        actual = journal.lastApply,
        base = journal.base;
      if (
        !actual ||
        !base ||
        actual.storeRevision < completed.storeRevision ||
        actual.serverRevision < completed.serverRevision
      )
        fail('stored_data_invalid');
      if (
        (actual.operationId === completed.operationId ||
          actual.storeRevision === completed.storeRevision) &&
        !same(actual, completed, 4096)
      )
        fail('stored_data_invalid');
      if (
        base.revision === acknowledgement.revision &&
        (base.updatedAt !== acknowledgement.committedAt ||
          canonicalAccountContentSnapshot(base.snapshot) !==
            canonicalAccountContentSnapshot(transition.proposed))
      )
        fail('stored_data_invalid');
    }
  }
  return freezeResult({ transition, digest: await digest(raw) });
}
