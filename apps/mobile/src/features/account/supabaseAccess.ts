import { createClient, processLock, type Session, type User } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import type { AccountAuthConfig } from './authConfig';
import { AccountAuthError, type AccountIdentity, type AccountProviderName } from './authTypes';
import { accountCredentialStorage } from './credentialStorage';
import {
  nativeIdentityToken,
  clearNativeProviderSession,
  nativeAppleCredentialState,
} from './nativeAuth';
import { AccountCredentialStorageError } from './sessionStorage';
import { createAuthLifetime } from './authLifetime';
import { createAccountAuthFetch } from './authFetch';

const pendingKey = 'cookmate.account.auth-web-pending';
const appleKey = 'cookmate.account.auth-apple-user';
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const safeText = (value: unknown, maximum: number): string | null =>
  typeof value === 'string' && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null;
function identity(user: User): AccountIdentity {
  if (!uuid(user.id)) throw new AccountAuthError('provider');
  const provider = user.app_metadata.provider;
  return {
    ownerId: user.id.toLowerCase(),
    email: safeText(user.email, 320),
    displayName: safeText(user.user_metadata.full_name ?? user.user_metadata.name, 120),
    provider: provider === 'google' || provider === 'apple' ? provider : null,
  };
}
function authFailure(error: unknown): AccountAuthError {
  if (error instanceof AccountAuthError) return error;
  if (error instanceof AccountCredentialStorageError) return new AccountAuthError('storage');
  if (typeof error === 'object' && error !== null) {
    if ('status' in error && (error.status === 401 || error.status === 403))
      return new AccountAuthError('session_expired');
    if ('name' in error && error.name === 'AuthRetryableFetchError')
      return new AccountAuthError('network');
  }
  return new AccountAuthError('provider');
}

