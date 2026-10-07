import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { AssistantHeader } from './AssistantPresentation';
import { AssistantRecipeReference } from './AssistantRecipeReference';

/** Read-only illustration: recipe navigation only, never conversation or command callbacks. */
export function AssistantPreview({ onBack }: { onBack(): void }) {
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <AssistantHeader title="Assistant preview" onReturn={onBack} returnLabel="Back to Help" />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.notice}>
          <AppText role="label" color="assistant">
            Example only
          </AppText>
          <AppText role="support" color="inkSecondary">
            A sample conversation, not a live AI response. Nothing here is sent or added to your
            conversation.
          </AppText>
        </View>
        <View style={[styles.bubble, styles.userBubble]}>
          <AppText role="label">You · example</AppText>
          <AppText>I feel like pasta. What could I make?</AppText>
        </View>
        <View style={styles.bubble}>
          <AppText role="label" color="assistant">
            CookMate · example
          </AppText>
          <AppText>
            Here are two recipes from the collection. Their recipe pages have the ingredients,
            instructions and source notes.
          </AppText>
        </View>
        {['52839', '53064'].map((id) => (
          <AssistantRecipeReference
            key={id}
            recipeId={id}
            onOpen={() => router.push({ pathname: '/recipe/[id]', params: { id } })}
            onSource={() =>
              router.push({ pathname: '/recipe/[id]', params: { id, section: 'source' } })
            }
          />
        ))}
        <AppText role="support" color="inkSecondary">
          In a real conversation, proposed changes need your review. This example cannot save
          recipes or change your meal plan.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.color.canvas },
    header: { borderBottomWidth: 1, borderBottomColor: t.color.divider },
    content: {
      padding: t.space.gutter,
      gap: t.space.lg,
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
    },
    notice: {
      gap: t.space.xxs,
      backgroundColor: t.color.surfaceMuted,
      borderRadius: t.radius.small,
      padding: t.space.sm,
    },
    bubble: {
      backgroundColor: t.color.surface,
      padding: t.space.md,
      borderRadius: t.radius.card,
      gap: t.space.sm,
    },
    userBubble: {
      backgroundColor: t.color.selection,
      alignSelf: 'flex-end',
      maxWidth: '94%',
      borderBottomRightRadius: t.space.xxs,
    },
  });
