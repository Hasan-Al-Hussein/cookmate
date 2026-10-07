import {
  canonicalContentJson,
  validateOverlayHead,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import { isUtcInstant, type ContractError } from '@cookmate/contracts';
import type {
  ClearCookingHistoryReceipt,
  ClearCookingHistoryReview,
  CookingChange,
  CookingMutationResult,
  Immutable,
  RepositoryResult,
} from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import { isAppId, isRevision } from './conversationRecords';
import {
  admitLocalCookingEvents,
  readAdoptionInSnapshot,
  requireCookingContentReadVersion,
  verifyHistoryContentBindings,
} from './cookingContentRepository';
import {
  historyClearSnapshot,
  withdrawClearedHistory,
  type HistoryClearSnapshot,
} from './cookingHistoryRows';
import { freezeResult, readRevision } from './query';
import { readRestoreEpoch } from './restoreEpoch';
import { runBound, type SerializedReader, type SerializedWriter, type SqlSession } from './sql';

interface Options {
  reader: SerializedReader;
  writer: SerializedWriter;
  installationId: string;
  sha256(text: string): Promise<string>;
  now(): string;
  newId(): string;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
  onCommitted(change: CookingChange): void;
}
interface Authority extends ContentAdoptionAccess {
  installationId: string;
  restoreEpoch: number;
  adoptionRevision: number;
  head: OverlayHead | null;
}
interface State {
  historyRevision: number;
  historyEpoch: number;
}
interface Capture {
  authority: Authority;
  state: State;
  storeRevision: number;
  history: HistoryClearSnapshot;
}
interface StoredReceipt {
  formatVersion: 2;
  authority: Authority;
  review: ClearCookingHistoryReview | null;
  receipt: ClearCookingHistoryReceipt;
  storeRevision: number;
}
const LIMITS = Object.freeze({
  receiptBytes: 4096,
  operations: 20_000,
  ledgerBytes: 64 * 1024 * 1024,
  identitiesBytes: 1024 * 1024,
  history: 10_000,
});
const schemaOptions = Object.freeze({ contentSchema: true as const });
const uuidGlob = `${'[0-9a-f]'.repeat(8)}-${'[0-9a-f]'.repeat(4)}-4${'[0-9a-f]'.repeat(3)}-[89ab]${'[0-9a-f]'.repeat(3)}-${'[0-9a-f]'.repeat(12)}`;
const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left, LIMITS.identitiesBytes) ===
  canonicalContentJson(right, LIMITS.identitiesBytes);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
class ClearFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function reject(message: string, code: ContractError['code'] = 'stale_context'): never {
  throw new ClearFault({ code, messageKey: `content.clear_${message}`, retry: 'after_correction' });
}
function stored(condition: unknown): asserts condition {
  if (!condition) reject('stored_evidence_invalid', 'storage_failure');
}
const errorDetail = (error: unknown): ContractError =>
  error instanceof ClearFault
    ? error.detail
    : {
        code: 'storage_failure',
        messageKey: 'content.clear_storage_failed',
        retry: 'after_correction',
      };
function next(value: number) {
  stored(isRevision(value) && Number.isSafeInteger(value + 1));
  return value + 1;
}
function validReview(value: unknown): value is ClearCookingHistoryReview {
  return (
    exact(value, ['reviewId', 'expectedHistoryRevision', 'historyEpoch', 'count']) &&
    isAppId(value.reviewId) &&
    isRevision(value.expectedHistoryRevision) &&
    isRevision(value.historyEpoch) &&
    isRevision(value.count) &&
    value.count <= LIMITS.history
  );
}
function validAuthority(value: unknown): value is unknown & Authority {
  return (
    exact(value, [
      'installationId',
      'ownerId',
      'authGeneration',
      'restoreEpoch',
      'adoptionRevision',
      'head',
    ]) &&
    isAppId(value.installationId) &&
    (value.ownerId === null || isAppId(value.ownerId)) &&
    isRevision(value.authGeneration) &&
    isRevision(value.restoreEpoch) &&
    isRevision(value.adoptionRevision) &&
    (value.head === null
      ? value.adoptionRevision === 0
      : validateOverlayHead(value.head) && value.adoptionRevision > 0)
  );
}

