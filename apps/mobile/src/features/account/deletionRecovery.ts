export const DELETION_RECOVERY_STORAGE_KEY = 'cookmate.account.auth-deletion-recovery';
const maximumOwners = 64;
const maximumJournalBytes = 64 * 1024;
const maximumResponseBytes = 2 * 1024;
const statusPath = '/functions/v1/cookmate-account-deletion-status';

export type DeletionRecoveryFailure =
  | 'invalid_input'
  | 'invalid_record'
  | 'storage'
  | 'changed'
  | 'limit'
  | 'unavailable'
  | 'cancelled'
  | 'invalid_response';
export class DeletionRecoveryError extends Error {
  constructor(readonly reason: DeletionRecoveryFailure) {
    super(`Account deletion recovery: ${reason}`);
  }
}
export interface DeletionRecoveryStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export interface DeletionRecoveryPendingInput {
  ownerId: string;
  operationId: string;
  expectedRevision: number;
  recoveryToken: string;
}
export interface PendingDeletionRecovery extends DeletionRecoveryPendingInput {
  kind: 'pending';
}
export interface ConfirmedDeletionRecovery {
  kind: 'confirmed';
  ownerId: string;
  operationId: string;
  expectedRevision: number;
  /** Local acknowledgement time, never substituted for the server's deletion time. */
  confirmedAt: string;
}
export type DeletionRecoveryRow = PendingDeletionRecovery | ConfirmedDeletionRecovery;
export type DeletionRecoveryStatus =
  | { operationId: string; status: 'pending' }
  | { operationId: string; status: 'deleted'; deletedAt: string; expiresAt: string };
export type DeletionRecoveryReceipt =
  | Extract<DeletionRecoveryStatus, { status: 'deleted' }>
  | { ownerId: string; operationId: string; deleted: true };

