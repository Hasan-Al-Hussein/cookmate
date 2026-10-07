import {
  checkAssistantRequest,
  checkAssistantResponse,
  checkMemoryResponseForRequest,
  checkLocalCommand,
  matchOperationReceipt,
  summarizeActionResults,
  validateCommandResult,
  validateMultiActionResult,
  validatePendingIntent,
} from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  CommandResult,
  ContractError,
  DateContext,
  LocalCommand,
  MultiActionResult,
  PendingIntent,
  ProposalResponse,
} from '@cookmate/contracts';
import { catalogueBoundary } from '@cookmate/catalogue';
import { validateReceiptSemantics, verifyCommandFingerprint } from '@cookmate/domain';
import type {
  AssistantActionRecovery,
  AuthorizedActionPlan,
  CommandPlatform,
  CookMateServices,
  Immutable,
  RepositoryResult,
} from '@cookmate/domain';
import { ConnectionError } from '../connection/errors';
import type { GatewayConnection } from '../connection';
import {
  AssistantCoreError,
  assertGuardCurrent,
  prepareAuthorizedActionPlan,
  rejectAction,
} from './actions';
import type { ExplicitActionAuthority } from './actions';
import { buildAssistantRequest, contextNarrowing } from './context';
import type { ContextBuildResult } from './context';
import type {
  AssistantPersistencePort,
  AssistantActionContinuationReview,
  ContextSelection,
  CurrentActionState,
  StoredAssistantIntent,
} from './ports';

export interface AssistantCoordinatorOptions {
  persistence: AssistantPersistencePort;
  services: Pick<CookMateServices, 'queries'>;
  connection: GatewayConnection;
  platform: CommandPlatform;
  currentDate(): DateContext;
}

export type TurnOutcome =
  | Exclude<ContextBuildResult, { kind: 'ready' | 'failed' }>
  | {
      kind: 'failed';
      error: ContractError;
      userIntentId?: string;
      acceptanceRetry?: { userIntentId: string; response: AssistantTurnResponse };
    }
  | {
      kind: 'reply';
      response: AssistantTurnResponse;
      actionStatus: 'not_executed';
      actionStatusText: 'No changes were applied by this reply.';
      omittedHistoryCount: number;
      historicalAcknowledgement: boolean;
    };

export interface ActionOutcome {
  results: MultiActionResult;
  summary: ReturnType<typeof summarizeActionResults>;
}

/** Trusted UI consent for the exact displayed review; model output is never authority. */
export interface ExplicitActionContinuationAuthority {
  source: 'explicit_user';
  review: Parameters<AssistantPersistencePort['confirmActionContinuation']>[0]['review'];
}

export interface ActionContinuationOutcome {
  /** Owned original command, independent of ancillary review labels or prefix claims. */
  command: LocalCommand;
  /** The actual attempt result; later reconciliation must not erase failure or uncertainty. */
  result: CommandResult;
  /** Current whole-plan proof, never reconstructed from a stale review after clear. */
  actionOutcome: ActionOutcome | null;
  recoveryError?: ContractError;
}

type Mutable<Value> = Value extends object
  ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
  : Value;
function clone<Value>(value: Value): Mutable<Value> {
  return JSON.parse(JSON.stringify(value)) as Mutable<Value>;
}

function read<Value>(result: RepositoryResult<Value>): Value {
  if (result.kind === 'failed') throw new AssistantCoreError(result.error);
  return result.value;
}

function safeError(error: unknown): ContractError {
  if (error instanceof ConnectionError || error instanceof AssistantCoreError) return error.detail;
  return { code: 'storage_failure', messageKey: 'assistant.storage_failure', retry: 'reconcile' };
}

