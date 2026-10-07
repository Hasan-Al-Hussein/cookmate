import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform, TurboModuleRegistry } from 'react-native';
import * as Crypto from 'expo-crypto';
import type { AccountAuthConfig } from './authConfig';
import { AccountAuthError, type AccountProviderName } from './authTypes';

export async function nativeAuthAvailability(config: AccountAuthConfig) {
  if (Platform.OS !== 'ios' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient)
    return { apple: false, google: false };
  const apple =
    config.apple &&
    (await import('expo-apple-authentication')
      .then((module) => module.isAvailableAsync())
      .catch(() => false));
  return {
    apple,
    google:
      config.google &&
      !!config.googleWebClientId &&
      !!config.googleIosClientId &&
      !!TurboModuleRegistry.get('RNGoogleSignin'),
  };
}

/** Provider identity tokens are exchanged immediately, never persisted as cooking data. */
export async function nativeIdentityToken(
  provider: AccountProviderName,
  config: AccountAuthConfig,
): Promise<{ token: string; nonce?: string; appleUserId?: string }> {
  const available = await nativeAuthAvailability(config);
  if (!available[provider]) throw new AccountAuthError('unsupported');
  try {
    if (provider === 'apple') {
      const apple = await import('expo-apple-authentication');
      const nonce = Crypto.randomUUID() + Crypto.randomUUID();
      const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
      const result = await apple.signInAsync({
        nonce: hashed,
        requestedScopes: [apple.AppleAuthenticationScope.EMAIL],
      });
      if (!result.identityToken) throw new AccountAuthError('provider');
      return { token: result.identityToken, nonce, appleUserId: result.user };
    }
    const google = await import('@react-native-google-signin/google-signin');
    google.GoogleSignin.configure({
      webClientId: config.googleWebClientId!,
      iosClientId: config.googleIosClientId!,
      offlineAccess: false,
    });
    const result = await google.GoogleSignin.signIn();
    if (result.type === 'cancelled') throw new AccountAuthError('cancelled');
    if (!result.data.idToken) throw new AccountAuthError('provider');
    return { token: result.data.idToken };
  } catch (error) {
    if (error instanceof AccountAuthError) throw error;
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERR_REQUEST_CANCELED'
    )
      throw new AccountAuthError('cancelled');
    throw new AccountAuthError('provider');
  }
}

export async function nativeAppleCredentialState(
  userId: string,
): Promise<'authorized' | 'revoked' | 'unknown'> {
  if (Platform.OS !== 'ios' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient)
    return 'unknown';
  const apple = await import('expo-apple-authentication');
  const state = await apple.getCredentialStateAsync(userId);
  if (state === apple.AppleAuthenticationCredentialState.AUTHORIZED) return 'authorized';
  if (
    state === apple.AppleAuthenticationCredentialState.REVOKED ||
    state === apple.AppleAuthenticationCredentialState.NOT_FOUND
  )
    return 'revoked';
  return 'unknown';
}

export async function subscribeNativeAppleRevocation(listener: () => void): Promise<() => void> {
  if (Platform.OS !== 'ios' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient)
    return () => undefined;
  const apple = await import('expo-apple-authentication');
  if (!(await apple.isAvailableAsync())) return () => undefined;
  const subscription = apple.addRevokeListener(listener);
  return () => subscription.remove();
}

export async function clearNativeProviderSession() {
  if (Platform.OS !== 'ios' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient)
    return;
  // Supabase logout and cooking-data retention remain separate operations.
  if (!TurboModuleRegistry.get('RNGoogleSignin')) return;
  const google = await import('@react-native-google-signin/google-signin');
  await google.GoogleSignin.signOut();
}
