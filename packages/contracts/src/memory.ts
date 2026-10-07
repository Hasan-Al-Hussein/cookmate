import equal from 'fast-deep-equal';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  ContractError,
  CurrentUserMessage,
  MemoryItem,
  UserMemorySource,
} from './generated/types.js';
import {
  validateAssistantTurnRequest,
  validateAssistantTurnResponse,
} from './generated/validators.js';
import type { ContractCheck } from './semantics.js';
import { MAX_ASSISTANT_BODY_BYTES } from './constants';

function invalid<T>(
  field: string,
  code: ContractError['code'] = 'invalid_input',
): ContractCheck<T> {
  return {
    ok: false,
    error: { code, field, messageKey: `contract.${code}`, retry: 'after_correction' },
  };
}

// No Buffer/TextEncoder dependency in the phone contract. JSON escaping handles
// lone surrogates; count the actual expanded JSON representation, not quote length.
export function assistantJsonByteLength(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Assistant body must be JSON');
  let bytes = 0;
  for (const character of json) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function sourceOf(message: CurrentUserMessage): UserMemorySource {
  return {
    sourceMessageId: message.messageId,
    quote: message.text,
    sourceSequence: message.sourceSequence,
    sourceDateContext: message.sourceDateContext,
    preferenceRevisionAtSource: message.preferenceRevisionAtSource,
    preferenceLinks: message.preferenceLinks,
  };
}

function sourceProjection(source: UserMemorySource): UserMemorySource {
  const {
    sourceMessageId,
    quote,
    sourceSequence,
    sourceDateContext,
    preferenceRevisionAtSource,
    preferenceLinks,
  } = source;
  return {
    sourceMessageId,
    quote,
    sourceSequence,
    sourceDateContext,
    preferenceRevisionAtSource,
    preferenceLinks,
  };
}

/** Pure frozen-wire consistency only. Retained USER ownership, generation,
 * original provenance, pending classification and complete group selection must
 * independently be checked against app storage. */
export function checkMemoryRequest(value: unknown): ContractCheck<AssistantTurnRequest> {
  if (!validateAssistantTurnRequest(value)) return invalid('request');
  if (assistantJsonByteLength(value) > MAX_ASSISTANT_BODY_BYTES)
    return invalid('request', 'too_large');
  const { memory, preferences, history, date } = value.context;
  const current = sourceOf(value.message);
  const { coverage, workingContext } = memory;
  // Narrowing is a local recovery outcome, never a partial sendable request.
  if (coverage.selectionStatus !== 'within_budget')
    return invalid('context.memory.coverage.selectionStatus');
  const livePreferences = new Map(
    preferences.items.map((preference) => [preference.preferenceId, preference]),
  );
  if (livePreferences.size !== preferences.items.length)
    return invalid('context.preferences.items');
  if (
    current.preferenceRevisionAtSource !== preferences.revision ||
    !equal(current.sourceDateContext, date) ||
    current.preferenceLinks.length !== 0 ||
    (preferences.lastRemovalRevision !== null &&
      preferences.lastRemovalRevision > preferences.revision)
  )
    return invalid('message.provenance');
  if (
    coverage.suppliedEntryCount !== memory.items.length ||
    coverage.retainedEntryCount - coverage.suppliedEntryCount !== coverage.omittedEntryCount ||
    coverage.suppliedReviewTargetCount !== memory.reviewTargetMessageIds.length ||
    coverage.pendingWorkingSourceCount < 1 ||
    coverage.pendingWorkingSourceCount > coverage.pendingUserSourceCount ||
    (workingContext.afterSequence === null &&
      coverage.pendingWorkingSourceCount !== coverage.pendingUserSourceCount)
  )
    return invalid('context.memory.coverage');

  const sources = new Map<string, UserMemorySource>();
  const sequences = new Map<number, string>();
  const assistants = new Set(
    history.filter((turn) => turn.role === 'assistant').map((turn) => turn.messageId),
  );
  function addSource(source: UserMemorySource): boolean {
    if (
      assistants.has(source.sourceMessageId) ||
      source.preferenceRevisionAtSource > preferences.revision
    )
      return false;
    const previous = sources.get(source.sourceMessageId);
    if (previous && !equal(sourceProjection(previous), sourceProjection(source))) return false;
    const sequenceOwner = sequences.get(source.sourceSequence);
    if (sequenceOwner && sequenceOwner !== source.sourceMessageId) return false;
    if (
      source.sourceMessageId !== current.sourceMessageId &&
      source.sourceSequence >= current.sourceSequence
    )
      return false;
    const linkKeys = new Set<string>();
    for (const link of source.preferenceLinks) {
      // savedRevision is a row version, removedRevision is a global revision.
      // There is intentionally no ordering comparison between those domains.
      const key = `${link.preferenceId}:${link.savedRevision}`;
      if (
        link.sourceMessageId !== source.sourceMessageId ||
        linkKeys.has(key) ||
        (link.removedRevision !== null &&
          (preferences.lastRemovalRevision === null ||
            link.removedRevision > preferences.lastRemovalRevision ||
            link.removedRevision <= source.preferenceRevisionAtSource))
      )
        return false;
      const live = livePreferences.get(link.preferenceId);
      const sameVersion = live?.revision === link.savedRevision;
      if (link.removedRevision === null) {
        if (!sameVersion || live?.type !== link.type || live.value !== link.value) return false;
      } else if (sameVersion) return false;
      linkKeys.add(key);
    }
    sources.set(source.sourceMessageId, source);
    sequences.set(source.sourceSequence, source.sourceMessageId);
    return true;
  }
  if (!addSource(current)) return invalid('message.provenance');
  const itemMap = new Map<string, MemoryItem>();
  const itemSources = new Set<string>();
  for (const item of memory.items) {
    if (
      itemMap.has(item.memoryId) ||
      itemSources.has(item.sourceMessageId) ||
      item.sourceMessageId === current.sourceMessageId ||
      !addSource(item)
    )
      return invalid('context.memory.items');
    itemMap.set(item.memoryId, item);
    itemSources.add(item.sourceMessageId);
  }
  const pendingIds = new Set<string>();
  for (const source of memory.pendingSources) {
    if (
      pendingIds.has(source.sourceMessageId) ||
      source.sourceMessageId === current.sourceMessageId ||
      !addSource(source)
    )
      return invalid('context.memory.pendingSources');
    pendingIds.add(source.sourceMessageId);
  }
  const targets = new Set(memory.reviewTargetMessageIds);
  if (
    !targets.has(current.sourceMessageId) ||
    targets.size !== pendingIds.size + 1 ||
    [...pendingIds].some((id) => !targets.has(id))
  )
    return invalid('context.memory.reviewTargetMessageIds');
  // Review targets may include reconsidered non-pending sources. Their count is
  // not a count of all pending sources. Uncovered pending evidence must narrow.
  if (coverage.pendingWorkingSourceCount > targets.size) return invalid('context.memory.coverage');
  const historyIds = new Set<string>();
  for (const turn of history) {
    if (
      historyIds.has(turn.messageId) ||
      turn.messageId === current.sourceMessageId ||
      turn.sourceSequence >= current.sourceSequence
    )
      return invalid('context.history');
    historyIds.add(turn.messageId);
    if (turn.role === 'user') {
      if (!addSource(sourceOf(turn))) return invalid('context.history.provenance');
    } else {
      const owner = sequences.get(turn.sourceSequence);
      if (sources.has(turn.messageId) || (owner && owner !== turn.messageId))
        return invalid('context.history');
      sequences.set(turn.sourceSequence, turn.messageId);
    }
  }
  for (const item of memory.items) {
    for (const relation of item.relations) {
      const target = itemMap.get(relation.target.memoryId);
      if (
        !target ||
        target.revision !== relation.target.expectedRevision ||
        target.sourceSequence >= item.sourceSequence
      )
        return invalid('context.memory.items.relations');
    }
  }
  const carriedSources = new Set<string>();
  for (const id of workingContext.carryMemoryIds) {
    const item = itemMap.get(id);
    if (!item) return invalid('context.memory.workingContext.carryMemoryIds');
    carriedSources.add(item.sourceMessageId);
  }
  const boundary = workingContext.afterSequence;
  if (boundary !== null) {
    if (current.sourceSequence <= boundary)
      return invalid('context.memory.workingContext.afterSequence');
    for (const source of sources.values()) {
      if (source.sourceSequence <= boundary && !carriedSources.has(source.sourceMessageId))
        return invalid('context.memory.workingContext');
    }
    if (history.some((turn) => turn.role === 'assistant' && turn.sourceSequence <= boundary))
      return invalid('context.history.workingContext');
  }
  return { ok: true, value };
}

/** First-acceptance frozen membership checks. Do not run current-state checks
 * before the stored acceptance fingerprint lookup on an exact retry. This does
 * not verify a claimed source against the retained SQLite original. */
export function checkMemoryResponseForRequest(
  value: unknown,
  request: AssistantTurnRequest,
): ContractCheck<AssistantTurnResponse> {
  const requestCheck = checkMemoryRequest(request);
  if (!requestCheck.ok) return requestCheck;
  if (!validateAssistantTurnResponse(value)) return invalid('response', 'invalid_model_result');
  if (assistantJsonByteLength(value) > MAX_ASSISTANT_BODY_BYTES)
    return invalid('response', 'too_large');
  for (const key of [
    'apiVersion',
    'requestId',
    'userIntentId',
    'intentRevision',
    'conversationId',
    'conversationGeneration',
    'connectionGeneration',
  ] as const) {
    if (value[key] !== request[key]) return invalid(`response.${key}`, 'stale_context');
  }
  if (
    !equal(value.catalogue, request.catalogue) ||
    value.preferenceRevision !== request.context.preferences.revision
  )
    return invalid('response.context', 'stale_context');
  if (value.kind === 'error') return { ok: true, value };
  const { memory } = request.context;
  const update = value.memoryUpdate;
  if (
    update.baseRevision !== memory.projectionRevision ||
    update.baseContextRevision !== memory.baseContextRevision
  )
    return invalid('memoryUpdate.baseRevision', 'stale_context');
  const sources = new Map(
    [sourceOf(request.message), ...memory.pendingSources].map((source) => [
      source.sourceMessageId,
      source,
    ]),
  );
  const reviews = new Map<string, string>();
  for (const review of update.reviews) {
    if (
      !memory.reviewTargetMessageIds.includes(review.sourceMessageId) ||
      reviews.has(review.sourceMessageId)
    )
      return invalid('memoryUpdate.reviews', 'invalid_model_result');
    reviews.set(review.sourceMessageId, review.disposition);
  }
  if (reviews.size !== memory.reviewTargetMessageIds.length)
    return invalid('memoryUpdate.reviews', 'invalid_model_result');
  if (value.kind !== 'clarification' && [...reviews.values()].includes('unresolved'))
    return invalid('memoryUpdate.unresolved', 'invalid_model_result');
  const entries = new Map(update.entries.map((entry) => [entry.sourceMessageId, entry]));
  if (
    entries.size !== update.entries.length ||
    entries.size !== [...reviews.values()].filter((disposition) => disposition === 'retain').length
  )
    return invalid('memoryUpdate.entries', 'invalid_model_result');
  const selected = new Map(memory.items.map((item) => [item.memoryId, item]));
  for (const entry of update.entries) {
    const source = sources.get(entry.sourceMessageId);
    if (!source || reviews.get(entry.sourceMessageId) !== 'retain' || entry.quote !== source.quote)
      return invalid('memoryUpdate.entries.quote', 'invalid_model_result');
    for (const relation of entry.relations) {
      let target: UserMemorySource | undefined;
      if (relation.target.kind === 'memory') {
        const item = selected.get(relation.target.memoryId);
        if (!item || item.revision !== relation.target.expectedRevision)
          return invalid('memoryUpdate.entries.relations', 'invalid_model_result');
        target = item;
      } else if (entries.has(relation.target.sourceMessageId)) {
        target = sources.get(relation.target.sourceMessageId);
      }
      if (!target || target.sourceSequence >= source.sourceSequence)
        return invalid('memoryUpdate.entries.relations', 'invalid_model_result');
    }
  }
  return { ok: true, value };
}

// Equality at the withdrawal revision allows a new explicit temporary constraint.
export function sourcePredatesPreferenceRemoval(
  sourceRevision: number,
  lastRemovalRevision: number | null,
): boolean {
  return lastRemovalRevision !== null && sourceRevision < lastRemovalRevision;
}
