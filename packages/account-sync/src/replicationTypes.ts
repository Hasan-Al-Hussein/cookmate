import type { AccountCommitReceipt, AccountRemoteState } from './remote';
import type { AccountSnapshot, AccountSnapshotOptions } from './types';

export interface AccountReplicationScope {
  ownerId: string;
  authGeneration: number;
}
export interface AccountSyncScopeApproval {
  schemaVersion: 1;
  ownerId: string;
  scopeVersion: 2;
  personalApproved: true;
  historyIncluded: boolean;
  decidedAt: string;
}
export type AccountCaptureScope =
  | { version: 1 }
  | { version: 2; approvalDigest: string; historyIncluded: boolean };
export interface AccountScopeApprovalEvidence {
  record: AccountSyncScopeApproval;
  /** SHA-256 of the canonical validated record, verified by the durable repository. */
  digest: string;
}
export interface AccountLocalCapture {
  storeRevision: number;
  snapshot: AccountSnapshot;
  /** Omitted only by legacy v1 repositories/captures. Never infer expanded approval. */
  scope?: AccountCaptureScope;
}
export interface AccountPendingReplication {
  operationId: string;
  mode: 'push' | 'pull';
  capturedLocal: AccountLocalCapture;
  remote: AccountRemoteState;
  proposed: AccountSnapshot;
  proposedDigest: string;
  acknowledgement: AccountCommitReceipt | null;
}
export interface AccountApplyReceipt {
  ownerId: string;
  operationId: string;
  storeRevision: number;
  serverRevision: number;
  appliedAt: string;
}
interface AccountReplicationJournalCore {
  ownerId: string;
  revision: number;
  base: AccountRemoteState | null;
  /** Observing a server version does not acknowledge it as the installed merge base. */
  observed: { revision: number; snapshotDigest: string | null; updatedAt: string | null } | null;
  pending: AccountPendingReplication | null;
  lastApply: AccountApplyReceipt | null;
}
export interface AccountReplicationJournalV1 extends AccountReplicationJournalCore {
  schemaVersion: 1;
}
export interface AccountReplicationJournalV2 extends AccountReplicationJournalCore {
  schemaVersion: 2;
  scope: AccountCaptureScope;
}
export type AccountReplicationJournal = AccountReplicationJournalV1 | AccountReplicationJournalV2;
export interface AccountPendingSettings {
  ownerId: string;
  operationId: string;
  previous: AccountSnapshotOptions;
  projection: AccountSnapshotOptions;
}
export interface AccountReplicationInspection {
  local: AccountLocalCapture;
  journal: AccountReplicationJournal | null;
  deviceDataOwnerId: string | null;
  pendingSettings: AccountPendingSettings | null;
  /** Required (explicit null when absent) for production expanded-mode inspection. */
  scopeApproval?: AccountScopeApprovalEvidence | null;
}
export interface AccountStageInput {
  operationId: string;
  expectedJournalRevision: number;
  expectedDeviceDataOwnerId: string | null;
  /** The coordinator obtains explicit review before the first guest/account combination. */
  initialImportReviewed: boolean;
  capturedLocal: AccountLocalCapture;
  remote: AccountRemoteState;
  proposed: AccountSnapshot;
  mode: 'push' | 'pull';
}
export interface AccountApplyInput {
  operationId: string;
  expectedJournalRevision: number;
  expectedLocal: AccountLocalCapture;
  /** Rebased against pending.capturedLocal and the acknowledged server candidate. */
  rebased: AccountSnapshot;
}
export type AccountReplicationFailure =
  | 'invalid_input'
  | 'stored_data_invalid'
  | 'too_large'
  | 'account_changed'
  | 'different_data_owner'
  | 'initial_review_required'
  | 'scope_review_required'
  | 'scope_changed'
  | 'catalogue_mismatch'
  | 'unknown_recipe'
  | 'history_content_mismatch'
  | 'store_busy'
  | 'active_actions'
  | 'recovery_required'
  | 'local_changed'
  | 'journal_changed'
  | 'operation_pending'
  | 'operation_changed'
  | 'acknowledgement_required'
  | 'stale_server_revision'
  | 'deletion_pending'
  | 'settings_pending'
  | 'settings_changed';
export class AccountReplicationError extends Error {
  constructor(public readonly reason: AccountReplicationFailure) {
    super(`Account replication: ${reason}`);
    this.name = 'AccountReplicationError';
  }
}
export interface AccountReplicationRepository {
  inspect(scope: AccountReplicationScope): Promise<AccountReplicationInspection>;
  stage(
    scope: AccountReplicationScope,
    input: AccountStageInput,
  ): Promise<AccountReplicationJournal>;
  recordAcknowledgement(
    scope: AccountReplicationScope,
    input: { operationId: string; receipt: AccountCommitReceipt },
  ): Promise<AccountReplicationJournal>;
  apply(scope: AccountReplicationScope, input: AccountApplyInput): Promise<AccountApplyReceipt>;
  readApplyReceipt(
    scope: AccountReplicationScope,
    operationId: string,
  ): Promise<AccountApplyReceipt | null>;
  acknowledgeSettings(
    scope: AccountReplicationScope,
    expected: AccountPendingSettings,
  ): Promise<void>;
  readInitialGuestCapture(scope: AccountReplicationScope): Promise<AccountLocalCapture | null>;
  /** Only a validated CAS rejection proves this unacknowledged request did not commit. */
  discardRejected(
    scope: AccountReplicationScope,
    input: {
      operationId: string;
      expectedJournalRevision: number;
      reason: 'needs_review';
    },
  ): Promise<AccountReplicationJournal>;
}
