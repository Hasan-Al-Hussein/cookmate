import {
  AccountSnapshotError,
  emptyAccountSnapshot,
  type AccountCommitReceipt,
  type AccountMergeResolutions,
  type AccountReplicationScope,
} from '@cookmate/account-sync';
import type { Immutable } from '@cookmate/domain';
import {
  accountContentPendingFingerprint,
  normalizeAccountContentRemoteState,
  parseAccountContentJournal,
  serializeAccountContentJournal,
  type AccountContentPendingDraft,
  type AccountContentRemoteState,
  type AccountContentReplicationJournal,
} from '../../../../packages/account-sync/src/contentReplicationRecords';
import {
  canonicalAccountContentSnapshot,
  type AccountContentSnapshot,
} from '../../../../packages/account-sync/src/contentSnapshot';
import { validateAccountContentCaptureScope } from '../../../../packages/account-sync/src/contentScope';
import { canonicalPortableContentJson } from '../../../../packages/domain/src/portableBackupContent';
import {
  mergeAccountContentSnapshots,
  type AccountContentMergeResult,
} from '../../../../packages/account-sync/src/contentMerge';
import {
  captureAccountContentLocalBundle,
  type AccountContentCaptureOptions,
  type AccountContentLocalCapture,
} from './accountContentCapture';
import {
  createAccountContentRemovalReview,
  resolveAccountContentRemovalReview,
  assertAccountContentRemovalResolution,
  type AccountContentRemovalChoices,
  type AccountContentRemovalReview,
  type AccountContentRemovalResolution,
} from './accountContentRemovalReview';
import { freezeResult } from './query';
import {
  accountContentGuestKey,
  accountContentJournalKey,
  readAccountContentJournalState,
} from './accountContentJournalStorage';
import { readAccountLegacyContentTransitionState } from './accountLegacyTransitionStorage';
import {
  ACCOUNT_BINDING_KEY,
  commitReceipt,
  exact,
  fail,
  readBinding,
  readJournal,
  revision,
  uuid,
  writeMetadata,
} from './accountReplicationRecords';
import {
  runBound,
  type SerializedReader,
  type SerializedWriter,
  type SqlSession,
  type SqlValue,
} from './sql';

