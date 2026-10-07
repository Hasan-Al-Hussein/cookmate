import { catalogueMatches } from '@cookmate/contracts';
import type { CatalogueIdentity } from '@cookmate/contracts';
import { portableBackupByteLength } from '@cookmate/domain';
import {
  ACCOUNT_SNAPSHOT_MAX_BYTES,
  accountCaptureScope,
  accountCaptureScopesEqual,
  accountSnapshotsEqual,
  canonicalAccountSnapshot,
  emptyAccountSnapshot,
  normalizeAccountSnapshot,
  validateAccountCaptureScope,
} from '@cookmate/account-sync';
import type {
  AccountCommitReceipt,
  AccountRemoteState,
  AccountSnapshot,
  AccountSnapshotOptions,
} from '@cookmate/account-sync';
import { AccountReplicationError } from '@cookmate/account-sync';
import type {
  AccountApplyReceipt,
  AccountLocalCapture,
  AccountPendingSettings,
  AccountReplicationJournal,
} from '@cookmate/account-sync';
import { runBound } from './sql';
import type { SqlSession } from './sql';

// Four bounded snapshots can coexist during a durable, recoverable three-way merge.
export const ACCOUNT_JOURNAL_MAX_BYTES = 4 * ACCOUNT_SNAPSHOT_MAX_BYTES + 65536;
export const ACCOUNT_BINDING_KEY = 'account-replication:owner';
export const ACCOUNT_SETTINGS_KEY = 'account-replication:settings';
export const ACCOUNT_APPLY_EPOCH_KEY = 'account-replication:apply-epoch';
export const ACCOUNT_GUEST_KEY = 'account-replication:initial-guest';
export const journalKey = (ownerId: string) => `account-replication:journal:${ownerId}`;
export function fail(reason: ConstructorParameters<typeof AccountReplicationError>[0]): never {
  throw new AccountReplicationError(reason);
}
export const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const instant = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
  );
};
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return false;
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable;
    })
  );
}
export function snapshotOptions(
  value: unknown,
  catalogue: Readonly<CatalogueIdentity>,
): AccountSnapshotOptions {
  if (!exact(value, ['appPreferences', 'profile'])) fail('invalid_input');
  // emptyAccountSnapshot projects fields; validate extras before that projection.
  if (
    !exact(value.appPreferences, ['theme', 'motion', 'locale']) ||
    !exact(value.profile, ['displayName'])
  )
    fail('invalid_input');
  const checked = emptyAccountSnapshot(catalogue, value as unknown as AccountSnapshotOptions);
  return { appPreferences: checked.appPreferences, profile: checked.profile };
}
export function capture(value: unknown): AccountLocalCapture {
  if (
    !(
      exact(value, ['storeRevision', 'snapshot']) ||
      exact(value, ['storeRevision', 'snapshot', 'scope'])
    ) ||
    !revision(value.storeRevision)
  )
    fail('invalid_input');
  if (Object.hasOwn(value, 'scope') && !validateAccountCaptureScope(value.scope))
    fail('invalid_input');
  const result: AccountLocalCapture = {
    storeRevision: value.storeRevision,
    snapshot: normalizeAccountSnapshot(value.snapshot as AccountSnapshot),
    ...(validateAccountCaptureScope(value.scope) ? { scope: { ...value.scope } } : {}),
  };
  accountCaptureScope(result);
  return result;
}
export function remoteState(value: unknown, ownerId: string): AccountRemoteState {
  if (
    !exact(value, ['ownerId', 'revision', 'snapshot', 'updatedAt', 'deletionOperationId']) ||
    value.ownerId !== ownerId ||
    !revision(value.revision) ||
    (value.deletionOperationId !== null && !uuid(value.deletionOperationId))
  )
    fail('invalid_input');
  if (value.revision === 0) {
    if (value.snapshot !== null || value.updatedAt !== null) fail('invalid_input');
    return {
      ownerId,
      revision: 0,
      snapshot: null,
      updatedAt: null,
      deletionOperationId: value.deletionOperationId,
    };
  }
  if (!instant(value.updatedAt)) fail('invalid_input');
  return {
    ownerId,
    revision: value.revision,
    snapshot: normalizeAccountSnapshot(value.snapshot as AccountSnapshot),
    updatedAt: value.updatedAt,
    deletionOperationId: value.deletionOperationId,
  };
}
export function commitReceipt(
  value: unknown,
  ownerId: string,
  operationId: string,
  expectedRevision: number,
): AccountCommitReceipt {
  if (
    !exact(value, ['ownerId', 'operationId', 'revision', 'committedAt']) ||
    value.ownerId !== ownerId ||
    value.operationId !== operationId ||
    !uuid(operationId) ||
    !revision(value.revision) ||
    value.revision !== expectedRevision + 1 ||
    !instant(value.committedAt)
  )
    fail('invalid_input');
  return { ownerId, operationId, revision: value.revision, committedAt: value.committedAt };
}
function applyReceipt(value: unknown, ownerId: string): AccountApplyReceipt {
  if (
    !exact(value, ['ownerId', 'operationId', 'storeRevision', 'serverRevision', 'appliedAt']) ||
    value.ownerId !== ownerId ||
    !uuid(value.operationId) ||
    !revision(value.storeRevision) ||
    value.storeRevision === 0 ||
    !revision(value.serverRevision) ||
    value.serverRevision === 0 ||
    !instant(value.appliedAt)
  )
    fail('stored_data_invalid');
  return value as unknown as AccountApplyReceipt;
}
export function assertSnapshotCatalogue(
  snapshot: AccountSnapshot,
  catalogue: Readonly<CatalogueIdentity>,
  knownRecipeIds: ReadonlySet<string>,
): void {
  if (!catalogueMatches(snapshot.catalogue, catalogue)) fail('catalogue_mismatch');
  if (
    snapshot.favourites.some((item) => !knownRecipeIds.has(item.recipeId)) ||
    snapshot.plan.some((item) => !knownRecipeIds.has(item.recipeId)) ||
    (snapshot.schemaVersion === 2 &&
      (snapshot.personal.notes.some((item) => !knownRecipeIds.has(item.recipeId)) ||
        snapshot.personal.memberships.some((item) => !knownRecipeIds.has(item.recipeId)) ||
        snapshot.cookingHistory?.entries.some((item) => !knownRecipeIds.has(item.recipeId))))
  )
    fail('unknown_recipe');
}
export function sameRemote(left: AccountRemoteState, right: AccountRemoteState): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt &&
    left.deletionOperationId === right.deletionOperationId &&
    (left.snapshot === null
      ? right.snapshot === null
      : right.snapshot !== null && accountSnapshotsEqual(left.snapshot, right.snapshot))
  );
}
export async function readMetadata(
  session: SqlSession,
  key: string,
  maxBytes = ACCOUNT_JOURNAL_MAX_BYTES,
): Promise<unknown | null> {
  const row = (
    await session.all<{ bytes: number; value: string | null }>(
      'SELECT length(CAST(value AS BLOB)) AS bytes, CASE WHEN length(CAST(value AS BLOB))<=? THEN value ELSE NULL END AS value FROM app_metadata WHERE key=?',
      [maxBytes, key],
    )
  )[0];
  if (!row) return null;
  if (row.bytes > maxBytes) fail('too_large');
  if (typeof row.value !== 'string') fail('stored_data_invalid');
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (parsed === null) fail('stored_data_invalid');
    return parsed;
  } catch {
    return fail('stored_data_invalid');
  }
}
export async function writeMetadata(
  session: SqlSession,
  key: string,
  value: unknown,
  maxBytes = ACCOUNT_JOURNAL_MAX_BYTES,
): Promise<void> {
  const serialized = JSON.stringify(value);
  if (portableBackupByteLength(serialized) > maxBytes) fail('too_large');
  await runBound(
    session,
    'INSERT INTO app_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, serialized],
  );
}
export async function readBinding(session: SqlSession): Promise<string | null> {
  const value = await readMetadata(session, ACCOUNT_BINDING_KEY, 256);
  if (value === null) return null;
  if (
    !exact(value, ['schemaVersion', 'ownerId']) ||
    value.schemaVersion !== 1 ||
    !uuid(value.ownerId)
  )
    fail('stored_data_invalid');
  return value.ownerId;
}
export async function readPendingSettings(
  session: SqlSession,
  catalogue: Readonly<CatalogueIdentity>,
): Promise<AccountPendingSettings | null> {
  const value = await readMetadata(session, ACCOUNT_SETTINGS_KEY, 4096);
  if (value === null) return null;
  try {
    if (
      !exact(value, ['ownerId', 'operationId', 'previous', 'projection']) ||
      !uuid(value.ownerId) ||
      !uuid(value.operationId)
    )
      fail('stored_data_invalid');
    return {
      ownerId: value.ownerId,
      operationId: value.operationId,
      previous: snapshotOptions(value.previous, catalogue),
      projection: snapshotOptions(value.projection, catalogue),
    };
  } catch {
    return fail('stored_data_invalid');
  }
}
export async function readJournal(
  session: SqlSession,
  ownerId: string,
  sha256: (value: string) => Promise<string>,
): Promise<AccountReplicationJournal | null> {
  const value = await readMetadata(session, journalKey(ownerId));
  if (value === null) return null;
  try {
    const journalKeys = [
      'schemaVersion',
      'ownerId',
      'revision',
      'base',
      'observed',
      'pending',
      'lastApply',
    ];
    if (
      !(exact(value, journalKeys) || exact(value, [...journalKeys, 'scope'])) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
      (value.schemaVersion === 1
        ? Object.hasOwn(value, 'scope')
        : !validateAccountCaptureScope(value.scope)) ||
      value.ownerId !== ownerId ||
      !revision(value.revision) ||
      value.revision === 0
    )
      fail('stored_data_invalid');
    const base = value.base === null ? null : remoteState(value.base, ownerId);
    if (base?.deletionOperationId !== null && base !== null) fail('stored_data_invalid');
    const lastApply = value.lastApply === null ? null : applyReceipt(value.lastApply, ownerId);
    if (
      (lastApply === null) !== (base === null) ||
      (lastApply && (!base || base.revision !== lastApply.serverRevision))
    )
      fail('stored_data_invalid');
    const observed = value.observed;
    if (
      observed === null ||
      !exact(observed, ['revision', 'snapshotDigest', 'updatedAt']) ||
      !revision(observed.revision) ||
      (observed.revision === 0
        ? observed.snapshotDigest !== null || observed.updatedAt !== null
        : typeof observed.snapshotDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(observed.snapshotDigest) ||
          !instant(observed.updatedAt))
    )
      fail('stored_data_invalid');
    const fence = observed as AccountReplicationJournal['observed'];
    if (
      base &&
      (!fence ||
        base.revision > fence.revision ||
        (base.revision === fence.revision &&
          (base.updatedAt !== fence.updatedAt ||
            (base.snapshot ? await sha256(canonicalAccountSnapshot(base.snapshot)) : null) !==
              fence.snapshotDigest)))
    )
      fail('stored_data_invalid');
    let pending: AccountReplicationJournal['pending'] = null;
    if (value.pending !== null) {
      const p = value.pending;
      if (
        !exact(p, [
          'operationId',
          'mode',
          'capturedLocal',
          'remote',
          'proposed',
          'proposedDigest',
          'acknowledgement',
        ]) ||
        !uuid(p.operationId) ||
        !['push', 'pull'].includes(p.mode as string) ||
        typeof p.proposedDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(p.proposedDigest)
      )
        fail('stored_data_invalid');
      const remote = remoteState(p.remote, ownerId);
      const capturedLocal = capture(p.capturedLocal);
      const proposed = normalizeAccountSnapshot(p.proposed as AccountSnapshot);
      if (
        remote.deletionOperationId !== null ||
        (base &&
          (remote.revision < base.revision ||
            (remote.revision === base.revision && !sameRemote(remote, base)))) ||
        !catalogueMatches(capturedLocal.snapshot.catalogue, proposed.catalogue) ||
        (remote.snapshot && !catalogueMatches(remote.snapshot.catalogue, proposed.catalogue)) ||
        (base?.snapshot && !catalogueMatches(base.snapshot.catalogue, proposed.catalogue)) ||
        !fence ||
        remote.revision !== fence.revision ||
        remote.updatedAt !== fence.updatedAt ||
        (remote.snapshot ? await sha256(canonicalAccountSnapshot(remote.snapshot)) : null) !==
          fence.snapshotDigest ||
        (await sha256(canonicalAccountSnapshot(proposed))) !== p.proposedDigest ||
        (p.mode === 'pull' &&
          (!remote.snapshot ||
            !accountSnapshotsEqual(remote.snapshot, proposed) ||
            p.acknowledgement !== null))
      )
        fail('stored_data_invalid');
      pending = {
        operationId: p.operationId,
        mode: p.mode as 'push' | 'pull',
        capturedLocal,
        remote,
        proposed,
        proposedDigest: p.proposedDigest,
        acknowledgement:
          p.acknowledgement === null
            ? null
            : commitReceipt(p.acknowledgement, ownerId, p.operationId, remote.revision),
      };
    }
    const scope = value.schemaVersion === 2 ? value.scope : { version: 1 as const };
    if (!validateAccountCaptureScope(scope)) fail('stored_data_invalid');
    if (
      pending &&
      (!accountCaptureScopesEqual(scope, accountCaptureScope(pending.capturedLocal)) ||
        pending.proposed.schemaVersion !== scope.version)
    )
      fail('stored_data_invalid');
    if (
      scope.version === 1 &&
      [base?.snapshot, pending?.remote.snapshot].some((snapshot) => snapshot?.schemaVersion === 2)
    )
      fail('stored_data_invalid');
    const decoded = {
      ownerId,
      revision: value.revision,
      base,
      observed: fence,
      pending,
      lastApply,
    };
    return value.schemaVersion === 1
      ? { ...decoded, schemaVersion: 1 }
      : { ...decoded, schemaVersion: 2, scope };
  } catch {
    return fail('stored_data_invalid');
  }
}
