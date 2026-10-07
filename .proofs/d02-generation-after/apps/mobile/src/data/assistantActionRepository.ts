import {
  commandFingerprintInput,
  isRelativeDateContextCurrent,
  matchOperationReceipt,
  phaseAfterCancel,
  validateCommandResult,
  validatePendingIntent,
} from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  CatalogueBoundary,
  CommandResult,
  DateContext,
  LocalCommand,
  PendingIntent,
} from '@cookmate/contracts';
import { verifyCommandFingerprint } from '@cookmate/domain';
import type {
  AssistantPersistencePort,
  AssistantActionRecovery,
  AuthorizedActionPlan,
  CommandPlatform,
  CurrentActionState,
  Immutable,
  IntentGuardSnapshot,
  RepositoryResult,
  StoreChange,
  StoredAssistantIntent,
} from '@cookmate/domain';
import {
  commandMatchesPlannedSlot,
  plannedCommand,
  readActionPlanInSnapshot,
  validateAuthorizedActionPlan,
} from './actionPlanRecords';
import type { StoredActionPlan } from './actionPlanRecords';
import {
  equivalentJson,
  isDateContext,
  isIntentGuard,
  publicAssistantIntent,
  readAssistantIntentInSnapshot,
  utf8Length,
} from './assistantIntentRecords';
import type { AssistantIntentRecord } from './assistantIntentRecords';
import { CommandFault, rejectCommand } from './commandExecutor';
import type { AssistantCommandHooks } from './commandExecutor';
import {
  isAppId,
  isRevision,
  readConversationHeader,
  requireConversationRecord,
} from './conversationRecords';
import { freezeResult, readRevision } from './query';
import {
  readPlanInSnapshot,
  readPreferencesInSnapshot,
  readReceiptInSnapshot,
  readShoppingScopeInSnapshot,
} from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SerializedReader, SerializedWriter, SqlSession } from './sql';

interface ActionRepositoryOptions {
  reader: SerializedReader;
  writer: SerializedWriter;
  catalogue: CatalogueBoundary;
  platform: CommandPlatform;
  dateContext(): DateContext;
  connectionGeneration(): number;
  now(): string;
  onCommitted(change: StoreChange): void;
  executeCommand(command: Immutable<LocalCommand>): Promise<CommandResult>;
}
type AuthorityOptions = Pick<
  ActionRepositoryOptions,
  'catalogue' | 'platform' | 'dateContext' | 'connectionGeneration'
>;
type ActionRepository = Pick<
  AssistantPersistencePort,
  | 'readCurrentActionState'
  | 'readActionRecovery'
  | 'freezeActionPlan'
  | 'freezeIntent'
  | 'finalizeNextIntentSlot'
  | 'executeIntentSlot'
  | 'cancelIntent'
>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const failure = (error: unknown) => ({
  kind: 'failed' as const,
  error:
    error instanceof CommandFault
      ? error.detail
      : {
          code: 'storage_failure' as const,
          messageKey: 'assistant.action_storage_failed',
          retry: 'reconcile' as const,
        },
});

function runtime(options: AuthorityOptions) {
  const date = clone(options.dateContext());
  const connection = options.connectionGeneration();
  requireConversationRecord(isDateContext(date) && isRevision(connection));
  return { date, connection };
}
function requireRuntime(options: AuthorityOptions, request: AssistantTurnRequest): void {
  const current = runtime(options);
  if (
    current.connection !== request.connectionGeneration ||
    !isRelativeDateContextCurrent(current.date, request.context.date)
  )
    rejectCommand('stale_context', 'assistant.runtime_changed');
}
async function currentGuards(
  session: SqlSession,
  options: AuthorityOptions,
  baseline: IntentGuardSnapshot,
): Promise<IntentGuardSnapshot> {
  const header = await readConversationHeader(session);
  const actual = runtime(options);
  return {
    conversationId: header.conversationId,
    conversationGeneration: header.generation,
    contextRevision: header.revision,
    connectionGeneration: actual.connection,
    preferenceRevision: (await readPreferencesInSnapshot(session)).revision,
    relativeDateContext: actual.date,
    ...(baseline.planRevision !== undefined
      ? { planRevision: await readRevision(session, 'plan') }
      : {}),
    ...(baseline.shoppingScopeRevision !== undefined
      ? { shoppingScopeRevision: (await readShoppingScopeInSnapshot(session)).revision }
      : {}),
  };
}
async function requireGuards(
  session: SqlSession,
  options: AuthorityOptions,
  baseline: IntentGuardSnapshot,
): Promise<void> {
  if (!equivalentJson(baseline, await currentGuards(session, options, baseline)))
    rejectCommand('stale_context', 'assistant.authority_changed');
}
async function readIntent(
  session: SqlSession,
  options: Pick<AuthorityOptions, 'catalogue' | 'platform'>,
  id: string,
  revision?: number,
): Promise<AssistantIntentRecord> {
  if (!isAppId(id) || (revision !== undefined && !isRevision(revision)))
    rejectCommand('invalid_input', 'assistant.invalid_intent');
  const saved = await readAssistantIntentInSnapshot(session, options.catalogue, id);
  if (!saved || (revision !== undefined && saved.intent.revision !== revision))
    rejectCommand('stale_context', 'assistant.intent_changed');
  for (const slot of saved.intent.slots)
    requireConversationRecord(await verifyCommandFingerprint(slot.command, options.platform));
  return saved;
}

