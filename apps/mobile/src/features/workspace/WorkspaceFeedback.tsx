import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getRecipe } from '@cookmate/catalogue';
import type { OperationReceipt, PlanOccurrence } from '@cookmate/contracts';
import type { DirectActionReview, Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { usePageStyles } from '../../components/Page';
import { PresenceModal, useModalAction } from '../../components/PresenceModal';
import { useWorkspace, type QueryState } from './WorkspaceProvider';
import { formatPlanDate, mealLabel } from './runtimeClock';
import { useActionFocus } from '../../hooks/useActionFocus';
import { RecoveryFeedback } from './RecoveryFeedback';
import { preferenceLabels } from '../assistant/assistantCopy';
import { useAssistant } from '../assistant/useAssistant';
import { AssistantRecoveryFeedback } from '../assistant/AssistantRecoveryFeedback';
import { useDelayedPending } from '../../components/useDelayedPending';
import { ReceiptMotion } from '../../components/ReceiptMotion';
import { AnimatedDisclosure } from '../../components/AnimatedDisclosure';
import { useRouter } from 'expo-router';
import { useOrdinaryWorkspaceActions } from '../content/useOrdinaryWorkspace';
import { useOptionalOrdinaryContentWorkspace } from '../content/OrdinaryContentWorkspaceProvider';

export function reviewActionLabel(review: Immutable<DirectActionReview>): string {
  const facts = review.consequences;
  if (facts.kind === 'shopping_selection') return 'Update shopping list';
  if (facts.kind === 'conversation_clear') return 'Clear conversation';
  if (review.input.kind === 'clearPreferences') return 'Clear saved preferences';
  if (facts.kind === 'plan') {
    if (!facts.resultPlacement)
      return facts.source
        ? `Remove ${mealLabel(facts.source.placement.mealKey).toLowerCase()}`
        : 'Remove meal';
    const meal = mealLabel(facts.resultPlacement.mealKey).toLowerCase();
    if (facts.destination && facts.destination.occurrenceId !== facts.source?.occurrenceId)
      return `Replace ${meal}`;
    if (
      facts.source &&
      (facts.source.placement.actualDate !== facts.resultPlacement.actualDate ||
        facts.source.placement.mealKey !== facts.resultPlacement.mealKey)
    )
      return `Move to ${meal}`;
    return `${facts.source ? 'Update' : 'Add'} ${meal}`;
  }
  if (facts.kind === 'purchase') return facts.purchased ? 'Mark purchased' : 'Mark still needed';
  if (facts.kind === 'favourite') return facts.saved ? 'Save recipe' : 'Remove favourite';
  return 'Confirm change';
}

function ShoppingSelectionConsequences({ review }: { review: Immutable<DirectActionReview> }) {
  const { mode } = useOrdinaryWorkspaceActions();
  const pageStyles = usePageStyles();
  const [expanded, setExpanded] = useState(false);
  const [groupsExpanded, setGroupsExpanded] = useState(false);
  const facts = review.consequences;
  if (facts.kind !== 'shopping_selection') return null;
  if (!facts.shoppingEffects)
    return (
      <Notice title="Review the current shopping list again" tone="caution">
        Cancel this earlier review and open a new one to check the ingredient changes. Nothing has
        been changed.
      </Notice>
    );
  const effects = facts.shoppingEffects;
  const affected = [
    ...effects.added.map((group) => ({ group, label: 'Added' })),
    ...effects.removed.map((group) => ({ group, label: 'Removed' })),
    ...effects.demandChanged.map((group) => ({ group, label: 'Changed' })),
  ];
  const before = new Set(facts.before.occurrenceIds);
  const after = new Set(facts.afterOccurrenceIds);
  const added = [...after].filter((id) => !before.has(id)).length;
  const removed = [...before].filter((id) => !after.has(id)).length;
  const unchanged = [...after].filter((id) => before.has(id)).length;
  return (
    <View style={pageStyles.section}>
      <AppText role="bodyStrong">
        {added} added · {removed} removed · {unchanged} unchanged
      </AppText>
      <AppText>
        {after.size
          ? `${after.size} dated meal${after.size === 1 ? '' : 's'} will supply your shopping list.`
          : 'Remove all meals from the shopping list. Your meal plan stays saved.'}
      </AppText>
      {mode === 'bundled' && (
        <AppText role="support">Your manually added items stay separate and are kept.</AppText>
      )}
      <AppText role="section">Shopping ingredients</AppText>
      <AppText role="bodyStrong">
        {effects.added.length} added · {effects.removed.length} removed ·{' '}
        {effects.demandChanged.length} changed
      </AppText>
      <AppText role="support">{effects.unchanged.length} unchanged ingredient groups</AppText>
      {!affected.length && (
        <AppText>Ingredient quantities and purchase marks stay as they are.</AppText>
      )}
      {!!effects.checkedMarksRequiringReview && (
        <Notice title="Check changed ingredients again" tone="caution">
          {effects.checkedMarksRequiringReview} purchased ingredient group
          {effects.checkedMarksRequiringReview === 1 ? '' : 's'} will become unchecked because the
          required ingredients changed.
        </Notice>
      )}
      {!!effects.checkedMarksRemoved && (
        <AppText role="support">
          {effects.checkedMarksRemoved} purchased ingredient group
          {effects.checkedMarksRemoved === 1 ? '' : 's'} will leave this list. If added again, they
          will be unchecked and need checking again.
        </AppText>
      )}
      {!!affected.length && (
        <ActionButton
          label={groupsExpanded ? 'Hide ingredient changes' : 'Review ingredient changes'}
          variant="secondary"
          accessibilityState={{ expanded: groupsExpanded }}
          onPress={() => setGroupsExpanded((value) => !value)}
        />
      )}
      <AnimatedDisclosure expanded={groupsExpanded}>
        {groupsExpanded &&
          affected.map(({ group, label }) => (
            <View key={group.groupKey} style={pageStyles.section}>
              <AppText role="bodyStrong">
                {group.displayName} · {label}
              </AppText>
              {group.before && (
                <AppText role="support">Before: {group.before.quantityLabel}</AppText>
              )}
              {group.after && <AppText role="support">After: {group.after.quantityLabel}</AppText>}
              {label === 'Changed' &&
                group.before?.quantityLabel === group.after?.quantityLabel && (
                  <AppText role="support">
                    The selected meal contributions changed even though the displayed amount is the
                    same.
                  </AppText>
                )}
              {group.before?.purchased && !group.after && (
                <AppText role="support">
                  Previously purchased. If added again, this will be unchecked.
                </AppText>
              )}
              {group.before?.purchased && group.after && !group.after.purchased && (
                <AppText role="support">
                  Purchased mark will reset. Check this ingredient again.
                </AppText>
              )}
              {group.after?.changed && !group.before?.purchased && (
                <AppText role="support">
                  Review this changed demand before marking it purchased.
                </AppText>
              )}
            </View>
          ))}
      </AnimatedDisclosure>
      {!!facts.afterOccurrences.length && (
        <ActionButton
          label={expanded ? 'Hide dated meals' : 'Review dated meals'}
          variant="secondary"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
        />
      )}
      <AnimatedDisclosure expanded={expanded}>
        {expanded &&
          facts.afterOccurrences.map((meal) => (
            <AppText key={meal.occurrenceId}>{occurrenceLabel(meal, mode)}</AppText>
          ))}
      </AnimatedDisclosure>
    </View>
  );
}

export function occurrenceLabel(
  occurrence: Immutable<PlanOccurrence>,
  mode: 'bundled' | 'content' = 'bundled',
) {
  return `${mode === 'content' ? `Recipe ${occurrence.recipeId}` : (getRecipe(occurrence.recipeId)?.title ?? 'Unavailable recipe')} · ${formatPlanDate(occurrence.placement.actualDate)} · ${mealLabel(occurrence.placement.mealKey)}`;
}
export function receiptMessage(receipt: Immutable<OperationReceipt>) {
  if (receipt.outcome === 'no_op') return 'Already up to date. No change was needed.';
  return Platform.OS === 'web' ? 'Change saved in this browser.' : 'Change saved on this iPhone.';
}
export function QueryFeedback({
  state,
  retry,
  noun,
}: {
  state: QueryState<unknown>;
  retry(): void;
  noun: string;
}) {
  const showLoading = useDelayedPending(state.kind === 'loading');
  if (state.kind === 'ready') return null;
  if (state.kind === 'loading' && state.previous === undefined && !showLoading)
    return (
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`Loading ${noun}`}
        accessibilityState={{ busy: true }}
      />
    );
  return (
    <Notice
      title={state.kind === 'loading' ? `Loading ${noun}…` : `Couldn’t load ${noun}`}
      tone={state.kind === 'failed' ? 'error' : 'neutral'}
    >
      <AppText role="support">
        {state.previous !== undefined
          ? 'The previous view is shown below. Changes are unavailable until the latest saved state is loaded.'
          : 'Your saved state has not been confirmed yet.'}
      </AppText>
      {state.kind === 'failed' && state.error.retry !== 'never' && (
        <ActionButton variant="secondary" label={`Retry loading ${noun}`} onPress={retry} />
      )}
    </Notice>
  );
}
export function WorkspaceFeedback({ checklist = false }: { checklist?: boolean }) {
  const router = useRouter();
  const workspace = useOptionalOrdinaryContentWorkspace();
  if (workspace?.kind === 'ready') return <ReadyWorkspaceFeedback checklist={checklist} />;
  if (workspace)
    return (
      <Notice title="Recipe workspace needs attention">
        <AppText>
          Saved actions are paused while this installation’s recipe content is checked.
        </AppText>
        <ActionButton
          label="Recipe content updates"
          variant="secondary"
          onPress={() => router.push('/private-content')}
        />
      </Notice>
    );
  return <LegacyWorkspaceFeedback checklist={checklist} />;
}

