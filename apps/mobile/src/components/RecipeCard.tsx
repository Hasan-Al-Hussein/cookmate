import { MotionPressable as Pressable } from './MotionPressable';
import { useTheme, useThemedStyles, type ThemeTokens } from '../design/ThemeProvider';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AppText } from './Typography';
import {
  OrdinaryRecipePhoto,
  ordinaryPhotoNeedsReview,
  type OrdinaryRecipe,
} from './OrdinaryRecipePhoto';
import { FavouriteButton } from '../features/workspace/FavouritesState';
import { useNativeLayout } from '../hooks/useNativeLayout';
import type { ReactNode } from 'react';

export function RecipeCard({
  recipe,
  favouriteCollection = false,
  presentation = 'standard',
}: {
  recipe: OrdinaryRecipe;
  favouriteCollection?: boolean;
  presentation?: 'editorial' | 'standard';
}) {
  const router = useRouter();
  const editorial = presentation === 'editorial';
  const t = useTheme();
  const photoNeedsReview = ordinaryPhotoNeedsReview(recipe);
  return (
    <RecipeCardFrame
      title={recipe.title}
      cuisine={recipe.cuisine}
      presentation={presentation}
      accessibilityLabel={`Open ${recipe.title}, ${recipe.cuisine}${photoNeedsReview ? '. Photo needs review; see source notes' : ''}`}
      onOpen={() => router.push({ pathname: '/recipe/[id]', params: { id: recipe.recipeId } })}
      photo={
        <OrdinaryRecipePhoto
          recipe={recipe}
          borderRadius={0}
          aspectRatio={editorial ? 1.2 : t.image.discoveryAspectRatio}
        />
      }
      save={
        <FavouriteButton
          recipeId={recipe.recipeId}
          title={recipe.title}
          compact
          restoreOnUnsave={favouriteCollection}
        />
      }
    />
  );
}

/** Shared card composition; callers retain recipe, photo and navigation authority. */
export function RecipeCardFrame({
  title,
  cuisine,
  photo,
  save,
  onOpen,
  accessibilityLabel,
  status,
  presentation = 'standard',
}: {
  title: string;
  cuisine: string;
  photo: ReactNode;
  save: ReactNode;
  onOpen(): void;
  accessibilityLabel: string;
  status?: string;
  presentation?: 'editorial' | 'standard';
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const { enlarged, fontScale } = useNativeLayout();
  const editorial = presentation === 'editorial';
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onOpen}
        style={({ pressed }) => [styles.open, pressed && styles.pressed]}
      >
        <View style={styles.clip}>
          {photo}
          <View style={[styles.caption, editorial && styles.editorialCaption]}>
            <AppText
              role="recipe"
              style={
                editorial && !enlarged && { minHeight: t.type.recipe.lineHeight * 2 * fontScale }
              }
            >
              {title}
            </AppText>
            <AppText role="support" color="inkSecondary" style={editorial && styles.metadata}>
              {cuisine}
            </AppText>
            {status && (
              <AppText role="support" color="inkSecondary">
                {status}
              </AppText>
            )}
          </View>
        </View>
      </Pressable>
      {save}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    card: {
      flex: 1,
      minWidth: 0,
      overflow: 'visible',
    },
    open: {
      flex: 1,
      backgroundColor: t.color.surface,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: t.color.divider,
      overflow: 'visible',
      boxShadow: '0px 5px 14px rgba(58, 32, 22, 0.10)',
    },
    clip: { flex: 1, borderRadius: 17, overflow: 'hidden' },
    caption: { padding: t.space.sm, gap: t.space.xxs },
    editorialCaption: { paddingBottom: t.space.md },
    metadata: { fontSize: 13, lineHeight: 18 },
    pressed: { opacity: 0.97 },
  });
