import { Stack } from 'expo-router';
import { useTheme } from '../design/ThemeProvider';
import { useReducedMotion } from '../hooks/useNativeLayout';
import { RouteMotion } from './RouteMotion';
import { ContentRouteGuard } from '../features/content/ContentRouteGuard';

/** Shared ordinary navigation: the configured content installation uses the same routes. */
export function ApplicationNavigator() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <Stack
      screenLayout={({ children, route }) => (
        <RouteMotion root={route.name === '(tabs)'}>
          <ContentRouteGuard route={route.name} level="stack">
            {children}
          </ContentRouteGuard>
        </RouteMotion>
      )}
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.color.canvas },
        animation: reduced ? 'none' : 'default',
      }}
    />
  );
}
