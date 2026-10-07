import type { AccountSnapshot } from './types';
import { ACCOUNT_SNAPSHOT_MAX_BYTES } from './types';
import { parseAccountSnapshot } from './validation';

export interface AccountRemoteState {
  ownerId: string;
  revision: number;
  snapshot: AccountSnapshot | null;
  updatedAt: string | null;
  deletionOperationId: string | null;
}
export interface AccountCommitReceipt {
  ownerId: string;
  operationId: string;
  revision: number;
  committedAt: string;
}
export interface AccountRemoteSession {
  ownerId: string;
  accessToken: string;
  generation: number;
}
export type AccountRemoteFailure =
  | 'sign_in_required'
  | 'account_changed'
  | 'unavailable'
  | 'cancelled'
  | 'needs_review'
  | 'snapshot_upgrade_required'
  | 'invalid_response'
  | 'sync_rate_limited'
  | 'deletion_pending'
  | 'recent_sign_in_required'
  | 'deletion_not_confirmed'
  | 'deletion_capability_limit'
  | 'operation_changed'
  | 'stored_data_needs_review';

export class AccountRemoteError extends Error {
  constructor(readonly reason: AccountRemoteFailure) {
    super(`Account service: ${reason}`);
  }
}

const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string => {
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

/** Transport timestamps also admit PostgreSQL's UTC offset and microsecond representation. */
export const accountRemoteTimestamp = timestamp;

export interface AccountRemote {
  readonly ownerId: string;
  read(signal?: AbortSignal): Promise<AccountRemoteState>;
  commit(
    input: { operationId: string; expectedRevision: number; snapshot: AccountSnapshot },
    signal?: AbortSignal,
  ): Promise<AccountCommitReceipt>;
  delete(
    input: {
      operationId: string;
      expectedRevision: number;
      confirmation: 'DELETE_COOKMATE_ACCOUNT';
      recoveryToken: string;
    },
    signal?: AbortSignal,
  ): Promise<{ ownerId: string; operationId: string; deleted: true }>;
}

/** Read only the server's allowlisted result. Provider prose and tokens never enter errors. */
export function parseAccountRemoteState(value: unknown, ownerId: string): AccountRemoteState {
  if (
    !record(value) ||
    value.ownerId !== ownerId ||
    value.schemaVersion !== 1 ||
    !revision(value.revision) ||
    typeof value.deletionPending !== 'boolean' ||
    (value.deletionPending
      ? !uuid(value.deletionOperationId)
      : value.deletionOperationId !== null) ||
    (value.revision === 0
      ? value.snapshot !== null || value.updatedAt !== null
      : value.snapshot === null || !timestamp(value.updatedAt))
  )
    throw new AccountRemoteError('invalid_response');
  let snapshot: AccountSnapshot | null = null;
  if (value.snapshot !== null) {
    try {
      snapshot = parseAccountSnapshot(JSON.stringify(value.snapshot));
    } catch {
      throw new AccountRemoteError('invalid_response');
    }
  }
  return {
    ownerId,
    revision: value.revision,
    snapshot,
    updatedAt: value.updatedAt as string | null,
    deletionOperationId: value.deletionOperationId as string | null,
  };
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maximum = ACCOUNT_SNAPSHOT_MAX_BYTES + 8192;
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    void response.body?.cancel().catch(() => undefined);
    throw new AccountRemoteError('invalid_response');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AccountRemoteError('invalid_response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  let reads = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      if (++reads > 65_536) throw new AccountRemoteError('invalid_response');
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new AccountRemoteError('invalid_response');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    // Do not await cancellation: an untrusted body can stall its cancellation promise.
    void reader.cancel().catch(() => undefined);
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

const failureStatuses: Partial<Record<AccountRemoteFailure, number>> = {
  sign_in_required: 401,
  needs_review: 409,
  snapshot_upgrade_required: 409,
  sync_rate_limited: 429,
  deletion_pending: 409,
  recent_sign_in_required: 403,
  deletion_not_confirmed: 503,
  deletion_capability_limit: 409,
  operation_changed: 409,
  stored_data_needs_review: 409,
};

/** Shared private transport configuration; snapshot format admission belongs to each adapter. */
export interface AccountRemoteOptions {
  endpoint: string;
  publishableKey: string;
  ownerId: string;
  session(): Promise<AccountRemoteSession | null>;
  isCurrent(session: AccountRemoteSession): boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** One bounded request per call, with no retries or snapshot/version coercion. */
export function createAccountRequest(options: AccountRemoteOptions) {
  const { ownerId, publishableKey, session: getSession, isCurrent } = options;
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    !uuid(ownerId) ||
    !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)
  )
    throw new AccountRemoteError('unavailable');
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new AccountRemoteError('unavailable');
  const transport = options.fetch ?? fetch;
  async function request(body: object, signal?: AbortSignal) {
    if (signal?.aborted) throw new AccountRemoteError('cancelled');
    const session = await getSession();
    if (!session) throw new AccountRemoteError('sign_in_required');
    // Keep the callback's original identity semantics, but never let in-place mutation
    // turn an old request into a response for a newer credential generation.
    const captured = Object.freeze({
      ownerId: session.ownerId,
      accessToken: session.accessToken,
      generation: session.generation,
    });
    const assertCurrent = () => {
      if (
        captured.ownerId !== ownerId ||
        session.ownerId !== captured.ownerId ||
        session.accessToken !== captured.accessToken ||
        session.generation !== captured.generation ||
        !isCurrent(session)
      )
        throw new AccountRemoteError('account_changed');
    };
    assertCurrent();
    if (
      !session.accessToken ||
      session.accessToken.length > 16_384 ||
      !/^[A-Za-z0-9_.-]+$/.test(session.accessToken)
    )
      throw new AccountRemoteError('sign_in_required');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    try {
      if (signal?.aborted) throw new AccountRemoteError('cancelled');
      assertCurrent();
      const response = await transport(endpoint.href, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${captured.accessToken}`,
          apikey: publishableKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const value = await responseJson(response, controller.signal);
      if (controller.signal.aborted)
        throw new AccountRemoteError(signal?.aborted ? 'cancelled' : 'unavailable');
      assertCurrent();
      if (!response.ok) {
        if (
          record(value) &&
          typeof value.error === 'string' &&
          failureStatuses[value.error as AccountRemoteFailure] === response.status
        )
          throw new AccountRemoteError(value.error as AccountRemoteFailure);
        throw new AccountRemoteError(response.status === 401 ? 'sign_in_required' : 'unavailable');
      }
      // The consuming adapter must recheck after its await and after parsing the response.
      return { value, assertCurrent };
    } catch (error) {
      controller.abort();
      if (error instanceof AccountRemoteError) throw error;
      throw new AccountRemoteError(signal?.aborted ? 'cancelled' : 'unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
  return request;
}

/** One request per explicit call. Pending writes must be journalled before calling commit. */
export function createAccountRemote(options: AccountRemoteOptions): AccountRemote {
  const ownerId = options.ownerId;
  const request = createAccountRequest(options);
  return {
    ownerId,
    async read(signal) {
      const response = await request({ action: 'read' }, signal);
      response.assertCurrent();
      const result = parseAccountRemoteState(response.value, ownerId);
      response.assertCurrent();
      return result;
    },
    async commit(input, signal) {
      if (
        !uuid(input.operationId) ||
        !revision(input.expectedRevision) ||
        input.expectedRevision === Number.MAX_SAFE_INTEGER
      )
        throw new AccountRemoteError('invalid_response');
      const snapshot = parseAccountSnapshot(JSON.stringify(input.snapshot));
      const response = await request(
        {
          action: 'commit',
          operationId: input.operationId,
          expectedRevision: input.expectedRevision,
          snapshot,
        },
        signal,
      );
      response.assertCurrent();
      const value = response.value;
      if (
        !record(value) ||
        value.ownerId !== ownerId ||
        value.operationId !== input.operationId ||
        value.revision !== input.expectedRevision + 1 ||
        !timestamp(value.committedAt)
      )
        throw new AccountRemoteError('invalid_response');
      response.assertCurrent();
      return {
        ownerId,
        operationId: input.operationId,
        revision: value.revision as number,
        committedAt: value.committedAt,
      };
    },
    async delete(input, signal) {
      if (
        !uuid(input.operationId) ||
        !revision(input.expectedRevision) ||
        input.confirmation !== 'DELETE_COOKMATE_ACCOUNT' ||
        typeof input.recoveryToken !== 'string' ||
        input.recoveryToken.length !== 64 ||
        !/^[0-9a-f]{64}$/.test(input.recoveryToken)
      )
        throw new AccountRemoteError('invalid_response');
      const response = await request(
        {
          action: 'delete',
          operationId: input.operationId,
          expectedRevision: input.expectedRevision,
          confirmation: input.confirmation,
          recoveryToken: input.recoveryToken,
        },
        signal,
      );
      response.assertCurrent();
      const value = response.value;
      if (
        !record(value) ||
        value.ownerId !== ownerId ||
        value.operationId !== input.operationId ||
        value.deleted !== true
      )
        throw new AccountRemoteError('deletion_not_confirmed');
      response.assertCurrent();
      return { ownerId, operationId: input.operationId, deleted: true };
    },
  };
}
