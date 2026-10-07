import { catalogueMatches } from '@cookmate/contracts';
import type { CatalogueBoundary, CatalogueIdentity } from '@cookmate/contracts';
import {
  CONVERSATION_EXPORT_MAX_BYTES,
  CONVERSATION_EXPORT_MAX_MESSAGES,
  ConversationExportError,
  conversationExportTextByteLength,
  createConversationExportSnapshot,
} from '@cookmate/domain';
import type {
  ConversationHeader,
  CookMateQueries,
  StoredConversationMessage,
} from '@cookmate/domain';
import {
  readConversationHeader,
  readMessagesInSnapshot,
  requireConversationRecord,
} from './conversationRecords';
import { readSnapshot } from './query';
import type { SerializedReader, SqlSession } from './sql';

const PAGE_SIZE = 50;
// Same cardinalities as the persisted display reader; check before it allocates reference rows.
const MAX_REFERENCE_SETS_PER_MESSAGE = 10;
const MAX_RECIPES_PER_REFERENCE_SET = 100;

async function assertReferenceBounds(session: SqlSession, header: ConversationHeader) {
  const scope = [header.conversationId, header.generation];
  const sets = (
    await session.all<{ maxSets: number; idBytes: number }>(
      `SELECT COALESCE(MAX(setCount),0) AS maxSets,COALESCE(SUM(idBytes),0) AS idBytes FROM (
        SELECT COUNT(*) AS setCount,SUM(length(CAST(s.reference_set_id AS BLOB))) AS idBytes
        FROM reference_set s JOIN message m ON m.message_id=s.message_id
        WHERE m.conversation_id=? AND m.generation=? GROUP BY s.message_id
      )`,
      scope,
    )
  )[0];
  requireConversationRecord(
    sets && Number.isSafeInteger(sets.maxSets) && Number.isSafeInteger(sets.idBytes),
  );
  if (sets.maxSets > MAX_REFERENCE_SETS_PER_MESSAGE)
    throw new ConversationExportError('invalid_record');
  if (sets.idBytes > CONVERSATION_EXPORT_MAX_BYTES) throw new ConversationExportError('byte_limit');
  const items = (
    await session.all<{ maxItems: number; idBytes: number }>(
      `SELECT COALESCE(MAX(itemCount),0) AS maxItems,COALESCE(SUM(idBytes),0) AS idBytes FROM (
        SELECT COUNT(i.position) AS itemCount,COALESCE(SUM(length(CAST(i.recipe_id AS BLOB))),0) AS idBytes
        FROM reference_set s JOIN message m ON m.message_id=s.message_id
        LEFT JOIN reference_item i ON i.reference_set_id=s.reference_set_id
        WHERE m.conversation_id=? AND m.generation=? GROUP BY s.reference_set_id
      )`,
      scope,
    )
  )[0];
  requireConversationRecord(
    items && Number.isSafeInteger(items.maxItems) && Number.isSafeInteger(items.idBytes),
  );
  if (items.maxItems > MAX_RECIPES_PER_REFERENCE_SET)
    throw new ConversationExportError('invalid_record');
  // Both are necessary bytes in either export, so this cannot reject a smaller valid export.
  if (sets.idBytes + items.idBytes > CONVERSATION_EXPORT_MAX_BYTES)
    throw new ConversationExportError('byte_limit');
}

/** One current workspace read transaction, without assistant binding or action authority. */
export function createConversationExportReader(
  reader: SerializedReader,
  options: { catalogue: CatalogueBoundary; now(): string },
): NonNullable<CookMateQueries['readConversationExport']> {
  return async () => {
    const result = await readSnapshot(reader, async (session) => {
      try {
        const manifest = await session.all<CatalogueIdentity>(
          'SELECT catalogue_version AS version,fingerprint FROM catalogue_manifest WHERE singleton=1 LIMIT 2',
        );
        requireConversationRecord(
          manifest.length === 1 && catalogueMatches(manifest[0]!, options.catalogue.identity),
        );
        const header = await readConversationHeader(session);
        const count = (
          await session.all<{ count: number }>(
            'SELECT COUNT(*) AS count FROM message WHERE conversation_id=? AND generation=?',
            [header.conversationId, header.generation],
          )
        )[0]?.count;
        requireConversationRecord(Number.isSafeInteger(count) && count !== undefined && count >= 0);
        if (count > CONVERSATION_EXPORT_MAX_MESSAGES)
          throw new ConversationExportError('message_limit');
        await assertReferenceBounds(session, header);
        let beforeSequence = header.nextSequence;
        let rowBytes = 0;
        let messages: StoredConversationMessage[] = [];
        while (messages.length < count) {
          const page = await readMessagesInSnapshot(
            session,
            options.catalogue,
            header,
            beforeSequence,
            Math.min(PAGE_SIZE, count - messages.length),
          );
          requireConversationRecord(page.length > 0);
          // Bound accumulation before reading another page; final representations are checked too.
          for (const message of page) rowBytes += conversationExportTextByteLength(message.text);
          if (rowBytes > CONVERSATION_EXPORT_MAX_BYTES)
            throw new ConversationExportError('byte_limit');
          messages = [...page, ...messages];
          beforeSequence = page[0]!.sequence;
        }
        return {
          kind: 'export' as const,
          value: createConversationExportSnapshot({
            exportedAt: options.now(),
            catalogue: manifest[0]!,
            header,
            messages,
          }),
        };
      } catch (error) {
        if (error instanceof ConversationExportError)
          return { kind: 'rejected' as const, reason: error.reason };
        throw error;
      }
    });
    if (result.kind !== 'ready')
      return {
        kind: 'failed',
        error: {
          code: 'storage_failure',
          messageKey: 'conversation_export.read_failed',
          retry: 'after_correction',
        },
      };
    if (result.value.kind === 'rejected')
      return {
        kind: 'failed',
        error: {
          code: result.value.reason === 'invalid_record' ? 'storage_failure' : 'too_large',
          messageKey: `conversation_export.${result.value.reason}`,
          retry: 'after_correction',
        },
      };
    return { kind: 'ready', revision: result.revision, value: result.value.value };
  };
}
