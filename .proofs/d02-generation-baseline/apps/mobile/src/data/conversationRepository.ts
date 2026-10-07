import type { CatalogueBoundary } from '@cookmate/contracts';
import type {
  AssistantPersistencePort,
  AssistantIntentSummary,
  ConversationHeader,
  Immutable,
} from '@cookmate/domain';
import { readSnapshot } from './query';
import {
  isAppId,
  isRevision,
  readConversationHeader,
  readMessagesInSnapshot,
  readReferenceSetsInSnapshot,
  requireConversationRecord,
} from './conversationRecords';
import type { SerializedReader, SqlSession } from './sql';
import { readAssistantIntentInSnapshot } from './assistantIntentRecords';
import type { AssistantIntentRecord } from './assistantIntentRecords';
import { decodeStoredText } from './storedText';

type ConversationQueries = Pick<
  AssistantPersistencePort,
  'readConversation' | 'readReferenceSets' | 'readIntentPage'
>;
const invalidInput = () => ({
  kind: 'failed' as const,
  error: {
    code: 'invalid_input' as const,
    messageKey: 'conversation.invalid_query',
    retry: 'after_correction' as const,
  },
});

interface InventorySourceRow {
  sequence: number | null;
  role: string;
  conversationId: string;
  generation: number;
  text: string;
}

/** Shared inventory evidence checks for paged display and the incremental recovery gate. */
export async function readAssistantInventoryRecordInSnapshot(
  session: SqlSession,
  catalogue: CatalogueBoundary,
  id: string,
  header: Immutable<ConversationHeader>,
  selectedSource?: InventorySourceRow,
): Promise<AssistantIntentRecord> {
  const saved = await readAssistantIntentInSnapshot(session, catalogue, id);
  requireConversationRecord(saved);
  const source =
    selectedSource ??
    (
      await session.all<InventorySourceRow>(
        'SELECT sequence,role,conversation_id AS conversationId,generation,text FROM message WHERE message_id=?',
        [saved.request.message.messageId],
      )
    )[0];
  requireConversationRecord(
    source &&
      isRevision(source.sequence) &&
      source.sequence < header.nextSequence &&
      source.role === 'user' &&
      source.conversationId === header.conversationId &&
      source.generation === header.generation &&
      saved.request.conversationId === header.conversationId &&
      saved.request.conversationGeneration === header.generation &&
      saved.request.message.sourceSequence === source.sequence &&
      decodeStoredText(source.text) === saved.request.message.text,
  );
  const reply = (
    await session.all<Omit<InventorySourceRow, 'sequence'>>(
      'SELECT role,conversation_id AS conversationId,generation,text FROM message WHERE message_id=?',
      [saved.acceptanceEnvelope.assistantMessageId],
    )
  )[0];
  requireConversationRecord(
    Boolean(reply) === Boolean(saved.response && saved.response.kind !== 'error') &&
      (!reply ||
        (reply.role === 'assistant' &&
          reply.conversationId === header.conversationId &&
          reply.generation === header.generation &&
          saved.response &&
          saved.response.kind !== 'error' &&
          decodeStoredText(reply.text) === saved.response.text)),
  );
  return saved;
}

export function createConversationRepository(
  reader: SerializedReader,
  catalogue: CatalogueBoundary,
): ConversationQueries {
  const repository: ConversationQueries = {
    readIntentPage: async (input = {}) => {
      const limit = input.limit ?? 30;
      const beforeSequence = input.beforeSequence;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (beforeSequence !== undefined && !isRevision(beforeSequence))
      )
        return invalidInput();
      return readSnapshot(reader, async (session) => {
        const header = await readConversationHeader(session);
        const rows = await session.all<{
          id: string;
          sequence: number | null;
          role: string;
          conversationId: string;
          generation: number;
          text: string;
        }>(
          `SELECT a.user_intent_id AS id,m.sequence,m.role,m.conversation_id AS conversationId,m.generation,m.text
          FROM assistant_intent_context a LEFT JOIN message m ON m.message_id=json_extract(a.request_json,'$.message.messageId')
          WHERE m.sequence < ? OR m.sequence IS NULL ORDER BY m.sequence DESC LIMIT ?`,
          [Math.min(beforeSequence ?? header.nextSequence, header.nextSequence), limit + 1],
        );
        const hasEarlier = rows.length > limit;
        const page = rows.slice(0, limit).reverse();
        const items: AssistantIntentSummary[] = [];
        for (const row of page) {
          const saved = await readAssistantInventoryRecordInSnapshot(
            session,
            catalogue,
            row.id,
            header,
            row,
          );
          items.push({
            userIntentId: saved.intent.userIntentId,
            revision: saved.intent.revision,
            phase: saved.intent.phase,
            userMessageId: saved.request.message.messageId,
            assistantMessageId:
              saved.response && saved.response.kind !== 'error'
                ? saved.acceptanceEnvelope.assistantMessageId
                : null,
            sourceSequence: saved.request.message.sourceSequence,
            hasActionPlan: saved.actionPlan !== null,
          });
        }
        return {
          header,
          items,
          hasEarlier,
          beforeSequence: hasEarlier ? items[0]!.sourceSequence : null,
        };
      });
    },
    readConversation: async (input = {}) => {
      const limit = input.limit ?? 30;
      const beforeSequence = input.beforeSequence;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (beforeSequence !== undefined && !isRevision(beforeSequence))
      )
        return invalidInput();
      return readSnapshot(reader, async (session) => {
        const header = await readConversationHeader(session);
        const rows = await readMessagesInSnapshot(
          session,
          catalogue,
          header,
          Math.min(beforeSequence ?? header.nextSequence, header.nextSequence),
          limit + 1,
        );
        const hasEarlier = rows.length > limit;
        const messages = hasEarlier ? rows.slice(1) : rows;
        return {
          header,
          messages,
          hasEarlier,
          beforeSequence: hasEarlier ? messages[0]!.sequence : null,
        };
      });
    },
    readReferenceSets: async (ids) => {
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        ids.some((id) => !isAppId(id)) ||
        new Set(ids).size !== ids.length
      )
        return invalidInput();
      const snapshot = [...ids];
      return readSnapshot(reader, async (session) =>
        readReferenceSetsInSnapshot(
          session,
          catalogue,
          await readConversationHeader(session),
          snapshot,
        ),
      );
    },
  };
  return Object.freeze(repository);
}
