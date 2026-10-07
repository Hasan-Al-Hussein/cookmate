import { ACCOUNT_SNAPSHOT_MAX_BYTES } from '@cookmate/account-sync';
import type { AccountBackend } from './backend';
import { parseAccountServiceSnapshot, type AccountServiceSnapshot } from './snapshot';
import { deletionCapability, deletionCapabilityDigest, readDeletionStatus } from './deletion';
import {
  AccountServiceError,
  boundedJson,
  exact,
  record,
  revision,
  serverTimestamp,
  uuid,
} from './protocol';

function readResponse(result: unknown, ownerId: string, enableContentSnapshots: boolean) {
  if (
    !record(result) ||
    result.ownerId !== ownerId ||
    !revision(result.revision) ||
    result.schemaVersion !== 1 ||
    typeof result.deletionPending !== 'boolean' ||
    (result.deletionPending
      ? !uuid(result.deletionOperationId)
      : result.deletionOperationId !== null) ||
    !Object.hasOwn(result, 'snapshot') ||
    (result.revision === 0
      ? result.snapshot !== null || result.updatedAt !== null
      : result.snapshot === null || !serverTimestamp(result.updatedAt))
  )
    throw new AccountServiceError(503, 'invalid_server_result');
  let snapshot: AccountServiceSnapshot | null = null;
  if (result.snapshot !== null) {
    try {
      snapshot = parseAccountServiceSnapshot(result.snapshot, enableContentSnapshots);
    } catch {
      throw new AccountServiceError(409, 'stored_data_needs_review');
    }
  }
  return {
    ownerId,
    revision: result.revision,
    schemaVersion: 1,
    snapshot,
    updatedAt: result.updatedAt,
    deletionPending: result.deletionPending,
    deletionOperationId: result.deletionOperationId,
  };
}

export function createAccountHandler(options: {
  backend: AccountBackend;
  allowedOrigins: readonly string[];
  /** Server composition capability only. This does not approve a user's expanded sync scope. */
  enableContentSnapshots?: boolean;
}) {
  const origins = new Set(options.allowedOrigins);
  const enableContentSnapshots = options.enableContentSnapshots === true;
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
    headers.set(
      'access-control-allow-headers',
      'authorization, content-type, apikey, x-client-info',
    );
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' });
    try {
      const authorization = request.headers.get('authorization');
      if (
        !authorization ||
        authorization.length > 16_384 ||
        !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)
      )
        throw new AccountServiceError(401, 'sign_in_required');
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        throw new AccountServiceError(415, 'json_required');
      const account = await options.backend.verify(authorization.slice(7));
      const body = await boundedJson(request, ACCOUNT_SNAPSHOT_MAX_BYTES + 8192);
      if (!record(body)) throw new AccountServiceError(400, 'invalid_request');
      const identity = { p_owner: account.ownerId, p_session: account.sessionId };
      if (body.action === 'read' && exact(body, ['action'])) {
        const result = await options.backend.rpc('cookmate_sync_read', identity);
        return respond(200, readResponse(result, account.ownerId, enableContentSnapshots));
      }
      const deleting = body.action === 'delete';
      if (
        (body.action !== 'commit' && !deleting) ||
        !exact(body, [
          'action',
          'operationId',
          'expectedRevision',
          ...(deleting ? ['confirmation', 'recoveryToken'] : ['snapshot']),
        ]) ||
        !uuid(body.operationId) ||
        !revision(body.expectedRevision)
      )
        throw new AccountServiceError(400, 'invalid_request');
      const input = {
        ...identity,
        p_operation: body.operationId,
        p_expected_revision: body.expectedRevision,
      };
      if (deleting) {
        if (body.confirmation !== 'DELETE_COOKMATE_ACCOUNT')
          throw new AccountServiceError(400, 'deletion_confirmation_required');
        if (!deletionCapability(body.recoveryToken))
          throw new AccountServiceError(400, 'invalid_request');
        const operationId = body.operationId.toLowerCase();
        const result = await options.backend.rpc('cookmate_account_begin_delete', {
          ...input,
          p_operation: operationId,
          p_capability_digest: await deletionCapabilityDigest(operationId, body.recoveryToken),
        });
        if (
          !record(result) ||
          result.ownerId !== account.ownerId ||
          result.operationId !== operationId ||
          result.deletionPending !== true
        )
          throw new AccountServiceError(503, 'invalid_server_result');
        try {
          await options.backend.deleteUser(account.ownerId);
        } catch {
          // The Auth transaction may have committed before its response was lost.
        }
        try {
          const receipt = await readDeletionStatus(
            options.backend,
            operationId,
            body.recoveryToken,
          );
          if (receipt.status !== 'deleted') throw new Error();
        } catch {
          throw new AccountServiceError(503, 'deletion_not_confirmed');
        }
        return respond(200, {
          ownerId: account.ownerId,
          operationId: body.operationId,
          deleted: true,
        });
      }
      let snapshot;
      try {
        snapshot = parseAccountServiceSnapshot(body.snapshot, enableContentSnapshots);
      } catch {
        throw new AccountServiceError(400, 'invalid_snapshot');
      }
      const result = await options.backend.rpc('cookmate_sync_commit', {
        ...input,
        p_snapshot: snapshot,
      });
      if (
        !record(result) ||
        result.ownerId !== account.ownerId ||
        result.operationId !== body.operationId ||
        !revision(result.revision) ||
        result.revision !== body.expectedRevision + 1 ||
        !serverTimestamp(result.committedAt)
      )
        throw new AccountServiceError(503, 'invalid_server_result');
      return respond(200, {
        ownerId: account.ownerId,
        operationId: body.operationId,
        revision: result.revision,
        committedAt: result.committedAt,
      });
    } catch (error) {
      // No provider prose, access tokens, request data or service credentials enter logs/responses.
      const known =
        error instanceof AccountServiceError
          ? error
          : new AccountServiceError(503, 'account_service_unavailable');
      if (known.status === 429) headers.set('retry-after', '60');
      return respond(known.status, { error: known.code });
    }
  };
}
