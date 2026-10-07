import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { StyleSheet, TextInput, View } from 'react-native';
import { ActionButton, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { AssistantContextChip } from './AssistantPresentation';
import {
  appendSuggestedQuestion,
  searchContextLabel,
  useAssistantEntry,
} from './AssistantEntryState';

export function AssistantSearchContext({
  draft,
  onChangeDraft,
  editable,
  draftOnly = false,
}: {
  draft: string;
  onChangeDraft(text: string): void;
  editable: boolean;
  draftOnly?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const controlStyles = useControlStyles();

  const { search, clearSearch, setQuestion } = useAssistantEntry();
  if (!search) return null;
  const appended = appendSuggestedQuestion(draft, search.question);
  return (
    <View style={styles.group}>
      <AssistantContextChip
        label={`Search: ${searchContextLabel(search.criteria)}`}
        onRemove={clearSearch}
      />
      <AppText role="support" color="inkSecondary">
        {draft
          ? 'Your unsent draft is kept. You can add this question to it.'
          : 'Edit this suggested question, then add it to your message.'}{' '}
        {draftOnly
          ? 'This preview keeps a draft only; sending is unavailable.'
          : 'Only your message is sent when you choose Send.'}
      </AppText>
      <TextInput
        accessibilityLabel="Suggested question from your search"
        value={search.question}
        onChangeText={setQuestion}
        multiline
        submitBehavior="newline"
        style={[controlStyles.field, styles.question]}
      />
      <ActionButton
        label="Add question to draft"
        variant="quiet"
        disabled={!editable || !search.question.trim() || appended === null}
        onPress={() => {
          if (!editable || appended === null || !search.question.trim()) return;
          onChangeDraft(appended);
          clearSearch();
        }}
      />
      {appended === null && (
        <AppText role="support" color="error">
          Shorten the question or your draft to stay within 4,000 characters. Nothing has been
          replaced.
        </AppText>
      )}
    </View>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    group: { gap: t.space.xs },
    question: {
      minHeight: 76,
      maxHeight: 144,
      textAlignVertical: 'top',
      backgroundColor: t.color.surface,
    },
  });
