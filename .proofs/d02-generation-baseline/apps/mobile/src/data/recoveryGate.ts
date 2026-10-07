import type { CatalogueBoundary } from '@cookmate/contracts';
import type {
  AssistantActionRecovery,
  CommandPlatform,
  ConversationHeader,
  Immutable,
  RecoveryGate,
  RepositoryResult,
} from '@cookmate/domain';
import { readActionRecoveryInSnapshot } from './assistantActionRepository';
import { readAssistantInventoryRecordInSnapshot } from './conversationRepository';
import { isAppId, isRevision, readConversationHeader } from './conversationRecords';
import { freezeResult, readRevision } from './query';
import { StorageFault } from './sql';
import { verifySchemaCompatibility } from './schemaCompatibility';
import type {
  RecoveryImpact,
  SerializedWriter,
  SqlSession,
  WriterTransactionObserver,
} from './sql';

const BATCH_LIMIT = 32;
const BYTE_LIMIT = 2 * 1024 * 1024;
type Reader = Pick<SqlSession, 'all'>;
type Proof = Immutable<AssistantActionRecovery>;
interface Fences {
  data: number;
  schema: number;
  changes: number;
}
interface Patch {
  cursor: string;
  complete: boolean;
  validated: string[];
  proofs: { id: string; proof: Proof | null }[];
  continuation: string;
  snapshot?: readonly Proof[];
}
interface Frame {
  impact: RecoveryImpact;
  fences: Fences;
  header: ConversationHeader;
  end?: Fences;
  patch?: Patch;
}

async function fences(reader: Reader): Promise<Fences> {
  const data = (await reader.all<{ data_version: number }>('PRAGMA main.data_version'))[0]
    ?.data_version;
  const schema = (await reader.all<{ schema_version: number }>('PRAGMA main.schema_version'))[0]
    ?.schema_version;
  const changes = (await reader.all<{ changes: number }>('SELECT total_changes() AS changes'))[0]
    ?.changes;
  if (!isRevision(data) || !isRevision(schema) || !isRevision(changes))
    throw new StorageFault('storage_failure', 'Recovery freshness fence unavailable');
  return { data, schema, changes };
}

// Estimate encoded evidence before any JSON body is brought into JavaScript. The slot
// subquery is capped at nine: a ninth row is corruption, never an unbounded materialization.
const inventory = `SELECT k.id,a.user_intent_id AS contextId,
  COALESCE(length(CAST(a.request_json AS BLOB)),0) + COALESCE(length(CAST(a.response_json AS BLOB)),0)
  + COALESCE(length(CAST(a.guards_json AS BLOB)),0) + COALESCE(length(CAST(a.slot_results_json AS BLOB)),0)
  + COALESCE(length(CAST(p.intent_json AS BLOB)),0)
  + COALESCE(length(CAST(ap.plan_json AS BLOB)),0) + COALESCE(length(CAST(ap.guards_json AS BLOB)),0)
  + COALESCE(length(CAST(m.text AS BLOB)),0) + COALESCE(length(CAST(reply.text AS BLOB)),0)
  + COALESCE((SELECT SUM(bytes) FROM (SELECT length(CAST(s.command_json AS BLOB)) AS bytes
      FROM command_slot s WHERE s.user_intent_id=a.user_intent_id LIMIT 9)),0)
  + COALESCE((SELECT SUM(bytes) FROM (SELECT length(CAST(r.effects_json AS BLOB))
      + length(CAST(r.committed_at AS BLOB)) AS bytes
      FROM json_each(ap.plan_json,'$.slots') reserved JOIN operation_receipt r
      ON r.operation_id=json_extract(reserved.value,'$.operationId') LIMIT 9)),0) AS bytes,
  (SELECT COUNT(*) FROM (SELECT 1 FROM command_slot s WHERE s.user_intent_id=a.user_intent_id LIMIT 9)) AS slotCount
 FROM recovery_ids k LEFT JOIN assistant_intent_context a ON a.user_intent_id=k.id
 LEFT JOIN pending_intent p ON p.user_intent_id=k.id
 LEFT JOIN assistant_action_plan ap ON ap.user_intent_id=a.user_intent_id
 LEFT JOIN assistant_acceptance_envelope e ON e.user_intent_id=a.user_intent_id
 LEFT JOIN message m ON m.message_id=json_extract(a.request_json,'$.message.messageId')
 LEFT JOIN message reply ON reply.message_id=e.assistant_message_id`;
