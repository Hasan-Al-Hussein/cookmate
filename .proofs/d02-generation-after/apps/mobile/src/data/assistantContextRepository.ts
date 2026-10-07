import {
  assistantJsonByteLength,
  phaseAfterCancel,
  validateWorkingContextSelection,
} from '@cookmate/contracts';
import type {
  AssistantContext,
  CatalogueBoundary,
  DateContext,
  HistoricalTurn,
  WorkingContextSelection,
} from '@cookmate/contracts';
import { getPlanWeek, isSupportedPlanDate, PLAN_MAX_DATE, shiftPlanDate } from '@cookmate/domain';
import type {
  AssistantContextSelection,
  AssistantPersistencePort,
  ConversationHeader,
  ContextNarrowing,
  ConversationContextSnapshot,
  StoreChange,
} from '@cookmate/domain';
import {
  equivalentJson,
  isDateContext,
  readAssistantIntentInSnapshot,
} from './assistantIntentRecords';
import { CommandFault, rejectCommand } from './commandExecutor';
import {
  isAppId,
  isRevision,
  readConversationHeader,
  readMessagesInSnapshot,
  readReferenceSetsInSnapshot,
} from './conversationRecords';
import {
  completeMemoryGroups,
  hydrateMemoryItems,
  readMemoryGraph,
  readMemoryState,
  readUserSources,
} from './memoryRecords';
import { freezeResult, readRevision, readSnapshot } from './query';
import { readPlanInSnapshot, readPreferencesInSnapshot } from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SerializedReader, SerializedWriter, SqlSession } from './sql';

interface ContextOptions {
  reader: SerializedReader;
  writer: Pick<SerializedWriter, 'transaction'>;
  catalogue: CatalogueBoundary;
  dateContext(): DateContext;
  onCommitted(change: StoreChange): void;
}
type ContextInput = { text: string; messageId: string; selection: AssistantContextSelection };
const failure = (error: unknown) => ({
  kind: 'failed' as const,
  error:
    error instanceof CommandFault
      ? error.detail
      : {
          code: 'storage_failure' as const,
          messageKey: 'conversation.context_failed',
          retry: 'after_correction' as const,
        },
});

