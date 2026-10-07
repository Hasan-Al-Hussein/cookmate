import { canonicalContentJson } from '@cookmate/catalogue/content';
import { isActualLocalDate, isUtcInstant, type ContractError } from '@cookmate/contracts';
import {
  COOKING_HISTORY_PAGE_LIMIT,
  type CookingHistoryEntry,
  type Immutable,
  type RepositoryResult,
} from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import type { ContentCookingHistoryEntry } from './contentCookingHistoryRecords';
import { isAppId, isRevision } from './conversationRecords';
import {
  readStoredCookingHistoryEntries,
  requireCookingContentReadVersion,
  type CookingContentPin,
  type HistoryPinSource,
} from './cookingContentRepository';
import { historyRows } from './cookingHistoryRows';
import { freezeResult, readRevision } from './query';
import { readRestoreEpoch } from './restoreEpoch';
import type { SerializedReader, SqlSession } from './sql';

interface Options {
  reader: SerializedReader;
  installationId: string;
  sha256(text: string): Promise<string>;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
}
export interface ContentCookingHistoryPage {
  items: {
    entry: CookingHistoryEntry | ContentCookingHistoryEntry;
    pin: CookingContentPin;
    source: HistoryPinSource;
  }[];
  historyRevision: number;
  historyEpoch: number;
  nextCursor: string | null;
}
interface Cursor {
  formatVersion: 1;
  installationId: string;
  ownerId: string | null;
  authGeneration: number;
  historyRevision: number;
  historyEpoch: number;
  restoreEpoch: number;
  cookedOn: string;
  recordedAt: string;
  eventId: string;
}
class ReadFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function reject(message: string, code: ContractError['code'] = 'storage_failure'): never {
  throw new ReadFault({
    code,
    messageKey: `content.history_${message}`,
    retry: 'after_correction',
  });
}
function stored(condition: unknown): asserts condition {
  if (!condition) reject('stored_evidence_invalid');
}
function request(input: unknown): { limit: number; cursor: Cursor | null } {
  try {
    const value = input === undefined ? {} : JSON.parse(canonicalContentJson(input, 2048));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !['cursor', 'limit'].includes(key))
    )
      throw new Error();
    const limit = value.limit === undefined ? 20 : value.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > COOKING_HISTORY_PAGE_LIMIT)
      throw new Error();
    if (value.cursor === undefined) return { limit, cursor: null };
    if (typeof value.cursor !== 'string' || value.cursor.length > 1024) throw new Error();
    const cursor: unknown = JSON.parse(value.cursor);
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error();
    const keys = [
      'formatVersion',
      'installationId',
      'ownerId',
      'authGeneration',
      'historyRevision',
      'historyEpoch',
      'restoreEpoch',
      'cookedOn',
      'recordedAt',
      'eventId',
    ];
    if (
      Object.keys(cursor).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(cursor, key))
    )
      throw new Error();
    const candidate = cursor as Cursor;
    if (
      candidate.formatVersion !== 1 ||
      !isAppId(candidate.installationId) ||
      (candidate.ownerId !== null && !isAppId(candidate.ownerId)) ||
      !isRevision(candidate.authGeneration) ||
      !isRevision(candidate.historyRevision) ||
      !isRevision(candidate.historyEpoch) ||
      !isRevision(candidate.restoreEpoch) ||
      typeof candidate.cookedOn !== 'string' ||
      !isActualLocalDate(candidate.cookedOn) ||
      typeof candidate.recordedAt !== 'string' ||
      !isUtcInstant(candidate.recordedAt) ||
      !isAppId(candidate.eventId)
    )
      throw new Error();
    return { limit, cursor: candidate };
  } catch {
    reject('invalid_page', 'invalid_input');
  }
}

