import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useId, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { PreferenceType, SavedPreference } from '@cookmate/contracts';
import { normalizeSearchText, type Immutable } from '@cookmate/domain';
import { ActionButton, Notice, useControlStyles } from '../../components/Controls';
import { controlStateProps } from '../../components/controlStateProps';
import { confirmAction } from '../../components/confirmAction';
import { focusTarget } from '../../components/focusTarget';
import { fieldHelpProps } from '../../components/fieldHelpProps';
import { PresenceModal, useModalAction } from '../../components/PresenceModal';
import { AppText } from '../../components/Typography';
import { usePageStyles } from '../../components/Page';
import { QueryFeedback } from '../workspace/WorkspaceFeedback';
import { useWorkspace, useWorkspaceQuery } from '../workspace/WorkspaceProvider';
import { preferenceLabels } from '../assistant/assistantCopy';
import { useActionFocus } from '../../hooks/useActionFocus';
import { recipeSearch } from '../discover/DiscoverState';

const preferencePrompts: Record<PreferenceType, { question: string; help: string }> = {
  cuisine: {
    question: 'Which cuisine do you enjoy?',
    help: 'Choose a source label below or write your own.',
  },
  ingredient_like: {
    question: 'Which ingredient do you enjoy?',
    help: 'Choose a source label below or write your own.',
  },
  ingredient_avoid: {
    question: 'Which ingredient would you rather avoid?',
    help: 'Avoidance is a preference, not an allergy-safety check. Verify every recipe.',
  },
  dietary_style: {
    question: 'How would you describe your eating style?',
    help: 'Use your own words. Recipe categories are not verified dietary classifications.',
  },
};

