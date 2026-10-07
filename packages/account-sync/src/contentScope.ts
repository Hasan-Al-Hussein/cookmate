import type { Immutable } from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../domain/src/portableBackupContent';
import { AccountReplicationError } from './replicationTypes';
import { exact, fingerprintPattern, instant, matches, uuidPattern } from './validationPrimitives';

/** Private format3 prerequisites only; these types do not expand the active replication union. */
export const ACCOUNT_CONTENT_SCOPE_MAX_BYTES = 4096;
export interface AccountContentSyncScopeApproval {
  schemaVersion: 1;
  ownerId: string;
  installationId: string;
  scopeVersion: 3;
  personalApproved: true;
  historyIncluded: boolean;
  decidedAt: string;
}
export interface AccountContentScopeApprovalEvidence {
  record: AccountContentSyncScopeApproval;
  /** A canonical stale-capture guard, never authentication or remote consent proof. */
  digest: string;
}
export interface AccountContentCaptureScope {
  version: 3;
  approvalDigest: string;
  historyIncluded: boolean;
}

function approval(value: unknown): value is AccountContentSyncScopeApproval {
  return (
    exact(value, [
      'schemaVersion',
      'ownerId',
      'installationId',
      'scopeVersion',
      'personalApproved',
      'historyIncluded',
      'decidedAt',
    ]) &&
    value.schemaVersion === 1 &&
    matches(value.ownerId, uuidPattern) &&
    matches(value.installationId, uuidPattern) &&
    value.scopeVersion === 3 &&
    value.personalApproved === true &&
    typeof value.historyIncluded === 'boolean' &&
    instant(value.decidedAt)
  );
}
function evidence(value: unknown): value is AccountContentScopeApprovalEvidence {
  return (
    exact(value, ['record', 'digest']) &&
    approval(value.record) &&
    matches(value.digest, fingerprintPattern)
  );
}
function captureScope(value: unknown): value is AccountContentCaptureScope {
  return (
    exact(value, ['version', 'approvalDigest', 'historyIncluded']) &&
    value.version === 3 &&
    matches(value.approvalDigest, fingerprintPattern) &&
    typeof value.historyIncluded === 'boolean'
  );
}
function admit<Value>(
  input: unknown,
  validate: (value: unknown) => value is Value,
): { value: Value; serialized: string } {
  let serialized: string;
  try {
    serialized = canonicalPortableContentJson(input, ACCOUNT_CONTENT_SCOPE_MAX_BYTES);
  } catch (error) {
    throw new AccountReplicationError(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_input',
    );
  }
  const value: unknown = JSON.parse(serialized);
  if (!validate(value)) throw new AccountReplicationError('invalid_input');
  return { value, serialized };
}
function valid<Value>(input: unknown, validate: (value: unknown) => value is Value): boolean {
  try {
    admit(input, validate);
    return true;
  } catch {
    return false;
  }
}

export function validateAccountContentSyncScopeApproval(
  value: unknown,
): value is AccountContentSyncScopeApproval {
  return valid(value, approval);
}
export function canonicalAccountContentSyncScopeApproval(value: unknown): string {
  return admit(value, approval).serialized;
}
/** Structural validation only; durable readers must independently recompute the record digest. */
export function validateAccountContentScopeApprovalEvidence(
  value: unknown,
): value is AccountContentScopeApprovalEvidence {
  return valid(value, evidence);
}
export async function createAccountContentScopeApprovalEvidence(
  input: AccountContentSyncScopeApproval,
  sha256: (text: string) => Promise<string>,
): Promise<Immutable<AccountContentScopeApprovalEvidence>> {
  // Own the bounded record before the asynchronous hash; subsequent caller edits are irrelevant.
  const { value: record, serialized } = admit(input, approval);
  const digest = await sha256(serialized);
  if (!matches(digest, fingerprintPattern)) throw new AccountReplicationError('invalid_input');
  return Object.freeze({ record: Object.freeze(record), digest });
}
export function validateAccountContentCaptureScope(
  value: unknown,
): value is AccountContentCaptureScope {
  return valid(value, captureScope);
}
export function canonicalAccountContentCaptureScope(value: unknown): string {
  return admit(value, captureScope).serialized;
}
export function accountContentCaptureScopesEqual(
  left: AccountContentCaptureScope,
  right: AccountContentCaptureScope,
): boolean {
  return canonicalAccountContentCaptureScope(left) === canonicalAccountContentCaptureScope(right);
}
