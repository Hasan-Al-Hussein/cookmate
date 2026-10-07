import type { Immutable } from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../domain/src/portableBackupContent';
import type { AccountContentMergeResult } from './contentMerge';
import type { AccountContentRemote } from './contentRemote';
import type {
  AccountContentJournalApplyReceipt,
  AccountContentRemoteState,
  AccountContentReplicationJournal,
} from './contentReplicationRecords';
import { accountContentCaptureScopesEqual, type AccountContentCaptureScope } from './contentScope';
import { canonicalAccountContentSnapshot, type AccountContentSnapshot } from './contentSnapshot';
import { AccountRemoteError, type AccountCommitReceipt } from './remote';
import {
  AccountReplicationError,
  type AccountPendingSettings,
  type AccountReplicationScope,
} from './replicationTypes';
import { createAccountSyncExecution, type SyncExecutionState } from './syncExecution';
import type { AccountMergeResolutions } from './types';

export interface ContentSyncCapture {
  readonly snapshot: Immutable<AccountContentSnapshot>;
  readonly scope: Immutable<AccountContentCaptureScope>;
  readonly fence: { readonly binding: string | null };
}
export interface ContentSyncReview {
  readonly merge: Immutable<AccountContentMergeResult>;
  readonly removalReview: { readonly conflicts: readonly { readonly id: string }[] } | null;
}
export interface ContentSyncPushReview extends ContentSyncReview {
  readonly operationId: string;
  readonly initialImportRequired: boolean;
}
export interface ContentSyncApplyReview extends ContentSyncReview {
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly blockers: readonly 'removed_core_choices'[];
}
export type ContentSyncRemovalChoices = Readonly<
  Record<string, 'keep_local' | 'save_account_version'>
>;
type Identity = { operationId: string; requestFingerprint: string };
type Journal = Immutable<AccountContentReplicationJournal>;
type Remote = Immutable<AccountContentRemoteState>;
type Snapshot = Immutable<AccountContentSnapshot>;

/** Structural borrowed ports; concrete capture fences and issued review objects retain their types. */
interface ContentSyncReviewServices<
  Capture extends ContentSyncCapture,
  Push extends ContentSyncPushReview,
  Owner extends string | null,
> {
  readonly scope: Readonly<AccountReplicationScope>;
  capture(): Promise<Capture>;
  journal: {
    read(scope: AccountReplicationScope): Promise<Journal | null>;
    reviewPush(
      scope: AccountReplicationScope,
      input: { operationId: string; remote: Remote },
      resolutions?: AccountMergeResolutions,
    ): Promise<Push>;
    stageReviewedPush(
      scope: AccountReplicationScope,
      review: Push,
      choices: {
        initialImportReviewed: boolean;
        resolutions?: AccountMergeResolutions;
        removalChoices?: ContentSyncRemovalChoices;
      },
    ): Promise<Journal>;
    stage(
      scope: AccountReplicationScope,
      input: {
        operationId: string;
        expectedJournalRevision: number;
        expectedDeviceDataOwnerId: Owner;
        initialImportReviewed: boolean;
        capturedLocal: Capture;
        remote: Remote;
        proposed: Snapshot;
        mode: 'pull';
      },
    ): Promise<Journal>;
  };
}
export type ContentSyncBootstrapServices<
  Capture extends ContentSyncCapture,
  Push extends ContentSyncPushReview,
> = ContentSyncReviewServices<Capture, Push, null>;
export interface ContentSyncServices<
  Capture extends ContentSyncCapture,
  Push extends ContentSyncPushReview,
  Apply extends ContentSyncApplyReview,
