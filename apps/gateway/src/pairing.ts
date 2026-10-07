import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { CatalogueIdentity, PairResponse } from '@cookmate/contracts';
import { API_VERSION } from '@cookmate/contracts';
import type { CredentialRegistry } from './registry';
import { gatewayError } from './errors';
import { LIMITS } from './limits';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function createPairingService(
  registry: CredentialRegistry,
  catalogue: CatalogueIdentity,
  now = Date.now,
) {
  let window: { digest: Buffer; expiresAt: number; attempts: number } | null = null;
  return {
    /** Operator API only. Never exposed through a remote route or diagnostic logger. */
    openWindow() {
      const code = Array.from(
        { length: 12 },
        () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
      ).join('');
      window = {
        digest: createHash('sha256').update(code).digest(),
        expiresAt: now() + LIMITS.pairingWindowMs,
        attempts: 0,
      };
      return { code, expiresAt: new Date(window.expiresAt).toISOString() };
    },
    closeWindow() {
      window = null;
    },
    async pair(code: string): Promise<PairResponse> {
      if (!window || now() >= window.expiresAt) {
        window = null;
        throw gatewayError('pairing_expired', 401, 'after_reconnect');
      }
      const active = window;
      active.attempts += 1;
      const valid = timingSafeEqual(active.digest, createHash('sha256').update(code).digest());
      if (!valid) {
        if (active.attempts >= LIMITS.pairingAttempts) window = null;
        throw gatewayError('unauthenticated', 401, 'after_reconnect');
      }
      // Consume synchronously before durable issuance; simultaneous requests cannot reuse a code.
      window = null;
      return { apiVersion: API_VERSION, ...(await registry.issue()), catalogue: { ...catalogue } };
    },
  };
}
