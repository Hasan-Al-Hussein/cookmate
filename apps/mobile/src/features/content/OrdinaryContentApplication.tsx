import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { DisplayFontContext, AppText } from '../../components/Typography';
import { LaunchCoordinator } from '../../components/LaunchCoordinator';
import { ApplicationNavigator } from '../../components/ApplicationNavigator';
import { PreviewFrame } from '../../components/PreviewFrame';
import { ThemeTransition } from '../../components/ThemeTransition';
import { Notice } from '../../components/Controls';
import { Page } from '../../components/Page';
import { ThemeProvider, useThemeMode } from '../../design/ThemeProvider';
import { MotionPolicyProvider } from '../../design/MotionPolicy';
import {
  AppPreferencesProvider,
  useAppPreferences,
} from '../app-preferences/AppPreferencesProvider';
import { appPreferencesStoreForContent } from '../app-preferences/preferenceStorage';
import { DiscoverProvider } from '../discover/DiscoverState';
import { AssistantEntryProvider } from '../assistant/AssistantEntryState';
import { PrivateContentEntry } from './PrivateContentEntry';
import { createBrowserContentAccountRuntime } from './createBrowserContentAccountRuntime';
import { ContentAccountEntry } from './ContentAccountEntry';
import { useOptionalContentAccount, type BrowserContentAccountRoot } from './contentAccountContext';
import type { PrivateContentConfiguration } from './privateContentConfig';
import type { PrivateContentRuntime } from './privateContentRuntime';
import { OrdinaryContentRuntimeContext } from './ordinaryContentRuntimeContext';
import { OrdinaryContentWorkspaceProvider } from './OrdinaryContentWorkspaceProvider';
import { ActionConfirmation } from '../workspace/WorkspaceFeedback';
import { FavouritesProvider } from '../workspace/FavouritesState';
import { localAccountStorage } from '../account/localAccountStorage';
import { ContentPrivateStateContext, createContentPrivateState } from './contentPrivateState';
import { PlanningPreferencesProvider } from '../planning-preferences/PlanningPreferencesProvider';
import { RecentlyViewedProvider } from '../recently-viewed/RecentlyViewedProvider';

// A remount cannot construct a second controller/auth client while the old root is draining.
let previousContentLifetime: Promise<void> = Promise.resolve();

export function OrdinaryContentApplication({
  config,
}: {
  config: Readonly<PrivateContentConfiguration>;
}) {
  const [owned, setOwned] = useState<{
    config: Readonly<PrivateContentConfiguration>;
    root: BrowserContentAccountRoot;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let release!: () => void;
    const ended = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lifetime = previousContentLifetime.then(async () => {
      if (!active) return;
      const root = createBrowserContentAccountRuntime(config);
      try {
        if (active) {
          setOwned({ config, root });
          await ended;
        }
      } finally {
        await root.runtime.dispose();
      }
    });
    previousContentLifetime = lifetime;
    void lifetime.catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
      release();
    };
  }, [config]);
  const store = useMemo(
    () => appPreferencesStoreForContent(config.installationId),
    [config.installationId],
  );
  if (failed) return <UnavailableContentApplication />;
  const root = owned?.config === config ? owned.root : null;
  return (
    <AppPreferencesProvider store={store}>
      <ThemeProvider>
        <MotionPolicyProvider>
          <ContentAppearance>
            {root ? (
              <PrivateContentEntry
                controller={root}
                renderOpened={() => (
                  <ContentAccountEntry
                    root={root}
                    renderWorkspace={(runtime) => (
                      <ContentRoutes
                        key={`${runtime.storageScope.installationId}:${runtime.storageScope.ownerId ?? 'guest'}`}
                        installationId={config.installationId}
                        runtime={runtime}
                      />
                    )}
                  />
                )}
              />
            ) : (
              <Page>
                <AppText>Opening this content installation…</AppText>
              </Page>
            )}
          </ContentAppearance>
        </MotionPolicyProvider>
      </ThemeProvider>
    </AppPreferencesProvider>
  );
}

function ContentAppearance({ children }: { children: ReactNode }) {
  const [fontsReady, fontError] = useFonts({
    CookMateNewsreader: require('../../../assets/brand/Newsreader16pt-Regular.ttf'),
    CookMateNewsreaderItalic: require('../../../assets/brand/Newsreader16pt-Italic.ttf'),
  });
  const mode = useThemeMode();
  const { hydrated } = useAppPreferences();
  return (
    <DisplayFontContext.Provider value={fontsReady}>
      <LaunchCoordinator fontSettled={fontsReady || !!fontError}>
        <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
        <ThemeTransition>
          <PreviewFrame>
            {hydrated ? (
              children
            ) : (
              <Page>
                <AppText>Opening this installation’s preferences…</AppText>
              </Page>
            )}
          </PreviewFrame>
        </ThemeTransition>
      </LaunchCoordinator>
    </DisplayFontContext.Provider>
  );
}

function ContentRoutes({
  runtime,
  installationId,
}: {
  runtime: PrivateContentRuntime;
  installationId: string;
}) {
  const account = useOptionalContentAccount();
  const preferences = account?.root.runtime.preferencesStore();
  const privateState = useMemo(() => {
    if (runtime.storageScope.installationId !== installationId)
      throw new Error('Private state does not belong to this content installation.');
    return createContentPrivateState(
      runtime.storageScope,
      localAccountStorage,
      preferences ? { preferences } : {},
    );
  }, [runtime.storageScope, installationId, preferences]);
  if (!account) throw new Error('Configured account lifetime is required for local preferences.');
  return (
    <ContentPrivateStateContext.Provider value={privateState}>
      <PlanningPreferencesProvider controller={account.root.planningPreferences()}>
        <RecentlyViewedProvider controller={account.root.recentlyViewed()}>
          <OrdinaryContentRuntimeContext.Provider value={runtime}>
            <OrdinaryContentWorkspaceProvider host={runtime.host}>
              <FavouritesProvider>
                <DiscoverProvider>
                  <AssistantEntryProvider scopeKey={privateState.draftScopeKey}>
                    <ApplicationNavigator />
                    <ActionConfirmation />
                  </AssistantEntryProvider>
                </DiscoverProvider>
              </FavouritesProvider>
            </OrdinaryContentWorkspaceProvider>
          </OrdinaryContentRuntimeContext.Provider>
        </RecentlyViewedProvider>
      </PlanningPreferencesProvider>
    </ContentPrivateStateContext.Provider>
  );
}

export function UnavailableContentApplication() {
  return (
    <ThemeProvider>
      <Page bottomInset>
        <Notice title="Content installation is unavailable" tone="caution">
          <AppText>
            The selected content installation is not configured for this app and origin. No guest or
            account workspace was opened. Check the operator configuration before retrying.
          </AppText>
        </Notice>
      </Page>
    </ThemeProvider>
  );
}