/** Conservative selection: unknown relevance never silently discards a retained constraint. */
export async function readContextInSnapshot(
  session: SqlSession,
  catalogue: CatalogueBoundary,
  input: ContextInput,
  date: DateContext,
): Promise<ConversationContextSnapshot | ContextNarrowing> {
  if (
    !isAppId(input.messageId) ||
    typeof input.text !== 'string' ||
    [...input.text].length < 1 ||
    [...input.text].length > 4000 ||
    !isDateContext(date) ||
    !isSupportedPlanDate(date.localDate)
  )
    rejectCommand('invalid_input', 'conversation.invalid_context');
  const selection = input.selection;
  if (
    (selection.selectedRecipeId !== undefined &&
      !catalogue.recipeIds.has(selection.selectedRecipeId)) ||
    (selection.selectedPlacement !== undefined &&
      (!isSupportedPlanDate(selection.selectedPlacement.actualDate) ||
        !['breakfast', 'lunch', 'dinner'].includes(selection.selectedPlacement.mealKey))) ||
    (selection.reference !== undefined &&
      (!Number.isInteger(selection.reference.ordinal) ||
        selection.reference.ordinal < 1 ||
        selection.reference.ordinal > 100 ||
        (selection.reference.referenceSetId !== undefined &&
          !isAppId(selection.reference.referenceSetId))))
  )
    rejectCommand('invalid_input', 'conversation.invalid_selection');
  const header = await readConversationHeader(session);
  if ((await session.all('SELECT 1 FROM message WHERE message_id=?', [input.messageId])).length)
    rejectCommand('operation_conflict', 'conversation.message_reused');
  const state = await readMemoryState(session, header);
  const graph = await readMemoryGraph(session, header, catalogue);
  const boundary = state.workingContext.afterSequence;
  const carried = completeMemoryGroups(graph, state.workingContext.carryMemoryIds);
  if (!equivalentJson(carried, [...state.workingContext.carryMemoryIds].sort()))
    throw new StorageFault('storage_failure', 'Stored memory selection is incomplete');
  const selectedIds = completeMemoryGroups(graph, [
    ...carried,
    ...[...graph.values()]
      .filter((node) => boundary === null || node.sourceSequence > boundary)
      .map((node) => node.memoryId),
  ]);
  // A relation created after a boundary may explicitly reintroduce old evidence. All such
  // ancestors must be visible carry IDs; never silently expand the user's persisted scope.
  const carriedSet = new Set(carried);
  if (
    selectedIds.some(
      (id) => boundary !== null && graph.get(id)!.sourceSequence <= boundary && !carriedSet.has(id),
    )
  )
    throw new StorageFault('storage_failure', 'Memory relation crosses working scope');
  const pending = await session.all<{ messageId: string; sequence: number }>(
    `SELECT m.message_id AS messageId,m.sequence FROM message m LEFT JOIN memory_source_review r ON r.message_id=m.message_id
     WHERE m.conversation_id=? AND m.generation=? AND m.role='user' AND (r.disposition IS NULL OR r.disposition IN ('pending','unresolved')) ORDER BY m.sequence`,
    [header.conversationId, header.generation],
  );
  if (pending.some((row) => !isAppId(row.messageId) || !isRevision(row.sequence)))
    throw new StorageFault('storage_failure', 'Invalid pending source');
  const workingPending = pending.filter((row) => boundary === null || row.sequence > boundary);
  const coverage: AssistantContext['memory']['coverage'] = {
    retainedEntryCount: graph.size,
    suppliedEntryCount: selectedIds.length <= 32 ? selectedIds.length : 0,
    omittedEntryCount: graph.size - (selectedIds.length <= 32 ? selectedIds.length : 0),
    pendingUserSourceCount: pending.length + 1,
    pendingWorkingSourceCount: workingPending.length + 1,
    suppliedReviewTargetCount: Math.min(workingPending.length, 7) + 1,
    selectionStatus: 'within_budget',
  };
  const narrow = (reason: ContextNarrowing['reason']): ContextNarrowing => ({
    kind: 'narrowing',
    revision: header.revision,
    reason,
    coverage: { ...coverage, selectionStatus: 'narrowing_required' },
    workingContext: state.workingContext,
  });
  if (selectedIds.length > 32) return narrow('entry_limit');
  if (workingPending.length > 7) return narrow('pending_evidence');
  const preferences = await readPreferencesInSnapshot(session);
  const pendingSources = await readUserSources(
    session,
    header,
    workingPending.map((row) => row.messageId),
    catalogue,
  );
  const items = await hydrateMemoryItems(session, header, graph, selectedIds, catalogue);
  const messages = (
    await readMessagesInSnapshot(session, catalogue, header, header.nextSequence, 20)
  ).filter((message) => boundary === null || message.sequence > boundary);
  const sources = new Map(
    (
      await readUserSources(
        session,
        header,
        messages.filter((message) => message.role === 'user').map((message) => message.messageId),
        catalogue,
      )
    ).map((source) => [source.sourceMessageId, source]),
  );
  const history: HistoricalTurn[] = messages.map((message) => {
    if (message.role === 'assistant')
      return {
        messageId: message.messageId,
        role: 'assistant',
        text: message.text,
        sourceSequence: message.sequence,
      };
    const source = sources.get(message.messageId)!;
    return {
      messageId: message.messageId,
      role: 'user',
      text: source.quote,
      sourceSequence: source.sourceSequence,
      sourceDateContext: source.sourceDateContext,
      preferenceRevisionAtSource: source.preferenceRevisionAtSource,
      preferenceLinks: source.preferenceLinks,
    };
  });
  const refRows = await session.all<{ id: string }>(
    `SELECT s.reference_set_id AS id FROM reference_set s JOIN message m ON m.message_id=s.message_id
     WHERE m.conversation_id=? AND m.generation=? AND m.sequence>? ORDER BY m.sequence DESC,s.ordinal DESC LIMIT 10`,
    [header.conversationId, header.generation, boundary ?? -1],
  );
  const explicitRef = selection.reference?.referenceSetId;
  const refIds = [...(explicitRef ? [explicitRef] : []), ...refRows.map((row) => row.id)]
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, 10);
  const referenceSets = await readReferenceSetsInSnapshot(session, catalogue, header, refIds);
  if (explicitRef && !referenceSets.some((set) => set.referenceSetId === explicitRef))
    rejectCommand('stale_context', 'conversation.reference_changed');
  const week = getPlanWeek(selection.selectedPlacement?.actualDate ?? date.localDate);
  const end = shiftPlanDate(week.startDate, 13) ?? PLAN_MAX_DATE;
  const planOccurrences = (
    await readPlanInSnapshot(session, catalogue, week.startDate, end)
  ).occurrences.map((item) => ({ ...item, placement: { ...item.placement } }));
  if (planOccurrences.length > 42) return narrow('entry_limit');
  const snapshot: ConversationContextSnapshot = {
    conversationId: header.conversationId,
    conversationGeneration: header.generation,
    contextRevision: header.revision,
    currentMessage: {
      messageId: input.messageId,
      text: input.text,
      sourceSequence: header.nextSequence,
      sourceDateContext: date,
      preferenceRevisionAtSource: preferences.revision,
      preferenceLinks: [],
    },
    date,
    history,
    memory: {
      projectionRevision: state.projectionRevision,
      baseContextRevision: header.revision,
      workingContext: state.workingContext,
      items,
      pendingSources,
      reviewTargetMessageIds: [
        input.messageId,
        ...pendingSources.map((source) => source.sourceMessageId),
      ],
      coverage,
    },
    referenceSets,
    preferences,
    planOccurrences,
  };
  // Leave room for request identity/capabilities/selection. The assembled wire request is
  // checked again by the contract; no quote or provenance field is ever truncated.
  if (assistantJsonByteLength(snapshot) > 126000) return narrow('byte_limit');
  return snapshot;
}

