import type { AccountReplicationScope, AccountSnapshotOptions } from '@cookmate/account-sync';
import type { Immutable } from '@cookmate/domain';
import { portablePersonalLimits } from '@cookmate/domain';
import {
  createAccountContentScopeApprovalEvidence,
  validateAccountContentScopeApprovalEvidence,
  type AccountContentScopeApprovalEvidence,
} from '../../../../packages/account-sync/src/contentScope';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import {
  ACCOUNT_JOURNAL_MAX_BYTES,
  ACCOUNT_SETTINGS_KEY,
  exact,
  fail,
  journalKey,
  readBinding,
  readJournal,
  readMetadata,
  revision,
  uuid,
  writeMetadata,
} from './accountReplicationRecords';
import type { AccountScopeApprovalCounts } from './accountScopeApproval';
import {
  admitCookingWorkspaceClocks,
  admitLegacyHistoryRows,
  admitLocalCookingEvents,
  readAdoptionInSnapshot,
  requireCookingContentReadVersion,
} from './cookingContentRepository';
import { readAccountCookingScope } from './cookingHistoryRows';
import { freezeResult } from './query';
import { readAccountContentJournalState } from './accountContentJournalStorage';
import {
  ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX,
  accountLegacyContentTransitionKey,
} from './accountLegacyTransitionKeys';
import { readAccountLegacyContentTransitionState } from './accountLegacyTransitionStorage';
import { readRestoreEpoch } from './restoreEpoch';
import {
  StorageFault,
  type SerializedReader,
  type SerializedWriter,
  type SqlSession,
  type SqlValue,
} from './sql';

export const ACCOUNT_CONTENT_SCOPE_APPROVAL_MAX_BYTES = 2048;
type Sha256 = (text: string) => Promise<string>;
const fingerprint = /^[0-9a-f]{64}$/;

export function accountContentScopeApprovalKey(ownerId: string): string {
  if (!uuid(ownerId)) fail('invalid_input');
  return `account-replication:content-scope:${ownerId}`;
}

async function requireContentSchema(session: SqlSession): Promise<7 | 8> {
  try {
    return await requireCookingContentReadVersion(session);
  } catch {
    fail('stored_data_invalid');
  }
}
async function assertInstallation(session: SqlSession, installationId: string): Promise<void> {
  if (!uuid(installationId)) fail('invalid_input');
  const row = (
    await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    )
  )[0];
  if (row?.id !== installationId) fail('stored_data_invalid');
}

/** Local consent evidence only. Neither this record nor its digest establishes remote authority. */
export async function readAccountContentScopeApproval(
  session: SqlSession,
  ownerId: string,
  installationId: string,
  sha256: Sha256,
): Promise<Immutable<AccountContentScopeApprovalEvidence> | null> {
  const key = accountContentScopeApprovalKey(ownerId);
  await requireContentSchema(session);
  await assertInstallation(session, installationId);
  const binding = await readBinding(session);
  if (binding !== null && binding !== ownerId) fail('different_data_owner');
  const value = await readMetadata(session, key, ACCOUNT_CONTENT_SCOPE_APPROVAL_MAX_BYTES);
  if (value === null) return null;
  if (
    !validateAccountContentScopeApprovalEvidence(value) ||
    value.record.ownerId !== ownerId ||
    value.record.installationId !== installationId
  )
    fail('stored_data_invalid');
  const evidence = await createAccountContentScopeApprovalEvidence(value.record, sha256);
  if (value.digest !== evidence.digest) fail('stored_data_invalid');
  return freezeResult(evidence);
}

export interface AccountContentPendingCaptureIdentity {
  operationId: string;
  requestFingerprint: string;
}

function ownPendingIdentity(input: AccountContentPendingCaptureIdentity) {
  if (
    !exact(input, ['operationId', 'requestFingerprint']) ||
    !uuid(input.operationId) ||
    typeof input.requestFingerprint !== 'string' ||
    !fingerprint.test(input.requestFingerprint)
  )
    fail('invalid_input');
  return Object.freeze({
    operationId: input.operationId,
    requestFingerprint: input.requestFingerprint,
  });
}

