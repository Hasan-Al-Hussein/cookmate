import { isActualLocalDate, isUtcInstant } from '@cookmate/contracts';
import type { CatalogueIdentity, ContractError, DateContext, Recipe } from '@cookmate/contracts';
import {
  COOKING_HISTORY_PAGE_LIMIT,
  COOKING_NOTE_MAX_CHARACTERS,
  cookingContentIdentity,
  portablePersonalLimits,
} from '@cookmate/domain';
import type {
  ClearCookingHistoryReceipt,
  ClearCookingHistoryReview,
  CommandPlatform,
  CookedReceipt,
  CookingChange,
  CookingContentIdentity,
  CookingHistoryEntry,
  CookingMutationResult,
  CookingService,
  CookingSession,
  CookingSessionView,
  Immutable,
  RepositoryResult,
} from '@cookmate/domain';
import { isAppId, isRevision } from './conversationRecords';
import { freezeResult, readRevision } from './query';
import { runBound, StorageFault } from './sql';
import type { SerializedReader, SerializedWriter, SqlSession } from './sql';
import {
  historyClearSnapshot,
  hasAccountCookingEventId,
  historyCount,
  historyRows,
  parseAccountHistory,
  parseImportedHistory,
  withdrawClearedHistory,
} from './cookingHistoryRows';
import type { HistoryClearSnapshot, HistoryRow } from './cookingHistoryRows';