export function createAssistantContextRepository(
  options: ContextOptions,
): Pick<AssistantPersistencePort, 'readContext' | 'readMemoryPage' | 'setWorkingContext'> {
  const pendingNotifications = new Map<
    number,
    { header: ConversationHeader; selection: WorkingContextSelection }
  >();
  const notify = (revision: number) => {
    try {
      options.onCommitted({ revision, collections: ['conversation'] });
    } catch {
      /* Committed state survives observer errors. */
    }
  };
  const reconcileNotifications = async () => {
    if (!pendingNotifications.size) return;
    const observed = await readSnapshot(options.reader, async (session) => {
      const header = await readConversationHeader(session);
      const state = await readMemoryState(session, header);
      return [...pendingNotifications].map(([revision, proof]) => ({
        revision,
        proof,
        confirmed:
          header.conversationId === proof.header.conversationId &&
          header.generation === proof.header.generation &&
          header.revision === proof.header.revision &&
          equivalentJson(state.workingContext, proof.selection),
      }));
    });
    if (observed.kind !== 'ready') return;
    for (const item of observed.value) {
      if (pendingNotifications.get(item.revision) !== item.proof) continue;
      pendingNotifications.delete(item.revision);
      if (item.confirmed) notify(item.revision);
    }
  };
  return Object.freeze({
    readContext: async (input) => {
      const snapshot = JSON.parse(JSON.stringify(input)) as ContextInput;
      const date = JSON.parse(JSON.stringify(options.dateContext())) as DateContext;
      try {
        const result = await options.reader.transaction(async (session) => {
          const value = await readContextInSnapshot(session, options.catalogue, snapshot, date);
          return 'kind' in value
            ? freezeResult(value)
            : {
                kind: 'ready' as const,
                revision: await readRevision(session, 'store'),
                value: freezeResult(value),
              };
        });
        await reconcileNotifications();
        return result;
      } catch (error) {
        return failure(error);
      }
    },
    readMemoryPage: async (input = {}) => {
      const limit = input.limit ?? 30;
      const beforeSequence = input.beforeSequence;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (beforeSequence !== undefined && !isRevision(beforeSequence))
      )
        return failure(
          new CommandFault({
            code: 'invalid_input',
            messageKey: 'conversation.invalid_page',
            retry: 'after_correction',
          }),
        );
      const result = await readSnapshot(options.reader, async (session) => {
        const header = await readConversationHeader(session);
        const state = await readMemoryState(session, header);
        const graph = await readMemoryGraph(session, header, options.catalogue);
        const nodes = [...graph.values()]
          .filter((node) => node.sourceSequence < (beforeSequence ?? header.nextSequence))
          .sort((a, b) => b.sourceSequence - a.sourceSequence);
        const page = nodes.slice(0, limit).reverse();
        return {
          header,
          items: await hydrateMemoryItems(
            session,
            header,
            graph,
            page.map((node) => node.memoryId),
            options.catalogue,
          ),
          workingContext: state.workingContext,
          hasEarlier: nodes.length > limit,
          beforeSequence: nodes.length > limit ? page[0]!.sourceSequence : null,
        };
      });
      if (result.kind === 'ready') await reconcileNotifications();
      return result;
    },
    setWorkingContext: async (input) => {
      const expectedContextRevision = input.expectedContextRevision;
      const selection = JSON.parse(
        JSON.stringify({
          afterSequence: input.afterSequence,
          carryMemoryIds: input.carryMemoryIds,
        }),
      );
      if (!isRevision(expectedContextRevision) || !validateWorkingContextSelection(selection))
        return failure(
          new CommandFault({
            code: 'invalid_input',
            messageKey: 'conversation.invalid_scope',
            retry: 'after_correction',
          }),
        );
      let attempted: { value: ConversationHeader; revision: number; changed: boolean } | undefined;
      try {
        const result = await options.writer.transaction(async (session) => {
          const header = await readConversationHeader(session);
          if (header.revision !== expectedContextRevision)
            rejectCommand('stale_context', 'conversation.context_changed');
          if (
            selection.afterSequence !== null &&
            !(
              await session.all(
                'SELECT 1 FROM message WHERE conversation_id=? AND generation=? AND sequence=?',
                [header.conversationId, header.generation, selection.afterSequence],
              )
            ).length
          )
            rejectCommand('invalid_input', 'conversation.invalid_boundary');
          const graph = await readMemoryGraph(session, header, options.catalogue);
          if (selection.carryMemoryIds.some((id) => !graph.has(id)))
            rejectCommand('invalid_input', 'conversation.unknown_memory');
          selection.carryMemoryIds = completeMemoryGroups(graph, selection.carryMemoryIds);
          if (selection.carryMemoryIds.length > 32)
            rejectCommand('too_large', 'conversation.scope_limit');
          const carried = await hydrateMemoryItems(
            session,
            header,
            graph,
            selection.carryMemoryIds,
            options.catalogue,
          );
          if (assistantJsonByteLength(carried) > 126000)
            rejectCommand('too_large', 'conversation.scope_limit');
          const state = await readMemoryState(session, header);
          if (equivalentJson(state.workingContext, selection))
            return {
              value: header,
              revision: await readRevision(session, 'store'),
              changed: false,
            };
          // Scope change ends uncommitted chat authority, preserving receipts and dispatched reconciliation.
          const ids = await session.all<{ id: string }>(
            'SELECT user_intent_id AS id FROM assistant_intent_context',
          );
          for (const { id } of ids) {
            const record = await readAssistantIntentInSnapshot(session, options.catalogue, id);
            if (!record || ['settled', 'cancelled'].includes(record.intent.phase)) continue;
            const phase = phaseAfterCancel(record.intent.phase);
            await runBound(
              session,
              'UPDATE pending_intent SET phase=?,intent_json=? WHERE user_intent_id=?',
              [phase, JSON.stringify({ ...record.intent, phase }), id],
            );
            await runBound(
              session,
              "UPDATE assistant_intent_context SET lifecycle='cancelled' WHERE user_intent_id=?",
              [id],
            );
          }
          await runBound(
            session,
            "UPDATE message SET status='cancelled' WHERE status='sending' AND conversation_id=?",
            [header.conversationId],
          );
          await runBound(
            session,
            'UPDATE conversation_memory_state SET working_after_sequence=?,carry_memory_ids_json=? WHERE conversation_id=?',
            [
              selection.afterSequence,
              JSON.stringify(selection.carryMemoryIds),
              header.conversationId,
            ],
          );
          for (const collection of ['store', 'conversation']) {
            const revision = await readRevision(session, collection);
            if (!Number.isSafeInteger(revision + 1))
              throw new StorageFault('storage_failure', 'Revision exhausted');
            await runBound(session, 'UPDATE state_revision SET revision=? WHERE collection=?', [
              revision + 1,
              collection,
            ]);
          }
          attempted = {
            value: await readConversationHeader(session),
            revision: await readRevision(session, 'store'),
            changed: true,
          };
          return attempted;
        });
        if (result.changed) {
          pendingNotifications.delete(result.revision);
          notify(result.revision);
        }
        await reconcileNotifications();
        return {
          kind: 'ready' as const,
          value: freezeResult(result.value),
          revision: result.revision,
        };
      } catch (error) {
        // A lost COMMIT acknowledgement may follow a committed scope change. Read only after
        // the writer settles, and notify only if its exact guarded transition is still present.
        if (attempted) {
          pendingNotifications.set(attempted.revision, { header: attempted.value, selection });
        }
        await reconcileNotifications();
        return failure(error);
      }
    },
  });
}
