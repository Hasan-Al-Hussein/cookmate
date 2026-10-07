import { Platform } from 'react-native';
import { createSupabaseAccountAccess } from './supabaseAccess';
import { AccountAuthError } from './authTypes';
import type { AccountAuthConfig } from './authConfig';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const flowState = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = {
  id: ownerId,
  email: 'cook@example.test',
  user_metadata: { full_name: 'Test cook' },
  app_metadata: { provider: 'google' },
};
const mockValues = new Map<string, string>();
const mockStorage = {
  getItem: jest.fn(async (key: string) => mockValues.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockValues.set(key, value);
  }),
  removeItem: jest.fn(async (key: string) => {
    mockValues.delete(key);
  }),
};
const mockAuth = {
  getUser: jest.fn(),
  getSession: jest.fn(),
  signInWithIdToken: jest.fn(),
  signInWithOAuth: jest.fn(),
  exchangeCodeForSession: jest.fn(),
  signOut: jest.fn(),
  onAuthStateChange: jest.fn(),
  startAutoRefresh: jest.fn(),
  stopAutoRefresh: jest.fn(),
  dispose: jest.fn(),
};
const mockCreateClient = jest.fn((..._args: unknown[]) => ({ auth: mockAuth }));
const mockNativeIdentity = jest.fn();
const mockClearNative = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
  processLock: jest.fn(),
}));
jest.mock('./credentialStorage', () => ({
  accountCredentialStorage: {
    getItem: (key: string) => mockStorage.getItem(key),
    setItem: (key: string, value: string) => mockStorage.setItem(key, value),
    removeItem: (key: string) => mockStorage.removeItem(key),
  },
}));
jest.mock('./nativeAuth', () => ({
  nativeIdentityToken: (...args: unknown[]) => mockNativeIdentity(...args),
  clearNativeProviderSession: () => mockClearNative(),
}));
jest.mock('./authFetch', () => ({ createAccountAuthFetch: () => jest.fn() }));
const config: AccountAuthConfig = {
  url: 'https://account.example',
  publishableKey: 'sb_publishable_test',
  serviceEndpoint: 'https://account.example/functions/v1/cookmate-account',
  google: true,
  apple: true,
  googleWebClientId: null,
  googleIosClientId: null,
};
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const pendingKey = 'cookmate.account.auth-web-pending';
beforeEach(() => {
  jest.clearAllMocks();
  mockValues.clear();
  jest.replaceProperty(Platform, 'OS', 'web');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { isSecureContext: true, location: { origin: 'https://cookmate.example' } },
  });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { subtle: {}, getRandomValues: jest.fn(), randomUUID: () => flowState },
  });
  mockAuth.getUser.mockResolvedValue({ data: { user }, error: null });
  mockAuth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mockAuth.signInWithIdToken.mockResolvedValue({ data: { user }, error: null });
  mockAuth.signInWithOAuth.mockResolvedValue({
    data: {
      url: `https://account.example/auth/v1/authorize?code_challenge_method=s256&code_challenge=${'a'.repeat(43)}`,
      flowId: 'flow_identifier_123',
    },
    error: null,
  });
  mockAuth.exchangeCodeForSession.mockResolvedValue({ data: { user }, error: null });
  mockAuth.signOut.mockResolvedValue({ error: null });
  mockClearNative.mockResolvedValue(undefined);
  mockAuth.dispose.mockResolvedValue(undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else Reflect.deleteProperty(globalThis, 'crypto');
});

test('deletion cleanup refuses to sign out a newer account session', async () => {
  const access = createSupabaseAccountAccess(config);
  mockAuth.getSession.mockResolvedValue({
    data: { session: { user: { ...user, id: flowState } } },
    error: null,
  });
  await expect(access.signOut(ownerId)).rejects.toMatchObject({ reason: 'account_changed' });
  expect(mockAuth.signOut).not.toHaveBeenCalled();
  expect(mockClearNative).not.toHaveBeenCalled();
  mockAuth.getSession.mockResolvedValue({ data: { session: { user } }, error: null });
  await access.signOut(ownerId);
  expect(mockAuth.signOut).toHaveBeenCalledWith({ scope: 'local' });
});

test('a configured installation uses only its supplied owned credential port', async () => {
  const values = new Map<string, string>();
  const supplied = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
  const storageKey = 'cookmate.account.auth-content-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const access = createSupabaseAccountAccess(config, { storage: supplied, storageKey });
  supplied.setItem = async () => {
    throw new Error('Caller port changed');
  };
  await access.prepareWebSignIn('google');
  expect(values.has(pendingKey)).toBe(true);
  expect(mockStorage.setItem).not.toHaveBeenCalled();
  const options = mockCreateClient.mock.calls[0]![2] as {
    auth: { storageKey: string; storage: { setItem(key: string, value: string): Promise<void> } };
  };
  expect(options.auth.storageKey).toBe(storageKey);
  await options.auth.storage.setItem(
    storageKey,
    JSON.stringify({
      access_token: 'disposable-session',
      provider_token: 'excluded-provider-token',
    }),
  );
  expect(JSON.parse(values.get(storageKey)!)).toEqual({ access_token: 'disposable-session' });
  await access.signOut();
  expect(values.has(pendingKey)).toBe(false);
  expect(mockStorage.removeItem).not.toHaveBeenCalled();
  await access.dispose();
});

