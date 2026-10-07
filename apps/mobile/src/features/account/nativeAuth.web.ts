import { AccountAuthError } from './authTypes';
import type { AccountAuthConfig } from './authConfig';
import type { AccountProviderName } from './authTypes';

export async function nativeAuthAvailability(_config: AccountAuthConfig) {
  return { apple: false, google: false };
}
export async function nativeIdentityToken(
  _provider: AccountProviderName,
  _config: AccountAuthConfig,
): Promise<{ token: string; nonce?: string; appleUserId?: string }> {
  throw new AccountAuthError('unsupported');
}
export async function nativeAppleCredentialState(
  _userId: string,
): Promise<'authorized' | 'revoked' | 'unknown'> {
  return 'unknown';
}
export async function subscribeNativeAppleRevocation(_listener: () => void): Promise<() => void> {
  return () => undefined;
}
export async function clearNativeProviderSession() {
  /* Browser OAuth has no native provider session. */
}
