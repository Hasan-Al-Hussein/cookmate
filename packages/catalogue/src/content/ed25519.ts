import { hashes, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { CONTENT_LIMITS, type ReleaseTrustVerifier } from './types';

/** Raw Ed25519 signature encoded as exactly 128 lowercase hexadecimal characters. */
export const CONTENT_SIGNATURE_SCHEME = 'ed25519-hex-v1';
export interface ContentTrustKey {
  keyId: string;
  publicKeyHex: string;
}

// Verification needs no private key, randomness, Buffer, Node crypto or native polyfill.
hashes.sha512 = sha512;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const publicKeyPattern = /^[0-9a-f]{64}$/;
const signaturePattern = /^[0-9a-f]{128}$/;

/** Keys come from independently configured app/operator trust, never a release payload. */
export function createContentTrustVerifier(
  input: readonly ContentTrustKey[],
): ReleaseTrustVerifier {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32)
    throw new Error('Invalid content trust configuration.');
  const keys = new Map<string, Uint8Array>();
  for (const key of input) {
    if (
      !key ||
      !keyIdPattern.test(key.keyId) ||
      !publicKeyPattern.test(key.publicKeyHex) ||
      keys.has(key.keyId)
    )
      throw new Error('Invalid content trust configuration.');
    keys.set(key.keyId, hexToBytes(key.publicKeyHex));
  }
  return Object.freeze({
    async verify(input: Parameters<ReleaseTrustVerifier['verify']>[0]) {
      if (
        !input ||
        input.scheme !== CONTENT_SIGNATURE_SCHEME ||
        typeof input.signature !== 'string' ||
        !signaturePattern.test(input.signature) ||
        typeof input.canonicalPayload !== 'string' ||
        input.canonicalPayload.length > CONTENT_LIMITS.releaseBytes + 4096
      )
        return false;
      const key = keys.get(input.keyId);
      if (!key) return false;
      const payload = utf8ToBytes(input.canonicalPayload);
      if (payload.byteLength > CONTENT_LIMITS.releaseBytes + 4096) return false;
      try {
        // Strict RFC8032 verification rejects small-order/noncanonical points.
        return verify(hexToBytes(input.signature), payload, key, { zip215: false });
      } catch {
        return false;
      }
    },
  });
}
