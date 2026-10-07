import { catalogueMatches } from '@cookmate/contracts';
import {
  PORTABLE_BACKUP_MAX_BYTES,
  portableBackupByteLength,
  type Immutable,
} from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../domain/src/portableBackupContent';
import { canonicalAccountContentSnapshot, type AccountContentSnapshot } from './contentSnapshot';
import { validateAccountContentCaptureScope } from './contentScope';
import type {
  AccountContentJournalApplyReceipt,
  AccountContentJournalCapture,
} from './contentReplicationRecords';
import {
  accountRemoteTimestamp,
  type AccountCommitReceipt,
  type AccountRemoteState,
} from './remote';
import { AccountReplicationError } from './replicationTypes';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  type AccountMergeResolutions,
  type AccountSnapshot,
} from './types';
import {
  canonicalAccountSnapshot,
  normalizeAccountSnapshot,
  parseAccountSnapshot,
} from './validation';
import {
  exact,
  fingerprintPattern,
  instant,
  matches,
  record,
  uuidPattern,
} from './validationPrimitives';

export const ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES = 4 * ACCOUNT_SNAPSHOT_MAX_BYTES + 65536;
export const ACCOUNT_LEGACY_CONTENT_RESOLUTIONS_MAX_BYTES = 32768;
const maximumResolutions = 1000;
type Sha256 = (text: string) => Promise<string>;

export interface AccountLegacyContentTransitionDraft {
  ownerId: string;
  installationId: string;
  legacy: {
    /** Hash of exact bytes remaining in the original legacy journal key. */
    journalDigest: string;
    journalRevision: number;
    base: AccountRemoteState | null;
    observed: { revision: number; snapshotDigest: string | null; updatedAt: string | null };
    /** Derived semantic evidence only; never an original remote observation. */
    baseProjectionDigest: string | null;
  };
  /** Actual original nonempty format1/2 server response, never a projected format3 response. */
  remote: AccountRemoteState;
  remoteDigest: string;
  remoteProjectionDigest: string;
  capturedLocal: AccountContentJournalCapture;
  networkOperationId: string;
  localApplyOperationId: string;
  proposed: AccountContentSnapshot;
  proposedDigest: string;
  /** Retained choices, not permission to dispatch or apply. The host must recompute the review. */
  review: { initialImportReviewed: boolean; resolutions: AccountMergeResolutions };
}
export interface AccountLegacyContentTransition extends AccountLegacyContentTransitionDraft {
  schemaVersion: 1;
  kind: 'legacy_to_content3';
  revision: number;
  requestFingerprint: string;
  acknowledgement: AccountCommitReceipt | null;
  handoff: { requestFingerprint: string } | null;
  lastApply: AccountContentJournalApplyReceipt | null;
}

