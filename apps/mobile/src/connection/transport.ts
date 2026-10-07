import {
  API_VERSION,
  MAX_ASSISTANT_BODY_BYTES,
  catalogueMatches,
  checkAssistantRequest,
  checkAssistantResponse,
  checkMemoryResponseForRequest,
  isResponseCurrent,
  isUtcInstant,
  validateHealthResponse,
  validatePairRequest,
  validatePairResponse,
} from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  ContractError,
} from '@cookmate/contracts';
import { catalogueBoundary } from '@cookmate/catalogue';
import { ConnectionError, connectionError, readHttpError, utf8ByteLength } from './errors';
import { isPairingCredential, trustedEndpoint } from './credentials';
import type { CredentialStore, PairingCredential } from './credentials';

export interface ConnectionState {
  generation: number;
  status: 'unpaired' | 'paired' | 'reconnect';
  endpoint?: string;
  clientId?: string;
  expiresAt?: string;
  reason?: ContractError['code'];
}

export interface ConnectionOptions {
  credentials: CredentialStore;
  /** Must preserve native certificate validation and honor redirect: error. */
  fetch: typeof fetch;
  now?: () => number;
  /** Native adapters may know offline/TLS reasons that ordinary fetch hides. */
  classifyNetworkFailure?: (error: unknown) => 'network_unavailable' | 'untrusted_endpoint';
  deadlineMs?: number;
  /** Synchronous final permission check immediately before a personal-data request leaves. */
  authorizeAssistantRequest?: () => void;
}

export interface GatewayConnection {
  getState(): Readonly<ConnectionState>;
  restore(installationId: string | null): Promise<Readonly<ConnectionState>>;
  health(endpoint: string, signal?: AbortSignal): Promise<void>;
  pair(endpoint: string, code: string): Promise<Readonly<ConnectionState>>;
  turn(request: AssistantTurnRequest, signal?: AbortSignal): Promise<AssistantTurnResponse>;
  cancel(): void;
  forget(): Promise<void>;
  revokeAndForget(): Promise<{
    localForgotten: true;
    serverRevoked: boolean;
    error?: ContractError;
  }>;
}

const HARD_DEADLINE_MS = 45_000;

async function readBoundedBody(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_ASSISTANT_BODY_BYTES))
    throw connectionError('too_large');
  if (response.body?.getReader && typeof TextDecoder !== 'undefined') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let total = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_ASSISTANT_BODY_BYTES) throw connectionError('too_large');
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  // Some native fetch versions buffer bodies; enforce the size before JSON decoding.
  const text = await response.text();
  if (utf8ByteLength(text) > MAX_ASSISTANT_BODY_BYTES) throw connectionError('too_large');
  return text;
}