interface Options extends AccountContentCaptureOptions {
  reader: Pick<SerializedReader, 'transaction'>;
  writer: Pick<SerializedWriter, 'transaction' | 'requiresRecovery'>;
}
export interface AccountContentStageInput {
  operationId: string;
  expectedJournalRevision: number;
  expectedDeviceDataOwnerId: string | null;
  initialImportReviewed: boolean;
  capturedLocal: AccountContentLocalCapture;
  remote: AccountContentRemoteState;
  proposed: AccountContentSnapshot;
  mode: 'push' | 'pull';
}
interface RecoveryInput {
  operationId: string;
  requestFingerprint: string;
}
export interface AccountContentRejectedPush extends RecoveryInput {
  expectedJournalRevision: number;
  reason: 'needs_review';
}
export interface AccountContentPushReview {
  operationId: string;
  initialImportRequired: boolean;
  /** Exact reviewed sides for presentation; not staging or remote-write authority. */
  comparison: { local: AccountContentSnapshot; account: AccountContentSnapshot | null };
  merge: AccountContentMergeResult;
  removalReview: AccountContentRemovalReview | null;
}
export interface AccountContentPushChoices {
  initialImportReviewed: boolean;
  resolutions?: AccountMergeResolutions;
  removalChoices?: AccountContentRemovalChoices;
}
interface PushCapability {
  scope: Readonly<AccountReplicationScope>;
  operationId: string;
  remote: Immutable<AccountContentRemoteState>;
  base: Immutable<AccountContentRemoteState> | null;
  journalRevision: number;
  bundle: Awaited<ReturnType<typeof captureAccountContentLocalBundle>>;
  hasRestoreArchive: boolean;
  resolutions: AccountMergeResolutions;
  removalReview: Immutable<AccountContentRemovalReview> | null;
  reviewedCandidate: string | null;
  submitted: string | null;
}
interface PushAdmission {
  capability: PushCapability;
  resolution: Immutable<AccountContentRemovalResolution>;
}
const normalChoicesLimit = 32768;
const removalChoicesLimit = 1024 * 1024;
function normalChoices(input: unknown): AccountMergeResolutions {
  let value: unknown;
  try {
    value = JSON.parse(canonicalPortableContentJson(input, normalChoicesLimit));
  } catch {
    return fail('invalid_input');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length > 1000 ||
    Object.entries(value).some(
      ([key, choice]) => !key || (choice !== 'local' && choice !== 'account'),
    )
  )
    fail('invalid_input');
  return freezeResult(value as AccountMergeResolutions);
}
function pushChoices(input: unknown, defaults: AccountMergeResolutions) {
  let value: unknown;
  try {
    value = JSON.parse(
      canonicalPortableContentJson(input, normalChoicesLimit + removalChoicesLimit + 1024),
    );
  } catch {
    return fail('invalid_input');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exact(value, [
      'initialImportReviewed',
      ...(Object.hasOwn(value, 'resolutions') ? ['resolutions'] : []),
      ...(Object.hasOwn(value, 'removalChoices') ? ['removalChoices'] : []),
    ]) ||
    typeof value.initialImportReviewed !== 'boolean'
  )
    fail('invalid_input');
  const removals: unknown = Object.hasOwn(value, 'removalChoices') ? value.removalChoices : {};
  if (
    !removals ||
    typeof removals !== 'object' ||
    Array.isArray(removals) ||
    Object.values(removals).some(
      (choice) => choice !== 'keep_local' && choice !== 'save_account_version',
    )
  )
    fail('invalid_input');
  canonicalPortableContentJson(removals, removalChoicesLimit);
  return freezeResult({
    initialImportReviewed: value.initialImportReviewed,
    resolutions: normalChoices(Object.hasOwn(value, 'resolutions') ? value.resolutions : defaults),
    removalChoices: removals as AccountContentRemovalChoices,
  });
}
function pushMerge(
  capability: Pick<PushCapability, 'base' | 'bundle' | 'remote'>,
  resolutions: AccountMergeResolutions,
) {
  // Only a review ancestor for a first import; this is never stored as an accepted account base.
  const empty: AccountContentSnapshot = {
    ...emptyAccountSnapshot(capability.bundle.capture.snapshot.catalogue, {
      appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
      profile: { displayName: null },
    }),
    schemaVersion: 3,
    personal: { notes: [], collections: [], memberships: [], manualItems: [] },
    planReferences: [],
  };
  try {
    return mergeAccountContentSnapshots({
      base: capability.base?.snapshot ?? empty,
      local: capability.bundle.capture.snapshot,
      account: capability.remote.snapshot ?? empty,
      contentScope: {
        schemaVersion: 3,
        historyIncluded: capability.bundle.capture.scope.historyIncluded,
      },
      resolutions,
      reviewPersonalRemovals: true,
    });
  } catch (error) {
    if (error instanceof AccountSnapshotError) fail('invalid_input');
    throw error;
  }
}
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const same = (a: unknown, b: unknown) =>
  canonicalPortableContentJson(a) === canonicalPortableContentJson(b);
function next(value: number) {
  if (!revision(value) || !Number.isSafeInteger(value + 1)) fail('stored_data_invalid');
  return value + 1;
}
function recoveryInput(input: unknown): RecoveryInput {
  if (
    !exact(input, ['operationId', 'requestFingerprint']) ||
    !uuid(input.operationId) ||
    !fingerprint(input.requestFingerprint)
  )
    fail('invalid_input');
  return { operationId: input.operationId, requestFingerprint: input.requestFingerprint };
}

