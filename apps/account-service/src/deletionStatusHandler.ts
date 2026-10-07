import type { AccountBackend } from './backend';
import { deletionCapability, readDeletionStatus } from './deletion';
import { AccountServiceError, boundedJson, exact, uuid } from './protocol';

/** Capability-only receipt lookup. This handler has no authentication, account-read or deletion authority. */
export function createDeletionStatusHandler(options: {
  backend: Pick<AccountBackend, 'rpc'>;
  allowedOrigins: readonly string[];
}) {
  const origins = new Set(options.allowedOrigins);
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const headers = new Headers({
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      vary: 'Origin',
    });
    const respond = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers });
    if (origin && !origins.has(origin)) return respond(403, { error: 'origin_not_allowed' });
    if (origin) headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-methods', 'POST, OPTIONS');
    headers.set('access-control-allow-headers', 'content-type, apikey, x-client-info');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' });
    try {
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        throw new AccountServiceError(415, 'json_required');
      const body = await boundedJson(request, 2048);
      if (
        !exact(body, ['operationId', 'recoveryToken']) ||
        !uuid(body.operationId) ||
        !deletionCapability(body.recoveryToken)
      )
        throw new AccountServiceError(400, 'invalid_request');
      return respond(
        200,
        await readDeletionStatus(options.backend, body.operationId, body.recoveryToken),
      );
    } catch (error) {
      const known =
        error instanceof AccountServiceError
          ? error
          : new AccountServiceError(503, 'account_service_unavailable');
      return respond(known.status, { error: known.code });
    }
  };
}