/** Exact historical proof shared by the per-ID port and the incremental gate. */
export async function readActionRecoveryInSnapshot(
  session: SqlSession,
  options: Pick<AuthorityOptions, 'catalogue' | 'platform'>,
  id: string,
): Promise<AssistantActionRecovery | null> {
  const saved = await readIntent(session, options, id);
  const header = await readConversationHeader(session);
  requireConversationRecord(
    saved.request.conversationId === header.conversationId &&
      saved.request.conversationGeneration === header.generation,
  );
  const plan = saved.actionPlan;
  if (!plan) return null;
  const slots: AssistantActionRecovery['slots'] = [];
  for (const slot of plan.slots) {
    const receipt = await readReceiptInSnapshot(session, slot.operationId, options.catalogue);
    if (receipt) {
      const frozen = saved.intent.slots.find((item) => item.slotId === slot.slotId);
      requireConversationRecord(
        frozen && matchOperationReceipt(frozen.command, receipt) === 'existing',
      );
    }
    slots.push({
      slotId: slot.slotId,
      operationId: slot.operationId,
      outcome: receipt
        ? 'receipt'
        : ['cancelled', 'reconciling'].includes(saved.intent.phase)
          ? 'not_executed'
          : 'unresolved',
      receipt,
    });
  }
  return {
    conversationId: header.conversationId,
    conversationGeneration: header.generation,
    userIntentId: saved.intent.userIntentId,
    intentRevision: saved.intent.revision,
    phase: saved.intent.phase,
    slots,
  };
}
async function actionRecord(
  session: SqlSession,
  options: AuthorityOptions,
  saved: AssistantIntentRecord,
): Promise<StoredActionPlan> {
  const action = await readActionPlanInSnapshot(
    session,
    saved.intent.userIntentId,
    options.catalogue,
    saved.request,
    saved.response,
  );
  if (!action) rejectCommand('stale_context', 'assistant.action_plan_required');
  return action;
}
function requireActive(saved: AssistantIntentRecord): void {
  if (saved.slotResults.some((entry) => entry.result.kind === 'uncertain'))
    rejectCommand('stale_context', 'assistant.reconciliation_required');
  if (saved.lifecycle !== 'accepted' || !['ready', 'dispatched'].includes(saved.intent.phase))
    rejectCommand('cancelled', 'assistant.intent_not_active');
}
async function updateIntent(session: SqlSession, intent: PendingIntent): Promise<void> {
  if (!validatePendingIntent(intent))
    throw new StorageFault('storage_failure', 'Invalid action intent');
  await runBound(
    session,
    'UPDATE pending_intent SET phase=?, intent_json=? WHERE user_intent_id=?',
    [intent.phase, JSON.stringify(intent), intent.userIntentId],
  );
}
async function stateFor(
  session: SqlSession,
  options: AuthorityOptions,
  saved: AssistantIntentRecord,
): Promise<CurrentActionState> {
  if (!saved.guards || saved.response?.kind !== 'proposal')
    rejectCommand('stale_context', 'assistant.proposal_required');
  const baseline =
    (
      await readActionPlanInSnapshot(
        session,
        saved.intent.userIntentId,
        options.catalogue,
        saved.request,
        saved.response,
      )
    )?.guards ?? saved.guards;
  const proposals = saved.response.proposals;
  const plan = await readPlanInSnapshot(session, options.catalogue, '1900-01-01', '2100-12-31');
  return {
    guards: await currentGuards(session, options, baseline),
    shoppingScope: { ...plan.shoppingScope, occurrenceIds: [...plan.shoppingScope.occurrenceIds] },
    planOccurrences: plan.occurrences.filter((occurrence) =>
      proposals.some(
        (proposal) =>
          proposal.kind === 'addPlan' && equivalentJson(proposal.placement, occurrence.placement),
      ),
    ),
  };
}