async function availability(
  session: SqlSession,
  ownerId: string,
  sha256: Sha256,
  pendingIdentity?: AccountContentPendingCaptureIdentity,
) {
  const wanted = pendingIdentity === undefined ? null : ownPendingIdentity(pendingIdentity);
  const key = journalKey(ownerId);
  const transitionKey = accountLegacyContentTransitionKey(ownerId);
  if (!uuid(ownerId)) fail('invalid_input');
  const databaseSchemaVersion = await requireContentSchema(session);
  const binding = await readBinding(session);
  if (binding !== null && binding !== ownerId) fail('different_data_owner');
  if (
    (
      await session.all('SELECT 1 FROM app_metadata WHERE key GLOB ? AND key<>? LIMIT 1', [
        `${ACCOUNT_LEGACY_CONTENT_TRANSITION_PREFIX}*`,
        transitionKey,
      ])
    ).length
  )
    fail('different_data_owner');
  // Foreign journals are rejected from their key alone; no foreign private body is read.
  if (
    (
      await session.all(
        "SELECT 1 FROM app_metadata WHERE key GLOB 'account-replication:journal:*' AND key<>? LIMIT 1",
        [key],
      )
    ).length
  )
    fail('stored_data_invalid');
  const present = (await session.all('SELECT 1 FROM app_metadata WHERE key=?', [key])).length > 0;
  const journal = await readJournal(session, ownerId, sha256);
  if (present && (!journal || binding !== ownerId)) fail('stored_data_invalid');
  if (journal?.pending) fail('operation_pending');
  const contentJournal = await readAccountContentJournalState(session, ownerId, sha256);
  if ((await session.all('SELECT 1 FROM app_metadata WHERE key=?', [transitionKey])).length) {
    const [installation] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (!uuid(installation?.id)) fail('stored_data_invalid');
    const { transition } = await readAccountLegacyContentTransitionState(
      session,
      ownerId,
      installation.id,
      sha256,
    );
    if (!transition) fail('stored_data_invalid');
    if (
      !transition.lastApply &&
      (!wanted ||
        !transition.handoff ||
        wanted.operationId !== transition.localApplyOperationId ||
        wanted.requestFingerprint !== transition.handoff.requestFingerprint)
    )
      fail('operation_pending');
  } else if (contentJournal.journal && (journal?.base || (journal?.observed?.revision ?? 0) > 0)) {
    fail('recovery_required');
  }
  if (wanted) {
    const pending = contentJournal.journal?.pending;
    if (
      !pending ||
      pending.operationId !== wanted.operationId ||
      pending.requestFingerprint !== wanted.requestFingerprint
    )
      fail('operation_changed');
  } else if (contentJournal.journal?.pending) fail('operation_pending');
  // Presence is itself a pending transition, including malformed/null settings evidence.
  if ((await session.all('SELECT 1 FROM app_metadata WHERE key=?', [ACCOUNT_SETTINGS_KEY])).length)
    fail('settings_pending');
  let journalDigest: string | null = null;
  if (present) {
    const row = (
      await session.all<{ value: string | null }>(
        "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END value FROM app_metadata WHERE key=?",
        [ACCOUNT_JOURNAL_MAX_BYTES, key],
      )
    )[0];
    if (typeof row?.value !== 'string') fail('stored_data_invalid');
    journalDigest = await sha256(row.value);
    if (!fingerprint.test(journalDigest)) fail('stored_data_invalid');
  }
  if (wanted && contentJournal.journal?.legacyJournalDigest !== journalDigest)
    fail('local_changed');
  return {
    binding,
    journalDigest,
    databaseSchemaVersion,
    contentJournalDigest: contentJournal.digest,
    pendingScope: wanted ? contentJournal.journal!.scope : null,
  };
}

/** Private schema7/8 admission; old pending operations must settle with their original bytes first. */
export async function assertAccountContentApprovalAvailable(
  session: SqlSession,
  ownerId: string,
  sha256: Sha256,
): Promise<string | null> {
  return (await availability(session, ownerId, sha256)).binding;
}

