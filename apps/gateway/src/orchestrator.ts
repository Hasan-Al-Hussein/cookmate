import { randomUUID } from 'node:crypto';
import {
  API_VERSION,
  checkAssistantRequest,
  checkAssistantResponse,
  checkMemoryResponseForRequest,
} from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  MemoryUpdate,
  SourceReference,
} from '@cookmate/contracts';
import type { SearchCriteria } from '@cookmate/domain';
import { createEvidenceBuilder, evidenceSourceKeys, sourceKey } from './evidence';
import type { EvidencePacket } from './evidence';
import type { ModelProvider, ProviderBudget, ProviderInput } from './provider-contract';
import { contextBudgetError, gatewayError, GatewayError } from './errors';
import { LIMITS } from './limits';
import { expandMemoryUpdate, unresolvedMemoryUpdate } from './memory';
import { isModelStep } from './model-validation';
import { searchProvenance, selectionProvenance } from './retrieval-provenance';
import type { SelectionProvenance } from './retrieval-provenance';

export function responseEnvelope(request: AssistantTurnRequest) {
  return {
    apiVersion: API_VERSION,
    catalogue: { ...request.catalogue },
    requestId: request.requestId,
    userIntentId: request.userIntentId,
    intentRevision: request.intentRevision,
    conversationId: request.conversationId,
    conversationGeneration: request.conversationGeneration,
    connectionGeneration: request.connectionGeneration,
    preferenceRevision: request.context.preferences.revision,
  };
}

