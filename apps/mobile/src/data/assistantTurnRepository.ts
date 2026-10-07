import {
  checkAssistantRequest,
  acceptanceFingerprintInput,
  API_VERSION,
  checkAssistantResponse,
  isRelativeDateContextCurrent,
  isResponseCurrent,
  isUtcInstant,
} from '@cookmate/contracts';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  CatalogueBoundary,
  DateContext,
  PendingIntent,
} from '@cookmate/contracts';
import type {
  AssistantPersistencePort,
  AssistantAcceptanceResult,
  CommandPlatform,
  ConversationHeader,
  IntentGuardSnapshot,
  RepositoryResult,
  StoreChange,
  StoredAssistantIntent,
} from '@cookmate/domain';
import {
  equivalentJson,
  isDateContext,
  readAssistantIntentInSnapshot,
  publicAssistantIntent,
  utf8Length,
} from './assistantIntentRecords';
import type { AssistantIntentRecord } from './assistantIntentRecords';
import {
  isAppId,
  isRevision,
  readConversationHeader,
  requireConversationRecord,
} from './conversationRecords';
import { CommandFault, rejectCommand } from './commandExecutor';
import { freezeResult, readRevision, readSnapshot } from './query';
import { readPreferencesInSnapshot, readShoppingScopeInSnapshot } from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SerializedReader, SerializedWriter, SqlSession } from './sql';
import { readContextInSnapshot } from './assistantContextRepository';
import { applyAcceptedMemory } from './memoryAcceptance';
import { readAcceptanceInSnapshot } from './acceptanceRecords';
import { readMemoryState } from './memoryRecords';
import { encodeStoredText } from './storedText';

interface TurnRepositoryOptions {
  reader: SerializedReader;
  writer: Pick<SerializedWriter, 'transaction'>;
  catalogue: CatalogueBoundary;
  platform: CommandPlatform;
  now(): string;
  dateContext(): DateContext;
  connectionGeneration(): number;
  onCommitted(change: StoreChange): void;
}
type TurnRepository = Pick<
  AssistantPersistencePort,
  | 'readIntent'
  | 'readAcceptance'
  | 'rearmTurn'
  | 'saveDraft'
  | 'beginTurn'
  | 'acceptResponse'
  | 'recordTurnFailure'
>;

const clone = <Value>(value: Value): Value => JSON.parse(JSON.stringify(value)) as Value;
function publicIntent(record: AssistantIntentRecord): StoredAssistantIntent {
  return publicAssistantIntent(record);
}
async function advance(session: SqlSession, conversation = true): Promise<number> {
  for (const collection of conversation ? ['store', 'conversation'] : ['store']) {
    const revision = await readRevision(session, collection);
    if (!Number.isSafeInteger(revision + 1))
      throw new StorageFault('storage_failure', 'Revision exhausted');
    await runBound(session, 'UPDATE state_revision SET revision = ? WHERE collection = ?', [
      revision + 1,
      collection,
    ]);
  }
  return readRevision(session, 'conversation');
}

