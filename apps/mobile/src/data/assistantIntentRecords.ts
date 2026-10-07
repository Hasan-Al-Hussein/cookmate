import {
  checkAssistantRequest,
  checkAssistantResponse,
  checkLocalCommand,
  isRelativeDateContextCurrent,
  isResponseCurrent,
  matchOperationReceipt,
  validateCommandResult,
} from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  CatalogueBoundary,
  CommandResult,
  PendingIntent,
} from '@cookmate/contracts';
import type {
  IntentGuardSnapshot,
  StoredAssistantIntent,
  AuthorizedActionPlan,
} from '@cookmate/domain';
import {
  isAppId,
  isRevision,
  parseStoredIntent,
  requireConversationRecord,
} from './conversationRecords';
import { readReceiptInSnapshot } from './stateRepositories';
import type { SqlSession } from './sql';
import { readActionPlanInSnapshot } from './actionPlanRecords';

import {
  isIntentGuard,
  parseBoundedJson,
  equivalentJson,
  record,
} from './assistantRecordValidation';
export {
  isIntentGuard,
  parseBoundedJson,
  equivalentJson,
  utf8Length,
  isDateContext,
} from './assistantRecordValidation';
export interface AssistantIntentRecord {
  actionPlan: AuthorizedActionPlan | null;
  acceptanceEnvelope: { assistantMessageId: string; expectedIntentRevision: number };
  intent: PendingIntent;
  request: AssistantTurnRequest;
  response: AssistantTurnResponse | null;
  guards: IntentGuardSnapshot | null;
  slotResults: { slotId: string; result: CommandResult }[];
  lifecycle: 'awaiting_response' | 'accepted' | 'failed' | 'cancelled';
  contextRevision: number;
}

export function publicAssistantIntent(record: AssistantIntentRecord): StoredAssistantIntent {
  const { intent, request, response, guards, slotResults, acceptanceEnvelope, actionPlan } = record;
  return { intent, request, response, guards, slotResults, acceptanceEnvelope, actionPlan };
}