export interface AccountContentScopeApprovalReview {
  reviewId: string;
  ownerId: string;
  installationId: string;
  scopeVersion: 3;
  /** Metadata counts, not a claim that every entry is valid for capture or upload. */
  counts: AccountScopeApprovalCounts;
  historyIncluded: boolean;
  previousApprovalDigest: string | null;
}
export interface AccountContentScopeApprovalOptions {
  reader: Pick<SerializedReader, 'transaction'>;
  writer: Pick<SerializedWriter, 'transaction' | 'requiresRecovery'>;
  installationId: string;
  currentScope(): AccountReplicationScope | null;
  getLocalSettings(): AccountSnapshotOptions;
  now(): string;
  newId(): string;
  sha256: Sha256;
}
export interface AccountContentScopeApprovalService {
  read(
    scope: AccountReplicationScope,
  ): Promise<Immutable<AccountContentScopeApprovalEvidence> | null>;
  review(scope: AccountReplicationScope): Promise<Immutable<AccountContentScopeApprovalReview>>;
  approve(
    scope: AccountReplicationScope,
    review: Immutable<AccountContentScopeApprovalReview>,
    choice: { historyIncluded: boolean },
  ): Promise<Immutable<AccountContentScopeApprovalEvidence>>;
  close(): void;
}
export interface AccountContentCaptureFence {
  databaseSchemaVersion: 7 | 8;
  contentJournalDigest: string | null;
  ownerId: string;
  installationId: string;
  binding: string | null;
  journalDigest: string | null;
  localSettings: string;
  adoption: string;
  restoreEpoch: number;
  storeRevision: number;
  personalRevision: number;
  personalEpoch: number;
  historyRevision: number;
  historyEpoch: number;
  approval: Immutable<AccountContentScopeApprovalEvidence> | null;
  counts: AccountScopeApprovalCounts;
}
interface ReviewFence extends AccountContentCaptureFence {
  authGeneration: number;
}

function canonicalSettings(input: AccountSnapshotOptions): string {
  let serialized: string;
  try {
    serialized = canonicalPortableContentJson(input, 4096);
  } catch {
    return fail('invalid_input');
  }
  const value: unknown = JSON.parse(serialized);
  if (
    !exact(value, ['appPreferences', 'profile']) ||
    !exact(value.appPreferences, ['theme', 'motion', 'locale']) ||
    !['system', 'light', 'dark'].includes(value.appPreferences.theme as string) ||
    !['system', 'reduced'].includes(value.appPreferences.motion as string) ||
    !['system', 'en', 'ar'].includes(value.appPreferences.locale as string) ||
    !exact(value.profile, ['displayName']) ||
    !(
      value.profile.displayName === null ||
      (typeof value.profile.displayName === 'string' &&
        value.profile.displayName.length > 0 &&
        value.profile.displayName.length <= 120)
    )
  )
    fail('invalid_input');
  return serialized;
}

async function countVisibleHistory(session: SqlSession, epoch: number): Promise<number> {
  const scope = await readAccountCookingScope(session, { contentSchema: true });
  if (!scope) fail('stored_data_invalid');
  await admitLocalCookingEvents(session);
  await admitLegacyHistoryRows(session, 'backup');
  // Same visible identity/removal policy as historyRows, without hydrating duplicate private
  // entries. A later capture still has to prove every selected payload and exact reference.
  const row = (
    await session.all<{ count: number }>(
      `WITH candidates AS (
        SELECT event_id eventId FROM cooking_event WHERE state='saved' AND history_epoch=?
        UNION SELECT event_id FROM imported_cooking_history WHERE history_epoch=?
        UNION SELECT a.event_id FROM account_cooking_history a WHERE a.owner_id=?
          AND NOT EXISTS (SELECT 1 FROM cooking_event old WHERE old.event_id=a.event_id AND (old.state<>'saved' OR old.history_epoch<>?))
          AND NOT EXISTS (SELECT 1 FROM imported_cooking_history old WHERE old.event_id=a.event_id AND old.history_epoch<>?)
      ) SELECT COUNT(*) count FROM candidates c
        WHERE NOT EXISTS (SELECT 1 FROM account_cooking_history_removed r WHERE r.owner_id=? AND r.event_id=c.eventId)
          AND NOT EXISTS (SELECT 1 FROM cooking_history_withdrawal r WHERE r.event_id=c.eventId)`,
      [epoch, epoch, scope.ownerId, epoch, epoch, scope.ownerId],
    )
  )[0];
  if (!row || !revision(row.count) || row.count > portablePersonalLimits.history)
    fail('stored_data_invalid');
  return row.count;
}

