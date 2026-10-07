import {
  checkLocalCommand,
  commandFingerprintInput,
  isRelativeDateContextCurrent,
  isUtcInstant,
  matchOperationReceipt,
  validateLocalCommand,
  validatePendingIntent,
} from '@cookmate/contracts';
import type {
  CatalogueBoundary,
  CommandPayload,
  CommandResult,
  ContractError,
  ConversationOrigin,
  DateContext,
  LocalCommand,
  OperationReceipt,
  PendingIntent,
} from '@cookmate/contracts';
import { validateReceiptSemantics, verifyCommandFingerprint } from '@cookmate/domain';
import type {
  ChangedCollection,
  CommandPlatform,
  DirectReviewGuard,
  Immutable,
  RepositoryResult,
  StoreChange,
} from '@cookmate/domain';
import { readRevision } from './query';
import { readReceiptInSnapshot, readShoppingScopeInSnapshot } from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SerializedWriter, SqlSession } from './sql';

export class CommandFault extends Error {
  constructor(public readonly detail: ContractError) {
    super(detail.messageKey);
    this.name = 'CommandFault';
  }
}

export function rejectCommand(code: ContractError['code'], messageKey: string): never {
  throw new CommandFault({ code, messageKey, retry: 'after_correction' });
}

export interface MutationOutcome {
  outcome: OperationReceipt['outcome'];
  effects: OperationReceipt['effects'];
  collections: readonly ChangedCollection[];
  shoppingProjection: OperationReceipt['shoppingProjection'];
  /** Provenance can change semantic chat context even when a duplicate saved value is a domain no-op. */
  conversationChanged?: boolean;
}

export type CommandExecutionContext = Pick<LocalCommand, 'operationId' | 'origin'>;

export type CommandHandlers = {
  [Kind in CommandPayload['kind']]?: (
    session: SqlSession,
    payload: Extract<CommandPayload, { kind: Kind }>,
    committedAt: string,
    context: CommandExecutionContext,
  ) => Promise<MutationOutcome>;
};

export interface CommandExecutorOptions {
  assistantHooks?: AssistantCommandHooks;
  writer: SerializedWriter;
  catalogue: CatalogueBoundary;
  platform: Pick<CommandPlatform, 'sha256'>;
  handlers: CommandHandlers;
  now(): string;
  dateContext(): DateContext;
  readReceipt(operationId: string): Promise<RepositoryResult<OperationReceipt | null>>;
  onCommitted(change: StoreChange): void;
}

/** Private factory hooks keep assistant receipt-chain authority in the same write transaction. */
export interface AssistantCommandHooks {
  beforeExecute(session: SqlSession, command: LocalCommand): Promise<void>;
  afterReceipt(
    session: SqlSession,
    command: LocalCommand,
    receipt: OperationReceipt,
  ): Promise<PendingIntent['phase'] | undefined>;
  verifyRuntime(command: LocalCommand): void;
}

function sameOrigin(
  left: ConversationOrigin | undefined,
  right: ConversationOrigin | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.conversationId === right.conversationId &&
    left.generation === right.generation &&
    left.messageId === right.messageId
  );
}

function freezeCommand(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeCommand);
    Object.freeze(value);
  }
}

function requireCurrentRelativeDate(command: LocalCommand, currentDate: () => DateContext): void {
  if (
    command.relativeDateGuard &&
    !isRelativeDateContextCurrent(command.relativeDateGuard.interpretedAt, currentDate())
  )
    rejectCommand('stale_context', 'command.relative_date_changed');
}

