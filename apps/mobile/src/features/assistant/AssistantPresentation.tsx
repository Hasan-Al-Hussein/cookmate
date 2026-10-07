import { MotionPressable as Pressable } from '../../components/MotionPressable';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useCallback, useRef } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { ActionButton, useControlStyles } from '../../components/Controls';
import { AppIcon, IconButton } from '../../components/Icon';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { AssistantEmblem } from './AssistantEmblem';

export function AssistantInvitation({
  searchLabel,
  onPress,
}: {
  searchLabel?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  const search = searchLabel?.trim();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={search ? `Ask CookMate about ${search}` : 'Ask CookMate for ideas'}
      onPress={onPress}
      style={({ pressed }) => [styles.invitation, pressed && styles.pressed]}
    >
      <AppIcon name="sparkle" size={28} color={t.color.assistantText} />
      <View style={styles.invitationText}>
        <AppText role="label" color="assistant">
          {search ? `Ask CookMate about ${search}` : 'Need a little inspiration?'}
        </AppText>
        {!search && (
          <AppText role="support" color="assistant">
            Ask CookMate for ideas
          </AppText>
        )}
      </View>
      <AppIcon name="chevronRight" size={18} color={t.color.assistantText} />
    </Pressable>
  );
}

export function AssistantHeader({
  onReturn,
  returnLabel = 'Back',
  title = 'CookMate Assistant',
}: {
  onReturn?: (() => void) | undefined;
  returnLabel?: string;
  title?: string;
}) {
  const styles = useThemedStyles(createStyles);

  const heading = useRef<View>(null);
  const { registerFocusFallback } = useWorkspace();
  useFocusEffect(
    useCallback(
      () => registerFocusFallback(() => focusTarget(heading.current)),
      [registerFocusFallback],
    ),
  );

  return (
    <View style={styles.headingRow}>
      {onReturn && <IconButton name="back" label={returnLabel} tone="quiet" onPress={onReturn} />}
      <AssistantEmblem />
      <View ref={heading} accessible accessibilityRole="header" style={styles.heading}>
        <AppText role="section" color="assistant" style={styles.headingText}>
          {title}
        </AppText>
      </View>
    </View>
  );
}

export function AssistantWelcome() {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.welcome}>
      <AppText role="section">A little help in the kitchen.</AppText>
      <AppText color="inkSecondary">Find a recipe, compare ideas or plan your next meal.</AppText>
    </View>
  );
}

export function AssistantCapabilityNotice({
  title,
  description,
  onLearnMore,
}: {
  title: string;
  description: string;
  onLearnMore(): void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.capability}>
      <AppText role="label" color="assistant">
        {title}
      </AppText>
      <AppText role="support" color="inkSecondary">
        {description}
      </AppText>
      <ActionButton
        label="Learn more"
        variant="quiet"
        onPress={onLearnMore}
        style={styles.learnMore}
      />
    </View>
  );
}

export function AssistantLocalActions({
  onExplore,
  onPlan,
  onPreferences,
}: {
  onExplore(): void;
  onPlan(): void;
  onPreferences(): void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.localActions}>
      <ActionButton label="Explore recipes" onPress={onExplore} />
      <ActionButton label="View meal plan" variant="secondary" onPress={onPlan} />
      <ActionButton label="Saved preferences" variant="quiet" onPress={onPreferences} />
    </View>
  );
}

export function AssistantContextChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Remove context: ${label}`}
      accessibilityHint="Removes this context. Your draft is kept."
      onPress={onRemove}
      style={({ pressed }) => [styles.contextChip, pressed && styles.pressed]}
    >
      <AppText role="label" color="assistant" style={styles.wrappingText}>
        {label}
      </AppText>
      <AppIcon name="close" size={18} color={t.color.assistantText} />
    </Pressable>
  );
}

export function AssistantComposer({
  value,
  onChangeText,
  onSend,
  editable,
  sendDisabled,
}: {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  editable: boolean;
  sendDisabled: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const controlStyles = useControlStyles();

  return (
    <View style={styles.composer}>
      <TextInput
        accessibilityLabel="Message the assistant"
        placeholder="Message the assistant"
        placeholderTextColor={t.color.inkSecondary}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        multiline
        submitBehavior="newline"
        style={[controlStyles.field, styles.input]}
      />
      <ActionButton
        label="Send"
        accessibilityLabel="Send message"
        onPress={onSend}
        disabled={sendDisabled}
        style={styles.send}
      />
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    invitation: {
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      paddingHorizontal: t.space.md,
      paddingVertical: t.space.sm,
      borderRadius: t.radius.control,
      backgroundColor: t.color.successSurface,
    },
    invitationText: { flex: 1, minWidth: 0, gap: t.space.xxs },
    headingRow: {
      minHeight: 60,
      paddingHorizontal: t.space.gutter,
      paddingVertical: 6,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.xs,
    },
    heading: { flex: 1, minWidth: 0 },
    headingText: { fontSize: 20, lineHeight: 26 },
    welcome: { gap: t.space.xs, paddingTop: t.space.lg },
    capability: {
      gap: t.space.xxs,
      paddingHorizontal: t.space.sm,
      paddingTop: t.space.sm,
      paddingBottom: t.space.xxs,
      borderRadius: t.radius.small,
      backgroundColor: t.color.surfaceMuted,
    },
    learnMore: {
      alignSelf: 'flex-start',
      paddingHorizontal: 0,
      minHeight: t.control.minimumTarget,
    },
    localActions: { gap: t.space.xs },
    contextChip: {
      minHeight: t.control.minimumTarget,
      alignSelf: 'flex-start',
      maxWidth: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      paddingHorizontal: t.space.sm,
      paddingVertical: t.space.xs,
      borderRadius: t.radius.control,
      backgroundColor: t.color.successSurface,
    },
    wrappingText: { flexShrink: 1 },
    composer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-end',
      gap: t.space.xs,
    },
    input: {
      flexBasis: 180,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      maxHeight: 130,
      textAlignVertical: 'top',
      backgroundColor: t.color.surface,
    },
    send: { minWidth: 72, minHeight: t.control.minimumTarget },
    pressed: { opacity: 0.72 },
  });