export function createGatewayConnection(options: ConnectionOptions): GatewayConnection {
  const now = options.now ?? Date.now;
  const deadline = Math.min(HARD_DEADLINE_MS, options.deadlineMs ?? HARD_DEADLINE_MS);
  if (!Number.isFinite(deadline) || deadline <= 0) throw connectionError('invalid_input');
  let state: ConnectionState = { generation: 0, status: 'unpaired' };
  let credential: PairingCredential | null = null;
  let installationId: string | null = null;
  let activeTurn = false;
  const controllers = new Set<AbortController>();
  let writes: Promise<unknown> = Promise.resolve();

  function serialize<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = writes.then(operation);
    writes = result.catch(() => undefined);
    return result;
  }

  function invalidate(reason?: ContractError['code']) {
    state = {
      generation: state.generation + 1,
      status: reason ? 'reconnect' : 'unpaired',
      ...(reason ? { reason } : {}),
    };
    credential = null;
    for (const controller of controllers) controller.abort();
  }

  function assertCurrent(generation: number) {
    if (state.generation !== generation) throw connectionError('stale_context', 'after_correction');
  }

  async function request(
    endpoint: string,
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    token?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = `${trustedEndpoint(endpoint)}${path}`;
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && utf8ByteLength(serialized) > MAX_ASSISTANT_BODY_BYTES)
      throw connectionError('too_large', 'after_correction');
    if (signal?.aborted) throw connectionError('cancelled');
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let rejectAbort: (error: ConnectionError) => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(
        connectionError(timedOut ? 'deadline' : 'cancelled', timedOut ? 'after_delay' : 'never'),
      );
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadline);
    const operation = async () => {
      if (path === '/v2/assistant/turn') options.authorizeAssistantRequest?.();
      const response = await options.fetch(url, {
        method,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(serialized ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
      });
      if (
        response.redirected ||
        (response.url && response.url !== url) ||
        (response.status >= 300 && response.status < 400)
      )
        throw connectionError('untrusted_endpoint', 'after_correction');
      if (response.status === 204 && method === 'DELETE') return null;
      const text = await readBoundedBody(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw connectionError('invalid_model_result');
      }
      if (!response.ok) {
        const error = readHttpError(parsed);
        throw error ? new ConnectionError(error) : connectionError('invalid_model_result');
      }
      return parsed;
    };
    try {
      return await Promise.race([operation(), aborted]);
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw connectionError(
        options.classifyNetworkFailure?.(error) ?? 'network_unavailable',
        'after_reconnect',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      controllers.delete(controller);
      controller.abort();
    }
  }

  async function erase() {
    try {
      await options.credentials.clear();
    } catch {
      throw connectionError('storage_failure');
    }
  }

  function currentCredential(): PairingCredential {
    if (!credential) throw connectionError('unauthenticated', 'after_reconnect');
    if (Date.parse(credential.pairing.expiresAt) <= now()) {
      invalidate('pairing_expired');
      throw connectionError('pairing_expired', 'after_reconnect');
    }
    return credential;
  }

  return {
    getState: () => Object.freeze({ ...state }),
    async restore(marker) {
      invalidate();
      const generation = state.generation;
      installationId = marker;
      return serialize(async () => {
        let saved: unknown;
        try {
          saved = await options.credentials.read();
        } catch {
          throw connectionError('storage_failure');
        }
        assertCurrent(generation);
        if (!marker || !isPairingCredential(saved) || saved.installationId !== marker) {
          await erase();
          return Object.freeze({ ...state });
        }
        const reason = !catalogueMatches(saved.pairing.catalogue, catalogueBoundary.identity)
          ? 'incompatible_version'
          : !isUtcInstant(saved.pairing.expiresAt) || Date.parse(saved.pairing.expiresAt) <= now()
            ? 'pairing_expired'
            : undefined;
        if (reason) {
          await erase();
          assertCurrent(generation);
          state = { generation, status: 'reconnect', reason };
        } else {
          credential = saved;
          state = {
            generation,
            status: 'paired',
            endpoint: saved.endpoint,
            clientId: saved.pairing.clientId,
            expiresAt: saved.pairing.expiresAt,
          };
        }
        return Object.freeze({ ...state });
      });
    },
    async health(endpoint, signal) {
      if (
        !validateHealthResponse(
          await request(endpoint, '/health', 'GET', undefined, undefined, signal),
        )
      )
        throw connectionError('incompatible_version', 'after_correction');
    },
    async pair(endpoint, code) {
      const origin = trustedEndpoint(endpoint);
      if (!installationId || installationId.length > 128)
        throw connectionError('invalid_input', 'after_correction');
      const body = { apiVersion: API_VERSION, code };
      if (!validatePairRequest(body)) throw connectionError('invalid_input', 'after_correction');
      invalidate();
      const generation = state.generation;
      const marker = installationId;
      return serialize(async () => {
        await erase();
        assertCurrent(generation);
        const pairing = await request(origin, '/v2/pair', 'POST', body);
        assertCurrent(generation);
        if (
          !validatePairResponse(pairing) ||
          !isUtcInstant(pairing.expiresAt) ||
          Date.parse(pairing.expiresAt) <= now()
        )
          throw connectionError('invalid_model_result');
        if (!catalogueMatches(pairing.catalogue, catalogueBoundary.identity))
          throw connectionError('incompatible_version', 'after_correction');
        const saved = { endpoint: origin, installationId: marker, pairing };
        try {
          await options.credentials.write(saved);
        } catch {
          throw connectionError('storage_failure');
        }
        if (state.generation !== generation) {
          await erase();
          assertCurrent(generation);
        }
        credential = saved;
        state = {
          generation,
          status: 'paired',
          endpoint: origin,
          clientId: pairing.clientId,
          expiresAt: pairing.expiresAt,
        };
        return Object.freeze({ ...state });
      });
    },
    async turn(input, signal) {
      if (activeTurn) throw connectionError('already_pending');
      const saved = currentCredential();
      const check = checkAssistantRequest(input, catalogueBoundary);
      if (!check.ok) throw new ConnectionError(check.error);
      const turn: AssistantTurnRequest = JSON.parse(JSON.stringify(input));
      const generation = state.generation;
      if (turn.connectionGeneration !== generation)
        throw connectionError('stale_context', 'after_correction');
      activeTurn = true;
      try {
        const response = await request(
          saved.endpoint,
          '/v2/assistant/turn',
          'POST',
          turn,
          saved.pairing.token,
          signal,
        );
        assertCurrent(generation);
        const checked = checkAssistantResponse(response, catalogueBoundary);
        if (!checked.ok) throw new ConnectionError(checked.error);
        const memoryChecked = checkMemoryResponseForRequest(checked.value, turn);
        if (!memoryChecked.ok) throw new ConnectionError(memoryChecked.error);
        if (
          !isResponseCurrent(checked.value, {
            ...turn,
            preferenceRevision: turn.context.preferences.revision,
          })
        )
          throw connectionError('stale_context', 'after_correction');
        if (checked.value.kind === 'error') {
          const safeError = readHttpError({ error: checked.value.error })!;
          if (['unauthenticated', 'pairing_expired', 'pairing_revoked'].includes(safeError.code))
            throw new ConnectionError(safeError);
          return { ...checked.value, error: safeError };
        }
        return checked.value;
      } catch (error) {
        if (
          error instanceof ConnectionError &&
          state.generation === generation &&
          ['unauthenticated', 'pairing_expired', 'pairing_revoked'].includes(error.detail.code)
        ) {
          invalidate(error.detail.code);
          await serialize(erase);
        }
        throw error;
      } finally {
        activeTurn = false;
      }
    },
    cancel() {
      state = { ...state, generation: state.generation + 1 };
      for (const controller of controllers) controller.abort();
    },
    async forget() {
      invalidate();
      await serialize(erase);
    },
    async revokeAndForget() {
      const saved = credential;
      invalidate();
      await serialize(erase);
      if (!saved) return { localForgotten: true, serverRevoked: false };
      try {
        const response = await request(
          saved.endpoint,
          '/v2/pairing',
          'DELETE',
          undefined,
          saved.pairing.token,
        );
        if (response !== null) throw connectionError('invalid_model_result');
        return { localForgotten: true, serverRevoked: true };
      } catch (error) {
        return {
          localForgotten: true,
          serverRevoked: false,
          error:
            error instanceof ConnectionError
              ? error.detail
              : connectionError('network_unavailable').detail,
        };
      }
    },
  };
}
