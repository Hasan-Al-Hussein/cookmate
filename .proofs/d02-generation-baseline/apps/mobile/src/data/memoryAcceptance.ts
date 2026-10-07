import { checkMemoryResponseForRequest } from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  CatalogueBoundary,
  NormalAssistantTurnResponse,
} from '@cookmate/contracts';
import type { CommandPlatform, ConversationHeader } from '@cookmate/domain';
import { equivalentJson } from './assistantIntentRecords';
import { rejectCommand } from './commandExecutor';
import {
  completeMemoryGroups,
  hydrateMemoryItems,
  readMemoryGraph,
  readMemoryState,
  verifySuppliedUserSources,
} from './memoryRecords';
import { runBound, StorageFault } from './sql';
import type { SqlSession } from './sql';

/** Validate the entire sidecar and original USER evidence before assigning any app memory ID. */
export async function applyAcceptedMemory(
  session: SqlSession,
  header: ConversationHeader,
  request: AssistantTurnRequest,
  response: NormalAssistantTurnResponse,
  catalogue: CatalogueBoundary,
  platform: Pick<CommandPlatform, 'newId'>,
): Promise<void> {
  const check = checkMemoryResponseForRequest(response, request);
  if (!check.ok) rejectCommand(check.error.code, check.error.messageKey);
  const state = await readMemoryState(session, header);
  const memory = request.context.memory;
  if (
    state.projectionRevision !== memory.projectionRevision ||
    !equivalentJson(state.workingContext, memory.workingContext)
  )
    rejectCommand('stale_context', 'conversation.memory_changed');
  const current = request.message;
  await verifySuppliedUserSources(
    session,
    header,
    [
      {
        sourceMessageId: current.messageId,
        quote: current.text,
        sourceSequence: current.sourceSequence,
        sourceDateContext: current.sourceDateContext,
        preferenceRevisionAtSource: current.preferenceRevisionAtSource,
        preferenceLinks: current.preferenceLinks,
      },
      ...memory.pendingSources,
    ],
    catalogue,
  );
  const graph = await readMemoryGraph(session, header, catalogue);
  const actual = await hydrateMemoryItems(
    session,
    header,
    graph,
    memory.items.map((item) => item.memoryId),
    catalogue,
  );
  if (!equivalentJson(actual, memory.items))
    rejectCommand('stale_context', 'conversation.memory_changed');
  for (const review of response.memoryUpdate.reviews) {
    const row = (
      await session.all<{ disposition: string; revision: number }>(
        'SELECT disposition,revision FROM memory_source_review WHERE message_id=?',
        [review.sourceMessageId],
      )
    )[0];
    if (
      !row ||
      !['pending', 'unresolved', 'non_memory'].includes(row.disposition) ||
      [...graph.values()].some((node) => node.sourceMessageId === review.sourceMessageId)
    )
      rejectCommand('stale_context', 'conversation.source_review_changed');
    if (!Number.isSafeInteger(row.revision + 1))
      throw new StorageFault('storage_failure', 'Memory revision exhausted');
  }
  const projectionRevision = state.projectionRevision + 1;
  if (!Number.isSafeInteger(projectionRevision))
    throw new StorageFault('storage_failure', 'Memory revision exhausted');
  const ids = new Map(
    response.memoryUpdate.entries.map((entry) => [entry.sourceMessageId, platform.newId()]),
  );
  for (const entry of response.memoryUpdate.entries) {
    await runBound(session, 'INSERT INTO memory_entry VALUES (?, ?, ?, ?, ?)', [
      ids.get(entry.sourceMessageId)!,
      entry.sourceMessageId,
      1,
      entry.kind,
      JSON.stringify(entry.scope),
    ]);
  }
  for (const entry of response.memoryUpdate.entries) {
    for (const [ordinal, relation] of entry.relations.entries()) {
      const targetId =
        relation.target.kind === 'source'
          ? ids.get(relation.target.sourceMessageId)!
          : relation.target.memoryId;
      const targetRevision =
        relation.target.kind === 'source' ? 1 : relation.target.expectedRevision;
      await runBound(session, 'INSERT INTO memory_relation VALUES (?, ?, ?, ?, ?)', [
        ids.get(entry.sourceMessageId)!,
        ordinal,
        targetId,
        relation.kind,
        targetRevision,
      ]);
    }
  }
  for (const review of response.memoryUpdate.reviews)
    await runBound(
      session,
      'UPDATE memory_source_review SET disposition=?,revision=revision+1 WHERE message_id=?',
      [review.disposition, review.sourceMessageId],
    );
  let carry = state.workingContext.carryMemoryIds;
  if (carry.length) {
    carry = completeMemoryGroups(await readMemoryGraph(session, header, catalogue), carry);
    if (carry.length > 32) rejectCommand('too_large', 'conversation.scope_limit');
  }
  await runBound(
    session,
    'UPDATE conversation_memory_state SET projection_revision=?,carry_memory_ids_json=? WHERE conversation_id=?',
    [projectionRevision, JSON.stringify(carry), header.conversationId],
  );
}
