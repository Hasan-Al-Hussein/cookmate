import { Tabs } from 'expo-router';
import { BottomNavigation } from '../../src/components/BottomNavigation';
import { useReducedMotion } from '../../src/hooks/useNativeLayout';
import { motionTokens } from '../../src/design/motion';
import { FocusedMotion } from '../../src/components/FocusedMotion';
import { ContentRouteGuard } from '../../src/features/content/ContentRouteGuard';

export default function MainTabs() {
  const reduced = useReducedMotion();
  return (
    <Tabs
      screenLayout={({ children, route }) => (
        <FocusedMotion>
          <ContentRouteGuard route={route.name} level="tab" params={route.params}>
            {children}
          </ContentRouteGuard>
        </FocusedMotion>
      )}
      tabBar={(props) => <BottomNavigation {...props} />}
      screenOptions={{
        headerShown: false,
        animation: reduced ? 'none' : 'fade',
        transitionSpec: {
          animation: 'timing',
          config: { duration: reduced ? 0 : motionTokens.duration.fade },
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Discover' }} />
      <Tabs.Screen name="favourites" options={{ title: 'Favourites' }} />
      <Tabs.Screen name="plan" options={{ title: 'Plan' }} />
      <Tabs.Screen name="assistant" options={{ title: 'Assistant' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
