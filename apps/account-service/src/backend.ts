import { AccountServiceError, boundedJson, record, uuid } from './protocol';

export interface VerifiedAccount {
  ownerId: string;
  sessionId: string;
}
export interface AccountBackend {
  verify(accessToken: string): Promise<VerifiedAccount>;
  rpc(
    name:
      | 'cookmate_sync_read'
      | 'cookmate_sync_commit'
      | 'cookmate_account_begin_delete'
      | 'cookmate_account_deletion_receipt',
    input: Record<string, unknown>,
  ): Promise<unknown>;
  deleteUser(ownerId: string): Promise<void>;
}

const errors: Readonly<Record<string, readonly [number, string]>> = {
  CM400: [400, 'invalid_request'],
  CM401: [401, 'sign_in_required'],
  CM403: [403, 'recent_sign_in_required'],
  CM409: [409, 'operation_changed'],
  CM410: [409, 'deletion_pending'],
  CM412: [409, 'needs_review'],
  CM426: [409, 'snapshot_upgrade_required'],
  CM429: [429, 'sync_rate_limited'],
  CM430: [409, 'deletion_capability_limit'],
};

/** Secrets live only in this server-side adapter. No SDK or service key enters the app. */
export function createSupabaseBackend(options: {
  url: string;
  publishableKey: string;
  serviceKey: string;
  fetch?: typeof fetch;
}): AccountBackend {
  const origin = new URL(options.url);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !['', '/'].includes(origin.pathname) ||
    !options.publishableKey ||
    !options.serviceKey
  )
    throw new Error('Account backend configuration is incomplete.');
  const fetcher = options.fetch ?? fetch;
  async function request(path: string, init: RequestInit) {
    try {
      return await fetcher(new URL(path, origin), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AccountServiceError(503, 'account_service_unavailable');
    }
  }
  const adminHeaders = {
    apikey: options.serviceKey,
    authorization: `Bearer ${options.serviceKey}`,
    'content-type': 'application/json',
  };
  return {
    async verify(accessToken) {
      // getUser verifies signature, expiry and the live user; decoding alone is never auth.
      const response = await request('/auth/v1/user', {
        headers: { apikey: options.publishableKey, authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 401 || response.status === 403 || response.status === 404)
        throw new AccountServiceError(401, 'sign_in_required');
      if (!response.ok) throw new AccountServiceError(503, 'account_service_unavailable');
      const user = await boundedJson(response, 128 * 1024);
      let claims: unknown;
      try {
        const encoded = accessToken.split('.')[1];
        if (!encoded) throw new Error();
        claims = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
      } catch {
        throw new AccountServiceError(401, 'sign_in_required');
      }
      if (
        !record(user) ||
        !uuid(user.id) ||
        !record(claims) ||
        claims.sub !== user.id ||
        !uuid(claims.session_id)
      )
        throw new AccountServiceError(401, 'sign_in_required');
      return { ownerId: user.id, sessionId: claims.session_id };
    },
    async rpc(name, input) {
      const response = await request(`/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify(input),
      });
      // Allow JSONB/PostgREST formatting overhead. Domain parsing still enforces
      // the smaller 2 MiB snapshot limit before storage and before a read response.
      const result = await boundedJson(
        response,
        name === 'cookmate_account_deletion_receipt' ? 4096 : 6 * 1024 * 1024,
      );
      if (!response.ok) {
        const mapped =
          record(result) && typeof result.code === 'string' ? errors[result.code] : undefined;
        if (mapped) throw new AccountServiceError(mapped[0], mapped[1]);
        throw new AccountServiceError(503, 'account_service_unavailable');
      }
      return result;
    },
    async deleteUser(ownerId) {
      if (!uuid(ownerId)) throw new AccountServiceError(400, 'invalid_request');
      try {
        const response = await request(`/auth/v1/admin/users/${encodeURIComponent(ownerId)}`, {
          method: 'DELETE',
          headers: adminHeaders,
          body: JSON.stringify({ should_soft_delete: false }),
        });
        if (!response.ok) throw new AccountServiceError(503, 'deletion_not_confirmed');
      } catch {
        // A transport failure may happen after Auth committed the deletion.
        // Neither a failed retry nor a later 401 establishes its outcome.
        throw new AccountServiceError(503, 'deletion_not_confirmed');
      }
      // Auth user deletion cascades to CookMate's snapshot and all retained sync receipts.
    },
  };
}
