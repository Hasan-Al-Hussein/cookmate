import type {
  AssistantTurnRequest,
  CatalogueIdentity,
  LocalCommand,
  OperationReceipt,
  ProposalResponse,
  SourceReference,
} from '../src/generated/types.js';

export const ids = {
  request: '00000000-0000-4000-8000-000000000001',
  intent: '00000000-0000-4000-8000-000000000002',
  conversation: '00000000-0000-4000-8000-000000000003',
  message: '00000000-0000-4000-8000-000000000004',
  operation: '00000000-0000-4000-8000-000000000005',
  occurrence: '00000000-0000-4000-8000-000000000006',
  destination: '00000000-0000-4000-8000-000000000007',
  slot: '00000000-0000-4000-8000-000000000008',
  otherSlot: '00000000-0000-4000-8000-000000000009',
};
export const catalogueIdentity: CatalogueIdentity = {
  version: 'synthetic-fixture-v1',
  fingerprint: 'a'.repeat(64),
};
// Synthetic ownership fixture, not a claim about workbook positions.
export const catalogueBoundary = {
  identity: catalogueIdentity,
  recipeIds: new Set(['53262', '52771']),
  hasSource(reference: SourceReference): boolean {
    if (reference.section === 'recipe') return this.recipeIds.has(reference.recipeId);
    if (reference.section === 'annotation')
      return reference.recipeId === '53262' && reference.annotationId === 'fixture-53262-note';
    return reference.recipeId === '53262' && reference.position === 1;
  },
};

export function requestFixture(): AssistantTurnRequest {
  return {
    apiVersion: '2',
    catalogue: catalogueIdentity,
    requestId: ids.request,
    userIntentId: ids.intent,
    intentRevision: 0,
    conversationId: ids.conversation,
    conversationGeneration: 0,
    connectionGeneration: 0,
    message: {
      messageId: ids.message,
      text: 'Save this recipe and plan it for dinner.',
      sourceSequence: 0,
      sourceDateContext: { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 },
      preferenceRevisionAtSource: 0,
      preferenceLinks: [],
    },
    context: {
      history: [],
      memory: {
        projectionRevision: 0,
        baseContextRevision: 0,
        workingContext: { afterSequence: null, carryMemoryIds: [] },
        items: [],
        reviewTargetMessageIds: [ids.message],
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
      date: { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 },
      selectedRecipeId: '53262',
    },
    capabilities: ['saveRecipe', 'addPlan', 'savePreference'],
  };
}

export function responseFixture(): ProposalResponse {
  const request = requestFixture();
  return {
    apiVersion: request.apiVersion,
    catalogue: request.catalogue,
    requestId: request.requestId,
    userIntentId: request.userIntentId,
    intentRevision: request.intentRevision,
    conversationId: request.conversationId,
    conversationGeneration: request.conversationGeneration,
    connectionGeneration: request.connectionGeneration,
    preferenceRevision: request.context.preferences.revision,
    kind: 'proposal',
    text: 'Ready to save this recipe.',
    sources: [{ recipeId: '53262', section: 'recipe' }],
    referenceSets: [],
    proposals: [{ kind: 'saveRecipe', recipeId: '53262' }],
    memoryUpdate: {
      baseRevision: 0,
      baseContextRevision: 0,
      reviews: [{ sourceMessageId: ids.message, disposition: 'non_memory' }],
      entries: [],
    },
  };
}

export function commandFixture(): LocalCommand {
  return {
    schemaVersion: 2,
    operationId: ids.operation,
    userIntentId: ids.intent,
    intentRevision: 0,
    payloadFingerprint: 'b'.repeat(64),
    command: { kind: 'setFavourite', recipeId: '53262', saved: true },
  };
}

export function receiptFixture(): OperationReceipt {
  return {
    schemaVersion: 1,
    operationId: ids.operation,
    userIntentId: ids.intent,
    payloadFingerprint: 'b'.repeat(64),
    outcome: 'committed',
    committedAt: '2026-09-28T02:00:00.000Z',
    effects: [{ kind: 'favourite', entityId: '53262', revision: 1, saved: true }],
    shoppingProjection: 'unchanged',
  };
}
