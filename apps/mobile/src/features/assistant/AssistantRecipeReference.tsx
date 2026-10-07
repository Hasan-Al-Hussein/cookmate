import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { StyleSheet, View } from 'react-native';
import { getRecipe, getRecipePhotoTreatment } from '@cookmate/catalogue';
import { ActionButton } from '../../components/Controls';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText } from '../../components/Typography';

export function AssistantRecipeReference({
  recipeId,
  index,
  onOpen,
  onSource,
}: {
  recipeId: string;
  index?: number;
  onOpen: () => void;
  onSource: () => void;
}) {
  const styles = useThemedStyles(createStyles);

  const recipe = getRecipe(recipeId);
  const title = recipe?.title ?? 'Unavailable recipe reference';
  const orderedTitle = index === undefined ? title : `${index + 1}. ${title}`;
  const photoNeedsReview = !!getRecipePhotoTreatment(recipeId)?.warningAnnotationId;

  return (
    <View style={styles.card}>
      {recipe && (
        <View style={styles.thumbnail}>
          <RecipePhoto compact recipeId={recipeId} title={title} aspectRatio={1} />
        </View>
      )}
      <View style={styles.content}>
        <AppText role="recipe" color="assistant">
          {orderedTitle}
        </AppText>
        {!recipe && (
          <AppText role="support" color="inkSecondary">
            This recipe reference is unavailable in the catalogue.
          </AppText>
        )}
        <View style={styles.actions}>
          <ActionButton
            label="View recipe"
            accessibilityLabel={`View recipe: ${orderedTitle}`}
            accessibilityHint={
              photoNeedsReview
                ? 'View recipe. Supplied photo association needs review. See the recipe source notes.'
                : 'View this recipe.'
            }
            variant="quiet"
            disabled={!recipe}
            onPress={onOpen}
            style={styles.action}
          />
          <ActionButton
            label="Source"
            accessibilityLabel={`Source: ${title}`}
            variant="quiet"
            disabled={!recipe}
            onPress={onSource}
            style={styles.action}
          />
        </View>
      </View>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.sm,
      padding: t.space.sm,
      backgroundColor: t.color.surface,
      borderWidth: t.border.divider,
      borderColor: t.color.divider,
      borderRadius: t.radius.card,
    },
    thumbnail: { width: t.layout.thumbnail, flexShrink: 0 },
    content: { flex: 1, minWidth: 0, gap: t.space.xxs },
    actions: { flexDirection: 'row', flexWrap: 'wrap', columnGap: t.space.xs },
    action: {
      minHeight: t.control.minimumTarget,
      maxWidth: '100%',
      paddingHorizontal: t.space.xxs,
    },
  });
