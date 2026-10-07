import {
  checkLocalCommand,
  isRelativeDateContextCurrent,
  matchOperationReceipt,
} from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  CatalogueBoundary,
  LocalCommand,
  PendingIntent,
} from '@cookmate/contracts';
import type {
  AuthorizedActionPlan,
  AuthorizedSlotPlan,
  IntentGuardSnapshot,
} from '@cookmate/domain';
import { equivalentJson, isIntentGuard, parseBoundedJson } from './assistantRecordValidation';
import {
  isAppId,
  isRevision,
  parseStoredIntent,
  requireConversationRecord,
} from './conversationRecords';
import { readReceiptInSnapshot } from './stateRepositories';
import type { SqlSession } from './sql';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

export function plannedCommand(
  plan: AuthorizedActionPlan,
  slot: AuthorizedSlotPlan,
  preferenceRevision: number,
): LocalCommand {
  return {
    schemaVersion: 2,
    operationId: slot.operationId,
    userIntentId: plan.userIntentId,
    intentRevision: plan.revision,
    origin: plan.origin,
    ...(slot.payload.kind === 'addPlan' && plan.relativeDateGuard
      ? { relativeDateGuard: plan.relativeDateGuard }
      : {}),
    command:
      slot.payload.kind === 'savePreference'
        ? { ...slot.payload, expectedPreferenceRevision: preferenceRevision }
        : slot.payload,
    payloadFingerprint: '0'.repeat(64),
  };
}

/** Proposal matching is structural; caller IDs and payloads never widen the accepted response. */
export function validateAuthorizedActionPlan(
  value: unknown,
  request: AssistantTurnRequest,
  response: AssistantTurnResponse | null,
  catalogue: CatalogueBoundary,
): value is AuthorizedActionPlan {
  if (
    !object(value) ||
    !keys(value, ['userIntentId', 'revision', 'origin', 'slots'], ['relativeDateGuard']) ||
    response?.kind !== 'proposal' ||
    value.userIntentId !== request.userIntentId ||
    value.revision !== request.intentRevision ||
    !equivalentJson(value.origin, {
      conversationId: request.conversationId,
      generation: request.conversationGeneration,
      messageId: request.message.messageId,
    }) ||
    !Array.isArray(value.slots) ||
    value.slots.length !== response.proposals.length ||
    !value.slots.length ||
    value.slots.length > 8
  )
    return false;
  const plan = value as unknown as AuthorizedActionPlan;
  if (value.relativeDateGuard !== undefined) {
    const guard = value.relativeDateGuard;
    if (
      !object(guard) ||
      !keys(guard, ['interpretedAt', 'resolvedDate', 'sourceMessageId']) ||
      guard.sourceMessageId !== request.message.messageId ||
      !equivalentJson(guard.interpretedAt, request.context.date) ||
      !response.proposals.some(
        (proposal) =>
          proposal.kind === 'addPlan' && proposal.placement.actualDate === guard.resolvedDate,
      )
    )
      return false;
  }
  const identities = new Set<string>();
  const placements = new Set<string>();
  for (const [index, candidate] of value.slots.entries()) {
    if (
      !object(candidate) ||
      !keys(candidate, ['slotId', 'operationId', 'proposalIndex', 'payload']) ||
      !isAppId(candidate.slotId) ||
      !isAppId(candidate.operationId) ||
      candidate.proposalIndex !== index ||
      !object(candidate.payload)
    )
      return false;
    const slot = candidate as unknown as AuthorizedSlotPlan;
    const proposal = response.proposals[index]!;
    if (!request.capabilities.includes(proposal.kind)) return false;
    if (response.proposals.slice(0, index).some((earlier) => equivalentJson(earlier, proposal)))
      return false;
    const payload = slot.payload;
    let matches = false;
    if (proposal.kind === 'saveRecipe')
      matches = equivalentJson(payload, {
        kind: 'setFavourite',
        recipeId: proposal.recipeId,
        saved: true,
      });
    else if (proposal.kind === 'savePreference')
      matches =
        payload.kind === 'savePreference' &&
        isAppId(payload.preferenceId) &&
        equivalentJson(payload, {
          kind: 'savePreference',
          preferenceId: payload.preferenceId,
          type: proposal.type,
          explicitValue: proposal.explicitValue,
        });
    else {
      const placement = `${proposal.placement.actualDate}/${proposal.placement.mealKey}`;
      if (placements.has(placement)) return false;
      placements.add(placement);
      matches =
        proposal.expectedTarget.kind === 'empty'
          ? payload.kind === 'addPlan' &&
            isAppId(payload.occurrenceId) &&
            equivalentJson(payload, {
              kind: 'addPlan',
              occurrenceId: payload.occurrenceId,
              recipeId: proposal.recipeId,
              placement: proposal.placement,
              expectedTarget: { kind: 'empty' },
            })
          : payload.kind === 'replacePlanRecipe' &&
            isRevision(payload.expectedShoppingScopeRevision) &&
            equivalentJson(payload, {
              kind: 'replacePlanRecipe',
              occurrenceId: proposal.expectedTarget.occurrenceId,
              expectedRevision: proposal.expectedTarget.expectedRevision,
              expectedShoppingScopeRevision: payload.expectedShoppingScopeRevision,
              recipeId: proposal.recipeId,
              placement: proposal.placement,
            });
    }
    if (
      !matches ||
      !checkLocalCommand(
        plannedCommand(plan, slot, request.context.preferences.revision),
        catalogue,
      ).ok
    )
      return false;
    for (const id of [
      slot.slotId,
      slot.operationId,
      ...(payload.kind === 'savePreference'
        ? [payload.preferenceId]
        : payload.kind === 'addPlan'
          ? [payload.occurrenceId]
          : []),
    ]) {
      if (identities.has(id)) return false;
      identities.add(id);
    }
  }
  return true;
}