/** These hooks share one serialized writer. The active value lasts only through that command's transaction. */
export function createAssistantCommandHooks(options: AuthorityOptions): AssistantCommandHooks {
  let active: {
    command: LocalCommand;
    saved: AssistantIntentRecord;
    action: StoredActionPlan;
  } | null = null;
  return {
    beforeExecute: async (session, command) => {
      active = null;
      if (
        !(
          await session.all('SELECT 1 FROM assistant_intent_context WHERE user_intent_id=?', [
            command.userIntentId,
          ])
        ).length
      ) {
        requireConversationRecord(
          !(
            await session.all(
              'SELECT 1 FROM assistant_action_plan WHERE user_intent_id=? UNION ALL SELECT 1 FROM assistant_acceptance_envelope WHERE user_intent_id=?',
              [command.userIntentId, command.userIntentId],
            )
          ).length,
        );
        return;
      }
      const saved = await readIntent(
        session,
        options,
        command.userIntentId,
        command.intentRevision,
      );
      const action = await actionRecord(session, options, saved);
      requireActive(saved);
      await requireGuards(session, options, action.guards);
      requireRuntime(options, saved.request);
      const next = action.plan.slots[action.cursor];
      const frozen = saved.intent.slots[action.cursor];
      if (
        !next ||
        !frozen ||
        frozen.slotId !== next.slotId ||
        !equivalentJson(frozen.command, command) ||
        !commandMatchesPlannedSlot(command, action.plan, next)
      )
        rejectCommand('stale_context', 'assistant.slot_not_next');
      active = { command: clone(command), saved, action };
    },
    afterReceipt: async (session, command, receipt) => {
      if (!active || active.command.operationId !== command.operationId) {
        if (
          (
            await session.all('SELECT 1 FROM assistant_intent_context WHERE user_intent_id=?', [
              command.userIntentId,
            ])
          ).length
        )
          throw new StorageFault('storage_failure', 'Missing assistant execution authority');
        return undefined;
      }
      const { saved, action } = active;
      const row = (
        await session.all<{ cursor: number; planJson: string; guardsJson: string }>(
          'SELECT cursor, plan_json AS planJson, guards_json AS guardsJson FROM assistant_action_plan WHERE user_intent_id=?',
          [command.userIntentId],
        )
      )[0];
      const actual = await readReceiptInSnapshot(session, command.operationId, options.catalogue);
      requireConversationRecord(
        row &&
          row.cursor === action.cursor &&
          equivalentJson(JSON.parse(row.planJson), action.plan) &&
          equivalentJson(JSON.parse(row.guardsJson), action.guards) &&
          actual &&
          equivalentJson(actual, receipt) &&
          matchOperationReceipt(command, actual) === 'existing',
      );
      const slot = action.plan.slots[action.cursor]!;
      const results = saved.slotResults.filter((entry) => entry.slotId !== slot.slotId);
      results.push({ slotId: slot.slotId, result: { kind: 'receipt', receipt: actual } });
      const guards = await currentGuards(session, options, action.guards);
      // Runtime authority is never rebased by an effect; final verification also runs before COMMIT.
      guards.connectionGeneration = action.guards.connectionGeneration;
      guards.relativeDateContext = action.guards.relativeDateContext;
      await runBound(
        session,
        'UPDATE assistant_intent_context SET slot_results_json=? WHERE user_intent_id=?',
        [JSON.stringify(results), command.userIntentId],
      );
      await runBound(
        session,
        'UPDATE assistant_action_plan SET guards_json=?, cursor=? WHERE user_intent_id=?',
        [JSON.stringify(guards), action.cursor + 1, command.userIntentId],
      );
      return action.cursor + 1 === action.plan.slots.length ? 'settled' : 'dispatched';
    },
    verifyRuntime: (command) => {
      if (active?.command.operationId !== command.operationId) return;
      const request = active.saved.request;
      active = null;
      requireRuntime(options, request);
    },
  };
}

