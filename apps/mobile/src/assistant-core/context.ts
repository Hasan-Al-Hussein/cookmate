import {
  API_VERSION,
  MAX_ASSISTANT_BODY_BYTES,
  assistantJsonByteLength,
  checkAssistantRequest,
  isRelativeDateContextCurrent,
} from '@cookmate/contracts';
import type { AssistantTurnRequest, ContractError, DateContext } from '@cookmate/contracts';
import { catalogueBoundary } from '@cookmate/catalogue';
import type { Immutable } from '@cookmate/domain';
import type { ContextNarrowing, ContextSelection, ConversationContextSnapshot } from './ports';

export type ContextBuildResult =
  | { kind: 'ready'; request: AssistantTurnRequest; omittedHistoryCount: number }
  | ContextNarrowing
  | { kind: 'clarification'; reason: 'reference'; messageKey: string }
  | { kind: 'failed'; error: ContractError };

export interface RequestIdentity {
  requestId: string;
  userIntentId: string;
  intentRevision: number;
  messageId: string;
  connectionGeneration: number;
}

/** Counts and membership remain Data's snapshot; this never creates a partial sendable packet. */
export function contextNarrowing(
  snapshot: Immutable<ConversationContextSnapshot>,
  reason: ContextNarrowing['reason'],
): ContextNarrowing {
  return {
    kind: 'narrowing',
    revision: snapshot.contextRevision,
    reason,
    coverage: { ...snapshot.memory.coverage, selectionStatus: 'narrowing_required' },
    workingContext: {
      ...snapshot.memory.workingContext,
      carryMemoryIds: [...snapshot.memory.workingContext.carryMemoryIds],
    },
  };
}

/** Data selects context and supplies immutable USER provenance before this boundary. */
export function buildAssistantRequest(
  snapshot: Immutable<ConversationContextSnapshot>,
  input: { text: string; ids: RequestIdentity; date: DateContext; selection: ContextSelection },
): ContextBuildResult {
  if (
    snapshot.currentMessage.messageId !== input.ids.messageId ||
    snapshot.currentMessage.text !== input.text ||
    snapshot.memory.baseContextRevision !== snapshot.contextRevision ||
    !isRelativeDateContextCurrent(snapshot.date, input.date)
  )
    return {
      kind: 'failed',
      error: {
        code: 'stale_context',
        messageKey: 'assistant.snapshot_changed',
        retry: 'after_correction',
      },
    };
  if (
    snapshot.memory.coverage.selectionStatus === 'narrowing_required' ||
    snapshot.memory.coverage.pendingWorkingSourceCount >
      snapshot.memory.reviewTargetMessageIds.length
  )
    return contextNarrowing(snapshot, 'pending_evidence');
  if (
    snapshot.memory.items.length > 32 ||
    snapshot.memory.pendingSources.length > 7 ||
    snapshot.memory.reviewTargetMessageIds.length > 8 ||
    snapshot.planOccurrences.length > 42 ||
    snapshot.history.length > 20 ||
    snapshot.referenceSets.length > 10
  )
    return contextNarrowing(snapshot, 'entry_limit');

  const referenceSets = snapshot.referenceSets;
  let selectedRecipeId = input.selection.selectedRecipeId;
  const reference = input.selection.reference;
  if (reference) {
    const sets = snapshot.referenceSets.filter(
      (set) => !reference.referenceSetId || set.referenceSetId === reference.referenceSetId,
    );
    const set = sets.length === 1 ? sets[0] : undefined;
    const recipeId =
      Number.isSafeInteger(reference.ordinal) && reference.ordinal >= 1
        ? set?.recipeIds[reference.ordinal - 1]
        : undefined;
    if (!set || !recipeId || (selectedRecipeId && selectedRecipeId !== recipeId))
      return {
        kind: 'clarification',
        reason: 'reference',
        messageKey: 'assistant.clarify_reference',
      };
    selectedRecipeId = recipeId;
  }
  const candidate: unknown = JSON.parse(
    JSON.stringify({
      apiVersion: API_VERSION,
      catalogue: catalogueBoundary.identity,
      requestId: input.ids.requestId,
      userIntentId: input.ids.userIntentId,
      intentRevision: input.ids.intentRevision,
      conversationId: snapshot.conversationId,
      conversationGeneration: snapshot.conversationGeneration,
      connectionGeneration: input.ids.connectionGeneration,
      message: snapshot.currentMessage,
      context: {
        history: snapshot.history,
        memory: snapshot.memory,
        referenceSets,
        preferences: snapshot.preferences,
        planOccurrences: snapshot.planOccurrences,
        date: snapshot.date,
        ...(selectedRecipeId ? { selectedRecipeId } : {}),
        ...(input.selection.selectedPlacement
          ? { selectedPlacement: input.selection.selectedPlacement }
          : {}),
      },
      capabilities: ['saveRecipe', 'addPlan', 'savePreference'],
    }),
  );
  if (assistantJsonByteLength(candidate) > MAX_ASSISTANT_BODY_BYTES)
    return contextNarrowing(snapshot, 'byte_limit');
  const checked = checkAssistantRequest(candidate, catalogueBoundary);
  if (!checked.ok) return { kind: 'failed', error: checked.error };
  // Local history selection belongs to Data. No source/provenance channel is trimmed here.
  return { kind: 'ready', request: checked.value, omittedHistoryCount: 0 };
}