/** Uses Data's durable lifecycle exclusively. Reopen/reconcile never calls an executor. */
export function createAssistantCoordinator(options: AssistantCoordinatorOptions) {
  let epoch = 0;
  let reviewEpoch = 0;
  let busy = false;
  let activeIntent: { userIntentId: string; revision: number } | null = null;

  function assertEpoch(expected: number) {
    if (epoch !== expected) rejectAction('cancelled', 'cancelled');
  }

  function invalidateActionContinuationReview() {
    reviewEpoch++;
    options.persistence.invalidateActionContinuationReview();
  }

  function assertReviewEpoch(expected: number) {
    if (reviewEpoch !== expected) rejectAction('cancelled', 'review_cancelled');
  }

  function requirePaired() {
    const connection = options.connection.getState();
    if (connection.status !== 'paired') rejectAction('unauthenticated', 'connect_first');
    return connection;
  }

  async function exclusive<Value>(
    operation: (expectedEpoch: number) => Promise<Value>,
  ): Promise<Value> {
    if (busy) rejectAction('already_pending', 'already_pending');
    busy = true;
    try {
      return await operation(epoch);
    } finally {
      busy = false;
      activeIntent = null;
    }
  }

  async function storedIntent(userIntentId: string): Promise<StoredAssistantIntent> {
    const saved = read(await options.persistence.readIntent(userIntentId));
    if (
      !saved ||
      !validatePendingIntent(saved.intent) ||
      saved.intent.userIntentId !== userIntentId ||
      !checkAssistantRequest(saved.request, catalogueBoundary).ok ||
      saved.request.userIntentId !== userIntentId
    )
      rejectAction('stale_context', 'intent_unavailable');
    return clone(saved) as StoredAssistantIntent;
  }

  async function reconcileSlot(
    command: LocalCommand,
    previous?: CommandResult,
  ): Promise<CommandResult | null> {
    try {
      const receipt = read(await options.services.queries.readReceipt(command.operationId));
      if (receipt) {
        if (
          !validateReceiptSemantics(receipt, catalogueBoundary) ||
          matchOperationReceipt(command, receipt) !== 'existing'
        )
          return {
            kind: 'failed',
            operationId: command.operationId,
            error: {
              code: 'operation_conflict',
              messageKey: 'assistant.receipt_conflict',
              retry: 'never',
            },
          };
        return { kind: 'receipt', receipt: clone(receipt) };
      }
      // A remembered success without the corresponding durable receipt is corruption, not success.
      if (previous?.kind === 'receipt' || previous?.kind === 'uncertain')
        return { kind: 'uncertain', operationId: command.operationId };
      return previous ?? null;
    } catch {
      return { kind: 'uncertain', operationId: command.operationId };
    }
  }

  function plannedSlots(saved: StoredAssistantIntent) {
    return (
      saved.actionPlan?.slots.map((slot) => ({
        slotId: slot.slotId,
        operationId: slot.operationId,
      })) ??
      saved.intent.slots.map((slot) => ({
        slotId: slot.slotId,
        operationId: slot.command.operationId,
      }))
    );
  }

  function notDispatched(operationId: string): CommandResult {
    return {
      kind: 'failed',
      operationId,
      error: {
        code: 'cancelled',
        messageKey: 'assistant.not_dispatched',
        retry: 'after_correction',
      },
    };
  }

  function outcome(saved: StoredAssistantIntent, slots: MultiActionResult['slots']): ActionOutcome {
    const results = { userIntentId: saved.intent.userIntentId, slots };
    if (!saved.actionPlan)
      return {
        results,
        summary: summarizeActionResults(results, clone(saved.intent) as PendingIntent),
      };
    // Unfinalized reservations deliberately have no LocalCommand. Validate those identities
    // separately; every claimed receipt still requires the actual frozen command.
    const plan = plannedSlots(saved);
    const valid =
      validateMultiActionResult(results) &&
      plan.length === slots.length &&
      slots.every((entry, index) => {
        const expected = plan[index];
        if (!expected || entry.slotId !== expected.slotId) return false;
        if (entry.result.kind !== 'receipt')
          return entry.result.operationId === expected.operationId;
        const frozen = saved.intent.slots.find((slot) => slot.slotId === entry.slotId);
        return (
          !!frozen &&
          frozen.command.operationId === expected.operationId &&
          frozen.command.userIntentId === saved.intent.userIntentId &&
          matchOperationReceipt(clone(frozen.command), entry.result.receipt) === 'existing'
        );
      });
    const completed = slots.filter((slot) => slot.result.kind === 'receipt').length;
    return {
      results,
      summary: !valid
        ? 'invalid'
        : slots.some((slot) => slot.result.kind === 'uncertain')
          ? 'uncertain'
          : completed === slots.length && completed > 0
            ? 'complete'
            : completed > 0
              ? 'partial'
              : 'failed',
    };
  }

  async function reconcileWithinExclusive(
    userIntentId: string,
    expectedEpoch: number,
  ): Promise<ActionOutcome> {
    assertEpoch(expectedEpoch);
    // Settlement may change the durable phase/journal. Compare its proof with a fresh
    // saved intent, never the snapshot captured before the explicit metadata retry.
    const proof = clone(read(await options.persistence.reconcileActionRecovery(userIntentId)));
    assertEpoch(expectedEpoch);
    const saved = await storedIntent(userIntentId);
    assertEpoch(expectedEpoch);
    return recoveryOutcome(saved, proof);
  }

  async function reconcileSaved(
    saved: StoredAssistantIntent,
    expectedEpoch: number,
  ): Promise<ActionOutcome> {
    const proof = read(await options.persistence.readActionRecovery(saved.intent.userIntentId));
    assertEpoch(expectedEpoch);
    return recoveryOutcome(saved, proof);
  }

  function recoveryOutcome(
    saved: StoredAssistantIntent,
    proof: Immutable<AssistantActionRecovery> | null,
  ): ActionOutcome {
    const userIntentId = saved.intent.userIntentId;
    const reservations = plannedSlots(saved);
    if (!reservations.length) rejectAction('invalid_input', 'no_actions');
    if (
      !proof ||
      typeof proof !== 'object' ||
      Array.isArray(proof) ||
      proof.conversationId !== saved.request.conversationId ||
      proof.conversationGeneration !== saved.request.conversationGeneration ||
      proof.userIntentId !== userIntentId ||
      proof.intentRevision !== saved.intent.revision ||
      proof.phase !== saved.intent.phase ||
      !Array.isArray(proof.slots) ||
      proof.slots.length !== reservations.length ||
      new Set(reservations.map((slot) => slot.slotId)).size !== reservations.length ||
      new Set(reservations.map((slot) => slot.operationId)).size !== reservations.length
    )
      rejectAction('stale_context', 'recovery_changed');
    const slots: MultiActionResult['slots'][number][] = [];
    for (const [index, reservation] of reservations.entries()) {
      const recovered = proof.slots[index];
      if (
        !recovered ||
        typeof recovered !== 'object' ||
        Array.isArray(recovered) ||
        recovered.slotId !== reservation.slotId ||
        recovered.operationId !== reservation.operationId
      )
        rejectAction('stale_context', 'recovery_changed');
      let result: CommandResult;
      if (recovered.outcome === 'receipt') {
        const frozen = saved.intent.slots.find((slot) => slot.slotId === reservation.slotId);
        if (
          !frozen ||
          frozen.command.operationId !== reservation.operationId ||
          frozen.command.userIntentId !== userIntentId ||
          !checkLocalCommand(frozen.command, catalogueBoundary).ok ||
          !validateReceiptSemantics(recovered.receipt, catalogueBoundary) ||
          matchOperationReceipt(clone(frozen.command), recovered.receipt) !== 'existing'
        )
          rejectAction('operation_conflict', 'receipt_conflict');
        result = { kind: 'receipt', receipt: clone(recovered.receipt) };
      } else if (recovered.outcome === 'not_executed') {
        const previous = saved.slotResults.find(
          (slot) => slot.slotId === reservation.slotId,
        )?.result;
        if (
          previous &&
          (!validateCommandResult(previous) ||
            (previous.kind !== 'receipt' && previous.operationId !== reservation.operationId))
        )
          rejectAction('operation_conflict', 'journal_result_conflict');
        if (
          recovered.receipt !== null ||
          !['cancelled', 'reconciling'].includes(proof.phase) ||
          previous?.kind === 'receipt'
        )
          rejectAction('stale_context', 'recovery_changed');
        // Proven absence resolves old uncertainty, but does not erase a correlated attempted failure.
        result =
          previous?.kind === 'failed' ? clone(previous) : notDispatched(reservation.operationId);
      } else if (recovered.outcome === 'unresolved' && recovered.receipt === null) {
        result = { kind: 'uncertain', operationId: reservation.operationId };
      } else rejectAction('stale_context', 'recovery_changed');
      slots.push({ slotId: reservation.slotId, result });
    }
    return outcome(saved, slots as MultiActionResult['slots']);
  }

  async function continuationOutcome(
    command: LocalCommand,
    result: CommandResult,
    expectedEpoch: number,
    expectedReviewEpoch: number,
  ): Promise<ActionContinuationOutcome> {
    const attempted = { command: clone(command), result: clone(result) };
    try {
      assertEpoch(expectedEpoch);
      assertReviewEpoch(expectedReviewEpoch);
      const saved = await storedIntent(command.userIntentId);
      assertEpoch(expectedEpoch);
      assertReviewEpoch(expectedReviewEpoch);
      // The supplied review's cursor/slot label is not attested by a historical receipt.
      const frozen = saved.intent.slots.find(
        (slot) => slot.command.operationId === command.operationId,
      );
      if (
        !saved.actionPlan ||
        !frozen ||
        saved.intent.revision !== command.intentRevision ||
        frozen.command.userIntentId !== command.userIntentId ||
        frozen.command.payloadFingerprint !== command.payloadFingerprint ||
        !checkLocalCommand(frozen.command, catalogueBoundary).ok ||
        !(await verifyCommandFingerprint(clone(frozen.command), options.platform))
      )
        rejectAction('operation_conflict', 'continuation_history_changed');
      assertEpoch(expectedEpoch);
      assertReviewEpoch(expectedReviewEpoch);
      const recovered = await reconcileSaved(saved, expectedEpoch);
      assertReviewEpoch(expectedReviewEpoch);
      const slots = clone(recovered.results.slots);
      const target = slots.find((slot) => slot.slotId === frozen.slotId);
      if (!target) rejectAction('stale_context', 'continuation_history_changed');
      if (target.result.kind === 'receipt') {
        if (matchOperationReceipt(command, target.result.receipt) !== 'existing')
          rejectAction('operation_conflict', 'receipt_conflict');
        // Independent current proof may resolve uncertainty; retain the original attempt separately.
      } else if (result.kind === 'receipt') {
        rejectAction('stale_context', 'continuation_receipt_unavailable');
      } else if (target.result.kind !== 'uncertain') {
        target.result = clone(result);
      }
      return { ...attempted, actionOutcome: outcome(saved, slots) };
    } catch (error) {
      // Missing/cleared history cannot erase the correlated attempt or invent a completed batch.
      return { ...attempted, actionOutcome: null, recoveryError: safeError(error) };
    }
  }

  function reply(
    acknowledgement: StoredAssistantIntent,
    historicalAcknowledgement: boolean,
  ): TurnOutcome {
    const response = clone(acknowledgement.response) as AssistantTurnResponse | null;
    if (
      !response ||
      !checkAssistantResponse(response, catalogueBoundary).ok ||
      !checkMemoryResponseForRequest(
        response,
        clone(acknowledgement.request) as AssistantTurnRequest,
      ).ok
    )
      rejectAction('stale_context', 'accepted_response_unavailable');
    return {
      kind: 'reply',
      response,
      historicalAcknowledgement,
      actionStatus: 'not_executed',
      actionStatusText: 'No changes were applied by this reply.',
      omittedHistoryCount: 0,
    };
  }

  async function accept(
    saved: StoredAssistantIntent,
    response: AssistantTurnResponse,
    expectedEpoch: number,
  ): Promise<TurnOutcome> {
    // Preserve this exact normalised payload and the durable envelope through acknowledgement loss.
    const normalized = clone(response);
    try {
      const accepted = read(
        await options.persistence.acceptResponse({
          response: normalized,
          ...saved.acceptanceEnvelope,
        }),
      );
      assertEpoch(expectedEpoch);
      if (
        !accepted.replay &&
        options.connection.getState().generation !== saved.request.connectionGeneration
      )
        rejectAction('stale_context', 'connection_changed');
      return reply(clone(accepted.acknowledgement) as StoredAssistantIntent, accepted.replay);
    } catch (error) {
      return {
        kind: 'failed',
        error: safeError(error),
        userIntentId: saved.intent.userIntentId,
        acceptanceRetry: { userIntentId: saved.intent.userIntentId, response: clone(normalized) },
      };
    }
  }

  async function runTurn(
    saved: StoredAssistantIntent,
    expectedEpoch: number,
    selection?: ContextSelection,
  ): Promise<TurnOutcome> {
    const sent = clone(saved.request) as AssistantTurnRequest;
    // A reopened request retains resolved selections, but cannot identify which of several
    // reference sets originally supplied an ordinal. Never infer that missing UI selection.
    const recoverySelection = selection
      ? clone(selection)
      : {
          ...(sent.context.selectedRecipeId
            ? { selectedRecipeId: sent.context.selectedRecipeId }
            : {}),
          ...(sent.context.selectedPlacement
            ? { selectedPlacement: sent.context.selectedPlacement }
            : {}),
        };
    activeIntent = { userIntentId: sent.userIntentId, revision: saved.intent.revision };
    try {
      assertEpoch(expectedEpoch);
      const connection = options.connection.getState();
      if (connection.status !== 'paired') rejectAction('unauthenticated', 'connect_first');
      if (connection.generation !== sent.connectionGeneration)
        rejectAction('stale_context', 'connection_changed');
      const response = await options.connection.turn(sent);
      assertEpoch(expectedEpoch);
      const checked = checkAssistantResponse(response, catalogueBoundary);
      if (!checked.ok) throw new AssistantCoreError(checked.error);
      const memory = checkMemoryResponseForRequest(response, sent);
      if (!memory.ok) throw new AssistantCoreError(memory.error);
      if (response.kind === 'error') throw new AssistantCoreError(response.error);
      const normalized =
        response.kind === 'proposal'
          ? { ...response, text: 'Review these proposed changes. Nothing has been saved yet.' }
          : response;
      return await accept(saved, normalized, expectedEpoch);
    } catch (error) {
      const detail = safeError(error);
      let recorded = false;
      try {
        read(
          await options.persistence.recordTurnFailure({
            userIntentId: sent.userIntentId,
            expectedIntentRevision: saved.intent.revision,
            error: detail,
          }),
        );
        recorded = true;
      } catch {
        // The registered frozen turn remains the only retry identity after a storage failure.
      }
      const budgetReason =
        detail.field === 'context.token_limit'
          ? 'token_limit'
          : detail.field === 'context.byte_limit'
            ? 'byte_limit'
            : null;
      if (recorded && budgetReason) {
        try {
          assertEpoch(expectedEpoch);
          // This is only a preview of a possible fresh brief. It never rewrites/rearms the
          // failed request, begins a second turn, or calls the provider again.
          const fresh = await options.persistence.readContext({
            text: sent.message.text,
            selection: recoverySelection,
            messageId: options.platform.newId(),
          });
          assertEpoch(expectedEpoch);
          return fresh.kind === 'narrowing' ? fresh : contextNarrowing(read(fresh), budgetReason);
        } catch (recoveryError) {
          return {
            kind: 'failed',
            error: safeError(recoveryError),
            userIntentId: sent.userIntentId,
          };
        }
      }
      return { kind: 'failed', error: detail, userIntentId: sent.userIntentId };
    }
  }

  return {
    async send(text: string, selection: ContextSelection = {}): Promise<TurnOutcome> {
      const ownedSelection = clone(selection);
      return exclusive(async (expectedEpoch) => {
        let userIntentId: string | undefined;
        try {
          const messageId = options.platform.newId();
          const snapshot = await options.persistence.readContext({
            text,
            selection: ownedSelection,
            messageId,
          });
          assertEpoch(expectedEpoch);
          if (snapshot.kind === 'narrowing') return snapshot;
          const context = read(snapshot);
          assertEpoch(expectedEpoch);
          const connection = options.connection.getState();
          if (connection.status !== 'paired') rejectAction('unauthenticated', 'connect_first');
          const built = buildAssistantRequest(context, {
            text,
            selection: ownedSelection,
            date: options.currentDate(),
            ids: {
              requestId: options.platform.newId(),
              userIntentId: options.platform.newId(),
              intentRevision: 0,
              messageId,
              connectionGeneration: connection.generation,
            },
          });
          if (built.kind !== 'ready') return built;
          userIntentId = built.request.userIntentId;
          const saved = read(
            await options.persistence.beginTurn({
              request: built.request,
              expectedConversationRevision: context.contextRevision,
            }),
          );
          return runTurn(clone(saved) as StoredAssistantIntent, expectedEpoch, ownedSelection);
        } catch (error) {
          return {
            kind: 'failed',
            error: safeError(error),
            ...(userIntentId ? { userIntentId } : {}),
          };
        }
      });
    },

    /** Explicit local retry only. Data compares the full payload before checking mutable guards. */
    async retryAcceptance(
      userIntentId: string,
      response: AssistantTurnResponse,
    ): Promise<TurnOutcome> {
      const owned = clone(response);
      return exclusive(async (expectedEpoch) => {
        try {
          return await accept(await storedIntent(userIntentId), owned, expectedEpoch);
        } catch (error) {
          return { kind: 'failed', error: safeError(error), userIntentId };
        }
      });
    },

    /** User-requested provider retry only. Rearming retains all original identities and context. */
    async retryTurn(userIntentId: string): Promise<TurnOutcome> {
      return exclusive(async (expectedEpoch) => {
        try {
          const accepted = read(await options.persistence.readAcceptance(userIntentId));
          assertEpoch(expectedEpoch);
          if (accepted) return reply(clone(accepted) as StoredAssistantIntent, true);
          const saved = await storedIntent(userIntentId);
          const rearmed = read(
            await options.persistence.rearmTurn({
              userIntentId,
              expectedIntentRevision: saved.intent.revision,
            }),
          );
          return runTurn(clone(rearmed) as StoredAssistantIntent, expectedEpoch);
        } catch (error) {
          return { kind: 'failed', error: safeError(error), userIntentId };
        }
      });
    },

    /** Historical acknowledgements do not authorize dispatch or confirmation. */
    async readAcceptance(userIntentId: string): Promise<TurnOutcome | null> {
      const expectedEpoch = epoch;
      const accepted = read(await options.persistence.readAcceptance(userIntentId));
      assertEpoch(expectedEpoch);
      return accepted ? reply(clone(accepted) as StoredAssistantIntent, true) : null;
    },

    readMemoryPage: (input?: Parameters<AssistantPersistencePort['readMemoryPage']>[0]) =>
      options.persistence.readMemoryPage(input),

    /** Invoke only for an explicit user working-context decision; a rejected CAS changes nothing. */
    async setWorkingContext(input: Parameters<AssistantPersistencePort['setWorkingContext']>[0]) {
      const result = await options.persistence.setWorkingContext(clone(input));
      if (result.kind === 'ready') {
        epoch++;
        options.connection.cancel();
        invalidateActionContinuationReview();
      }
      return result;
    },

    /** Read-only review; neither opening nor replacing it dispatches or rearms an action. */
    async readActionContinuationReview(
      input: Parameters<AssistantPersistencePort['readActionContinuationReview']>[0],
    ): Promise<Immutable<AssistantActionContinuationReview> | null> {
      const owned = clone(input);
      return exclusive(async (expectedEpoch) => {
        const connection = requirePaired();
        invalidateActionContinuationReview();
        const expectedReviewEpoch = reviewEpoch;
        const review = clone(read(await options.persistence.readActionContinuationReview(owned)));
        assertEpoch(expectedEpoch);
        assertReviewEpoch(expectedReviewEpoch);
        if (requirePaired().generation !== connection.generation)
          rejectAction('stale_context', 'connection_changed');
        if (review === null) return null;
        if (
          !review ||
          !checkLocalCommand(review.slot?.command, catalogueBoundary).ok ||
          !['frozen', 'prospective'].includes(review.slot.commandState) ||
          review.slot.command.userIntentId !== owned.userIntentId ||
          review.slot.command.intentRevision !== owned.expectedIntentRevision ||
          review.state?.guards?.connectionGeneration !== connection.generation ||
          !(await verifyCommandFingerprint(review.slot.command, options.platform))
        )
          rejectAction('operation_conflict', 'continuation_review_changed');
        assertEpoch(expectedEpoch);
        assertReviewEpoch(expectedReviewEpoch);
        if (requirePaired().generation !== connection.generation)
          rejectAction('stale_context', 'connection_changed');
        return review;
      });
    },

    /** Synchronous review-only dismissal; it does not cancel a turn or retire durable work. */
    invalidateActionContinuationReview,

    /** Confirm exactly one reviewed original command under the runtime's normal mutation gate. */
    async confirmActionContinuation(
      authority: ExplicitActionContinuationAuthority,
    ): Promise<ActionContinuationOutcome> {
      const owned = clone(authority);
      if (
        owned?.source !== 'explicit_user' ||
        !checkLocalCommand(owned.review?.slot?.command, catalogueBoundary).ok ||
        !['frozen', 'prospective'].includes(owned.review.slot.commandState)
      )
        rejectAction('invalid_input', 'continuation_confirmation_required');
      const command = clone(owned.review.slot.command);
      return exclusive(async (expectedEpoch) => {
        const connection = requirePaired();
        const expectedReviewEpoch = reviewEpoch;
        activeIntent = { userIntentId: command.userIntentId, revision: command.intentRevision };
        if (!(await verifyCommandFingerprint(command, options.platform)))
          rejectAction('operation_conflict', 'continuation_command_changed');
        assertEpoch(expectedEpoch);
        assertReviewEpoch(expectedReviewEpoch);
        if (requirePaired().generation !== connection.generation)
          rejectAction('stale_context', 'connection_changed');
        let result: CommandResult;
        try {
          // Data resolves actual historical receipts before live-review gates, or admits this one slot.
          result = clone(
            await options.persistence.confirmActionContinuation({ review: owned.review }),
          );
          if (
            !validateCommandResult(result) ||
            (result.kind === 'receipt'
              ? !validateReceiptSemantics(result.receipt, catalogueBoundary) ||
                matchOperationReceipt(command, result.receipt) !== 'existing'
              : result.operationId !== command.operationId)
          )
            result = { kind: 'uncertain', operationId: command.operationId };
        } catch {
          result = { kind: 'uncertain', operationId: command.operationId };
        }
        return continuationOutcome(command, result, expectedEpoch, expectedReviewEpoch);
      });
    },

    /** Called only after the user authorizes every named action and its current consequences. */
    async approve(
      userIntentId: string,
      authority: ExplicitActionAuthority,
    ): Promise<AuthorizedActionPlan> {
      return exclusive(async (expectedEpoch) => {
        const saved = await storedIntent(userIntentId);
        activeIntent = { userIntentId, revision: saved.intent.revision };
        if (options.connection.getState().status !== 'paired')
          rejectAction('unauthenticated', 'connect_first');
        if (!saved.response || saved.response.kind !== 'proposal' || !saved.guards)
          rejectAction('stale_context', 'proposal_unavailable');
        if (saved.intent.slots.length || saved.actionPlan)
          rejectAction('operation_conflict', 'actions_already_frozen');
        if (!['confirmation', 'ready'].includes(saved.intent.phase))
          rejectAction('stale_context', 'intent_not_confirmable');
        const current = clone(
          read(await options.persistence.readCurrentActionState(userIntentId)),
        ) as CurrentActionState;
        assertGuardCurrent(saved.guards, current, options.connection.getState().generation);
        const prepared = await prepareAuthorizedActionPlan(
          clone(saved.request) as AssistantTurnRequest,
          clone(saved.response) as ProposalResponse,
          authority,
          current,
          clone(saved.guards),
          options.platform,
        );
        assertEpoch(expectedEpoch);
        assertGuardCurrent(saved.guards, current, options.connection.getState().generation);
        read(
          await options.persistence.freezeActionPlan({
            plan: prepared,
            expectedIntentRevision: saved.intent.revision,
            guards: clone(saved.guards),
          }),
        );
        assertEpoch(expectedEpoch);
        return prepared;
      });
    },

    /** Explicit dispatch/retry only; keeps operation IDs and skips known committed effects. */
    async dispatch(userIntentId: string): Promise<ActionOutcome> {
      return exclusive(async (expectedEpoch) => {
        let saved = await storedIntent(userIntentId);
        if (!plannedSlots(saved).length) rejectAction('invalid_input', 'no_actions');
        if (!['ready', 'dispatched'].includes(saved.intent.phase))
          return reconcileWithinExclusive(userIntentId, expectedEpoch);
        if (!saved.guards) rejectAction('stale_context', 'guards_unavailable');
        activeIntent = { userIntentId, revision: saved.intent.revision };
        const slots: MultiActionResult['slots'][number][] = [];
        let interrupted = false;
        for (const reservation of plannedSlots(saved)) {
          let slot = saved.intent.slots.find((item) => item.slotId === reservation.slotId);
          if (!slot) {
            if (
              interrupted ||
              epoch !== expectedEpoch ||
              options.connection.getState().status !== 'paired' ||
              options.connection.getState().generation !== saved.guards?.connectionGeneration
            ) {
              slots.push({
                slotId: reservation.slotId,
                result: notDispatched(reservation.operationId),
              });
              continue;
            }
            try {
              const finalized = read(
                await options.persistence.finalizeNextIntentSlot({
                  userIntentId,
                  expectedIntentRevision: saved.intent.revision,
                  slotId: reservation.slotId,
                }),
              );
              saved = clone(finalized.intent) as StoredAssistantIntent;
              slot = saved.intent.slots.find((item) => item.slotId === reservation.slotId);
              if (
                !slot ||
                slot.command.operationId !== reservation.operationId ||
                !checkLocalCommand(slot.command, catalogueBoundary).ok ||
                JSON.stringify(slot) !== JSON.stringify(finalized.slot)
              )
                rejectAction('operation_conflict', 'finalized_slot_changed');
            } catch (error) {
              interrupted = true;
              slots.push({
                slotId: reservation.slotId,
                result: {
                  kind: 'failed',
                  operationId: reservation.operationId,
                  error: safeError(error),
                },
              });
              continue;
            }
          }
          const stored = saved.slotResults.find((item) => item.slotId === slot.slotId)?.result;
          const previous = stored ? (clone(stored) as CommandResult) : undefined;
          let result = await reconcileSlot(clone(slot.command), previous);
          const retryableFailure =
            result?.kind === 'failed' &&
            ['after_delay', 'after_reconnect'].includes(result.error.retry);
          if (result === null || retryableFailure) {
            if (
              interrupted ||
              epoch !== expectedEpoch ||
              options.connection.getState().status !== 'paired' ||
              options.connection.getState().generation !== saved.guards?.connectionGeneration
            ) {
              result = {
                kind: 'failed',
                operationId: slot.command.operationId,
                error: {
                  code: 'cancelled',
                  messageKey: 'assistant.not_dispatched',
                  retry: 'after_correction',
                },
              };
            } else {
              try {
                // Data loads its own frozen slot and journals the real result; no duplicate command store.
                result = await options.persistence.executeIntentSlot({
                  userIntentId,
                  expectedIntentRevision: saved.intent.revision,
                  slotId: slot.slotId,
                });
                if (
                  !validateCommandResult(result) ||
                  (result.kind === 'receipt'
                    ? matchOperationReceipt(clone(slot.command), result.receipt) !== 'existing'
                    : result.operationId !== slot.command.operationId)
                )
                  result = { kind: 'uncertain', operationId: slot.command.operationId };
                else if (result.kind === 'receipt')
                  result = (await reconcileSlot(clone(slot.command), result)) ?? {
                    kind: 'uncertain',
                    operationId: slot.command.operationId,
                  };
              } catch {
                result = { kind: 'uncertain', operationId: slot.command.operationId };
              }
            }
          }
          if (result.kind !== 'receipt') interrupted = true;
          slots.push({ slotId: slot.slotId, result });
        }
        return outcome(saved, slots as MultiActionResult['slots']);
      });
    },

    /** Explicit metadata recovery only; serialized with dispatch and continuation confirmation. */
    reconcile(userIntentId: string): Promise<ActionOutcome> {
      return exclusive((expectedEpoch) => reconcileWithinExclusive(userIntentId, expectedEpoch));
    },

    /** Call synchronously on clear/reconfiguration; durable clear itself is a Data command. */
    invalidate() {
      epoch++;
      options.connection.cancel();
      invalidateActionContinuationReview();
    },

    async cancel(userIntentId = activeIntent?.userIntentId): Promise<void> {
      epoch++;
      options.connection.cancel();
      invalidateActionContinuationReview();
      if (!userIntentId) return;
      const saved = await storedIntent(userIntentId);
      read(
        await options.persistence.cancelIntent({
          userIntentId,
          expectedIntentRevision: saved.intent.revision,
        }),
      );
    },
  };
}