interface InventoryRow {
  id: string;
  contextId: string | null;
  bytes: number;
  slotCount: number;
}

/** A connection-lifetime coverage claim. It is never command authority or historical narration. */
export function createAssistantRecoveryGate(options: {
  writer: SerializedWriter;
  catalogue: CatalogueBoundary;
  platform: CommandPlatform;
}) {
  const instance = options.platform.newId();
  if (!isAppId(instance)) throw new StorageFault('storage_failure', 'Invalid recovery instance ID');
  let epoch = 0;
  let serial = 0;
  let token = `${instance}:${epoch}`;
  let cursor = '';
  let complete = false;
  let continuation = `${token}:${serial}`;
  let expected: Fences | undefined;
  let expectedSchema: number | undefined;
  let header: ConversationHeader | undefined;
  let frame: Frame | undefined;
  let closed = false;
  let schemaBroken = false;
  let certificate = false;
  const dirty = new Set<string>();
  const candidates = new Map<string, Proof>();
  let candidateSnapshot: readonly Proof[] = Object.freeze([]);
  const listeners = new Set<(event: { token: string | null }) => void>();

  const emit = (value: string | null) => {
    for (const listener of [...listeners]) {
      try {
        listener({ token: value });
      } catch {
        /* Consumers cannot interfere with persistence. */
      }
    }
  };
  const invalidate = (all: boolean, unknown = false) => {
    certificate = false;
    token = `${instance}:${++epoch}`;
    continuation = `${token}:${++serial}`;
    if (all) {
      cursor = '';
      complete = false;
      dirty.clear();
      candidates.clear();
      candidateSnapshot = Object.freeze([]);
    }
    emit(unknown ? null : token);
  };
  const fail = () => {
    frame = undefined;
    expected = undefined;
    invalidate(true, true);
  };
  const sameIdentity = (a: ConversationHeader, b: ConversationHeader) =>
    a.conversationId === b.conversationId && a.generation === b.generation;

  const observer: WriterTransactionObserver = {
    begin: async (session, impact) => {
      if (closed || schemaBroken)
        throw new StorageFault('storage_failure', 'Recovery gate unavailable');
      certificate = false;
      const actual = await fences(session);
      if (expectedSchema === undefined) {
        await verifySchemaCompatibility(session);
        expectedSchema = actual.schema;
      }
      const current = await readConversationHeader(session);
      if (actual.schema !== expectedSchema) {
        schemaBroken = true;
        throw new StorageFault('storage_failure', 'Recovery schema changed');
      }
      if (
        (expected && (actual.data !== expected.data || actual.changes !== expected.changes)) ||
        (header && !sameIdentity(header, current))
      )
        invalidate(true, true);
      header = current;
      if (impact.kind === 'intents' && impact.userIntentIds.every(isAppId)) {
        if (impact.userIntentIds.length) {
          invalidate(false);
          for (const id of impact.userIntentIds) dirty.add(id);
        }
      } else if (!['read_only', 'draft_only', 'none'].includes(impact.kind)) invalidate(true);
      frame = { impact, fences: actual, header: current };
    },
    beforeCommit: async (session) => {
      if (!frame) throw new StorageFault('storage_failure', 'Missing recovery transaction');
      const actual = await fences(session);
      const current = await readConversationHeader(session);
      if (actual.schema !== frame.fences.schema) schemaBroken = true;
      if (actual.schema !== frame.fences.schema || actual.data !== frame.fences.data)
        throw new StorageFault('storage_failure', 'Recovery fence changed inside transaction');
      if (frame.impact.kind === 'read_only' && actual.changes !== frame.fences.changes)
        throw new StorageFault('storage_failure', 'Read-only recovery transaction mutated storage');
      if (
        frame.impact.kind === 'draft_only' &&
        (!sameIdentity(current, frame.header) ||
          current.nextSequence !== frame.header.nextSequence ||
          current.revision !== frame.header.revision)
      )
        throw new StorageFault('storage_failure', 'Draft transaction changed recovery evidence');
      if (!sameIdentity(current, frame.header)) {
        invalidate(true);
        delete frame.patch;
      }
      frame.header = current;
      frame.end = actual;
    },
    committed: async (reader) => {
      if (!frame?.end) throw new StorageFault('storage_failure', 'Unfinished recovery transaction');
      const actual = await fences(reader);
      if (actual.schema !== frame.end.schema) schemaBroken = true;
      if (
        actual.data !== frame.end.data ||
        actual.schema !== frame.end.schema ||
        actual.changes !== frame.end.changes
      )
        throw new StorageFault('storage_failure', 'Recovery fence changed at commit');
      const staged = frame.patch;
      if (staged) {
        for (const id of staged.validated) dirty.delete(id);
        for (const item of staged.proofs) {
          if (item.proof) candidates.set(item.id, item.proof);
          else candidates.delete(item.id);
        }
        cursor = staged.cursor;
        complete = staged.complete;
        continuation = staged.continuation;
        if (staged.snapshot) candidateSnapshot = staged.snapshot;
      }
      header = frame.header;
      expected = actual;
      certificate = ['read_only', 'draft_only', 'none'].includes(frame.impact.kind);
      frame = undefined;
    },
    failed: fail,
  };
  options.writer.setObserver(observer);

  const inspect = async (session: SqlSession, row: InventoryRow, current: ConversationHeader) => {
    if (
      !isAppId(row.id) ||
      !isRevision(row.bytes) ||
      !isRevision(row.slotCount) ||
      row.slotCount > 8 ||
      row.bytes > BYTE_LIMIT
    )
      throw new StorageFault(
        'storage_failure',
        'Recovery evidence exceeds the bounded audit budget',
      );
    if (row.contextId === null) {
      await directOnly(session, row.id);
      return null;
    }
    if (row.contextId !== row.id)
      throw new StorageFault('storage_failure', 'Invalid assistant recovery inventory identity');
    await readAssistantInventoryRecordInSnapshot(session, options.catalogue, row.id, current);
    const proof = await readActionRecoveryInSnapshot(session, options, row.id);
    return proof?.slots.some((slot) => slot.outcome === 'unresolved') ? freezeResult(proof) : null;
  };
  const directOnly = async (session: SqlSession, id: string) => {
    const rows = await session.all<{ origin: string | null; associations: number }>(
      `SELECT json_extract(p.intent_json,'$.origin') AS origin,
       (SELECT COUNT(*) FROM assistant_action_plan WHERE user_intent_id=p.user_intent_id)
       +(SELECT COUNT(*) FROM assistant_acceptance_envelope WHERE user_intent_id=p.user_intent_id)
       +(SELECT COUNT(*) FROM assistant_acceptance WHERE user_intent_id=p.user_intent_id) AS associations
       FROM pending_intent p WHERE p.user_intent_id=?`,
      [id],
    );
    if (rows.length !== 1 || rows[0]!.origin !== null || rows[0]!.associations !== 0)
      throw new StorageFault('storage_failure', 'Missing assistant recovery inventory record');
  };

  return {
    refreshRecoveryGate: async (
      input: { continuation?: string } = {},
    ): Promise<RepositoryResult<Immutable<RecoveryGate>>> => {
      const requested = input.continuation;
      if (requested !== undefined && typeof requested !== 'string')
        return {
          kind: 'failed',
          error: {
            code: 'invalid_input',
            messageKey: 'recovery.invalid_continuation',
            retry: 'after_correction',
          },
        };
      let value: Immutable<RecoveryGate> | undefined;
      try {
        const revision = await options.writer.transaction(
          async (session) => {
            if (!frame || !header)
              throw new StorageFault('storage_failure', 'Recovery gate unavailable');
            if (requested !== undefined && requested !== continuation)
              throw new StorageFault('storage_failure', 'Recovery continuation expired');
            const current = frame.header;
            const patch: Patch = { cursor, complete, validated: [], proofs: [], continuation };
            let bytes = 0;
            let count = 0;
            for (const id of dirty) {
              if (count === BATCH_LIMIT) break;
              const row = (
                await session.all<InventoryRow>(
                  `WITH recovery_ids AS (SELECT ? AS id) ${inventory}`,
                  [id],
                )
              )[0];
              if (row && count > 0 && bytes + row.bytes > BYTE_LIMIT) break;
              if (row) {
                patch.proofs.push({ id, proof: await inspect(session, row, current) });
                bytes += row.bytes;
              } else {
                await directOnly(session, id);
                patch.proofs.push({ id, proof: null });
              }
              patch.validated.push(id);
              count++;
            }
            if (!patch.complete && count < BATCH_LIMIT) {
              const rows = await session.all<InventoryRow>(
                `WITH recovery_ids AS (
                  SELECT user_intent_id AS id FROM pending_intent WHERE user_intent_id>?
                  UNION SELECT user_intent_id AS id FROM assistant_intent_context WHERE user_intent_id>?
                  UNION SELECT user_intent_id AS id FROM assistant_acceptance_envelope WHERE user_intent_id>?
                  UNION SELECT user_intent_id AS id FROM assistant_action_plan WHERE user_intent_id>?
                  UNION SELECT user_intent_id AS id FROM assistant_acceptance WHERE user_intent_id>?
                  UNION SELECT user_intent_id AS id FROM command_slot WHERE user_intent_id>?
                  ORDER BY id LIMIT ?
                ) ${inventory} ORDER BY k.id`,
                [cursor, cursor, cursor, cursor, cursor, cursor, BATCH_LIMIT - count + 1],
              );
              let consumed = 0;
              for (const row of rows) {
                if (count === BATCH_LIMIT || (count > 0 && bytes + row.bytes > BYTE_LIMIT)) break;
                patch.proofs.push({ id: row.id, proof: await inspect(session, row, current) });
                patch.cursor = row.id;
                patch.validated.push(row.id);
                bytes += row.bytes;
                count++;
                consumed++;
              }
              patch.complete = consumed === rows.length;
            }
            const processedDirty = new Set(patch.validated.filter((id) => dirty.has(id)));
            const hasDirty = dirty.size > processedDirty.size;
            const done = patch.complete && !hasDirty;
            patch.continuation = done ? continuation : `${token}:${++serial}`;
            frame.patch = patch;
            // Build only the changed unresolved snapshot. No historical map is retained or walked.
            let nextCandidates = candidateSnapshot;
            if (patch.proofs.length) {
              const next = new Map(candidates);
              for (const item of patch.proofs) {
                if (item.proof) next.set(item.id, item.proof);
                else next.delete(item.id);
              }
              nextCandidates = Object.freeze([...next.values()]);
            }
            patch.snapshot = nextCandidates;
            value = Object.freeze(
              done
                ? {
                    token,
                    conversationId: current.conversationId,
                    conversationGeneration: current.generation,
                    kind: 'ready' as const,
                    candidates: nextCandidates,
                  }
                : {
                    token,
                    conversationId: current.conversationId,
                    conversationGeneration: current.generation,
                    kind: 'checking' as const,
                    continuation: patch.continuation,
                  },
            );
            return readRevision(session, 'store');
          },
          { kind: 'read_only' },
        );
        return { kind: 'ready', revision, value: value! };
      } catch {
        return {
          kind: 'failed',
          error: {
            code: 'storage_failure',
            messageKey: 'recovery.unavailable',
            retry: 'reconcile',
          },
        };
      }
    },
    subscribeRecoveryInvalidation: (listener: (event: { token: string | null }) => void) => {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    unchangedCertificate: (): { kind: 'unchanged'; token: string } | undefined =>
      !closed && certificate ? { kind: 'unchanged', token } : undefined,
    close: () => {
      closed = true;
      fail();
      listeners.clear();
    },
  };
}