export function createProviderBudget(): ProviderBudget {
  let generations = 0;
  let preflights = 0;
  let retries = 0;
  function check() {
    if (generations + preflights >= LIMITS.providerNetworkRequests)
      throw gatewayError('too_large', 422);
  }
  return {
    spendGeneration() {
      check();
      if (generations >= LIMITS.providerCalls) throw gatewayError('too_large', 422);
      generations++;
    },
    spendPreflight() {
      check();
      if (preflights >= LIMITS.tokenPreflights) throw gatewayError('too_large', 422);
      preflights++;
    },
    spendRetry() {
      if (retries >= 1) throw gatewayError('provider_unavailable', 503, 'after_delay');
      retries++;
    },
    get generations() {
      return generations;
    },
    get preflights() {
      return preflights;
    },
    get retries() {
      return retries;
    },
  };
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === keys.sort().join(',');
const strings = (value: unknown, maxItems: number, maxLength: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= maxItems &&
  value.every((item) => typeof item === 'string' && [...item].length <= maxLength);

function clarification(
  request: AssistantTurnRequest,
  text: string,
  missing: 'reference' | 'recipe' | 'intent',
  memoryUpdate: MemoryUpdate = unresolvedMemoryUpdate(request),
): AssistantTurnResponse {
  return {
    ...responseEnvelope(request),
    kind: 'clarification',
    text,
    missing: [missing],
    sources: [],
    referenceSets: [],
    memoryUpdate,
  };
}

function resolveOrdinal(
  request: AssistantTurnRequest,
  evidence: ReturnType<typeof createEvidenceBuilder>,
): { selection?: SelectionProvenance; ambiguous: boolean } {
  const match = /\b(first|second|third|fourth|fifth|sixth)\s+(?:one|option|recipe)\b/i.exec(
    request.message.text,
  );
  if (!match) return { ambiguous: false };
  const named = evidence.namedRecipeIds(request.message.text);
  if (named.length === 1)
    return { selection: selectionProvenance('explicit_recipes', [named[0]!]), ambiguous: false };
  if (request.context.selectedRecipeId)
    return {
      selection: selectionProvenance('selected_recipe', [request.context.selectedRecipeId]),
      ambiguous: false,
    };
  const index = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'].indexOf(
    match[1]?.toLowerCase() ?? '',
  );
  const sets = new Map(
    request.context.referenceSets.map((set) => [JSON.stringify(set.recipeIds), set.recipeIds]),
  );
  if (sets.size !== 1)
    return {
      // A bare ordinal or save request has no list description; qualifiers need interpretation.
      ambiguous:
        /^\s*(?:save\s+)?(?:the\s+)?(?:first|second|third|fourth|fifth|sixth)\s+(?:one|option|recipe)\s*[.!?]?\s*$/i.test(
          request.message.text,
        ),
    };
  const id = [...sets.values()][0]?.[index];
  return id
    ? { selection: selectionProvenance('ordered_reference', [id]), ambiguous: false }
    : { ambiguous: true };
}

// Keep the positive grammar tied to supported app objects/destinations, not cooking keywords.
const completionVerb = String.raw`(?:saved|added|scheduled|removed|deleted)`;
const appObject = String.raw`(?:it|(?:the|your|this)\s+(?:recipes?|(?:[a-z]+\s+)*preferences?|plan|favourites?|favorites?))`;
const appDestination = String.raw`(?:to|from|in)\s+your\s+(?:plan|favourites|favorites)`;
const firstPersonCompletion = String.raw`^i(?:'ve| have)?\s+${completionVerb}\s+`;
const firstPersonCompletionStart = new RegExp(firstPersonCompletion, 'i');
const appCompletionClaims = [
  new RegExp(String.raw`${firstPersonCompletion}(?:${appObject}\b|.+?\s+${appDestination}\b)`, 'i'),
  new RegExp(String.raw`^${appObject}\s+(?:has|have)\s+been\s+${completionVerb}\b`, 'i'),
  new RegExp(
    String.raw`^(?:the|your|this)\s+meals?\s+(?:has|have)\s+been\s+${completionVerb}\s+${appDestination}\b`,
    'i',
  ),
  new RegExp(String.raw`^${completionVerb}\s+(?:${appObject}\b|${appDestination}\b)`, 'i'),
];
const namedRecipeCompletion = new RegExp(
  String.raw`^\s+(?:has|have)\s+been\s+${completionVerb}\b`,
  'i',
);

function claimsCompletedAppAction(text: string, packet: EvidencePacket): boolean {
  // This bounded prose heuristic supplies no receipt authority; the phone owns actual writes.
  return text.split(/[.!?]\s+|\n+/).some((part) => {
    const statement = part.trim();
    const firstPerson = firstPersonCompletionStart.exec(statement);
    const directObject = firstPerson ? statement.slice(firstPerson[0].length) : null;
    return (
      appCompletionClaims.some((claim) => claim.test(statement)) ||
      packet.some(
        ({ title }) =>
          (statement.slice(0, title.length).toLowerCase() === title.toLowerCase() &&
            namedRecipeCompletion.test(statement.slice(title.length))) ||
          (directObject !== null &&
            directObject.slice(0, title.length).toLowerCase() === title.toLowerCase() &&
            /^(?:\s|[.,!?;:]|$)/.test(directObject.slice(title.length))),
      )
    );
  });
}

function validateReply(
  value: unknown,
  request: AssistantTurnRequest,
  packet: EvidencePacket,
  evidence: ReturnType<typeof createEvidenceBuilder>,
): AssistantTurnResponse {
  if (
    !isObject(value) ||
    !exactKeys(value, ['kind', 'sufficiency', 'missingFacts', 'response', 'memoryUpdate']) ||
    value.kind !== 'respond' ||
    typeof value.sufficiency !== 'string' ||
    !['sufficient', 'insufficient', 'unanswerable', 'irrelevant'].includes(
      String(value.sufficiency),
    ) ||
    !strings(value.missingFacts, 8, 300) ||
    !isObject(value.response)
  )
    throw gatewayError('invalid_model_result', 502, 'never');
  const body = value.response;
  const keys = ['kind', 'text', 'sources', 'recipeIds'];
  if (body.kind === 'proposal') keys.push('proposals');
  if (body.kind === 'clarification') keys.push('missing');
  if (
    !exactKeys(body, keys) ||
    !strings(body.recipeIds, LIMITS.evidenceRecipes, 20) ||
    new Set(body.recipeIds).size !== body.recipeIds.length
  )
    throw gatewayError('invalid_model_result', 502, 'never');
  if (value.sufficiency === 'insufficient' && body.kind !== 'clarification')
    throw gatewayError('invalid_model_result', 502, 'never');
  if (body.kind === 'proposal' && value.sufficiency !== 'sufficient')
    throw gatewayError('invalid_model_result', 502, 'never');
  if (value.sufficiency === 'sufficient' && value.missingFacts.length)
    throw gatewayError('invalid_model_result', 502, 'never');
  const allowedRecipes = new Set(packet.map((recipe) => recipe.recipeId));
  if (body.recipeIds.some((id) => !allowedRecipes.has(id)))
    throw gatewayError('invalid_model_result', 502, 'never');
  const { recipeIds, ...responseBody } = body;
  const response = {
    ...responseEnvelope(request),
    ...responseBody,
    memoryUpdate: expandMemoryUpdate(value.memoryUpdate, request),
    referenceSets: recipeIds.length
      ? [{ referenceSetId: randomUUID(), messageId: randomUUID(), recipeIds }]
      : [],
  };
  const checked = checkAssistantResponse(response, evidence.boundary);
  if (!checked.ok) {
    if (checked.error.code === 'too_large') throw contextBudgetError('byte_limit');
    throw gatewayError('invalid_model_result', 502, 'never');
  }
  if (checked.value.kind === 'error' || !checkMemoryResponseForRequest(checked.value, request).ok)
    throw gatewayError('invalid_model_result', 502, 'never');
  const result = checked.value;
  const allowedSources = evidenceSourceKeys(packet);
  if (result.sources.some((reference) => !allowedSources.has(sourceKey(reference))))
    throw gatewayError('invalid_model_result', 502, 'never');
  if (recipeIds.some((id) => !result.sources.some((reference) => reference.recipeId === id)))
    throw gatewayError('invalid_model_result', 502, 'never');
  if (claimsCompletedAppAction(result.text, packet))
    throw gatewayError('invalid_model_result', 502, 'never');
  if (result.kind === 'proposal') {
    for (const proposal of result.proposals) {
      if (!request.capabilities.includes(proposal.kind))
        throw gatewayError('invalid_model_result', 502, 'never');
      if (
        'recipeId' in proposal &&
        (!allowedRecipes.has(proposal.recipeId) ||
          !result.sources.some((ref) => ref.recipeId === proposal.recipeId))
      )
        throw gatewayError('invalid_model_result', 502, 'never');
      if (proposal.kind === 'addPlan') {
        const current = request.context.planOccurrences.find(
          (occurrence) =>
            occurrence.placement.actualDate === proposal.placement.actualDate &&
            occurrence.placement.mealKey === proposal.placement.mealKey,
        );
        if (
          current
            ? proposal.expectedTarget.kind !== 'occupied' ||
              proposal.expectedTarget.occurrenceId !== current.occurrenceId ||
              proposal.expectedTarget.expectedRevision !== current.revision
            : proposal.expectedTarget.kind !== 'empty'
        )
          throw gatewayError('invalid_model_result', 502, 'never');
      }
    }
    // Provider prose cannot assert a write; the phone owns confirmation and receipt narration.
    result.text = 'Review these proposed changes before applying them.';
  }
  const used = new Set(result.sources.map((reference) => reference.recipeId));
  const notes = packet
    .filter((recipe) => used.has(recipe.recipeId))
    .flatMap((recipe) => [
      ...recipe.annotations.map((annotation) => ({
        text: `${recipe.title}: ${annotation.note}`,
        source: annotation.source,
      })),
      ...recipe.retainedOriginalWarnings.map((annotation) => ({
        text: `${recipe.title} (original revision; not yet resolved for this version): ${annotation.note}`,
        source: annotation.source,
      })),
    ]);
  if (notes.length) {
    result.text += `\n\nSource notes: ${notes.map((note) => note.text).join(' ')}`;
    for (const note of notes)
      if (
        !result.sources.some(
          (reference: SourceReference) => sourceKey(reference) === sourceKey(note.source),
        )
      )
        result.sources.push(note.source);
  }
  if (!checkAssistantResponse(result, evidence.boundary).ok) throw gatewayError('too_large', 422);
  return result;
}

export function createOrchestrator(provider: ModelProvider, evidence = createEvidenceBuilder()) {
  return async (
    input: AssistantTurnRequest,
    execution: { signal: AbortSignal; deadline: number },
  ): Promise<AssistantTurnResponse> => {
    const checked = checkAssistantRequest(input, evidence.boundary);
    if (!checked.ok) throw gatewayError(checked.error.code);
    const request = structuredClone(checked.value);
    const ordinal = resolveOrdinal(request, evidence);
    if (ordinal.ambiguous)
      return clarification(
        request,
        'Which earlier recipe list do you mean? Select the recipe or name the list so I can use the right one.',
        'reference',
      );
    const initial = evidence.initial(request);
    let packet = ordinal.selection
      ? evidence.packet(ordinal.selection.returnedRecipeIds)
      : initial.packet;
    const retrieval: ProviderInput['retrieval'][number][] = [
      ordinal.selection ?? initial.selection,
    ];
    const budget = createProviderBudget();
    for (let round = 0; round < LIMITS.retrievalRounds; round++) {
      execution.signal.throwIfAborted();
      let result;
      try {
        result = await provider.complete(
          {
            request,
            evidence: packet,
            retrieval,
            remainingRetrievalRounds: LIMITS.retrievalRounds - round - 1,
          },
          { ...execution, budget },
        );
      } catch (error) {
        if (
          error instanceof GatewayError &&
          (error.detail.field === 'context.token_limit' ||
            error.detail.field === 'context.byte_limit')
        )
          throw error;
        if (error instanceof GatewayError && error.detail.code === 'too_large')
          return clarification(
            request,
            'Please narrow this to one recipe or a smaller comparison so I can include the complete ingredients, instructions and source notes.',
            'recipe',
          );
        throw error;
      }
      execution.signal.throwIfAborted();
      const step = result.value;
      if (!isModelStep(step)) throw gatewayError('invalid_model_result', 502, 'never');
      if (isObject(step) && step.kind === 'retrieve') {
        if (round + 1 >= LIMITS.retrievalRounds)
          return clarification(
            request,
            'Please narrow this to a recipe, ingredient or smaller comparison so I can check the full source details.',
            'recipe',
          );
        if (
          !exactKeys(step, ['kind', 'criteria', 'recipeIds', 'requiredFacts']) ||
          !isObject(step.criteria) ||
          !strings(step.recipeIds, LIMITS.evidenceRecipes, 20) ||
          !strings(step.requiredFacts, 8, 300)
        )
          throw gatewayError('invalid_model_result', 502, 'never');
        const criteria = step.criteria as SearchCriteria;
        if (
          Object.keys(criteria).some(
            (key) => !['query', 'category', 'cuisine', 'ingredients'].includes(key),
          ) ||
          (criteria.query !== undefined &&
            (typeof criteria.query !== 'string' || [...criteria.query].length > 4000)) ||
          (criteria.category !== undefined &&
            (typeof criteria.category !== 'string' || [...criteria.category].length > 512)) ||
          (criteria.cuisine !== undefined &&
            (typeof criteria.cuisine !== 'string' || [...criteria.cuisine].length > 512)) ||
          (criteria.ingredients !== undefined && !strings(criteria.ingredients, 20, 512))
        )
          throw gatewayError('invalid_model_result', 502, 'never');
        if (step.recipeIds.length) {
          // Direct IDs carry their own provenance, never an unrelated search's counts.
          if (Object.keys(criteria).length)
            throw gatewayError('invalid_model_result', 502, 'never');
          const permitted = new Set([
            request.context.selectedRecipeId,
            ...request.context.referenceSets.flatMap((set) => set.recipeIds),
            ...packet.map((recipe) => recipe.recipeId),
          ]);
          if (step.recipeIds.some((id) => !permitted.has(id)))
            throw gatewayError('invalid_model_result', 502, 'never');
          packet = evidence.packet(step.recipeIds);
          retrieval.push(
            selectionProvenance(
              'explicit_recipes',
              packet.map((recipe) => recipe.recipeId),
              step.requiredFacts,
            ),
          );
          continue;
        }
        let found;
        try {
          found = evidence.retrieve(criteria);
        } catch {
          throw gatewayError('invalid_model_result', 502, 'never');
        }
        const selection = searchProvenance(found, 'model_requested', step.requiredFacts);
        packet = evidence.packet(selection.returnedRecipeIds);
        retrieval.push(selection);
        continue;
      }
      const response = validateReply(step, request, packet, evidence);
      // Spelling candidates may be shown, but need an explicit new user selection before actions.
      if (
        response.kind === 'proposal' &&
        retrieval.some(
          (item) => item.kind === 'search' && item.returnedFrom === 'spelling_suggestions',
        )
      )
        return clarification(
          request,
          'Please select the intended recipe from these possible matches before making a change.',
          'recipe',
          response.memoryUpdate,
        );
      return response;
    }
    return clarification(
      request,
      'Please narrow the request so I can verify the relevant recipe details.',
      'recipe',
    );
  };
}
