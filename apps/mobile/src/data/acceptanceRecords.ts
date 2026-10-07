import {
  acceptanceFingerprintInput,
  checkAssistantRequest,
  checkAssistantResponse,
  validatePendingIntent,
  isResponseCurrent,
  isRelativeDateContextCurrent,
} from '@cookmate/contracts';
import type { CatalogueBoundary } from '@cookmate/contracts';
import type { CommandPlatform, StoredAssistantIntent } from '@cookmate/domain';
import { isIntentGuard, parseBoundedJson, equivalentJson } from './assistantRecordValidation';
import { isAppId, requireConversationRecord } from './conversationRecords';
import type { SqlSession } from './sql';

export async function readAcceptanceInSnapshot(
  session: SqlSession,
  id: string,
  catalogue: CatalogueBoundary,
  platform: Pick<CommandPlatform, 'sha256'>,
): Promise<{ fingerprint: string; acknowledgement: StoredAssistantIntent } | null> {
  const row = (
    await session.all<{ version: string; fingerprint: string; json: string }>(
      'SELECT normalization_version AS version,fingerprint,acknowledgement_json AS json FROM assistant_acceptance WHERE user_intent_id=?',
      [id],
    )
  )[0];
  if (!row) return null;
  requireConversationRecord(
    row.version === 'memory-acceptance-v1' && /^[0-9a-f]{64}$/.test(row.fingerprint),
  );
  const value = parseBoundedJson(row.json, 524288) as StoredAssistantIntent;
  requireConversationRecord(
    value &&
      typeof value === 'object' &&
      Object.keys(value).sort().join(',') ===
        'acceptanceEnvelope,actionPlan,guards,intent,request,response,slotResults' &&
      value.actionPlan === null,
  );
  requireConversationRecord(
    validatePendingIntent(value.intent) &&
      value.intent.userIntentId === id &&
      value.intent.slots.length === 0 &&
      Array.isArray(value.slotResults) &&
      value.slotResults.length === 0,
  );
  const request = checkAssistantRequest(value.request, catalogue);
  const response = checkAssistantResponse(value.response, catalogue);
  requireConversationRecord(
    request.ok &&
      response.ok &&
      response.value.kind !== 'error' &&
      value.guards &&
      isIntentGuard(value.guards) &&
      isAppId(value.acceptanceEnvelope?.assistantMessageId),
  );
  const original = (
    await session.all<{
      guardsJson: string;
      assistantMessageId: string;
      expectedIntentRevision: number;
    }>(
      `SELECT a.guards_json AS guardsJson,e.assistant_message_id AS assistantMessageId,e.expected_intent_revision AS expectedIntentRevision
    FROM assistant_intent_context a JOIN assistant_acceptance_envelope e ON e.user_intent_id=a.user_intent_id WHERE a.user_intent_id=?`,
      [id],
    )
  )[0];
  const expectedPhase =
    response.value.kind === 'proposal'
      ? 'confirmation'
      : response.value.kind === 'clarification'
        ? 'clarification'
        : 'settled';
  const hasPlan =
    response.value.kind === 'proposal' &&
    response.value.proposals.some((proposal) => proposal.kind === 'addPlan');
  const hasScope =
    response.value.kind === 'proposal' &&
    response.value.proposals.some(
      (proposal) => proposal.kind === 'addPlan' && proposal.expectedTarget.kind === 'occupied',
    );
  requireConversationRecord(
    original &&
      equivalentJson(value.acceptanceEnvelope, {
        assistantMessageId: original.assistantMessageId,
        expectedIntentRevision: original.expectedIntentRevision,
      }) &&
      equivalentJson(value.intent, {
        userIntentId: request.value.userIntentId,
        revision: request.value.intentRevision,
        phase: expectedPhase,
        slots: [],
        origin: {
          conversationId: request.value.conversationId,
          generation: request.value.conversationGeneration,
          messageId: request.value.message.messageId,
        },
      }) &&
      isResponseCurrent(response.value, {
        ...request.value,
        preferenceRevision: request.value.context.preferences.revision,
      }) &&
      value.acceptanceEnvelope.expectedIntentRevision === value.intent.revision &&
      equivalentJson(value.guards, parseBoundedJson(original.guardsJson, 4096)) &&
      value.guards.conversationId === request.value.conversationId &&
      value.guards.conversationGeneration === request.value.conversationGeneration &&
      value.guards.connectionGeneration === request.value.connectionGeneration &&
      isRelativeDateContextCurrent(value.guards.relativeDateContext, request.value.context.date) &&
      (value.guards.planRevision !== undefined) === hasPlan &&
      (value.guards.shoppingScopeRevision !== undefined) === hasScope &&
      value.guards.contextRevision >= request.value.context.memory.baseContextRevision + 2 &&
      value.guards.preferenceRevision === request.value.context.preferences.revision,
  );
  const fingerprint = await platform.sha256(
    acceptanceFingerprintInput({
      normalizationVersion: 1,
      frozenRequest: request.value,
      normalizedResponse: response.value,
      envelope: value.acceptanceEnvelope,
    }),
  );
  requireConversationRecord(fingerprint === row.fingerprint);
  return { fingerprint: row.fingerprint, acknowledgement: value };
}
