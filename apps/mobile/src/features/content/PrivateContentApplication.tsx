import { useMemo } from 'react';
import { Platform } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useFonts } from 'expo-font';
import { DisplayFontContext, AppText } from '../../components/Typography';
import { Notice } from '../../components/Controls';
import { Page } from '../../components/Page';
import { PreviewFrame } from '../../components/PreviewFrame';
import { ThemeProvider } from '../../design/ThemeProvider';
import { MotionPolicyProvider } from '../../design/MotionPolicy';
import { readPrivateContentConfiguration } from './privateContentConfig';
import { privateContentBrowserWorkspace } from './privateContentBrowserRuntime';
import { PrivateContentEntry } from './PrivateContentEntry';
import { useOrdinaryContentRuntime } from './ordinaryContentRuntimeContext';
import { BorrowedContentUpdates } from './PrivateContentScreen';

/** Deliberately excludes ordinary account, cooking, assistant and preference-store providers. */
export function PrivateContentApplication() {
  const [fontsReady] = useFonts({
    CookMateNewsreader: require('../../../assets/brand/Newsreader16pt-Regular.ttf'),
    CookMateNewsreaderItalic: require('../../../assets/brand/Newsreader16pt-Italic.ttf'),
  });
  return (
    <DisplayFontContext.Provider value={fontsReady}>
      <ThemeProvider>
        <MotionPolicyProvider>
          <PreviewFrame>
            <Stack screenOptions={{ headerShown: false, animation: 'none' }} />
          </PreviewFrame>
        </MotionPolicyProvider>
      </ThemeProvider>
    </DisplayFontContext.Provider>
  );
}

export function PrivateContentRoute() {
  const runtime = useOrdinaryContentRuntime();
  const router = useRouter();
  return runtime ? (
    <BorrowedContentUpdates runtime={runtime} onExit={() => router.replace('/')} />
  ) : (
    <ConfiguredPrivateContentRoute />
  );
}

function ConfiguredPrivateContentRoute() {
  const configured = useMemo(() => {
    try {
      if (Platform.OS !== 'web') return null;
      const config = readPrivateContentConfiguration(
        process.env.EXPO_PUBLIC_COOKMATE_CONTENT_REVIEW,
        globalThis.location?.origin ?? '',
      );
      return config ? privateContentBrowserWorkspace(config) : null;
    } catch {
      return null;
    }
  }, []);
  if (!configured)
    return (
      <Page bottomInset>
        <AppText role="title">Private recipe review</AppText>
        <Notice title="Private review is not configured">
          <AppText>
            This route requires its own configured browser origin, trusted publication keys and a
            prepared review database. It does not open or migrate your normal cooking data.
          </AppText>
        </Notice>
      </Page>
    );
  return (
    <PrivateContentEntry
      key={process.env.EXPO_PUBLIC_COOKMATE_CONTENT_REVIEW}
      controller={configured}
    />
  );
}
