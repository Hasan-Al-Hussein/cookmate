import { usePathname } from 'expo-router';
import { useMemo } from 'react';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { Platform, Text, View } from 'react-native';
import { DisplayFontContext } from '../src/components/Typography';
import { PreviewFrame } from '../src/components/PreviewFrame';
import { DiscoverProvider } from '../src/features/discover/DiscoverState';
import { ThemeProvider, useThemeMode } from '../src/design/ThemeProvider';
import { MotionPolicyProvider } from '../src/design/MotionPolicy';
import {
  AppPreferencesProvider,
  useAppPreferences,
} from '../src/features/app-preferences/AppPreferencesProvider';
import { BrandMark } from '../src/components/BrandMark';
import { BootstrapLaunchCoordinator, LaunchCoordinator } from '../src/components/LaunchCoordinator';
import { WorkspaceProvider, useWorkspace } from '../src/features/workspace/WorkspaceProvider';
import { FavouritesProvider } from '../src/features/workspace/FavouritesState';
import { ActionConfirmation } from '../src/features/workspace/WorkspaceFeedback';
import { createNativeAssistant } from '../src/features/assistant/nativeAssistant';
import { AssistantEntryProvider } from '../src/features/assistant/AssistantEntryState';
import { AccountProvider, useAccount } from '../src/features/account/AccountProvider';
import { WelcomeGate } from '../src/features/account/WelcomeGate';
import { BrowserStorageGate } from '../src/components/BrowserStorageGate';
import { ApplicationNavigator } from '../src/components/ApplicationNavigator';
import { ThemeTransition } from '../src/components/ThemeTransition';
import { isPrivateContentPath } from '../src/features/content/privateContentConfig';
import { PrivateContentApplication } from '../src/features/content/PrivateContentApplication';
import { BundledOrdinaryCatalogueProvider } from '../src/features/content/OrdinaryCatalogue';
import { ordinaryContentStartup } from '../src/features/content/ordinaryContentStartup';
import { PlanningPreferencesProvider } from '../src/features/planning-preferences/PlanningPreferencesProvider';
import { RecentlyViewedProvider } from '../src/features/recently-viewed/RecentlyViewedProvider';
import {
  OrdinaryContentApplication,
  UnavailableContentApplication,
} from '../src/features/content/OrdinaryContentApplication';

export default function RootLayout() {
  const privateReview = isPrivateContentPath(usePathname());
  const startup = useMemo(
    () =>
      ordinaryContentStartup(
        process.env.EXPO_PUBLIC_COOKMATE_CONTENT_WORKSPACE,
        Platform.OS,
        Platform.OS === 'web' ? (globalThis.location?.origin ?? '') : '',
      ),
    [],
  );
  return (
    <BootstrapLaunchCoordinator>
      <BrowserStorageGate>
        {startup.kind === 'unavailable' ? (
          <UnavailableContentApplication />
        ) : startup.kind === 'content' ? (
          <OrdinaryContentApplication config={startup.config} />
        ) : privateReview ? (
          <PrivateContentApplication />
        ) : (
          <AccountProvider>
            <OwnedApplication />
          </AccountProvider>
        )}
      </BrowserStorageGate>
    </BootstrapLaunchCoordinator>
  );
}

function OwnedApplication() {
  const { runtime, state, planningPreferences, recentlyViewed } = useAccount();
  if (!planningPreferences || !recentlyViewed)
    throw new Error('Local preference lifetime is missing.');
  return (
    <WorkspaceProvider
      workspaceKey={state.workspaceKey}
      openStore={runtime.opener(state.workspace)}
      {...(Platform.OS === 'web'
        ? {}
        : {
            createAssistant: (services: Parameters<typeof createNativeAssistant>[0]) =>
              createNativeAssistant(services, state.workspaceKey),
          })}
    >
      <AppPreferencesProvider store={runtime.preferencesStore()}>
        <PlanningPreferencesProvider controller={planningPreferences()}>
          <RecentlyViewedProvider controller={recentlyViewed()}>
            <ThemeProvider>
              <MotionPolicyProvider>
                <Application />
              </MotionPolicyProvider>
            </ThemeProvider>
          </RecentlyViewedProvider>
        </PlanningPreferencesProvider>
      </AppPreferencesProvider>
    </WorkspaceProvider>
  );
}

function Application() {
  const mode = useThemeMode();
  const { hydrated } = useAppPreferences();
  const { availability } = useWorkspace();
  const { state } = useAccount();
  const [fontsReady, fontError] = useFonts({
    CookMateNewsreader: require('../assets/brand/Newsreader16pt-Regular.ttf'),
    CookMateNewsreaderItalic: require('../assets/brand/Newsreader16pt-Italic.ttf'),
  });
  if (!hydrated || (state.workspace.kind === 'account' && availability.kind === 'opening'))
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: '#910D16',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 16,
        }}
      >
        <BrandMark width={96} height={96} />
        <Text style={{ color: '#FFFCF8', fontSize: 18, textAlign: 'center' }}>
          {!hydrated ? 'Opening CookMate preferences…' : 'Opening your saved cooking…'}
        </Text>
        <Text style={{ color: '#FFFCF8', fontSize: 16, textAlign: 'center' }}>
          If this does not finish, restart CookMate to retry. Your saved data has not been reset.
        </Text>
      </View>
    );
  return (
    <DisplayFontContext.Provider value={fontsReady}>
      <LaunchCoordinator fontSettled={fontsReady || !!fontError}>
        <FavouritesProvider>
          <BundledOrdinaryCatalogueProvider scopeKey={state.workspaceKey}>
            <DiscoverProvider>
              <AssistantEntryProvider>
                <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
                <ThemeTransition>
                  <PreviewFrame>
                    <WelcomeGate>
                      <ApplicationNavigator />
                      <ActionConfirmation />
                    </WelcomeGate>
                  </PreviewFrame>
                </ThemeTransition>
              </AssistantEntryProvider>
            </DiscoverProvider>
          </BundledOrdinaryCatalogueProvider>
        </FavouritesProvider>
      </LaunchCoordinator>
    </DisplayFontContext.Provider>
  );
}
