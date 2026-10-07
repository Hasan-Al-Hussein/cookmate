import { catalogueMatches } from '@cookmate/contracts';
import {
  PORTABLE_BACKUP_MAX_BYTES,
  portableBackupByteLength,
  type Immutable,
} from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../domain/src/portableBackupContent';
import { canonicalAccountContentSnapshot, type AccountContentSnapshot } from './contentSnapshot';
import {
  accountContentCaptureScopesEqual,
  validateAccountContentCaptureScope,
  type AccountContentCaptureScope,
} from './contentScope';
import { AccountReplicationError, type AccountApplyReceipt } from './replicationTypes';
import { accountRemoteTimestamp, type AccountCommitReceipt } from './remote';
import { ACCOUNT_SNAPSHOT_MAX_BYTES } from './types';
import { exact, fingerprintPattern, instant, matches, uuidPattern } from './validationPrimitives';

/** Private data codec only. No active replication union, database or remote authority is added. */
export const ACCOUNT_CONTENT_JOURNAL_MAX_BYTES = 4 * ACCOUNT_SNAPSHOT_MAX_BYTES + 65536;
export interface AccountContentRemoteState {
  ownerId: string;
  revision: number;
  snapshot: AccountContentSnapshot | null;
  updatedAt: string | null;
  deletionOperationId: string | null;
}
export interface AccountContentJournalCapture {
  storeRevision: number;
  snapshot: AccountContentSnapshot;
  scope: AccountContentCaptureScope;
  /** Digest of the complete local capture fence; never a substitute for host admission. */
  fenceDigest: string;
}
export interface AccountContentPendingDraft {
  operationId: string;
  mode: 'push' | 'pull';
  capturedLocal: AccountContentJournalCapture;
  remote: AccountContentRemoteState;
  proposed: AccountContentSnapshot;
}
export interface AccountContentPendingReplication extends AccountContentPendingDraft {
  requestFingerprint: string;
  proposedDigest: string;
  acknowledgement: AccountCommitReceipt | null;
}
export interface AccountContentJournalApplyReceipt extends AccountApplyReceipt {
  requestFingerprint: string;
}
export interface AccountContentReplicationJournal {
  schemaVersion: 3;
  ownerId: string;
  installationId: string;
  revision: number;
  legacyJournalDigest: string | null;
  scope: AccountContentCaptureScope;
  base: AccountContentRemoteState | null;
  observed: { revision: number; snapshotDigest: string | null; updatedAt: string | null };
  pending: AccountContentPendingReplication | null;
  lastApply: AccountContentJournalApplyReceipt | null;
}
type Sha256 = (text: string) => Promise<string>;
const journalKeys = [
  'schemaVersion',
  'ownerId',
  'installationId',
  'revision',
  'legacyJournalDigest',
  'scope',
  'base',
  'observed',
  'pending',
  'lastApply',
];
const draftKeys = ['operationId', 'mode', 'capturedLocal', 'remote', 'proposed'];
const remoteKeys = ['ownerId', 'revision', 'snapshot', 'updatedAt', 'deletionOperationId'];
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const fingerprint = (value: unknown): value is string => matches(value, fingerprintPattern);
function requireData(value: unknown): asserts value {
  if (!value) throw new AccountReplicationError('invalid_input');
}
function freeze<Value>(value: Value): Immutable<Value> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Immutable<Value>;
}
function bounded(value: unknown, maximum: number): string {
  try {
    return canonicalPortableContentJson(value, maximum);
  } catch (error) {
    throw new AccountReplicationError(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_input',
    );
  }
}
/** The shared encoder caps individual values at8MiB. Root fields admit the journal's additional64KiB. */
function canonicalRecord(
  value: unknown,
  keys: readonly string[],
  maximum = ACCOUNT_CONTENT_JOURNAL_MAX_BYTES,
): string {
  requireData(exact(value, keys));
  const chunks = ['{'];
  let bytes = 2;
  for (const [index, key] of [...keys].sort().entries()) {
    const prefix = (index ? ',' : '') + JSON.stringify(key) + ':';
    bytes += prefix.length;
    if (bytes >= maximum) throw new AccountReplicationError('too_large');
    const encoded = bounded(value[key], Math.min(PORTABLE_BACKUP_MAX_BYTES, maximum - bytes));
    bytes += portableBackupByteLength(encoded);
    chunks.push(prefix, encoded);
  }
  chunks.push('}');
  return chunks.join('');
}
function ownRecord(
  value: unknown,
  keys: readonly string[],
  maximum?: number,
): Record<string, unknown> {
  return JSON.parse(canonicalRecord(value, keys, maximum)) as Record<string, unknown>;
}
function snapshot(value: unknown): AccountContentSnapshot {
  try {
    // Already owned inert data. Normalize arrays consistently for fingerprints and equality.
    return JSON.parse(canonicalAccountContentSnapshot(value)) as AccountContentSnapshot;
  } catch (error) {
    throw new AccountReplicationError(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_input',
    );
  }
}
function remote(value: unknown, ownerId: string): AccountContentRemoteState {
  requireData(
    exact(value, remoteKeys) &&
      value.ownerId === ownerId &&
      revision(value.revision) &&
      (value.deletionOperationId === null || matches(value.deletionOperationId, uuidPattern)),
  );
  if (value.revision === 0) {
    requireData(value.snapshot === null && value.updatedAt === null);
    return {
      ownerId,
      revision: 0,
      snapshot: null,
      updatedAt: null,
      deletionOperationId: value.deletionOperationId,
    };
  }
  requireData(accountRemoteTimestamp(value.updatedAt));
  return {
    ownerId,
    revision: value.revision,
    snapshot: snapshot(value.snapshot),
    updatedAt: value.updatedAt,
    deletionOperationId: value.deletionOperationId,
  };
}
export function normalizeAccountContentRemoteState(
  input: unknown,
  ownerId: string,
): Immutable<AccountContentRemoteState> {
  requireData(matches(ownerId, uuidPattern));
  return freeze(remote(ownRecord(input, remoteKeys, ACCOUNT_SNAPSHOT_MAX_BYTES + 4096), ownerId));
}
function capture(value: unknown): AccountContentJournalCapture {
  requireData(
    exact(value, ['storeRevision', 'snapshot', 'scope', 'fenceDigest']) &&
      revision(value.storeRevision) &&
      fingerprint(value.fenceDigest) &&
      validateAccountContentCaptureScope(value.scope),
  );
  const projected = snapshot(value.snapshot);
  requireData(Object.hasOwn(projected, 'cookingHistory') === value.scope.historyIncluded);
  return {
    storeRevision: value.storeRevision,
    snapshot: projected,
    scope: value.scope,
    fenceDigest: value.fenceDigest,
  };
}
function historyMatches(
  left: AccountContentSnapshot,
  right: AccountContentSnapshot | null,
): boolean {
  if (
    Object.hasOwn(left, 'cookingHistory') !==
    (right !== null && Object.hasOwn(right, 'cookingHistory'))
  )
    return false;
  return (
    !Object.hasOwn(left, 'cookingHistory') ||
    bounded(left.cookingHistory, ACCOUNT_SNAPSHOT_MAX_BYTES) ===
      bounded(right!.cookingHistory, ACCOUNT_SNAPSHOT_MAX_BYTES)
  );
}
function draft(value: unknown, ownerId: string): AccountContentPendingDraft {
  requireData(
    exact(value, draftKeys) &&
      matches(value.operationId, uuidPattern) &&
      (value.mode === 'push' || value.mode === 'pull'),
  );
  const capturedLocal = capture(value.capturedLocal),
    observed = remote(value.remote, ownerId),
    proposed = snapshot(value.proposed);
  requireData(
    observed.deletionOperationId === null &&
      catalogueMatches(capturedLocal.snapshot.catalogue, proposed.catalogue) &&
      (observed.snapshot === null ||
        catalogueMatches(observed.snapshot.catalogue, proposed.catalogue)),
  );
  requireData(
    capturedLocal.scope.historyIncluded
      ? Object.hasOwn(proposed, 'cookingHistory')
      : historyMatches(proposed, observed.snapshot),
  );
  requireData(
    value.mode !== 'pull' ||
      (observed.snapshot !== null &&
        canonicalAccountContentSnapshot(observed.snapshot) ===
          canonicalAccountContentSnapshot(proposed)),
  );
  return {
    operationId: value.operationId,
    mode: value.mode,
    capturedLocal,
    remote: observed,
    proposed,
  };
}
function requestJson(
  ownerId: string,
  installationId: string,
  legacyJournalDigest: string | null,
  value: Immutable<AccountContentPendingDraft>,
): string {
  return canonicalRecord({ ownerId, installationId, legacyJournalDigest, ...value }, [
    'ownerId',
    'installationId',
    'legacyJournalDigest',
    ...draftKeys,
  ]);
}
async function digest(serialized: string, sha256: Sha256): Promise<string> {
  const result = await sha256(serialized);
  requireData(fingerprint(result));
  return result;
}
/** Own and validate every immutable request field before the first hash await. */
export async function accountContentPendingFingerprint(
  ownerId: string,
  installationId: string,
  legacyJournalDigest: string | null,
  input: AccountContentPendingDraft | Immutable<AccountContentPendingDraft>,
  sha256: Sha256,
): Promise<string> {
  requireData(
    matches(ownerId, uuidPattern) &&
      matches(installationId, uuidPattern) &&
      (legacyJournalDigest === null || fingerprint(legacyJournalDigest)),
  );
  const value = draft(ownRecord(input, draftKeys), ownerId);
  return digest(requestJson(ownerId, installationId, legacyJournalDigest, value), sha256);
}
function acknowledgement(
  value: unknown,
  ownerId: string,
  operationId: string,
  previousRevision: number,
): AccountCommitReceipt {
  requireData(
    exact(value, ['ownerId', 'operationId', 'revision', 'committedAt']) &&
      value.ownerId === ownerId &&
      value.operationId === operationId &&
      revision(value.revision) &&
      value.revision === previousRevision + 1 &&
      accountRemoteTimestamp(value.committedAt),
  );
  return { ownerId, operationId, revision: value.revision, committedAt: value.committedAt };
}
function applied(value: unknown, ownerId: string): AccountContentJournalApplyReceipt {
  requireData(
    exact(value, [
      'ownerId',
      'operationId',
      'storeRevision',
      'serverRevision',
      'appliedAt',
      'requestFingerprint',
    ]) &&
      value.ownerId === ownerId &&
      matches(value.operationId, uuidPattern) &&
      revision(value.storeRevision) &&
      value.storeRevision > 0 &&
      revision(value.serverRevision) &&
      value.serverRevision > 0 &&
      instant(value.appliedAt) &&
      fingerprint(value.requestFingerprint),
  );
  return {
    ownerId,
    operationId: value.operationId,
    storeRevision: value.storeRevision,
    serverRevision: value.serverRevision,
    appliedAt: value.appliedAt,
    requestFingerprint: value.requestFingerprint,
  };
}
function normalizeJournal(
  input: unknown,
  ownerId: string,
  installationId: string,
): Immutable<AccountContentReplicationJournal> {
  requireData(matches(ownerId, uuidPattern) && matches(installationId, uuidPattern));
  const value = ownRecord(input, journalKeys);
  requireData(
    value.schemaVersion === 3 &&
      value.ownerId === ownerId &&
      value.installationId === installationId &&
      revision(value.revision) &&
      value.revision > 0 &&
      (value.legacyJournalDigest === null || fingerprint(value.legacyJournalDigest)) &&
      validateAccountContentCaptureScope(value.scope),
  );
  const base = value.base === null ? null : remote(value.base, ownerId),
    lastApply = value.lastApply === null ? null : applied(value.lastApply, ownerId);
  requireData(
    (base === null) === (lastApply === null) &&
      (base === null ||
        (base.revision > 0 &&
          base.deletionOperationId === null &&
          base.revision === lastApply!.serverRevision)),
  );
  const observed = value.observed;
  requireData(
    exact(observed, ['revision', 'snapshotDigest', 'updatedAt']) &&
      revision(observed.revision) &&
      (observed.revision === 0
        ? observed.snapshotDigest === null && observed.updatedAt === null
        : fingerprint(observed.snapshotDigest) && accountRemoteTimestamp(observed.updatedAt)),
  );
  const fence = {
    revision: observed.revision,
    snapshotDigest: observed.snapshotDigest as string | null,
    updatedAt: observed.updatedAt as string | null,
  };
  requireData(base === null || base.revision <= fence.revision);
  let pending: AccountContentPendingReplication | null = null;
  if (value.pending !== null) {
    const p = value.pending;
    requireData(
      exact(p, [...draftKeys, 'requestFingerprint', 'proposedDigest', 'acknowledgement']) &&
        fingerprint(p.requestFingerprint) &&
        fingerprint(p.proposedDigest),
    );
    const candidate = draft(
      {
        operationId: p.operationId,
        mode: p.mode,
        capturedLocal: p.capturedLocal,
        remote: p.remote,
        proposed: p.proposed,
      },
      ownerId,
    );
    requireData(
      accountContentCaptureScopesEqual(value.scope, candidate.capturedLocal.scope) &&
        candidate.remote.revision === fence.revision &&
        candidate.remote.updatedAt === fence.updatedAt &&
        (base === null ||
          (catalogueMatches(base.snapshot!.catalogue, candidate.proposed.catalogue) &&
            candidate.remote.revision >= base.revision)) &&
        (lastApply === null ||
          (lastApply.operationId !== candidate.operationId &&
            candidate.capturedLocal.storeRevision >= lastApply.storeRevision)) &&
        (candidate.mode !== 'pull' || p.acknowledgement === null),
    );
    pending = {
      ...candidate,
      requestFingerprint: p.requestFingerprint,
      proposedDigest: p.proposedDigest,
      acknowledgement:
        p.acknowledgement === null
          ? null
          : acknowledgement(
              p.acknowledgement,
              ownerId,
              candidate.operationId,
              candidate.remote.revision,
            ),
    };
  }
  return freeze({
    schemaVersion: 3,
    ownerId,
    installationId,
    revision: value.revision,
    legacyJournalDigest: value.legacyJournalDigest,
    scope: value.scope,
    base,
    observed: fence,
    pending,
    lastApply,
  });
}
async function verifyJournal(
  value: Immutable<AccountContentReplicationJournal>,
  sha256: Sha256,
): Promise<void> {
  // Freeze owned strings and inputs before any await; no caller mutation changes a later hash.
  const baseJson = value.base?.snapshot
    ? canonicalAccountContentSnapshot(value.base.snapshot)
    : null;
  const pending = value.pending;
  const remoteJson = pending?.remote.snapshot
    ? canonicalAccountContentSnapshot(pending.remote.snapshot)
    : null;
  const proposedJson = pending ? canonicalAccountContentSnapshot(pending.proposed) : null;
  const request = pending
    ? requestJson(value.ownerId, value.installationId, value.legacyJournalDigest, {
        operationId: pending.operationId,
        mode: pending.mode,
        capturedLocal: pending.capturedLocal,
        remote: pending.remote,
        proposed: pending.proposed,
      })
    : null;
  if (value.base?.revision === value.observed.revision) {
    requireData(
      value.base.updatedAt === value.observed.updatedAt &&
        baseJson !== null &&
        (await digest(baseJson, sha256)) === value.observed.snapshotDigest,
    );
  }
  if (!pending) return;
  requireData(
    (remoteJson === null ? null : await digest(remoteJson, sha256)) ===
      value.observed.snapshotDigest,
  );
  if (value.base && value.base.revision === pending.remote.revision)
    requireData(baseJson === remoteJson && value.base.updatedAt === pending.remote.updatedAt);
  requireData(
    (await digest(proposedJson!, sha256)) === pending.proposedDigest &&
      (await digest(request!, sha256)) === pending.requestFingerprint,
  );
}

