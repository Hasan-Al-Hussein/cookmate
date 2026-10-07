import {
  checkAssistantResponse,
  checkAssistantRequest,
  checkMemoryResponseForRequest,
  isRelativeDateContextCurrent,
  isResponseCurrent,
  validateAiProposal,
} from '@cookmate/contracts';
import type {
  AiProposal,
  AssistantTurnRequest,
  CommandPayload,
  ContractError,
  PendingIntent,
  ProposalResponse,
  RelativeDateGuard,
} from '@cookmate/contracts';
import { catalogueBoundary } from '@cookmate/catalogue';
import { createCommandPreparer } from '@cookmate/domain';
import type {
  AuthorizedActionPlan,
  CommandPlatform,
  PlannedCommandPayload,
} from '@cookmate/domain';
import type { ActionGuard, CurrentActionState } from './ports';

export class AssistantCoreError extends Error {
  constructor(public readonly detail: ContractError) {
    super(detail.messageKey);
    this.name = 'AssistantCoreError';
  }
}

export function rejectAction(code: ContractError['code'], key: string): never {
  throw new AssistantCoreError({ code, messageKey: `assistant.${key}`, retry: 'after_correction' });
}

export interface ReplacementConfirmation {
  occurrenceId: string;
  expectedRevision: number;
  expectedShoppingScopeRevision: number;
  currentRecipeId: string;
  replacementRecipeId: string;
  includedInShopping: boolean;
  placement: { actualDate: string; mealKey: string };
}

/** Only trusted UI/user-intent code may supply this; model output is never authority. */
export interface ExplicitActionAuthority {
  source: 'explicit_user';
  /** Every exact requested action must be reviewed/authorized; no inferred preference save. */
  proposals: AiProposal[];
  replacementConfirmations: ReplacementConfirmation[];
  relativeDateGuard?: RelativeDateGuard;
}

function proposalKey(proposal: AiProposal): string {
  switch (proposal.kind) {
    case 'saveRecipe':
      return JSON.stringify([proposal.kind, proposal.recipeId]);
    case 'savePreference':
      return JSON.stringify([proposal.kind, proposal.type, proposal.explicitValue]);
    case 'addPlan':
      return JSON.stringify([
        proposal.kind,
        proposal.recipeId,
        proposal.placement.actualDate,
        proposal.placement.mealKey,
        proposal.expectedTarget.kind,
        proposal.expectedTarget.kind === 'occupied' ? proposal.expectedTarget.occurrenceId : null,
        proposal.expectedTarget.kind === 'occupied'
          ? proposal.expectedTarget.expectedRevision
          : null,
      ]);
  }
}

export function assertGuardCurrent(
  expected: ActionGuard,
  current: CurrentActionState,
  connectionGeneration: number,
) {
  const actual = current.guards;
  if (
    expected.conversationId !== actual.conversationId ||
    expected.conversationGeneration !== actual.conversationGeneration ||
    expected.contextRevision !== actual.contextRevision ||
    expected.preferenceRevision !== actual.preferenceRevision ||
    expected.connectionGeneration !== connectionGeneration ||
    expected.connectionGeneration !== actual.connectionGeneration ||
    (expected.planRevision !== undefined && expected.planRevision !== actual.planRevision) ||
    (expected.shoppingScopeRevision !== undefined &&
      expected.shoppingScopeRevision !== current.shoppingScope.revision) ||
    (expected.relativeDateContext &&
      (!actual.relativeDateContext ||
        !isRelativeDateContextCurrent(expected.relativeDateContext, actual.relativeDateContext)))
  )
    rejectAction('stale_context', 'context_changed');
}