function fail(reason: DeletionRecoveryFailure): never {
  throw new DeletionRecoveryError(reason);
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const token = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function timestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
const identityKeys = ['ownerId', 'operationId', 'expectedRevision'] as const;
function parseRow(value: unknown, reason: DeletionRecoveryFailure): DeletionRecoveryRow {
  if (!record(value)) return fail(reason);
  const pending = value.kind === 'pending';
  if (
    (!pending && value.kind !== 'confirmed') ||
    !exact(value, ['kind', ...identityKeys, pending ? 'recoveryToken' : 'confirmedAt']) ||
    !uuid(value.ownerId) ||
    !uuid(value.operationId) ||
    !revision(value.expectedRevision)
  )
    return fail(reason);
  if (pending) {
    if (!token(value.recoveryToken)) return fail(reason);
    return Object.freeze({
      kind: 'pending',
      ownerId: value.ownerId,
      operationId: value.operationId,
      expectedRevision: value.expectedRevision,
      recoveryToken: value.recoveryToken,
    });
  }
  if (!timestamp(value.confirmedAt)) return fail(reason);
  return Object.freeze({
    kind: 'confirmed',
    ownerId: value.ownerId,
    operationId: value.operationId,
    expectedRevision: value.expectedRevision,
    confirmedAt: value.confirmedAt,
  });
}
function parseJournal(raw: string | null): readonly DeletionRecoveryRow[] {
  if (raw === null) return Object.freeze([]);
  if (
    raw.length > maximumJournalBytes ||
    new TextEncoder().encode(raw).length > maximumJournalBytes
  )
    return fail('invalid_record');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail('invalid_record');
  }
  if (
    !exact(value, ['schemaVersion', 'entries']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > maximumOwners
  )
    return fail('invalid_record');
  const entries = value.entries.map((row) => parseRow(row, 'invalid_record'));
  if (
    new Set(entries.map((row) => row.ownerId)).size !== entries.length ||
    new Set(entries.map((row) => row.operationId)).size !== entries.length
  )
    return fail('invalid_record');
  return Object.freeze(entries);
}
function sameIdentity(a: DeletionRecoveryRow, b: DeletionRecoveryRow) {
  return identityKeys.every((key) => a[key] === b[key]);
}
function parseStatus(value: unknown, operationId: string): DeletionRecoveryStatus {
  if (
    exact(value, ['operationId', 'status']) &&
    value.operationId === operationId &&
    value.status === 'pending'
  )
    return Object.freeze({ operationId, status: 'pending' });
  if (
    !exact(value, ['operationId', 'status', 'deletedAt', 'expiresAt']) ||
    value.operationId !== operationId ||
    value.status !== 'deleted' ||
    !timestamp(value.deletedAt) ||
    !timestamp(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.parse(value.deletedAt)
  )
    return fail('invalid_response');
  return Object.freeze({
    operationId,
    status: 'deleted',
    deletedAt: value.deletedAt,
    expiresAt: value.expiresAt,
  });
}
function validateReceipt(value: unknown, pending: PendingDeletionRecovery): void {
  if (exact(value, ['ownerId', 'operationId', 'deleted'])) {
    if (
      value.ownerId !== pending.ownerId ||
      value.operationId !== pending.operationId ||
      value.deleted !== true
    )
      fail('invalid_response');
  } else if (parseStatus(value, pending.operationId).status !== 'deleted') fail('invalid_response');
}

// Factories sharing the same adapter also share their in-process read/write queue.
const storageQueues = new WeakMap<DeletionRecoveryStorage, Promise<void>>();

/**
 * One app owner must hold this secure record. Read/check/write is not a cross-process
 * storage CAS: the injected adapter has no atomic compare-and-set primitive.
 */
export function createDeletionRecoveryJournal(
  store: DeletionRecoveryStorage,
  options: { now?: () => string } = {},
) {
  const now = options.now ?? (() => new Date().toISOString());
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = (storageQueues.get(store) ?? Promise.resolve())
      .then(operation)
      .catch((error) => {
        if (error instanceof DeletionRecoveryError) throw error;
        throw new DeletionRecoveryError('storage');
      });
    storageQueues.set(
      store,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
  async function read() {
    const raw = await store.getItem(DELETION_RECOVERY_STORAGE_KEY);
    return { raw, entries: parseJournal(raw) };
  }
  async function replace(previous: string | null, entries: readonly DeletionRecoveryRow[]) {
    if (entries.length > maximumOwners) fail('limit');
    const raw = JSON.stringify({
      schemaVersion: 1,
      entries: [...entries].sort((a, b) => a.ownerId.localeCompare(b.ownerId)),
    });
    if (new TextEncoder().encode(raw).length > maximumJournalBytes) fail('limit');
    parseJournal(raw);
    if ((await store.getItem(DELETION_RECOVERY_STORAGE_KEY)) !== previous) fail('changed');
    try {
      await store.setItem(DELETION_RECOVERY_STORAGE_KEY, raw);
    } catch {
      /* Exact readback decides whether an interrupted acknowledgement committed. */
    }
    const found = await store.getItem(DELETION_RECOVERY_STORAGE_KEY);
    if (found !== raw) fail(found === previous ? 'storage' : 'changed');
  }
  return {
    read(ownerId: string): Promise<DeletionRecoveryRow | null> {
      return serial(async () => {
        if (!uuid(ownerId)) fail('invalid_input');
        return (await read()).entries.find((row) => row.ownerId === ownerId) ?? null;
      });
    },
    list(): Promise<readonly DeletionRecoveryRow[]> {
      return serial(async () => (await read()).entries);
    },
    putPending(input: DeletionRecoveryPendingInput): Promise<DeletionRecoveryRow> {
      return serial(async () => {
        if (!exact(input, [...identityKeys, 'recoveryToken'])) fail('invalid_input');
        const pending = parseRow(
          { kind: 'pending', ...input },
          'invalid_input',
        ) as PendingDeletionRecovery;
        const before = await read();
        const existing = before.entries.find((row) => row.ownerId === pending.ownerId);
        if (existing) {
          if (
            !sameIdentity(existing, pending) ||
            (existing.kind === 'pending' && existing.recoveryToken !== pending.recoveryToken)
          )
            fail('changed');
          // A retry must never recreate a credential after confirmed deletion.
          return existing;
        }
        if (before.entries.some((row) => row.operationId === pending.operationId)) fail('changed');
        await replace(before.raw, [...before.entries, pending]);
        return pending;
      });
    },
    /** Only after a correlated authenticated response proves this operation was not admitted. */
    rejectPending(expected: PendingDeletionRecovery): Promise<void> {
      return serial(async () => {
        const pending = parseRow(expected, 'invalid_input');
        if (pending.kind !== 'pending') fail('invalid_input');
        const before = await read();
        const existing = before.entries.find((row) => row.ownerId === pending.ownerId);
        if (
          !existing ||
          existing.kind !== 'pending' ||
          !sameIdentity(existing, pending) ||
          existing.recoveryToken !== pending.recoveryToken
        )
          fail('changed');
        await replace(
          before.raw,
          before.entries.filter((row) => row.ownerId !== pending.ownerId),
        );
      });
    },
    confirm(
      expected: PendingDeletionRecovery,
      receipt: DeletionRecoveryReceipt,
    ): Promise<ConfirmedDeletionRecovery> {
      return serial(async () => {
        const pending = parseRow(expected, 'invalid_input');
        if (pending.kind !== 'pending') fail('invalid_input');
        validateReceipt(receipt, pending);
        const before = await read();
        const existing = before.entries.find((row) => row.ownerId === pending.ownerId);
        if (!existing || !sameIdentity(existing, pending)) fail('changed');
        if (existing.kind === 'confirmed') return existing;
        if (existing.recoveryToken !== pending.recoveryToken) fail('changed');
        const confirmed = parseRow(
          {
            kind: 'confirmed',
            ownerId: pending.ownerId,
            operationId: pending.operationId,
            expectedRevision: pending.expectedRevision,
            confirmedAt: now(),
          },
          'invalid_input',
        ) as ConfirmedDeletionRecovery;
        await replace(
          before.raw,
          before.entries.map((row) => (row.ownerId === pending.ownerId ? confirmed : row)),
        );
        return confirmed;
      });
    },
  };
}
export type DeletionRecoveryJournal = ReturnType<typeof createDeletionRecoveryJournal>;

/** Status-only capability lookup. It has no Auth session or deletion mutation interface. */
export function createDeletionRecoveryTransport(options: {
  endpoint: string;
  publishableKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    return fail('invalid_input');
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.pathname !== statusPath ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    options.endpoint.includes('?') ||
    options.endpoint.includes('#') ||
    (options.publishableKey !== undefined &&
      !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(options.publishableKey)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    fail('invalid_input');
  const transport = options.fetch ?? fetch;
  return {
    async readStatus(
      input: { operationId: string; recoveryToken: string },
      signal?: AbortSignal,
    ): Promise<DeletionRecoveryStatus> {
      if (
        !exact(input, ['operationId', 'recoveryToken']) ||
        !uuid(input.operationId) ||
        !token(input.recoveryToken)
      )
        fail('invalid_input');
      if (signal?.aborted) fail('cancelled');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      const aborted = () =>
        new DeletionRecoveryError(signal?.aborted ? 'cancelled' : 'unavailable');
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, timeoutMs);
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      function cancelBody(body: ReadableStream<Uint8Array> | null | undefined) {
        try {
          void body?.cancel().catch(() => undefined);
        } catch {
          /* No body retained. */
        }
      }
      async function bounded<T>(task: Promise<T>): Promise<T> {
        if (controller.signal.aborted) throw aborted();
        let rejectAbort!: () => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
          rejectAbort = () => reject(aborted());
        });
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
        try {
          if (controller.signal.aborted) throw aborted();
          return await Promise.race([task, interrupted]);
        } finally {
          controller.signal.removeEventListener('abort', rejectAbort);
        }
      }
      try {
        if (signal?.aborted) fail('cancelled');
        const request = transport(endpoint.href, {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(options.publishableKey ? { apikey: options.publishableKey } : {}),
          },
          body: JSON.stringify(input),
        });
        void request.then(
          (late) => {
            if (controller.signal.aborted) cancelBody(late.body);
          },
          () => undefined,
        );
        response = await bounded(request);
        if (response.status !== 200) fail('unavailable');
        reader = response.body?.getReader();
        if (!reader) fail('invalid_response');
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumResponseBytes))
          fail('invalid_response');
        if (
          response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'application/json'
        )
          fail('invalid_response');
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0,
          reads = 0,
          text = '';
        while (true) {
          if (++reads > 4096) fail('invalid_response');
          const chunk = await bounded(reader.read());
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maximumResponseBytes) fail('invalid_response');
          text += decoder.decode(chunk.value, { stream: true });
        }
        if (controller.signal.aborted) throw aborted();
        return parseStatus(JSON.parse(text + decoder.decode()) as unknown, input.operationId);
      } catch (error) {
        if (error instanceof DeletionRecoveryError) throw error;
        if (controller.signal.aborted) throw aborted();
        throw new DeletionRecoveryError(response ? 'invalid_response' : 'unavailable');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (reader) {
          try {
            void reader.cancel().catch(() => undefined);
          } catch {
            /* Do not stall cleanup. */
          }
          try {
            reader.releaseLock();
          } catch {
            /* A cancelled read may still be settling. */
          }
        } else cancelBody(response?.body);
      }
    },
  };
}
export type DeletionRecoveryTransport = ReturnType<typeof createDeletionRecoveryTransport>;
