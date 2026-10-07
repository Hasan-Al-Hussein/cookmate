import { timingSafeEqual } from 'node:crypto';
import type { AccountBackend } from './backend';
import { AccountServiceError, exact, record, serverTimestamp } from './protocol';

export const DELETION_CAPABILITY_LIMIT = 8;
export const deletionCapability = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);

export type DeletionStatus =
  | { operationId: string; status: 'pending' }
  | { operationId: string; status: 'deleted'; deletedAt: string; expiresAt: string };

export async function deletionCapabilityDigest(
  operationId: string,
  token: string,
): Promise<string> {
  const input = new TextEncoder().encode(
    `cookmate-account-deletion-v1:${operationId.toLowerCase()}:${token}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

function bytes(digest: string): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16),
  );
}

/** The privileged lookup never exposes its hashes; a capability only proves this operation's status. */
export async function readDeletionStatus(
  backend: Pick<AccountBackend, 'rpc'>,
  operationId: string,
  token: string,
): Promise<DeletionStatus> {
  const digest = bytes(await deletionCapabilityDigest(operationId, token));
  const value = await backend.rpc('cookmate_account_deletion_receipt', {
    p_operation: operationId,
  });
  if (
    value !== null &&
    (!exact(value, ['operationId', 'state', 'deletedAt', 'expiresAt', 'capabilityDigests']) ||
      value.operationId !== operationId.toLowerCase() ||
      !Array.isArray(value.capabilityDigests) ||
      value.capabilityDigests.length < 1 ||
      value.capabilityDigests.length > DELETION_CAPABILITY_LIMIT ||
      !value.capabilityDigests.every(deletionCapability) ||
      (value.state === 'pending'
        ? value.deletedAt !== null || value.expiresAt !== null
        : value.state !== 'deleted' ||
          !serverTimestamp(value.deletedAt) ||
          !serverTimestamp(value.expiresAt) ||
          Date.parse(value.expiresAt) <= Date.parse(value.deletedAt)))
  )
    throw new AccountServiceError(503, 'invalid_server_result');

  const digests = record(value) ? (value.capabilityDigests as string[]) : [];
  let matched = 0;
  // Compare every fixed-length slot, including padding; never use string equality or early return.
  for (let index = 0; index < DELETION_CAPABILITY_LIMIT; index++) {
    const equal = timingSafeEqual(digest, bytes(digests[index] ?? '0'.repeat(64)));
    matched |= Number(equal) & Number(index < digests.length);
  }
  if (!matched || !record(value))
    throw new AccountServiceError(404, 'deletion_receipt_unavailable');
  if (value.state === 'pending') return { operationId, status: 'pending' };
  return {
    operationId,
    status: 'deleted',
    deletedAt: value.deletedAt as string,
    expiresAt: value.expiresAt as string,
  };
}