/** Only persisted response proposals can become a reserved plan and then a finalized command. */
export function createAssistantActionRepository(
  options: ActionRepositoryOptions,
): ActionRepository {
  interface WriteResult<T> {
    value: T;
    proof?: (session: SqlSession) => Promise<boolean>;
    runtimeRequest?: AssistantTurnRequest;
  }
  const notifications = new Map<
    string,
    { revision: number; proof: (session: SqlSession) => Promise<boolean> }
  >();
  const notify = (revision: number) => {
    try {
      options.onCommitted({ revision, collections: ['conversation'] });
    } catch {
      /* Observer failure cannot undo persistence. */
    }
  };
  const reconcile = async () => {
    for (const [key, pending] of [...notifications]) {
      try {
        const proven = await options.reader.transaction(pending.proof);
        if (notifications.get(key) !== pending) continue;
        notifications.delete(key);
        if (proven) notify(pending.revision);
      } catch {
        /* Keep the operation-specific proof until its durable state can be read. */
      }
    }
  };
  const read = async <T>(
    work: (session: SqlSession) => Promise<T>,
    queue: Pick<SerializedReader, 'transaction'> = options.reader,
  ): Promise<RepositoryResult<T>> => {
    try {
      return await queue.transaction(
        async (session) => ({
          kind: 'ready' as const,
          value: freezeResult(await work(session)),
          revision: await readRevision(session, 'store'),
        }),
        { kind: 'read_only' },
      );
    } catch (error) {
      return failure(error);
    }
  };
  const write = async <T>(
    key: string,
    work: (session: SqlSession) => Promise<WriteResult<T>>,
    userIntentId?: string,
  ): Promise<RepositoryResult<T>> => {
    let attempted:
      | { revision: number; proof: (session: SqlSession) => Promise<boolean> }
      | undefined;
    try {
      const result = await options.writer.transaction(
        async (session) => {
          const value = await work(session);
          let revision = await readRevision(session, 'store');
          if (value.proof) {
            if (!isRevision(revision + 1))
              throw new StorageFault('storage_failure', 'Revision exhausted');
            await runBound(
              session,
              "UPDATE state_revision SET revision=? WHERE collection='store'",
              [++revision],
            );
            attempted = { revision, proof: value.proof };
          }
          if (value.runtimeRequest) requireRuntime(options, value.runtimeRequest);
          return { kind: 'ready' as const, value: freezeResult(value.value), revision };
        },
        userIntentId ? { kind: 'intents', userIntentIds: [userIntentId] } : { kind: 'all' },
      );
      if (attempted) {
        notifications.delete(key);
        notify(attempted.revision);
      }
      await reconcile();
      return result;
    } catch (error) {
      if (attempted) notifications.set(key, attempted);
      await reconcile();
      return failure(error);
    }
  };
  const planProof = (id: string, plan: AuthorizedActionPlan) => async (session: SqlSession) => {
    const row = (
      await session.all<{ json: string }>(
        'SELECT plan_json AS json FROM assistant_action_plan WHERE user_intent_id=?',
        [id],
      )
    )[0];
    return !!row && equivalentJson(JSON.parse(row.json), plan);
  };
  const freeze = async (
    session: SqlSession,
    plan: AuthorizedActionPlan,
    expectedRevision: number,
    guards: IntentGuardSnapshot,
    frozen?: PendingIntent,
  ): Promise<WriteResult<StoredAssistantIntent>> => {
    const saved = await readIntent(session, options, plan.userIntentId, expectedRevision);
    if (
      !validateAuthorizedActionPlan(plan, saved.request, saved.response, options.catalogue) ||
      !isIntentGuard(guards) ||
      plan.revision !== expectedRevision ||
      utf8Length(JSON.stringify(plan)) > 131072
    )
      rejectCommand('invalid_input', 'assistant.invalid_action_plan');
    const existing = await readActionPlanInSnapshot(
      session,
      plan.userIntentId,
      options.catalogue,
      saved.request,
      saved.response,
    );
    if (existing) {
      if (
        !equivalentJson(existing.plan, plan) ||
        (frozen && !equivalentJson(saved.intent.slots, frozen.slots))
      )
        rejectCommand('operation_conflict', 'assistant.action_plan_already_frozen');
      return { value: publicAssistantIntent(saved) };
    }
    if (
      saved.lifecycle !== 'accepted' ||
      saved.intent.phase !== 'confirmation' ||
      saved.intent.slots.length ||
      !saved.guards ||
      !equivalentJson(guards, saved.guards)
    )
      rejectCommand('stale_context', 'assistant.accepted_authority_changed');
    await requireGuards(session, options, saved.guards);
    requireRuntime(options, saved.request);
    const current = await stateFor(session, options, saved);
    for (const slot of plan.slots) {
      const payload = slot.payload;
      if (
        (
          await session.all(
            'SELECT 1 FROM command_slot WHERE slot_id=? OR operation_id=? UNION ALL SELECT 1 FROM operation_receipt WHERE operation_id=?',
            [slot.slotId, slot.operationId, slot.operationId],
          )
        ).length ||
        (
          await session.all(
            "SELECT 1 FROM assistant_action_plan a, json_each(a.plan_json, '$.slots') s WHERE json_extract(s.value,'$.slotId')=? OR json_extract(s.value,'$.operationId')=?",
            [slot.slotId, slot.operationId],
          )
        ).length
      )
        rejectCommand('operation_conflict', 'assistant.reserved_identity_reused');
      if (
        payload.kind === 'savePreference' &&
        (
          await session.all('SELECT 1 FROM saved_preference WHERE preference_id=?', [
            payload.preferenceId,
          ])
        ).length
      )
        rejectCommand('operation_conflict', 'assistant.preference_identity_reused');
      if (payload.kind === 'addPlan' || payload.kind === 'replacePlanRecipe') {
        const occupant = current.planOccurrences.find((entry) =>
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
          current.shoppingScope.revision !== payload.expectedShoppingScopeRevision
        )
          rejectCommand('stale_context', 'assistant.plan_target_changed');
      }
    }
    const intent: PendingIntent = {
      ...saved.intent,
      phase: 'ready',
      slots: frozen?.slots ?? [],
      ...(plan.relativeDateGuard ? { relativeDateGuard: plan.relativeDateGuard } : {}),
    };
    await runBound(session, 'INSERT INTO assistant_action_plan VALUES (?, ?, ?, 0)', [
      plan.userIntentId,
      JSON.stringify(plan),
      JSON.stringify(guards),
    ]);
    await updateIntent(session, intent);
    for (const [position, slot] of intent.slots.entries())
      await runBound(session, 'INSERT INTO command_slot VALUES (?, ?, ?, ?, ?)', [
        slot.slotId,
        intent.userIntentId,
        position,
        slot.command.operationId,
        JSON.stringify(slot.command),
      ]);
    return {
      value: publicAssistantIntent((await readIntent(session, options, intent.userIntentId))!),
      proof: planProof(intent.userIntentId, plan),
      runtimeRequest: saved.request,
    };
  };
  const repository: ActionRepository = {
    readActionRecovery: (id) =>
      read((session) => readActionRecoveryInSnapshot(session, options, id), options.writer),
    readCurrentActionState: (id) =>
      read(async (session) => stateFor(session, options, await readIntent(session, options, id))),
    freezeActionPlan: async (input) => {
      const snapshot = clone(input);
      return write(
        `plan:${snapshot.plan.userIntentId}`,
        (session) =>
          freeze(session, snapshot.plan, snapshot.expectedIntentRevision, snapshot.guards),
        snapshot.plan.userIntentId,
      );
    },
    freezeIntent: async (input) => {
      const snapshot = clone(input);
      return write(
        `plan:${snapshot.intent.userIntentId}`,
        async (session) => {
          const intent = snapshot.intent;
          if (
            !validatePendingIntent(intent) ||
            intent.phase !== 'ready' ||
            !intent.origin ||
            !intent.slots.length ||
            intent.slots.filter((slot) => slot.command.command.kind === 'savePreference').length > 1
          )
            rejectCommand('invalid_input', 'assistant.invalid_frozen_intent');
          const plan: AuthorizedActionPlan = {
            userIntentId: intent.userIntentId,
            revision: intent.revision,
            origin: intent.origin,
            ...(intent.relativeDateGuard ? { relativeDateGuard: intent.relativeDateGuard } : {}),
            slots: intent.slots.map((slot, proposalIndex) => {
              const payload = slot.command.command;
              const planned =
                payload.kind === 'savePreference'
                  ? (({ expectedPreferenceRevision: _revision, ...rest }) => rest)(payload)
                  : payload;
              return {
                slotId: slot.slotId,
                operationId: slot.command.operationId,
                proposalIndex,
                payload: planned,
              };
            }),
          };
          for (const [index, slot] of intent.slots.entries())
            if (
              !commandMatchesPlannedSlot(slot.command, plan, plan.slots[index]!) ||
              !(await verifyCommandFingerprint(slot.command, options.platform)) ||
              (slot.command.command.kind === 'savePreference' &&
                slot.command.command.expectedPreferenceRevision !==
                  snapshot.guards.preferenceRevision)
            )
              rejectCommand('invalid_input', 'assistant.invalid_frozen_slot');
          return freeze(session, plan, snapshot.expectedIntentRevision, snapshot.guards, intent);
        },
        snapshot.intent.userIntentId,
      );
    },
    finalizeNextIntentSlot: async (input) => {
      const snapshot = clone(input);
      return write(
        `slot:${snapshot.userIntentId}:${snapshot.slotId}`,
        async (session) => {
          if (!isAppId(snapshot.slotId)) rejectCommand('invalid_input', 'assistant.invalid_slot');
          const saved = await readIntent(
            session,
            options,
            snapshot.userIntentId,
            snapshot.expectedIntentRevision,
          );
          const action = await actionRecord(session, options, saved);
          const existing = saved.intent.slots.find((slot) => slot.slotId === snapshot.slotId);
          if (existing) return { value: { intent: publicAssistantIntent(saved), slot: existing } };
          requireActive(saved);
          const next = action.plan.slots[action.cursor];
          if (
            !next ||
            next.slotId !== snapshot.slotId ||
            saved.intent.slots.length !== action.cursor
          )
            rejectCommand('stale_context', 'assistant.slot_not_next');
          await requireGuards(session, options, action.guards);
          requireRuntime(options, saved.request);
          const command = plannedCommand(
            action.plan,
            next,
            (await readPreferencesInSnapshot(session)).revision,
          );
          command.payloadFingerprint = await options.platform.sha256(
            commandFingerprintInput(command),
          );
          const slot = { slotId: next.slotId, command };
          const intent = { ...saved.intent, slots: [...saved.intent.slots, slot] };
          await runBound(session, 'INSERT INTO command_slot VALUES (?, ?, ?, ?, ?)', [
            slot.slotId,
            intent.userIntentId,
            action.cursor,
            command.operationId,
            JSON.stringify(command),
          ]);
          await updateIntent(session, intent);
          const actual = await readIntent(session, options, intent.userIntentId);
          return {
            value: { intent: publicAssistantIntent(actual), slot },
            runtimeRequest: saved.request,
            proof: async (proofSession) => {
              const row = (
                await proofSession.all<{ json: string }>(
                  'SELECT command_json AS json FROM command_slot WHERE user_intent_id=? AND slot_id=?',
                  [intent.userIntentId, slot.slotId],
                )
              )[0];
              return !!row && equivalentJson(JSON.parse(row.json), command);
            },
          };
        },
        snapshot.userIntentId,
      );
    },
    executeIntentSlot: async (input) => {
      const snapshot = clone(input);
      let command: LocalCommand | undefined;
      let operationId = snapshot.slotId;
      try {
        const loaded = await options.reader.transaction(async (session) => {
          if (!isAppId(snapshot.slotId)) rejectCommand('invalid_input', 'assistant.invalid_slot');
          const saved = await readIntent(
            session,
            options,
            snapshot.userIntentId,
            snapshot.expectedIntentRevision,
          );
          const action = await actionRecord(session, options, saved);
          operationId =
            action.plan.slots.find((item) => item.slotId === snapshot.slotId)?.operationId ??
            operationId;
          const slot = saved.intent.slots.find((item) => item.slotId === snapshot.slotId);
          if (!slot) rejectCommand('stale_context', 'assistant.slot_not_finalized');
          command = slot.command;
          const actual = await readReceiptInSnapshot(
            session,
            command.operationId,
            options.catalogue,
          );
          if (actual) return { receipt: actual };
          requireActive(saved);
          if (action.plan.slots[action.cursor]?.slotId !== slot.slotId)
            rejectCommand('stale_context', 'assistant.slot_not_next');
          await requireGuards(session, options, action.guards);
          requireRuntime(options, saved.request);
          return { command };
        });
        if (loaded.receipt) return freezeResult({ kind: 'receipt', receipt: loaded.receipt });
        let result: CommandResult;
        try {
          result = await options.executeCommand(loaded.command!);
        } catch {
          result = { kind: 'uncertain', operationId: command!.operationId };
        }
        const proven = await options.reader.transaction(async (session) => {
          const actual = await readReceiptInSnapshot(
            session,
            command!.operationId,
            options.catalogue,
          );
          if (
            !actual ||
            (
              await session.all('SELECT 1 FROM pending_intent WHERE user_intent_id=?', [
                snapshot.userIntentId,
              ])
            ).length
          )
            await readIntent(
              session,
              options,
              snapshot.userIntentId,
              snapshot.expectedIntentRevision,
            );
          return actual;
        });
        if (proven) {
          requireConversationRecord(matchOperationReceipt(command!, proven) === 'existing');
          return freezeResult({ kind: 'receipt', receipt: proven });
        }
        if (result.kind === 'receipt')
          throw new StorageFault('storage_failure', 'Command receipt is not persisted');
        if (
          !validateCommandResult(result) ||
          result.operationId !== command!.operationId ||
          (result.kind === 'failed' &&
            result.error.operationId !== undefined &&
            result.error.operationId !== command!.operationId)
        )
          throw new StorageFault('storage_failure', 'Invalid command result');
        const journal = await write(
          `result:${command!.operationId}`,
          async (session) => {
            const saved = await readIntent(
              session,
              options,
              snapshot.userIntentId,
              snapshot.expectedIntentRevision,
            );
            const actual = await readReceiptInSnapshot(
              session,
              command!.operationId,
              options.catalogue,
            );
            if (actual)
              return { value: { kind: 'receipt' as const, receipt: actual } as CommandResult };
            const results = saved.slotResults.filter((entry) => entry.slotId !== snapshot.slotId);
            results.push({ slotId: snapshot.slotId, result });
            if (
              equivalentJson(results, saved.slotResults) &&
              (result.kind !== 'uncertain' || saved.intent.phase === 'reconciling')
            )
              return { value: result };
            await runBound(
              session,
              'UPDATE assistant_intent_context SET slot_results_json=? WHERE user_intent_id=?',
              [JSON.stringify(results), snapshot.userIntentId],
            );
            if (result.kind === 'uncertain')
              await updateIntent(session, { ...saved.intent, phase: 'reconciling' });
            return {
              value: result,
              proof: async (proofSession) => {
                const row = (
                  await proofSession.all<{ json: string }>(
                    'SELECT slot_results_json AS json FROM assistant_intent_context WHERE user_intent_id=?',
                    [snapshot.userIntentId],
                  )
                )[0];
                return !!row && equivalentJson(JSON.parse(row.json), results);
              },
            };
          },
          snapshot.userIntentId,
        );
        return journal.kind === 'ready' ? journal.value : result;
      } catch (error) {
        const failed = failure(error);
        return {
          kind: 'failed',
          operationId: command?.operationId ?? operationId,
          error: failed.error,
        };
      }
    },
    cancelIntent: async (input) => {
      const snapshot = clone(input);
      return write(
        `cancel:${snapshot.userIntentId}`,
        async (session) => {
          const saved = await readIntent(
            session,
            options,
            snapshot.userIntentId,
            snapshot.expectedIntentRevision,
          );
          const phase = phaseAfterCancel(saved.intent.phase);
          if (
            phase === saved.intent.phase &&
            (phase === 'settled' || saved.lifecycle === 'cancelled')
          )
            return { value: publicAssistantIntent(saved) };
          await updateIntent(session, { ...saved.intent, phase });
          await runBound(
            session,
            "UPDATE assistant_intent_context SET lifecycle='cancelled' WHERE user_intent_id=?",
            [snapshot.userIntentId],
          );
          const actual = await readIntent(session, options, snapshot.userIntentId);
          return {
            value: publicAssistantIntent(actual),
            proof: async (proofSession) => {
              const row = (
                await proofSession.all<{ lifecycle: string; phase: string }>(
                  'SELECT a.lifecycle,p.phase FROM assistant_intent_context a JOIN pending_intent p ON p.user_intent_id=a.user_intent_id WHERE p.user_intent_id=?',
                  [snapshot.userIntentId],
                )
              )[0];
              return row?.lifecycle === 'cancelled' && row.phase === phase;
            },
          };
        },
        snapshot.userIntentId,
      );
    },
  };
  return repository;
}
