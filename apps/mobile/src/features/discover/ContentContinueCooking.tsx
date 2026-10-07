import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import type { ContentCookingSessionView } from '../../data/contentCookingSessions';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import type { ContentWorkspaceHost } from '../content/contentWorkspaceHost';
import { ContentRecipePhoto } from '../content/ContentRecipePhoto';
import { ContentCookingSessionRecovery } from '../cooking/ContentCookingSessionRecovery';

/** Latest saved progress comes only from this installation, never a packaged-ID lookup. */
export function ContentContinueCooking({ fallback = null }: { fallback?: ReactNode }) {
  const runtime = useOrdinaryContentRuntime();
  return runtime ? <ScopedContinue host={runtime.host} fallback={fallback} /> : null;
}
function ScopedContinue({ host, fallback }: { host: ContentWorkspaceHost; fallback: ReactNode }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  return snapshot.status === 'ready' ? (
    <Resume key={snapshot.scopeKey} host={host} scopeKey={snapshot.scopeKey} fallback={fallback} />
  ) : null;
}
function Resume({
  host,
  scopeKey,
  fallback,
}: {
  host: ContentWorkspaceHost;
  scopeKey: string;
  fallback: ReactNode;
}) {
  const styles = useThemedStyles(createStyles),
    router = useRouter();
  const [view, setView] = useState<Immutable<ContentCookingSessionView> | null>(null);
  const [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [focused, setFocused] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const active = useRef(false),
    generation = useRef(0);
  const current = useCallback(() => {
    const state = host.getSnapshot();
    return active.current && state.status === 'ready' && state.scopeKey === scopeKey;
  }, [host, scopeKey]);
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (current()) setLoaded(false);
    try {
      if (!current()) return;
      const result = await host.sessions.readResumeSession();
      if (!current() || request !== generation.current) return;
      setLoaded(result.kind === 'ready');
      setView(result.kind === 'ready' ? result.value : null);
      setFailed(result.kind !== 'ready');
    } catch {
      if (current() && request === generation.current) {
        setView(null);
        setFailed(true);
      }
    }
  }, [host, current]);
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      setFocused(true);
      setView(null);
      setFailed(false);
      void load();
      let stop: (() => void) | undefined;
      try {
        stop = host.subscribeCooking(() => void load());
      } catch {
        if (current()) {
          generation.current++;
          setView(null);
          setFailed(true);
        }
      }
      return () => {
        active.current = false;
        setFocused(false);
        generation.current++;
        stop?.();
      };
    }, [host, load, current, attempt]),
  );
  if (!focused) return null;
  const recipe = view?.recipe;
  return (
    <>
      {failed && (
        <Notice title="Couldn’t load your cooking progress">
          <ActionButton
            label="Retry cooking progress"
            variant="quiet"
            onPress={() => {
              if (current()) setAttempt((value) => value + 1);
            }}
          />
        </Notice>
      )}
      {view?.session?.state === 'active' && (
        <View style={styles.card}>
          {recipe && (
            <View style={styles.photo}>
              <ContentRecipePhoto
                recipe={recipe}
                content={host.content}
                scopeKey={scopeKey}
                aspectRatio={1}
                onCleanupFailure={host.onPhotoCleanupFailure}
              />
            </View>
          )}
          <View style={styles.copy}>
            <AppText role="support" color="assistant">
              CONTINUE COOKING
            </AppText>
            <AppText role="bodyStrong">{recipe?.title ?? 'Saved cooking progress'}</AppText>
            <AppText role="support" color="inkSecondary">
              {view.resume === 'exact'
                ? 'Your reading place belongs to this exact saved recipe version.'
                : view.resume === 'legacy_requires_restart'
                  ? 'This saved reading position needs an explicit restart.'
                  : 'The saved recipe version is unavailable. Your progress has been retained.'}
            </AppText>
            {recipe && (
              <ActionButton
                label={view.resume === 'exact' ? 'Continue cooking' : 'Review cooking progress'}
                variant="quiet"
                onPress={() => {
                  if (current())
                    router.push({
                      pathname: '/recipe/[id]',
                      params: {
                        id: recipe.recipeId,
                        contentRef: canonicalContentJson(recipe.contentRef, 1024),
                        cook: 'resume',
                      },
                    });
                }}
              />
            )}
          </View>
        </View>
      )}
      <ContentCookingSessionRecovery
        host={host}
        scopeKey={scopeKey}
        view={view}
        isCurrent={current}
        onConfirmed={load}
      />
      {loaded && !failed && view?.session?.state !== 'active' && fallback}
    </>
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
