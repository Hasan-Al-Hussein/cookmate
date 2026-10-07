import { isUtcInstant, validatePendingIntent } from '@cookmate/contracts';
import type { CatalogueBoundary, PendingIntent, ReferenceSet } from '@cookmate/contracts';
import type { ConversationHeader, StoredConversationMessage } from '@cookmate/domain';
import { readRevision } from './query';
import { StorageFault } from './sql';
import type { SqlSession } from './sql';
import { decodeStoredText } from './storedText';

export const isAppId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function requireConversationRecord(condition: unknown): asserts condition {
  if (!condition) throw new StorageFault('storage_failure', 'Stored conversation is invalid');
}

export function parseStoredIntent(
  json: string,
  row: { userIntentId: string; revision: number; phase: string },
): PendingIntent {
  requireConversationRecord(typeof json === 'string' && json.length <= 131072);
  const value: unknown = JSON.parse(json);
  requireConversationRecord(
    validatePendingIntent(value) &&
      value.userIntentId === row.userIntentId &&
      value.revision === row.revision &&
      value.phase === row.phase,
  );
  return value;
}

export async function readConversationHeader(session: SqlSession): Promise<ConversationHeader> {
  const row = (
    await session.all<Omit<ConversationHeader, 'revision'>>(
      'SELECT conversation_id AS conversationId, generation, composer_draft AS composerDraft, next_sequence AS nextSequence FROM conversation WHERE singleton = 1',
    )
  )[0];
  if (row) row.composerDraft = decodeStoredText(row.composerDraft);
  requireConversationRecord(
    row &&
      isAppId(row.conversationId) &&
      isRevision(row.generation) &&
      isRevision(row.nextSequence) &&
      typeof row.composerDraft === 'string' &&
      [...row.composerDraft].length <= 4000,
  );
  return { ...row, revision: await readRevision(session, 'conversation') };
}

/** Caller chooses current conversation/generation; stale reference IDs never cross a cleared chat. */
export async function readReferenceSetsInSnapshot(
  session: SqlSession,
  catalogue: CatalogueBoundary,
  header: ConversationHeader,
  ids: readonly string[],
): Promise<ReferenceSet[]> {
  const result: ReferenceSet[] = [];
  for (const id of ids) {
    const set = (
      await session.all<{ referenceSetId: string; messageId: string; ordinal: number }>(
        `SELECT s.reference_set_id AS referenceSetId, s.message_id AS messageId, s.ordinal FROM reference_set s
       JOIN message m ON m.message_id = s.message_id WHERE s.reference_set_id = ? AND m.conversation_id = ? AND m.generation = ?`,
        [id, header.conversationId, header.generation],
      )
    )[0];
    if (!set) continue;
    const items = await session.all<{ position: number; recipeId: string }>(
      'SELECT position, recipe_id AS recipeId FROM reference_item WHERE reference_set_id = ? ORDER BY position',
      [id],
    );
    requireConversationRecord(
      isAppId(set.referenceSetId) &&
        isAppId(set.messageId) &&
        isRevision(set.ordinal) &&
        items.length >= 1 &&
        items.length <= 100 &&
        new Set(items.map((item) => item.recipeId)).size === items.length &&
        items.every(
          (item, index) => item.position === index && catalogue.recipeIds.has(item.recipeId),
        ),
    );
    result.push({
      referenceSetId: set.referenceSetId,
      messageId: set.messageId,
      recipeIds: items.map((item) => item.recipeId) as ReferenceSet['recipeIds'],
    });
  }
  return result;
}

export async function readMessagesInSnapshot(
  session: SqlSession,
  catalogue: CatalogueBoundary,
  header: ConversationHeader,
  beforeSequence: number,
  limit: number,
): Promise<StoredConversationMessage[]> {
  const rows = await session.all<Omit<StoredConversationMessage, 'referenceSets'>>(
    `SELECT message_id AS messageId, conversation_id AS conversationId, generation, sequence, role, text, status, created_at AS createdAt
     FROM message WHERE conversation_id = ? AND generation = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`,
    [header.conversationId, header.generation, beforeSequence, limit],
  );
  const result: StoredConversationMessage[] = [];
  for (const row of rows.reverse()) {
    row.text = decodeStoredText(row.text);
    requireConversationRecord(
      isAppId(row.messageId) &&
        row.conversationId === header.conversationId &&
        row.generation === header.generation &&
        isRevision(row.sequence) &&
        row.sequence < header.nextSequence &&
        ['user', 'assistant'].includes(row.role) &&
        ['sending', 'complete', 'failed', 'cancelled', 'interrupted'].includes(row.status) &&
        typeof row.text === 'string' &&
        [...row.text].length >= 1 &&
        [...row.text].length <= (row.role === 'user' ? 4000 : 8000) &&
        isUtcInstant(row.createdAt),
    );
    const ids = await session.all<{ id: string; ordinal: number }>(
      'SELECT reference_set_id AS id, ordinal FROM reference_set WHERE message_id = ? ORDER BY ordinal',
      [row.messageId],
    );
    requireConversationRecord(
      ids.length <= 10 && ids.every((item, index) => item.ordinal === index),
    );
    result.push({
      ...row,
      referenceSets: await readReferenceSetsInSnapshot(
        session,
        catalogue,
        header,
        ids.map((item) => item.id),
      ),
    });
  }
  return result;
}
