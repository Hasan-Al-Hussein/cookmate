import {
  validateMemoryUpdate,
  validatePreferenceSnapshot,
  validateWorkingContextSelection,
} from '@cookmate/contracts';
import type {
  CatalogueBoundary,
  MemoryItem,
  MemoryScope,
  SourcePreferenceLink,
  UserMemorySource,
  WorkingContextSelection,
} from '@cookmate/contracts';
import type { ConversationHeader } from '@cookmate/domain';
import { equivalentJson, isDateContext, parseBoundedJson } from './assistantIntentRecords';
import { isAppId, isRevision } from './conversationRecords';
import { readPreferencesInSnapshot, readReceiptInSnapshot } from './stateRepositories';
import { StorageFault } from './sql';
import type { SqlSession } from './sql';
import { decodeStoredText } from './storedText';

function stored(condition: unknown): asserts condition {
  if (!condition)
    throw new StorageFault('storage_failure', 'Stored conversation memory is invalid');
}
export interface MemoryState {
  projectionRevision: number;
  workingContext: WorkingContextSelection;
}
export interface MemoryNode {
  memoryId: string;
  sourceMessageId: string;
  sourceSequence: number;
  revision: number;
  kind: MemoryItem['kind'];
  scope: MemoryScope;
  relations: MemoryItem['relations'];
}
export async function readMemoryState(
  session: SqlSession,
  header: ConversationHeader,
): Promise<MemoryState> {
  const row = (
    await session.all<{
      generation: number;
      projectionRevision: number;
      afterSequence: number | null;
      carryJson: string;
    }>(
      'SELECT generation, projection_revision AS projectionRevision, working_after_sequence AS afterSequence, carry_memory_ids_json AS carryJson FROM conversation_memory_state WHERE conversation_id=?',
      [header.conversationId],
    )
  )[0];
  stored(row && row.generation === header.generation && isRevision(row.projectionRevision));
  const workingContext = {
    afterSequence: row.afterSequence,
    carryMemoryIds: parseBoundedJson(row.carryJson, 4096),
  };
  stored(validateWorkingContextSelection(workingContext));
  if (workingContext.afterSequence !== null)
    stored(
      (
        await session.all(
          'SELECT 1 FROM message WHERE conversation_id=? AND generation=? AND sequence=?',
          [header.conversationId, header.generation, workingContext.afterSequence],
        )
      ).length === 1,
    );
  return { projectionRevision: row.projectionRevision, workingContext };
}

/** Metadata-only graph. Full original quotes are loaded only for bounded pages/outbound selections. */
export async function readMemoryGraph(
  session: SqlSession,
  header: ConversationHeader,
  catalogue: CatalogueBoundary,
): Promise<Map<string, MemoryNode>> {
  const rows = await session.all<{
    memoryId: string;
    sourceMessageId: string;
    sourceSequence: number;
    revision: number;
    kind: MemoryItem['kind'];
    scopeJson: string;
    role: string;
    generation: number;
  }>(
    `SELECT e.memory_id AS memoryId, e.source_message_id AS sourceMessageId, m.sequence AS sourceSequence,
       e.revision, e.kind, e.scope_json AS scopeJson, m.role, m.generation
     FROM memory_entry e JOIN message m ON m.message_id=e.source_message_id WHERE m.conversation_id=?`,
    [header.conversationId],
  );
  const graph = new Map<string, MemoryNode>();
  for (const row of rows) {
    stored(
      isAppId(row.memoryId) &&
        isAppId(row.sourceMessageId) &&
        isRevision(row.revision) &&
        isRevision(row.sourceSequence) &&
        row.generation === header.generation &&
        row.role === 'user',
    );
    const scope = parseBoundedJson(row.scopeJson, 4096);
    const draft = {
      baseRevision: 0,
      baseContextRevision: 0,
      reviews: [{ sourceMessageId: row.sourceMessageId, disposition: 'retain' }],
      entries: [
        {
          sourceMessageId: row.sourceMessageId,
          quote: 'shape validation',
          kind: row.kind,
          scope,
          relations: [],
        },
      ],
    };
    stored(validateMemoryUpdate(draft));
    const parsedScope = draft.entries[0]!.scope;
    stored(
      parsedScope.kind !== 'recipes' ||
        parsedScope.recipeIds.every((id) => catalogue.recipeIds.has(id)),
    );
    graph.set(row.memoryId, {
      memoryId: row.memoryId,
      sourceMessageId: row.sourceMessageId,
      sourceSequence: row.sourceSequence,
      revision: row.revision,
      kind: row.kind,
      scope: parsedScope,
      relations: [],
    });
  }
  const relations = await session.all<{
    sourceId: string;
    ordinal: number;
    targetId: string;
    kind: MemoryItem['relations'][number]['kind'];
    targetRevision: number;
  }>(
    `SELECT r.source_memory_id AS sourceId, r.ordinal, r.target_memory_id AS targetId, r.kind, r.target_revision AS targetRevision
     FROM memory_relation r JOIN memory_entry e ON e.memory_id=r.source_memory_id JOIN message m ON m.message_id=e.source_message_id
     WHERE m.conversation_id=? ORDER BY r.source_memory_id,r.ordinal`,
    [header.conversationId],
  );
  for (const row of relations) {
    const source = graph.get(row.sourceId);
    const target = graph.get(row.targetId);
    stored(
      source &&
        target &&
        row.ordinal === source.relations.length &&
        row.ordinal < 8 &&
        target.sourceSequence < source.sourceSequence &&
        target.revision === row.targetRevision &&
        ['supersedes', 'conflicts_with'].includes(row.kind),
    );
    source.relations.push({
      kind: row.kind,
      target: { kind: 'memory', memoryId: target.memoryId, expectedRevision: target.revision },
    });
  }
  return graph;
}

