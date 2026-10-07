import { API_VERSION, validateAssistantTurnResponse } from '@cookmate/contracts';
import type { ContractError } from '@cookmate/contracts';
import { identity } from '@cookmate/catalogue';

export class ConnectionError extends Error {
  constructor(public readonly detail: ContractError) {
    super(detail.messageKey);
    this.name = 'ConnectionError';
  }
}

export function connectionError(
  code: ContractError['code'],
  retry: ContractError['retry'] = 'never',
): ConnectionError {
  return new ConnectionError({ code, retry, messageKey: `connection.${code}` });
}

/** Reuse the generated strict error schema without exposing untrusted server text. */
export function readHttpError(value: unknown): ContractError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 1 || !('error' in value)) return null;
  const id = '00000000-0000-4000-8000-000000000000';
  const envelope = {
    apiVersion: API_VERSION,
    catalogue: identity,
    requestId: id,
    userIntentId: id,
    intentRevision: 0,
    conversationId: id,
    conversationGeneration: 0,
    connectionGeneration: 0,
    preferenceRevision: 0,
    kind: 'error',
    error: value.error,
  };
  if (!validateAssistantTurnResponse(envelope) || envelope.kind !== 'error') return null;
  // Message keys/fields are free text in the wire schema. Never relay them as diagnostics.
  const { code, retry, retryAfterSeconds, field } = envelope.error;
  return {
    code,
    retry,
    messageKey: `connection.${code}`,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(code === 'too_large' && (field === 'context.token_limit' || field === 'context.byte_limit')
      ? { field }
      : {}),
  };
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}
