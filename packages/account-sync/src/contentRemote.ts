import type { Immutable } from '@cookmate/domain';
import { canonicalPortableContentJson } from '../../domain/src/portableBackupContent';
import {
  canonicalAccountContentSnapshot,
  normalizeAccountContentSnapshot,
  type AccountContentSnapshot,
} from './contentSnapshot';
import {
  AccountRemoteError,
  accountRemoteTimestamp,
  createAccountRequest,
  type AccountCommitReceipt,
  type AccountRemoteOptions,
} from './remote';
import { ACCOUNT_SNAPSHOT_MAX_BYTES, type AccountSnapshot } from './types';
import { parseAccountSnapshot } from './validation';
import { exact } from './validationPrimitives';

/** Original service bytes remain legacy until a real format3 CAS commit succeeds. */
export interface AccountContentServiceRemoteState {
  ownerId: string;
  revision: number;
  snapshot: AccountSnapshot | AccountContentSnapshot | null;
  updatedAt: string | null;
  deletionOperationId: string | null;
}
export interface AccountContentRemote {
  readonly ownerId: string;
  read(signal?: AbortSignal): Promise<Immutable<AccountContentServiceRemoteState>>;
  /** Only a durably staged, explicitly reviewed format3 candidate belongs here. */
  commit(
    input: {
      operationId: string;
      expectedRevision: number;
      snapshot: Immutable<AccountContentSnapshot>;
    },
    signal?: AbortSignal,
  ): Promise<Immutable<AccountCommitReceipt>>;
}
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function invalid(): never {
  throw new AccountRemoteError('invalid_response');
}
function freeze<Value>(value: Value): Immutable<Value> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Immutable<Value>;
}
function own(value: unknown, maximum: number): unknown {
  try {
    return JSON.parse(canonicalPortableContentJson(value, maximum));
  } catch {
    return invalid();
  }
}

/** Private strict transport-envelope1 reader. This never projects legacy data into format3. */
export function parseAccountContentServiceRemoteState(
  input: unknown,
  ownerId: string,
): Immutable<AccountContentServiceRemoteState> {
  const value = own(input, ACCOUNT_SNAPSHOT_MAX_BYTES + 8192);
  if (
    !uuid(ownerId) ||
    !exact(value, [
      'schemaVersion',
      'ownerId',
      'revision',
      'snapshot',
      'updatedAt',
      'deletionPending',
      'deletionOperationId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.ownerId !== ownerId ||
    !revision(value.revision) ||
    typeof value.deletionPending !== 'boolean' ||
    (value.deletionPending
      ? !uuid(value.deletionOperationId)
      : value.deletionOperationId !== null) ||
    (value.revision === 0
      ? value.snapshot !== null || value.updatedAt !== null
      : value.snapshot === null || !accountRemoteTimestamp(value.updatedAt))
  )
    invalid();
  let snapshot: AccountSnapshot | Immutable<AccountContentSnapshot> | null = null;
  if (value.snapshot !== null) {
    try {
      snapshot =
        typeof value.snapshot === 'object' &&
        'schemaVersion' in value.snapshot &&
        value.snapshot.schemaVersion === 3
          ? normalizeAccountContentSnapshot(value.snapshot)
          : parseAccountSnapshot(JSON.stringify(value.snapshot));
    } catch {
      invalid();
    }
  }
  return freeze({
    ownerId,
    revision: value.revision,
    snapshot,
    updatedAt: value.updatedAt as string | null,
    deletionOperationId: value.deletionOperationId as string | null,
  });
}

/**
 * Unmounted format3 adapter. Shared authenticated bounded transport; no retries, implicit
 * conversion, consent promotion or runtime activation. Server admission is separately opt-in.
 */
export function createAccountContentRemote(options: AccountRemoteOptions): AccountContentRemote {
  const ownerId = options.ownerId;
  const request = createAccountRequest(options);
  return Object.freeze({
    ownerId,
    async read(signal?: AbortSignal) {
      const response = await request({ action: 'read' }, signal);
      response.assertCurrent();
      const result = parseAccountContentServiceRemoteState(response.value, ownerId);
      response.assertCurrent();
      return result;
    },
    async commit(
      input: {
        operationId: string;
        expectedRevision: number;
        snapshot: Immutable<AccountContentSnapshot>;
      },
      signal?: AbortSignal,
    ) {
      const value = own(input, ACCOUNT_SNAPSHOT_MAX_BYTES + 4096);
      if (
        !exact(value, ['operationId', 'expectedRevision', 'snapshot']) ||
        !uuid(value.operationId) ||
        !revision(value.expectedRevision) ||
        value.expectedRevision === Number.MAX_SAFE_INTEGER
      )
        invalid();
      let snapshot: AccountContentSnapshot;
      try {
        snapshot = JSON.parse(canonicalAccountContentSnapshot(value.snapshot));
      } catch {
        return invalid();
      }
      // Own immutable identity/payload before session lookup or any network await.
      const operationId = value.operationId;
      const expectedRevision = value.expectedRevision;
      const response = await request(
        { action: 'commit', operationId, expectedRevision, snapshot },
        signal,
      );
      response.assertCurrent();
      const receipt = response.value;
      if (
        !exact(receipt, ['ownerId', 'operationId', 'revision', 'committedAt']) ||
        receipt.ownerId !== ownerId ||
        receipt.operationId !== operationId ||
        receipt.revision !== expectedRevision + 1 ||
        !accountRemoteTimestamp(receipt.committedAt)
      )
        invalid();
      const result = freeze({
        ownerId,
        operationId,
        revision: expectedRevision + 1,
        committedAt: receipt.committedAt,
      });
      response.assertCurrent();
      return result;
    },
  });
}