interface Draft {
  preferenceId?: string;
  type: PreferenceType;
  value: string;
  initialType: PreferenceType;
  initialValue: string;
  revision: number;
}
export function Preferences({ showTitle = true }: { showTitle?: boolean }) {
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();
  const controlStyles = useControlStyles();

  const query = useWorkspaceQuery('preferences', ['preferences'], (services) =>
    services.queries.readPreferences(),
  );
  const { actions, actionState } = useWorkspace();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [submitted, setSubmitted] = useState<Draft | null>(null);
  const heading = useRef<View>(null);
  const focus = useActionFocus();
  const cuisineFocus = useActionFocus();
  const avoidFocus = useActionFocus();
  const returnFocus = useRef(focus.restoreFocus);
  const snapshot = query.state.kind === 'ready' ? query.state.value : query.state.previous;
  const ready = query.state.kind === 'ready';
  const changed =
    !!draft && (draft.value !== draft.initialValue || draft.type !== draft.initialType);
  const stale = !!draft && !!snapshot && snapshot.revision !== draft.revision;
  const length = [...(draft?.value ?? '')].length;
  const valueHelpId = useId();
  const hasValue = !!draft?.value.trim();
  const invalidValue = !hasValue || length > 256;
  const valueHelp = `${length} / 256 characters. ${!hasValue ? 'Enter at least one non-space character. ' : ''}${length > 256 ? 'Use 256 characters or fewer. ' : ''}This value is saved only when you select Save preference.`;
  const sourceChoices =
    draft?.type === 'cuisine'
      ? recipeSearch.facets.cuisines
      : draft?.type === 'ingredient_like' || draft?.type === 'ingredient_avoid'
        ? recipeSearch.facets.ingredients
        : [];
  const choiceQuery = normalizeSearchText(draft?.value ?? '');
  const matchingChoices = sourceChoices.filter((value) =>
    normalizeSearchText(value).includes(choiceQuery),
  );
  useEffect(() => {
    if (
      !submitted ||
      actionState.kind !== 'receipt' ||
      actionState.review.input.kind !== 'savePreference'
    )
      return;
    const input = actionState.review.input;
    if (
      input.type === submitted.type &&
      input.explicitValue === submitted.value &&
      input.preferenceId === submitted.preferenceId
    ) {
      setDraft(null);
      setSubmitted(null);
    }
  }, [actionState, submitted]);
  function edit(
    preference?: Immutable<SavedPreference>,
    restoreFocus = focus.restoreFocus,
    initialType: PreferenceType = 'cuisine',
  ) {
    if (!snapshot) return;
    returnFocus.current = restoreFocus;
    setSubmitted(null);
    setDraft({
      ...(preference ? { preferenceId: preference.preferenceId } : {}),
      type: preference?.type ?? initialType,
      initialType: preference?.type ?? initialType,
      value: preference?.value ?? '',
      initialValue: preference?.value ?? '',
      revision: snapshot.revision,
    });
  }
  const close = useModalAction(!!draft, () => {
    if (submitted && ['preparing', 'applying', 'uncertain'].includes(actionState.kind)) {
      confirmAction({
        title: 'Close while the result is pending?',
        message:
          'Closing only leaves this editor. The preference may already be saved or may still finish saving. Check its result in Settings.',
        cancelLabel: 'Keep editor open',
        confirmLabel: 'Close editor',
        onConfirm: () => setDraft(null),
      });
      return;
    }
    if (changed)
      confirmAction({
        title: 'Discard preference draft?',
        message: 'Your saved preferences will stay unchanged.',
        cancelLabel: 'Keep editing',
        confirmLabel: 'Discard draft',
        destructive: true,
        onConfirm: () => setDraft(null),
      });
    else setDraft(null);
  });
  const save = useModalAction(!!draft, () => {
    if (!draft || invalidValue || stale || !ready || !actions || actions.blocked) return;
    setSubmitted(draft);
    void actions.begin(
      {
        kind: 'savePreference',
        ...(draft.preferenceId ? { preferenceId: draft.preferenceId } : {}),
        type: draft.type,
        explicitValue: draft.value,
      },
      { observedPreferenceRevision: draft.revision },
    );
  });
  return (
    <>
      {showTitle && (
        <AppText role="section" accessibilityRole="header">
          Saved preferences
        </AppText>
      )}
      <QueryFeedback state={query.state} retry={query.retry} noun="saved preferences" />
      {ready && snapshot?.items.length === 0 && (
        <View style={styles.empty}>
          <AppText role="section">Make it more your taste.</AppText>
          <AppText color="inkSecondary">
            Remember a cuisine you enjoy or an ingredient you prefer to avoid. Nothing is saved
            until you choose it.
          </AppText>
          <View style={styles.suggestions}>
            <ActionButton
              ref={cuisineFocus.ref}
              label="A cuisine I enjoy"
              variant="secondary"
              disabled={!actions || actions.blocked}
              onPress={() => edit(undefined, cuisineFocus.restoreFocus, 'cuisine')}
            />
            <ActionButton
              ref={avoidFocus.ref}
              label="An ingredient to avoid"
              variant="secondary"
              disabled={!actions || actions.blocked}
              onPress={() => edit(undefined, avoidFocus.restoreFocus, 'ingredient_avoid')}
            />
          </View>
        </View>
      )}
      <AppText role="support" color="inkSecondary">
        Only preferences you deliberately save belong here. Temporary requests stay in the
        conversation. Preferences are not allergy or dietary safety guarantees.
      </AppText>
      {snapshot?.items.map((preference) => (
        <PreferenceRow
          key={preference.preferenceId}
          preference={preference}
          revision={snapshot.revision}
          ready={ready}
          edit={edit}
        />
      ))}
      <ActionButton
        ref={focus.ref}
        label="Add a saved preference"
        disabled={!ready || !actions || actions.blocked}
        onPress={() => edit()}
      />
      {snapshot && snapshot.items.length > 0 && (
        <ActionButton
          label="Review clearing saved preferences"
          variant="quiet"
          disabled={!ready || !actions || actions.blocked}
          onPress={() =>
            void actions?.begin(
              { kind: 'clearPreferences' },
              {
                confirm: true,
                observedPreferenceRevision: snapshot.revision,
                restoreFocus: focus.restoreFocus,
              },
            )
          }
        />
      )}
      <PresenceModal
        visible={!!draft}
        preview
        accessibilityLabel={draft?.preferenceId ? 'Edit preference' : 'Save a preference'}
        presentationStyle="pageSheet"
        onRequestClose={close}
        onDismiss={() => returnFocus.current()}
        onShow={() => {
          focusTarget(heading.current);
        }}
      >
        <SafeAreaView style={pageStyles.root}>
          <KeyboardAvoidingView behavior="padding" style={pageStyles.root}>
            <ScrollView
              contentContainerStyle={pageStyles.content}
              keyboardShouldPersistTaps="handled"
            >
              <View
                ref={heading}
                accessible
                accessibilityRole="header"
                style={styles.editorHeading}
              >
                <AppText role="title">
                  {draft?.preferenceId ? 'Edit preference' : 'Save a preference'}
                </AppText>
                <AppText role="support" color="inkSecondary">
                  A little more about what you enjoy.
                </AppText>
              </View>
              {draft && (
                <>
                  <View style={styles.types}>
                    {(Object.entries(preferenceLabels) as [PreferenceType, string][]).map(
                      ([type, label]) => (
                        <Pressable
                          key={type}
                          accessibilityRole="radio"
                          accessibilityLabel={label}
                          {...controlStateProps(
                            {
                              checked: draft.type === type,
                              disabled: !actions || actions.blocked,
                            },
                            'radio',
                          )}
                          disabled={!actions || actions.blocked}
                          onPress={() =>
                            setDraft((current) => (current ? { ...current, type } : null))
                          }
                          style={({ pressed }) => [
                            styles.typeChoice,
                            draft.type === type && styles.selectedType,
                            pressed && styles.pressed,
                          ]}
                        >
                          <AppText
                            role="control"
                            color={draft.type === type ? 'brand' : 'inkSecondary'}
                          >
                            {label}
                          </AppText>
                        </Pressable>
                      ),
                    )}
                  </View>
                  <View style={styles.prompt}>
                    <AppText role="section">{preferencePrompts[draft.type].question}</AppText>
                    <AppText role="support" color="inkSecondary">
                      {preferencePrompts[draft.type].help}
                    </AppText>
                  </View>
                  <TextInput
                    accessibilityLabel="Preference value"
                    placeholder={preferenceLabels[draft.type]}
                    placeholderTextColor={controlStyles.field.color}
                    {...fieldHelpProps({
                      id: valueHelpId,
                      text: valueHelp,
                      invalid: invalidValue,
                    })}
                    value={draft.value}
                    onChangeText={(value) =>
                      setDraft((current) => (current ? { ...current, value } : null))
                    }
                    multiline
                    style={[controlStyles.field, styles.valueField]}
                    editable={!actions?.blocked}
                  />
                  <AppText role="support" nativeID={valueHelpId} color="inkSecondary">
                    {valueHelp}
                  </AppText>
                  {sourceChoices.length > 0 && (
                    <View style={styles.prompt}>
                      <AppText role="bodyStrong">From the recipe collection</AppText>
                      <AppText role="support" color="inkSecondary">
                        {matchingChoices.length
                          ? 'Type above to narrow these source labels. Choosing one fills your draft only.'
                          : 'No matching source label. You can save your own wording.'}
                      </AppText>
                      <View style={styles.suggestions}>
                        {matchingChoices.slice(0, 6).map((value) => (
                          <ActionButton
                            key={value}
                            label={value}
                            accessibilityLabel={`Use ${value}`}
                            variant="secondary"
                            disabled={!actions || actions.blocked}
                            onPress={() =>
                              setDraft((current) => (current ? { ...current, value } : null))
                            }
                          />
                        ))}
                      </View>
                    </View>
                  )}
                  {stale && (
                    <Notice title="Saved preferences changed" tone="caution">
                      <AppText>
                        Keep your draft for reference, or explicitly replace it with the latest
                        saved value.
                      </AppText>
                      <ActionButton
                        label="Replace draft with current saved value"
                        variant="secondary"
                        onPress={() =>
                          edit(
                            snapshot?.items.find(
                              (item) => item.preferenceId === draft.preferenceId,
                            ),
                          )
                        }
                      />
                    </Notice>
                  )}
                  {actionState.kind === 'failed' && actionState.input.kind === 'savePreference' && (
                    <Notice title="Preference was not saved" tone="error">
                      Your draft is still here. Check the value and the current saved preferences
                      before trying again.
                    </Notice>
                  )}
                  {actionState.kind === 'uncertain' && (
                    <Notice title="The saved result needs checking">
                      Close this editor to check the saved result in Settings. Closing does not undo
                      a completed save.
                    </Notice>
                  )}
                </>
              )}
            </ScrollView>
            <View style={[pageStyles.content, styles.editorActions]}>
              <ActionButton
                label="Save preference"
                disabled={invalidValue || stale || !ready || !actions || actions.blocked}
                onPress={save}
              />
              <ActionButton
                label={actions?.blocked ? 'Close editor' : 'Cancel'}
                variant="quiet"
                onPress={close}
              />
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </PresenceModal>
    </>
  );
}

