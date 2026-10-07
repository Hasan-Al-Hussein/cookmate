import type { AccountSnapshot } from './types';
import { AccountReplicationError } from './replicationTypes';
import type {
  AccountCaptureScope,
  AccountLocalCapture,
  AccountScopeApprovalEvidence,
  AccountSyncScopeApproval,
} from './replicationTypes';
import { exact, instant, matches, uuidPattern, fingerprintPattern } from './validationPrimitives';
import { canonicalJson, normalizeAccountSnapshot } from './validation';

export function validateAccountSyncScopeApproval(
  value: unknown,
): value is AccountSyncScopeApproval {
  return (
    exact(value, [
      'schemaVersion',
      'ownerId',
      'scopeVersion',
      'personalApproved',
      'historyIncluded',
      'decidedAt',
    ]) &&
    value.schemaVersion === 1 &&
    matches(value.ownerId, uuidPattern) &&
    value.scopeVersion === 2 &&
    value.personalApproved === true &&
    typeof value.historyIncluded === 'boolean' &&
    instant(value.decidedAt)
  );
}
export function canonicalAccountSyncScopeApproval(value: AccountSyncScopeApproval): string {
  if (!validateAccountSyncScopeApproval(value)) throw new AccountReplicationError('invalid_input');
  return canonicalJson(value);
}
export function validateAccountCaptureScope(value: unknown): value is AccountCaptureScope {
  return (
    (exact(value, ['version']) && value.version === 1) ||
    (exact(value, ['version', 'approvalDigest', 'historyIncluded']) &&
      value.version === 2 &&
      matches(value.approvalDigest, fingerprintPattern) &&
      typeof value.historyIncluded === 'boolean')
  );
}
export function validateAccountScopeApprovalEvidence(
  value: unknown,
): value is AccountScopeApprovalEvidence {
  return (
    exact(value, ['record', 'digest']) &&
    validateAccountSyncScopeApproval(value.record) &&
    matches(value.digest, fingerprintPattern)
  );
}
/** Repository helper. The hash is a stale-capture guard, not a credential or remote consent proof. */
export async function createAccountScopeApprovalEvidence(
  record: AccountSyncScopeApproval,
  sha256: (text: string) => Promise<string>,
): Promise<AccountScopeApprovalEvidence> {
  const serialized = canonicalAccountSyncScopeApproval(record);
  const digest = await sha256(serialized);
  if (!matches(digest, fingerprintPattern)) throw new AccountReplicationError('invalid_input');
  return { record: JSON.parse(serialized) as AccountSyncScopeApproval, digest };
}
export function accountCaptureScope(capture: AccountLocalCapture): AccountCaptureScope {
  if (capture.scope === undefined && capture.snapshot.schemaVersion === 1) return { version: 1 };
  if (
    !validateAccountCaptureScope(capture.scope) ||
    capture.scope.version !== capture.snapshot.schemaVersion ||
    (capture.scope.version === 2 &&
      Object.hasOwn(capture.snapshot, 'cookingHistory') !== capture.scope.historyIncluded)
  )
    throw new AccountReplicationError('stored_data_invalid');
  return capture.scope;
}
export function accountCaptureScopesEqual(
  left: AccountCaptureScope,
  right: AccountCaptureScope,
): boolean {
  if (!validateAccountCaptureScope(left) || !validateAccountCaptureScope(right))
    throw new AccountReplicationError('stored_data_invalid');
  return canonicalJson(left) === canonicalJson(right);
}
/** Convergence only: full canonical snapshot bytes still guard pending requests and server CAS. */
export function accountSnapshotsEqualForScope(
  left: AccountSnapshot,
  right: AccountSnapshot,
  scope: AccountCaptureScope,
): boolean {
  if (!validateAccountCaptureScope(scope)) throw new AccountReplicationError('stored_data_invalid');
  const project = (snapshot: AccountSnapshot) => {
    const value = normalizeAccountSnapshot(snapshot);
    if (scope.version === 2 && !scope.historyIncluded && value.schemaVersion === 2)
      delete value.cookingHistory;
    return canonicalJson(value);
  };
  return project(left) === project(right);
}