interface Options {
  reader: SerializedReader;
  writer: SerializedWriter;
  platform: CommandPlatform;
  catalogue: Readonly<CatalogueIdentity>;
  readRecipe(id: string): Immutable<Recipe> | undefined;
  now(): string;
  dateContext(): DateContext;
  onCommitted(change: CookingChange): void;
}
class CookingFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function fault(key: string, code: ContractError['code'] = 'invalid_input'): never {
  throw new CookingFault({ code, messageKey: `cooking.${key}`, retry: 'after_correction' });
}
function stored(condition: unknown): asserts condition {
  if (!condition) throw new StorageFault('storage_failure', 'Stored cooking data is invalid');
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const positive = (value: unknown): value is number => isRevision(value) && value > 0;
const errorDetail = (error: unknown): ContractError =>
  error instanceof CookingFault
    ? error.detail
    : { code: 'storage_failure', messageKey: 'cooking.storage_failure', retry: 'after_correction' };
const failed = (error: unknown) => ({ kind: 'failed' as const, error: errorDetail(error) });
function zone(value: unknown): value is string {
  if (!text(value, 100)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
function next(value: number) {
  stored(isRevision(value) && Number.isSafeInteger(value + 1));
  return value + 1;
}
function validIdentity(value: Record<string, unknown>) {
  return (
    text(value.recipeId, 100) &&
    hash(value.contentFingerprint) &&
    value.readerVersion === 1 &&
    record(value.catalogue) &&
    exact(value.catalogue, ['version', 'fingerprint']) &&
    text(value.catalogue.version, 200) &&
    hash(value.catalogue.fingerprint)
  );
}
function validSession(value: unknown): value is CookingSession {
  return (
    record(value) &&
    exact(value, [
      'recipeId',
      'catalogue',
      'contentFingerprint',
      'readerVersion',
      'sessionId',
      'revision',
      'passageSequence',
      'state',
      'updatedAt',
      'lastOperationId',
    ]) &&
    validIdentity(value) &&
    isAppId(value.sessionId) &&
    positive(value.revision) &&
    positive(value.passageSequence) &&
    ['active', 'dismissed', 'completed'].includes(value.state as string) &&
    typeof value.updatedAt === 'string' &&
    isUtcInstant(value.updatedAt) &&
    isAppId(value.lastOperationId)
  );
}
function validEntry(value: unknown): value is CookingHistoryEntry {
  return (
    record(value) &&
    exact(value, [
      'recipeId',
      'catalogue',
      'contentFingerprint',
      'readerVersion',
      'eventId',
      'recipeTitle',
      'photoKey',
      'cookedOn',
      'timeZone',
      'recordedAt',
      'note',
      'historyEpoch',
      'revision',
    ]) &&
    validIdentity(value) &&
    isAppId(value.eventId) &&
    text(value.recipeTitle, 1000) &&
    text(value.photoKey, 300) &&
    typeof value.cookedOn === 'string' &&
    isActualLocalDate(value.cookedOn) &&
    zone(value.timeZone) &&
    typeof value.recordedAt === 'string' &&
    isUtcInstant(value.recordedAt) &&
    (value.note === null ||
      (typeof value.note === 'string' && [...value.note].length <= COOKING_NOTE_MAX_CHARACTERS)) &&
    isRevision(value.historyEpoch) &&
    positive(value.revision)
  );
}
interface State {
  sessionRevision: number;
  historyRevision: number;
  historyEpoch: number;
}
async function state(session: SqlSession): Promise<State> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (version !== 4 && version !== 5 && version !== 6)
    fault('not_activated', 'incompatible_version');
  const rows = await session.all<State>(
    'SELECT session_revision AS sessionRevision, history_revision AS historyRevision, history_epoch AS historyEpoch FROM cooking_state WHERE singleton=1',
  );
  stored(rows.length === 1 && Object.values(rows[0]!).every(isRevision));
  return rows[0]!;
}
interface SessionRow {
  recipeId: string;
  sessionId: string;
  revision: number;
  state: string;
  updatedAt: string;
  operationId: string;
  requestFingerprint: string;
  sessionJson: string;
}
const sessionColumns =
  'recipe_id AS recipeId, session_id AS sessionId, revision, state, updated_at AS updatedAt, operation_id AS operationId, request_fingerprint AS requestFingerprint, session_json AS sessionJson';
function parseSession(row: SessionRow): CookingSession {
  stored(
    typeof row.sessionJson === 'string' &&
      row.sessionJson.length <= 8192 &&
      hash(row.requestFingerprint),
  );
  const value: unknown = JSON.parse(row.sessionJson);
  stored(
    validSession(value) &&
      value.recipeId === row.recipeId &&
      value.sessionId === row.sessionId &&
      value.revision === row.revision &&
      value.state === row.state &&
      value.updatedAt === row.updatedAt &&
      value.lastOperationId === row.operationId,
  );
  return value;
}
async function sessionRow(session: SqlSession, recipeId: string) {
  const row = (
    await session.all<SessionRow>(
      `SELECT ${sessionColumns} FROM cooking_session WHERE recipe_id=?`,
      [recipeId],
    )
  )[0];
  if (row) {
    parseSession(row);
    stored(row.revision <= (await state(session)).sessionRevision);
  }
  return row ?? null;
}
async function writeSession(
  session: SqlSession,
  value: CookingSession,
  requestFingerprint: string,
) {
  await runBound(
    session,
    `INSERT INTO cooking_session VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(recipe_id) DO UPDATE SET session_id=excluded.session_id,revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at,operation_id=excluded.operation_id,request_fingerprint=excluded.request_fingerprint,session_json=excluded.session_json`,
    [
      value.recipeId,
      value.sessionId,
      value.revision,
      value.state,
      value.updatedAt,
      value.lastOperationId,
      requestFingerprint,
      JSON.stringify(value),
    ],
  );
  await runBound(session, 'UPDATE cooking_state SET session_revision=? WHERE singleton=1', [
    value.revision,
  ]);
}
interface EventRow {
  eventId: string;
  historyEpoch: number;
  state: 'saved' | 'cleared' | 'cancelled';
  cookedOn: string | null;
  recordedAt: string | null;
  requestFingerprint: string | null;
  receiptJson: string | null;
}
const eventColumns =
  'event_id AS eventId, history_epoch AS historyEpoch, state, cooked_on AS cookedOn, recorded_at AS recordedAt, request_fingerprint AS requestFingerprint, receipt_json AS receiptJson';
function parseEvent(row: EventRow): CookedReceipt {
  stored(isAppId(row.eventId) && isRevision(row.historyEpoch));
  if (row.state === 'cleared' || row.state === 'cancelled') {
    stored(
      row.cookedOn === null &&
        row.recordedAt === null &&
        row.requestFingerprint === null &&
        row.receiptJson === null,
    );
    return { kind: row.state, eventId: row.eventId, historyEpoch: row.historyEpoch };
  }
  stored(
    row.state === 'saved' &&
      hash(row.requestFingerprint) &&
      typeof row.receiptJson === 'string' &&
      row.receiptJson.length <= 32768,
  );
  const value: unknown = JSON.parse(row.receiptJson);
  stored(
    record(value) &&
      exact(value, ['kind', 'event', 'closedSession']) &&
      value.kind === 'saved' &&
      validEntry(value.event) &&
      (value.closedSession === null || validSession(value.closedSession)),
  );
  const receipt = value as unknown as Extract<CookedReceipt, { kind: 'saved' }>;
  stored(
    receipt.event.eventId === row.eventId &&
      receipt.event.historyEpoch === row.historyEpoch &&
      receipt.event.cookedOn === row.cookedOn &&
      receipt.event.recordedAt === row.recordedAt &&
      (!receipt.closedSession ||
        (receipt.closedSession.recipeId === receipt.event.recipeId &&
          receipt.closedSession.state === 'completed' &&
          receipt.closedSession.lastOperationId === row.eventId)),
  );
  return receipt;
}
async function eventRow(session: SqlSession, eventId: string) {
  const row = (
    await session.all<EventRow>(`SELECT ${eventColumns} FROM cooking_event WHERE event_id=?`, [
      eventId,
    ])
  )[0];
  if (row) parseEvent(row);
  return row ?? null;
}
function historyEntry(row: HistoryRow): CookingHistoryEntry {
  if (row.source === 'account') return parseAccountHistory(row);
  if (row.entryJson !== null) return parseImportedHistory(row);
  const receipt = parseEvent(row as EventRow);
  stored(receipt.kind === 'saved');
  return receipt.event;
}
/** Data-only snapshot; operation requests, session closures and receipts never leave this boundary. */
export async function readCookingHistoryForBackup(
  session: SqlSession,
): Promise<CookingHistoryEntry[]> {
  const current = await state(session);
  const rows = await historyRows(session, current.historyEpoch, portablePersonalLimits.history + 1);
  const entries = rows.map(historyEntry);
  stored(
    entries.every(
      (entry) =>
        entry.historyEpoch === current.historyEpoch && entry.revision <= current.historyRevision,
    ),
  );
  return entries;
}
async function visibleEventReceipt(session: SqlSession, row: EventRow): Promise<CookedReceipt> {
  const receipt = parseEvent(row);
  return receipt.kind === 'saved' &&
    receipt.event.historyEpoch < (await state(session)).historyEpoch
    ? { kind: 'cleared', eventId: row.eventId, historyEpoch: row.historyEpoch }
    : receipt;
}
async function requireLocalEventId(session: SqlSession, eventId: string) {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  if (
    (version === 5 || version === 6) &&
    (await session.all('SELECT 1 FROM imported_cooking_history WHERE event_id=?', [eventId])).length
  )
    fault('imported_entry_is_not_an_operation');
  if (await hasAccountCookingEventId(session, eventId)) fault('account_entry_is_not_an_operation');
}
async function clearReceipt(
  session: SqlSession,
  operationId: string,
): Promise<ClearCookingHistoryReceipt | null> {
  const row = (
    await session.all<{ receiptJson: string }>(
      'SELECT receipt_json AS receiptJson FROM cooking_history_clear WHERE operation_id=?',
      [operationId],
    )
  )[0];
  if (!row) return null;
  stored(typeof row.receiptJson === 'string' && row.receiptJson.length <= 4096);
  const value: unknown = JSON.parse(row.receiptJson);
  stored(
    record(value) &&
      exact(value, [
        'operationId',
        'outcome',
        'clearedCount',
        'previousHistoryEpoch',
        'historyEpoch',
        'historyRevision',
        'committedAt',
      ]) &&
      value.operationId === operationId &&
      isRevision(value.clearedCount) &&
      isRevision(value.previousHistoryEpoch) &&
      isRevision(value.historyEpoch) &&
      isRevision(value.historyRevision) &&
      ((value.outcome === 'cleared' &&
        value.historyEpoch === value.previousHistoryEpoch + 1 &&
        positive(value.historyRevision)) ||
        (value.outcome === 'cancelled' &&
          value.historyEpoch === value.previousHistoryEpoch &&
          value.clearedCount === 0)) &&
      typeof value.committedAt === 'string' &&
      isUtcInstant(value.committedAt),
  );
  return value as unknown as ClearCookingHistoryReceipt;
}

/** App-only transactions; every mutation is explicit and all recovery reads use the independent reader. */
export function createCookingRepository(
  options: Options,
): CookingService & { close(): void; notifyRestored(revision: number): void } {
  const identities = new Map<string, Promise<CookingContentIdentity>>();
  const reviews = new WeakMap<
    object,
    {
      review: Immutable<ClearCookingHistoryReview>;
      history: Immutable<HistoryClearSnapshot> | null;
    }
  >();
  const listeners = new Set<(change: CookingChange) => void>();
  const identity = (recipeId: string) => {
    const recipe = options.readRecipe(recipeId);
    if (!recipe) fault('unknown_recipe');
    let result = identities.get(recipeId);
    if (!result) {
      result = cookingContentIdentity(recipe, options.catalogue, options.platform.sha256);
      identities.set(recipeId, result);
      void result.catch(() => identities.delete(recipeId));
    }
    return result;
  };
  const now = () => {
    const result = options.now();
    stored(isUtcInstant(result));
    return result;
  };
  const requestHash = async (value: unknown) => {
    const digest = await options.platform.sha256(JSON.stringify(value));
    stored(hash(digest));
    return digest;
  };
  const read = async <T>(
    work: (session: SqlSession) => Promise<T>,
  ): Promise<RepositoryResult<Immutable<T>>> => {
    try {
      return await options.reader.transaction(async (session) => {
        await state(session);
        return {
          kind: 'ready' as const,
          revision: await readRevision(session, 'store'),
          value: freezeResult(await work(session)) as Immutable<T>,
        };
      });
    } catch (error) {
      return failed(error);
    }
  };
  const view = async (recipeId: string, row: SessionRow | null): Promise<CookingSessionView> => {
    const currentContent = await identity(recipeId);
    const passageSequences = options.readRecipe(recipeId)!.instructions.map((p) => p.sequence);
    const saved = row ? parseSession(row) : null;
    return {
      currentContent,
      passageSequences,
      session: saved,
      resume:
        !saved || saved.state !== 'active'
          ? 'none'
          : saved.contentFingerprint === currentContent.contentFingerprint &&
              saved.readerVersion === currentContent.readerVersion &&
              passageSequences.includes(saved.passageSequence)
            ? 'matching'
            : 'content_changed',
    };
  };
  const publish = (change: CookingChange) => {
    const frozen = freezeResult(change);
    try {
      options.onCommitted(frozen);
    } catch {
      /* Notification cannot undo a commit. */
    }
    for (const listener of [...listeners])
      try {
        listener(frozen);
      } catch {
        /* Isolate consumers. */
      }
  };
  const mutate = async <T>(
    operationId: string,
    recipeId: string | null,
    historyChanged: boolean,
    work: (session: SqlSession) => Promise<{ value: T; changed: boolean }>,
    proof: (session: SqlSession) => Promise<T | null>,
  ): Promise<CookingMutationResult<T>> => {
    let touched = false;
    try {
      const result = await options.writer.transaction(
        async (session) => {
          await state(session);
          const outcome = await work(session);
          let revision = await readRevision(session, 'store');
          if (outcome.changed) {
            revision = next(revision);
            await runBound(
              session,
              "UPDATE state_revision SET revision=? WHERE collection='store'",
              [revision],
            );
            touched = true;
          }
          return {
            kind: 'ready' as const,
            value: freezeResult(outcome.value) as Immutable<T>,
            revision,
          };
        },
        { kind: 'none' },
      );
      if (touched) publish({ recipeId, historyChanged, revision: result.revision });
      return result;
    } catch (error) {
      const recovered = await read(proof);
      if (recovered.kind === 'ready' && recovered.value !== null) {
        if (touched) publish({ recipeId, historyChanged, revision: recovered.revision });
        return { ...recovered, value: recovered.value as Immutable<T> };
      }
      if (options.writer.requiresRecovery() || recovered.kind === 'failed')
        return { kind: 'uncertain', operationId, error: errorDetail(error) };
      return failed(error);
    }
  };
  const checkIdentity = async (recipeId: string, fingerprint: string, readerVersion: number) => {
    const content = await identity(recipeId);
    if (!hash(fingerprint) || readerVersion !== 1) fault('invalid_content');
    if (content.contentFingerprint !== fingerprint) fault('content_changed', 'stale_context');
    return content;
  };
  const saveSession: CookingService['saveSession'] = async (input) => {
    try {
      const owned = JSON.parse(JSON.stringify(input)) as typeof input;
      if (
        !isAppId(owned.operationId) ||
        !isAppId(owned.sessionId) ||
        !text(owned.recipeId, 100) ||
        !(owned.expectedRevision === null || positive(owned.expectedRevision)) ||
        !positive(owned.passageSequence)
      )
        fault('invalid_session');
      const content = await checkIdentity(
        owned.recipeId,
        owned.contentFingerprint,
        owned.readerVersion,
      );
      if (
        !options
          .readRecipe(owned.recipeId)!
          .instructions.some((p) => p.sequence === owned.passageSequence)
      )
        fault('invalid_passage');
      const fingerprint = await requestHash([
        'save-session',
        owned.operationId,
        owned.sessionId,
        owned.recipeId,
        owned.expectedRevision,
        owned.contentFingerprint,
        owned.readerVersion,
        owned.passageSequence,
      ]);
      const proof = async (session: SqlSession) => {
        const row = await sessionRow(session, owned.recipeId);
        return row?.operationId === owned.operationId && row.requestFingerprint === fingerprint
          ? parseSession(row)
          : null;
      };
      return mutate(
        owned.operationId,
        owned.recipeId,
        false,
        async (session) => {
          const row = await sessionRow(session, owned.recipeId);
          if (row?.operationId === owned.operationId) {
            if (row.requestFingerprint !== fingerprint) fault('operation_conflict');
            return { value: parseSession(row), changed: false };
          }
          if ((row?.revision ?? null) !== owned.expectedRevision)
            fault('session_changed', 'stale_context');
          if (
            row &&
            row.sessionId === owned.sessionId &&
            (row.state !== 'active' ||
              parseSession(row).contentFingerprint !== content.contentFingerprint)
          )
            fault('restart_required', 'stale_context');
          const value: CookingSession = {
            ...content,
            sessionId: owned.sessionId,
            revision: next((await state(session)).sessionRevision),
            passageSequence: owned.passageSequence,
            state: 'active',
            updatedAt: now(),
            lastOperationId: owned.operationId,
          };
          await writeSession(session, value, fingerprint);
          return { value, changed: true };
        },
        proof,
      );
    } catch (error) {
      return failed(error);
    }
  };
  const dismissSession: CookingService['dismissSession'] = async (input) => {
    try {
      const owned = { ...input };
      if (
        !isAppId(owned.operationId) ||
        !isAppId(owned.sessionId) ||
        !text(owned.recipeId, 100) ||
        !positive(owned.expectedRevision)
      )
        fault('invalid_session');
      const fingerprint = await requestHash([
        'dismiss-session',
        owned.operationId,
        owned.recipeId,
        owned.sessionId,
        owned.expectedRevision,
      ]);
      const proof = async (session: SqlSession) => {
        const row = await sessionRow(session, owned.recipeId);
        return row?.operationId === owned.operationId && row.requestFingerprint === fingerprint
          ? parseSession(row)
          : null;
      };
      return mutate(
        owned.operationId,
        owned.recipeId,
        false,
        async (session) => {
          const row = await sessionRow(session, owned.recipeId);
          if (row?.operationId === owned.operationId) {
            if (row.requestFingerprint !== fingerprint) fault('operation_conflict');
            return { value: parseSession(row), changed: false };
          }
          if (
            !row ||
            row.sessionId !== owned.sessionId ||
            row.revision !== owned.expectedRevision ||
            row.state !== 'active'
          )
            fault('session_changed', 'stale_context');
          const value: CookingSession = {
            ...parseSession(row),
            state: 'dismissed',
            revision: next((await state(session)).sessionRevision),
            updatedAt: now(),
            lastOperationId: owned.operationId,
          };
          await writeSession(session, value, fingerprint);
          return { value, changed: true };
        },
        proof,
      );
    } catch (error) {
      return failed(error);
    }
  };
  const saveCooked: CookingService['saveCooked'] = async (input) => {
    try {
      const owned = JSON.parse(JSON.stringify(input)) as typeof input;
      const note = owned.note ?? null;
      if (
        !isAppId(owned.eventId) ||
        !text(owned.recipeId, 100) ||
        !isRevision(owned.expectedHistoryEpoch) ||
        typeof owned.cookedOn !== 'string' ||
        !isActualLocalDate(owned.cookedOn) ||
        owned.cookedOn > options.dateContext().localDate ||
        !zone(owned.timeZone) ||
        !(
          note === null ||
          (typeof note === 'string' && [...note].length <= COOKING_NOTE_MAX_CHARACTERS)
        ) ||
        (owned.session &&
          (!isAppId(owned.session.sessionId) || !positive(owned.session.expectedRevision)))
      )
        fault('invalid_cooked_event');
      if (!hash(owned.contentFingerprint) || owned.readerVersion !== 1) fault('invalid_content');
      const fingerprint = await requestHash([
        'save-cooked',
        owned.eventId,
        owned.recipeId,
        owned.contentFingerprint,
        owned.readerVersion,
        owned.expectedHistoryEpoch,
        owned.cookedOn,
        owned.timeZone,
        note,
        owned.session?.sessionId ?? null,
        owned.session?.expectedRevision ?? null,
      ]);
      const proof = async (session: SqlSession) => {
        const row = await eventRow(session, owned.eventId);
        return row && (row.state !== 'saved' || row.requestFingerprint === fingerprint)
          ? visibleEventReceipt(session, row)
          : null;
      };
      return mutate(
        owned.eventId,
        owned.recipeId,
        true,
        async (session) => {
          const existing = await eventRow(session, owned.eventId);
          if (existing) {
            if (existing.state === 'saved' && existing.requestFingerprint !== fingerprint)
              fault('operation_conflict');
            return { value: await visibleEventReceipt(session, existing), changed: false };
          }
          await requireLocalEventId(session, owned.eventId);
          const current = await state(session);
          if (current.historyEpoch !== owned.expectedHistoryEpoch)
            fault('history_changed', 'stale_context');
          const content = await checkIdentity(
            owned.recipeId,
            owned.contentFingerprint,
            owned.readerVersion,
          );
          const recipe = options.readRecipe(owned.recipeId)!;
          const recordedAt = now();
          let closedSession: CookingSession | null = null;
          if (owned.session) {
            const row = await sessionRow(session, owned.recipeId);
            if (
              !row ||
              row.state !== 'active' ||
              row.sessionId !== owned.session.sessionId ||
              row.revision !== owned.session.expectedRevision ||
              parseSession(row).contentFingerprint !== content.contentFingerprint
            )
              fault('session_changed', 'stale_context');
            closedSession = {
              ...parseSession(row),
              state: 'completed',
              revision: next(current.sessionRevision),
              updatedAt: recordedAt,
              lastOperationId: owned.eventId,
            };
            await writeSession(session, closedSession, fingerprint);
          }
          const event: CookingHistoryEntry = {
            ...content,
            eventId: owned.eventId,
            recipeTitle: recipe.title,
            photoKey: recipe.photoKey,
            cookedOn: owned.cookedOn,
            timeZone: owned.timeZone,
            recordedAt,
            note,
            historyEpoch: current.historyEpoch,
            revision: next(current.historyRevision),
          };
          const value: CookedReceipt = { kind: 'saved', event, closedSession };
          await runBound(session, "INSERT INTO cooking_event VALUES (?,?,'saved',?,?,?,?)", [
            owned.eventId,
            current.historyEpoch,
            owned.cookedOn,
            recordedAt,
            fingerprint,
            JSON.stringify(value),
          ]);
          await runBound(session, 'UPDATE cooking_state SET history_revision=? WHERE singleton=1', [
            event.revision,
          ]);
          return { value, changed: true };
        },
        proof,
      );
    } catch (error) {
      return failed(error);
    }
  };
  const reviewClearHistory: CookingService['reviewClearHistory'] = () =>
    read(async (session) => {
      const current = await state(session);
      const history = await historyClearSnapshot(session, current.historyEpoch);
      const count = history
        ? history.eventIds.length
        : await historyCount(session, current.historyEpoch);
      stored(isRevision(count));
      const review = freezeResult({
        reviewId: options.platform.newId(),
        expectedHistoryRevision: current.historyRevision,
        historyEpoch: current.historyEpoch,
        count,
      });
      stored(isAppId(review.reviewId));
      reviews.set(review, { review, history: freezeResult(history) });
      return review;
    });
  const clearHistory: CookingService['clearHistory'] = async (review, operationId) => {
    try {
      if (!isAppId(operationId)) fault('invalid_operation');
      // Issued reviews authorize new clears only. Durable receipts authorize recovery after reopen.
      const proof = async (session: SqlSession) => clearReceipt(session, operationId);
      return mutate(
        operationId,
        null,
        true,
        async (session) => {
          const previous = await proof(session);
          if (previous) return { value: previous, changed: false };
          const issued = reviews.get(review);
          if (!issued) fault('clear_review_required', 'stale_context');
          const current = await state(session);
          const history = await historyClearSnapshot(session, current.historyEpoch);
          const count = history
            ? history.eventIds.length
            : await historyCount(session, current.historyEpoch);
          if (
            current.historyRevision !== issued.review.expectedHistoryRevision ||
            current.historyEpoch !== issued.review.historyEpoch ||
            count !== issued.review.count ||
            JSON.stringify(history) !== JSON.stringify(issued.history)
          )
            fault('history_changed', 'stale_context');
          const value: ClearCookingHistoryReceipt = {
            operationId,
            outcome: 'cleared',
            clearedCount: issued.review.count,
            previousHistoryEpoch: current.historyEpoch,
            historyEpoch: next(current.historyEpoch),
            historyRevision: next(current.historyRevision),
            committedAt: now(),
          };
          // An explicit clear also redacts older local receipts hidden by a restore. Retained
          // portable archives have their own disclosed lifetime and are not deleted here.
          if (history) await withdrawClearedHistory(session, history);
          await session.exec(
            "UPDATE cooking_event SET state='cleared',cooked_on=NULL,recorded_at=NULL,request_fingerprint=NULL,receipt_json=NULL WHERE state='saved'",
          );
          const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
            ?.user_version;
          if (version === 5 || version === 6)
            await session.exec('DELETE FROM imported_cooking_history');
          await runBound(
            session,
            'UPDATE cooking_state SET history_epoch=?,history_revision=? WHERE singleton=1',
            [value.historyEpoch, value.historyRevision],
          );
          await runBound(session, 'INSERT INTO cooking_history_clear VALUES (?,?)', [
            operationId,
            JSON.stringify(value),
          ]);
          return { value, changed: true };
        },
        proof,
      );
    } catch (error) {
      return failed(error);
    }
  };
  const resolveCookedOperation: CookingService['resolveCookedOperation'] = async (eventId) => {
    try {
      if (!isAppId(eventId)) fault('invalid_operation');
      const proof = async (session: SqlSession) => {
        const row = await eventRow(session, eventId);
        return row ? visibleEventReceipt(session, row) : null;
      };
      return mutate<CookedReceipt>(
        eventId,
        null,
        false,
        async (session) => {
          const existing = await proof(session);
          if (existing) return { value: existing, changed: false };
          await requireLocalEventId(session, eventId);
          const current = await state(session);
          const value: CookedReceipt = {
            kind: 'cancelled',
            eventId,
            historyEpoch: current.historyEpoch,
          };
          // BEGIN IMMEDIATE serializes this fence against every later same-ID dispatch.
          await runBound(
            session,
            "INSERT INTO cooking_event VALUES (?,?,'cancelled',NULL,NULL,NULL,NULL)",
            [eventId, current.historyEpoch],
          );
          return { value, changed: true };
        },
        proof,
      );
    } catch (error) {
      return failed(error);
    }
  };
  const resolveClearHistoryOperation: CookingService['resolveClearHistoryOperation'] = async (
    operationId,
  ) => {
    try {
      if (!isAppId(operationId)) fault('invalid_operation');
      const proof = (session: SqlSession) => clearReceipt(session, operationId);
      return mutate<ClearCookingHistoryReceipt>(
        operationId,
        null,
        false,
        async (session) => {
          const existing = await proof(session);
          if (existing) return { value: existing, changed: false };
          const current = await state(session);
          const value: ClearCookingHistoryReceipt = {
            operationId,
            outcome: 'cancelled',
            clearedCount: 0,
            previousHistoryEpoch: current.historyEpoch,
            historyEpoch: current.historyEpoch,
            historyRevision: current.historyRevision,
            committedAt: now(),
          };
          await runBound(session, 'INSERT INTO cooking_history_clear VALUES (?,?)', [
            operationId,
            JSON.stringify(value),
          ]);
          return { value, changed: true };
        },
        proof,
      );
    } catch (error) {
      return failed(error);
    }
  };
  const readHistory: CookingService['readHistory'] = (input) =>
    read(async (session) => {
      const current = await state(session);
      const limit = input?.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > COOKING_HISTORY_PAGE_LIMIT)
        fault('invalid_page');
      let cursor: { epoch: number; cookedOn: string; recordedAt: string; eventId: string } | null =
        null;
      if (input?.cursor !== undefined) {
        if (typeof input.cursor !== 'string' || input.cursor.length > 512) fault('invalid_cursor');
        let parsed: unknown;
        try {
          parsed = JSON.parse(input.cursor);
        } catch {
          fault('invalid_cursor');
        }
        if (
          !record(parsed) ||
          !exact(parsed, ['epoch', 'cookedOn', 'recordedAt', 'eventId']) ||
          !isRevision(parsed.epoch) ||
          typeof parsed.cookedOn !== 'string' ||
          !isActualLocalDate(parsed.cookedOn) ||
          typeof parsed.recordedAt !== 'string' ||
          !isUtcInstant(parsed.recordedAt) ||
          !isAppId(parsed.eventId)
        )
          fault('invalid_cursor');
        cursor = {
          epoch: parsed.epoch,
          cookedOn: parsed.cookedOn,
          recordedAt: parsed.recordedAt,
          eventId: parsed.eventId,
        };
        if (cursor.epoch !== current.historyEpoch) fault('history_changed', 'stale_context');
      }
      const rows = await historyRows(session, current.historyEpoch, limit + 1, cursor ?? undefined);
      const items = rows.slice(0, limit).map((row) => {
        const event = historyEntry(row);
        stored(
          event.historyEpoch === current.historyEpoch && event.revision <= current.historyRevision,
        );
        return event;
      });
      const last = items.at(-1);
      return {
        items,
        historyRevision: current.historyRevision,
        historyEpoch: current.historyEpoch,
        nextCursor:
          rows.length > limit && last
            ? JSON.stringify({
                epoch: current.historyEpoch,
                cookedOn: last.cookedOn,
                recordedAt: last.recordedAt,
                eventId: last.eventId,
              })
            : null,
      };
    });
  return {
    readResumeSession: () =>
      read(async (session) => {
        const row = (
          await session.all<SessionRow>(
            `SELECT ${sessionColumns} FROM cooking_session WHERE state='active' ORDER BY updated_at DESC,revision DESC,recipe_id LIMIT 1`,
          )
        )[0];
        if (row) stored(row.revision <= (await state(session)).sessionRevision);
        return row ? view(row.recipeId, row) : null;
      }),
    readSession: (recipeId) =>
      read(async (session) => view(recipeId, await sessionRow(session, recipeId))),
    saveSession,
    dismissSession,
    readHistory,
    saveCooked,
    resolveCookedOperation,
    reviewClearHistory,
    clearHistory,
    resolveClearHistoryOperation,
    readCookedReceipt: (eventId) =>
      read(async (session) => {
        if (!isAppId(eventId)) fault('invalid_operation');
        const row = await eventRow(session, eventId);
        return row ? visibleEventReceipt(session, row) : null;
      }),
    readClearHistoryReceipt: (operationId) =>
      read(async (session) => {
        if (!isAppId(operationId)) fault('invalid_operation');
        return clearReceipt(session, operationId);
      }),
    notifyRestored: (revision) => publish({ recipeId: null, historyChanged: true, revision }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      listeners.clear();
    },
  };
}