async function requireCurrentAuthority(
  session: SqlSession,
  command: LocalCommand,
  currentDate: () => DateContext,
): Promise<PendingIntent> {
  const row = (
    await session.all<{ revision: number; phase: PendingIntent['phase']; intentJson: string }>(
      'SELECT revision, phase, intent_json AS intentJson FROM pending_intent WHERE user_intent_id = ?',
      [command.userIntentId],
    )
  )[0];
  if (!row) rejectCommand('stale_context', 'command.intent_not_registered');
  const intent: unknown = JSON.parse(row.intentJson);
  if (
    !validatePendingIntent(intent) ||
    intent.userIntentId !== command.userIntentId ||
    intent.revision !== row.revision ||
    intent.phase !== row.phase
  )
    throw new StorageFault('storage_failure', 'Stored intent is invalid');
  if (intent.revision !== command.intentRevision)
    rejectCommand('stale_context', 'command.intent_changed');
  if (intent.phase === 'cancelled' || intent.phase === 'reconciling')
    rejectCommand('cancelled', 'command.intent_cancelled');
  if (intent.phase !== 'ready' && intent.phase !== 'dispatched')
    rejectCommand('stale_context', 'command.intent_not_ready');
  const slot = intent.slots.find((item) => item.command.operationId === command.operationId);
  if (
    !slot ||
    slot.command.payloadFingerprint !== command.payloadFingerprint ||
    commandFingerprintInput(slot.command) !== commandFingerprintInput(command)
  )
    rejectCommand('operation_conflict', 'command.frozen_slot_mismatch');
  const storedSlot = (
    await session.all<{ slotId: string; commandJson: string }>(
      'SELECT slot_id AS slotId, command_json AS commandJson FROM command_slot WHERE user_intent_id = ? AND operation_id = ?',
      [command.userIntentId, command.operationId],
    )
  )[0];
  const storedCommand: unknown = storedSlot ? JSON.parse(storedSlot.commandJson) : null;
  if (
    !storedSlot ||
    storedSlot.slotId !== slot.slotId ||
    !validateLocalCommand(storedCommand) ||
    storedCommand.payloadFingerprint !== command.payloadFingerprint ||
    commandFingerprintInput(storedCommand) !== commandFingerprintInput(command)
  )
    throw new StorageFault('storage_failure', 'Stored command slot is inconsistent');
  if (!sameOrigin(intent.origin, command.origin))
    rejectCommand('stale_context', 'command.origin_changed');
  if (command.origin) {
    const origin = command.origin;
    const current = (
      await session.all<{ conversationId: string; generation: number }>(
        'SELECT conversation_id AS conversationId, generation FROM conversation WHERE singleton = 1',
      )
    )[0];
    const message = (
      await session.all<{ messageId: string }>(
        'SELECT message_id AS messageId FROM message WHERE message_id = ? AND conversation_id = ? AND generation = ?',
        [origin.messageId, origin.conversationId, origin.generation],
      )
    )[0];
    if (
      !current ||
      current.conversationId !== origin.conversationId ||
      current.generation !== origin.generation ||
      !message
    )
      rejectCommand('stale_context', 'command.conversation_changed');
  }
  requireCurrentRelativeDate(command, currentDate);
  if (command.command.kind === 'setShoppingSelection') {
    const guard = (
      await session.all<{ planRevision: number; shoppingScopeRevision: number }>(
        'SELECT plan_revision AS planRevision,shopping_scope_revision AS shoppingScopeRevision FROM command_review_guard WHERE operation_id=?',
        [command.operationId],
      )
    )[0];
    if (!guard || guard.shoppingScopeRevision !== command.command.expectedShoppingScopeRevision)
      throw new StorageFault('storage_failure', 'Missing or mismatched selection review guard');
    if (guard.planRevision !== (await readRevision(session, 'plan')))
      rejectCommand('stale_context', 'shopping.reviewed_meals_changed');
  }
  return intent;
}

async function storeReceipt(session: SqlSession, receipt: OperationReceipt): Promise<void> {
  await runBound(session, 'INSERT INTO operation_receipt VALUES (?, ?, ?, ?, ?, ?, ?)', [
    receipt.operationId,
    receipt.userIntentId,
    receipt.payloadFingerprint,
    receipt.outcome,
    receipt.committedAt,
    receipt.shoppingProjection,
    JSON.stringify(receipt.effects),
  ]);
}