/** Private schema7/8 privacy clear. Review is local integrity evidence, never content-body authority. */
export function createContentCookingHistoryClear(options: Options) {
  if (!isAppId(options.installationId)) reject('invalid_installation', 'invalid_input');
  const access = options.getAccess();
  if (
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !isRevision(access.authGeneration)
  )
    reject('access_changed');
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  const reviews = new WeakMap<object, Immutable<Capture>>();
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
      reject('access_changed');
    return undefined;
  }
  const sha256 = async (text: string) => {
    check();
    const result = await options.sha256(text);
    check();
    stored(typeof result === 'string' && /^[0-9a-f]{64}$/.test(result));
    return result;
  };
  async function owner(session: SqlSession) {
    check();
    await requireCookingContentReadVersion(session);
    const [row] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (row?.id !== options.installationId || (await readBinding(session)) !== scope.ownerId)
      reject('access_changed');
    check();
  }
  async function authority(session: SqlSession): Promise<Authority> {
    await owner(session);
    const adoption = await readAdoptionInSnapshot(session),
      restoreEpoch = await readRestoreEpoch(session);
    const value = {
      ...scope,
      installationId: options.installationId,
      restoreEpoch,
      adoptionRevision: adoption.revision,
      head: adoption.head,
    };
    stored(validAuthority(value));
    check();
    return value;
  }
  async function state(session: SqlSession): Promise<State> {
    const [value] = await session.all<State>(
      'SELECT history_revision historyRevision,history_epoch historyEpoch FROM cooking_state WHERE singleton=1',
    );
    stored(value && isRevision(value.historyRevision) && isRevision(value.historyEpoch));
    return value;
  }
  async function admitLedger(session: SqlSession) {
    const [usage] = await session.all<{ count: number; bytes: number }>(
      'SELECT COUNT(*) count,COALESCE(SUM(length(CAST(receipt_json AS BLOB))),0) bytes FROM cooking_history_clear',
    );
    stored(
      usage &&
        isRevision(usage.count) &&
        isRevision(usage.bytes) &&
        usage.count <= LIMITS.operations &&
        usage.bytes <= LIMITS.ledgerBytes,
    );
    stored(
      (
        await session.all(
          `SELECT 1 FROM cooking_history_clear WHERE typeof(operation_id)<>'text' OR length(CAST(operation_id AS BLOB))<>36 OR operation_id NOT GLOB ? OR typeof(receipt_json)<>'text' OR length(CAST(receipt_json AS BLOB))>4096 OR NOT json_valid(receipt_json) LIMIT 1`,
          [uuidGlob],
        )
      ).length === 0,
    );
    return usage;
  }
  async function receipt(
    session: SqlSession,
    operationId: string,
  ): Promise<ClearCookingHistoryReceipt | null> {
    await owner(session);
    await admitLedger(session);
    const [row] = await session.all<{ receipt: string }>(
      'SELECT receipt_json receipt FROM cooking_history_clear WHERE operation_id=?',
      [operationId],
    );
    if (!row) return null;
    const value: unknown = JSON.parse(row.receipt);
    // A legacy clear receipt has no account authority and is never upgraded on retry.
    if (
      exact(value, [
        'operationId',
        'outcome',
        'clearedCount',
        'previousHistoryEpoch',
        'historyEpoch',
        'historyRevision',
        'committedAt',
      ])
    )
      reject('operation_conflict', 'operation_conflict');
    stored(
      exact(value, ['formatVersion', 'authority', 'review', 'receipt', 'storeRevision']) &&
        value.formatVersion === 2 &&
        validAuthority(value.authority) &&
        isRevision(value.storeRevision),
    );
    if (
      value.authority.ownerId !== scope.ownerId ||
      value.authority.installationId !== options.installationId
    )
      reject('access_changed');
    const proof = value.receipt;
    stored(
      exact(proof, [
        'operationId',
        'outcome',
        'clearedCount',
        'previousHistoryEpoch',
        'historyEpoch',
        'historyRevision',
        'committedAt',
      ]) &&
        proof.operationId === operationId &&
        isRevision(proof.clearedCount) &&
        proof.clearedCount <= LIMITS.history &&
        isRevision(proof.previousHistoryEpoch) &&
        isRevision(proof.historyEpoch) &&
        isRevision(proof.historyRevision) &&
        typeof proof.committedAt === 'string' &&
        isUtcInstant(proof.committedAt),
    );
    if (proof.outcome === 'cleared') {
      stored(
        validReview(value.review) &&
          proof.clearedCount === value.review.count &&
          proof.previousHistoryEpoch === value.review.historyEpoch &&
          proof.historyEpoch === next(value.review.historyEpoch) &&
          proof.historyRevision === next(value.review.expectedHistoryRevision),
      );
    } else
      stored(
        proof.outcome === 'cancelled' &&
          value.review === null &&
          proof.clearedCount === 0 &&
          proof.historyEpoch === proof.previousHistoryEpoch,
      );
    const current = await state(session);
    stored(
      proof.historyEpoch <= current.historyEpoch &&
        proof.historyRevision <= current.historyRevision &&
        value.storeRevision <= (await readRevision(session, 'store')) &&
        canonicalContentJson(value, LIMITS.receiptBytes) === row.receipt,
    );
    check();
    return freezeResult(proof as unknown as ClearCookingHistoryReceipt);
  }
  async function recover(
    operationId: string,
  ): Promise<RepositoryResult<Immutable<ClearCookingHistoryReceipt> | null>> {
    try {
      check();
      if (!isAppId(operationId)) reject('invalid_operation', 'invalid_input');
      const result = await options.reader.transaction(
        async (session) => ({
          kind: 'ready' as const,
          value: await receipt(session, operationId),
          revision: await readRevision(session, 'store'),
        }),
        { kind: 'read_only' },
      );
      check();
      return result;
    } catch (error) {
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  async function capture(session: SqlSession): Promise<Capture> {
    const capturedAuthority = await authority(session),
      current = await state(session);
    await verifyHistoryContentBindings(session, sha256);
    const history = await historyClearSnapshot(session, current.historyEpoch, schemaOptions);
    stored(history && history.ownerId === scope.ownerId);
    check();
    return {
      authority: capturedAuthority,
      state: current,
      storeRevision: await readRevision(session, 'store'),
      history,
    };
  }
  async function reviewClearHistory(): Promise<
    RepositoryResult<Immutable<ClearCookingHistoryReview>>
  > {
    try {
      check();
      const captured = freezeResult(
        await options.reader.transaction(capture, { kind: 'read_only' }),
      );
      check();
      const review = freezeResult({
        reviewId: options.newId(),
        expectedHistoryRevision: captured.state.historyRevision,
        historyEpoch: captured.state.historyEpoch,
        count: captured.history.eventIds.length,
      });
      stored(validReview(review));
      reviews.set(review, captured);
      return { kind: 'ready', value: review, revision: captured.storeRevision };
    } catch (error) {
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  async function mutate(
    operationId: string,
    review: Immutable<ClearCookingHistoryReview> | null,
    cancel: boolean,
  ): Promise<CookingMutationResult<ClearCookingHistoryReceipt>> {
    let dispatched = false,
      changed = false,
      notified = false;
    function notify(value: Immutable<ClearCookingHistoryReceipt>, revision: number) {
      if (notified) return;
      notified = true;
      try {
        options.onCommitted({
          recipeId: null,
          historyChanged: value.outcome === 'cleared',
          revision,
        });
      } catch {
        /* Durable proof is independent of observers. */
      }
    }
    try {
      check();
      if (!isAppId(operationId)) reject('invalid_operation', 'invalid_input');
      const previous = await recover(operationId);
      if (previous.kind === 'failed') throw new ClearFault(previous.error);
      if (previous.value) return { ...previous, value: previous.value };
      const issued = review && reviews.get(review);
      if (!cancel && !issued) reject('review_required');
      const before =
        issued?.authority ?? (await options.reader.transaction(authority, { kind: 'read_only' }));
      check();
      dispatched = true;
      const result = await options.writer.transaction(
        async (session) => {
          const existing = await receipt(session, operationId);
          if (existing)
            return {
              kind: 'ready' as const,
              value: existing,
              revision: await readRevision(session, 'store'),
            };
          if (!same(await authority(session), before)) reject('workspace_changed');
          const current = await state(session);
          if (issued) {
            const actual = await capture(session);
            if (!same(actual, issued)) reject('history_changed');
          }
          const committedAt = options.now();
          stored(isUtcInstant(committedAt));
          const value: ClearCookingHistoryReceipt = {
            operationId,
            outcome: issued ? 'cleared' : 'cancelled',
            clearedCount: review?.count ?? 0,
            previousHistoryEpoch: current.historyEpoch,
            historyEpoch: issued ? next(current.historyEpoch) : current.historyEpoch,
            historyRevision: issued ? next(current.historyRevision) : current.historyRevision,
            committedAt,
          };
          const revision = next(await readRevision(session, 'store'));
          const wrapper: StoredReceipt = {
            formatVersion: 2,
            authority: { ...before },
            review: review ? { ...review } : null,
            receipt: value,
            storeRevision: revision,
          };
          const json = canonicalContentJson(wrapper, LIMITS.receiptBytes),
            usage = await admitLedger(session);
          if (
            usage.count >= LIMITS.operations ||
            usage.bytes + new TextEncoder().encode(json).byteLength > LIMITS.ledgerBytes
          )
            reject('operation_limit', 'unsupported_request');
          if (issued) {
            // Preserve all known IDs, including old epochs and backup lineage, before redaction.
            await withdrawClearedHistory(
              session,
              {
                ownerId: issued.history.ownerId,
                eventIds: [...issued.history.eventIds],
                withdrawalIds: [...issued.history.withdrawalIds],
              },
              schemaOptions,
            );
            await session.exec('DELETE FROM local_history_content_pin');
            await session.exec(
              "UPDATE cooking_event SET state='cleared',cooked_on=NULL,recorded_at=NULL,request_fingerprint=NULL,receipt_json=NULL WHERE state='saved'",
            );
            await session.exec('DELETE FROM imported_cooking_history');
            await runBound(
              session,
              'UPDATE cooking_state SET history_epoch=?,history_revision=? WHERE singleton=1',
              [value.historyEpoch, value.historyRevision],
            );
            await admitLocalCookingEvents(session);
          }
          await runBound(session, 'INSERT INTO cooking_history_clear VALUES (?,?)', [
            operationId,
            json,
          ]);
          await runBound(session, "UPDATE state_revision SET revision=? WHERE collection='store'", [
            revision,
          ]);
          check();
          changed = true;
          return { kind: 'ready' as const, value: freezeResult(value), revision };
        },
        { kind: 'none' },
        check,
      );
      check();
      if (changed) notify(result.value, result.revision);
      check();
      return result;
    } catch (error) {
      if (dispatched) {
        const recovered = await recover(operationId);
        if (recovered.kind === 'ready' && recovered.value) {
          if (changed) notify(recovered.value, recovered.revision);
          try {
            check();
          } catch (accessError) {
            return { kind: 'uncertain', operationId, error: errorDetail(accessError) };
          }
          return { ...recovered, value: recovered.value };
        }
        if (recovered.kind === 'failed' || options.writer.requiresRecovery())
          return { kind: 'uncertain', operationId, error: errorDetail(error) };
      }
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  return Object.freeze({
    reviewClearHistory,
    clearHistory: (review: Immutable<ClearCookingHistoryReview>, operationId: string) =>
      mutate(operationId, review, false),
    readClearHistoryReceipt: recover,
    resolveClearHistoryOperation: (operationId: string) => mutate(operationId, null, true),
    close() {
      closed = true;
    },
  });
}
