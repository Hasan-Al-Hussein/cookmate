import { createHash } from 'node:crypto';
import { identity } from '@cookmate/catalogue';
import { API_VERSION } from '@cookmate/contracts';
import type { AssistantTurnRequest, DateContext, ProposalResponse } from '@cookmate/contracts';
import type { CommandPlatform } from '@cookmate/domain';
import type { ActionGuard, ConversationContextSnapshot, CurrentActionState } from './ports';

export const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
export const date: DateContext = {
  localDate: '2026-09-28',
  timeZone: 'Asia/Dubai',
  utcOffsetMinutes: 240,
};
export function platform(): CommandPlatform {
  let counter = 100;
  return {
    newId: () => id(counter++),
    sha256: async (text) => createHash('sha256').update(text).digest('hex'),
  };
}
export function snapshot(
  messageId = id(4),
  text = 'Please save this recipe.',
): ConversationContextSnapshot {
  return {
    conversationId: id(1),
    conversationGeneration: 0,
    contextRevision: 0,
    currentMessage: {
      messageId,
      text,
      sourceSequence: 100,
      sourceDateContext: { ...date },
      preferenceRevisionAtSource: 0,
      preferenceLinks: [],
    },
    date: { ...date },
    history: [],
    memory: {
      projectionRevision: 0,
      baseContextRevision: 0,
      workingContext: { afterSequence: null, carryMemoryIds: [] },
      items: [],
      reviewTargetMessageIds: [messageId],
      pendingSources: [],
      coverage: {
        retainedEntryCount: 0,
        suppliedEntryCount: 0,
        omittedEntryCount: 0,
        pendingUserSourceCount: 1,
        pendingWorkingSourceCount: 1,
        suppliedReviewTargetCount: 1,
        selectionStatus: 'within_budget',
      },
    },
    referenceSets: [],
    preferences: { revision: 0, lastRemovalRevision: null, items: [] },
    planOccurrences: [],
  };
}
export function request(generation = 1): AssistantTurnRequest {
  return {
    apiVersion: API_VERSION,
    catalogue: { ...identity },
    requestId: id(2),
    userIntentId: id(3),
    intentRevision: 0,
    conversationId: id(1),
    conversationGeneration: 0,
    connectionGeneration: generation,
    message: snapshot().currentMessage,
    context: {
      history: [],
      memory: snapshot().memory,
      referenceSets: [],
      preferences: { revision: 0, lastRemovalRevision: null, items: [] },
      planOccurrences: [],
      date: { ...date },
      selectedRecipeId: '53262',
    },
    capabilities: ['saveRecipe', 'addPlan', 'savePreference'],
  };
}
export function response(turn = request()): ProposalResponse {
  const [firstTarget, ...otherTargets] = turn.context.memory.reviewTargetMessageIds;
  return {
    apiVersion: API_VERSION,
    catalogue: turn.catalogue,
    requestId: turn.requestId,
    userIntentId: turn.userIntentId,
    intentRevision: turn.intentRevision,
    conversationId: turn.conversationId,
    conversationGeneration: turn.conversationGeneration,
    connectionGeneration: turn.connectionGeneration,
    preferenceRevision: turn.context.preferences.revision,
    kind: 'proposal',
    text: 'Saved!',
    sources: [{ recipeId: '53262', section: 'recipe' }],
    referenceSets: [],
    proposals: [{ kind: 'saveRecipe', recipeId: '53262' }],
    memoryUpdate: {
      baseRevision: turn.context.memory.projectionRevision,
      baseContextRevision: turn.context.memory.baseContextRevision,
      reviews: [
        { sourceMessageId: firstTarget, disposition: 'non_memory' },
        ...otherTargets.map((sourceMessageId) => ({
          sourceMessageId,
          disposition: 'non_memory' as const,
        })),
      ],
      entries: [],
    },
  };
}
export function guard(): ActionGuard {
  return {
    conversationId: id(1),
    conversationGeneration: 0,
    contextRevision: 0,
    preferenceRevision: 0,
    connectionGeneration: 1,
    relativeDateContext: { ...date },
  };
}
export function current(): CurrentActionState {
  return {
    guards: guard(),
    planOccurrences: [],
    shoppingScope: { scopeId: id(5), revision: 0, occurrenceIds: [] },
  };
}