test('browser flow persists one verifier selector and accepts only its matching callback', async () => {
  const access = createSupabaseAccountAccess(config);
  await access.prepareWebSignIn('google');
  const pending = JSON.parse(mockValues.get(pendingKey)!);
  expect(pending.flowId).toBe('flow_identifier_123');
  expect(pending.state).toBe(flowState);
  const options = mockAuth.signInWithOAuth.mock.calls[0]![0].options;
  expect(options.redirectTo).toBe(
    `https://cookmate.example/auth/callback?cookmate_flow=${flowState}`,
  );
  const identity = await access.completeWebSignIn(`${options.redirectTo}&code=auth_code`);
  expect(identity.ownerId).toBe(ownerId);
  expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledWith('auth_code', {
    flowId: 'flow_identifier_123',
  });
  expect(mockValues.has(pendingKey)).toBe(false);
});
test('wrong origins, flow identifiers and duplicate codes never exchange credentials', async () => {
  const access = createSupabaseAccountAccess(config);
  await access.prepareWebSignIn('google');
  for (const href of [
    `https://attacker.example/auth/callback?cookmate_flow=${flowState}&code=x`,
    'https://cookmate.example/auth/callback?cookmate_flow=other&code=x',
    `https://cookmate.example/auth/callback?cookmate_flow=${flowState}&code=x&code=y`,
  ])
    await expect(access.completeWebSignIn(href)).rejects.toBeInstanceOf(AccountAuthError);
  expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
});
test('plain PKCE fallback and missing browser crypto are rejected before redirect', async () => {
  const access = createSupabaseAccountAccess(config);
  mockAuth.signInWithOAuth.mockResolvedValueOnce({
    data: {
      url: 'https://account.example/auth/v1/authorize?code_challenge_method=plain&code_challenge=unsafe',
      flowId: 'flow_identifier_123',
    },
  });
  await expect(access.prepareWebSignIn('google')).rejects.toMatchObject({ reason: 'unsupported' });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  await expect(access.prepareWebSignIn('google')).rejects.toMatchObject({ reason: 'unsupported' });
  expect(mockAuth.signInWithOAuth).toHaveBeenCalledTimes(1);
  expect(mockValues.size).toBe(0);
});
test('cancelled provider response preserves guest data and does not exchange a code', async () => {
  const access = createSupabaseAccountAccess(config);
  await access.prepareWebSignIn('google');
  await expect(
    access.completeWebSignIn(
      `https://cookmate.example/auth/callback?cookmate_flow=${flowState}&error=access_denied`,
    ),
  ).rejects.toMatchObject({ reason: 'cancelled' });
  expect(mockAuth.exchangeCodeForSession).not.toHaveBeenCalled();
  expect(mockValues.has(pendingKey)).toBe(false);
});
test('a consumed callback is not automatically replayed after response loss', async () => {
  const access = createSupabaseAccountAccess(config);
  await access.prepareWebSignIn('google');
  mockAuth.exchangeCodeForSession.mockRejectedValueOnce(new Error('private provider failure'));
  const callback = `https://cookmate.example/auth/callback?cookmate_flow=${flowState}&code=x`;
  await expect(access.completeWebSignIn(callback)).rejects.toMatchObject({ reason: 'provider' });
  await expect(access.completeWebSignIn(callback)).rejects.toMatchObject({
    reason: 'session_expired',
  });
  expect(mockAuth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
});
test('native identity token cancellation is not reported as a Supabase sign-in', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const access = createSupabaseAccountAccess(config);
  mockNativeIdentity.mockRejectedValueOnce(new AccountAuthError('cancelled'));
  await expect(access.signInNative('apple')).rejects.toMatchObject({ reason: 'cancelled' });
  expect(mockAuth.signInWithIdToken).not.toHaveBeenCalled();
  mockNativeIdentity.mockResolvedValueOnce({
    token: 'synthetic.identity.token',
    nonce: 'synthetic-nonce',
  });
  expect((await access.signInNative('apple')).ownerId).toBe(ownerId);
  expect(mockAuth.signInWithIdToken).toHaveBeenCalledWith({
    provider: 'apple',
    token: 'synthetic.identity.token',
    nonce: 'synthetic-nonce',
  });
});
test('provider API tokens are excluded from persisted Supabase sessions', async () => {
  createSupabaseAccountAccess(config);
  const options = mockCreateClient.mock.calls[0]![2] as {
    auth: { storage: { setItem(key: string, value: string): Promise<void> } };
  };
  await options.auth.storage.setItem(
    'cookmate.account.auth',
    JSON.stringify({
      access_token: 'session-token',
      refresh_token: 'session-refresh',
      provider_token: 'provider-secret',
      provider_refresh_token: 'provider-refresh',
    }),
  );
  expect(JSON.parse(mockValues.get('cookmate.account.auth')!)).toEqual({
    access_token: 'session-token',
    refresh_token: 'session-refresh',
  });
});

test('retired native login waits for its pending prompt and never exchanges a late token', async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  const access = createSupabaseAccountAccess(config);
  let finish!: (value: { token: string }) => void;
  mockNativeIdentity.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const login = access.signInNative('google');
  const rejected = expect(login).rejects.toMatchObject({ reason: 'account_changed' });
  let disposed = false;
  const drain = access.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  finish({ token: 'late-private-token' });
  await rejected;
  await drain;
  expect(mockAuth.signInWithIdToken).not.toHaveBeenCalled();
  await expect(access.readSession()).rejects.toMatchObject({ reason: 'account_changed' });
});

test('replacement waits for an already dispatched secure write and seals the old storage', async () => {
  const access = createSupabaseAccountAccess(config);
  const options = mockCreateClient.mock.calls[0]![2] as {
    auth: { storage: { setItem(key: string, value: string): Promise<void> } };
  };
  let finish!: () => void;
  mockStorage.setItem.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const write = options.auth.storage.setItem('cookmate.account.auth', '{}');
  let disposed = false;
  const drain = access.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  finish();
  await write;
  await drain;
  await expect(options.auth.storage.setItem('cookmate.account.auth', '{}')).rejects.toMatchObject({
    reason: 'account_changed',
  });
});
