import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getRecipePhotoTreatment, type CatalogueRecipe } from '@cookmate/catalogue';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText } from '../../components/Typography';
import { ActionButton } from '../../components/Controls';
import { AppIcon } from '../../components/Icon';
import { FavouriteButton } from './FavouritesState';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import type { ReactNode } from 'react';

/** A small collection gives each saved recipe room to be useful. */
export function SavedRecipeRow({ recipe }: { recipe: CatalogueRecipe }) {
  const router = useRouter();
  const photoNeedsReview = !!getRecipePhotoTreatment(recipe.recipeId)?.warningAnnotationId;
  return (
    <SavedRecipeRowFrame
      title={recipe.title}
      cuisine={recipe.cuisine}
      photo={<RecipePhoto recipeId={recipe.recipeId} title={recipe.title} aspectRatio={1} />}
      accessibilityLabel={`Open ${recipe.title}, ${recipe.cuisine}${photoNeedsReview ? '. Photo needs review; see source notes' : ''}`}
      onOpen={() => router.push({ pathname: '/recipe/[id]', params: { id: recipe.recipeId } })}
      onPlan={() => router.push({ pathname: '/plan-edit', params: { recipeId: recipe.recipeId } })}
      save={
        <FavouriteButton
          recipeId={recipe.recipeId}
          title={recipe.title}
          compact
          inline
          restoreOnUnsave
        />
      }
    />
  );
}

export function SavedRecipeRowFrame({
  title,
  cuisine,
  photo,
  save,
  onOpen,
  onPlan,
  accessibilityLabel,
  status,
}: {
  title: string;
  cuisine: string;
  photo: ReactNode;
  save: ReactNode;
  onOpen(): void;
  onPlan?: () => void;
  accessibilityLabel: string;
  status?: string;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const { enlarged } = useNativeLayout();
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onOpen}
        style={({ pressed }) => [
          styles.open,
          enlarged && styles.stacked,
          pressed && styles.pressed,
        ]}
      >
        <View style={enlarged ? styles.widePhoto : styles.photo}>{photo}</View>
        <View style={styles.copy}>
          <AppText role="recipe">{title}</AppText>
          <AppText role="support" color="inkSecondary">
            {cuisine}
          </AppText>
          {status && (
            <AppText role="support" color="inkSecondary">
              {status}
            </AppText>
          )}
          <View style={styles.link}>
            <AppText role="label" color="brand">
              View recipe
            </AppText>
            <AppIcon name="chevronRight" size={16} color={t.color.brandText} />
          </View>
        </View>
      </Pressable>
      <View style={styles.actions}>
        {onPlan && (
          <ActionButton
            label="Plan this recipe"
            variant="quiet"
            style={styles.plan}
            onPress={onPlan}
          />
        )}
        {save}
      </View>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    card: {
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      padding: t.space.sm,
      gap: t.space.xs,
      boxShadow: '0px 3px 12px rgba(58,32,22,0.07)',
    },
    open: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.md,
      borderRadius: t.radius.small,
    },
    stacked: { flexDirection: 'column', alignItems: 'stretch' },
    photo: { width: 116 },
    widePhoto: { width: '100%' },
    copy: { flex: 1, gap: t.space.xs },
    link: { flexDirection: 'row', alignItems: 'center', gap: t.space.xxs, marginTop: t.space.xs },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      paddingTop: t.space.xs,
    },
    plan: { flex: 1 },
    pressed: { opacity: 0.8 },
  });
