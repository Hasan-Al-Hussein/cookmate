import {
  checkAssistantRequest,
  checkAssistantResponse,
  checkLocalCommand,
  isResponseCurrent,
  validateCommandResult,
  validatePreferenceSnapshot,
} from '@cookmate/contracts';
import type { CatalogueBoundary, ClearConversationCommand } from '@cookmate/contracts';
import type { CommandPlatform, DirectActionConsequences } from '@cookmate/domain';
import { validateReceiptSemantics } from '@cookmate/domain';
import { readAcceptanceInSnapshot } from './acceptanceRecords';
import { validateAuthorizedActionPlan } from './actionPlanRecords';
import {
  equivalentJson,
  isDateContext,
  isIntentGuard,
  parseBoundedJson,
} from './assistantRecordValidation';
import { rejectCommand } from './commandExecutor';
import {
  isRevision,
  isAppId,
  parseStoredIntent,
  readConversationHeader,
  readMessagesInSnapshot,
  requireConversationRecord,
} from './conversationRecords';
import { completeMemoryGroups, readMemoryGraph, readMemoryState } from './memoryRecords';
import { decodeStoredText } from './storedText';
import type { SqlSession } from './sql';

export interface ConversationClearOptions extends Pick<CommandPlatform, 'sha256'> {
  catalogue: CatalogueBoundary;
}
type ClearConsequences = Extract<DirectActionConsequences, { kind: 'conversation_clear' }>;

