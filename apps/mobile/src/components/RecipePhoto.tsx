import { useThemedStyles, type ThemeTokens } from '../design/ThemeProvider';
import { useState } from 'react';
import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import { getRecipePhotoTreatment } from '@cookmate/catalogue';
import { recipePhotoAssets } from '@cookmate/catalogue/photos';
import { designTokens as t } from '../design';
import { AppText } from './Typography';

export function RecipePhoto({
  recipeId,
  title,
  aspectRatio = t.image.discoveryAspectRatio,
  borderRadius = t.radius.card,
  compact = false,
}: {
  recipeId: string;
  title: string;
  aspectRatio?: number;
  borderRadius?: number;
  compact?: boolean;
}) {
  const source = recipePhotoAssets[recipeId];
  const needsReview = !!getRecipePhotoTreatment(recipeId)?.warningAnnotationId;
  return (
    <RecipePhotoFrame
      imageKey={`${recipeId}:${source ?? 'missing'}`}
      source={source}
      title={title}
      aspectRatio={aspectRatio}
      borderRadius={borderRadius}
      compact={compact}
      needsReview={needsReview}
      preserveFullFrame={!!getRecipePhotoTreatment(recipeId)?.preserveFullFrame}
    />
  );
}

/** Shared presentation only. A published source must be supplied by the verified content reader. */
export function RecipePhotoFrame({
  imageKey,
  source,
  title,
  aspectRatio = t.image.discoveryAspectRatio,
  borderRadius = t.radius.card,
  compact = false,
  needsReview = false,
  preserveFullFrame = false,
  loading = false,
}: {
  imageKey: string;
  source: ImageSourcePropType | undefined;
  title: string;
  aspectRatio?: number;
  borderRadius?: number;
  compact?: boolean;
  needsReview?: boolean;
  preserveFullFrame?: boolean;
  loading?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const accessibilityLabel = needsReview
    ? `Supplied photo for ${title}; recipe association needs review`
    : `Supplied photo of ${title}`;
  return (
    <View style={styles.container}>
      <View style={[styles.frame, { aspectRatio, borderRadius }]}>
        <PhotoContent
          key={imageKey}
          source={source}
          title={title}
          accessibilityLabel={accessibilityLabel}
          preserveFullFrame={preserveFullFrame}
          compact={compact}
          loading={loading}
        />
      </View>
      {needsReview && (
        <View style={styles.notice}>
          <AppText role="label" style={compact && styles.compactLabel}>
            Photo needs review
          </AppText>
          {!compact && (
            <AppText role="support" color="inkSecondary">
              See the recipe’s source notes.
            </AppText>
          )}
        </View>
      )}
    </View>
  );
}

// A keyed image owns its failure state; late errors from an old image cannot hide a new source.
function PhotoContent({
  source,
  title,
  accessibilityLabel,
  preserveFullFrame,
  compact,
  loading,
}: {
  source: ImageSourcePropType | undefined;
  title: string;
  accessibilityLabel: string;
  preserveFullFrame: boolean;
  compact: boolean;
  loading: boolean;
}) {
  const styles = useThemedStyles(createStyles);

  const [failed, setFailed] = useState(false);
  return (
    <>
      {!source || failed ? (
        <View
          style={[styles.fallback, compact && styles.compactFallback]}
          accessibilityLabel={`${loading ? 'Loading photo' : 'Photo unavailable'} for ${title}`}
        >
          <AppText role="support" style={compact && styles.compactLabel}>
            {loading ? 'Loading photo' : 'Photo unavailable'}
          </AppText>
          {!compact && (
            <AppText role="support" color="inkSecondary">
              {title}
            </AppText>
          )}
        </View>
      ) : (
        <Image
          source={source}
          style={styles.image}
          resizeMode={preserveFullFrame ? 'contain' : 'cover'}
          accessibilityLabel={accessibilityLabel}
          onError={() => setFailed(true)}
        />
      )}
    </>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    container: { width: '100%', gap: t.space.xs },
    notice: { gap: t.space.xxs },
    frame: {
      width: '100%',
      backgroundColor: t.color.surfaceMuted,
      borderRadius: t.radius.card,
      overflow: 'hidden',
    },
    image: { width: '100%', height: '100%' },
    fallback: { flex: 1, padding: t.space.sm, alignItems: 'center', justifyContent: 'center' },
    compactFallback: { padding: t.space.xxs },
    compactLabel: { fontSize: 12, lineHeight: 16 },
  });
