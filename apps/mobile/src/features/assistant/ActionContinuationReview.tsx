import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useLayoutEffect, useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getRecipe } from '@cookmate/catalogue';
import type { LocalCommand } from '@cookmate/contracts';
import type { Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { usePageStyles } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { useActionFocus } from '../../hooks/useActionFocus';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { formatPlanDate, mealLabel } from '../workspace/runtimeClock';
import { errorCopy, preferenceLabels } from './assistantCopy';
import type { IntentRecord } from './assistantRuntime';
import { useAssistant } from './useAssistant';
import { PresenceModal, useModalAction } from '../../components/PresenceModal';

export function continuationCommandLabel(command: Immutable<LocalCommand>): string | null {
  const payload = command.command;
  switch (payload.kind) {
    case 'setFavourite':
      return `${payload.saved ? 'Save' : 'Remove'} ${getRecipe(payload.recipeId)?.title ?? 'Unavailable recipe'} ${payload.saved ? 'to' : 'from'} Favourites`;
    case 'addPlan':
      return `Plan ${getRecipe(payload.recipeId)?.title ?? 'Unavailable recipe'} · ${formatPlanDate(payload.placement.actualDate)} · ${mealLabel(payload.placement.mealKey)}`;
    case 'replacePlanRecipe':
      return `Replace planned meal with ${getRecipe(payload.recipeId)?.title ?? 'Unavailable recipe'} · ${formatPlanDate(payload.placement.actualDate)} · ${mealLabel(payload.placement.mealKey)}`;
    case 'savePreference':
      return `Save ${preferenceLabels[payload.type]}: ${payload.explicitValue}`;
    default:
      return null;
  }
}

export function ActionContinuationReview({
  record,
  available = true,
}: {
  record: IntentRecord;
  available?: boolean;
}) {
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();

  const { assistant, state } = useAssistant();
  const { actions } = useWorkspace();
  const focus = useActionFocus();
  const heading = useRef<View>(null);
  const ownedRequestId = useRef<number | undefined>(undefined);
  const userIntentId = record.intent.userIntentId;
  const revision = record.intent.revision;
  const conversationId = state?.conversation?.header.conversationId;
  const generation = state?.conversation?.header.generation;
  const connectionGeneration = state?.connection.generation;

  useLayoutEffect(
    () => () => {
      const requestId = ownedRequestId.current;
      ownedRequestId.current = undefined;
      if (
        requestId !== undefined &&
        assistant?.getSnapshot().continuationReview?.requestId === requestId
      )
        assistant.dismissContinuationReview(requestId);
    },
    [
      assistant,
      available,
      userIntentId,
      revision,
      conversationId,
      generation,
      connectionGeneration,
    ],
  );

  const central = state?.continuationReview;
  const ticket =
    available &&
    central?.userIntentId === userIntentId &&
    central.requestId === ownedRequestId.current
      ? central
      : undefined;
  const review = ticket?.kind === 'ready' ? ticket.review : undefined;
  const payload = review?.slot.command.command;
  const label = review ? continuationCommandLabel(review.slot.command) : null;
  const currentMeal =
    payload?.kind === 'replacePlanRecipe'
      ? review?.state.planOccurrences.find((meal) => meal.occurrenceId === payload.occurrenceId)
      : undefined;
  const describable = !!label && (payload?.kind !== 'replacePlanRecipe' || !!currentMeal);
  const readBlocked = !assistant || !!state?.busy || !!state?.connectionBusy || !!state?.readError;
  const mutationsHeld = !!actions?.blocked || !!assistant?.mutationsHeld;
  const applyBlocked = readBlocked || mutationsHeld || !describable;
  const checkResultsBlocked = !assistant || !!state?.busy || !!state?.connectionBusy;

  function openReview() {
    if (!available || !assistant) return;
    const current = assistant.getSnapshot();
    if (current.busy || current.connectionBusy || current.readError) return;
    const previousId = current.continuationReview?.requestId;
    void assistant.reviewContinuation(userIntentId, revision);
    const opened = assistant.getSnapshot().continuationReview;
    if (opened?.userIntentId === userIntentId && opened.requestId !== previousId)
      ownedRequestId.current = opened.requestId;
  }

  const dismiss = useModalAction(available && !!ticket, () => {
    const requestId = ownedRequestId.current;
    ownedRequestId.current = undefined;
    if (
      requestId !== undefined &&
      assistant?.getSnapshot().continuationReview?.requestId === requestId
    )
      assistant.dismissContinuationReview(requestId);
  });

  const confirm = useModalAction(available && !!ticket, () => {
    if (!assistant || !review || !ticket || applyBlocked) return;
    const current = assistant.getSnapshot();
    if (
      current.busy ||
      current.connectionBusy ||
      current.readError ||
      actions?.blocked ||
      assistant.mutationsHeld ||
      current.continuationReview?.kind !== 'ready' ||
      current.continuationReview.requestId !== ticket.requestId ||
      current.continuationReview.review !== review
    )
      return;
    void assistant.confirmContinuation(review);
    // A normal confirmation claims the central ticket without revoking its authority.
    if (assistant.getSnapshot().continuationReview?.requestId !== ticket.requestId)
      ownedRequestId.current = undefined;
  });

  const checkSavedResults = useModalAction(available && !!ticket, () => {
    if (!assistant) return;
    const current = assistant.getSnapshot();
    const displayed = current.continuationReview;
    if (
      current.busy ||
      current.connectionBusy ||
      !displayed ||
      displayed.requestId !== ownedRequestId.current ||
      displayed.userIntentId !== userIntentId ||
      (displayed.kind !== 'unavailable' && displayed.kind !== 'failed')
    )
      return;
    dismiss();
    const afterDismiss = assistant.getSnapshot();
    if (afterDismiss.busy || afterDismiss.connectionBusy || afterDismiss.continuationReview) return;
    void assistant.runAction(userIntentId, () => assistant.core.reconcile(userIntentId));
  });

  return (
    <>
      {available && (
        <View style={pageStyles.section}>
          <ActionButton
            ref={focus.ref}
            label="Review next unfinished change"
            variant="secondary"
            busy={ticket?.kind === 'loading'}
            disabled={readBlocked || !!ticket}
            onPress={openReview}
          />
        </View>
      )}
      <PresenceModal
        visible={!!ticket}
        accessibilityLabel="Review next unfinished change"
        presentationStyle="pageSheet"
        onRequestClose={dismiss}
        onDismiss={() => focus.restoreFocus()}
        onShow={() => {
          focusTarget(heading.current);
        }}
      >
        <SafeAreaView style={pageStyles.root}>
          <ScrollView contentContainerStyle={pageStyles.content}>
            <View ref={heading} accessible accessibilityRole="header">
              <AppText role="title">Review next unfinished change</AppText>
            </View>
            {ticket?.kind === 'loading' && (
              <Notice title="Checking the next unfinished change…">
                Your saved results and current choices are being checked.
              </Notice>
            )}
            {ticket?.kind === 'unavailable' && (
              <Notice title="No change available to review">
                This request has no change available to confirm here. Check its saved results; this
                does not confirm that every change finished.
              </Notice>
            )}
            {ticket?.kind === 'failed' && (
              <Notice title="Couldn’t review this change" tone="error">
                {errorCopy(ticket.error)}
              </Notice>
            )}
            {review && (
              <>
                {describable ? (
                  <>
                    <View style={styles.reviewItem}>
                      <AppText role="label" color="brand">
                        Proposed change
                      </AppText>
                      <AppText role="bodyStrong">{label}</AppText>
                    </View>
                    {payload?.kind === 'replacePlanRecipe' && currentMeal && (
                      <Notice
                        title={`Replace ${getRecipe(currentMeal.recipeId)?.title ?? 'current meal'}?`}
                        tone="caution"
                      >
                        <AppText>
                          {getRecipe(payload.recipeId)?.title ?? 'The reviewed recipe'} will take
                          its place on {formatPlanDate(payload.placement.actualDate)} at{' '}
                          {mealLabel(payload.placement.mealKey)}.
                        </AppText>
                        <AppText role="support">
                          {review.state.shoppingScope.occurrenceIds.includes(
                            currentMeal.occurrenceId,
                          )
                            ? 'This meal stays selected for shopping. Its new ingredients can reset changed purchase marks.'
                            : 'This meal stays outside the shopping selection.'}
                        </AppText>
                      </Notice>
                    )}
                    <AppText role="support">
                      Apply confirms only this change. Any later unfinished change needs a separate
                      review.
                    </AppText>
                  </>
                ) : (
                  <Notice title="This change needs a new review" tone="caution">
                    Its current details cannot be confirmed here. Check the recipe, plan or
                    preferences controls before making a new request.
                  </Notice>
                )}
                {review.prefixReceipts.length > 0 && (
                  <Notice title="Earlier results already confirmed">
                    <AppText role="support">
                      {review.prefixReceipts.length} earlier{' '}
                      {review.prefixReceipts.length === 1 ? 'result is' : 'results are'} already
                      recorded. Applying this change does not repeat them.
                    </AppText>
                    {review.prefixReceipts.flatMap(({ slotId, receipt }) =>
                      receipt.effects
                        .filter((effect) => effect.kind === 'favourite')
                        .map((effect) => (
                          <AppText key={`${slotId}:${effect.entityId}`} role="support">
                            {getRecipe(effect.entityId)?.title ?? 'Recipe'} ·{' '}
                            {effect.saved ? 'saved in Favourites' : 'removed from Favourites'}
                          </AppText>
                        )),
                    )}
                  </Notice>
                )}
                {mutationsHeld && (
                  <Notice title="Applying changes is paused" tone="caution">
                    Check pending saved results or wait for the current change to finish before
                    applying this change.
                  </Notice>
                )}
              </>
            )}
            <View style={styles.actions}>
              {(ticket?.kind === 'unavailable' || ticket?.kind === 'failed') && (
                <ActionButton
                  label="Check saved results"
                  disabled={checkResultsBlocked}
                  onPress={checkSavedResults}
                />
              )}
              {review && describable && (
                <ActionButton label="Apply this change" disabled={applyBlocked} onPress={confirm} />
              )}
              <ActionButton label="Keep current choices" variant="quiet" onPress={dismiss} />
            </View>
          </ScrollView>
        </SafeAreaView>
      </PresenceModal>
    </>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    reviewItem: {
      gap: t.space.xs,
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
    },
    actions: {
      gap: t.space.xs,
      paddingTop: t.space.md,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
    },
  });