/** Receipts survive clear, including damaged historical proof. Bind it without repairing it. */
async function readReceiptEvidence(
  session: SqlSession,
  operationId: string,
  catalogue: CatalogueBoundary,
) {
  const row = (
    await session.all<{
      operationId: string;
      userIntentId: string;
      payloadFingerprint: string;
      outcome: string;
      committedAt: string;
      shoppingProjection: string;
      effectsJson: string;
    }>(
      `SELECT operation_id AS operationId,user_intent_id AS userIntentId,payload_fingerprint AS payloadFingerprint,
     outcome,committed_at AS committedAt,shopping_projection AS shoppingProjection,effects_json AS effectsJson
     FROM operation_receipt WHERE operation_id=?`,
      [operationId],
    )
  )[0];
  if (!row) return null;
  const { effectsJson, ...fields } = row;
  const value = { schemaVersion: 1, ...fields, effects: parseBoundedJson(effectsJson) };
  return { value, valid: validateReceiptSemantics(value, catalogue) };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

/** Private, exact authority over only the rows that a conversation clear removes or resets. */
export async function readConversationClearScope(
  session: SqlSession,
  options: ConversationClearOptions,
) {
  const header = await readConversationHeader(session);
  const messages = await readMessagesInSnapshot(
    session,
    options.catalogue,
    header,
    header.nextSequence,
    header.nextSequence,
  );
  const total = (
    await session.all<{ count: number }>(
      'SELECT COUNT(*) AS count FROM message WHERE conversation_id=?',
      [header.conversationId],
    )
  )[0]!.count;
  requireConversationRecord(total === messages.length);
  const userIds = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.messageId);
  const contextRows = await session.all<{
    messageId: string;
    dateJson: string;
    preferenceRevision: number;
  }>(
    `SELECT c.message_id AS messageId,c.source_date_context_json AS dateJson,c.preference_revision_at_source AS preferenceRevision
     FROM message_context c JOIN message m ON m.message_id=c.message_id WHERE m.conversation_id=? ORDER BY c.message_id`,
    [header.conversationId],
  );
  const sources = contextRows.map(({ dateJson, ...context }) => {
    const date = parseBoundedJson(dateJson, 4096);
    requireConversationRecord(
      userIds.includes(context.messageId) &&
        isDateContext(date) &&
        isRevision(context.preferenceRevision),
    );
    return { ...context, date };
  });
  requireConversationRecord(sources.length === userIds.length);
  const memory = await readMemoryState(session, header);
  const graph = await readMemoryGraph(session, header, options.catalogue);
  requireConversationRecord(
    equivalentJson(
      completeMemoryGroups(graph, memory.workingContext.carryMemoryIds),
      [...memory.workingContext.carryMemoryIds].sort(),
    ),
  );
  const reviews = await session.all<{ messageId: string; disposition: string; revision: number }>(
    `SELECT r.message_id AS messageId,r.disposition,r.revision FROM memory_source_review r
     JOIN message m ON m.message_id=r.message_id WHERE m.conversation_id=? ORDER BY r.message_id`,
    [header.conversationId],
  );
  const retainedSources = new Set([...graph.values()].map((node) => node.sourceMessageId));
  requireConversationRecord(
    reviews.every(
      (row) =>
        userIds.includes(row.messageId) &&
        isRevision(row.revision) &&
        ['pending', 'retain', 'non_memory', 'unresolved'].includes(row.disposition) &&
        (row.disposition === 'retain') === retainedSources.has(row.messageId),
    ),
  );
  const sourceReceiptLinks = await session.all<{
    messageId: string;
    preferenceId: string;
    savedRevision: number;
    operationId: string;
    type: string;
    value: string;
    removedRevision: number | null;
  }>(
    `SELECT l.source_message_id AS messageId,l.preference_id AS preferenceId,l.saved_revision AS savedRevision,l.save_operation_id AS operationId,
     l.type,l.value,l.removed_revision AS removedRevision
     FROM source_preference_link l JOIN message m ON m.message_id=l.source_message_id
     WHERE m.conversation_id=? ORDER BY l.source_message_id,l.preference_id,l.saved_revision`,
    [header.conversationId],
  );
  for (const link of sourceReceiptLinks) {
    link.value = decodeStoredText(link.value);
    requireConversationRecord(
      userIds.includes(link.messageId) &&
        isAppId(link.operationId) &&
        (link.removedRevision === null || isRevision(link.removedRevision)) &&
        validatePreferenceSnapshot({
          revision: link.savedRevision,
          lastRemovalRevision: null,
          items: [
            {
              preferenceId: link.preferenceId,
              type: link.type,
              value: link.value,
              revision: link.savedRevision,
            },
          ],
        }),
    );
  }
  const sourceReceipts = [];
  for (const operationId of [...new Set(sourceReceiptLinks.map((link) => link.operationId))].sort())
    sourceReceipts.push({
      operationId,
      evidence: await readReceiptEvidence(session, operationId, options.catalogue),
    });
  const attached = await session.all<{
    userIntentId: string;
    revision: number;
    phase: string;
    intentJson: string;
  }>(
    `SELECT user_intent_id AS userIntentId,revision,phase,intent_json AS intentJson FROM pending_intent
     WHERE json_extract(intent_json, '$.origin.conversationId')=?
       OR user_intent_id IN (SELECT user_intent_id FROM assistant_intent_context)
     ORDER BY user_intent_id`,
    [header.conversationId],
  );
  let pendingProposalCount: number | null = 0;
  let outstandingRequestCount = 0;
  const intents = [];
  for (const row of attached) {
    const intent = parseStoredIntent(row.intentJson, row);
    const context = (
      await session.all<{
        schemaVersion: number;
        lifecycle: string;
        contextRevision: number;
        requestJson: string;
        responseJson: string | null;
        guardsJson: string | null;
        slotResultsJson: string;
      }>(
        `SELECT schema_version AS schemaVersion,lifecycle,context_revision AS contextRevision,request_json AS requestJson,
       response_json AS responseJson,guards_json AS guardsJson,slot_results_json AS slotResultsJson
       FROM assistant_intent_context WHERE user_intent_id=?`,
        [row.userIntentId],
      )
    )[0];
    const request = context
      ? checkAssistantRequest(parseBoundedJson(context.requestJson), options.catalogue)
      : null;
    const response = context?.responseJson
      ? checkAssistantResponse(parseBoundedJson(context.responseJson), options.catalogue)
      : null;
    const guards = context?.guardsJson ? parseBoundedJson(context.guardsJson, 4096) : null;
    const results = context ? parseBoundedJson(context.slotResultsJson) : null;
    if (context)
      requireConversationRecord(
        context.schemaVersion === 1 &&
          isRevision(context.contextRevision) &&
          ['awaiting_response', 'accepted', 'failed', 'cancelled'].includes(context.lifecycle) &&
          request?.ok &&
          request.value.userIntentId === intent.userIntentId &&
          request.value.intentRevision === intent.revision &&
          equivalentJson(intent.origin, {
            conversationId: request.value.conversationId,
            generation: request.value.conversationGeneration,
            messageId: request.value.message.messageId,
          }) &&
          (response === null ||
            (response.ok &&
              isResponseCurrent(response.value, {
                ...request.value,
                preferenceRevision: request.value.context.preferences.revision,
              }))) &&
          (guards === null || isIntentGuard(guards)) &&
          Array.isArray(results) &&
          results.length <= intent.slots.length &&
          results.every(
            (value) =>
              value !== null &&
              typeof value === 'object' &&
              Object.keys(value).length === 2 &&
              isAppId(value.slotId) &&
              validateCommandResult(value.result),
          ),
      );
    const planRow = (
      await session.all<{ planJson: string; guardsJson: string; cursor: number }>(
        'SELECT plan_json AS planJson,guards_json AS guardsJson,cursor FROM assistant_action_plan WHERE user_intent_id=?',
        [row.userIntentId],
      )
    )[0];
    const plan = planRow ? parseBoundedJson(planRow.planJson) : null;
    const planGuards = planRow ? parseBoundedJson(planRow.guardsJson, 4096) : null;
    if (planRow)
      requireConversationRecord(
        request?.ok &&
          validateAuthorizedActionPlan(
            plan,
            request.value,
            response?.ok ? response.value : null,
            options.catalogue,
          ) &&
          isIntentGuard(planGuards) &&
          isRevision(planRow.cursor) &&
          planRow.cursor <= plan.slots.length,
      );
    const envelope = await session.all<{
      assistantMessageId: string;
      expectedIntentRevision: number;
    }>(
      'SELECT assistant_message_id AS assistantMessageId,expected_intent_revision AS expectedIntentRevision FROM assistant_acceptance_envelope WHERE user_intent_id=?',
      [row.userIntentId],
    );
    requireConversationRecord(
      envelope.every(
        (value) => isAppId(value.assistantMessageId) && isRevision(value.expectedIntentRevision),
      ),
    );
    const acceptance = await readAcceptanceInSnapshot(
      session,
      row.userIntentId,
      options.catalogue,
      options,
    );
    const slots = await session.all<{
      slotId: string;
      position: number;
      operationId: string;
      commandJson: string;
    }>(
      'SELECT slot_id AS slotId,position,operation_id AS operationId,command_json AS commandJson FROM command_slot WHERE user_intent_id=? ORDER BY position',
      [row.userIntentId],
    );
    requireConversationRecord(slots.length === intent.slots.length);
    const receipts = [];
    for (const [index, slot] of slots.entries()) {
      const command = parseBoundedJson(slot.commandJson);
      requireConversationRecord(
        checkLocalCommand(command, options.catalogue).ok &&
          slot.position === index &&
          equivalentJson(intent.slots[index], { slotId: slot.slotId, command }),
      );
      const frozen = intent.slots[index]!.command;
      requireConversationRecord(
        slot.operationId === frozen.operationId &&
          frozen.userIntentId === intent.userIntentId &&
          frozen.intentRevision === intent.revision &&
          equivalentJson(frozen.origin ?? null, intent.origin ?? null),
      );
      const receipt = await readReceiptEvidence(session, frozen.operationId, options.catalogue);
      if (receipt)
        receipt.valid =
          receipt.valid &&
          receipt.value.userIntentId === frozen.userIntentId &&
          receipt.value.payloadFingerprint === frozen.payloadFingerprint;
      receipts.push(receipt);
    }
    const plannedReceipts = [];
    if (
      request?.ok &&
      validateAuthorizedActionPlan(
        plan,
        request.value,
        response?.ok ? response.value : null,
        options.catalogue,
      )
    )
      for (const slot of plan.slots)
        plannedReceipts.push(
          await readReceiptEvidence(session, slot.operationId, options.catalogue),
        );
    if (context?.lifecycle === 'awaiting_response') outstandingRequestCount++;
    if (
      context?.lifecycle === 'accepted' &&
      response?.ok &&
      response.value.kind === 'proposal' &&
      !['settled', 'cancelled'].includes(intent.phase)
    ) {
      // Missing historical prefix proof must not prevent clearing private conversation data.
      // An unverifiable active group gets an unknown count, never invented completion evidence.
      if (
        planRow &&
        (receipts.some((receipt) => receipt !== null && !receipt.valid) ||
          plannedReceipts.some(
            (receipt, index) =>
              (receipt !== null && !receipt.valid) || index < planRow.cursor !== (receipt !== null),
          ))
      )
        pendingProposalCount = null;
      else if (
        pendingProposalCount !== null &&
        (planRow === undefined || planRow.cursor < plannedReceipts.length)
      )
        pendingProposalCount++;
    }
    const reviewGuards = await session.all<{
      operationId: string;
      planRevision: number;
      shoppingScopeRevision: number;
    }>(
      `SELECT g.operation_id AS operationId,g.plan_revision AS planRevision,g.shopping_scope_revision AS shoppingScopeRevision
       FROM command_review_guard g JOIN command_slot s ON s.operation_id=g.operation_id WHERE s.user_intent_id=? ORDER BY g.operation_id`,
      [row.userIntentId],
    );
    requireConversationRecord(
      reviewGuards.every(
        (guard) => isRevision(guard.planRevision) && isRevision(guard.shoppingScopeRevision),
      ),
    );
    intents.push({
      intent,
      context: context
        ? {
            schemaVersion: context.schemaVersion,
            lifecycle: context.lifecycle,
            contextRevision: context.contextRevision,
            request: request?.ok ? request.value : null,
            response: response?.ok ? response.value : null,
            guards,
            results,
          }
        : null,
      plan,
      planGuards,
      cursor: planRow?.cursor ?? null,
      envelope,
      acceptance,
      receipts,
      plannedReceipts,
      reviewGuards,
    });
  }
  const scope: ClearConsequences['scope'] = {
    draftCharacterCount: [...header.composerDraft].length,
    referenceSetCount: messages.reduce((count, message) => count + message.referenceSets.length, 0),
    contextItemCount: graph.size,
    pendingProposalCount,
    outstandingRequestCount,
    hasAnythingToClear:
      header.composerDraft.length > 0 ||
      messages.length > 0 ||
      attached.length > 0 ||
      header.nextSequence > 0 ||
      memory.projectionRevision > 0 ||
      memory.workingContext.afterSequence !== null ||
      memory.workingContext.carryMemoryIds.length > 0 ||
      graph.size > 0,
  };
  const fingerprint = await options.sha256(
    canonicalJson({
      version: 1,
      header,
      messages,
      sources,
      memory,
      graph: [...graph.values()].sort((a, b) =>
        a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0,
      ),
      reviews,
      sourceReceiptLinks,
      sourceReceipts,
      intents,
    }),
  );
  requireConversationRecord(/^[0-9a-f]{64}$/.test(fingerprint));
  return {
    header,
    fingerprint,
    scope,
    messageCount: messages.length,
    attachedIntentIds: attached.map((row) => row.userIntentId),
  };
}

export async function requireReviewedConversationClear(
  session: SqlSession,
  command: ClearConversationCommand,
  options: ConversationClearOptions,
) {
  if (!command.expectedScopeFingerprint)
    rejectCommand('stale_context', 'conversation.clear_changed');
  const current = await readConversationClearScope(session, options);
  if (
    current.header.conversationId !== command.conversationId ||
    current.header.generation !== command.expectedGeneration ||
    current.fingerprint !== command.expectedScopeFingerprint
  )
    rejectCommand('stale_context', 'conversation.clear_changed');
  return current;
}