/** Durable turn construction only; action freezing/dispatch are composed separately. */
export function createAssistantTurnRepository(options: TurnRepositoryOptions): TurnRepository {
  const fail = (error: unknown) => ({
    kind: 'failed' as const,
    error:
      error instanceof CommandFault
        ? error.detail
        : {
            code: 'storage_failure' as const,
            messageKey: 'conversation.write_failed',
            retry: 'reconcile' as const,
          },
  });
  type WriteKind = 'begin' | 'accept' | 'failure' | 'draft' | 'rearm';
  type TurnValue = StoredAssistantIntent | ConversationHeader | AssistantAcceptanceResult;
  interface PendingNotification {
    revision: number;
    proves(session: SqlSession): Promise<boolean>;
  }
  const pendingNotifications = new Map<string, PendingNotification>();
  const notify = (revision: number, draftHeader?: ConversationHeader) => {
    try {
      options.onCommitted({
        revision,
        collections: ['conversation'],
        ...(draftHeader
          ? { conversationChange: { kind: 'draft_only' as const, header: draftHeader } }
          : {}),
      });
    } catch {
      /* Observers cannot undo committed state. */
    }
  };
  const proofFor = (
    kind: WriteKind,
    value: TurnValue,
    revision: number,
  ): [string, PendingNotification] => {
    if ('acknowledgement' in value) value = value.acknowledgement;
    if ('intent' in value)
      return [
        `${kind}:${value.intent.userIntentId}`,
        {
          revision,
          proves: async (session) => {
            const actual = await readAssistantIntentInSnapshot(
              session,
              options.catalogue,
              value.intent.userIntentId,
            );
            if (!actual || !equivalentJson(actual.request, value.request)) return false;
            return (
              kind === 'begin' ||
              (equivalentJson(actual.response, value.response) &&
                (kind !== 'rearm' || actual.intent.phase === value.intent.phase) &&
                equivalentJson(actual.guards, value.guards))
            );
          },
        },
      ];
    return [
      `draft:${value.conversationId}`,
      {
        revision,
        proves: async (session) => {
          const actual = await readConversationHeader(session);
          return (
            actual.conversationId === value.conversationId &&
            actual.generation === value.generation &&
            actual.composerDraft === value.composerDraft
          );
        },
      },
    ];
  };
  const reconcileNotifications = async () => {
    if (!pendingNotifications.size) return;
    try {
      const proofs = await options.reader.transaction(async (session) => {
        const result: [string, PendingNotification, boolean][] = [];
        for (const [key, entry] of [...pendingNotifications])
          result.push([key, entry, await entry.proves(session)]);
        return result;
      });
      for (const [key, entry, proven] of proofs) {
        if (pendingNotifications.get(key) !== entry) continue;
        pendingNotifications.delete(key);
        if (proven) notify(entry.revision);
      }
    } catch {
      /* Retain uncertainty until the independent reader can prove the specific durable value. */
    }
  };
  const write = async <Value extends TurnValue>(
    kind: WriteKind,
    work: (session: SqlSession) => Promise<Value>,
    historicalReplay: () => boolean = () => false,
    userIntentId?: string,
  ): Promise<RepositoryResult<Value>> => {
    let attempted: [string, PendingNotification] | undefined;
    let admissionRequest: StoredAssistantIntent['request'] | undefined;
    try {
      const result = await options.writer.transaction(
        async (session) => {
          const before = await readRevision(session, 'store');
          const value = await work(session);
          const revision = await readRevision(session, 'store');
          const turn = 'acknowledgement' in value ? value.acknowledgement : value;
          if (
            (kind === 'begin' || kind === 'accept' || kind === 'rearm') &&
            'request' in turn &&
            !historicalReplay()
          )
            admissionRequest = turn.request;
          if (revision !== before) attempted = proofFor(kind, freezeResult(value), revision);
          return { value: freezeResult(value), revision, changed: revision !== before };
        },
        kind === 'draft'
          ? { kind: 'draft_only' }
          : userIntentId
            ? { kind: 'intents', userIntentIds: [userIntentId] }
            : { kind: 'all' },
        () => {
          if (admissionRequest) requireRuntimeCurrent(admissionRequest);
        },
      );
      if (result.changed) {
        if (attempted) pendingNotifications.delete(attempted[0]);
        notify(
          result.revision,
          kind === 'draft' && 'composerDraft' in result.value ? result.value : undefined,
        );
      }
      await reconcileNotifications();
      return { kind: 'ready', value: result.value, revision: result.revision };
    } catch (error) {
      // Publish a pending proof only after the transaction has settled, never while it is in flight.
      if (attempted) pendingNotifications.set(...attempted);
      await reconcileNotifications();
      return fail(error);
    }
  };
  const runtime = () => {
    const connectionGeneration = options.connectionGeneration();
    const date = clone(options.dateContext());
    requireConversationRecord(isRevision(connectionGeneration) && isDateContext(date));
    return { connectionGeneration, date };
  };
  const requireRuntimeCurrent = (request: {
    connectionGeneration: number;
    context: { date: DateContext };
  }) => {
    const current = runtime();
    if (
      current.connectionGeneration !== request.connectionGeneration ||
      !isRelativeDateContextCurrent(current.date, request.context.date)
    )
      rejectCommand('stale_context', 'conversation.context_changed');
  };
  const requireCurrentRequest = async (session: SqlSession, request: AssistantTurnRequest) => {
    const header = await readConversationHeader(session);
    const current = runtime();
    if (
      header.conversationId !== request.conversationId ||
      header.generation !== request.conversationGeneration ||
      current.connectionGeneration !== request.connectionGeneration ||
      !isRelativeDateContextCurrent(request.context.date, current.date) ||
      request.context.preferences.revision !== (await readRevision(session, 'preferences'))
    )
      rejectCommand('stale_context', 'conversation.context_changed');
    return { header, current };
  };
  const requireIntent = async (session: SqlSession, id: string, revision: number) => {
    if (!isAppId(id) || !isRevision(revision))
      rejectCommand('invalid_input', 'conversation.invalid_intent');
    const saved = await readAssistantIntentInSnapshot(session, options.catalogue, id);
    if (!saved || saved.intent.revision !== revision)
      rejectCommand('stale_context', 'conversation.intent_changed');
    return saved;
  };
  const repository: TurnRepository = {
    rearmTurn: async (input) => {
      const snapshot = clone(input);
      return write(
        'rearm',
        async (session) => {
          const saved = await requireIntent(
            session,
            snapshot.userIntentId,
            snapshot.expectedIntentRevision,
          );
          if (
            await readAcceptanceInSnapshot(
              session,
              snapshot.userIntentId,
              options.catalogue,
              options.platform,
            )
          )
            rejectCommand('operation_conflict', 'conversation.already_accepted');
          const { header } = await requireCurrentRequest(session, saved.request);
          if (header.revision !== saved.contextRevision)
            rejectCommand('stale_context', 'conversation.context_changed');
          const memory = await readMemoryState(session, header);
          if (
            memory.projectionRevision !== saved.request.context.memory.projectionRevision ||
            !equivalentJson(memory.workingContext, saved.request.context.memory.workingContext)
          )
            rejectCommand('stale_context', 'conversation.memory_changed');
          if (saved.lifecycle === 'awaiting_response') return publicIntent(saved);
          const message = (
            await session.all<{ status: string }>('SELECT status FROM message WHERE message_id=?', [
              saved.request.message.messageId,
            ])
          )[0];
          const retryable =
            saved.lifecycle === 'failed' &&
            saved.response?.kind === 'error' &&
            saved.response.error.code !== 'cancelled' &&
            ['after_delay', 'after_reconnect', 'reconcile'].includes(saved.response.error.retry);
          const interrupted =
            saved.lifecycle === 'cancelled' &&
            saved.response === null &&
            message?.status === 'interrupted';
          if ((!retryable && !interrupted) || saved.intent.slots.length)
            rejectCommand('stale_context', 'conversation.retry_unavailable');
          if (
            (
              await session.all(
                "SELECT 1 FROM pending_intent WHERE phase='awaiting_response' AND user_intent_id<>?",
                [saved.intent.userIntentId],
              )
            ).length
          )
            rejectCommand('already_pending', 'conversation.already_waiting');
          const intent: PendingIntent = { ...saved.intent, phase: 'awaiting_response' };
          await runBound(
            session,
            'UPDATE pending_intent SET phase=?,intent_json=? WHERE user_intent_id=?',
            [intent.phase, JSON.stringify(intent), intent.userIntentId],
          );
          await runBound(
            session,
            "UPDATE assistant_intent_context SET lifecycle='awaiting_response',response_json=NULL,guards_json=NULL WHERE user_intent_id=?",
            [intent.userIntentId],
          );
          await runBound(session, "UPDATE message SET status='sending' WHERE message_id=?", [
            saved.request.message.messageId,
          ]);
          await advance(session, false);
          return publicIntent(
            (await readAssistantIntentInSnapshot(session, options.catalogue, intent.userIntentId))!,
          );
        },
        undefined,
        snapshot.userIntentId,
      );
    },
    readAcceptance: async (id) => {
      if (!isAppId(id))
        return fail(
          new CommandFault({
            code: 'invalid_input',
            messageKey: 'conversation.invalid_intent',
            retry: 'after_correction',
          }),
        );
      const result = await readSnapshot(
        options.reader,
        async (session) =>
          (await readAcceptanceInSnapshot(session, id, options.catalogue, options.platform))
            ?.acknowledgement ?? null,
      );
      if (result.kind === 'ready') await reconcileNotifications();
      return result;
    },
    readIntent: async (id) => {
      if (!isAppId(id))
        return fail(
          new CommandFault({
            code: 'invalid_input',
            messageKey: 'conversation.invalid_intent',
            retry: 'after_correction',
          }),
        );
      const result = await readSnapshot(options.reader, async (session) => {
        const saved = await readAssistantIntentInSnapshot(session, options.catalogue, id);
        return saved ? publicIntent(saved) : null;
      });
      if (result.kind === 'ready') await reconcileNotifications();
      return result;
    },
    saveDraft: async (input, text) => {
      const guard = clone(input);
      if (
        !isAppId(guard.conversationId) ||
        !isRevision(guard.generation) ||
        !isRevision(guard.expectedConversationRevision) ||
        typeof text !== 'string' ||
        [...text].length > 4000
      )
        return fail(
          new CommandFault({
            code: 'invalid_input',
            messageKey: 'conversation.invalid_draft',
            retry: 'after_correction',
          }),
        );
      return write('draft', async (session) => {
        const header = await readConversationHeader(session);
        if (
          guard.conversationId !== header.conversationId ||
          guard.generation !== header.generation ||
          guard.expectedConversationRevision !== header.revision
        )
          rejectCommand('stale_context', 'conversation.draft_changed');
        if (header.composerDraft !== text) {
          await runBound(
            session,
            'UPDATE conversation SET composer_draft = ? WHERE singleton = 1',
            [encodeStoredText(text)],
          );
          // Typing while a response is in flight does not change semantic conversation context.
          await advance(session, false);
        }
        return { ...header, composerDraft: text };
      });
    },
    beginTurn: async (input) => {
      const { request, expectedConversationRevision } = clone(input);
      const check = checkAssistantRequest(request, options.catalogue);
      if (!check.ok) return { kind: 'failed', error: check.error };
      if (!isRevision(expectedConversationRevision) || utf8Length(JSON.stringify(request)) > 131072)
        return fail(
          new CommandFault({
            code: 'too_large',
            messageKey: 'conversation.request_limit',
            retry: 'after_correction',
          }),
        );
      let replay = false;
      return write(
        'begin',
        async (session) => {
          const existing = await readAssistantIntentInSnapshot(
            session,
            options.catalogue,
            request.userIntentId,
          );
          if (existing) {
            if (!equivalentJson(existing.request, request))
              rejectCommand('operation_conflict', 'conversation.intent_reused');
            replay = true;
            return publicIntent(existing);
          }
          const { header, current } = await requireCurrentRequest(session, request);
          if (header.revision !== expectedConversationRevision)
            rejectCommand('stale_context', 'conversation.context_changed');
          if (
            !equivalentJson(request.context.preferences, await readPreferencesInSnapshot(session))
          )
            rejectCommand('stale_context', 'conversation.preferences_changed');
          const actual = await readContextInSnapshot(
            session,
            options.catalogue,
            {
              text: request.message.text,
              messageId: request.message.messageId,
              selection: {
                ...(request.context.selectedRecipeId
                  ? { selectedRecipeId: request.context.selectedRecipeId }
                  : {}),
                ...(request.context.selectedPlacement
                  ? { selectedPlacement: request.context.selectedPlacement }
                  : {}),
                ...(request.context.referenceSets[0]
                  ? {
                      reference: {
                        ordinal: 1,
                        referenceSetId: request.context.referenceSets[0].referenceSetId,
                      },
                    }
                  : {}),
              },
            },
            current.date,
          );
          if (
            'kind' in actual ||
            !equivalentJson(actual.currentMessage, request.message) ||
            !equivalentJson(actual.memory, request.context.memory) ||
            !equivalentJson(actual.history, request.context.history) ||
            !equivalentJson(actual.planOccurrences, request.context.planOccurrences) ||
            !equivalentJson(actual.referenceSets, request.context.referenceSets)
          )
            rejectCommand('stale_context', 'conversation.context_changed');
          const active = await session.all(
            "SELECT 1 FROM pending_intent WHERE phase = 'awaiting_response' LIMIT 1",
          );
          if (active.length) rejectCommand('already_pending', 'conversation.already_waiting');
          const now = options.now();
          if (!isUtcInstant(now) || !Number.isSafeInteger(header.nextSequence + 1))
            throw new StorageFault('storage_failure', 'Invalid conversation clock or sequence');
          const intent: PendingIntent = {
            userIntentId: request.userIntentId,
            revision: request.intentRevision,
            origin: {
              conversationId: request.conversationId,
              generation: request.conversationGeneration,
              messageId: request.message.messageId,
            },
            phase: 'awaiting_response',
            slots: [],
          };
          await runBound(session, 'INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            request.message.messageId,
            request.conversationId,
            request.conversationGeneration,
            header.nextSequence,
            'user',
            encodeStoredText(request.message.text),
            'sending',
            now,
          ]);
          await runBound(
            session,
            'UPDATE conversation SET next_sequence = ?, composer_draft = ? WHERE singleton = 1',
            [header.nextSequence + 1, encodeStoredText('')],
          );
          await runBound(session, 'INSERT INTO message_context VALUES (?, ?, ?)', [
            request.message.messageId,
            JSON.stringify(request.message.sourceDateContext),
            request.message.preferenceRevisionAtSource,
          ]);
          await runBound(session, "INSERT INTO memory_source_review VALUES (?, 'pending', 0)", [
            request.message.messageId,
          ]);
          await runBound(session, 'INSERT INTO pending_intent VALUES (?, ?, ?, ?)', [
            intent.userIntentId,
            intent.revision,
            intent.phase,
            JSON.stringify(intent),
          ]);
          await runBound(session, 'INSERT INTO assistant_acceptance_envelope VALUES (?, ?, ?)', [
            intent.userIntentId,
            options.platform.newId(),
            intent.revision,
          ]);
          const contextRevision = await advance(session);
          await runBound(
            session,
            'INSERT INTO assistant_intent_context VALUES (?, 1, ?, ?, ?, NULL, NULL, ?)',
            [
              intent.userIntentId,
              'awaiting_response',
              contextRevision,
              JSON.stringify(request),
              '[]',
            ],
          );
          return publicIntent(
            (await readAssistantIntentInSnapshot(session, options.catalogue, intent.userIntentId))!,
          );
        },
        () => replay,
        request.userIntentId,
      );
    },
    acceptResponse: async (input) => {
      const { response, assistantMessageId, expectedIntentRevision } = clone(input);
      const check = checkAssistantResponse(response, options.catalogue);
      if (!check.ok) return { kind: 'failed', error: check.error };
      if (response.kind === 'error')
        return fail(
          new CommandFault({
            code: 'invalid_model_result',
            messageKey: 'conversation.error_requires_failure',
            retry: 'after_correction',
          }),
        );
      if (!isAppId(assistantMessageId) || utf8Length(JSON.stringify(response)) > 131072)
        return fail(
          new CommandFault({
            code: 'invalid_input',
            messageKey: 'conversation.invalid_response',
            retry: 'after_correction',
          }),
        );
      let replay = false;
      return write(
        'accept',
        async (session) => {
          const saved = await readAssistantIntentInSnapshot(
            session,
            options.catalogue,
            response.userIntentId,
          );
          if (!saved) rejectCommand('stale_context', 'conversation.intent_changed');
          const normalized = {
            ...response,
            referenceSets: response.referenceSets.map((set) => ({
              ...set,
              messageId: assistantMessageId,
            })),
          };
          const fingerprint = await options.platform.sha256(
            acceptanceFingerprintInput({
              normalizationVersion: 1,
              frozenRequest: saved.request,
              normalizedResponse: normalized,
              envelope: { assistantMessageId, expectedIntentRevision },
            }),
          );
          const accepted = await readAcceptanceInSnapshot(
            session,
            response.userIntentId,
            options.catalogue,
            options.platform,
          );
          if (accepted) {
            if (accepted.fingerprint !== fingerprint)
              rejectCommand('operation_conflict', 'conversation.acceptance_changed');
            replay = true;
            return { acknowledgement: accepted.acknowledgement, replay: true };
          }
          if (
            !equivalentJson(saved.acceptanceEnvelope, {
              assistantMessageId,
              expectedIntentRevision,
            })
          )
            rejectCommand('operation_conflict', 'conversation.envelope_changed');
          const { header, current } = await requireCurrentRequest(session, saved.request);
          if (
            !isResponseCurrent(response, {
              ...saved.request,
              preferenceRevision: saved.request.context.preferences.revision,
            })
          )
            rejectCommand('stale_context', 'conversation.response_changed');
          if (
            saved.lifecycle !== 'awaiting_response' ||
            saved.intent.phase !== 'awaiting_response' ||
            saved.contextRevision !== header.revision
          )
            rejectCommand('stale_context', 'conversation.intent_changed');
          await applyAcceptedMemory(
            session,
            header,
            saved.request,
            normalized,
            options.catalogue,
            options.platform,
          );
          {
            const now = options.now();
            if (!isUtcInstant(now) || !Number.isSafeInteger(header.nextSequence + 1))
              throw new StorageFault('storage_failure', 'Invalid conversation clock or sequence');
            if (
              new Set(normalized.referenceSets.map((set) => set.referenceSetId)).size !==
              normalized.referenceSets.length
            )
              rejectCommand('invalid_model_result', 'conversation.duplicate_reference');
            await runBound(session, 'INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
              assistantMessageId,
              header.conversationId,
              header.generation,
              header.nextSequence,
              'assistant',
              encodeStoredText(normalized.text),
              'complete',
              now,
            ]);
            for (const [ordinal, set] of normalized.referenceSets.entries()) {
              await runBound(session, 'INSERT INTO reference_set VALUES (?, ?, ?)', [
                set.referenceSetId,
                assistantMessageId,
                ordinal,
              ]);
              for (const [position, recipeId] of set.recipeIds.entries())
                await runBound(session, 'INSERT INTO reference_item VALUES (?, ?, ?)', [
                  set.referenceSetId,
                  position,
                  recipeId,
                ]);
            }
            await runBound(
              session,
              'UPDATE conversation SET next_sequence = ? WHERE singleton = 1',
              [header.nextSequence + 1],
            );
          }
          await runBound(session, 'UPDATE message SET status = ? WHERE message_id = ?', [
            'complete',
            saved.request.message.messageId,
          ]);
          const contextRevision = await advance(session);
          const intent: PendingIntent = {
            ...saved.intent,
            phase:
              normalized.kind === 'proposal'
                ? 'confirmation'
                : normalized.kind === 'clarification'
                  ? 'clarification'
                  : 'settled',
          };
          const guards: IntentGuardSnapshot = {
            conversationId: header.conversationId,
            conversationGeneration: header.generation,
            contextRevision,
            connectionGeneration: current.connectionGeneration,
            preferenceRevision: saved.request.context.preferences.revision,
            relativeDateContext: current.date,
            ...(normalized.kind === 'proposal' &&
            normalized.proposals.some((proposal) => proposal.kind === 'addPlan')
              ? { planRevision: await readRevision(session, 'plan') }
              : {}),
            ...(normalized.kind === 'proposal' &&
            normalized.proposals.some(
              (proposal) =>
                proposal.kind === 'addPlan' && proposal.expectedTarget.kind === 'occupied',
            )
              ? { shoppingScopeRevision: (await readShoppingScopeInSnapshot(session)).revision }
              : {}),
          };
          await runBound(
            session,
            'UPDATE pending_intent SET phase = ?, intent_json = ? WHERE user_intent_id = ?',
            [intent.phase, JSON.stringify(intent), intent.userIntentId],
          );
          await runBound(
            session,
            'UPDATE assistant_intent_context SET lifecycle = ?, context_revision = ?, response_json = ?, guards_json = ? WHERE user_intent_id = ?',
            [
              'accepted',
              contextRevision,
              JSON.stringify(normalized),
              guards ? JSON.stringify(guards) : null,
              intent.userIntentId,
            ],
          );
          const acknowledgement = publicIntent(
            (await readAssistantIntentInSnapshot(session, options.catalogue, intent.userIntentId))!,
          );
          await runBound(session, 'INSERT INTO assistant_acceptance VALUES (?, ?, ?, ?)', [
            intent.userIntentId,
            'memory-acceptance-v1',
            fingerprint,
            JSON.stringify(acknowledgement),
          ]);
          return { acknowledgement, replay: false };
        },
        () => replay,
        response.userIntentId,
      );
    },
    recordTurnFailure: async (input) => {
      const snapshot = clone(input);
      return write(
        'failure',
        async (session) => {
          const saved = await requireIntent(
            session,
            snapshot.userIntentId,
            snapshot.expectedIntentRevision,
          );
          if (saved.lifecycle !== 'awaiting_response') return publicIntent(saved);
          const request = saved.request;
          const response: AssistantTurnResponse = {
            apiVersion: API_VERSION,
            catalogue: request.catalogue,
            requestId: request.requestId,
            userIntentId: request.userIntentId,
            intentRevision: request.intentRevision,
            conversationId: request.conversationId,
            conversationGeneration: request.conversationGeneration,
            connectionGeneration: request.connectionGeneration,
            preferenceRevision: request.context.preferences.revision,
            kind: 'error',
            error: snapshot.error,
          };
          if (!checkAssistantResponse(response, options.catalogue).ok)
            rejectCommand('invalid_input', 'conversation.invalid_error');
          const intent: PendingIntent = { ...saved.intent, phase: 'cancelled' };
          await runBound(
            session,
            'UPDATE pending_intent SET phase = ?, intent_json = ? WHERE user_intent_id = ?',
            [intent.phase, JSON.stringify(intent), intent.userIntentId],
          );
          await runBound(session, 'UPDATE message SET status = ? WHERE message_id = ?', [
            snapshot.error.code === 'cancelled' ? 'cancelled' : 'failed',
            request.message.messageId,
          ]);
          const contextRevision = await advance(session);
          await runBound(
            session,
            "UPDATE assistant_intent_context SET lifecycle = 'failed', response_json = ?, context_revision=? WHERE user_intent_id = ?",
            [JSON.stringify(response), contextRevision, intent.userIntentId],
          );
          return publicIntent(
            (await readAssistantIntentInSnapshot(session, options.catalogue, intent.userIntentId))!,
          );
        },
        undefined,
        snapshot.userIntentId,
      );
    },
  };
  return Object.freeze(repository);
}
