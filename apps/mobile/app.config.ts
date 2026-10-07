import type { ConfigContext } from 'expo/config';

export default function appConfig({ config }: ConfigContext) {
  // Provider capability is build-time configuration, never inferred from an enabled UI button.
  const apple = process.env.EXPO_PUBLIC_COOKMATE_APPLE_AUTH === '1';
  const googleIosId = process.env.EXPO_PUBLIC_COOKMATE_GOOGLE_IOS_CLIENT_ID;
  const google =
    process.env.EXPO_PUBLIC_COOKMATE_GOOGLE_AUTH === '1' &&
    googleIosId &&
    /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleIosId);
  const configured = {
    ...config,
    ...(apple ? { ios: { ...config.ios, usesAppleSignIn: true } } : {}),
    plugins: [
      ...(config.plugins ?? []),
      ...(apple ? ['expo-apple-authentication'] : []),
      ...(google
        ? [
            [
              '@react-native-google-signin/google-signin',
              { iosUrlScheme: googleIosId.split('.').reverse().join('.') },
            ] as [string, Record<string, string>],
          ]
        : []),
    ],
  };
  if (process.env.COOKMATE_WEB_PREVIEW !== '1') return configured;
  return {
    ...configured,
    platforms: ['ios', 'web'],
    web: { ...config.web, bundler: 'metro', output: 'single' },
  };
}