/** Canonical serialization checks hashes; checksums do not authenticate a server or grant apply authority. */
export async function serializeAccountContentJournal(
  input: unknown,
  ownerId: string,
  installationId: string,
  sha256: Sha256,
): Promise<string> {
  const value = normalizeJournal(input, ownerId, installationId);
  await verifyJournal(value, sha256);
  return canonicalRecord(value, journalKeys);
}
export async function parseAccountContentJournal(
  serialized: string,
  ownerId: string,
  installationId: string,
  sha256: Sha256,
): Promise<Immutable<AccountContentReplicationJournal>> {
  if (typeof serialized !== 'string') throw new AccountReplicationError('stored_data_invalid');
  if (
    serialized.length > ACCOUNT_CONTENT_JOURNAL_MAX_BYTES ||
    portableBackupByteLength(serialized) > ACCOUNT_CONTENT_JOURNAL_MAX_BYTES
  )
    throw new AccountReplicationError('too_large');
  try {
    let raw: unknown;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new AccountReplicationError('stored_data_invalid');
    }
    const value = normalizeJournal(raw, ownerId, installationId);
    await verifyJournal(value, sha256);
    return value;
  } catch (error) {
    if (error instanceof AccountReplicationError && error.reason !== 'too_large')
      throw new AccountReplicationError('stored_data_invalid');
    throw error;
  }
}