/** Every persisted nested value is bounded and revalidated; JSON validity alone is insufficient. */
export async function readAssistantIntentInSnapshot(
  session: SqlSession,
  catalogue: CatalogueBoundary,
  userIntentId: string,
): Promise<AssistantIntentRecord | null> {
  const row = (
    await session.all<{
      userIntentId: string;
      revision: number;
      phase: string;
      intentJson: string;
      schemaVersion: number;
      lifecycle: AssistantIntentRecord['lifecycle'];
      contextRevision: number;
      requestJson: string;
      responseJson: string | null;
      guardsJson: string | null;
      slotResultsJson: string;
    }>(
      `SELECT p.user_intent_id AS userIntentId, p.revision, p.phase, p.intent_json AS intentJson,
    a.schema_version AS schemaVersion, a.lifecycle, a.context_revision AS contextRevision,
    a.request_json AS requestJson, a.response_json AS responseJson, a.guards_json AS guardsJson, a.slot_results_json AS slotResultsJson
    FROM pending_intent p JOIN assistant_intent_context a ON a.user_intent_id = p.user_intent_id WHERE p.user_intent_id = ?`,
      [userIntentId],
    )
  )[0];
  if (!row) return null;
  const envelope = (
    await session.all<{ assistantMessageId: string; expectedIntentRevision: number }>(
      'SELECT assistant_message_id AS assistantMessageId,expected_intent_revision AS expectedIntentRevision FROM assistant_acceptance_envelope WHERE user_intent_id=?',
      [userIntentId],
    )
  )[0];
  requireConversationRecord(
    envelope &&
      isAppId(envelope.assistantMessageId) &&
      envelope.expectedIntentRevision === row.revision,
  );
  requireConversationRecord(
    row.schemaVersion === 1 &&
      isRevision(row.contextRevision) &&
      ['awaiting_response', 'accepted', 'failed', 'cancelled'].includes(row.lifecycle),
  );
  const intent = parseStoredIntent(row.intentJson, row);
  requireConversationRecord(
    new Set(intent.slots.map((slot) => slot.slotId)).size === intent.slots.length &&
      new Set(intent.slots.map((slot) => slot.command.operationId)).size === intent.slots.length &&
      intent.slots.every(
        (slot) =>
          checkLocalCommand(slot.command, catalogue).ok &&
          slot.command.userIntentId === intent.userIntentId &&
          slot.command.intentRevision === intent.revision &&
          equivalentJson(slot.command.origin ?? null, intent.origin ?? null),
      ),
  );
  const request = checkAssistantRequest(parseBoundedJson(row.requestJson), catalogue);
  requireConversationRecord(
    request.ok &&
      request.value.userIntentId === intent.userIntentId &&
      request.value.intentRevision === intent.revision &&
      intent.origin?.conversationId === request.value.conversationId &&
      intent.origin.generation === request.value.conversationGeneration &&
      intent.origin.messageId === request.value.message.messageId,
  );
  const response =
    row.responseJson === null
      ? null
      : checkAssistantResponse(parseBoundedJson(row.responseJson), catalogue);
  requireConversationRecord(
    response === null ||
      (response.ok &&
        isResponseCurrent(response.value, {
          ...request.value,
          preferenceRevision: request.value.context.preferences.revision,
        })),
  );
  const guards: unknown = row.guardsJson === null ? null : parseBoundedJson(row.guardsJson, 4096);
  requireConversationRecord(
    guards === null ||
      (isIntentGuard(guards) &&
        guards.conversationId === request.value.conversationId &&
        guards.conversationGeneration === request.value.conversationGeneration &&
        guards.contextRevision === row.contextRevision &&
        guards.connectionGeneration === request.value.connectionGeneration &&
        guards.preferenceRevision === request.value.context.preferences.revision &&
        isRelativeDateContextCurrent(guards.relativeDateContext, request.value.context.date)),
  );
  const accepted = response?.ok ? response.value : null;
  const actionState = await readActionPlanInSnapshot(
    session,
    userIntentId,
    catalogue,
    request.value,
    accepted,
  );
  const noSlots = intent.slots.length === 0;
  // Both public freeze paths retain a plan. Finalized commands without one are corrupt,
  // never a successful no-plan recovery result or an inventory item safe to skip.
  requireConversationRecord(noSlots || actionState !== null);
  const validLifecycle =
    row.lifecycle === 'awaiting_response'
      ? accepted === null && guards === null && intent.phase === 'awaiting_response' && noSlots
      : row.lifecycle === 'failed'
        ? accepted?.kind === 'error' &&
          guards === null &&
          ['settled', 'cancelled'].includes(intent.phase) &&
          noSlots
        : row.lifecycle === 'cancelled'
          ? ['cancelled', 'reconciling'].includes(intent.phase) &&
            (accepted === null || accepted.kind === 'error' ? guards === null : guards !== null)
          : accepted !== null &&
            guards !== null &&
            ((accepted.kind === 'answer' && intent.phase === 'settled' && noSlots) ||
              (accepted.kind === 'clarification' && intent.phase === 'clarification' && noSlots) ||
              (accepted.kind === 'proposal' &&
                ((intent.phase === 'confirmation' && noSlots) ||
                  (['ready', 'dispatched', 'reconciling', 'settled'].includes(intent.phase) &&
                    (!noSlots || actionState !== null)))));
  requireConversationRecord(validLifecycle);
  const results = parseBoundedJson(row.slotResultsJson);
  requireConversationRecord(
    Array.isArray(results) && results.length <= intent.slots.length && results.length <= 8,
  );
  const slots = new Set<string>();
  const slotResults: AssistantIntentRecord['slotResults'] = [];
  for (const entry of results) {
    requireConversationRecord(
      record(entry) &&
        Object.keys(entry).length === 2 &&
        isAppId(entry.slotId) &&
        !slots.has(entry.slotId) &&
        validateCommandResult(entry.result),
    );
    const slot = intent.slots.find((item) => item.slotId === entry.slotId);
    requireConversationRecord(slot);
    slots.add(entry.slotId);
    if (entry.result.kind === 'receipt') {
      const actual = await readReceiptInSnapshot(
        session,
        entry.result.receipt.operationId,
        catalogue,
      );
      requireConversationRecord(
        actual &&
          matchOperationReceipt(slot.command, actual) === 'existing' &&
          equivalentJson(actual, entry.result.receipt),
      );
      slotResults.push({ slotId: entry.slotId, result: { kind: 'receipt', receipt: actual } });
    } else {
      requireConversationRecord(
        entry.result.operationId === slot.command.operationId &&
          (entry.result.kind !== 'failed' ||
            entry.result.error.operationId === undefined ||
            entry.result.error.operationId === slot.command.operationId),
      );
      slotResults.push({ slotId: entry.slotId, result: entry.result });
    }
  }
  return {
    actionPlan: actionState?.plan ?? null,
    acceptanceEnvelope: { ...envelope },
    intent,
    request: request.value,
    response: response?.ok ? response.value : null,
    guards,
    slotResults,
    lifecycle: row.lifecycle,
    contextRevision: row.contextRevision,
  };
}
