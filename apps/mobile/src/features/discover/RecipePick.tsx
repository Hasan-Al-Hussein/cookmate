import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { OrdinaryRecipePhoto, type OrdinaryRecipe } from '../../components/OrdinaryRecipePhoto';
import { AppText } from '../../components/Typography';
import { ActionButton } from '../../components/Controls';
import { IconButton } from '../../components/Icon';
import { useNativeLayout } from '../../hooks/useNativeLayout';

/** Selection happens only on an explicit tap, within the supplied eligible set. */
export function pickRecipeId(
  ids: readonly string[],
  previous?: string,
  random = Math.random,
): string | null {
  const available = [...new Set(ids)].filter((id) => /^[0-9]{1,20}$/.test(id));
  if (!available.length) return null;
  const choices = available.length > 1 ? available.filter((id) => id !== previous) : available;
  return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))]!;
}

export function RecipePick({
  recipe,
  count,
  onAnother,
  onDismiss,
}: {
  recipe: OrdinaryRecipe;
  count: number;
  onAnother(): void;
  onDismiss(): void;
}) {
  const styles = useThemedStyles(createStyles);

  const router = useRouter();
  const { enlarged } = useNativeLayout();
  return (
    <View style={styles.pick}>
      <View style={styles.heading}>
        <View style={styles.copy}>
          <AppText role="section">Your pick</AppText>
          <AppText role="support" color="inkSecondary">
            {count === 1
              ? 'The only recipe matching these criteria.'
              : `Chosen from ${count} matching recipes.`}
          </AppText>
        </View>
        <IconButton name="close" label="Dismiss recipe pick" tone="quiet" onPress={onDismiss} />
      </View>
      <View style={[styles.recipe, enlarged && styles.stacked]}>
        <View style={styles.photo}>
          <OrdinaryRecipePhoto recipe={recipe} aspectRatio={1} />
        </View>
        <View style={styles.copy}>
          <AppText role="recipe">{recipe.title}</AppText>
          <AppText role="support" color="inkSecondary">
            {recipe.cuisine}
          </AppText>
        </View>
      </View>
      <View style={[styles.actions, enlarged && styles.stacked]}>
        <ActionButton
          label="View picked recipe"
          variant="secondary"
          style={styles.action}
          onPress={() => router.push({ pathname: '/recipe/[id]', params: { id: recipe.recipeId } })}
        />
        {count > 1 && (
          <ActionButton
            label="Pick another"
            variant="quiet"
            style={styles.action}
            onPress={onAnother}
          />
        )}
      </View>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    pick: {
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      padding: t.space.md,
      gap: t.space.sm,
      borderWidth: 1,
      borderColor: t.color.divider,
    },
    heading: { flexDirection: 'row', alignItems: 'center', gap: t.space.xs },
    copy: { flex: 1, gap: t.space.xxs },
    recipe: { flexDirection: 'row', alignItems: 'center', gap: t.space.md },
    photo: { width: 96 },
    actions: { flexDirection: 'row', gap: t.space.xs },
    action: { flex: 1 },
    stacked: { flexDirection: 'column', alignItems: 'stretch' },
  });
