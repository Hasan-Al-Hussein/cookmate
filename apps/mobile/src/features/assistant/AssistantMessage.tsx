import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { getRecipe } from '@cookmate/catalogue';
import type { CommandResult } from '@cookmate/contracts';
import type { Immutable, StoredConversationMessage } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { usePageStyles } from '../../components/Page';
import { useAssistant } from './useAssistant';
import { errorCopy, preferenceLabels } from './assistantCopy';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import { ProposalReview } from './ProposalReview';
import { ActionContinuationReview, continuationCommandLabel } from './ActionContinuationReview';
import { canOfferHistoricalTurnRetry, newRequestGuidance } from './turnRecovery';
import { AssistantRecipeReference } from './AssistantRecipeReference';

type DisplayedSlot = {
  slotId: string;
  result: Immutable<CommandResult> | { kind: 'not_executed' };
};

export function AssistantMessage({ message }: { message: Immutable<StoredConversationMessage> }) {
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();

  const { assistant, state } = useAssistant();
  const router = useRouter();
  const record = Object.values(state?.conversation?.intents ?? {}).find(
    (record) =>
      record.request.message.messageId === message.messageId ||
      record.acceptanceEnvelope.assistantMessageId === message.messageId,
  );
  const id = record?.intent.userIntentId;
  const turnError =
    message.role === 'user' && message.status === 'failed' && record?.response?.kind === 'error'
      ? record.response.error
      : undefined;
  const editGuidance = turnError ? newRequestGuidance(turnError) : undefined;
  const checked = id ? state?.actionOutcomes[id] : undefined;
  const continuationAttempt = id ? state?.continuationOutcomes?.[id] : undefined;
  const recovery = id
    ? ((state?.recovery.kind === 'ready' ? state.recovery.proofs[id] : undefined) ??
      state?.historyProofs?.[id])
    : undefined;
  const currentPlanProved =
    !!recovery &&
    !!record?.actionPlan?.slots.length &&
    recovery?.userIntentId === id &&
    recovery?.intentRevision === record.intent.revision &&
    recovery?.conversationId === state?.conversation?.header.conversationId &&
    recovery?.conversationGeneration === state?.conversation?.header.generation &&
    record.actionPlan.slots.every((slot) =>
      recovery.slots.some(
        (proof) =>
          proof.slotId === slot.slotId &&
          proof.operationId === slot.operationId &&
          proof.outcome !== 'unresolved',
      ),
    );
  const continuationNeedsCheck =
    continuationAttempt?.actionOutcome === null &&
    (!checked || checked.summary === 'invalid') &&
    !currentPlanProved;
  const storedResults =
    checked && checked.summary !== 'invalid' ? checked.results.slots : (record?.slotResults ?? []);
  const slotIds = new Set([
    ...storedResults.map((entry) => entry.slotId),
    ...(recovery?.slots.map((slot) => slot.slotId) ?? []),
  ]);
  const results = [...slotIds].flatMap<DisplayedSlot>((slotId) => {
    const proof = recovery?.slots.find((slot) => slot.slotId === slotId);
    const saved = storedResults.find((entry) => entry.slotId === slotId);
    if (proof?.outcome === 'receipt' && proof.receipt)
      return [{ slotId, result: { kind: 'receipt' as const, receipt: proof.receipt } }];
    if (proof?.outcome === 'not_executed')
      // Proven absence does not erase why the actual attempt failed.
      return saved?.result.kind === 'failed'
        ? [saved]
        : [{ slotId, result: { kind: 'not_executed' as const } }];
    if (proof?.outcome === 'unresolved')
      return [{ slotId, result: { kind: 'uncertain' as const, operationId: proof.operationId } }];
    return saved ? [saved] : [];
  });
  const hasReceipts =
    results.some(({ result }) => result.kind === 'receipt') ||
    continuationAttempt?.result.kind === 'receipt';
  const canReviewUnfinishedPlan =
    !!record?.actionPlan &&
    record.intent.phase !== 'cancelled' &&
    record.actionPlan.slots.some(
      (slot) => results.find((result) => result.slotId === slot.slotId)?.result.kind !== 'receipt',
    );
  const canReviewProposal =
    !!record &&
    record.response?.kind === 'proposal' &&
    !record.actionPlan &&
    !record.intent.slots.length &&
    (record.intent.phase === 'confirmation' || record.intent.phase === 'ready');
  const offeredProposal = useRef(false);
  const offeredContinuation = useRef(false);
  if (canReviewProposal) offeredProposal.current = true;
  if (canReviewUnfinishedPlan) offeredContinuation.current = true;
  const hasKnownUnfinishedPlan =
    canReviewUnfinishedPlan && (currentPlanProved || checked?.summary === 'partial');
  const hasUnknown =
    results.some(
      ({ result, slotId }) =>
        (result.kind === 'uncertain' ||
          (result.kind === 'failed' && result.error.retry === 'reconcile')) &&
        recovery?.slots.find((slot) => slot.slotId === slotId)?.outcome !== 'not_executed',
    ) ||
    (!!record?.actionPlan && results.length === 0) ||
    checked?.summary === 'invalid' ||
    continuationNeedsCheck ||
    !!(id && state?.historyProofErrors?.[id]);
  const sources =
    record?.response && record.response.kind !== 'error' ? record.response.sources : [];
  const displayedRecipeIds = new Set(message.referenceSets.flatMap((set) => set.recipeIds));
  return (
    <View style={styles.message}>
      <View
        style={[
          styles.bubble,
          message.role === 'user' ? styles.userBubble : styles.assistantBubble,
        ]}
      >
        <AppText role="label" color={message.role === 'assistant' ? 'assistant' : 'inkSecondary'}>
          {message.role === 'user' ? 'You' : 'CookMate'}
        </AppText>
        <AppText selectable>{message.text}</AppText>
      </View>
      {message.role === 'assistant' && id === state?.activeIntentId && state?.busy && (
        <Notice title="Checking or applying these changes…" />
      )}
      {message.role === 'assistant' && (
        <AppText role="support" color="inkSecondary">
          {hasUnknown
            ? hasReceipts
              ? 'Some changes are saved; other results still need checking.'
              : 'The outcome of these changes is not yet confirmed. Check the saved results below.'
            : hasReceipts
              ? hasKnownUnfinishedPlan
                ? 'Some changes are saved. Review the next unfinished change.'
                : 'Saved results for this request are shown below.'
              : 'No changes were applied by this reply.'}
        </AppText>
      )}
      {message.referenceSets.map((set) => (
        <View key={set.referenceSetId} style={pageStyles.section}>
          {set.recipeIds.map((recipeId, index) => (
            <AssistantRecipeReference
              key={`${set.referenceSetId}:${index}:${recipeId}`}
              recipeId={recipeId}
              index={index}
              onOpen={() => router.push({ pathname: '/recipe/[id]', params: { id: recipeId } })}
              onSource={() =>
                router.push({
                  pathname: '/recipe/[id]',
                  params: { id: recipeId, section: 'source' },
                })
              }
            />
          ))}
        </View>
      ))}
      {message.role === 'assistant' &&
        [...new Set(sources.map((source) => source.recipeId))]
          .filter((recipeId) => !displayedRecipeIds.has(recipeId))
          .map((recipeId) => (
            <ActionButton
              key={recipeId}
              label={`Source: ${getRecipe(recipeId)?.title ?? 'unavailable recipe'}`}
              variant="quiet"
              onPress={() =>
                router.push({
                  pathname: '/recipe/[id]',
                  params: { id: recipeId, section: 'source' },
                })
              }
            />
          ))}
      {message.role === 'user' && message.status !== 'complete' && (
        <Notice
          title={
            message.status === 'sending'
              ? 'Waiting for an answer…'
              : message.status === 'cancelled'
                ? 'Request stopped'
                : 'No completed answer saved'
          }
        >
          <AppText role="support">
            {message.status === 'sending'
              ? 'You can leave this screen without sending it again.'
              : 'This request has not been automatically repeated.'}
          </AppText>
          {turnError && <AppText role="support">{errorCopy(turnError)}</AppText>}
          {editGuidance && <AppText role="support">{editGuidance}</AppText>}
          {id && canOfferHistoricalTurnRetry(message, record) && (
            <ActionButton
              label="Retry this earlier request"
              variant="secondary"
              disabled={state?.busy}
              onPress={() => void assistant?.retryTurn(id)}
            />
          )}
        </Notice>
      )}
      {message.role === 'assistant' && record?.response?.kind === 'clarification' && (
        <AppText role="support">Reply below with the missing detail.</AppText>
      )}
      {message.role === 'assistant' && record && offeredProposal.current && (
        <ProposalReview record={record} available={canReviewProposal} />
      )}
      {message.role === 'assistant' && record?.intent.phase === 'cancelled' && (
        <AppText role="support">
          This earlier proposal is no longer active. Make a new request to review current choices.
        </AppText>
      )}
      {message.role === 'assistant' &&
        results.map(({ slotId, result }) => {
          const knownNotApplied =
            recovery?.slots.find((slot) => slot.slotId === slotId)?.outcome === 'not_executed';
          const slot = record?.actionPlan?.slots.find((slot) => slot.slotId === slotId);
          const label =
            slot?.payload.kind === 'savePreference'
              ? `Save ${preferenceLabels[slot.payload.type]}: ${slot.payload.explicitValue}`
              : slot?.payload.kind === 'setFavourite'
                ? `Save ${getRecipe(slot.payload.recipeId)?.title ?? 'recipe'}`
                : slot && 'recipeId' in slot.payload
                  ? `Plan ${getRecipe(slot.payload.recipeId)?.title ?? 'recipe'}`
                  : 'Requested change';
          return (
            <Notice
              key={slotId}
              title={`${label} · ${result.kind === 'not_executed' ? 'not applied' : result.kind === 'receipt' ? 'saved' : result.kind === 'uncertain' ? 'result unknown' : 'not completed'}`}
              tone={result.kind === 'receipt' ? 'neutral' : 'caution'}
            >
              {result.kind === 'not_executed' ? (
                <AppText role="support">
                  {record?.intent.phase === 'cancelled'
                    ? 'This unfinished change was stopped without a saved effect. Make a new request if you still want it.'
                    : 'The saved results confirm that this change has not been applied.'}
                </AppText>
              ) : result.kind === 'receipt' ? (
                <>
                  {result.receipt.outcome === 'no_op' && (
                    <AppText role="support">Already up to date.</AppText>
                  )}
                  {result.receipt.effects
                    .filter((effect) => effect.kind === 'plan')
                    .map((effect) => (
                      <AppText key={effect.entityId} role="support">
                        {getRecipe(effect.recipeId)?.title} ·{' '}
                        {formatPlanDate(effect.placement.actualDate)} ·{' '}
                        {mealLabel(effect.placement.mealKey)}
                      </AppText>
                    ))}
                </>
              ) : (
                <>
                  <AppText role="support">
                    {result.kind === 'failed'
                      ? `${knownNotApplied ? 'Earlier attempt: ' : ''}${errorCopy(result.error)}`
                      : 'Check the saved result before deciding what to do next. A completed change has not been undone.'}
                  </AppText>
                  {knownNotApplied && (
                    <AppText role="support">
                      Saved results confirm this change was not applied.
                    </AppText>
                  )}
                </>
              )}
            </Notice>
          );
        })}
      {message.role === 'assistant' && continuationAttempt && (
        <Notice
          title={`${continuationCommandLabel(continuationAttempt.command) ?? 'Reviewed change'} · ${continuationAttempt.result.kind === 'receipt' ? 'saved result' : continuationAttempt.result.kind === 'failed' ? 'attempt not completed' : 'attempt result was uncertain'}`}
          tone={continuationAttempt.result.kind === 'receipt' ? 'neutral' : 'caution'}
        >
          <AppText role="support">
            {continuationAttempt.result.kind === 'receipt'
              ? 'The saved result for this change is confirmed.'
              : continuationAttempt.result.kind === 'failed'
                ? errorCopy(continuationAttempt.result.error)
                : 'This attempt did not return a confirmed result. Check the current saved results before making another change.'}
          </AppText>
          {continuationNeedsCheck && (
            <AppText role="support">
              The remaining results for this request could not be confirmed. Use Check saved results
              to review them.
            </AppText>
          )}
        </Notice>
      )}
      {message.role === 'assistant' &&
        id &&
        record &&
        (record.actionPlan || record.intent.slots.length > 0) && (
          <ActionButton
            label="Check saved results"
            variant="quiet"
            disabled={state?.busy}
            onPress={() => void assistant?.runAction(id, () => assistant.core.reconcile(id))}
          />
        )}
      {message.role === 'assistant' && record && offeredContinuation.current && (
        <ActionContinuationReview record={record} available={canReviewUnfinishedPlan} />
      )}
      {message.role === 'assistant' &&
        id &&
        record &&
        (record.actionPlan || record.intent.slots.length > 0) && (
          <>
            <ActionButton
              label="Inspect plan"
              variant="quiet"
              onPress={() => router.navigate('/plan')}
            />
            <ActionButton
              label="Inspect saved preferences"
              variant="quiet"
              onPress={() =>
                router.push({ pathname: '/settings', params: { section: 'preferences' } })
              }
            />
          </>
        )}
      {id &&
        (message.role === 'assistant' || !record?.response) &&
        state?.actionError?.userIntentId === id && (
          <Notice title="This change needs a new review" tone="error">
            {errorCopy(state.actionError.error)}
          </Notice>
        )}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    message: { gap: t.space.sm },
    bubble: { padding: t.space.md, borderRadius: t.radius.card, gap: t.space.xs },
    userBubble: {
      backgroundColor: t.color.selection,
      alignSelf: 'flex-end',
      maxWidth: '94%',
      borderBottomRightRadius: t.space.xxs,
    },
    assistantBubble: {
      backgroundColor: t.color.successSurface,
      borderTopLeftRadius: t.space.xxs,
    },
  });