/** Undirected closure keeps corrections, their source and every conflicting branch together. */
export function completeMemoryGroups(
  graph: ReadonlyMap<string, MemoryNode>,
  ids: readonly string[],
): string[] {
  const neighbors = new Map<string, Set<string>>(
    [...graph.keys()].map((id) => [id, new Set<string>()]),
  );
  for (const node of graph.values())
    for (const relation of node.relations) {
      neighbors.get(node.memoryId)!.add(relation.target.memoryId);
      neighbors.get(relation.target.memoryId)!.add(node.memoryId);
    }
  const visited = new Set<string>();
  const queue = [...ids];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    stored(graph.has(id));
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...neighbors.get(id)!);
  }
  return [...visited].sort();
}

export async function readUserSources(
  session: SqlSession,
  header: ConversationHeader,
  ids: readonly string[],
  catalogue: CatalogueBoundary,
): Promise<UserMemorySource[]> {
  stored(ids.length <= 100 && new Set(ids).size === ids.length && ids.every(isAppId));
  const preferences = await readPreferencesInSnapshot(session);
  const result: UserMemorySource[] = [];
  for (const id of ids) {
    const row = (
      await session.all<{
        messageId: string;
        sequence: number;
        text: string;
        role: string;
        dateJson: string | null;
        preferenceRevision: number | null;
      }>(
        `SELECT m.message_id AS messageId, m.sequence, m.text, m.role, c.source_date_context_json AS dateJson,
        c.preference_revision_at_source AS preferenceRevision FROM message m LEFT JOIN message_context c ON c.message_id=m.message_id
       WHERE m.message_id=? AND m.conversation_id=? AND m.generation=?`,
        [id, header.conversationId, header.generation],
      )
    )[0];
    if (row) row.text = decodeStoredText(row.text);
    stored(
      row &&
        row.role === 'user' &&
        isRevision(row.sequence) &&
        row.dateJson !== null &&
        isRevision(row.preferenceRevision) &&
        row.preferenceRevision <= preferences.revision &&
        typeof row.text === 'string' &&
        [...row.text].length >= 1 &&
        [...row.text].length <= 4000,
    );
    const date = parseBoundedJson(row.dateJson, 4096);
    stored(isDateContext(date));
    const links = await session.all<SourcePreferenceLink & { operationId: string }>(
      `SELECT source_message_id AS sourceMessageId, preference_id AS preferenceId,
      type, value, saved_revision AS savedRevision, removed_revision AS removedRevision, save_operation_id AS operationId
      FROM source_preference_link WHERE source_message_id=? ORDER BY preference_id,saved_revision`,
      [id],
    );
    const publicLinks: SourcePreferenceLink[] = [];
    for (const link of links) {
      link.value = decodeStoredText(link.value);
      stored(
        isRevision(link.savedRevision) &&
          link.savedRevision <= preferences.revision &&
          (link.removedRevision === null ||
            (isRevision(link.removedRevision) &&
              preferences.lastRemovalRevision !== null &&
              link.removedRevision <= preferences.lastRemovalRevision &&
              link.removedRevision > row.preferenceRevision)),
      );
      stored(
        validatePreferenceSnapshot({
          revision: preferences.revision,
          lastRemovalRevision: preferences.lastRemovalRevision,
          items: [
            {
              preferenceId: link.preferenceId,
              type: link.type,
              value: link.value,
              revision: link.savedRevision,
            },
          ],
        }),
      );
      const receipt = await readReceiptInSnapshot(session, link.operationId, catalogue);
      stored(
        receipt &&
          receipt.effects.some(
            (effect) => effect.kind === 'preference' && effect.entityId === link.preferenceId,
          ),
      );
      if (link.removedRevision === null)
        stored(
          preferences.items.some(
            (item) =>
              item.preferenceId === link.preferenceId &&
              item.revision === link.savedRevision &&
              item.type === link.type &&
              item.value === link.value,
          ),
        );
      const { operationId: _operationId, ...publicLink } = link;
      publicLinks.push(publicLink);
    }
    result.push({
      sourceMessageId: id,
      sourceSequence: row.sequence,
      sourceDateContext: date,
      preferenceRevisionAtSource: row.preferenceRevision,
      preferenceLinks: publicLinks,
      quote: row.text,
    });
  }
  return result;
}

export async function hydrateMemoryItems(
  session: SqlSession,
  header: ConversationHeader,
  graph: ReadonlyMap<string, MemoryNode>,
  ids: readonly string[],
  catalogue: CatalogueBoundary,
): Promise<MemoryItem[]> {
  const nodes = ids.map((id) => {
    const node = graph.get(id);
    stored(node);
    return node;
  });
  const sources = await readUserSources(
    session,
    header,
    nodes.map((node) => node.sourceMessageId),
    catalogue,
  );
  return nodes.map((node, index) => ({
    ...sources[index]!,
    memoryId: node.memoryId,
    revision: node.revision,
    kind: node.kind,
    scope: node.scope,
    relations: node.relations,
  }));
}

export async function verifySuppliedUserSources(
  session: SqlSession,
  header: ConversationHeader,
  supplied: readonly UserMemorySource[],
  catalogue: CatalogueBoundary,
): Promise<void> {
  const distinct = new Map<string, UserMemorySource>();
  for (const source of supplied) {
    const previous = distinct.get(source.sourceMessageId);
    stored(!previous || equivalentJson(previous, source));
    distinct.set(source.sourceMessageId, source);
  }
  const actual = await readUserSources(session, header, [...distinct.keys()], catalogue);
  stored(actual.every((source) => equivalentJson(source, distinct.get(source.sourceMessageId))));
}
