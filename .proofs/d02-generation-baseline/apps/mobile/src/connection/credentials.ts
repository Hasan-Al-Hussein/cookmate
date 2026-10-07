import { validatePairResponse } from '@cookmate/contracts';
import type { PairResponse } from '@cookmate/contracts';
import { connectionError, utf8ByteLength } from './errors';

export interface PairingCredential {
  installationId: string;
  endpoint: string;
  pairing: PairResponse;
}

export interface CredentialStore {
  read(): Promise<unknown>;
  write(credential: PairingCredential): Promise<void>;
  clear(): Promise<void>;
}

export function trustedEndpoint(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      value.length > 2048 ||
      value.trim() !== value ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname) ||
      !url.hostname ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      /^127\./.test(host) ||
      ['0.0.0.0', '[::]', '[::1]', '[::ffff:7f00:1]'].includes(host)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw connectionError('untrusted_endpoint', 'after_correction');
  }
}

export function isPairingCredential(value: unknown): value is PairingCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'endpoint,installationId,pairing') return false;
  if (
    typeof record.installationId !== 'string' ||
    !record.installationId ||
    record.installationId.length > 128
  )
    return false;
  if (typeof record.endpoint !== 'string' || !validatePairResponse(record.pairing)) return false;
  try {
    return trustedEndpoint(record.endpoint) === record.endpoint;
  } catch {
    return false;
  }
}

export interface SecureStorePort {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

const CREDENTIAL_KEY = 'cookmate.gateway.pairing.v1';
const MAX_CREDENTIAL_BYTES = 4096;

/** No provider-key field is accepted. The installation marker must live outside Keychain. */
export function createSecureCredentialStore(store: SecureStorePort): CredentialStore {
  return {
    async read() {
      const text = await store.getItemAsync(CREDENTIAL_KEY);
      if (text === null) return null;
      if (utf8ByteLength(text) > MAX_CREDENTIAL_BYTES) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    async write(credential) {
      const text = JSON.stringify(credential);
      if (!isPairingCredential(credential) || utf8ByteLength(text) > MAX_CREDENTIAL_BYTES)
        throw connectionError('invalid_input');
      await store.setItemAsync(CREDENTIAL_KEY, text);
    },
    clear: () => store.deleteItemAsync(CREDENTIAL_KEY),
  };
}
