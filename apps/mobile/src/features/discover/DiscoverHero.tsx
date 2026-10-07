import { useTheme, useThemedStyles, withAlpha, type ThemeTokens } from '../../design/ThemeProvider';
import { useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { recipePhotoAssets } from '@cookmate/catalogue/photos';
import { PageHeader } from '../../components/Page';
import { AppText, EditorialAccent } from '../../components/Typography';
import { AppIcon } from '../../components/Icon';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { OrdinaryRecipePhoto } from '../../components/OrdinaryRecipePhoto';
import { useDiscoverCatalogue } from './DiscoverState';

/** Live editorial layers over the exact supplied recipe photograph. */
export function DiscoverHero({ expanded }: { expanded: boolean }) {
  const t = useTheme();
  const ivory = t.color.canvas;
  const styles = useThemedStyles(createStyles);

  const router = useRouter();
  const { width, enlarged } = useNativeLayout();
  const [photoFailed, setPhotoFailed] = useState(false);
  const catalogue = useDiscoverCatalogue().ready;
  const featuredRecipe = catalogue?.current('52839');
  const verified = catalogue?.mode === 'content';
  const photo =
    !verified && featuredRecipe ? recipePhotoAssets[featuredRecipe.recipeId] : undefined;
  return (
    <View style={[styles.hero, expanded ? styles.expanded : styles.collapsed]}>
      {expanded && featuredRecipe && (verified || (photo && !photoFailed)) && (
        <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden>
          {verified ? (
            <View style={[styles.photograph, { width: Math.max(330, width * 0.84) }]}>
              <OrdinaryRecipePhoto
                recipe={featuredRecipe}
                borderRadius={0}
                aspectRatio={Math.max(330, width * 0.84) / 330}
                compact
              />
            </View>
          ) : (
            <Image
              source={photo}
              style={[styles.photograph, { width: Math.max(330, width * 0.84) }]}
              resizeMode="cover"
              accessible={false}
              onError={() => setPhotoFailed(true)}
            />
          )}
          <LinearGradient
            colors={[ivory, ivory, withAlpha(ivory, 0.7), withAlpha(ivory, 0)]}
            locations={[0, 0.4, 0.56, 0.8]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={[withAlpha(ivory, 0), ivory]}
            locations={[0.65, 1]}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            colors={[ivory, ivory, withAlpha(ivory, 0)]}
            locations={[0, 0.1, 0.4]}
            style={StyleSheet.absoluteFill}
          />
        </View>
      )}
      <PageHeader brand />
      {expanded && (
        <>
          <View style={[styles.words, enlarged && styles.enlargedWords]}>
            <AppText style={styles.eyebrow}>DISCOVER</AppText>
            <AppText
              role="lead"
              style={styles.headline}
              accessibilityRole="header"
              accessibilityLabel="Find your next meal."
            >
              Find your{'\n'}
              <EditorialAccent>next</EditorialAccent> meal.
            </AppText>
            <AppText style={styles.support} color="inkSecondary">
              Discover recipes, plan your week, and find a little inspiration.
            </AppText>
          </View>
          {featuredRecipe && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${featuredRecipe.title}, featured recipe`}
              onPress={() =>
                router.push({ pathname: '/recipe/[id]', params: { id: featuredRecipe.recipeId } })
              }
              style={({ pressed }) => [
                styles.featureLink,
                enlarged && styles.enlargedLink,
                pressed && styles.pressed,
              ]}
            >
              <AppText role="support" style={styles.featureTitle}>
                {featuredRecipe.title}
              </AppText>
              <AppIcon name="chevronRight" size={15} color={t.color.brandText} />
            </Pressable>
          )}
          {!verified && photoFailed && <AppText role="support">Featured photo unavailable</AppText>}
        </>
      )}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    hero: {
      backgroundColor: t.color.canvas,
      paddingHorizontal: t.space.gutter,
      paddingTop: t.space.sm,
      overflow: 'hidden',
    },
    expanded: { minHeight: 330, paddingBottom: 46 },
    collapsed: { paddingBottom: t.space.xs },
    photograph: { position: 'absolute', right: -85, top: 0, height: '100%' },
    words: { paddingTop: 25, gap: t.space.sm, width: '71%', maxWidth: 320 },
    enlargedWords: {
      width: '100%',
      maxWidth: undefined,
      padding: t.space.xs,
      backgroundColor: withAlpha(t.color.canvas, 0.94),
    },
    eyebrow: { color: t.color.brandText, fontSize: 11, lineHeight: 15, letterSpacing: 2.5 },
    headline: { fontSize: 43, lineHeight: 44, letterSpacing: -1.2 },
    support: { fontSize: 15, lineHeight: 22, maxWidth: 220 },
    featureLink: {
      position: 'absolute',
      bottom: 30,
      right: t.space.gutter,
      maxWidth: 158,
      minHeight: 48,
      paddingHorizontal: t.space.xs,
      paddingVertical: t.space.xxs,
      borderRadius: t.radius.small,
      backgroundColor: withAlpha(t.color.surface, 0.92),
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    enlargedLink: {
      position: 'relative',
      bottom: undefined,
      right: undefined,
      alignSelf: 'flex-end',
      marginTop: t.space.sm,
      maxWidth: '100%',
    },
    featureTitle: { flexShrink: 1, fontSize: 12, lineHeight: 16 },
    pressed: { opacity: 0.75 },
  });