/** Pure policy plus app-owned command preparation; no effect happens here. */
export async function prepareAuthorizedActionPlan(
  request: AssistantTurnRequest,
  response: ProposalResponse,
  authority: ExplicitActionAuthority,
  current: CurrentActionState,
  guard: ActionGuard,
  platform: CommandPlatform,
): Promise<AuthorizedActionPlan> {
  // Take ownership before asynchronous hashing; callers cannot change later slots mid-flight.
  request = JSON.parse(JSON.stringify(request)) as AssistantTurnRequest;
  response = JSON.parse(JSON.stringify(response)) as ProposalResponse;
  authority = JSON.parse(JSON.stringify(authority)) as ExplicitActionAuthority;
  current = JSON.parse(JSON.stringify(current)) as CurrentActionState;
  guard = JSON.parse(JSON.stringify(guard)) as ActionGuard;
  const requestCheck = checkAssistantRequest(request, catalogueBoundary);
  if (!requestCheck.ok) throw new AssistantCoreError(requestCheck.error);
  assertGuardCurrent(guard, current, guard.connectionGeneration);
  if (!isRelativeDateContextCurrent(request.context.date, current.guards.relativeDateContext))
    rejectAction('stale_context', 'date_changed');
  const checked = checkAssistantResponse(response, catalogueBoundary);
  if (!checked.ok) throw new AssistantCoreError(checked.error);
  const memory = checkMemoryResponseForRequest(response, request);
  if (!memory.ok) throw new AssistantCoreError(memory.error);
  if (
    guard.preferenceRevision !== request.context.preferences.revision ||
    !isResponseCurrent(response, {
      ...request,
      preferenceRevision: request.context.preferences.revision,
    })
  )
    rejectAction('stale_context', 'response_changed');
  if (
    authority.source !== 'explicit_user' ||
    authority.proposals.length !== response.proposals.length ||
    !authority.proposals.every(
      (proposal, index) =>
        validateAiProposal(proposal) &&
        proposalKey(proposal) === proposalKey(response.proposals[index]!),
    )
  )
    rejectAction('unsupported_request', 'explicit_authority_required');
  if (response.proposals.some((proposal) => !request.capabilities.includes(proposal.kind)))
    rejectAction('unsupported_request', 'capability_not_enabled');
  if (new Set(response.proposals.map(proposalKey)).size !== response.proposals.length)
    rejectAction('invalid_input', 'duplicate_proposal');
  if (
    authority.relativeDateGuard &&
    (!current.guards.relativeDateContext ||
      !isRelativeDateContextCurrent(
        authority.relativeDateGuard.interpretedAt,
        current.guards.relativeDateContext,
      ) ||
      authority.relativeDateGuard.sourceMessageId !== request.message.messageId)
  )
    rejectAction('stale_context', 'date_changed');

  const origin = {
    conversationId: request.conversationId,
    generation: request.conversationGeneration,
    messageId: request.message.messageId,
  };
  const intent: AuthorizedActionPlan = {
    userIntentId: request.userIntentId,
    revision: request.intentRevision,
    origin,
    slots: [],
    ...(authority.relativeDateGuard ? { relativeDateGuard: authority.relativeDateGuard } : {}),
  };
  const placements = new Set<string>();
  for (const [proposalIndex, proposal] of response.proposals.entries()) {
    let payload: PlannedCommandPayload;
    if (proposal.kind === 'saveRecipe')
      payload = { kind: 'setFavourite', recipeId: proposal.recipeId, saved: true };
    else if (proposal.kind === 'savePreference')
      payload = {
        kind: 'savePreference',
        preferenceId: platform.newId(),
        type: proposal.type,
        explicitValue: proposal.explicitValue,
      };
    else {
      const placementKey = `${proposal.placement.actualDate}/${proposal.placement.mealKey}`;
      if (placements.has(placementKey)) rejectAction('invalid_input', 'conflicting_placements');
      placements.add(placementKey);
      const occupants = current.planOccurrences.filter(
        (item) =>
          item.placement.actualDate === proposal.placement.actualDate &&
          item.placement.mealKey === proposal.placement.mealKey,
      );
      if (occupants.length > 1) rejectAction('storage_failure', 'invalid_placement_state');
      const occupant = occupants[0];
      if (proposal.expectedTarget.kind === 'empty') {
        if (occupant) rejectAction('stale_target', 'target_changed');
        payload = {
          kind: 'addPlan',
          occurrenceId: platform.newId(),
          recipeId: proposal.recipeId,
          placement: proposal.placement,
          expectedTarget: { kind: 'empty' },
        };
      } else {
        if (
          !occupant ||
          occupant.occurrenceId !== proposal.expectedTarget.occurrenceId ||
          occupant.revision !== proposal.expectedTarget.expectedRevision
        )
          rejectAction('stale_target', 'target_changed');
        const confirmations = authority.replacementConfirmations.filter(
          (item) => item.occurrenceId === occupant.occurrenceId,
        );
        const confirmation = confirmations[0];
        if (
          confirmations.length !== 1 ||
          !confirmation ||
          confirmation.expectedRevision !== occupant.revision ||
          confirmation.expectedShoppingScopeRevision !== current.shoppingScope.revision ||
          confirmation.currentRecipeId !== occupant.recipeId ||
          confirmation.replacementRecipeId !== proposal.recipeId ||
          confirmation.includedInShopping !==
            current.shoppingScope.occurrenceIds.includes(occupant.occurrenceId) ||
          confirmation.placement.actualDate !== occupant.placement.actualDate ||
          confirmation.placement.mealKey !== occupant.placement.mealKey
        )
          rejectAction('stale_target', 'replacement_confirmation_required');
        payload = {
          kind: 'replacePlanRecipe',
          occurrenceId: occupant.occurrenceId,
          expectedRevision: occupant.revision,
          expectedShoppingScopeRevision: current.shoppingScope.revision,
          recipeId: proposal.recipeId,
          placement: proposal.placement,
        };
      }
    }
    intent.slots.push({
      slotId: platform.newId(),
      operationId: platform.newId(),
      proposalIndex,
      payload,
    });
  }
  return intent;
}

/** Compatibility helper for a batch with at most one preference save. Coordinator uses the
 * durable action plan instead, so every sequential preference revision comes from Data. */
export async function prepareAuthorizedIntent(
  request: AssistantTurnRequest,
  response: ProposalResponse,
  authority: ExplicitActionAuthority,
  current: CurrentActionState,
  guard: ActionGuard,
  platform: CommandPlatform,
): Promise<PendingIntent> {
  const plan = await prepareAuthorizedActionPlan(
    request,
    response,
    authority,
    current,
    guard,
    platform,
  );
  if (plan.slots.filter((slot) => slot.payload.kind === 'savePreference').length > 1)
    rejectAction('unsupported_request', 'durable_action_plan_required');
  const intent: PendingIntent = {
    userIntentId: plan.userIntentId,
    revision: plan.revision,
    origin: plan.origin,
    phase: 'ready',
    slots: [],
    ...(plan.relativeDateGuard ? { relativeDateGuard: plan.relativeDateGuard } : {}),
  };
  for (const slot of plan.slots) {
    const payload: CommandPayload =
      slot.payload.kind === 'savePreference'
        ? { ...slot.payload, expectedPreferenceRevision: guard.preferenceRevision }
        : slot.payload;
    const prepare = createCommandPreparer(
      { ...platform, newId: () => slot.operationId },
      catalogueBoundary,
    );
    const command = await prepare(payload, {
      userIntentId: plan.userIntentId,
      intentRevision: plan.revision,
      origin: plan.origin,
      ...(slot.payload.kind === 'addPlan' && plan.relativeDateGuard
        ? { relativeDateGuard: plan.relativeDateGuard }
        : {}),
    });
    intent.slots.push({ slotId: slot.slotId, command });
  }
  return intent;
}