/** Created only after public configuration validation. Screens never receive the SDK or tokens. */
export function createSupabaseAccountAccess(
  config: AccountAuthConfig,
  partition?: { storage: typeof accountCredentialStorage; storageKey: string },
) {
  // A configured installation supplies its own partition; the default app keeps its exact keys.
  const storage = partition?.storage ?? accountCredentialStorage;
  const storageKey = partition?.storageKey ?? 'cookmate.account.auth';
  if (
    !/^cookmate\.account\.auth(?:-content-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/.test(
      storageKey,
    )
  )
    throw new AccountCredentialStorageError();
  const credentials = Object.freeze({
    getItem: storage.getItem.bind(storage),
    setItem: storage.setItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
  });
  const lifetime = createAuthLifetime();
  const client = createClient(config.url, config.publishableKey, {
    global: { fetch: createAccountAuthFetch(config.url, () => lifetime.check()) },
    auth: {
      // auth-js uses this key for its cross-tab BroadcastChannel as well as persistence.
      storageKey,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      lock: (name, timeout, task) => {
        lifetime.check();
        return lifetime.track(processLock(name, timeout, task));
      },
      storage: {
        getItem: (key) => lifetime.storage(() => credentials.getItem(key)),
        removeItem: (key) => lifetime.storage(() => credentials.removeItem(key)),
        async setItem(key, value) {
          // CookMate does not call Google/Apple APIs after identity verification.
          if (key === storageKey) {
            const session: unknown = JSON.parse(value);
            if (session && typeof session === 'object' && !Array.isArray(session)) {
              const safe = { ...session } as Record<string, unknown>;
              delete safe.provider_token;
              delete safe.provider_refresh_token;
              value = JSON.stringify(safe);
            }
          }
          await lifetime.storage(() => credentials.setItem(key, value));
        },
      },
    },
  });
  let busy = false;
  let disposal: Promise<void> | null = null;
  const serial = async <T>(task: () => Promise<T>): Promise<T> => {
    lifetime.check();
    if (busy) throw new AccountAuthError('provider');
    busy = true;
    try {
      const result = await lifetime.track(task());
      lifetime.check();
      return result;
    } catch (error) {
      throw authFailure(error);
    } finally {
      busy = false;
    }
  };
  async function verified(): Promise<AccountIdentity> {
    lifetime.check();
    const { data, error } = await client.auth.getUser();
    lifetime.check();
    if (error || !data.user) throw authFailure(error);
    return identity(data.user);
  }
  function callbackOrigin() {
    if (
      Platform.OS !== 'web' ||
      typeof window === 'undefined' ||
      !window.isSecureContext ||
      !globalThis.crypto?.subtle ||
      !globalThis.crypto?.getRandomValues
    )
      throw new AccountAuthError('unsupported');
    return `${window.location.origin}/auth/callback`;
  }
  return {
    async readSession(): Promise<{ identity: AccountIdentity; accessToken: string } | null> {
      try {
        lifetime.check();
        const { data, error } = await lifetime.track(client.auth.getSession());
        lifetime.check();
        if (error) throw authFailure(error);
        return data.session
          ? { identity: identity(data.session.user), accessToken: data.session.access_token }
          : null;
      } catch (error) {
        throw authFailure(error);
      }
    },
    subscribe(listener: (identity: AccountIdentity | null) => void) {
      lifetime.check();
      const { data } = client.auth.onAuthStateChange((_event, session: Session | null) => {
        // No awaited Supabase calls inside its lock-holding auth event callback.
        if (lifetime.retired) return;
        try {
          listener(session ? identity(session.user) : null);
        } catch {
          /* Runtime handles invalid/retired identities. */
        }
      });
      return () => data.subscription.unsubscribe();
    },
    signInNative(provider: AccountProviderName) {
      return serial(async () => {
        if (!config[provider] || Platform.OS === 'web') throw new AccountAuthError('unsupported');
        const token = await nativeIdentityToken(provider, config);
        lifetime.check();
        const { error } = await client.auth.signInWithIdToken({
          provider,
          token: token.token,
          ...(token.nonce ? { nonce: token.nonce } : {}),
        });
        if (error) throw authFailure(error);
        const current = await verified();
        if (provider === 'apple' && token.appleUserId) {
          if (!safeText(token.appleUserId, 512)) throw new AccountAuthError('provider');
          await lifetime.storage(() =>
            credentials.setItem(
              appleKey,
              JSON.stringify({ ownerId: current.ownerId, userId: token.appleUserId }),
            ),
          );
        }
        return current;
      });
    },
    prepareWebSignIn(provider: AccountProviderName): Promise<string> {
      return serial(async () => {
        if (!config[provider]) throw new AccountAuthError('unsupported');
        const callback = callbackOrigin();
        const state = globalThis.crypto.randomUUID();
        const { data, error } = await client.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: `${callback}?cookmate_flow=${state}`,
            skipBrowserRedirect: true,
            ...(provider === 'google' ? { queryParams: { prompt: 'select_account' } } : {}),
          },
        });
        if (error || !data.url || !data.flowId) throw authFailure(error);
        const url = new URL(data.url);
        if (
          url.origin !== config.url ||
          url.pathname !== '/auth/v1/authorize' ||
          url.searchParams.get('code_challenge_method')?.toLowerCase() !== 's256' ||
          !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '')
        )
          throw new AccountAuthError('unsupported');
        await credentials.setItem(
          pendingKey,
          JSON.stringify({
            version: 1,
            state,
            flowId: data.flowId,
            callback,
            expiresAt: Date.now() + 10 * 60 * 1000,
            exchanging: false,
          }),
        );
        return url.href;
      });
    },
    completeWebSignIn(href: string) {
      return serial(async () => {
        const callback = callbackOrigin();
        const url = new URL(href);
        if (`${url.origin}${url.pathname}` !== callback || url.hash)
          throw new AccountAuthError('provider');
        const raw = await credentials.getItem(pendingKey);
        if (!raw) throw new AccountAuthError('session_expired');
        const pending: unknown = JSON.parse(raw);
        if (
          !pending ||
          typeof pending !== 'object' ||
          !('version' in pending) ||
          pending.version !== 1 ||
          !('state' in pending) ||
          typeof pending.state !== 'string' ||
          !uuid(pending.state) ||
          !('callback' in pending) ||
          pending.callback !== callback ||
          !('flowId' in pending) ||
          typeof pending.flowId !== 'string' ||
          !/^[A-Za-z0-9_-]{8,64}$/.test(pending.flowId) ||
          !('expiresAt' in pending) ||
          typeof pending.expiresAt !== 'number' ||
          !Number.isSafeInteger(pending.expiresAt) ||
          pending.expiresAt < Date.now() ||
          !('exchanging' in pending) ||
          pending.exchanging !== false ||
          url.searchParams.getAll('cookmate_flow').length !== 1 ||
          url.searchParams.get('cookmate_flow') !== pending.state
        )
          throw new AccountAuthError('session_expired');
        if (url.searchParams.has('error')) {
          await credentials.removeItem(pendingKey);
          throw new AccountAuthError(
            url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'provider',
          );
        }
        const code = url.searchParams.get('code');
        if (
          url.searchParams.getAll('code').length !== 1 ||
          !code ||
          !/^[A-Za-z0-9._-]{1,2048}$/.test(code)
        )
          throw new AccountAuthError('provider');
        await credentials.setItem(pendingKey, JSON.stringify({ ...pending, exchanging: true }));
        // Never automatically repeat a consumed callback after a lost response.
        const { error } = await client.auth.exchangeCodeForSession(code, {
          flowId: pending.flowId,
        });
        await credentials.removeItem(pendingKey);
        if (error) throw authFailure(error);
        return verified();
      });
    },
    signOut(expectedOwner?: string) {
      return serial(async () => {
        if (expectedOwner) {
          const current = await client.auth.getSession();
          if (current.error) throw authFailure(current.error);
          if (current.data.session?.user.id !== expectedOwner)
            throw new AccountAuthError('account_changed');
        }
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw authFailure(error);
        await credentials.removeItem(pendingKey);
        await credentials.removeItem(appleKey);
        await clearNativeProviderSession();
      });
    },
    async verifyNativeAccess(current: AccountIdentity) {
      lifetime.check();
      if (current.provider !== 'apple' || Platform.OS !== 'ios') return;
      const raw = await lifetime.storage(() => credentials.getItem(appleKey));
      lifetime.check();
      if (!raw) return; // A browser Apple session does not have a native credential identifier.
      const record: unknown = JSON.parse(raw);
      if (
        !record ||
        typeof record !== 'object' ||
        !('ownerId' in record) ||
        !('userId' in record) ||
        typeof record.userId !== 'string' ||
        !safeText(record.userId, 512)
      )
        throw new AccountAuthError('storage');
      if (record.ownerId !== current.ownerId) return;
      const state = await lifetime.track(nativeAppleCredentialState(record.userId));
      lifetime.check();
      if (state === 'revoked') throw new AccountAuthError('session_expired');
    },
    startAutoRefresh: () => {
      lifetime.check();
      return lifetime.track(client.auth.startAutoRefresh());
    },
    stopAutoRefresh: () => lifetime.track(client.auth.stopAutoRefresh()),
    dispose() {
      if (disposal) return disposal;
      lifetime.retire();
      disposal = (async () => {
        await client.auth.dispose();
        await lifetime.drain();
        // An already-running initialization may have installed its listener during the drain.
        await client.auth.dispose();
      })();
      return disposal;
    },
  };
}
export type SupabaseAccountAccess = ReturnType<typeof createSupabaseAccountAccess>;
