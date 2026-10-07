import { performance } from 'node:perf_hooks';
import { GatewayError, gatewayError } from './errors';

export const DEFAULT_PROVIDER_REQUESTS_PER_MINUTE = 5;
const MAX_LOCAL_REQUESTS_PER_MINUTE = 1000;
const WINDOW_MS = 60_000;
const MAX_COOLDOWN_SECONDS = 86_400;

export interface ProviderPhysicalAdmission {
  /** Synchronous: call immediately before transport, with no intervening await/callback. */
  admit(signal?: AbortSignal | null): void;
  /** Called as soon as dispatched HTTP429 headers arrive, before reading its body. */
  recordQuota(retryAfterSeconds?: number): void;
}

function validLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LOCAL_REQUESTS_PER_MINUTE)
    throw gatewayError('provider_unavailable', 503, 'after_correction');
  return value;
}

/** Operator policy, not a statement about which calls Google charges to its quota. */
export function readProviderRequestLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PROVIDER_REQUESTS_PER_MINUTE;
  if (!/^[1-9][0-9]{0,3}$/.test(value))
    throw gatewayError('provider_unavailable', 503, 'after_correction');
  return validLimit(Number(value));
}

/** Explicit isolated instance for injected tests/diagnostics or a process owner. No timers/queue. */
export function createProviderPhysicalAdmission(options: {
  requestsPerMinute: number;
  now?: () => number;
}): ProviderPhysicalAdmission {
  const limit = validLimit(options.requestsPerMinute);
  const now = options.now ?? (() => performance.now());
  let timestamps: number[] = [];
  let lastTime = 0;
  let cooldownUntil = 0;
  let clockFailed = false;
  function time() {
    try {
      const value = now();
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        value > Number.MAX_SAFE_INTEGER - MAX_COOLDOWN_SECONDS * 1000
      )
        throw new Error('invalid_clock');
      // Injected clocks cannot shorten a window by moving backwards.
      lastTime = Math.max(lastTime, value);
      return lastTime;
    } catch {
      clockFailed = true;
      throw gatewayError('provider_unavailable', 503, 'after_correction');
    }
  }
  return {
    admit(signal) {
      signal?.throwIfAborted();
      if (clockFailed) throw gatewayError('provider_unavailable', 503, 'after_correction');
      const current = time();
      timestamps = timestamps.filter((timestamp) => current - timestamp < WINDOW_MS);
      const windowUntil = timestamps.length >= limit ? timestamps[0]! + WINDOW_MS : current;
      const delayMs = Math.max(windowUntil, cooldownUntil) - current;
      signal?.throwIfAborted();
      if (delayMs > 0) {
        const providerCooldown = cooldownUntil > current;
        const error = gatewayError(
          providerCooldown ? 'quota' : 'busy',
          providerCooldown ? 429 : 503,
          'after_delay',
        );
        throw new GatewayError(
          { ...error.detail, retryAfterSeconds: Math.ceil(delayMs / 1000) },
          error.status,
        );
      }
      timestamps.push(current);
    },
    recordQuota(retryAfterSeconds) {
      const seconds =
        typeof retryAfterSeconds === 'number' &&
        Number.isInteger(retryAfterSeconds) &&
        retryAfterSeconds >= 0 &&
        retryAfterSeconds <= MAX_COOLDOWN_SECONDS
          ? retryAfterSeconds
          : WINDOW_MS / 1000;
      // A broken injected clock closes future admission but must not bypass cleanup of
      // the dispatched response whose headers supplied this quota observation.
      try {
        cooldownUntil = Math.max(cooldownUntil, time() + seconds * 1000);
      } catch {
        // time() already latched a sanitized failure; response handling continues.
      }
    },
  };
}

let processAdmission: { limit: number; value: ProviderPhysicalAdmission } | undefined;

/** One budget for this process, including same-process launcher restarts. Different
 * processes/external callers and process restarts are deliberately outside this guard. */
export function getProcessProviderAdmission(requestsPerMinute: number): ProviderPhysicalAdmission {
  const limit = validLimit(requestsPerMinute);
  if (processAdmission && processAdmission.limit !== limit)
    throw gatewayError('provider_unavailable', 503, 'after_correction');
  processAdmission ??= {
    limit,
    value: createProviderPhysicalAdmission({ requestsPerMinute: limit }),
  };
  return processAdmission.value;
}
