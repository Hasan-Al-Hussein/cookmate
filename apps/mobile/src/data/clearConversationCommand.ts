import type { CommandHandlers } from './commandExecutor';
import { requireReviewedConversationClear } from './conversationClearScope';
import type { ConversationClearOptions } from './conversationClearScope';
import { runBound, StorageFault } from './sql';
import { encodeStoredText } from './storedText';

/** Receipts have no conversation FK and are deliberately outside this clear scope. */
export const createClearConversationCommandHandler = (
  options: ConversationClearOptions,
): Pick<CommandHandlers, 'clearConversation'> => ({
  clearConversation: async (session, command) => {
    const { header, scope, attachedIntentIds } = await requireReviewedConversationClear(
      session,
      command,
      options,
    );
    if (!scope.hasAnythingToClear)
      return { outcome: 'no_op', collections: [], shoppingProjection: 'unchanged', effects: [] };
    const generation = header.generation + 1;
    if (!Number.isSafeInteger(generation))
      throw new StorageFault('storage_failure', 'Conversation generation exhausted');
    // There is one local conversation. Remove its durable transport payloads as well as display rows.
    // Direct screen intents with no conversation origin remain independent of chat clearing.
    for (const userIntentId of attachedIntentIds) {
      await runBound(session, 'DELETE FROM pending_intent WHERE user_intent_id = ?', [
        userIntentId,
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
});
