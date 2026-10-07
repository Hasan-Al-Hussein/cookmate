import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useCallback, useRef, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getRecipe } from '@cookmate/catalogue';
import { ActionButton, Notice, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import {
  AssistantCapabilityNotice,
  AssistantContextChip,
  AssistantHeader,
  AssistantLocalActions,
  AssistantWelcome,
} from './AssistantPresentation';
import { AssistantSearchContext } from './AssistantSearchContext';
import { assistantMessageLimit, useAssistantEntry } from './AssistantEntryState';

/** Browser presentation only. No gateway, example replies or native conversation writes. */
export default function AssistantScreen() {
  const styles = useThemedStyles(createStyles);
  const controlStyles = useControlStyles();
  const router = useRouter();
  const { recipeId } = useLocalSearchParams<{ recipeId?: string }>();
  const recipe = typeof recipeId === 'string' ? getRecipe(recipeId) : undefined;
  const { search, previewDraft, setPreviewDraft, previewDraftError } = useAssistantEntry();
  const [preparingQuestion, setPreparingQuestion] = useState(false);
  const searchEntryId = search?.id;
  const scroll = useRef<ScrollView>(null);
  const revealedEntry = useRef<number | undefined>(undefined);
  useFocusEffect(
    useCallback(() => {
      if (searchEntryId === undefined || revealedEntry.current === searchEntryId) return;
      const frame = requestAnimationFrame(() => {
        if (!scroll.current) return;
        scroll.current.scrollTo({ y: 0, animated: false });
        revealedEntry.current = searchEntryId;
      });
      return () => cancelAnimationFrame(frame);
    }, [searchEntryId]),
  );
  const count = [...previewDraft].length;
  const draftVisible = preparingQuestion || !!previewDraft || (!!recipe && !search);
  const onReturn = search
    ? () => router.navigate('/')
    : recipe && router.canGoBack()
      ? () => router.back()
      : undefined;
  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <AssistantHeader onReturn={onReturn} returnLabel={search ? 'Back to search' : 'Back'} />
      </View>
      <ScrollView
        ref={scroll}
        style={styles.root}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <AssistantSearchContext
          draft={previewDraft}
          onChangeDraft={setPreviewDraft}
          editable
          draftOnly
        />
        {recipe && (
          <View style={styles.context}>
            <AssistantContextChip
              label={`Recipe: ${recipe.title}`}
              onRemove={() => router.setParams({ recipeId: '' })}
            />
            <ActionButton
              label="Open recipe"
              variant="quiet"
              onPress={() =>
                router.push({ pathname: '/recipe/[id]', params: { id: recipe.recipeId } })
              }
            />
          </View>
        )}
        <AssistantWelcome />
        <AssistantCapabilityNotice
          title="Chat is unavailable in this preview."
          description="You can still explore recipes and plan meals here."
          onLearnMore={() => router.push({ pathname: '/settings', params: { section: 'privacy' } })}
        />
        <AssistantLocalActions
          onExplore={() => router.navigate('/')}
          onPlan={() => router.navigate('/plan')}
          onPreferences={() =>
            router.push({ pathname: '/settings', params: { section: 'preferences' } })
          }
        />
        {draftVisible ? (
          <View style={styles.draft}>
            <AppText role="bodyStrong">Prepare a question</AppText>
            <AppText role="support" color="inkSecondary">
              Draft only in this preview. Sending is unavailable.
            </AppText>
            {previewDraftError && (
              <Notice title="This preview draft could not be saved" tone="error">
                Keep this tab open to retain your text.
              </Notice>
            )}
            <TextInput
              accessibilityLabel="Draft question"
              placeholder="Write a question for later"
              placeholderTextColor={controlStyles.field.color}
              value={previewDraft}
              onChangeText={setPreviewDraft}
              multiline
              submitBehavior="newline"
              style={[controlStyles.field, styles.draftInput]}
            />
            <AppText
              role="support"
              color={count > assistantMessageLimit ? 'error' : 'inkSecondary'}
            >
              {count > assistantMessageLimit
                ? `Message is ${count - assistantMessageLimit} characters too long. Your text is kept.`
                : 'Your draft stays in this browser tab.'}
            </AppText>
          </View>
        ) : !search ? (
          <ActionButton
            label="Prepare a question"
            variant="quiet"
            onPress={() => setPreparingQuestion(true)}
            style={styles.prepare}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, minHeight: 0, backgroundColor: t.color.canvas },
    header: { borderBottomWidth: 1, borderBottomColor: t.color.divider },
    content: {
      paddingHorizontal: t.space.gutter,
      paddingBottom: t.space.lg,
      gap: t.space.gutter,
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
    },
    prepare: { alignSelf: 'flex-start', paddingHorizontal: 0 },
    context: { gap: t.space.xs },
    draft: {
      gap: t.space.sm,
      paddingTop: t.space.md,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
    },
    draftInput: { minHeight: 96, maxHeight: 160, textAlignVertical: 'top' },
  });
