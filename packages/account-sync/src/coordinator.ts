import { emptyAccountSnapshot } from './backupAdapter';
import { mergeAccountSnapshots } from './merge';
import { accountSnapshotsEqual, canonicalJson } from './validation';
import { AccountRemoteError } from './remote';
import type { AccountRemote, AccountRemoteState } from './remote';
import { AccountReplicationError } from './replicationTypes';
import type {
  AccountReplicationInspection,
  AccountReplicationRepository,
  AccountReplicationScope,
  AccountPendingSettings,
  AccountPendingReplication,
  AccountCaptureScope,
} from './replicationTypes';
import type { AccountMergeConflict, AccountMergeResolutions, AccountSnapshot } from './types';
import { createAccountSyncExecution } from './syncExecution';
import {
  accountCaptureScope,
  accountCaptureScopesEqual,
  accountSnapshotsEqualForScope,
  validateAccountCaptureScope,
  validateAccountScopeApprovalEvidence,
} from './scope';

export type AccountSyncState =
  | { kind: 'local' }
  | { kind: 'working' }
  | { kind: 'synced'; at: string | null }
  | {
      kind: 'review';
      initial: boolean;
      recovering: boolean;
      local: AccountSnapshot;
      account: AccountSnapshot | null;
      conflicts: readonly AccountMergeConflict[];
      canConfirm: boolean;
      choice: 'merge' | 'account';
    }
  | { kind: 'failed'; reason: string; pending: boolean };

interface Review {
  inspection: AccountReplicationInspection;
  remote: AccountRemoteState;
  initial: boolean;
  recovering: boolean;
  choice: 'merge' | 'account';
  resolutions: AccountMergeResolutions;
  candidate: AccountSnapshot | null;
  conflicts: readonly AccountMergeConflict[];
}