const draftKeys = [
  'ownerId',
  'installationId',
  'legacy',
  'remote',
  'remoteDigest',
  'remoteProjectionDigest',
  'capturedLocal',
  'networkOperationId',
  'localApplyOperationId',
  'proposed',
  'proposedDigest',
  'review',
];
const storedKeys = [
  ...draftKeys,
  'schemaVersion',
  'kind',
  'revision',
  'requestFingerprint',
  'acknowledgement',
  'handoff',
  'lastApply',
];
const remoteKeys = ['ownerId', 'revision', 'snapshot', 'updatedAt', 'deletionOperationId'];
const fieldLimits: Readonly<Record<string, number>> = {
  legacy: ACCOUNT_SNAPSHOT_MAX_BYTES + 8192,
  remote: ACCOUNT_SNAPSHOT_MAX_BYTES + 4096,
  capturedLocal: ACCOUNT_SNAPSHOT_MAX_BYTES + 8192,
  proposed: ACCOUNT_SNAPSHOT_MAX_BYTES,
  review: ACCOUNT_LEGACY_CONTENT_RESOLUTIONS_MAX_BYTES + 1024,
};
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
/** Four individually capped snapshots may exceed the portable encoder's8MiB aggregate cap. */
function canonicalRecord(value: unknown, keys: readonly string[]): string {
  requireData(exact(value, keys));
  const chunks = ['{'];
  let bytes = 2;
  for (const [index, key] of [...keys].sort().entries()) {
    const prefix = (index ? ',' : '') + JSON.stringify(key) + ':';
    bytes += prefix.length;
    if (bytes >= ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES)
      throw new AccountReplicationError('too_large');
    const encoded = bounded(
      value[key],
      Math.min(
        fieldLimits[key] ?? 4096,
        PORTABLE_BACKUP_MAX_BYTES,
        ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES - bytes,
      ),
    );
    bytes += portableBackupByteLength(encoded);
    chunks.push(prefix, encoded);
  }
  chunks.push('}');
  return chunks.join('');
}
function ownRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  return JSON.parse(canonicalRecord(input, keys)) as Record<string, unknown>;
}
function legacySnapshot(value: unknown): AccountSnapshot {
  try {
    return normalizeAccountSnapshot(
      parseAccountSnapshot(bounded(value, ACCOUNT_SNAPSHOT_MAX_BYTES)),
    );
  } catch (error) {
    if (error instanceof Error && 'reason' in error && error.reason === 'too_large')
      throw new AccountReplicationError('too_large');
    throw new AccountReplicationError('invalid_input');
  }
}
function contentSnapshot(value: unknown): AccountContentSnapshot {
  try {
    return JSON.parse(canonicalAccountContentSnapshot(value)) as AccountContentSnapshot;
  } catch (error) {
    throw new AccountReplicationError(
      error instanceof Error && 'reason' in error && error.reason === 'too_large'
        ? 'too_large'
        : 'invalid_input',
    );
  }
}
function legacyRemote(input: unknown, ownerId: string): AccountRemoteState {
  requireData(
    exact(input, remoteKeys) &&
      input.ownerId === ownerId &&
      revision(input.revision) &&
      input.revision > 0 &&
      input.revision < Number.MAX_SAFE_INTEGER &&
      accountRemoteTimestamp(input.updatedAt) &&
      input.deletionOperationId === null,
  );
  return {
    ownerId,
    revision: input.revision,
    snapshot: legacySnapshot(input.snapshot),
    updatedAt: input.updatedAt,
    deletionOperationId: null,
  };
}
function captured(input: unknown): AccountContentJournalCapture {
  requireData(
    exact(input, ['storeRevision', 'snapshot', 'scope', 'fenceDigest']) &&
      revision(input.storeRevision) &&
      validateAccountContentCaptureScope(input.scope) &&
      fingerprint(input.fenceDigest),
  );
  const snapshot = contentSnapshot(input.snapshot);
  requireData(Object.hasOwn(snapshot, 'cookingHistory') === input.scope.historyIncluded);
  return {
    storeRevision: input.storeRevision,
    snapshot,
    scope: input.scope,
    fenceDigest: input.fenceDigest,
  };
}
function normalizeDraft(
  input: Record<string, unknown>,
): Immutable<AccountLegacyContentTransitionDraft> {
  requireData(
    matches(input.ownerId, uuidPattern) &&
      matches(input.installationId, uuidPattern) &&
      matches(input.networkOperationId, uuidPattern) &&
      matches(input.localApplyOperationId, uuidPattern) &&
      input.networkOperationId !== input.localApplyOperationId &&
      fingerprint(input.remoteDigest) &&
      fingerprint(input.remoteProjectionDigest) &&
      fingerprint(input.proposedDigest),
  );
  const old = input.legacy;
  requireData(
    exact(old, ['journalDigest', 'journalRevision', 'base', 'observed', 'baseProjectionDigest']) &&
      fingerprint(old.journalDigest) &&
      revision(old.journalRevision) &&
      old.journalRevision > 0,
  );
  const base = old.base === null ? null : legacyRemote(old.base, input.ownerId);
  requireData(
    base === null ? old.baseProjectionDigest === null : fingerprint(old.baseProjectionDigest),
  );
  const observed = old.observed;
  requireData(
    exact(observed, ['revision', 'snapshotDigest', 'updatedAt']) &&
      revision(observed.revision) &&
      (observed.revision === 0
        ? observed.snapshotDigest === null && observed.updatedAt === null
        : fingerprint(observed.snapshotDigest) && accountRemoteTimestamp(observed.updatedAt)),
  );
  const remote = legacyRemote(input.remote, input.ownerId);
  const capturedLocal = captured(input.capturedLocal),
    proposed = contentSnapshot(input.proposed);
  requireData(
    remote.revision >= observed.revision &&
      (base === null ||
        (base.revision <= observed.revision &&
          base.snapshot!.schemaVersion <= remote.snapshot!.schemaVersion)) &&
      catalogueMatches(remote.snapshot!.catalogue, proposed.catalogue) &&
      catalogueMatches(capturedLocal.snapshot.catalogue, proposed.catalogue) &&
      (base === null || catalogueMatches(base.snapshot!.catalogue, proposed.catalogue)),
  );
  requireData(!capturedLocal.scope.historyIncluded || Object.hasOwn(proposed, 'cookingHistory'));
  // Excluded history equality, authentic projection digests and actual review choices require
  // the host's verified legacy converter/merge. Shape/hash validation cannot grant that authority.
  const review = input.review;
  requireData(
    exact(review, ['initialImportReviewed', 'resolutions']) &&
      typeof review.initialImportReviewed === 'boolean' &&
      record(review.resolutions),
  );
  bounded(review.resolutions, ACCOUNT_LEGACY_CONTENT_RESOLUTIONS_MAX_BYTES);
  const resolutions = Object.entries(review.resolutions);
  requireData(
    resolutions.length <= maximumResolutions &&
      resolutions.every(
        ([key, choice]) => key.length > 0 && (choice === 'local' || choice === 'account'),
      ),
  );
  return freeze({
    ownerId: input.ownerId,
    installationId: input.installationId,
    legacy: {
      journalDigest: old.journalDigest,
      journalRevision: old.journalRevision,
      base,
      observed: {
        revision: observed.revision,
        snapshotDigest: observed.snapshotDigest as string | null,
        updatedAt: observed.updatedAt as string | null,
      },
      baseProjectionDigest: old.baseProjectionDigest as string | null,
    },
    remote,
    remoteDigest: input.remoteDigest,
    remoteProjectionDigest: input.remoteProjectionDigest,
    capturedLocal,
    networkOperationId: input.networkOperationId,
    localApplyOperationId: input.localApplyOperationId,
    proposed,
    proposedDigest: input.proposedDigest,
    review: {
      initialImportReviewed: review.initialImportReviewed,
      resolutions: review.resolutions as AccountMergeResolutions,
    },
  });
}
function requestJson(value: Immutable<AccountLegacyContentTransitionDraft>) {
  return canonicalRecord({ domain: 'cookmate-account-legacy-content-transition-v1', ...value }, [
    'domain',
    ...draftKeys,
  ]);
}
async function digest(serialized: string, sha256: Sha256) {
  const value = await sha256(serialized);
  requireData(fingerprint(value));
  return value;
}
async function verifyDraft(value: Immutable<AccountLegacyContentTransitionDraft>, sha256: Sha256) {
  const { base, observed } = value.legacy;
  const remoteDigest = await digest(
    canonicalAccountSnapshot(value.remote.snapshot! as AccountSnapshot),
    sha256,
  );
  requireData(remoteDigest === value.remoteDigest);
  if (value.remote.revision === observed.revision)
    requireData(
      value.remote.updatedAt === observed.updatedAt && remoteDigest === observed.snapshotDigest,
    );
  if (base !== null && base.revision === observed.revision)
    requireData(
      base.updatedAt === observed.updatedAt &&
        (await digest(canonicalAccountSnapshot(base.snapshot! as AccountSnapshot), sha256)) ===
          observed.snapshotDigest,
    );
  requireData(
    (await digest(canonicalAccountContentSnapshot(value.proposed), sha256)) ===
      value.proposedDigest,
  );
}
function stored(
  input: unknown,
  ownerId: string,
  installationId: string,
): Immutable<AccountLegacyContentTransition> {
  requireData(matches(ownerId, uuidPattern) && matches(installationId, uuidPattern));
  const value = ownRecord(input, storedKeys);
  requireData(
    value.schemaVersion === 1 &&
      value.kind === 'legacy_to_content3' &&
      value.ownerId === ownerId &&
      value.installationId === installationId &&
      revision(value.revision) &&
      value.revision > 0 &&
      value.revision < Number.MAX_SAFE_INTEGER &&
      fingerprint(value.requestFingerprint),
  );
  const draft = normalizeDraft(value);
  let acknowledgement: AccountCommitReceipt | null = null;
  if (value.acknowledgement !== null) {
    const ack = value.acknowledgement;
    requireData(
      exact(ack, ['ownerId', 'operationId', 'revision', 'committedAt']) &&
        ack.ownerId === ownerId &&
        ack.operationId === draft.networkOperationId &&
        revision(ack.revision) &&
        ack.revision === draft.remote.revision + 1 &&
        accountRemoteTimestamp(ack.committedAt),
    );
    acknowledgement = {
      ownerId,
      operationId: draft.networkOperationId,
      revision: ack.revision,
      committedAt: ack.committedAt,
    };
  }
  let handoff: AccountLegacyContentTransition['handoff'] = null;
  if (value.handoff !== null) {
    requireData(
      acknowledgement !== null &&
        exact(value.handoff, ['requestFingerprint']) &&
        fingerprint(value.handoff.requestFingerprint),
    );
    handoff = { requestFingerprint: value.handoff.requestFingerprint };
  }
  let lastApply: AccountContentJournalApplyReceipt | null = null;
  if (value.lastApply !== null) {
    const applied = value.lastApply;
    requireData(
      acknowledgement !== null &&
        handoff !== null &&
        exact(applied, [
          'ownerId',
          'operationId',
          'storeRevision',
          'serverRevision',
          'appliedAt',
          'requestFingerprint',
        ]) &&
        applied.ownerId === ownerId &&
        applied.operationId === draft.localApplyOperationId &&
        revision(applied.storeRevision) &&
        applied.storeRevision > 0 &&
        applied.storeRevision >= draft.capturedLocal.storeRevision &&
        applied.serverRevision === acknowledgement.revision &&
        instant(applied.appliedAt) &&
        applied.requestFingerprint === handoff.requestFingerprint,
    );
    lastApply = {
      ownerId,
      operationId: draft.localApplyOperationId,
      storeRevision: applied.storeRevision,
      serverRevision: acknowledgement.revision,
      appliedAt: applied.appliedAt,
      requestFingerprint: handoff.requestFingerprint,
    };
  }
  return freeze({
    ...draft,
    schemaVersion: 1,
    kind: 'legacy_to_content3',
    revision: value.revision,
    requestFingerprint: value.requestFingerprint,
    acknowledgement,
    handoff,
    lastApply,
  });
}
function draftOf(value: Immutable<AccountLegacyContentTransition>) {
  const {
    schemaVersion: _version,
    kind: _kind,
    revision: _revision,
    requestFingerprint: _fingerprint,
    acknowledgement: _ack,
    handoff: _handoff,
    lastApply: _applied,
    ...draft
  } = value;
  return draft;
}