/** One SQL-snapshot observation shared by private approval/capture; no payload or withdrawal IDs. */
async function captureFence(
  session: SqlSession,
  ownerId: string,
  installationId: string,
  sha256: Sha256,
  settings: AccountSnapshotOptions,
  pendingIdentity?: AccountContentPendingCaptureIdentity,
): Promise<Immutable<AccountContentCaptureFence>> {
  const localSettings = canonicalSettings(settings);
  await requireContentSchema(session);
  try {
    await admitCookingWorkspaceClocks(session);
  } catch (error) {
    if (error instanceof StorageFault) fail('stored_data_invalid');
    throw error;
  }
  const { pendingScope, ...available } = await availability(
    session,
    ownerId,
    sha256,
    pendingIdentity,
  );
  const approval = await readAccountContentScopeApproval(session, ownerId, installationId, sha256);
  if (
    pendingScope &&
    (!approval ||
      pendingScope.approvalDigest !== approval.digest ||
      pendingScope.historyIncluded !== approval.record.historyIncluded)
  )
    fail('scope_changed');
  const [clocks] = await session.all<{
    storeRevision: number;
    personalRevision: number;
    personalEpoch: number;
    historyRevision: number;
    historyEpoch: number;
  }>(`SELECT
    (SELECT CASE WHEN typeof(revision)='integer' THEN revision END FROM state_revision WHERE collection='store') storeRevision,
    (SELECT CASE WHEN typeof(revision)='integer' THEN revision END FROM personal_state WHERE singleton=1) personalRevision,
    (SELECT CASE WHEN typeof(epoch)='integer' THEN epoch END FROM personal_state WHERE singleton=1) personalEpoch,
    (SELECT CASE WHEN typeof(history_revision)='integer' THEN history_revision END FROM cooking_state WHERE singleton=1) historyRevision,
    (SELECT CASE WHEN typeof(history_epoch)='integer' THEN history_epoch END FROM cooking_state WHERE singleton=1) historyEpoch`);
  if (!clocks || !Object.values(clocks).every(revision)) fail('stored_data_invalid');
  const [personal] = await session.all<Omit<AccountScopeApprovalCounts, 'cookingHistory'>>(`SELECT
    (SELECT COUNT(*) FROM recipe_note WHERE deleted=0) notes,
    (SELECT COUNT(*) FROM personal_collection WHERE deleted=0) collections,
    (SELECT COUNT(*) FROM personal_collection_member m JOIN personal_collection c ON c.collection_id=m.collection_id WHERE m.present=1 AND c.deleted=0) memberships,
    (SELECT COUNT(*) FROM manual_shopping_item WHERE deleted=0) manualItems`);
  if (
    !personal ||
    !Object.values(personal).every(revision) ||
    personal.notes > portablePersonalLimits.notes ||
    personal.collections > portablePersonalLimits.collections ||
    personal.memberships > portablePersonalLimits.memberships ||
    personal.manualItems > portablePersonalLimits.manualItems
  )
    fail('stored_data_invalid');
  return freezeResult({
    ownerId,
    installationId,
    ...available,
    ...clocks,
    localSettings,
    adoption: canonicalPortableContentJson(await readAdoptionInSnapshot(session), 2048),
    restoreEpoch: await readRestoreEpoch(session),
    approval,
    counts: {
      ...personal,
      cookingHistory: await countVisibleHistory(session, clocks.historyEpoch),
    },
  });
}

export function readAccountContentCaptureFence(
  session: SqlSession,
  ownerId: string,
  installationId: string,
  sha256: Sha256,
  settings: AccountSnapshotOptions,
): Promise<Immutable<AccountContentCaptureFence>> {
  return captureFence(session, ownerId, installationId, sha256, settings);
}

/** Re-observe only an exact retained pending request; this grants no apply or remote authority. */
export function readAccountContentPendingCaptureFence(
  session: SqlSession,
  ownerId: string,
  installationId: string,
  sha256: Sha256,
  settings: AccountSnapshotOptions,
  identity: AccountContentPendingCaptureIdentity,
): Promise<Immutable<AccountContentCaptureFence>> {
  return captureFence(
    session,
    ownerId,
    installationId,
    sha256,
    settings,
    ownPendingIdentity(identity),
  );
}

function guardedSession(session: SqlSession, assert: () => undefined): SqlSession {
  return {
    all: async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
      assert();
      const rows = await session.all<Row>(sql, values);
      assert();
      return rows;
    },
    exec: async (sql) => {
      assert();
      await session.exec(sql);
      assert();
    },
    prepare: async (sql) => {
      assert();
      const statement = await session.prepare(sql);
      try {
        assert();
      } catch (error) {
        await statement.finalize();
        throw error;
      }
      return {
        run: async (values) => {
          assert();
          await statement.run(values);
          assert();
        },
        // Cleanup must still run after an owner/close invalidation.
        finalize: () => statement.finalize(),
      };
    },
  };
}