function LegacyWorkspaceFeedback({ checklist = false }: { checklist?: boolean }) {
  const { assistant } = useAssistant();
  const { availability, retryOpen } = useWorkspace();
  if (availability.kind === 'opening') return <Notice title="Opening your saved workspace…" />;
  if (availability.kind === 'failed') {
    const cleanupFailed = availability.error.messageKey === 'storage.cleanup_failed';
    const webRestartRequired =
      Platform.OS === 'web' && availability.error.messageKey === 'storage.web_restart_required';
    return (
      <Notice
        title={
          cleanupFailed ? 'Your saved workspace is unavailable' : 'Device storage is unavailable'
        }
        tone="error"
      >
        <AppText role="support">
          {cleanupFailed
            ? 'Recipes remain available. Your saved data is still unconfirmed.'
            : 'Recipes remain available. Saved meals and favourites could not be loaded.'}
        </AppText>
        {webRestartRequired && (
          <>
            <AppText role="support">
              Another CookMate preview may still hold the browser files. Close the other previews,
              then reload this one. Your saved data has not been cleared.
            </AppText>
            <ActionButton label="Reload preview" onPress={() => window.location.reload()} />
          </>
        )}
        {cleanupFailed && (
          <AppText role="support">
            {Platform.OS === 'web'
              ? 'Reload this page to let CookMate check your saved workspace again.'
              : 'Close and reopen CookMate to let it check your saved workspace again.'}
          </AppText>
        )}
        {availability.error.retry !== 'never' && (
          <ActionButton label="Retry device storage" onPress={retryOpen} />
        )}
      </Notice>
    );
  }
  return (
    <ReadyWorkspaceFeedback
      checklist={checklist}
      needsAssistantRecovery={!!assistant?.mutationsHeld}
    />
  );
}

