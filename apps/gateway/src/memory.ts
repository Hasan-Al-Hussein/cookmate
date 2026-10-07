import { validateModelMemoryUpdate } from '@cookmate/contracts';
import type { AssistantTurnRequest, MemoryUpdate } from '@cookmate/contracts';
import { gatewayError } from './errors';

/** A local clarification has not reviewed meaning. Keep every supplied source pending. */
export function unresolvedMemoryUpdate(request: AssistantTurnRequest): MemoryUpdate {
  const [first, ...rest] = request.context.memory.reviewTargetMessageIds;
  return {
    baseRevision: request.context.memory.projectionRevision,
    baseContextRevision: request.context.memory.baseContextRevision,
    reviews: [
      { sourceMessageId: first, disposition: 'unresolved' },
      ...rest.map((sourceMessageId) => ({
        sourceMessageId,
        disposition: 'unresolved' as const,
      })),
    ],
    entries: [],
  };
}

/** Quote expansion uses only disclosed frozen USER originals, never model-authored text. */
export function expandMemoryUpdate(value: unknown, request: AssistantTurnRequest): MemoryUpdate {
  if (!validateModelMemoryUpdate(value)) throw gatewayError('invalid_model_result', 502, 'never');
  const quotes = new Map([
    [request.message.messageId, request.message.text],
    ...request.context.memory.pendingSources.map(
      (source) => [source.sourceMessageId, source.quote] as const,
    ),
  ]);
  return {
    ...structuredClone(value),
    entries: value.entries.map((entry) => {
      const quote = quotes.get(entry.sourceMessageId);
      if (quote === undefined) throw gatewayError('invalid_model_result', 502, 'never');
      return { ...structuredClone(entry), quote };
    }),
  };
}
