import { catalogue } from '@cookmate/catalogue';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  MemoryUpdate,
} from '@cookmate/contracts';
import { createCredentialRegistry } from '../src/registry';
import { responseEnvelope } from '../src/orchestrator';

export function request(): AssistantTurnRequest {
  return {
    apiVersion: '2',
    catalogue: { ...catalogue.identity },
    requestId: '00000000-0000-4000-8000-000000000001',
    userIntentId: '00000000-0000-4000-8000-000000000002',
    intentRevision: 0,
    conversationId: '00000000-0000-4000-8000-000000000003',
    conversationGeneration: 0,
    connectionGeneration: 0,
    message: {
      messageId: '00000000-0000-4000-8000-000000000004',
      text: 'Tell me about Adana kebab.',
      sourceSequence: 1,
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
        pendingSources: [],
        reviewTargetMessageIds: ['00000000-0000-4000-8000-000000000004'],
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
export function answer(input = request()): AssistantTurnResponse {
  return {
    ...responseEnvelope(input),
    kind: 'answer',
    text: 'The source includes Adana kebab.',
    sources: [{ recipeId: '53262', section: 'recipe' }],
    referenceSets: [],
    memoryUpdate: nonMemoryUpdate(input),
  };
}
/** Test-only explicit model classification, never an application fallback. */
export function nonMemoryUpdate(input = request()): MemoryUpdate {
  const [first, ...rest] = input.context.memory.reviewTargetMessageIds;
  return {
    baseRevision: input.context.memory.projectionRevision,
    baseContextRevision: input.context.memory.baseContextRevision,
    reviews: [
      { sourceMessageId: first, disposition: 'non_memory' },
      ...rest.map((sourceMessageId) => ({ sourceMessageId, disposition: 'non_memory' as const })),
    ],
    entries: [],
  };
}
export async function memoryRegistry(now?: () => number) {
  let saved: unknown = null;
  let failWrite = false;
  const storage = {
    async read() {
      return structuredClone(saved);
    },
    async write(value: unknown) {
      if (failWrite) throw new Error('sensitive storage detail');
      saved = structuredClone(value);
    },
  };
  return {
    registry: await createCredentialRegistry(storage, now),
    storage,
    saved: () => structuredClone(saved),
    failWrites() {
      failWrite = true;
    },
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
