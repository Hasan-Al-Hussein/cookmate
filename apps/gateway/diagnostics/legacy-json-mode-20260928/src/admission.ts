import { createHash } from 'node:crypto';
import type { AssistantTurnRequest } from '@cookmate/contracts';
import { gatewayError } from './errors';
import { LIMITS } from './limits';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function createAdmission(deadlineMs: number = LIMITS.deadlineMs, now = Date.now) {
  const active = new Map<
    string,
    { requestId: string; fingerprint: string; controller: AbortController; deadline: number }
  >();
  return {
    begin(clientId: string, request: AssistantTurnRequest) {
      const fingerprint = createHash('sha256').update(canonical(request)).digest('hex');
      const existing = active.get(clientId);
      if (existing) {
        if (existing.requestId === request.requestId && existing.fingerprint !== fingerprint)
          throw gatewayError('operation_conflict', 409, 'never');
        throw gatewayError('already_pending', 409, 'after_delay');
      }
      if (active.size >= LIMITS.concurrentTurns) throw gatewayError('busy', 503, 'after_delay');
      const controller = new AbortController();
      const deadline = now() + deadlineMs;
      const entry = { requestId: request.requestId, fingerprint, controller, deadline };
      active.set(clientId, entry);
      const timer = setTimeout(
        () => controller.abort(gatewayError('deadline', 504, 'after_delay')),
        deadlineMs,
      );
      timer.unref();
      return {
        signal: controller.signal,
        deadline,
        cancel() {
          controller.abort(gatewayError('cancelled', 499, 'never'));
        },
        finish() {
          clearTimeout(timer);
          if (active.get(clientId) === entry) active.delete(clientId);
        },
      };
    },
    revoke(clientId: string) {
      active
        .get(clientId)
        ?.controller.abort(gatewayError('pairing_revoked', 401, 'after_reconnect'));
    },
    close() {
      for (const item of active.values())
        item.controller.abort(gatewayError('provider_unavailable', 503, 'after_reconnect'));
    },
    get size() {
      return active.size;
    },
  };
}

/** Bounds caller waiting even if an injected/failed adapter does not observe cancellation. */
export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