async function advanceIntent(
  session: SqlSession,
  intent: PendingIntent,
  phaseOverride?: PendingIntent['phase'],
): Promise<void> {
  const receipts = await session.all<{ operationId: string }>(
    'SELECT operation_id AS operationId FROM operation_receipt WHERE user_intent_id = ?',
    [intent.userIntentId],
  );
  const committed = new Set(receipts.map((receipt) => receipt.operationId));
  const phase =
    phaseOverride ??
    (intent.slots.every((slot) => committed.has(slot.command.operationId))
      ? 'settled'
      : 'dispatched');
  await runBound(
    session,
    'UPDATE pending_intent SET phase = ?, intent_json = ? WHERE user_intent_id = ?',
    [phase, JSON.stringify({ ...intent, phase }), intent.userIntentId],
  );
}

/** Private adapter composition only: models/screens cannot register handler implementations. */
export function createCommandExecutor(options: CommandExecutorOptions) {
  // Retain unannounced changes across an uncertain delivery, but announce only after receipt proof.
  // This adapter lives with the writer; process restoration reloads state instead of replaying events.
  const pendingNotifications = new Map<string, StoreChange>();
  const notifyCommitted = (operationId: string) => {
    const change = pendingNotifications.get(operationId);
    if (change) {
      pendingNotifications.delete(operationId);
      try {
        options.onCommitted(change);
      } catch {
        /* Observer owns its recovery; commit is durable. */
      }
    }
  };
  return Object.freeze({
    async execute(input: Immutable<LocalCommand>): Promise<CommandResult> {
      // The public port is app-owned LocalCommand. Snapshot before the first asynchronous boundary.
      const command: LocalCommand = JSON.parse(JSON.stringify(input)) as LocalCommand;
      const failed = (error: ContractError): CommandResult => ({
        kind: 'failed',
        operationId: command.operationId,
        error,
      });
      const check = checkLocalCommand(command, options.catalogue);
      if (!check.ok) return failed(check.error);
      freezeCommand(command);
      try {
        if (!(await verifyCommandFingerprint(command, options.platform)))
          return failed({
            code: 'operation_conflict',
            messageKey: 'command.fingerprint_mismatch',
            retry: 'never',
          });
      } catch {
        return failed({
          code: 'storage_failure',
          messageKey: 'command.hash_failed',
          retry: 'after_correction',
        });
      }
      let callbackFinished = false;
      try {
        const committed = await options.writer.transaction(
          async (session) => {
            const existing = await readReceiptInSnapshot(
              session,
              command.operationId,
              options.catalogue,
            );
            const match = matchOperationReceipt(command, existing ?? undefined);
            if (match === 'conflict')
              rejectCommand('operation_conflict', 'command.operation_reused');
            if (existing) return { receipt: existing, change: null };
            const intent = await requireCurrentAuthority(session, command, options.dateContext);
            await options.assistantHooks?.beforeExecute(session, command);
            const handler = options.handlers[command.command.kind] as
              | ((
                  session: SqlSession,
                  payload: CommandPayload,
                  committedAt: string,
                  context: CommandExecutionContext,
                ) => Promise<MutationOutcome>)
              | undefined;
            if (!handler) rejectCommand('unsupported_request', 'command.handler_unavailable');
            const committedAt = options.now();
            if (!isUtcInstant(committedAt))
              throw new StorageFault('storage_failure', 'Invalid command clock');
            const mutation = await handler(session, command.command, committedAt, command);
            if ((mutation.outcome === 'no_op') !== (mutation.collections.length === 0))
              throw new StorageFault('storage_failure', 'Invalid mutation outcome');
            const collections = [
              ...new Set<ChangedCollection>([
                ...mutation.collections,
                ...(mutation.conversationChanged ? ['conversation' as const] : []),
              ]),
            ];
            const receipt: OperationReceipt = {
              schemaVersion: 1,
              operationId: command.operationId,
              userIntentId: command.userIntentId,
              payloadFingerprint: command.payloadFingerprint,
              committedAt,
              outcome: mutation.outcome,
              effects: mutation.effects,
              shoppingProjection: mutation.shoppingProjection,
            };
            if (!validateReceiptSemantics(receipt, options.catalogue))
              throw new StorageFault('storage_failure', 'Invalid operation receipt');
            let change: StoreChange | null = null;
            if (collections.length > 0) {
              for (const collection of ['store', ...collections]) {
                const revision = await readRevision(session, collection);
                if (!Number.isSafeInteger(revision + 1))
                  throw new StorageFault('storage_failure', 'Revision exhausted');
                await runBound(
                  session,
                  'UPDATE state_revision SET revision = ? WHERE collection = ?',
                  [revision + 1, collection],
                );
              }
              change = { revision: await readRevision(session, 'store'), collections };
            }
            await storeReceipt(session, receipt);
            const phase = await options.assistantHooks?.afterReceipt(session, command, receipt);
            if (phase !== undefined) {
              // Receipt journals/cursors change visible chat state even when the domain effect is
              // a no-op. They change the store version, without inventing semantic context changes.
              if (collections.length === 0) {
                const revision = await readRevision(session, 'store');
                if (!Number.isSafeInteger(revision + 1))
                  throw new StorageFault('storage_failure', 'Revision exhausted');
                await runBound(
                  session,
                  "UPDATE state_revision SET revision=? WHERE collection='store'",
                  [revision + 1],
                );
              }
              if (!collections.includes('conversation')) collections.push('conversation');
              change = { revision: await readRevision(session, 'store'), collections };
            }
            await advanceIntent(session, intent, phase);
            // Async projection/SQLite work can cross midnight or a timezone switch after entry checks.
            requireCurrentRelativeDate(command, options.dateContext);
            options.assistantHooks?.verifyRuntime(command);
            callbackFinished = true;
            if (change) pendingNotifications.set(command.operationId, change);
            return { receipt, change };
          },
          command.command.kind === 'clearConversation'
            ? { kind: 'all' }
            : { kind: 'intents', userIntentIds: [command.userIntentId] },
        );
        notifyCommitted(command.operationId);
        return { kind: 'receipt', receipt: committed.receipt };
      } catch (error) {
        if (error instanceof CommandFault) return failed(error.detail);
        // A COMMIT acknowledgement can be lost after durability. Reconcile using the independent reader.
        try {
          const result = await options.readReceipt(command.operationId);
          if (result.kind === 'ready' && result.value) {
            if (matchOperationReceipt(command, result.value) === 'existing') {
              notifyCommitted(command.operationId);
              return { kind: 'receipt', receipt: result.value };
            }
            return failed({
              code: 'operation_conflict',
              messageKey: 'command.operation_reused',
              retry: 'never',
            });
          }
          if (result.kind === 'ready') pendingNotifications.delete(command.operationId);
        } catch {
          /* Preserve uncertainty; never invent a receipt from an attempted write. */
        }
        return callbackFinished
          ? { kind: 'uncertain', operationId: command.operationId }
          : failed({
              code: 'storage_failure',
              messageKey: 'storage.command_failed',
              retry: 'reconcile',
            });
      }
    },
  });
}

