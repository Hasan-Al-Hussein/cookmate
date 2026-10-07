import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useLayoutEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getRecipe } from '@cookmate/catalogue';
import type { AiProposal } from '@cookmate/contracts';
import type { CurrentActionState, Immutable } from '@cookmate/domain';
import type { ExplicitActionAuthority, ReplacementConfirmation } from '../../assistant-core';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { AppIcon } from '../../components/Icon';
import { focusTarget } from '../../components/focusTarget';
import { usePageStyles } from '../../components/Page';
import { useActionFocus } from '../../hooks/useActionFocus';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import { assistantError, repositoryValue, type IntentRecord } from './assistantRuntime';
import { errorCopy, preferenceLabels } from './assistantCopy';
import { useAssistant } from './useAssistant';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { PresenceModal, useModalAction } from '../../components/PresenceModal';

export function proposalLabel(proposal: Immutable<AiProposal>) {
  if (proposal.kind === 'savePreference')
    return `Remember ${preferenceLabels[proposal.type]}: ${proposal.explicitValue}`;
  const recipe = getRecipe(proposal.recipeId)?.title ?? 'Unavailable recipe';
  return proposal.kind === 'saveRecipe'
    ? `Save ${recipe} to Favourites`
    : `Plan ${recipe} · ${formatPlanDate(proposal.placement.actualDate)} · ${mealLabel(proposal.placement.mealKey)}`;
}
export function ProposalReview({
  record,
  available = true,
}: {
  record: IntentRecord;
  available?: boolean;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();

  const { assistant, state } = useAssistant();
  const { actions } = useWorkspace();
  const [review, setReview] = useState<{
    proposals: AiProposal[];
    replacements: ReplacementConfirmation[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const focus = useActionFocus();
  const heading = useRef<View>(null);
  const generation = state?.conversation?.header.generation;
  const connectionGeneration = state?.connection.generation;
  const reviewEpoch = useRef(0);
  useLayoutEffect(() => {
    setReview(null);
    reviewEpoch.current += 1;
    return () => {
      reviewEpoch.current += 1;
    };
  }, [
    available,
    record.intent.userIntentId,
    record.intent.revision,
    generation,
    connectionGeneration,
  ]);
  const proposals = record.response?.kind === 'proposal' ? record.response.proposals : [];
  async function openReview() {
    if (!available || !assistant || loading || state?.busy) return;
    const epoch = reviewEpoch.current;
    setLoading(true);
    setError(undefined);
    try {
      const current: Immutable<CurrentActionState> = repositoryValue(
        await assistant.persistence.readCurrentActionState(record.intent.userIntentId),
      );
      if (reviewEpoch.current !== epoch) return;
      const replacements: ReplacementConfirmation[] = [];
      for (const proposal of proposals) {
        if (proposal.kind !== 'addPlan' || proposal.expectedTarget.kind !== 'occupied') continue;
        const expected = proposal.expectedTarget;
        const meal = current.planOccurrences.find(
          (item) => item.occurrenceId === expected.occurrenceId,
        );
        if (!meal || meal.revision !== expected.expectedRevision) {
          setError('The proposed meal changed. Ask again to review its current state.');
          return;
        }
        replacements.push({
          occurrenceId: meal.occurrenceId,
          expectedRevision: meal.revision,
          expectedShoppingScopeRevision: current.shoppingScope.revision,
          currentRecipeId: meal.recipeId,
          replacementRecipeId: proposal.recipeId,
          includedInShopping: current.shoppingScope.occurrenceIds.includes(meal.occurrenceId),
          placement: { ...meal.placement },
        });
      }
      setReview({
        proposals: proposals.map((proposal) => JSON.parse(JSON.stringify(proposal)) as AiProposal),
        replacements,
      });
    } catch (error) {
      if (reviewEpoch.current === epoch) setError(errorCopy(assistantError(error)));
    } finally {
      setLoading(false);
    }
  }
  const close = useModalAction(available && !!review, () => setReview(null));
  const approve = useModalAction(available && !!review, () => {
    if (!assistant || !review || state?.busy || state?.readError || actions?.blocked) return;
    const authority: ExplicitActionAuthority = {
      source: 'explicit_user',
      proposals: review.proposals,
      replacementConfirmations: review.replacements,
    };
    setReview(null);
    void assistant.runAction(
      record.intent.userIntentId,
      async () => {
        await assistant.core.approve(record.intent.userIntentId, authority);
        return assistant.core.dispatch(record.intent.userIntentId);
      },
      true,
    );
  });
  return (
    <>
      {available && (
        <View style={styles.proposal}>
          <AppText role="label" color="assistant">
            Proposed changes
          </AppText>
          {proposals.map((proposal, index) => (
            <View key={index} style={styles.proposalRow}>
              <AppIcon
                name={proposal.kind === 'addPlan' ? 'calendar' : 'heart'}
                color={t.color.assistantText}
                size={20}
              />
              <AppText style={styles.proposalText} role="support">
                {proposalLabel(proposal)}
              </AppText>
            </View>
          ))}
          <ActionButton
            ref={focus.ref}
            label="Review proposed changes"
            busy={loading}
            disabled={state?.busy || !!state?.readError || !!actions?.blocked}
            onPress={() => void openReview()}
          />
          {error && (
            <Notice title="Couldn’t review these changes" tone="error">
              {error}
            </Notice>
          )}
        </View>
      )}
      <PresenceModal
        visible={available && !!review}
        accessibilityLabel="Review proposed changes"
        presentationStyle="pageSheet"
        onRequestClose={close}
        onDismiss={() => focus.restoreFocus()}
        onShow={() => {
          focusTarget(heading.current);
        }}
      >
        <SafeAreaView style={pageStyles.root}>
          <ScrollView contentContainerStyle={pageStyles.content}>
            <View ref={heading} accessible accessibilityRole="header">
              <AppText role="title">Review proposed changes</AppText>
            </View>
            {review?.proposals.map((proposal, index) => (
              <View key={index} style={styles.reviewItem}>
                <AppText role="label" color="brand">
                  Proposed change {index + 1}
                </AppText>
                <AppText>{proposalLabel(proposal)}</AppText>
              </View>
            ))}
            {review?.replacements.map((replacement) => (
              <Notice
                key={replacement.occurrenceId}
                title={`Replace ${getRecipe(replacement.currentRecipeId)?.title ?? 'current meal'}?`}
                tone="caution"
              >
                <AppText>
                  {getRecipe(replacement.replacementRecipeId)?.title} will take its place on{' '}
                  {formatPlanDate(replacement.placement.actualDate)} at{' '}
                  {mealLabel(replacement.placement.mealKey)}.
                </AppText>
                <AppText role="support">
                  {replacement.includedInShopping
                    ? 'This meal stays selected for shopping. Its new ingredients can reset changed purchase marks.'
                    : 'This meal stays outside the shopping selection.'}
                </AppText>
              </Notice>
            ))}
            <AppText role="support">
              These changes are saved only after the app confirms each result. Separate changes may
              finish separately.
            </AppText>
          </ScrollView>
          <View style={[pageStyles.content, styles.actions]}>
            <ActionButton label="Apply these changes" onPress={approve} />
            <ActionButton label="Keep current choices" variant="quiet" onPress={close} />
          </View>
        </SafeAreaView>
      </PresenceModal>
    </>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    proposal: {
      gap: t.space.sm,
      padding: t.space.md,
      backgroundColor: t.color.successSurface,
      borderRadius: t.radius.card,
    },
    proposalRow: { flexDirection: 'row', alignItems: 'flex-start', gap: t.space.sm },
    proposalText: { flex: 1 },
    reviewItem: {
      gap: t.space.xs,
      backgroundColor: t.color.surface,
      padding: t.space.md,
      borderRadius: t.radius.card,
    },
    actions: {
      gap: t.space.xs,
      backgroundColor: t.color.surface,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
    },
  });
