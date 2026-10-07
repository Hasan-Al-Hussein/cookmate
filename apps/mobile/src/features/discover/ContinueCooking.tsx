import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { getRecipe } from '@cookmate/catalogue';
import type { CookingSessionView, Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useWorkspace } from '../workspace/WorkspaceProvider';

/** A bounded read of actual unfinished cooking, never a promotional placeholder. */
export function ContinueCooking({ fallback = null }: { fallback?: ReactNode }) {
  const { availability } = useWorkspace();
  const service = availability.kind === 'ready' ? availability.services.cooking : undefined;
  const router = useRouter();
  const styles = useThemedStyles(createStyles);
  const [view, setView] = useState<Immutable<CookingSessionView> | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadedService, setLoadedService] = useState<typeof service>(undefined);
  const currentService = useRef(service);
  currentService.current = service;
  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let generation = 0;
      focused.current = true;
      setView(null);
      setFailed(false);
      setLoaded(false);
      if (!service) return;
      async function load() {
        const request = ++generation;
        setLoaded(false);
        try {
          const result = await service!.readResumeSession();
          if (!active || currentService.current !== service || request !== generation) return;
          setLoadedService(service);
          setLoaded(result.kind === 'ready');
          setView(result.kind === 'ready' ? result.value : null);
          setFailed(result.kind !== 'ready');
        } catch {
          if (!active || currentService.current !== service || request !== generation) return;
          setLoadedService(service);
          setView(null);
          setFailed(true);
        }
      }
      void load();
      const unsubscribe = service.subscribe(() => void load());
      return () => {
        active = false;
        focused.current = false;
        unsubscribe();
      };
    }, [service, attempt]),
  );
  if (!service || loadedService !== service) return null;
  if (failed)
    return (
      <Notice title="Couldn’t load your cooking progress">
        <ActionButton
          label="Retry cooking progress"
          variant="quiet"
          onPress={() => setAttempt((n) => n + 1)}
        />
      </Notice>
    );
  const session = view?.session;
  const recipe = session ? getRecipe(session.recipeId) : undefined;
  if (!session || session.state !== 'active') return loaded ? fallback : null;
  if (!recipe)
    return (
      <Notice title="Saved cooking progress">
        The saved recipe is unavailable. Your progress has been retained.
      </Notice>
    );
  return (
    <View style={styles.card}>
      <View style={styles.photo}>
        <RecipePhoto recipeId={recipe.recipeId} title={recipe.title} aspectRatio={1} compact />
      </View>
      <View style={styles.copy}>
        <AppText role="support" color="assistant">
          CONTINUE COOKING
        </AppText>
        <AppText role="bodyStrong">{recipe.title}</AppText>
        <AppText role="support" color="inkSecondary">
          {view?.resume === 'content_changed'
            ? 'This recipe changed. Review where to restart.'
            : 'Your reading place is saved on this device.'}
        </AppText>
        <ActionButton
          label={
            view?.resume === 'content_changed' ? 'Review cooking progress' : 'Continue cooking'
          }
          variant="quiet"
          onPress={() => {
            if (!focused.current || currentService.current !== service) return;
            router.push({
              pathname: '/recipe/[id]',
              params: { id: recipe.recipeId, cook: 'resume' },
            });
          }}
        />
      </View>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      gap: t.space.md,
      padding: t.space.md,
      borderRadius: t.radius.card,
      backgroundColor: t.color.surface,
      borderWidth: 1,
      borderColor: t.color.divider,
    },
    photo: { width: 80, flexShrink: 0 },
    copy: { flex: 1, minWidth: 0, gap: t.space.xs },
  });
