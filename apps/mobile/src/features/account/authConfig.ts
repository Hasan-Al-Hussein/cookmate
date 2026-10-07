export interface AccountAuthConfig {
  url: string;
  publishableKey: string;
  serviceEndpoint: string;
  google: boolean;
  apple: boolean;
  googleWebClientId: string | null;
  googleIosClientId: string | null;
}
export function parseAccountAuthConfig(input: {
  url?: string;
  publishableKey?: string;
  google?: string;
  apple?: string;
  googleWebClientId?: string;
  googleIosClientId?: string;
}): AccountAuthConfig | null {
  try {
    if (!input.url || !input.publishableKey) return null;
    const url = new URL(input.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      !/^sb_publishable_[A-Za-z0-9_-]+$/.test(input.publishableKey)
    )
      return null;
    const client = (value: string | undefined) =>
      value && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value) ? value : null;
    return Object.freeze({
      url: url.origin,
      publishableKey: input.publishableKey,
      serviceEndpoint: `${url.origin}/functions/v1/cookmate-account`,
      google: input.google === '1',
      apple: input.apple === '1',
      googleWebClientId: client(input.googleWebClientId),
      googleIosClientId: client(input.googleIosClientId),
    });
  } catch {
    return null;
  }
}

// Expo inlines these public values. Administrative keys are rejected and never belong here.
export function readAccountAuthConfig(): AccountAuthConfig | null {
  return parseAccountAuthConfig({
    ...(process.env.EXPO_PUBLIC_COOKMATE_SUPABASE_URL
      ? { url: process.env.EXPO_PUBLIC_COOKMATE_SUPABASE_URL }
      : {}),
    ...(process.env.EXPO_PUBLIC_COOKMATE_SUPABASE_PUBLISHABLE_KEY
      ? { publishableKey: process.env.EXPO_PUBLIC_COOKMATE_SUPABASE_PUBLISHABLE_KEY }
      : {}),
    ...(process.env.EXPO_PUBLIC_COOKMATE_GOOGLE_AUTH
      ? { google: process.env.EXPO_PUBLIC_COOKMATE_GOOGLE_AUTH }
      : {}),
    ...(process.env.EXPO_PUBLIC_COOKMATE_APPLE_AUTH
      ? { apple: process.env.EXPO_PUBLIC_COOKMATE_APPLE_AUTH }
      : {}),
    ...(process.env.EXPO_PUBLIC_COOKMATE_GOOGLE_WEB_CLIENT_ID
      ? { googleWebClientId: process.env.EXPO_PUBLIC_COOKMATE_GOOGLE_WEB_CLIENT_ID }
      : {}),
    ...(process.env.EXPO_PUBLIC_COOKMATE_GOOGLE_IOS_CLIENT_ID
      ? { googleIosClientId: process.env.EXPO_PUBLIC_COOKMATE_GOOGLE_IOS_CLIENT_ID }
      : {}),
  });
}
