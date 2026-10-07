import {
  checkLocalCommand,
  commandFingerprintInput,
  isRelativeDateContextCurrent,
  matchOperationReceipt,
  validateCommandResult,
  validateLocalCommand,
  validateOperationReceipt,
  validatePendingIntent,
  validatePlanOccurrence,
  validateShoppingScope,
} from '@cookmate/contracts';
import { verifyCommandFingerprint } from '@cookmate/domain';
import type {
  CatalogueBoundary,
  CommandResult,
  DateContext,
  LocalCommand,
  OperationReceipt,
} from '@cookmate/contracts';
import type {
  AssistantActionContinuationReview,
  AssistantPersistencePort,
  CommandPlatform,
  CurrentActionState,
  Immutable,
} from '@cookmate/domain';
import { readAcceptanceInSnapshot } from './acceptanceRecords';
import { commandMatchesPlannedSlot, plannedCommand } from './actionPlanRecords';
import type { StoredActionPlan } from './actionPlanRecords';
import { equivalentJson, isIntentGuard, record, utf8Length } from './assistantRecordValidation';
import type { AssistantIntentRecord } from './assistantIntentRecords';
import { CommandFault, rejectCommand } from './commandExecutor';
import type { PrivateReviewedContinuation } from './commandExecutor';
import { isAppId, isRevision, requireConversationRecord } from './conversationRecords';
import { freezeResult, readRevision } from './query';
import { readReceiptInSnapshot } from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SerializedWriter, SqlSession } from './sql';

interface LoadedAction {
  saved: AssistantIntentRecord;
  action: StoredActionPlan;
  state: CurrentActionState;
}
interface ContinuationOptions {
  writer: SerializedWriter;
  catalogue: CatalogueBoundary;
  platform: CommandPlatform;
  dateContext(): DateContext;
  connectionGeneration(): number;
  load(session: SqlSession, id: string, revision: number): Promise<LoadedAction>;
  execute(
    command: Immutable<LocalCommand>,
    admission: PrivateReviewedContinuation,
  ): Promise<CommandResult>;
  journal(slotId: string, command: LocalCommand, result: CommandResult): Promise<CommandResult>;
  assertUnheld(id: string, cursor: number): undefined;
  onFinalized(revision: number): void;
  readHistoricalReceipt(command: LocalCommand): Promise<OperationReceipt | null>;
}
type ContinuationRepository = Pick<
  AssistantPersistencePort,
  | 'readActionContinuationReview'
  | 'confirmActionContinuation'
  | 'invalidateActionContinuationReview'
>;
const MAX_REVIEW_BYTES = 131072;
const MAX_ACTION_SLOTS = 8;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Historical replay validates bounded shape, but ancillary review metadata attests no authority. */
function copyReview(input: unknown): AssistantActionContinuationReview {
  const json = JSON.stringify(input);
  if (typeof json !== 'string' || utf8Length(json) > MAX_REVIEW_BYTES)
    rejectCommand('invalid_input', 'assistant.invalid_continuation_review');
  const value: unknown = JSON.parse(json);
  if (
    !record(value) ||
    !exactKeys(value, ['reviewToken', 'cursor', 'slot', 'prefixReceipts', 'state', 'catalogue']) ||
    !isAppId(value.reviewToken) ||
    !isRevision(value.cursor) ||
    value.cursor >= MAX_ACTION_SLOTS ||
    !record(value.slot) ||
    !exactKeys(value.slot, ['slotId', 'command', 'commandState']) ||
    !['frozen', 'prospective'].includes(value.slot.commandState as string) ||
    !isAppId(value.slot.slotId) ||
    !validateLocalCommand(value.slot.command) ||
    !Array.isArray(value.prefixReceipts) ||
    value.prefixReceipts.length > MAX_ACTION_SLOTS ||
    !value.prefixReceipts.every(
      (entry) =>
        record(entry) &&
        exactKeys(entry, ['slotId', 'receipt']) &&
        isAppId(entry.slotId) &&
        validateOperationReceipt(entry.receipt),
    ) ||
    !record(value.state) ||
    !exactKeys(value.state, ['guards', 'planOccurrences', 'shoppingScope']) ||
    !isIntentGuard(value.state.guards) ||
    !Array.isArray(value.state.planOccurrences) ||
    value.state.planOccurrences.length > MAX_ACTION_SLOTS ||
    !value.state.planOccurrences.every(validatePlanOccurrence) ||
    !validateShoppingScope(value.state.shoppingScope) ||
    !record(value.catalogue) ||
    !exactKeys(value.catalogue, ['version', 'fingerprint']) ||
    typeof value.catalogue.version !== 'string' ||
    !value.catalogue.version.length ||
    typeof value.catalogue.fingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.catalogue.fingerprint)
  )
    rejectCommand('invalid_input', 'assistant.invalid_continuation_review');
  return value as unknown as AssistantActionContinuationReview;
}