> extends ContentSyncReviewServices<Capture, Push, string> {
  journal: ContentSyncReviewServices<Capture, Push, string>['journal'] & {
    recordAcknowledgement(
      scope: AccountReplicationScope,
      input: Identity & { receipt: Immutable<AccountCommitReceipt> },
    ): Promise<Journal>;
    discardRejected(
      scope: AccountReplicationScope,
      input: Identity & { expectedJournalRevision: number; reason: 'needs_review' },
    ): Promise<Journal>;
  };
  apply: {
    inspectSettings(
      scope: AccountReplicationScope,
    ): Promise<Immutable<AccountPendingSettings> | null>;
    acknowledgeSettings(
      scope: AccountReplicationScope,
      expected: Immutable<AccountPendingSettings>,
    ): Promise<void>;
    review(
      scope: AccountReplicationScope,
      identity: Identity,
      resolutions?: AccountMergeResolutions,
    ): Promise<Apply>;
    apply(
      scope: AccountReplicationScope,
      review: Apply,
      resolutions?: AccountMergeResolutions,
      removalChoices?: ContentSyncRemovalChoices,
    ): Promise<Immutable<AccountContentJournalApplyReceipt>>;
    recover(
      scope: AccountReplicationScope,
      identity: Identity,
    ): Promise<Immutable<AccountContentJournalApplyReceipt> | null>;
  };
}
export type ContentSyncReviewState<
  Push extends ContentSyncPushReview,
  Apply extends ContentSyncApplyReview,
> =
  | { kind: 'review'; phase: 'push'; initial: boolean; review: Push; canConfirm: boolean }
  | { kind: 'review'; phase: 'pull'; initial: boolean; snapshot: Snapshot; canConfirm: true }
  | { kind: 'review'; phase: 'apply'; initial: false; review: Apply; canConfirm: boolean }
  | {
      kind: 'review';
      phase: 'reopen';
      initial: true;
      reason: 'binding_staged';
      operationId: string;
      requestFingerprint: string;
      canConfirm: false;
    };
export type ContentSyncState<
  Push extends ContentSyncPushReview,
  Apply extends ContentSyncApplyReview,
> = SyncExecutionState<ContentSyncReviewState<Push, Apply>>;

export type ContentSyncCoordinatorOptions<
  Capture extends ContentSyncCapture,
  Push extends ContentSyncPushReview,
  Apply extends ContentSyncApplyReview = ContentSyncApplyReview,
> = {
  scope: Readonly<AccountReplicationScope>;
  isCurrent(): boolean;
  newId(): string;
} & (
  | {
      mode?: 'bound';
      services: ContentSyncServices<Capture, Push, Apply>;
      remote: AccountContentRemote;
      projectSettings(
        pending: Immutable<AccountPendingSettings>,
        isCurrent: () => boolean,
      ): Promise<boolean>;
    }
  | {
      mode: 'bootstrap';
      services: ContentSyncBootstrapServices<Capture, Push>;
      remote: Pick<AccountContentRemote, 'ownerId' | 'read'>;
    }
);

/** One review workflow; initial binding stops until the lifecycle owner reopens a bound facade. */
export function createAccountContentCoordinator<
  Capture extends ContentSyncCapture,
  Push extends ContentSyncPushReview,
  Apply extends ContentSyncApplyReview = ContentSyncApplyReview,
