import { useThemedStyles, type ThemeTokens } from '../../../design/ThemeProvider';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Image, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { getRecipePhotoTreatment, type CatalogueRecipe } from '@cookmate/catalogue';
import { recipePhotoAssets } from '@cookmate/catalogue/photos';
import { ActionButton } from '../../../components/Controls';
import { AppText } from '../../../components/Typography';
import { RecipeVideoPlayer } from './RecipeVideoPlayer';
import {
  safeSourceUrl,
  youtubeVideoId,
  VIDEO_LOAD_TIMEOUT_MS,
  videoFailureCopy,
  type VideoFailure,
  type VideoStatus,
} from './videoModel';

export function RecipeVideoCard({
  recipe,
  onOpenSource,
  activationRequest = 0,
  suspended = false,
  compact = false,
  useBundledPhoto = true,
}: {
  recipe: Pick<CatalogueRecipe, 'recipeId' | 'title' | 'videoUrl'>;
  onOpenSource: (url: string) => void;
  /** Increased only by a deliberate Watch action on this recipe screen. */
  activationRequest?: number;
  /** A covering reading mode must stop playback without moving this section. */
  suspended?: boolean;
  compact?: boolean;
  /** Exact-content readers supply their own verified photo and must not reuse the bundled image. */
  useBundledPhoto?: boolean;
}) {
  const styles = useThemedStyles(createStyles);

  const [activated, setActivated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<VideoStatus>('loading');
  const [failure, setFailure] = useState<VideoFailure | null>(null);
  const [width, setWidth] = useState(320);
  const [photoFailed, setPhotoFailed] = useState(false);
  const videoId = youtubeVideoId(recipe.videoUrl);
  const safeUrl = safeSourceUrl(recipe.videoUrl);
  const height = Math.max(200, (width * 9) / 16);
  const photo = useBundledPhoto ? recipePhotoAssets[recipe.recipeId] : undefined;
  const photoTreatment = useBundledPhoto ? getRecipePhotoTreatment(recipe.recipeId) : undefined;
  useFocusEffect(useCallback(() => () => setActivated(false), []));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') setActivated(false);
    });
    const hide = () => {
      if (document.visibilityState !== 'visible') setActivated(false);
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hide);
    return () => {
      subscription.remove();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hide);
    };
  }, []);
  useEffect(() => {
    if (!activated || suspended || failure || status !== 'loading') return;
    const timeout = setTimeout(() => setFailure('network'), VIDEO_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [activated, attempt, failure, status, suspended]);
  const activate = useCallback(() => {
    setFailure(null);
    setStatus('loading');
    setAttempt((current) => current + 1);
    setActivated(true);
  }, []);
  useEffect(() => {
    if (suspended) {
      setActivated(false);
      setFailure(null);
    } else if (activationRequest > 0 && videoId) activate();
  }, [activate, activationRequest, suspended, videoId]);
  if (!recipe.videoUrl)
    return <AppText color="inkSecondary">No video supplied for this recipe.</AppText>;
  if (!videoId)
    return (
      <View style={styles.group}>
        <AppText color="inkSecondary">
          This supplied video link cannot be played inside CookMate.
        </AppText>
        {safeUrl && (
          <ActionButton
            label="Open video source ↗"
            variant="quiet"
            onPress={() => onOpenSource(recipe.videoUrl!)}
          />
        )}
      </View>
    );
  if (compact && !activated && !failure)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Watch recipe video for ${recipe.title}`}
        accessibilityHint="Loads a YouTube player here. Internet required."
        onPress={activate}
        style={styles.compactPreview}
      >
        {photo && !photoFailed && (
          <Image
            source={photo}
            resizeMode={photoTreatment?.preserveFullFrame ? 'contain' : 'cover'}
            style={styles.compactPhoto}
            onError={() => setPhotoFailed(true)}
            accessibilityLabel={`Recipe photograph of ${recipe.title}, not a video frame`}
          />
        )}
        <View style={styles.compactText}>
          <AppText role="bodyStrong" color="brand">
            Watch recipe video
          </AppText>
          <AppText role="support" color="inkSecondary">
            YouTube · Internet required
          </AppText>
          {photoTreatment?.warningAnnotationId && (
            <AppText role="support" color="caution">
              Photo needs review
            </AppText>
          )}
        </View>
        <View style={styles.compactPlay} accessible={false}>
          <View style={styles.triangle} />
        </View>
      </Pressable>
    );
  return (
    <View style={styles.group}>
      <AppText role="section" accessibilityRole="header">
        Recipe video
      </AppText>
      <View
        onLayout={({ nativeEvent }) => {
          if (nativeEvent.layout.width > 0) setWidth(nativeEvent.layout.width);
        }}
        style={[styles.media, { height }]}
      >
        {activated && !failure && !suspended ? (
          <RecipeVideoPlayer
            key={attempt}
            videoId={videoId}
            title={recipe.title}
            height={height}
            onStatus={setStatus}
            onError={setFailure}
          />
        ) : failure ? (
          <View style={styles.failure}>
            <AppText role="bodyStrong">Video unavailable</AppText>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Watch recipe video for ${recipe.title}`}
            accessibilityHint="Loads a YouTube player here. Internet required."
            onPress={activate}
            style={styles.poster}
          >
            {photo && !photoFailed ? (
              <Image
                source={photo}
                resizeMode={photoTreatment?.preserveFullFrame ? 'contain' : 'cover'}
                style={[StyleSheet.absoluteFill, styles.photo]}
                onError={() => setPhotoFailed(true)}
                accessibilityLabel={`Recipe photograph of ${recipe.title}, not a video frame`}
              />
            ) : (
              <AppText style={styles.photoFallback}>Recipe preview photo unavailable</AppText>
            )}
            <View style={styles.play} accessible={false}>
              <View style={styles.triangle} />
            </View>
          </Pressable>
        )}
      </View>
      <AppText role="bodyStrong" accessibilityLiveRegion="polite">
        {failure
          ? 'Your recipe stays available below.'
          : !activated
            ? 'Watch recipe video'
            : {
                loading: 'Loading video…',
                ready: 'Video ready. Use the player’s play control if needed.',
                playing: 'Playing',
                paused: 'Paused',
                ended: 'Video finished',
              }[status]}
      </AppText>
      <AppText role="support" color="inkSecondary">
        {!activated && !failure
          ? 'Recipe photo preview · Loads a YouTube video here. Internet required.'
          : 'YouTube video · Internet required.'}
      </AppText>
      {failure && (
        <View style={styles.group}>
          <AppText role="support">{videoFailureCopy[failure]}</AppText>
          <ActionButton label="Retry video" variant="quiet" onPress={activate} />
        </View>
      )}
      {photoTreatment?.warningAnnotationId && (
        <AppText role="support" color="inkSecondary">
          Photo needs review. See the recipe’s source notes.
        </AppText>
      )}
      {(activated || failure) && (
        <View style={styles.actions}>
          <ActionButton
            label="Hide video"
            variant="secondary"
            onPress={() => {
              setActivated(false);
              setFailure(null);
            }}
          />
          <ActionButton
            label="Open on YouTube ↗"
            variant="quiet"
            style={styles.external}
            onPress={() => onOpenSource(recipe.videoUrl!)}
          />
        </View>
      )}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    photo: { width: '100%', height: '100%' },
    group: { gap: t.space.xs },
    compactPreview: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      padding: t.space.sm,
      borderRadius: t.radius.card,
      backgroundColor: t.color.surface,
      borderWidth: 1,
      borderColor: t.color.divider,
    },
    compactPhoto: { width: 60, height: 60, borderRadius: t.radius.small },
    compactText: { flex: 1, minWidth: 0 },
    compactPlay: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: t.color.brand,
      alignItems: 'center',
      justifyContent: 'center',
    },
    media: {
      width: '100%',
      minWidth: 200,
      backgroundColor: t.color.surfaceMuted,
      borderRadius: t.radius.control,
    },
    poster: {
      flex: 1,
      overflow: 'hidden',
      borderRadius: t.radius.control,
      alignItems: 'center',
      justifyContent: 'center',
    },
    play: {
      width: 58,
      height: 58,
      borderRadius: 29,
      backgroundColor: t.color.brand,
      alignItems: 'center',
      justifyContent: 'center',
    },
    triangle: {
      width: 0,
      height: 0,
      marginLeft: 4,
      borderTopWidth: 10,
      borderBottomWidth: 10,
      borderLeftWidth: 15,
      borderTopColor: 'transparent',
      borderBottomColor: 'transparent',
      borderLeftColor: t.color.onBrand,
    },
    photoFallback: { padding: t.space.md, textAlign: 'center' },
    failure: { flex: 1, padding: t.space.md, gap: t.space.xs, justifyContent: 'center' },
    external: { alignSelf: 'flex-start', paddingHorizontal: 0 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, alignItems: 'center' },
  });
