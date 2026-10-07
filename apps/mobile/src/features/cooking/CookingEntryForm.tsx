import { StyleSheet, TextInput, View } from 'react-native';
import { COOKING_NOTE_MAX_CHARACTERS } from '@cookmate/domain';
import { ActionButton, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { formatPlanDate } from '../workspace/runtimeClock';

/** Presentation shared by bundled and exact-content completion controllers. */
export function CookingEntryForm({
  date,
  note,
  today,
  validDate,
  busy,
  ready,
  reviewed,
  onDate,
  onNote,
  onRefresh,
  onSave,
}: {
  date: string;
  note: string;
  today: string;
  validDate: boolean;
  busy: boolean;
  ready: boolean;
  reviewed: boolean;
  onDate(value: string): void;
  onNote(value: string): void;
  onRefresh(): void;
  onSave(): void;
}) {
  const styles = useThemedStyles(createStyles),
    controls = useControlStyles();
  const noteLength = Array.from(note).length;
  return (
    <View style={styles.section}>
      <AppText role="label">Cooked on · YYYY-MM-DD</AppText>
      <TextInput
        accessibilityLabel="Cooked on date"
        value={date}
        onChangeText={onDate}
        editable={!busy}
        style={controls.field}
        autoCapitalize="none"
        maxLength={10}
      />
      <AppText role="support">
        {validDate ? formatPlanDate(date) : 'Enter a valid date no later than today.'}
      </AppText>
      <ActionButton
        label="Use today"
        variant="quiet"
        disabled={busy}
        onPress={() => onDate(today)}
      />
      <AppText role="label">Private cooking note · optional</AppText>
      <TextInput
        accessibilityLabel="Private cooking note"
        value={note}
        onChangeText={onNote}
        editable={!busy}
        multiline
        maxLength={COOKING_NOTE_MAX_CHARACTERS * 2}
        style={[controls.field, styles.note]}
      />
      <AppText role="support">
        {noteLength}/{COOKING_NOTE_MAX_CHARACTERS} characters. This note is not sent to the
        assistant.
      </AppText>
      {!reviewed ? (
        <ActionButton
          label="Refresh cooking review"
          variant="secondary"
          disabled={busy}
          onPress={onRefresh}
        />
      ) : (
        <ActionButton
          label="Confirm I cooked this"
          disabled={busy || !ready || !validDate || noteLength > COOKING_NOTE_MAX_CHARACTERS}
          onPress={onSave}
        />
      )}
    </View>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.sm },
    note: { minHeight: 112, textAlignVertical: 'top' },
  });