/** Orchestrates an owner-bound durable outbox. It never stores tokens or invents a save receipt. */
export function createAccountSyncCoordinator(options: {
  scope: AccountReplicationScope;
  isCurrent(): boolean;
  repository: AccountReplicationRepository;
  remote: AccountRemote;
  newId(): string;
  projectSettings(pending: AccountPendingSettings, isCurrent: () => boolean): Promise<boolean>;
  /** Enable only after the repository's atomic approval/capture/apply integration is ready. */
  enableExpandedScope?: boolean;
}) {
  if (options.scope.ownerId !== options.remote.ownerId)
    throw new AccountRemoteError('account_changed');
  let review: Review | null = null;
  const execution = createAccountSyncExecution<Extract<AccountSyncState, { kind: 'review' }>>({
    isCurrent: () => options.isCurrent(),
    hasPending: async () => !!(await options.repository.inspect(options.scope)).journal?.pending,
  });
  const check = execution.assertCurrent,
    publish = execution.publish,
    work = execution.run;
  const checkLegacyScope = (value: AccountReplicationInspection) => {
    const pending = value.journal?.pending;
    if (
      value.journal?.schemaVersion === 2 ||
      [
        value.local.snapshot,
        value.journal?.base?.snapshot,
        pending?.capturedLocal.snapshot,
        pending?.remote.snapshot,
        pending?.proposed,
      ].some((snapshot) => snapshot?.schemaVersion === 2)
    )
      throw new AccountReplicationError('scope_review_required');
    accountCaptureScope(value.local);
  };
  const authorize = (
    value: AccountReplicationInspection,
    legacyRecovery = false,
  ): AccountCaptureScope => {
    if (!options.enableExpandedScope) {
      checkLegacyScope(value);
      return { version: 1 };
    }
    const scope = accountCaptureScope(value.local);
    const pending = value.journal?.pending;
    if (legacyRecovery && pending?.proposed.schemaVersion === 1 && scope.version === 1) {
      if (
        accountCaptureScope(pending.capturedLocal).version !== 1 ||
        pending.remote.snapshot?.schemaVersion === 2 ||
        value.journal?.base?.snapshot?.schemaVersion === 2 ||
        (value.journal?.schemaVersion === 2 && value.journal.scope.version !== 1)
      )
        throw new AccountReplicationError('stored_data_invalid');
      return scope;
    }
    if (value.scopeApproval === undefined || value.scopeApproval === null)
      throw new AccountReplicationError('scope_review_required');
    if (!validateAccountScopeApprovalEvidence(value.scopeApproval))
      throw new AccountReplicationError('stored_data_invalid');
    const approval = value.scopeApproval;
    if (approval.record.ownerId !== options.scope.ownerId)
      throw new AccountReplicationError('different_data_owner');
    if (scope.version !== 2 || value.local.snapshot.schemaVersion !== 2)
      throw new AccountReplicationError('scope_review_required');
    if (
      scope.approvalDigest !== approval.digest ||
      scope.historyIncluded !== approval.record.historyIncluded
    )
      throw new AccountReplicationError('scope_changed');
    if (Object.hasOwn(value.local.snapshot, 'cookingHistory') !== scope.historyIncluded)
      throw new AccountReplicationError('stored_data_invalid');
    if (
      pending &&
      (value.journal?.schemaVersion !== 2 ||
        !accountCaptureScopesEqual(value.journal.scope, scope) ||
        !accountCaptureScopesEqual(accountCaptureScope(pending.capturedLocal), scope) ||
        pending.proposed.schemaVersion !== 2)
    )
      throw new AccountReplicationError('scope_changed');
    return scope;
  };
  const expandedMergeOptions = (scope: AccountCaptureScope) =>
    scope.version === 2 ? { expandedScope: { historyIncluded: scope.historyIncluded } } : {};
  const checkSameCapture = (
    current: AccountReplicationInspection,
    expected: AccountReplicationInspection,
    legacyRecovery = false,
  ) => {
    const scope = authorize(current, legacyRecovery);
    if (
      !accountCaptureScopesEqual(scope, accountCaptureScope(expected.local)) ||
      (scope.version === 2 &&
        canonicalJson(current.scopeApproval) !== canonicalJson(expected.scopeApproval))
    )
      throw new AccountReplicationError('scope_changed');
    if (
      current.local.storeRevision !== expected.local.storeRevision ||
      !accountSnapshotsEqual(current.local.snapshot, expected.local.snapshot)
    )
      throw new AccountReplicationError('local_changed');
    return scope;
  };
  const currentPending = (
    value: AccountReplicationInspection,
    expected: AccountPendingReplication,
  ) => {
    const pending = value.journal?.pending;
    const identity = (item: AccountPendingReplication) => ({
      ...item,
      capturedLocal: { ...item.capturedLocal, scope: accountCaptureScope(item.capturedLocal) },
      acknowledgement: null,
    });
    if (!pending || canonicalJson(identity(pending)) !== canonicalJson(identity(expected)))
      throw new AccountReplicationError('operation_changed');
    return pending;
  };
  const inspect = async () => {
    check();
    let value = await options.repository.inspect(options.scope);
    check();
    if (value.deviceDataOwnerId && value.deviceDataOwnerId !== options.scope.ownerId)
      throw new AccountReplicationError('different_data_owner');
    if (value.journal && value.journal.ownerId !== options.scope.ownerId)
      throw new AccountReplicationError('different_data_owner');
    if (!options.enableExpandedScope) checkLegacyScope(value);
    if (value.journal?.schemaVersion === 2 && !validateAccountCaptureScope(value.journal.scope))
      throw new AccountReplicationError('stored_data_invalid');
    if (value.pendingSettings) {
      if (value.pendingSettings.ownerId !== options.scope.ownerId)
        throw new AccountReplicationError('different_data_owner');
      if (!(await options.projectSettings(value.pendingSettings, execution.isActive)))
        throw new AccountReplicationError('settings_changed');
      check();
      await options.repository.acknowledgeSettings(options.scope, value.pendingSettings);
      value = await options.repository.inspect(options.scope);
      check();
      if (
        (value.deviceDataOwnerId && value.deviceDataOwnerId !== options.scope.ownerId) ||
        (value.journal && value.journal.ownerId !== options.scope.ownerId)
      )
        throw new AccountReplicationError('different_data_owner');
      if (!options.enableExpandedScope) checkLegacyScope(value);
      if (value.journal?.schemaVersion === 2 && !validateAccountCaptureScope(value.journal.scope))
        throw new AccountReplicationError('stored_data_invalid');
    }
    return value;
  };
  function recompute(value: Review) {
    const local = value.inspection.local.snapshot;
    const pending = value.inspection.journal?.pending;
    const scope = authorize(value.inspection, value.recovering);
    if (
      !value.recovering &&
      value.choice === 'account' &&
      (scope.version === 1 || value.remote.snapshot === null)
    ) {
      // Empty accounts have no replacement data. Preserve local work instead.
      value.candidate = value.remote.snapshot;
      value.conflicts = [];
    } else {
      const base =
        !value.recovering && value.choice === 'account'
          ? local
          : value.recovering && pending
            ? pending.capturedLocal.snapshot
            : (value.inspection.journal?.base?.snapshot ??
              emptyAccountSnapshot(local.catalogue, {
                appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
                profile: { displayName: null },
              }));
      const account =
        value.recovering && pending
          ? pending.proposed
          : (value.remote.snapshot ??
            emptyAccountSnapshot(local.catalogue, {
              appPreferences: { theme: 'system', motion: 'system', locale: 'system' },
              profile: { displayName: null },
            }));
      const merged = mergeAccountSnapshots({
        base,
        local,
        account,
        resolutions: value.resolutions,
        ...expandedMergeOptions(scope),
        ...(scope.version === 2 && !value.recovering && value.choice === 'account'
          ? { reviewPersonalRemovals: true }
          : {}),
      });
      if (merged.status === 'incompatible_catalogue')
        throw new AccountReplicationError('catalogue_mismatch');
      value.candidate = merged.status === 'merged' ? merged.snapshot : null;
      value.conflicts = merged.status === 'needs_review' ? merged.conflicts : [];
    }
    review = value;
    publish({
      kind: 'review',
      initial: value.initial,
      recovering: value.recovering,
      local,
      account: value.recovering && pending ? pending.proposed : value.remote.snapshot,
      conflicts: value.conflicts,
      canConfirm: value.candidate !== null,
      choice: value.choice,
    });
  }
  async function settle(pending: AccountPendingReplication) {
    check();
    const inspected = await inspect();
    pending = currentPending(inspected, pending);
    const scope = authorize(inspected, true);
    if (pending.mode === 'push' && !pending.acknowledgement) {
      await execution.withRequest(async (signal) => {
        try {
          const receipt = await options.remote.commit(
            {
              operationId: pending.operationId,
              expectedRevision: pending.remote.revision,
              snapshot: pending.proposed,
            },
            signal,
          );
          check();
          await options.repository.recordAcknowledgement(options.scope, {
            operationId: pending.operationId,
            receipt,
          });
        } catch (error) {
          if (error instanceof AccountRemoteError && error.reason === 'needs_review') {
            check();
            const current = await options.repository.inspect(options.scope);
            await options.repository.discardRejected(options.scope, {
              operationId: pending.operationId,
              expectedJournalRevision: current.journal?.revision ?? 0,
              reason: 'needs_review',
            });
          }
          throw error;
        }
      });
    }
    const value = await inspect();
    const persisted = currentPending(value, pending);
    if (!accountCaptureScopesEqual(authorize(value, true), scope))
      throw new AccountReplicationError('scope_changed');
    const result = mergeAccountSnapshots({
      base: persisted.capturedLocal.snapshot,
      local: value.local.snapshot,
      account: persisted.proposed,
      ...expandedMergeOptions(scope),
    });
    if (result.status === 'incompatible_catalogue')
      throw new AccountReplicationError('catalogue_mismatch');
    if (result.status === 'needs_review') {
      recompute({
        inspection: value,
        remote: persisted.remote,
        initial: false,
        recovering: true,
        choice: 'merge',
        resolutions: {},
        candidate: null,
        conflicts: [],
      });
      return;
    }
    await apply(value, persisted, result.snapshot);
  }
  async function apply(
    value: AccountReplicationInspection,
    pending: AccountPendingReplication,
    candidate: AccountSnapshot,
  ) {
    check();
    const currentBeforeApply = await inspect();
    currentPending(currentBeforeApply, pending);
    const scope = checkSameCapture(currentBeforeApply, value, true);
    await options.repository.apply(options.scope, {
      operationId: pending.operationId,
      expectedJournalRevision: value.journal!.revision,
      expectedLocal: value.local,
      rebased: candidate,
    });
    check();
    const current = await inspect();
    review = null;
    const base = current.journal?.base;
    if (options.enableExpandedScope && scope.version === 1) {
      // The acknowledged legacy operation is complete. Scope expansion is a separate review,
      // never a rewrite/retry of that operation and never an automatic follow-on upload.
      authorize(current);
      publish({ kind: 'local' });
      return;
    }
    if (
      options.enableExpandedScope &&
      (!accountCaptureScopesEqual(authorize(current), scope) ||
        canonicalJson(current.scopeApproval) !== canonicalJson(value.scopeApproval))
    ) {
      publish({ kind: 'local' });
      return;
    }
    publish(
      base?.snapshot && accountSnapshotsEqualForScope(current.local.snapshot, base.snapshot, scope)
        ? { kind: 'synced', at: base.updatedAt }
        : { kind: 'local' },
    );
  }
  const sync = () =>
    work(async () => {
      review = null;
      const value = await inspect();
      if (value.deviceDataOwnerId && value.deviceDataOwnerId !== options.scope.ownerId)
        throw new AccountReplicationError('different_data_owner');
      if (value.journal?.pending) {
        await settle(value.journal.pending);
        return;
      }
      const scope = authorize(value);
      const remote = await execution.withRequest((signal) => options.remote.read(signal));
      check();
      if (remote.deletionOperationId) throw new AccountReplicationError('deletion_pending');
      if (!options.enableExpandedScope && remote.snapshot?.schemaVersion === 2)
        throw new AccountReplicationError('scope_review_required');
      const initial =
        !value.journal?.base ||
        value.deviceDataOwnerId === null ||
        (scope.version === 2 &&
          (value.journal?.schemaVersion !== 2 ||
            !accountCaptureScopesEqual(scope, value.journal.scope)));
      if (
        !initial &&
        value.journal?.base?.revision === remote.revision &&
        remote.snapshot &&
        value.journal.base.updatedAt === remote.updatedAt &&
        value.journal.base.snapshot &&
        accountSnapshotsEqual(value.journal.base.snapshot, remote.snapshot) &&
        accountSnapshotsEqualForScope(value.local.snapshot, remote.snapshot, scope)
      ) {
        checkSameCapture(await inspect(), value);
        publish({ kind: 'synced', at: remote.updatedAt });
        return;
      }
      const next: Review = {
        inspection: value,
        remote,
        initial,
        recovering: false,
        choice: 'merge',
        resolutions: {},
        candidate: null,
        conflicts: [],
      };
      recompute(next);
      if (!initial && next.candidate) await stage(next);
    });
  async function stage(value: Review) {
    if (!value.candidate) throw new AccountReplicationError('initial_review_required');
    check();
    const current = await inspect();
    if (current.journal?.pending) throw new AccountReplicationError('operation_pending');
    checkSameCapture(current, value.inspection);
    const mode =
      value.remote.snapshot && accountSnapshotsEqual(value.candidate, value.remote.snapshot)
        ? 'pull'
        : 'push';
    const journal = await options.repository.stage(options.scope, {
      operationId: options.newId(),
      expectedJournalRevision: value.inspection.journal?.revision ?? 0,
      expectedDeviceDataOwnerId: value.inspection.deviceDataOwnerId,
      initialImportReviewed: true,
      capturedLocal: value.inspection.local,
      remote: value.remote,
      proposed: value.candidate,
      mode,
    });
    if (!journal.pending) throw new AccountReplicationError('operation_changed');
    review = null;
    await settle(journal.pending);
  }
  return {
    getSnapshot: execution.getSnapshot,
    subscribe: execution.subscribe,
    sync,
    select(choice: 'merge' | 'account') {
      if (execution.isRunning() || !review || review.recovering) return;
      check();
      recompute({ ...review, choice, resolutions: {} });
    },
    resolve(conflictId: string, choice: 'local' | 'account') {
      if (
        execution.isRunning() ||
        !review ||
        !review.conflicts.some((item) => item.id === conflictId)
      )
        return;
      check();
      recompute({ ...review, resolutions: { ...review.resolutions, [conflictId]: choice } });
    },
    confirm: () =>
      work(async () => {
        if (!review?.candidate) throw new AccountReplicationError('initial_review_required');
        const accepted = review;
        if (accepted.recovering)
          await apply(
            accepted.inspection,
            accepted.inspection.journal!.pending!,
            accepted.candidate!,
          );
        else await stage(accepted);
      }),
    cancelReview() {
      if (execution.isRunning()) return;
      review = null;
      publish({ kind: 'local' });
    },
    /** Await before activating another owner's workspace/preferences. */
    invalidate() {
      const completion = execution.invalidate();
      review = null;
      return completion;
    },
  };
}

export type AccountSyncCoordinator = ReturnType<typeof createAccountSyncCoordinator>;