/** Canonical evidence only. The host must separately verify scope, projections and review authority. */
export async function accountLegacyContentTransitionFingerprint(
  input: AccountLegacyContentTransitionDraft | Immutable<AccountLegacyContentTransitionDraft>,
  sha256: Sha256,
): Promise<string> {
  const hash = sha256;
  requireData(typeof hash === 'function');
  const value = normalizeDraft(ownRecord(input, draftKeys));
  const json = requestJson(value);
  await verifyDraft(value, hash);
  return digest(json, hash);
}
export async function serializeAccountLegacyContentTransition(
  input: unknown,
  ownerId: string,
  installationId: string,
  sha256: Sha256,
): Promise<string> {
  const hash = sha256;
  requireData(typeof hash === 'function');
  const value = stored(input, ownerId, installationId),
    draft = draftOf(value);
  const serialized = canonicalRecord(value, storedKeys),
    request = requestJson(draft);
  await verifyDraft(draft, hash);
  requireData((await digest(request, hash)) === value.requestFingerprint);
  return serialized;
}
export async function parseAccountLegacyContentTransition(
  serialized: string,
  ownerId: string,
  installationId: string,
  sha256: Sha256,
): Promise<Immutable<AccountLegacyContentTransition>> {
  const hash = sha256;
  if (typeof serialized !== 'string' || typeof hash !== 'function')
    throw new AccountReplicationError('stored_data_invalid');
  if (
    serialized.length > ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES ||
    portableBackupByteLength(serialized) > ACCOUNT_LEGACY_CONTENT_TRANSITION_MAX_BYTES
  )
    throw new AccountReplicationError('too_large');
  let input: unknown;
  try {
    input = JSON.parse(serialized);
  } catch {
    throw new AccountReplicationError('stored_data_invalid');
  }
  try {
    const value = stored(input, ownerId, installationId),
      draft = draftOf(value);
    const request = requestJson(draft);
    await verifyDraft(draft, hash);
    requireData((await digest(request, hash)) === value.requestFingerprint);
    return value;
  } catch (error) {
    if (error instanceof AccountReplicationError && error.reason !== 'too_large')
      throw new AccountReplicationError('stored_data_invalid');
    throw error;
  }
}