>(options: ContentSyncCoordinatorOptions<Capture, Push, Apply>) {
  const scope = Object.freeze({ ...options.scope });
  const { services, remote, isCurrent, newId } = options;
  if (
    services.scope.ownerId !== scope.ownerId ||
    services.scope.authGeneration !== scope.authGeneration ||
    remote.ownerId !== scope.ownerId
  )
    throw new AccountRemoteError('account_changed');
  const execution = createAccountSyncExecution<ContentSyncReviewState<Push, Apply>>({
    isCurrent,
    hasPending: async () => !!(await services.journal.read(scope))?.pending,
  });
  const check = execution.assertCurrent;
  type StageReview = {
    phase: 'stage';
    capture: Capture;
    journal: Journal | null;
    remote: Remote;
    issued: Push;
    initial: boolean;
    choice: 'merge' | 'account';
    resolutions: AccountMergeResolutions;
  };
  type ApplyReview = {
    phase: 'apply';
    identity: Identity;
    issued: Apply;
    resolutions: AccountMergeResolutions;
  };
  let review: StageReview | ApplyReview | null = null;
  function fail(reason: ConstructorParameters<typeof AccountReplicationError>[0]): never {
    throw new AccountReplicationError(reason);
  }
  const equalSnapshot = (left: Snapshot, right: Snapshot) =>
    canonicalAccountContentSnapshot(left) === canonicalAccountContentSnapshot(right);
  const identity = (pending: NonNullable<Journal['pending']>): Identity => ({
    operationId: pending.operationId,
    requestFingerprint: pending.requestFingerprint,
  });
  function requirePending(journal: Journal | null, wanted: Identity) {
    const pending = journal?.pending;
    if (
      !journal ||
      journal.ownerId !== scope.ownerId ||
      !pending ||
      pending.operationId !== wanted.operationId ||
      pending.requestFingerprint !== wanted.requestFingerprint
    )
      return fail('operation_changed');
    return { journal, pending };
  }
  async function readJournal() {
    check();
    const value = await services.journal.read(scope);
    check();
    if (value && value.ownerId !== scope.ownerId) fail('different_data_owner');
    return value;
  }
  async function settings() {
    if (options.mode === 'bootstrap') return;
    const { services, projectSettings } = options;
    check();
    const pending = await services.apply.inspectSettings(scope);
    check();
    if (!pending) return;
    if (pending.ownerId !== scope.ownerId) fail('different_data_owner');
    if (!(await projectSettings(pending, execution.isActive))) fail('settings_changed');
    check();
    await services.apply.acknowledgeSettings(scope, pending);
    check();
  }
  async function capture() {
    check();
    const value = await services.capture();
    check();
    if (value.fence.binding !== (options.mode === 'bootstrap' ? null : scope.ownerId))
      fail('different_data_owner');
    return value;
  }
  async function requireSameCapture(expected: Capture) {
    const current = await capture();
    if (canonicalPortableContentJson(current) !== canonicalPortableContentJson(expected))
      fail('local_changed');
  }
  function sameForScope(local: Capture, account: Snapshot) {
    if (local.scope.historyIncluded) return equalSnapshot(local.snapshot, account);
    const { cookingHistory: _history, ...withoutHistory } = account;
    return equalSnapshot(local.snapshot, withoutHistory);
  }
  function show(value: StageReview | ApplyReview) {
    check();
    review = value;
    if (value.phase === 'apply') {
      execution.publish({
        kind: 'review',
        phase: 'apply',
        initial: false,
        review: value.issued,
        canConfirm: value.issued.merge.status === 'merged',
      });
    } else if (value.choice === 'account' && value.remote.snapshot) {
      execution.publish({
        kind: 'review',
        phase: 'pull',
        initial: value.initial,
        snapshot: value.remote.snapshot,
        canConfirm: true,
      });
    } else {
      execution.publish({
        kind: 'review',
        phase: 'push',
        initial: value.initial,
        review: value.issued,
        canConfirm: value.issued.merge.status === 'merged',
      });
    }
  }
  async function finish() {
    await settings();
    const journal = await readJournal();
    if (journal?.pending) fail('operation_pending');
    // Capture rejects newly pending work and is the last awaited observation before status.
    const local = await capture();
    review = null;
    execution.publish(
      journal?.base?.snapshot &&
        accountContentCaptureScopesEqual(local.scope, journal.scope) &&
        sameForScope(local, journal.base.snapshot)
        ? { kind: 'synced', at: journal.base.updatedAt }
        : { kind: 'local' },
    );
  }
  async function apply(value: ApplyReview, removals?: ContentSyncRemovalChoices) {
    if (options.mode === 'bootstrap') fail('recovery_required');
    check();
    await options.services.apply.apply(scope, value.issued, value.resolutions, removals);
    check();
    await finish();
  }
  async function settle(wanted: Identity) {
    let current = await readJournal();
    if (options.mode === 'bootstrap') {
      const saved = requirePending(current, wanted).pending;
      review = null;
      execution.publish({
        kind: 'review',
        phase: 'reopen',
        initial: true,
        reason: 'binding_staged',
        ...identity(saved),
        canConfirm: false,
      });
      return;
    }
    const { services, remote } = options;
    if (!current?.pending) {
      if (!(await services.apply.recover(scope, wanted))) fail('operation_changed');
      check();
      await finish();
      return;
    }
    const pending = requirePending(current, wanted).pending;
    if (pending.mode === 'push' && !pending.acknowledgement) {
      let receipt: Immutable<AccountCommitReceipt>;
      // Only this exact transport call can supply the definite CAS rejection signal.
      try {
        receipt = await execution.withRequest((signal) =>
          remote.commit(
            {
              operationId: pending.operationId,
              expectedRevision: pending.remote.revision,
              snapshot: pending.proposed,
            },
            signal,
          ),
        );
      } catch (error) {
        check();
        if (error instanceof AccountRemoteError && error.reason === 'needs_review') {
          const latest = requirePending(await readJournal(), wanted);
          if (latest.pending.mode !== 'push' || latest.pending.acknowledgement)
            fail('operation_changed');
          await services.journal.discardRejected(scope, {
            ...wanted,
            expectedJournalRevision: latest.journal.revision,
            reason: 'needs_review',
          });
          check();
        }
        throw error;
      }
      check();
      await services.journal.recordAcknowledgement(scope, { ...wanted, receipt });
      check();
    }
    current = await readJournal();
    requirePending(current, wanted);
    const issued = await services.apply.review(scope, wanted);
    check();
    const value: ApplyReview = { phase: 'apply', identity: wanted, issued, resolutions: {} };
    if (issued.merge.status === 'incompatible_catalogue') fail('catalogue_mismatch');
    if (
      issued.merge.status === 'merged' &&
      !issued.blockers.length &&
      !issued.removalReview?.conflicts.length
    )
      await apply(value);
    else show(value);
  }
  async function stageLocal(value: StageReview, removals?: ContentSyncRemovalChoices) {
    check();
    const merged = value.issued.merge;
    const pull =
      value.choice === 'account' ||
      (merged.status === 'merged' &&
        value.remote.snapshot &&
        equalSnapshot(merged.snapshot, value.remote.snapshot) &&
        !value.issued.removalReview?.conflicts.length &&
        removals === undefined);
    let journal: Journal;
    if (pull) {
      if (!value.remote.snapshot || (removals && Object.keys(removals).length))
        fail('invalid_input');
      const input = {
        operationId: value.issued.operationId,
        expectedJournalRevision: value.journal?.revision ?? 0,
        initialImportReviewed: true,
        capturedLocal: value.capture,
        remote: value.remote,
        proposed: value.remote.snapshot,
        mode: 'pull' as const,
      };
      journal =
        options.mode === 'bootstrap'
          ? await options.services.journal.stage(scope, {
              ...input,
              expectedDeviceDataOwnerId: null,
            })
          : await options.services.journal.stage(scope, {
              ...input,
              expectedDeviceDataOwnerId: scope.ownerId,
            });
    } else {
      if (merged.status !== 'merged') fail('initial_review_required');
      journal = await services.journal.stageReviewedPush(scope, value.issued, {
        initialImportReviewed: true,
        resolutions: value.resolutions,
        ...(removals === undefined ? {} : { removalChoices: removals }),
      });
    }
    return journal;
  }
  async function stage(value: StageReview, removals?: ContentSyncRemovalChoices) {
    let journal: Journal;
    try {
      journal = await stageLocal(value, removals);
    } catch (error) {
      if (options.mode !== 'bootstrap') throw error;
      check();
      // A lost local staging ACK may already have bound the clone. Never stage or send again.
      let saved: Journal | null;
      try {
        saved = await readJournal();
      } catch {
        throw error;
      }
      if (saved?.pending?.operationId !== value.issued.operationId) throw error;
      await settle(identity(saved.pending));
      return;
    }
    check();
    if (!journal.pending) fail('operation_changed');
    review = null;
    await settle(identity(journal.pending));
  }
  function requiresReopen() {
    const state = execution.getSnapshot();
    return state.kind === 'review' && state.phase === 'reopen';
  }
  return {
    getSnapshot: execution.getSnapshot,
    subscribe: execution.subscribe,
    sync: () =>
      execution.run(async () => {
        review = null;
        await readJournal();
        await settings();
        const journal = await readJournal();
        if (journal?.pending) {
          await settle(identity(journal.pending));
          return;
        }
        const local = await capture();
        const observed = await execution.withRequest((signal) => remote.read(signal));
        if (observed.deletionOperationId) fail('deletion_pending');
        const snapshot = observed.snapshot;
        if (snapshot && snapshot.schemaVersion !== 3)
          throw new AccountRemoteError('snapshot_upgrade_required');
        const source: Remote = { ...observed, snapshot };
        const initial =
          options.mode === 'bootstrap' ||
          !journal?.base ||
          !accountContentCaptureScopesEqual(local.scope, journal.scope);
        if (
          !initial &&
          journal?.base?.snapshot &&
          source.snapshot &&
          journal.base.revision === source.revision &&
          journal.base.updatedAt === source.updatedAt &&
          equalSnapshot(journal.base.snapshot, source.snapshot) &&
          sameForScope(local, source.snapshot)
        ) {
          await requireSameCapture(local);
          execution.publish({ kind: 'synced', at: source.updatedAt });
          return;
        }
        const issued = await services.journal.reviewPush(scope, {
          operationId: newId(),
          remote: source,
        });
        check();
        // reviewPush captures independently; its scope must still match the initial decision.
        await requireSameCapture(local);
        if (issued.merge.status === 'incompatible_catalogue') fail('catalogue_mismatch');
        const value: StageReview = {
          phase: 'stage',
          capture: local,
          journal,
          remote: source,
          issued,
          initial: initial || issued.initialImportRequired,
          choice: 'merge',
          resolutions: {},
        };
        show(value);
        if (
          !value.initial &&
          issued.merge.status === 'merged' &&
          !issued.removalReview?.conflicts.length
        )
          await stage(value);
      }),
    select(choice: 'merge' | 'account') {
      if (execution.isRunning() || !review || review.phase !== 'stage') return;
      check();
      if (choice !== 'merge' && choice !== 'account') fail('invalid_input');
      // An empty account is not replacement data.
      show({
        ...review,
        choice: choice === 'account' && review.remote.snapshot ? choice : 'merge',
      });
    },
    resolve(conflictId: string, choice: 'local' | 'account') {
      if (requiresReopen()) return Promise.resolve();
      return execution.run(async () => {
        const current = review;
        if (
          !current ||
          current.issued.merge.status !== 'needs_review' ||
          !current.issued.merge.conflicts.some((conflict) => conflict.id === conflictId) ||
          (choice !== 'local' && choice !== 'account')
        )
          fail('invalid_input');
        const resolutions = { ...current.resolutions, [conflictId]: choice };
        if (current.phase === 'apply') {
          if (options.mode === 'bootstrap') fail('recovery_required');
          const issued = await options.services.apply.review(scope, current.identity, resolutions);
          check();
          show({ ...current, issued, resolutions });
        } else {
          const local = await capture();
          const issued = await services.journal.reviewPush(
            scope,
            { operationId: current.issued.operationId, remote: current.remote },
            resolutions,
          );
          check();
          await requireSameCapture(local);
          show({ ...current, capture: local, issued, resolutions });
        }
      });
    },
    confirm(removals?: ContentSyncRemovalChoices) {
      if (requiresReopen()) return Promise.resolve();
      const owned = removals === undefined ? undefined : { ...removals };
      return execution.run(async () => {
        const current = review;
        if (!current) fail('initial_review_required');
        if (current.phase === 'apply') await apply(current, owned);
        else await stage(current, owned);
      });
    },
    cancelReview() {
      if (execution.isRunning() || requiresReopen()) return;
      review = null;
      execution.publish({ kind: 'local' });
    },
    invalidate() {
      const completion = execution.invalidate();
      review = null;
      return completion;
    },
  };
}