/** Unmounted schema7/8 consent service. It writes one metadata record, never a sync operation. */
export function createAccountContentScopeApprovalService(
  options: AccountContentScopeApprovalOptions,
): AccountContentScopeApprovalService {
  const installationId = options.installationId;
  if (!uuid(installationId)) fail('invalid_input');
  const reviews = new WeakMap<Immutable<AccountContentScopeApprovalReview>, ReviewFence>();
  let closed = false;

  function admission(value: AccountReplicationScope, settings?: string) {
    if (
      !exact(value, ['ownerId', 'authGeneration']) ||
      !uuid(value.ownerId) ||
      !revision(value.authGeneration)
    )
      fail('invalid_input');
    const scope = { ownerId: value.ownerId, authGeneration: value.authGeneration };
    const assert = (): undefined => {
      const current = options.currentScope();
      if (
        closed ||
        !current ||
        current.ownerId !== scope.ownerId ||
        current.authGeneration !== scope.authGeneration
      )
        fail('account_changed');
      if (settings !== undefined && canonicalSettings(options.getLocalSettings()) !== settings)
        fail('local_changed');
      return undefined;
    };
    assert();
    return { scope, assert };
  }

  function guardedHash(assert: () => undefined): Sha256 {
    return async (text) => {
      assert();
      const digest = await options.sha256(text);
      assert();
      return digest;
    };
  }
  async function capture(
    session: SqlSession,
    scope: AccountReplicationScope,
    localSettings: string,
    assert: () => undefined,
  ) {
    const fence: ReviewFence = {
      ...(await readAccountContentCaptureFence(
        guardedSession(session, assert),
        scope.ownerId,
        installationId,
        guardedHash(assert),
        JSON.parse(localSettings) as AccountSnapshotOptions,
      )),
      authGeneration: scope.authGeneration,
    };
    return { fence, approval: fence.approval };
  }

  return Object.freeze<AccountContentScopeApprovalService>({
    read: async (value) => {
      const { scope, assert } = admission(value);
      const result = await options.reader.transaction(
        async (session) => {
          assert();
          return readAccountContentScopeApproval(
            guardedSession(session, assert),
            scope.ownerId,
            installationId,
            guardedHash(assert),
          );
        },
        { kind: 'read_only' },
        assert,
      );
      assert();
      return result;
    },
    review: async (value) => {
      const admitted = admission(value);
      const localSettings = canonicalSettings(options.getLocalSettings());
      const { scope, assert } = admission(admitted.scope, localSettings);
      const result = await options.reader.transaction(
        async (session) => {
          assert();
          const { fence, approval } = await capture(session, scope, localSettings, assert);
          const reviewId = options.newId();
          if (!uuid(reviewId)) fail('invalid_input');
          const review = freezeResult<AccountContentScopeApprovalReview>({
            reviewId,
            ownerId: scope.ownerId,
            installationId,
            scopeVersion: 3,
            counts: fence.counts,
            historyIncluded: approval?.record.historyIncluded ?? false,
            previousApprovalDigest: fence.approval?.digest ?? null,
          });
          assert();
          return { review, fence };
        },
        { kind: 'read_only' },
        assert,
      );
      assert();
      reviews.set(result.review, result.fence);
      return result.review;
    },
    approve: async (value, review, choice) => {
      if (!exact(choice, ['historyIncluded']) || typeof choice.historyIncluded !== 'boolean')
        fail('invalid_input');
      const historyIncluded = choice.historyIncluded;
      const before = reviews.get(review);
      if (!before) fail('scope_review_required');
      const { scope, assert } = admission(value, before.localSettings);
      if (before.ownerId !== scope.ownerId || before.authGeneration !== scope.authGeneration)
        fail('account_changed');
      // Consume authority before any await. Retry uncertain metadata by reading it, then reviewing anew.
      reviews.delete(review);
      const evidence = await options.writer.transaction(
        async (session) => {
          assert();
          const { fence } = await capture(session, scope, before.localSettings, assert);
          if (fence.binding !== before.binding) fail('different_data_owner');
          if (
            fence.approval?.digest !== before.approval?.digest ||
            fence.journalDigest !== before.journalDigest
          )
            fail('scope_changed');
          if (
            canonicalPortableContentJson(fence, 8192) !== canonicalPortableContentJson(before, 8192)
          )
            fail('local_changed');
          const approved = await createAccountContentScopeApprovalEvidence(
            {
              schemaVersion: 1,
              ownerId: scope.ownerId,
              installationId,
              scopeVersion: 3,
              personalApproved: true,
              historyIncluded,
              decidedAt: options.now(),
            },
            guardedHash(assert),
          );
          assert();
          await writeMetadata(
            guardedSession(session, assert),
            accountContentScopeApprovalKey(scope.ownerId),
            approved,
            ACCOUNT_CONTENT_SCOPE_APPROVAL_MAX_BYTES,
          );
          assert();
          return freezeResult(approved);
        },
        { kind: 'none' },
        assert,
      );
      assert();
      return evidence;
    },
    close: () => {
      closed = true;
    },
  });
}