function ReadyWorkspaceFeedback({
  checklist = false,
  needsAssistantRecovery = false,
}: {
  checklist?: boolean;
  needsAssistantRecovery?: boolean;
}) {
  const pageStyles = usePageStyles();
  const { recoveryState, actionState } = useOrdinaryWorkspaceActions();
  const hasDirectRecovery =
    recoveryState.kind !== 'ready' ||
    recoveryState.page.entries.length > 0 ||
    recoveryState.page.nextAfterSequence !== null;
  // Checklist marks already reflect confirmed state. Neither routine purchase progress nor
  // a previous action's receipt may add/remove a banner above the row being pressed. Global
  // receipt announcement and durable acknowledgement remain in ActionConfirmation; errors
  // and recovery keep their full UI.
  const quietPurchase =
    checklist &&
    (actionState.kind === 'receipt' ||
      (actionState.kind === 'reviewing' && actionState.input.kind === 'setPurchased') ||
      ((actionState.kind === 'preparing' || actionState.kind === 'applying') &&
        actionState.review.consequences.kind === 'purchase'));
  // Rechecking an empty, already-confirmed inventory still holds mutations, but need not
  // move the checklist. Cold checks, earlier entries and any failed check stay visible.
  const quietRecovery =
    quietPurchase &&
    recoveryState.kind === 'loading' &&
    recoveryState.previous?.entries.length === 0 &&
    recoveryState.previous.nextAfterSequence === null;
  const needsDirectRecovery = hasDirectRecovery && !quietRecovery;
  const hasCurrentActionFeedback =
    !quietPurchase && actionState.kind !== 'idle' && actionState.kind !== 'confirmation';
  if (!needsDirectRecovery && !needsAssistantRecovery && !hasCurrentActionFeedback) return null;
  return (
    <View style={pageStyles.section}>
      {needsDirectRecovery && <RecoveryFeedback />}
      {needsAssistantRecovery && <AssistantRecoveryFeedback />}
      {!quietPurchase && <CurrentActionFeedback />}
    </View>
  );
}
function CurrentActionFeedback() {
  const { actions, actionState: state } = useOrdinaryWorkspaceActions();
  const retryFocus = useActionFocus();
  if (state.kind === 'idle' || state.kind === 'confirmation') return null;
  if (state.kind === 'receipt')
    return (
      <ReceiptMotion>
        <Notice title={receiptMessage(state.receipt)}>
          <ActionButton
            variant="quiet"
            label="Dismiss confirmation"
            onPress={() => actions?.dismiss()}
          />
        </Notice>
      </ReceiptMotion>
    );
  if (state.kind === 'failed')
    return (
      <Notice
        title={
          ['stale_target', 'stale_context'].includes(state.error.code)
            ? 'This changed while you were reviewing it'
            : 'Couldn’t save this change'
        }
        tone="error"
      >
        <AppText role="support">
          {['stale_target', 'stale_context'].includes(state.error.code)
            ? 'Review the latest saved choices and consequences before confirming again.'
            : 'This change could not be saved. Your previous saved choices are still shown.'}
        </AppText>
        {state.error.retry !== 'never' && (
          <ActionButton
            ref={retryFocus.ref}
            label={
              ['stale_target', 'stale_context'].includes(state.error.code)
                ? 'Review updated change'
                : 'Retry this change'
            }
            onPress={() => void actions?.retry(retryFocus.restoreFocus)}
            disabled={actions?.blocked}
          />
        )}
        <ActionButton variant="quiet" label="Dismiss error" onPress={() => actions?.dismiss()} />
      </Notice>
    );
  if (state.kind === 'uncertain')
    return (
      <Notice title="Save result unconfirmed" tone="caution">
        <AppText role="support">{state.detail}</AppText>
        <ActionButton
          label="Check status"
          busy={state.checking}
          onPress={() => void actions?.reconcile()}
        />
        {state.retryAllowed && (
          <ActionButton
            label="Retry this same change"
            variant="secondary"
            disabled={state.checking || actions?.externallyHeld}
            onPress={() => void actions?.retryUncertain()}
          />
        )}
      </Notice>
    );
  return (
    <Notice
      title={
        state.kind === 'reviewing' ? 'Checking the current saved state…' : 'Saving your change…'
      }
    >
      You can browse while this finishes.
    </Notice>
  );
}
function Consequences({ review }: { review: Immutable<DirectActionReview> }) {
  const { mode } = useOrdinaryWorkspaceActions();
  const recipeTitle = (id: string) =>
    mode === 'content' ? `Recipe ${id}` : (getRecipe(id)?.title ?? id);
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();

  const facts = review.consequences;
  if (facts.kind === 'conversation_clear' && !facts.scope)
    return (
      <Notice title="Review the current conversation again">
        Cancel this earlier review and open a new one to check its exact saved scope. Nothing has
        been cleared.
      </Notice>
    );
  if (facts.kind === 'conversation_clear')
    return (
      <View style={pageStyles.section}>
        <AppText>
          {facts.scope.hasAnythingToClear
            ? 'These saved conversation records will be removed.'
            : 'There is nothing saved in this conversation to clear.'}
        </AppText>
        {facts.scope.hasAnythingToClear && (
          <View style={styles.reviewGroup}>
            <AppText>
              {facts.messageCount} saved message{facts.messageCount === 1 ? '' : 's'}
            </AppText>
            <AppText>
              {facts.scope.draftCharacterCount
                ? `Saved composer draft · ${facts.scope.draftCharacterCount} characters`
                : 'No saved composer draft'}
            </AppText>
            <AppText>
              {facts.scope.referenceSetCount} recipe-reference group
              {facts.scope.referenceSetCount === 1 ? '' : 's'}
            </AppText>
            <AppText>
              {facts.scope.contextItemCount} temporary memory entr
              {facts.scope.contextItemCount === 1 ? 'y' : 'ies'}
            </AppText>
            <AppText>
              {facts.scope.pendingProposalCount === null
                ? 'Pending proposal count could not be verified'
                : `${facts.scope.pendingProposalCount} pending proposal group${facts.scope.pendingProposalCount === 1 ? '' : 's'}`}
            </AppText>
            <AppText>
              {facts.scope.outstandingRequestCount} request
              {facts.scope.outstandingRequestCount === 1 ? '' : 's'} awaiting a response
            </AppText>
            <AppText role="support" color="inkSecondary">
              All attached request and response records are included. Uncommitted proposals will no
              longer be available.
            </AppText>
          </View>
        )}
        {facts.scope.pendingProposalCount === null && (
          <Notice title="Some proposal records need recovery" tone="caution">
            Clearing removes these local conversation records. An unavailable receipt does not mean
            an earlier change failed or was undone.
          </Notice>
        )}
        <AppText role="support">
          Favourites, meal plan, shopping progress, saved preferences, private notes and cooking
          history stay saved. Completed changes are not undone. This does not erase information
          already processed by Gemini.
        </AppText>
        {Platform.OS === 'web' && (
          <AppText role="support">Your draft in this browser tab stays.</AppText>
        )}
      </View>
    );
  if (facts.kind === 'preference') {
    const input = review.input;
    const previous =
      'preferenceId' in input
        ? facts.before.items.find((item) => item.preferenceId === input.preferenceId)
        : undefined;
    return (
      <View style={pageStyles.section}>
        <AppText>
          {input.kind === 'clearPreferences'
            ? `Clear all ${facts.before.items.length} saved preferences?`
            : input.kind === 'removePreference'
              ? `Remove ${previous ? `${preferenceLabels[previous.type]}: ${previous.value}` : 'this saved preference'}?`
              : input.kind === 'savePreference'
                ? `Save ${preferenceLabels[input.type]}: ${input.explicitValue}`
                : 'Review saved preferences.'}
        </AppText>
        {previous && input.kind === 'savePreference' && (
          <AppText>
            Previously: {preferenceLabels[previous.type]} · {previous.value}
          </AppText>
        )}
        <AppText role="support">
          Conversation, favourites, meal plan and shopping progress stay saved. Historical chat
          mentions do not restore removed preferences. Preferences do not guarantee allergy safety.
        </AppText>
      </View>
    );
  }
  if (facts.kind === 'favourite')
    return (
      <AppText>
        {facts.saved ? 'Save' : 'Unsave'} {recipeTitle(facts.recipeId)}
        {facts.saved ? ' in' : ' from'} Favourites. Existing planned meals stay in your plan.
      </AppText>
    );
  if (facts.kind === 'purchase')
    return (
      <AppText>
        {facts.purchased ? 'Mark purchased' : 'Mark still needed'}: {facts.displayName} ·{' '}
        {facts.quantityLabel}.
      </AppText>
    );
  if (facts.kind === 'shopping_selection') return <ShoppingSelectionConsequences review={review} />;
  if (facts.kind !== 'plan') return <AppText>Confirm the reviewed change.</AppText>;
  const moved =
    facts.source &&
    facts.resultPlacement &&
    (facts.source.placement.actualDate !== facts.resultPlacement.actualDate ||
      facts.source.placement.mealKey !== facts.resultPlacement.mealKey);
  const removedDestination =
    facts.source &&
    facts.destination &&
    facts.source.occurrenceId !== facts.destination.occurrenceId;
  return (
    <View style={pageStyles.section}>
      {(facts.source || facts.destination) && (
        <View style={styles.reviewGroup}>
          <AppText role="label" color="inkSecondary" accessibilityRole="header">
            Before
          </AppText>
          {facts.source && <AppText>Current meal: {occurrenceLabel(facts.source, mode)}.</AppText>}
          {facts.destination && facts.destination.occurrenceId !== facts.source?.occurrenceId && (
            <Notice
              title="This slot already has a meal"
              tone="caution"
            >{`Replace ${occurrenceLabel(facts.destination, mode)}. The two slots will not be swapped.`}</Notice>
          )}
        </View>
      )}
      <View style={[styles.reviewGroup, styles.proposedGroup]}>
        <AppText role="label" color="brand" accessibilityRole="header">
          Proposed change
        </AppText>
        {facts.resultRecipeId && facts.resultPlacement ? (
          <AppText>
            Save {recipeTitle(facts.resultRecipeId)} for{' '}
            {formatPlanDate(facts.resultPlacement.actualDate)},{' '}
            {mealLabel(facts.resultPlacement.mealKey)}.
          </AppText>
        ) : (
          <AppText>Remove this meal from your plan.</AppText>
        )}
        {moved && facts.source && (
          <AppText>
            The original slot becomes empty: {formatPlanDate(facts.source.placement.actualDate)},{' '}
            {mealLabel(facts.source.placement.mealKey)}.
          </AppText>
        )}
      </View>
      <View style={styles.reviewGroup}>
        <AppText role="label" color="inkSecondary" accessibilityRole="header">
          Shopping effects
        </AppText>
        <AppText role="support">
          {removedDestination && facts.destinationSelected
            ? 'The replaced destination meal is removed from shopping, along with its ingredient contribution. '
            : ''}
          {moved
            ? facts.sourceSelected
              ? 'The moving meal keeps its shopping selection. '
              : 'The moving meal stays outside the shopping selection. '
            : ''}
          {facts.resultRecipeId
            ? facts.resultSelected
              ? 'The resulting meal is selected for shopping. Its ingredients will update the list.'
              : 'The resulting meal is not selected for shopping.'
            : facts.sourceSelected
              ? 'It will also be removed from the selected shopping meals.'
              : 'This meal is not selected for shopping.'}
        </AppText>
        <AppText role="support">
          Changed ingredient demand can reset purchase marks and will be labelled for review.
        </AppText>
      </View>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    reviewGroup: {
      gap: t.space.xs,
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
    },
    proposedGroup: { backgroundColor: t.color.selection },
  });