function PreferenceRow({
  preference,
  revision,
  ready,
  edit,
}: {
  preference: Immutable<SavedPreference>;
  revision: number;
  ready: boolean;
  edit(
    preference: Immutable<SavedPreference>,
    restoreFocus: ReturnType<typeof useActionFocus>['restoreFocus'],
  ): void;
}) {
  const styles = useThemedStyles(createStyles);

  const { actions } = useWorkspace();
  const editFocus = useActionFocus();
  const removeFocus = useActionFocus();
  return (
    <View style={styles.preference}>
      <AppText role="label" color="brand">
        {preferenceLabels[preference.type]}
      </AppText>
      <AppText>{preference.value}</AppText>
      <View style={styles.rowActions}>
        <ActionButton
          ref={editFocus.ref}
          label="Edit"
          accessibilityLabel={`Edit ${preferenceLabels[preference.type]}: ${preference.value}`}
          variant="quiet"
          disabled={!ready || !actions || actions.blocked}
          onPress={() => edit(preference, editFocus.restoreFocus)}
        />
        <ActionButton
          ref={removeFocus.ref}
          label="Remove"
          accessibilityLabel={`Remove ${preferenceLabels[preference.type]}: ${preference.value}`}
          variant="quiet"
          disabled={!ready || !actions || actions.blocked}
          onPress={() =>
            void actions?.begin(
              { kind: 'removePreference', preferenceId: preference.preferenceId },
              {
                confirm: true,
                observedPreferenceRevision: revision,
                restoreFocus: removeFocus.restoreFocus,
                restoreAfterCommitRemoval: true,
              },
            )
          }
        />
      </View>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    preference: {
      gap: t.space.xs,
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
    },
    rowActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.space.xs,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
    },
    empty: {
      padding: t.space.gutter,
      gap: t.space.sm,
      borderRadius: t.radius.card,
      backgroundColor: t.color.surface,
    },
    editorHeading: { gap: t.space.xs },
    prompt: { gap: t.space.xs },
    suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    types: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    typeChoice: {
      flexBasis: '45%',
      flexGrow: 1,
      minHeight: t.control.minimumTarget,
      padding: t.space.sm,
      borderRadius: t.radius.control,
      borderWidth: 1,
      borderColor: t.color.divider,
      backgroundColor: t.color.surface,
      justifyContent: 'center',
    },
    selectedType: { borderColor: t.color.brand, backgroundColor: t.color.selection },
    pressed: { opacity: 0.7 },
    valueField: { minHeight: 80, textAlignVertical: 'top' },
    editorActions: {
      backgroundColor: t.color.surface,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      gap: t.space.xs,
    },
  });