export function commandMatchesPlannedSlot(
  command: LocalCommand,
  plan: AuthorizedActionPlan,
  slot: AuthorizedSlotPlan,
): boolean {
  const revision =
    command.command.kind === 'savePreference' ? command.command.expectedPreferenceRevision : 0;
  return equivalentJson(
    { ...command, payloadFingerprint: '0'.repeat(64) },
    plannedCommand(plan, slot, revision),
  );
}

export interface StoredActionPlan {
  plan: AuthorizedActionPlan;
  guards: IntentGuardSnapshot;
  cursor: number;
}

/** No assistant-intent reader call here: that reader delegates this nested record to us. */
export async function readActionPlanInSnapshot(
  session: SqlSession,
  userIntentId: string,
  catalogue: CatalogueBoundary,
  request: AssistantTurnRequest,
  response: AssistantTurnResponse | null,
): Promise<StoredActionPlan | null> {
  const row = (
    await session.all<{ planJson: string; guardsJson: string; cursor: number }>(
      'SELECT plan_json AS planJson, guards_json AS guardsJson, cursor FROM assistant_action_plan WHERE user_intent_id=?',
      [userIntentId],
    )
  )[0];
  if (!row) return null;
  const plan = parseBoundedJson(row.planJson);
  const guards = parseBoundedJson(row.guardsJson, 4096);
  requireConversationRecord(
    validateAuthorizedActionPlan(plan, request, response, catalogue) &&
      isIntentGuard(guards) &&
      isRevision(row.cursor) &&
      row.cursor <= plan.slots.length,
  );
  requireConversationRecord(
    guards.conversationId === request.conversationId &&
      guards.conversationGeneration === request.conversationGeneration &&
      guards.connectionGeneration === request.connectionGeneration &&
      isRelativeDateContextCurrent(guards.relativeDateContext, request.context.date),
  );
  const hasPlan =
    response?.kind === 'proposal' &&
    response.proposals.some((proposal) => proposal.kind === 'addPlan');
  const hasScope =
    response?.kind === 'proposal' &&
    response.proposals.some(
      (proposal) => proposal.kind === 'addPlan' && proposal.expectedTarget.kind === 'occupied',
    );
  requireConversationRecord(
    (guards.planRevision !== undefined) === hasPlan &&
      (guards.shoppingScopeRevision !== undefined) === hasScope,
  );
  const pending = (
    await session.all<{
      userIntentId: string;
      revision: number;
      phase: PendingIntent['phase'];
      intentJson: string;
    }>(
      'SELECT user_intent_id AS userIntentId, revision, phase, intent_json AS intentJson FROM pending_intent WHERE user_intent_id=?',
      [userIntentId],
    )
  )[0];
  requireConversationRecord(pending);
  const intent = parseStoredIntent(pending.intentJson, pending);
  requireConversationRecord(
    row.cursor === plan.slots.length
      ? intent.phase === 'settled'
      : intent.phase === 'ready' || intent.phase === 'cancelled'
        ? row.cursor === 0
        : intent.phase === 'dispatched'
          ? row.cursor > 0
          : intent.phase === 'reconciling',
  );
  const commands = await session.all<{
    slotId: string;
    position: number;
    operationId: string;
    commandJson: string;
  }>(
    'SELECT slot_id AS slotId, position, operation_id AS operationId, command_json AS commandJson FROM command_slot WHERE user_intent_id=? ORDER BY position',
    [userIntentId],
  );
  requireConversationRecord(
    intent.slots.length === commands.length &&
      commands.length >= row.cursor &&
      commands.length <= plan.slots.length &&
      equivalentJson(intent.origin, plan.origin) &&
      equivalentJson(intent.relativeDateGuard ?? null, plan.relativeDateGuard ?? null),
  );
  const context = (
    await session.all<{ resultsJson: string; acceptedGuardsJson: string }>(
      'SELECT slot_results_json AS resultsJson, guards_json AS acceptedGuardsJson FROM assistant_intent_context WHERE user_intent_id=?',
      [userIntentId],
    )
  )[0];
  requireConversationRecord(context);
  const acceptedGuards = parseBoundedJson(context.acceptedGuardsJson, 4096);
  requireConversationRecord(
    isIntentGuard(acceptedGuards) &&
      (row.cursor === 0
        ? equivalentJson(guards, acceptedGuards)
        : guards.contextRevision >= acceptedGuards.contextRevision &&
          guards.preferenceRevision >= acceptedGuards.preferenceRevision &&
          (guards.planRevision === undefined ||
            guards.planRevision >= acceptedGuards.planRevision!) &&
          (guards.shoppingScopeRevision === undefined ||
            guards.shoppingScopeRevision >= acceptedGuards.shoppingScopeRevision!)),
  );
  const results = parseBoundedJson(context.resultsJson);
  requireConversationRecord(Array.isArray(results));
  for (const [index, stored] of commands.entries()) {
    const command = parseBoundedJson(stored.commandJson);
    const slot = plan.slots[index]!;
    requireConversationRecord(
      checkLocalCommand(command, catalogue).ok &&
        stored.position === index &&
        stored.slotId === slot.slotId &&
        stored.operationId === slot.operationId &&
        equivalentJson(intent.slots[index], { slotId: stored.slotId, command }) &&
        commandMatchesPlannedSlot(command as LocalCommand, plan, slot),
    );
    const actual = await readReceiptInSnapshot(session, slot.operationId, catalogue);
    const journal = results.filter(
      (entry: unknown) => object(entry) && entry.slotId === slot.slotId,
    );
    if (index < row.cursor)
      requireConversationRecord(
        actual &&
          matchOperationReceipt(command as LocalCommand, actual) === 'existing' &&
          journal.length === 1 &&
          equivalentJson(journal[0], {
            slotId: slot.slotId,
            result: { kind: 'receipt', receipt: actual },
          }),
      );
    else
      requireConversationRecord(
        actual === null &&
          journal.every(
            (entry: unknown) =>
              object(entry) && object(entry.result) && entry.result.kind !== 'receipt',
          ),
      );
  }
  for (const slot of plan.slots.slice(commands.length)) {
    requireConversationRecord(
      (await readReceiptInSnapshot(session, slot.operationId, catalogue)) === null,
    );
  }
  return { plan, guards, cursor: row.cursor };
}