function errorDetail(error: unknown) {
  return error instanceof CommandFault
    ? error.detail
    : {
        code: error instanceof StorageFault ? error.code : ('storage_failure' as const),
        messageKey: 'assistant.continuation_storage_failed',
        retry: 'reconcile' as const,
      };
}

/** The only retained lifetime is one revocable review; no durable or ordinary dispatch grant exists. */
export function createAssistantContinuationRepository(
  options: ContinuationOptions,
): ContinuationRepository {
  let epoch = {};
  let current: {
    epoch: object;
    review: AssistantActionContinuationReview;
    consumed: boolean;
  } | null = null;
  const invalidate = () => {
    epoch = {};
    current = null;
  };
  const requireEpoch = (expected: object) => {
    if (epoch !== expected) rejectCommand('cancelled', 'assistant.continuation_review_invalidated');
  };
  const requireRuntime = (review: AssistantActionContinuationReview) => {
    if (
      options.connectionGeneration() !== review.state.guards.connectionGeneration ||
      !isRelativeDateContextCurrent(options.dateContext(), review.state.guards.relativeDateContext)
    )
      rejectCommand('stale_context', 'assistant.runtime_changed');
  };
  const loadSuspended = async (session: SqlSession, id: string, revision: number) => {
    const loaded = await options.load(session, id, revision);
    const { saved, action, state } = loaded;
    if (saved.lifecycle !== 'accepted' || saved.intent.phase !== 'reconciling')
      rejectCommand('cancelled', 'assistant.intent_not_suspended');
    const acceptance = await readAcceptanceInSnapshot(
      session,
      id,
      options.catalogue,
      options.platform,
    );
    requireConversationRecord(
      acceptance &&
        equivalentJson(acceptance.acknowledgement.request, saved.request) &&
        equivalentJson(acceptance.acknowledgement.response, saved.response) &&
        equivalentJson(acceptance.acknowledgement.acceptanceEnvelope, saved.acceptanceEnvelope),
    );
    const manifest = (
      await session.all<{ version: string; fingerprint: string }>(
        'SELECT catalogue_version AS version,fingerprint FROM catalogue_manifest WHERE singleton=1',
      )
    )[0];
    if (!manifest || !equivalentJson(manifest, options.catalogue.identity))
      rejectCommand('incompatible_version', 'assistant.catalogue_changed');
    // Only connection consent is renewable. Last-receipt semantic/date guards are not rebased.
    if (
      !equivalentJson(state.guards, {
        ...action.guards,
        connectionGeneration: state.guards.connectionGeneration,
      })
    )
      rejectCommand('stale_context', 'assistant.authority_changed');
    const next = action.plan.slots[action.cursor];
    const frozen = saved.intent.slots[action.cursor];
    options.assertUnheld(id, action.cursor);
    if (!next) return { ...loaded, slot: null };
    let slot: AssistantActionContinuationReview['slot'];
    if (frozen) {
      requireConversationRecord(
        frozen.slotId === next.slotId &&
          commandMatchesPlannedSlot(frozen.command, action.plan, next),
      );
      slot = { ...clone(frozen), commandState: 'frozen' };
    } else {
      requireConversationRecord(
        saved.intent.slots.length === action.cursor &&
          !(
            await session.all('SELECT 1 FROM command_slot WHERE slot_id=? OR operation_id=?', [
              next.slotId,
              next.operationId,
            ])
          ).length,
      );
      const command = plannedCommand(action.plan, next, state.guards.preferenceRevision);
      command.payloadFingerprint = await options.platform.sha256(commandFingerprintInput(command));
      requireConversationRecord(checkLocalCommand(command, options.catalogue).ok);
      slot = { slotId: next.slotId, command, commandState: 'prospective' };
    }
    const payload = slot.command.command;
    if (payload.kind === 'addPlan' || payload.kind === 'replacePlanRecipe') {
      const occupant = state.planOccurrences.find((entry) =>
        equivalentJson(entry.placement, payload.placement),
      );
      if (payload.kind === 'addPlan') {
        if (
          occupant ||
          (
            await session.all('SELECT 1 FROM plan_occurrence WHERE occurrence_id=?', [
              payload.occurrenceId,
            ])
          ).length
        )
          rejectCommand('stale_context', 'assistant.plan_target_changed');
      } else if (
        !occupant ||
        occupant.occurrenceId !== payload.occurrenceId ||
        occupant.revision !== payload.expectedRevision ||
        state.shoppingScope.revision !== payload.expectedShoppingScopeRevision
      )
        rejectCommand('stale_context', 'assistant.plan_target_changed');
    }
    if (
      payload.kind === 'savePreference' &&
      payload.expectedPreferenceRevision !== state.guards.preferenceRevision
    )
      rejectCommand('stale_context', 'assistant.authority_changed');
    return { ...loaded, slot };
  };
  const describe = async (
    session: SqlSession,
    loaded: Awaited<ReturnType<typeof loadSuspended>>,
    token: string,
  ) => {
    if (!loaded.slot) return null;
    const prefixReceipts: AssistantActionContinuationReview['prefixReceipts'] = [];
    for (const slot of loaded.saved.intent.slots.slice(0, loaded.action.cursor)) {
      const receipt = await readReceiptInSnapshot(
        session,
        slot.command.operationId,
        options.catalogue,
      );
      requireConversationRecord(
        receipt && matchOperationReceipt(slot.command, receipt) === 'existing',
      );
      prefixReceipts.push({ slotId: slot.slotId, receipt });
    }
    requireConversationRecord(
      prefixReceipts.length === loaded.action.cursor &&
        (await readReceiptInSnapshot(
          session,
          loaded.slot.command.operationId,
          options.catalogue,
        )) === null,
    );
    return {
      reviewToken: token,
      cursor: loaded.action.cursor,
      slot: clone(loaded.slot),
      prefixReceipts,
      state: loaded.state,
      catalogue: { ...options.catalogue.identity },
    };
  };

  return {
    invalidateActionContinuationReview: invalidate,
    readActionContinuationReview: async (input) => {
      invalidate();
      const expectedEpoch = epoch;
      try {
        const snapshot = clone(input);
        const result = await options.writer.transaction(
          async (session) => {
            const loaded = await loadSuspended(
              session,
              snapshot.userIntentId,
              snapshot.expectedIntentRevision,
            );
            const value = await describe(
              session,
              loaded,
              loaded.slot ? options.platform.newId() : '',
            );
            requireEpoch(expectedEpoch);
            return {
              kind: 'ready' as const,
              value,
              revision: await readRevision(session, 'store'),
            };
          },
          { kind: 'read_only' },
        );
        requireEpoch(expectedEpoch);
        if (result.value) {
          const review = copyReview(result.value);
          requireRuntime(review);
          current = { epoch: expectedEpoch, review, consumed: false };
        }
        return freezeResult(result);
      } catch (error) {
        return { kind: 'failed', error: errorDetail(error) };
      }
    },
    confirmActionContinuation: async (input) => {
      let command: LocalCommand | undefined;
      let admitted = false;
      let finalizationStarted = false;
      let finalizationPrepared = false;
      let finalizationQueued = false;
      let finalizationSnapshotEntered = false;
      try {
        const review = copyReview(input.review);
        command = review.slot.command;
        const candidate = current;
        const checked = checkLocalCommand(command, options.catalogue);
        if (!checked.ok)
          return { kind: 'failed', operationId: command.operationId, error: checked.error };
        if (!(await verifyCommandFingerprint(command, options.platform)))
          rejectCommand('operation_conflict', 'command.fingerprint_mismatch');
        if (options.writer.requiresRecovery()) {
          const receipt = await options.readHistoricalReceipt(command);
          if (receipt) return freezeResult({ kind: 'receipt', receipt });
          rejectCommand('storage_failure', 'assistant.writer_recovery_required');
        }
        let stage: 'reviewed' | 'finalizing' | 'finalized' | 'executing' = 'reviewed';
        const assertCurrent = () => {
          if (!candidate || current !== candidate)
            rejectCommand('cancelled', 'assistant.continuation_review_invalidated');
          requireEpoch(candidate.epoch);
          requireRuntime(review);
          options.assertUnheld(command!.userIntentId, review.cursor);
          if (!equivalentJson(candidate.review, review))
            rejectCommand('stale_context', 'assistant.continuation_review_changed');
          return undefined;
        };
        if (review.slot.commandState === 'prospective') {
          finalizationQueued = true;
          const finalized = await options.writer.transaction(
            async (session) => {
              finalizationSnapshotEntered = true;
              const receipt = await readReceiptInSnapshot(
                session,
                command!.operationId,
                options.catalogue,
              );
              if (receipt) {
                if (matchOperationReceipt(command!, receipt) !== 'existing')
                  rejectCommand('operation_conflict', 'command.operation_reused');
                return { receipt };
              }
              assertCurrent();
              if (!candidate || candidate.consumed)
                rejectCommand('stale_context', 'assistant.continuation_review_changed');
              const loaded = await loadSuspended(
                session,
                command!.userIntentId,
                command!.intentRevision,
              );
              const actual = await describe(session, loaded, review.reviewToken);
              if (!actual || !equivalentJson(actual, review))
                rejectCommand('stale_context', 'assistant.continuation_review_changed');
              assertCurrent();
              candidate.consumed = true;
              stage = 'finalizing';
              finalizationStarted = true;
              const slot = { slotId: review.slot.slotId, command: clone(command!) };
              const intent = {
                ...loaded.saved.intent,
                slots: [...loaded.saved.intent.slots, slot],
              };
              requireConversationRecord(validatePendingIntent(intent));
              await runBound(session, 'INSERT INTO command_slot VALUES (?, ?, ?, ?, ?)', [
                slot.slotId,
                intent.userIntentId,
                review.cursor,
                command!.operationId,
                JSON.stringify(command),
              ]);
              await runBound(
                session,
                'UPDATE pending_intent SET intent_json=? WHERE user_intent_id=?',
                [JSON.stringify(intent), intent.userIntentId],
              );
              const revision = (await readRevision(session, 'store')) + 1;
              requireConversationRecord(isRevision(revision));
              await runBound(
                session,
                "UPDATE state_revision SET revision=? WHERE collection='store'",
                [revision],
              );
              finalizationPrepared = true;
              return { revision };
            },
            { kind: 'intents', userIntentIds: [command.userIntentId] },
            () => {
              if (finalizationStarted) {
                assertCurrent();
                if (stage !== 'finalizing' || !candidate?.consumed)
                  rejectCommand('stale_context', 'assistant.continuation_review_changed');
              }
              return undefined;
            },
          );
          if (finalized.receipt)
            return freezeResult({ kind: 'receipt', receipt: finalized.receipt });
          stage = 'finalized';
          options.onFinalized(finalized.revision!);
        }
        const admission: PrivateReviewedContinuation = {
          authorize: async (session, executing) => {
            // This callback runs only after the executor proves the target receipt absent.
            assertCurrent();
            const prospective = review.slot.commandState === 'prospective';
            if (
              !candidate ||
              (prospective ? stage !== 'finalized' || !candidate.consumed : candidate.consumed)
            )
              rejectCommand('stale_context', 'assistant.continuation_review_changed');
            const loaded = await loadSuspended(
              session,
              command!.userIntentId,
              command!.intentRevision,
            );
            const actual = await describe(session, loaded, review.reviewToken);
            const expected = prospective
              ? { ...review, slot: { ...review.slot, commandState: 'frozen' as const } }
              : review;
            if (
              !actual ||
              !equivalentJson(actual, expected) ||
              !equivalentJson(actual.slot.command, executing)
            )
              rejectCommand('stale_context', 'assistant.continuation_review_changed');
            assertCurrent();
            candidate.consumed = true;
            stage = 'executing';
            admitted = true;
            return {
              saved: loaded.saved,
              action: loaded.action,
              assertCommitAdmission: () => {
                assertCurrent();
                if (stage !== 'executing' || !candidate.consumed)
                  rejectCommand('stale_context', 'assistant.continuation_review_changed');
                return undefined;
              },
            };
          },
        };
        let result: CommandResult;
        try {
          result = await options.execute(command, admission);
        } catch (error) {
          if (!admitted) throw error;
          result = { kind: 'uncertain', operationId: command.operationId };
        }
        if (
          !validateCommandResult(result) ||
          (result.kind === 'receipt'
            ? matchOperationReceipt(command, result.receipt) !== 'existing'
            : result.operationId !== command.operationId) ||
          (result.kind === 'failed' &&
            result.error.operationId !== undefined &&
            result.error.operationId !== command.operationId)
        )
          throw new StorageFault('storage_failure', 'Invalid continuation command result');
        // Historical receipts and rejected reviews never write journals or recreate cleared rows.
        if (result.kind === 'receipt' || !admitted) return freezeResult(result);
        return options.journal(review.slot.slotId, command, result);
      } catch (error) {
        // A prior queued job can invalidate a healthy writer before A's callback runs.
        // The command was already validated; independent history cannot authorize A or B.
        if (
          command &&
          finalizationQueued &&
          !finalizationSnapshotEntered &&
          options.writer.requiresRecovery()
        ) {
          try {
            const receipt = await options.readHistoricalReceipt(command);
            if (receipt) return freezeResult({ kind: 'receipt', receipt });
          } catch (historyError) {
            return {
              kind: 'failed',
              operationId: command.operationId,
              error: errorDetail(historyError),
            };
          }
        }
        if (
          command &&
          (admitted ||
            (finalizationStarted && options.writer.requiresRecovery()) ||
            (finalizationPrepared && !(error instanceof CommandFault)))
        )
          return { kind: 'uncertain', operationId: command.operationId };
        return {
          kind: 'failed',
          operationId: command?.operationId ?? input?.review?.slot?.command?.operationId ?? '',
          error: errorDetail(error),
        };
      }
    },
  };
}
