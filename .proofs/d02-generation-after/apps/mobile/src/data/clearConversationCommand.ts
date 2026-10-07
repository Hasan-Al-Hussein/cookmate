import { rejectCommand } from './commandExecutor';
import type { CommandHandlers } from './commandExecutor';
import { parseStoredIntent, readConversationHeader } from './conversationRecords';
import { runBound, StorageFault } from './sql';
import { encodeStoredText } from './storedText';

/** Receipts have no conversation FK and are deliberately outside this clear scope. */
export const clearConversationCommandHandler: Pick<CommandHandlers, 'clearConversation'> = {
  clearConversation: async (session, command) => {
    const header = await readConversationHeader(session);
    if (
      header.conversationId !== command.conversationId ||
      header.generation !== command.expectedGeneration
    )
      rejectCommand('stale_context', 'conversation.clear_changed');
    const generation = header.generation + 1;
    if (!Number.isSafeInteger(generation))
      throw new StorageFault('storage_failure', 'Conversation generation exhausted');
    // There is one local conversation. Remove its durable transport payloads as well as display rows.
    // Direct screen intents with no conversation origin remain independent of chat clearing.
    const attached = await session.all<{
      userIntentId: string;
      revision: number;
      phase: string;
      intentJson: string;
    }>(
      `SELECT user_intent_id AS userIntentId, revision, phase, intent_json AS intentJson FROM pending_intent
       WHERE json_extract(intent_json, '$.origin.conversationId') = ? OR user_intent_id IN (SELECT user_intent_id FROM assistant_intent_context)`,
      [header.conversationId],
    );
    for (const row of attached) {
      parseStoredIntent(row.intentJson, row);
      await runBound(session, 'DELETE FROM pending_intent WHERE user_intent_id = ?', [
        row.userIntentId,
      ]);
    }
    await runBound(session, 'DELETE FROM message WHERE conversation_id = ?', [
      header.conversationId,
    ]);
    await runBound(
      session,
      'UPDATE conversation_memory_state SET generation=?, projection_revision=0, working_after_sequence=NULL, carry_memory_ids_json=? WHERE conversation_id=?',
      [generation, '[]', header.conversationId],
    );
    await runBound(
      session,
      'UPDATE conversation SET generation = ?, composer_draft = ?, next_sequence = 0 WHERE singleton = 1',
      [generation, encodeStoredText('')],
    );
    return {
      outcome: 'committed',
      collections: ['conversation'],
      shoppingProjection: 'unchanged',
      effects: [{ kind: 'conversation', entityId: header.conversationId, revision: generation }],
    };
  },
};