/** Register only a deliberately authorized frozen intent; this function is never a provider tool. */
export async function registerReadyIntent(
  writer: SerializedWriter,
  input: PendingIntent,
  catalogue: CatalogueBoundary,
  platform: Pick<CommandPlatform, 'sha256'>,
  reviewedGuard?: DirectReviewGuard,
  registration?: { trackDirectRecovery: boolean },
): Promise<void> {
  const intent: unknown = JSON.parse(JSON.stringify(input));
  const trackDirectRecovery = registration?.trackDirectRecovery === true;
  const reviewGuard = reviewedGuard
    ? (JSON.parse(JSON.stringify(reviewedGuard)) as DirectReviewGuard)
    : undefined;
  if (!validatePendingIntent(intent) || intent.phase !== 'ready' || intent.slots.length === 0)
    rejectCommand('invalid_input', 'command.invalid_ready_intent');
  if (trackDirectRecovery && intent.origin)
    rejectCommand('invalid_input', 'command.invalid_direct_origin');
  const operations = new Set<string>();
  const slots = new Set<string>();
  for (const slot of intent.slots) {
    const command = slot.command;
    if (
      !checkLocalCommand(command, catalogue).ok ||
      command.userIntentId !== intent.userIntentId ||
      command.intentRevision !== intent.revision ||
      operations.has(command.operationId) ||
      slots.has(slot.slotId) ||
      !sameOrigin(command.origin, intent.origin) ||
      !(await verifyCommandFingerprint(command, platform))
    )
      rejectCommand('invalid_input', 'command.invalid_frozen_slot');
    operations.add(command.operationId);
    slots.add(slot.slotId);
  }
  await writer.transaction(
    async (session) => {
      const existing = (
        await session.all<{ intentJson: string }>(
          'SELECT intent_json AS intentJson FROM pending_intent WHERE user_intent_id = ?',
          [intent.userIntentId],
        )
      )[0];
      const json = JSON.stringify(intent);
      if (existing) {
        if (existing.intentJson !== json)
          rejectCommand('operation_conflict', 'command.intent_already_registered');
        return;
      }
      await runBound(session, 'INSERT INTO pending_intent VALUES (?, ?, ?, ?)', [
        intent.userIntentId,
        intent.revision,
        intent.phase,
        json,
      ]);
      for (const [position, slot] of intent.slots.entries()) {
        const payload = slot.command.command;
        // Low-level callers authorize a concrete command at registration. The production
        // facade always supplies the older reviewed guard and never silently refreshes it.
        const selectionGuard =
          payload.kind === 'setShoppingSelection'
            ? (reviewGuard ?? {
                kind: 'shopping_selection' as const,
                planRevision: await readRevision(session, 'plan'),
                shoppingScopeRevision: payload.expectedShoppingScopeRevision,
              })
            : null;
        if (
          selectionGuard &&
          (selectionGuard.kind !== 'shopping_selection' ||
            selectionGuard.planRevision !== (await readRevision(session, 'plan')) ||
            selectionGuard.shoppingScopeRevision !==
              (payload as Extract<CommandPayload, { kind: 'setShoppingSelection' }>)
                .expectedShoppingScopeRevision)
        )
          rejectCommand('stale_context', 'shopping.reviewed_meals_changed');
        if (
          reviewGuard?.kind === 'shopping_selection' &&
          reviewGuard.shoppingScopeRevision !==
            (await readShoppingScopeInSnapshot(session)).revision
        )
          rejectCommand('stale_context', 'shopping.reviewed_selection_changed');
        await runBound(session, 'INSERT INTO command_slot VALUES (?, ?, ?, ?, ?)', [
          slot.slotId,
          intent.userIntentId,
          position,
          slot.command.operationId,
          JSON.stringify(slot.command),
        ]);
        if (selectionGuard?.kind === 'shopping_selection')
          await runBound(session, 'INSERT INTO command_review_guard VALUES (?, ?, ?)', [
            slot.command.operationId,
            selectionGuard.planRevision,
            selectionGuard.shoppingScopeRevision,
          ]);
        if (trackDirectRecovery)
          await runBound(session, 'INSERT INTO direct_command_recovery(operation_id) VALUES (?)', [
            slot.command.operationId,
          ]);
      }
    },
    { kind: 'intents', userIntentIds: [intent.userIntentId] },
  );
}