/** Private metadata staging/recovery only. This performs no remote call or cooking-data apply. */
export function createAccountContentJournalRepository(inputOptions: Options) {
  const options = {
    ...inputOptions,
    catalogue: JSON.parse(
      canonicalPortableContentJson(inputOptions.catalogue, 4096),
    ) as AccountContentCaptureOptions['catalogue'],
  };
  const installationId = options.installationId;
  if (!uuid(installationId)) fail('invalid_input');
  let closed = false;
  const pushReviews = new WeakMap<object, PushCapability>();
  function access(value: AccountReplicationScope, checkSettings = false) {
    if (
      !exact(value, ['ownerId', 'authGeneration']) ||
      !uuid(value.ownerId) ||
      !revision(value.authGeneration)
    )
      fail('invalid_input');
    const scope = Object.freeze({ ownerId: value.ownerId, authGeneration: value.authGeneration });
    function owner(): undefined {
      const current = options.currentScope();
      if (
        closed ||
        !current ||
        current.ownerId !== scope.ownerId ||
        current.authGeneration !== scope.authGeneration
      )
        fail('account_changed');
      return undefined;
    }
    owner();
    const settingsText = checkSettings
      ? canonicalPortableContentJson(options.getLocalSettings(), 4096)
      : null;
    function check(): undefined {
      owner();
      if (
        settingsText !== null &&
        canonicalPortableContentJson(options.getLocalSettings(), 4096) !== settingsText
      )
        fail('settings_changed');
      return undefined;
    }
    check();
    const hash = async (text: string) => {
      check();
      const digest = await options.sha256(text);
      check();
      if (!fingerprint(digest)) fail('stored_data_invalid');
      return digest;
    };
    const guarded = (session: SqlSession): SqlSession => ({
      all: async <Row extends object>(sql: string, values?: readonly SqlValue[]) => {
        check();
        const rows = await session.all<Row>(sql, values);
        check();
        return rows;
      },
      exec: async (sql) => {
        check();
        await session.exec(sql);
        check();
      },
      prepare: async (sql) => {
        check();
        const statement = await session.prepare(sql);
        try {
          check();
        } catch (error) {
          await statement.finalize();
          throw error;
        }
        return {
          run: async (values) => {
            check();
            await statement.run(values);
            check();
          },
          finalize: () => statement.finalize(),
        };
      },
    });
    async function workspace(session: SqlSession) {
      check();
      if (
        (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version !== 8
      )
        fail('stored_data_invalid');
      const [row] = await session.all<{ id: string | null }>(
        "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
      );
      if (row?.id !== installationId) fail('different_data_owner');
      const binding = await readBinding(session);
      if (binding !== null && binding !== scope.ownerId) fail('different_data_owner');
      return binding;
    }
    async function readState(session: SqlSession) {
      await workspace(session);
      const { transition } = await readAccountLegacyContentTransitionState(
        session,
        scope.ownerId,
        installationId,
        hash,
      );
      if (!transition) {
        const legacy = await readJournal(session, scope.ownerId, hash);
        const existing = await readAccountContentJournalState(session, scope.ownerId, hash);
        if (existing.journal && (legacy?.base || (legacy?.observed?.revision ?? 0) > 0))
          fail('recovery_required');
        return existing;
      }
      return readAccountContentJournalState(session, scope.ownerId, hash);
    }
    return { scope, check, hash, guarded, workspace, readState };
  }
  async function read(scope: AccountReplicationScope) {
    const context = access(scope);
    const value = await options.reader.transaction(
      async (raw) => (await context.readState(context.guarded(raw))).journal,
      { kind: 'read_only' },
    );
    context.check();
    return value;
  }
  async function recover(scope: AccountReplicationScope, input: RecoveryInput) {
    const context = access(scope);
    const wanted = recoveryInput(input);
    const journal = await read(context.scope);
    context.check();
    if (!journal) return null;
    const operation =
      journal.pending?.operationId === wanted.operationId ? journal.pending : journal.lastApply;
    if (!operation || operation.operationId !== wanted.operationId) return null;
    if (operation.requestFingerprint !== wanted.requestFingerprint) fail('operation_changed');
    return journal;
  }
  async function write(session: SqlSession, value: unknown, context: ReturnType<typeof access>) {
    const serialized = await serializeAccountContentJournal(
      value,
      context.scope.ownerId,
      installationId,
      context.hash,
    );
    await runBound(
      session,
      'INSERT INTO app_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [accountContentJournalKey(context.scope.ownerId), serialized],
    );
    return parseAccountContentJournal(
      serialized,
      context.scope.ownerId,
      installationId,
      context.hash,
    );
  }
  async function idle(session: SqlSession) {
    if (
      (
        await session.all(
          "SELECT 1 FROM pending_intent WHERE phase NOT IN ('settled','cancelled') LIMIT 1",
        )
      ).length ||
      (
        await session.all(
          "SELECT 1 FROM assistant_intent_context WHERE lifecycle='awaiting_response' LIMIT 1",
        )
      ).length ||
      (await session.all('SELECT 1 FROM direct_command_recovery LIMIT 1')).length
    )
      fail('active_actions');
    if (
      (
        await session.all(
          "SELECT 1 FROM command_slot s JOIN pending_intent p ON p.user_intent_id=s.user_intent_id LEFT JOIN operation_receipt r ON r.operation_id=s.operation_id WHERE p.phase='settled' AND r.operation_id IS NULL LIMIT 1",
        )
      ).length
    )
      fail('recovery_required');
  }
  async function reviewPush(
    scope: AccountReplicationScope,
    input: Immutable<{ operationId: string; remote: AccountContentRemoteState }>,
    inputResolutions?: AccountMergeResolutions,
  ): Promise<Immutable<AccountContentPushReview>> {
    const context = access(scope, true);
    const owned: unknown = JSON.parse(canonicalPortableContentJson(input, 2 * 1024 * 1024 + 8192));
    if (!exact(owned, ['operationId', 'remote']) || !uuid(owned.operationId)) fail('invalid_input');
    const operationId = owned.operationId,
      remote = normalizeAccountContentRemoteState(owned.remote, context.scope.ownerId),
      resolutions = normalChoices(inputResolutions ?? {});
    if (remote.deletionOperationId !== null) fail('deletion_pending');
    try {
      const capability = await options.reader.transaction(
        async (raw) => {
          const session = context.guarded(raw);
          const current = (await context.readState(session)).journal;
          if (current?.pending) fail('operation_pending');
          if (current?.lastApply?.operationId === operationId) fail('operation_changed');
          await idle(session);
          const bundle = await captureAccountContentLocalBundle(session, context.scope, {
            ...options,
            sha256: context.hash,
          });
          const hasRestoreArchive =
            (await session.all('SELECT 1 FROM portable_restore_operation LIMIT 1')).length > 0;
          const observed = {
            revision: remote.revision,
            updatedAt: remote.updatedAt,
            snapshotDigest: remote.snapshot
              ? await context.hash(canonicalAccountContentSnapshot(remote.snapshot))
              : null,
          };
          if (
            current?.observed &&
            (observed.revision < current.observed.revision ||
              (observed.revision === current.observed.revision &&
                !same(observed, current.observed)))
          )
            fail('stale_server_revision');
          const value = {
            scope: context.scope,
            operationId,
            remote,
            base: current?.base ?? null,
            journalRevision: current?.revision ?? 0,
            bundle,
            hasRestoreArchive,
            resolutions,
          };
          const merge = pushMerge(value, resolutions);
          const removalReview =
            merge.status === 'merged'
              ? createAccountContentRemovalReview(merge.snapshot, bundle.backup, hasRestoreArchive)
              : null;
          return {
            ...value,
            removalReview,
            reviewedCandidate:
              merge.status === 'merged' ? canonicalAccountContentSnapshot(merge.snapshot) : null,
            submitted: null,
          } satisfies PushCapability;
        },
        { kind: 'read_only' },
      );
      context.check();
      const result = freezeResult({
        operationId,
        initialImportRequired: capability.base === null,
        comparison: {
          local: capability.bundle.capture.snapshot,
          account: capability.remote.snapshot,
        },
        merge: pushMerge(capability, resolutions),
        removalReview: capability.removalReview,
      });
      pushReviews.set(result, capability);
      context.check();
      return result;
    } catch (error) {
      context.check();
      throw error;
    }
  }
  async function stageReviewedPush(
    scope: AccountReplicationScope,
    review: Immutable<AccountContentPushReview>,
    input: AccountContentPushChoices,
  ): Promise<Immutable<AccountContentReplicationJournal>> {
    const context = access(scope, true);
    const capability = review && typeof review === 'object' ? pushReviews.get(review) : undefined;
    if (!capability || !same(capability.scope, context.scope)) fail('local_changed');
    const choices = pushChoices(input, capability.resolutions);
    if (capability.base === null && !choices.initialImportReviewed) fail('initial_review_required');
    const merged = pushMerge(capability, choices.resolutions);
    if (merged.status !== 'merged') fail('invalid_input');
    const candidateText = canonicalAccountContentSnapshot(merged.snapshot);
    let removalReview = capability.removalReview;
    if (removalReview) {
      if (capability.reviewedCandidate !== candidateText) fail('recovery_required');
    } else {
      removalReview = createAccountContentRemovalReview(
        merged.snapshot,
        capability.bundle.backup,
        capability.hasRestoreArchive,
      );
      if (removalReview.conflicts.length) fail('recovery_required');
    }
    const resolution = resolveAccountContentRemovalReview(removalReview, choices.removalChoices);
    const submitted = canonicalPortableContentJson({ choices, proposed: resolution.snapshot });
    if (capability.submitted !== null && capability.submitted !== submitted)
      fail('operation_changed');
    capability.submitted = submitted;
    const request = freezeResult({
      operationId: capability.operationId,
      expectedJournalRevision: capability.journalRevision,
      expectedDeviceDataOwnerId: capability.bundle.capture.fence.binding,
      initialImportReviewed: choices.initialImportReviewed,
      capturedLocal: capability.bundle.capture,
      remote: capability.remote,
      proposed: resolution.snapshot,
      mode: 'push' as const,
    });
    const value = await stageInternal(context.scope, request, { capability, resolution });
    context.check();
    return value;
  }
  function stage(scope: AccountReplicationScope, input: Immutable<AccountContentStageInput>) {
    // The public raw path has no argument through which a caller can supply push authority.
    return stageInternal(scope, input);
  }
  async function stageInternal(
    scope: AccountReplicationScope,
    input: Immutable<AccountContentStageInput>,
    pushAdmission?: PushAdmission,
  ): Promise<Immutable<AccountContentReplicationJournal>> {
    const context = access(scope, pushAdmission !== undefined);
    // Own the entire request before any asynchronous hashing or SQL work.
    let value: AccountContentStageInput;
    try {
      value = JSON.parse(canonicalPortableContentJson(input)) as AccountContentStageInput;
    } catch {
      return fail('invalid_input');
    }
    if (
      !exact(value, [
        'operationId',
        'expectedJournalRevision',
        'expectedDeviceDataOwnerId',
        'initialImportReviewed',
        'capturedLocal',
        'remote',
        'proposed',
        'mode',
      ]) ||
      !uuid(value.operationId) ||
      !revision(value.expectedJournalRevision) ||
      (value.expectedDeviceDataOwnerId !== null && !uuid(value.expectedDeviceDataOwnerId)) ||
      typeof value.initialImportReviewed !== 'boolean' ||
      !['push', 'pull'].includes(value.mode) ||
      !exact(value.capturedLocal, ['storeRevision', 'snapshot', 'scope', 'fence']) ||
      !revision(value.capturedLocal.storeRevision) ||
      !validateAccountContentCaptureScope(value.capturedLocal.scope) ||
      !value.capturedLocal.fence ||
      typeof value.capturedLocal.fence !== 'object'
    )
      fail('invalid_input');
    const legacyJournalDigest = value.capturedLocal.fence.journalDigest;
    if (legacyJournalDigest !== null && !fingerprint(legacyJournalDigest)) fail('invalid_input');
    const capturedLocal = {
      storeRevision: value.capturedLocal.storeRevision,
      snapshot: value.capturedLocal.snapshot,
      scope: value.capturedLocal.scope,
      fenceDigest: await context.hash(
        canonicalPortableContentJson(value.capturedLocal.fence, 32768),
      ),
    };
    const draft: AccountContentPendingDraft = {
      operationId: value.operationId,
      mode: value.mode,
      capturedLocal,
      remote: JSON.parse(
        canonicalPortableContentJson(
          normalizeAccountContentRemoteState(value.remote, context.scope.ownerId),
        ),
      ) as AccountContentRemoteState,
      proposed: JSON.parse(
        canonicalAccountContentSnapshot(value.proposed),
      ) as AccountContentSnapshot,
    };
    const requestFingerprint = await accountContentPendingFingerprint(
      context.scope.ownerId,
      installationId,
      legacyJournalDigest,
      draft,
      context.hash,
    );
    const proposedDigest = await context.hash(canonicalAccountContentSnapshot(draft.proposed));
    const observed = {
      revision: draft.remote.revision,
      updatedAt: draft.remote.updatedAt,
      snapshotDigest: draft.remote.snapshot
        ? await context.hash(canonicalAccountContentSnapshot(draft.remote.snapshot))
        : null,
    };
    const beforeSettings = canonicalPortableContentJson(options.getLocalSettings(), 4096);
    const commitGuard = () => {
      context.check();
      if (canonicalPortableContentJson(options.getLocalSettings(), 4096) !== beforeSettings)
        fail('settings_changed');
      return undefined;
    };
    let attemptedWrite = false;
    try {
      const result = await options.writer.transaction(
        async (raw) => {
          const session = context.guarded(raw),
            binding = await context.workspace(session);
          const current = (await context.readState(session)).journal;
          // Retained operation recovery precedes recapture: pending work intentionally blocks capture.
          if (current?.pending) {
            if (current.pending.operationId !== value.operationId) fail('operation_pending');
            if (current.pending.requestFingerprint !== requestFingerprint)
              fail('operation_changed');
            return current;
          }
          if (current?.lastApply?.operationId === value.operationId) {
            if (current.lastApply.requestFingerprint !== requestFingerprint)
              fail('operation_changed');
            return current;
          }
          if (value.mode === 'push' && !pushAdmission) fail('recovery_required');
          if (
            binding !== value.expectedDeviceDataOwnerId ||
            (current?.revision ?? 0) !== value.expectedJournalRevision
          )
            fail('journal_changed');
          await idle(session);
          const bundle = await captureAccountContentLocalBundle(session, context.scope, {
            ...options,
            sha256: context.hash,
          });
          const live = bundle.capture;
          if (!same(live, value.capturedLocal)) fail('local_changed');
          if (value.mode === 'push') {
            if (!pushAdmission || !same(pushAdmission.capability.scope, context.scope))
              fail('local_changed');
            if (!same(pushAdmission.capability.base, current?.base ?? null))
              fail('journal_changed');
            const hasRestoreArchive =
              (await session.all('SELECT 1 FROM portable_restore_operation LIMIT 1')).length > 0;
            assertAccountContentRemovalResolution(
              pushAdmission.resolution,
              draft.proposed,
              bundle.backup,
              hasRestoreArchive,
            );
          }
          const legacy = await readJournal(session, context.scope.ownerId, context.hash);
          // A legacy observation only permits ordinary content3 work after the separately
          // reviewed handoff has a matching, genuine local completion in this database.
          if (legacy?.base || (legacy?.observed?.revision ?? 0) > 0) {
            const { transition } = await readAccountLegacyContentTransitionState(
              session,
              context.scope.ownerId,
              installationId,
              context.hash,
            );
            if (!transition?.lastApply) fail('recovery_required');
          }
          if (current && current.legacyJournalDigest !== legacyJournalDigest)
            fail('journal_changed');
          if (
            current?.observed &&
            (observed.revision < current.observed.revision ||
              (observed.revision === current.observed.revision &&
                !same(observed, current.observed)))
          )
            fail('stale_server_revision');
          if (draft.remote.deletionOperationId !== null) fail('deletion_pending');
          if (binding === null) {
            if (!value.initialImportReviewed) fail('initial_review_required');
            if (
              current ||
              (
                await session.all('SELECT 1 FROM app_metadata WHERE key=?', [
                  accountContentGuestKey(context.scope.ownerId),
                ])
              ).length
            )
              fail('stored_data_invalid');
            const archive = canonicalPortableContentJson({
              schemaVersion: 3,
              ownerId: context.scope.ownerId,
              installationId,
              capturedLocal,
            });
            await runBound(session, 'INSERT INTO app_metadata(key,value) VALUES (?,?)', [
              accountContentGuestKey(context.scope.ownerId),
              archive,
            ]);
            await writeMetadata(
              session,
              ACCOUNT_BINDING_KEY,
              { schemaVersion: 1, ownerId: context.scope.ownerId },
              256,
            );
          }
          attemptedWrite = true;
          return write(
            session,
            {
              schemaVersion: 3,
              ownerId: context.scope.ownerId,
              installationId,
              revision: next(current?.revision ?? 0),
              legacyJournalDigest,
              scope: capturedLocal.scope,
              base: current?.base ?? null,
              observed,
              lastApply: current?.lastApply ?? null,
              pending: { ...draft, requestFingerprint, proposedDigest, acknowledgement: null },
            },
            context,
          );
        },
        { kind: 'none' },
        commitGuard,
      );
      commitGuard();
      return result;
    } catch (error) {
      commitGuard();
      if (attemptedWrite) {
        const saved = await recover(context.scope, {
          operationId: value.operationId,
          requestFingerprint,
        });
        commitGuard();
        if (saved) return saved;
      }
      throw error;
    }
  }
  async function recordAcknowledgement(
    scope: AccountReplicationScope,
    input: RecoveryInput & { receipt: AccountCommitReceipt },
  ) {
    const context = access(scope);
    const owned: unknown = JSON.parse(canonicalPortableContentJson(input, 4096));
    if (!exact(owned, ['operationId', 'requestFingerprint', 'receipt'])) fail('invalid_input');
    const wanted = recoveryInput({
      operationId: owned.operationId,
      requestFingerprint: owned.requestFingerprint,
    });
    let wantedReceipt: AccountCommitReceipt | null = null,
      attemptedWrite = false;
    try {
      const result = await options.writer.transaction(
        async (raw) => {
          const session = context.guarded(raw),
            current = (await context.readState(session)).journal;
          const pending = current?.pending;
          if (
            !current ||
            !pending ||
            pending.operationId !== wanted.operationId ||
            pending.requestFingerprint !== wanted.requestFingerprint ||
            pending.mode !== 'push'
          )
            fail('operation_changed');
          wantedReceipt = commitReceipt(
            owned.receipt,
            context.scope.ownerId,
            wanted.operationId,
            pending.remote.revision,
          );
          if (pending.acknowledgement) {
            if (!same(pending.acknowledgement, wantedReceipt)) fail('operation_changed');
            return current;
          }
          attemptedWrite = true;
          return write(
            session,
            {
              ...current,
              revision: next(current.revision),
              pending: { ...pending, acknowledgement: wantedReceipt },
            },
            context,
          );
        },
        { kind: 'none' },
        context.check,
      );
      context.check();
      return result;
    } catch (error) {
      context.check();
      if (attemptedWrite && wantedReceipt) {
        const saved = await recover(context.scope, wanted);
        context.check();
        if (saved?.pending?.acknowledgement && same(saved.pending.acknowledgement, wantedReceipt))
          return saved;
      }
      throw error;
    }
  }
  /**
   * Trusted caller boundary, matching the legacy repository: invoke only for the exact commit
   * call's validated AccountRemoteError('needs_review'). The service checks an existing receipt
   * before its CAS check, so this response proves that request was not committed. Missing ACKs,
   * timeouts, cancellation and other errors do not authorize discarding anything. This method
   * neither calls the network nor authenticates a caller-supplied reason as remote evidence.
   */
  async function discardRejected(
    scope: AccountReplicationScope,
    input: AccountContentRejectedPush,
  ): Promise<Immutable<AccountContentReplicationJournal>> {
    const context = access(scope);
    const owned: unknown = JSON.parse(canonicalPortableContentJson(input, 4096));
    if (
      !exact(owned, ['operationId', 'requestFingerprint', 'expectedJournalRevision', 'reason']) ||
      !revision(owned.expectedJournalRevision) ||
      owned.reason !== 'needs_review'
    )
      fail('invalid_input');
    const wanted = recoveryInput({
      operationId: owned.operationId,
      requestFingerprint: owned.requestFingerprint,
    });
    const expectedJournalRevision = owned.expectedJournalRevision;
    const attempt: { expected: Immutable<AccountContentReplicationJournal> | null } = {
      expected: null,
    };
    try {
      const result = await options.writer.transaction(
        async (raw) => {
          const session = context.guarded(raw),
            current = (await context.readState(session)).journal;
          if (!current || current.revision !== expectedJournalRevision) fail('journal_changed');
          const pending = current.pending;
          if (
            !pending ||
            pending.operationId !== wanted.operationId ||
            pending.requestFingerprint !== wanted.requestFingerprint ||
            pending.mode !== 'push' ||
            pending.acknowledgement !== null
          )
            fail('operation_changed');
          attempt.expected = { ...current, revision: next(current.revision), pending: null };
          const saved = await write(session, attempt.expected, context);
          if ((await context.workspace(session)) !== context.scope.ownerId)
            fail('different_data_owner');
          return saved;
        },
        { kind: 'none' },
        context.check,
      );
      context.check();
      return result;
    } catch (error) {
      context.check();
      const expected = attempt.expected;
      if (expected) {
        // Resolve only this call's lost local COMMIT acknowledgement by exact readback. There
        // is no new cancellation receipt: absence alone, or a later journal, proves no identity.
        const saved = await read(context.scope);
        context.check();
        if (
          saved?.revision === expected.revision &&
          saved.pending === null &&
          same(saved, expected)
        )
          return saved;
      }
      throw error;
    }
  }
  return Object.freeze({
    read,
    recover,
    stage,
    reviewPush,
    stageReviewedPush,
    recordAcknowledgement,
    discardRejected,
    close: () => {
      closed = true;
    },
  });
}