export function ActionConfirmation() {
  const { scopeKey } = useOrdinaryWorkspaceActions();
  return <ScopedActionConfirmation key={scopeKey} />;
}

function ScopedActionConfirmation() {
  const pageStyles = usePageStyles();

  const { actions, actionState: state } = useOrdinaryWorkspaceActions();
  const close = useModalAction(state.kind === 'confirmation', () => actions?.cancelReview());
  const confirm = useModalAction(state.kind === 'confirmation', () => void actions?.confirm());
  const heading = useRef<View>(null);
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (state.kind !== 'receipt' || state.receipt.operationId === announced.current) return;
    announced.current = state.receipt.operationId;
    AccessibilityInfo.announceForAccessibility(receiptMessage(state.receipt));
    // A rendered result has now been handled; failed acknowledgement leaves its durable notice intact.
    actions?.acknowledgeDisplayedReceipt();
  }, [state, actions]);
  return (
    <PresenceModal
      visible={state.kind === 'confirmation'}
      preview
      accessibilityLabel={
        state.kind === 'confirmation' ? reviewActionLabel(state.review) : 'Review your change'
      }
      presentationStyle="pageSheet"
      onRequestClose={close}
      onDismiss={() => actions?.restoreReviewFocus()}
      onShow={() => {
        focusTarget(heading.current);
      }}
    >
      <SafeAreaView style={pageStyles.root}>
        <ScrollView contentContainerStyle={pageStyles.content}>
          <View ref={heading} accessible accessibilityRole="header">
            <AppText role="title">
              {state.kind === 'confirmation'
                ? reviewActionLabel(state.review)
                : 'Review your change'}
            </AppText>
          </View>
          {state.kind === 'confirmation' && (
            <>
              {state.refreshed && (
                <Notice title="The shopping quantity changed" tone="caution">
                  Check this updated quantity before marking it purchased.
                </Notice>
              )}
              <Consequences review={state.review} />
            </>
          )}
        </ScrollView>
        <View style={pageStyles.content}>
          <ActionButton
            label={
              state.kind === 'confirmation' ? reviewActionLabel(state.review) : 'Confirm change'
            }
            disabled={
              state.kind === 'confirmation' &&
              ((state.review.consequences.kind === 'conversation_clear' &&
                !state.review.consequences.scope?.hasAnythingToClear) ||
                (state.review.consequences.kind === 'shopping_selection' &&
                  !state.review.consequences.shoppingEffects))
            }
            onPress={confirm}
          />
          <ActionButton label="Cancel" variant="quiet" onPress={close} />
        </View>
      </SafeAreaView>
    </PresenceModal>
  );
}