/** Private read-only mixed history. Exact pins are metadata, never permission to expose a recipe body. */
export function createContentCookingHistoryReader(options: Options) {
  if (!isAppId(options.installationId)) reject('invalid_installation', 'invalid_input');
  const access = options.getAccess();
  if (
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !isRevision(access.authGeneration)
  )
    reject('access_changed', 'stale_context');
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  let closed = false;
  function check(): undefined {
    const live = options.getAccess();
    if (
      closed ||
      !live ||
      live.ownerId !== scope.ownerId ||
      live.authGeneration !== scope.authGeneration ||
      options.assertAccess(scope) !== undefined
    )
      reject('access_changed', 'stale_context');
    return undefined;
  }
  async function owner(session: SqlSession) {
    check();
    await requireCookingContentReadVersion(session);
    const [row] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (row?.id !== options.installationId || (await readBinding(session)) !== scope.ownerId)
      reject('access_changed', 'stale_context');
    check();
  }
  const sha256 = async (text: string) => {
    check();
    const result = await options.sha256(text);
    check();
    stored(typeof result === 'string' && /^[0-9a-f]{64}$/.test(result));
    return result;
  };
  async function readHistory(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<RepositoryResult<Immutable<ContentCookingHistoryPage>>> {
    try {
      check();
      const { cursor, limit } = request(input);
      if (
        cursor &&
        (cursor.installationId !== options.installationId ||
          cursor.ownerId !== scope.ownerId ||
          cursor.authGeneration !== scope.authGeneration)
      )
        reject('access_changed', 'stale_context');
      const result = await options.reader.transaction(
        async (session) => {
          await owner(session);
          const [state] = await session.all<{ historyRevision: number; historyEpoch: number }>(
            'SELECT history_revision historyRevision,history_epoch historyEpoch FROM cooking_state WHERE singleton=1',
          );
          stored(state && isRevision(state.historyRevision) && isRevision(state.historyEpoch));
          const restoreEpoch = await readRestoreEpoch(session);
          if (
            cursor &&
            (cursor.historyRevision !== state.historyRevision ||
              cursor.historyEpoch !== state.historyEpoch ||
              cursor.restoreEpoch !== restoreEpoch)
          )
            reject('changed', 'stale_context');
          const rows = await historyRows(
            session,
            state.historyEpoch,
            limit + 1,
            cursor ?? undefined,
            { contentSchema: true },
          );
          const keys = rows.map((row) => {
            stored(row.source && ['local', 'backup', 'account'].includes(row.source));
            return { source: row.source, eventId: row.eventId };
          });
          const verified = await readStoredCookingHistoryEntries(session, { keys, sha256 });
          const indexed = new Map(
            verified.map((value) => [`${value.source}:${value.value.eventId}`, value]),
          );
          const items = rows.slice(0, limit).map((row) => {
            const value = indexed.get(`${row.source}:${row.eventId}`);
            stored(value);
            const historyEpoch =
              'historyEpoch' in value.value ? value.value.historyEpoch : state.historyEpoch;
            const revision =
              'revision' in value.value ? value.value.revision : state.historyRevision;
            stored(isRevision(historyEpoch) && isRevision(revision));
            const entry = { ...value.value, historyEpoch, revision };
            stored(
              entry.historyEpoch === state.historyEpoch &&
                entry.revision > 0 &&
                entry.revision <= state.historyRevision &&
                entry.cookedOn === row.cookedOn &&
                entry.recordedAt === row.recordedAt,
            );
            return { entry, pin: value.pin, source: value.source };
          });
          const last = items.at(-1)?.entry;
          check();
          return {
            kind: 'ready' as const,
            value: freezeResult({
              items,
              ...state,
              nextCursor:
                rows.length > limit && last
                  ? canonicalContentJson({
                      formatVersion: 1,
                      installationId: options.installationId,
                      ...scope,
                      ...state,
                      restoreEpoch,
                      cookedOn: last.cookedOn,
                      recordedAt: last.recordedAt,
                      eventId: last.eventId,
                    })
                  : null,
            }),
            revision: await readRevision(session, 'store'),
          };
        },
        { kind: 'read_only' },
      );
      check();
      return result;
    } catch (error) {
      return {
        kind: 'failed',
        error:
          error instanceof ReadFault
            ? error.detail
            : {
                code: 'storage_failure',
                messageKey: 'content.history_read_failed',
                retry: 'after_correction',
              },
      };
    }
  }
  return Object.freeze({
    readHistory,
    close() {
      closed = true;
    },
  });
}
