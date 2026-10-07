import {
  canonicalContentJson,
  createBundledRecipeRevision,
  validateOverlayHead,
  validateRecipeContentRef,
  type OverlayHead,
  type RecipeContentRef,
  type RecipeContentRevision,
} from '@cookmate/catalogue/content';
import {
  isActualLocalDate,
  isUtcInstant,
  type ContractError,
  type DateContext,
} from '@cookmate/contracts';
import type {
  CookingChange,
  CookingMutationResult,
  Immutable,
  RepositoryResult,
} from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import type { ContentReadingView, openContentReleaseStore } from './contentReleaseStore';
import {
  CONTENT_COOKED_RECOVERY_MAX_BYTES,
  matchesContentCookingHistoryRevision,
  validateContentCookedReceipt,
  validateContentCookedRecoveryReference,
  validateSaveContentCookedInput,
  type ContentCookedReceipt,
  type ContentCookedRecoveryReference,
  type SaveContentCookedInput,
} from './contentCookingHistoryRecords';
import { validateContentCookingSession, type ContentCookingSession } from './contentCookingRecords';
import { isAppId, isRevision } from './conversationRecords';
import {
  admitCookingClocks,
  admitCookingSessionRows,
  admitCookingWorkspaceClocks,
  admitLocalCookingEvents,
  readAdoptionInSnapshot,
  readStoredCookingSession,
  readStoredLocalCookingEvent,
  retainCookingRevisionInSnapshot,
} from './cookingContentRepository';
import { hasAccountCookingEventId } from './cookingHistoryRows';
import { freezeResult, readRevision } from './query';
import { readRestoreEpoch } from './restoreEpoch';
import { runBound, type SerializedReader, type SerializedWriter, type SqlSession } from './sql';

interface Options {
  /** Explicit private schema 8 opt-in; existing callers remain schema 7 only. */
  cookingSchemaVersion?: 7 | 8;
  reader: SerializedReader;
  writer: SerializedWriter;
  contentStore: Pick<Awaited<ReturnType<typeof openContentReleaseStore>>, 'withVerifiedReading'>;
  installationId: string;
  sha256(text: string): Promise<string>;
  now(): string;
  dateContext(): DateContext;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
  onCommitted(change: CookingChange): void;
}
interface Workspace extends ContentAdoptionAccess {
  installationId: string;
  restoreEpoch: number;
  adoptionRevision: number;
  head: OverlayHead | null;
}
interface Authority extends Workspace {
  formatVersion: 1;
  contentRef: RecipeContentRef;
  expectedHistoryEpoch: number;
  session: { sessionId: string; expectedRevision: number } | null;
}
interface State {
  historyRevision: number;
  historyEpoch: number;
  sessionRevision: number;
}
const LIMITS = Object.freeze({
  authorityBytes: 4096,
  receiptBytes: 32768,
  operations: 20_000,
  authorityTotalBytes: 64 * 1024 * 1024,
});
const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left, LIMITS.receiptBytes) ===
  canonicalContentJson(right, LIMITS.receiptBytes);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
class HistoryFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function reject(message: string, code: ContractError['code'] = 'stale_context'): never {
  throw new HistoryFault({
    code,
    messageKey: `content.cooked_${message}`,
    retry: 'after_correction',
  });
}
function stored(condition: unknown): asserts condition {
  if (!condition) reject('stored_evidence_invalid', 'storage_failure');
}
const errorDetail = (error: unknown): ContractError =>
  error instanceof HistoryFault
    ? error.detail
    : {
        code: 'storage_failure',
        messageKey: 'content.cooked_storage_failed',
        retry: 'after_correction',
      };
function next(value: number) {
  stored(isRevision(value) && Number.isSafeInteger(value + 1));
  return value + 1;
}
function ownInput(input: unknown): SaveContentCookedInput {
  if (!validateSaveContentCookedInput(input)) reject('invalid_request', 'invalid_input');
  return freezeResult(
    JSON.parse(canonicalContentJson(input, LIMITS.receiptBytes)) as SaveContentCookedInput,
  );
}
function ownReference(input: unknown): ContentCookedRecoveryReference {
  if (!validateContentCookedRecoveryReference(input)) reject('invalid_request', 'invalid_input');
  return freezeResult(
    JSON.parse(
      canonicalContentJson(input, CONTENT_COOKED_RECOVERY_MAX_BYTES),
    ) as ContentCookedRecoveryReference,
  );
}
type RecoveryInput = SaveContentCookedInput | ContentCookedRecoveryReference;

/** Private schema-7 cooked-action host with explicit schema-8 opt-in. No sync or UI activation. */
export function createContentCookingHistory(options: Options) {
  const cookingSchemaVersion = options.cookingSchemaVersion ?? 7;
  if (cookingSchemaVersion !== 7 && cookingSchemaVersion !== 8)
    reject('invalid_schema', 'invalid_input');
  if (!isAppId(options.installationId)) reject('invalid_installation', 'invalid_input');
  const access = options.getAccess();
  if (
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !isRevision(access.authGeneration)
  )
    reject('access_changed');
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
      reject('access_changed');
    return undefined;
  }
  const sha256 = async (text: string) => {
    check();
    const result = await options.sha256(text);
    check();
    stored(hash(result));
    return result;
  };
  async function owner(session: SqlSession) {
    check();
    stored(
      (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version ===
        cookingSchemaVersion,
    );
    const [row] = await session.all<{ id: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END id FROM app_metadata WHERE key='installation_id'",
    );
    if (row?.id !== options.installationId || (await readBinding(session)) !== scope.ownerId)
      reject('access_changed');
    await admitCookingClocks(session);
    check();
  }
  async function workspace(session: SqlSession): Promise<Workspace> {
    await owner(session);
    await admitCookingWorkspaceClocks(session);
    const adoption = await readAdoptionInSnapshot(session),
      restoreEpoch = await readRestoreEpoch(session);
    check();
    return {
      ...scope,
      installationId: options.installationId,
      restoreEpoch,
      adoptionRevision: adoption.revision,
      head: adoption.head,
    };
  }
  async function state(session: SqlSession): Promise<State> {
    const [value] = await session.all<State>(
      'SELECT history_revision historyRevision,history_epoch historyEpoch,session_revision sessionRevision FROM cooking_state WHERE singleton=1',
    );
    stored(value && Object.values(value).every(isRevision));
    return value;
  }
  async function admitAuthorities(session: SqlSession) {
    const [usage] = await session.all<{ count: number; bytes: number }>(
      'SELECT COUNT(*) count,COALESCE(SUM(length(CAST(authority_json AS BLOB))),0) bytes FROM content_cooking_event_authority',
    );
    stored(
      usage &&
        isRevision(usage.count) &&
        isRevision(usage.bytes) &&
        usage.count <= LIMITS.operations &&
        usage.bytes <= LIMITS.authorityTotalBytes,
    );
    stored(
      (
        await session.all(`SELECT 1 FROM content_cooking_event_authority WHERE typeof(event_id)<>'text' OR length(CAST(event_id AS BLOB))<>36 OR
      typeof(request_fingerprint)<>'text' OR length(CAST(request_fingerprint AS BLOB))<>64 OR
      typeof(authority_json)<>'text' OR length(CAST(authority_json AS BLOB))>4096 OR NOT json_valid(authority_json) LIMIT 1`)
      ).length === 0,
    );
    return usage;
  }
  function parseAuthority(text: string, input: RecoveryInput): Authority {
    const value: unknown = JSON.parse(text);
    stored(
      exact(value, [
        'formatVersion',
        'installationId',
        'ownerId',
        'authGeneration',
        'restoreEpoch',
        'adoptionRevision',
        'head',
        'contentRef',
        'expectedHistoryEpoch',
        'session',
      ]) &&
        value.formatVersion === 1 &&
        isAppId(value.installationId) &&
        (value.ownerId === null || isAppId(value.ownerId)) &&
        isRevision(value.authGeneration) &&
        isRevision(value.restoreEpoch) &&
        isRevision(value.adoptionRevision) &&
        (value.head === null
          ? value.adoptionRevision === 0
          : validateOverlayHead(value.head) && value.adoptionRevision > 0) &&
        validateRecipeContentRef(value.contentRef) &&
        same(value.contentRef, input.contentRef) &&
        value.expectedHistoryEpoch === input.expectedHistoryEpoch &&
        same(value.session, input.session ?? null) &&
        canonicalContentJson(value, LIMITS.authorityBytes) === text,
    );
    if (value.installationId !== options.installationId || value.ownerId !== scope.ownerId)
      reject('access_changed');
    return value as unknown as Authority;
  }
  async function proof(
    session: SqlSession,
    input: RecoveryInput,
    fingerprint: string,
  ): Promise<ContentCookedReceipt | null> {
    await owner(session);
    await admitAuthorities(session);
    const [row] = await session.all<{ fingerprint: string; authority: string }>(
      'SELECT request_fingerprint fingerprint,authority_json authority FROM content_cooking_event_authority WHERE event_id=?',
      [input.eventId],
    );
    if (!row) {
      // Existing v1/data-only events cannot acquire action authority through a v2 retry.
      if (
        (await session.all('SELECT 1 FROM cooking_event WHERE event_id=? LIMIT 1', [input.eventId]))
          .length
      )
        reject('operation_conflict', 'operation_conflict');
      await requireLocalId(session, input.eventId);
      return null;
    }
    if (row.fingerprint !== fingerprint) reject('operation_conflict', 'operation_conflict');
    parseAuthority(row.authority, input);
    const local = await readStoredLocalCookingEvent(session, input.eventId, { sha256 });
    stored(local && validateContentCookedReceipt(local.receipt));
    const receipt = local.receipt;
    const current = await state(session);
    if (receipt.kind === 'saved') {
      stored(
        local.requestFingerprint === fingerprint &&
          receipt.event.readerVersion === 2 &&
          same(receipt.event.contentRef, input.contentRef) &&
          receipt.event.eventId === input.eventId &&
          receipt.event.historyEpoch === input.expectedHistoryEpoch &&
          receipt.event.revision <= current.historyRevision &&
          receipt.event.historyEpoch <= current.historyEpoch &&
          (input.session
            ? receipt.closedSession !== null &&
              receipt.closedSession.sessionId === input.session.sessionId &&
              receipt.closedSession.revision > input.session.expectedRevision &&
              receipt.closedSession.revision <= current.sessionRevision
            : receipt.closedSession === null),
      );
      if ('cookedOn' in input) {
        stored(
          receipt.event.cookedOn === input.cookedOn &&
            receipt.event.timeZone === input.timeZone &&
            receipt.event.note === (input.note ?? null),
        );
      } else {
        // Only authoritative receipt fields reconstruct private request data. It is never
        // retained in recovery metadata or copied into the body-free authority journal.
        const original: SaveContentCookedInput = {
          eventId: input.eventId,
          contentRef: input.contentRef,
          expectedHistoryEpoch: input.expectedHistoryEpoch,
          cookedOn: receipt.event.cookedOn,
          timeZone: receipt.event.timeZone,
          ...(input.session ? { session: input.session } : {}),
          note: receipt.event.note,
        };
        let matches = (await digest(original)) === fingerprint;
        // Existing inputs distinguish an omitted note from an explicit null.
        if (!matches && original.note === null) {
          delete original.note;
          matches = (await digest(original)) === fingerprint;
        }
        stored(matches);
      }
      if (receipt.event.historyEpoch < current.historyEpoch)
        return freezeResult({
          kind: 'cleared',
          eventId: input.eventId,
          historyEpoch: receipt.event.historyEpoch,
        });
    } else
      stored(
        receipt.eventId === input.eventId &&
          receipt.historyEpoch <= current.historyEpoch &&
          (receipt.kind !== 'cleared' || receipt.historyEpoch === input.expectedHistoryEpoch),
      );
    check();
    return freezeResult(receipt);
  }
  async function digest(input: SaveContentCookedInput) {
    return sha256(canonicalContentJson(['cookmate-content-cooked-v1', input], LIMITS.receiptBytes));
  }
  async function recoverOwned(
    input: RecoveryInput,
    fingerprint: string,
  ): Promise<RepositoryResult<Immutable<ContentCookedReceipt> | null>> {
    try {
      const result = await options.reader.transaction(
        async (session) => ({
          kind: 'ready' as const,
          value: await proof(session, input, fingerprint),
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
  async function recover(
    input: Immutable<SaveContentCookedInput>,
  ): Promise<RepositoryResult<Immutable<ContentCookedReceipt> | null>> {
    try {
      check();
      const owned = ownInput(input);
      return await recoverOwned(owned, await digest(owned));
    } catch (error) {
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  async function prepareCookedRecovery(
    input: Immutable<SaveContentCookedInput>,
  ): Promise<RepositoryResult<Immutable<ContentCookedRecoveryReference>>> {
    try {
      check();
      const owned = ownInput(input),
        requestFingerprint = await digest(owned);
      const result = await options.reader.transaction(
        async (session) => {
          await owner(session);
          return {
            kind: 'ready' as const,
            value: ownReference({
              formatVersion: 1,
              eventId: owned.eventId,
              requestFingerprint,
              contentRef: owned.contentRef,
              expectedHistoryEpoch: owned.expectedHistoryEpoch,
              session: owned.session ?? null,
            }),
            revision: await readRevision(session, 'store'),
          };
        },
        { kind: 'read_only' },
      );
      check();
      return result;
    } catch (error) {
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  async function readCookedRecovery(
    input: Immutable<ContentCookedRecoveryReference>,
  ): Promise<RepositoryResult<Immutable<ContentCookedReceipt> | null>> {
    try {
      check();
      const owned = ownReference(input);
      return await recoverOwned(owned, owned.requestFingerprint);
    } catch (error) {
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  async function requireLocalId(session: SqlSession, eventId: string) {
    if (
      (
        await session.all(
          'SELECT 1 FROM imported_cooking_history WHERE event_id=? OR source_event_id=? LIMIT 1',
          [eventId, eventId],
        )
      ).length
    )
      reject('imported_id_conflict', 'operation_conflict');
    if (await hasAccountCookingEventId(session, eventId))
      reject('account_id_conflict', 'operation_conflict');
  }
  async function capture(input: RecoveryInput, includeSession: boolean) {
    const result = await options.reader.transaction(
      async (session) => ({
        workspace: await workspace(session),
        state: await state(session),
        saved:
          includeSession && input.session
            ? await readStoredCookingSession(session, input.contentRef.recipeId, { sha256 })
            : null,
      }),
      { kind: 'read_only' },
    );
    check();
    return result;
  }
  function requireSession(
    input: SaveContentCookedInput,
    saved: Awaited<ReturnType<typeof readStoredCookingSession>>,
  ) {
    if (!input.session) return;
    if (
      !saved ||
      saved.session.readerVersion !== 2 ||
      saved.session.state !== 'active' ||
      saved.session.sessionId !== input.session.sessionId ||
      saved.session.revision !== input.session.expectedRevision ||
      !same(saved.session.contentRef, input.contentRef)
    )
      reject('session_changed');
  }
  function requireDate(input: SaveContentCookedInput) {
    const date = options.dateContext();
    stored(isActualLocalDate(date.localDate));
    if (input.cookedOn > date.localDate) reject('future_date', 'invalid_input');
  }
  async function reserve<Value>(
    before: Workspace,
    input: SaveContentCookedInput,
    work: (verified: Immutable<RecipeContentRevision>, guard: () => undefined) => Promise<Value>,
  ): Promise<Value> {
    const result = await options.contentStore.withVerifiedReading(
      before.head,
      [input.contentRef],
      async (view: ContentReadingView) => {
        const guard = (): undefined => {
          check();
          stored(view.assertActive() === undefined);
          return undefined;
        };
        guard();
        stored(same(view.head, before.head));
        let verified: Immutable<RecipeContentRevision>;
        if (before.head) {
          stored(
            view.snapshot &&
              same(before.head, {
                releaseId: view.snapshot.envelope.manifest.releaseId,
                sequence: view.snapshot.envelope.manifest.sequence,
                fingerprint: view.snapshot.envelope.fingerprint,
              }),
          );
          const lookup = input.session
            ? view.snapshot.lookupExact(input.contentRef)
            : view.snapshot.lookupCurrent(input.contentRef.recipeId);
          if (
            lookup.kind !== 'readable' ||
            (!input.session && lookup.state !== 'current') ||
            !same(lookup.value.revision.ref, input.contentRef)
          )
            reject('content_unavailable');
          verified = lookup.value.revision;
        } else {
          stored(view.snapshot === null && !view.hasWithdrawal);
          verified = await createBundledRecipeRevision(input.contentRef.recipeId, sha256);
          guard();
          if (!same(verified.ref, input.contentRef)) reject('content_unavailable');
        }
        stored(matchesContentCookingHistoryRevision(input, verified));
        const value = await work(verified, guard);
        guard();
        return value;
      },
    );
    check();
    return result;
  }
  async function mutate(
    input: Immutable<RecoveryInput>,
    cancel: boolean,
    reference = false,
  ): Promise<CookingMutationResult<ContentCookedReceipt>> {
    let owned: RecoveryInput | undefined,
      fingerprint: string | undefined,
      dispatched = false,
      completed = false,
      notified = false;
    const notify = (value: ContentCookedReceipt, revision: number) => {
      if (notified) return;
      notified = true;
      try {
        options.onCommitted({
          recipeId: value.kind === 'saved' ? value.event.recipeId : null,
          historyChanged: value.kind === 'saved',
          revision,
        });
      } catch {
        /* Durable result is independent of observers. */
      }
    };
    try {
      check();
      owned = reference ? ownReference(input) : ownInput(input);
      fingerprint = 'requestFingerprint' in owned ? owned.requestFingerprint : await digest(owned);
      const request = owned,
        saveRequest = cancel ? null : ownInput(owned),
        requestFingerprint = fingerprint,
        prior = await recoverOwned(request, requestFingerprint);
      if (prior.kind === 'failed') throw new HistoryFault(prior.error);
      if (prior.value) return { ...prior, value: prior.value };
      const before = await capture(request, !cancel);
      if (saveRequest) {
        requireDate(saveRequest);
        requireSession(saveRequest, before.saved);
        if (before.state.historyEpoch !== request.expectedHistoryEpoch) reject('history_changed');
      }
      const write = async (
        verified: Immutable<RecipeContentRevision> | null,
        guard: () => undefined,
      ) => {
        guard();
        dispatched = true;
        const result = await options.writer.transaction(
          async (session) => {
            guard();
            const previous = await proof(session, request, requestFingerprint);
            if (previous)
              return {
                value: previous,
                revision: await readRevision(session, 'store'),
                changed: false,
              };
            if (!same(await workspace(session), before.workspace)) reject('workspace_changed');
            await requireLocalId(session, request.eventId);
            const current = await state(session),
              usage = await admitAuthorities(session);
            const authority: Authority = {
              ...before.workspace,
              formatVersion: 1,
              contentRef: { ...request.contentRef },
              expectedHistoryEpoch: request.expectedHistoryEpoch,
              session: request.session ? { ...request.session } : null,
            };
            const authorityJson = canonicalContentJson(authority, LIMITS.authorityBytes);
            if (
              usage.count >= LIMITS.operations ||
              usage.bytes + new TextEncoder().encode(authorityJson).byteLength >
                LIMITS.authorityTotalBytes
            )
              reject('authority_limit', 'unsupported_request');
            let value: ContentCookedReceipt;
            if (cancel) {
              value = {
                kind: 'cancelled',
                eventId: request.eventId,
                historyEpoch: current.historyEpoch,
              };
              await runBound(
                session,
                "INSERT INTO cooking_event VALUES (?,?,'cancelled',NULL,NULL,NULL,NULL)",
                [request.eventId, current.historyEpoch],
              );
            } else {
              stored(verified && saveRequest);
              requireDate(saveRequest);
              if (current.historyEpoch !== request.expectedHistoryEpoch) reject('history_changed');
              const saved = request.session
                ? await readStoredCookingSession(session, request.contentRef.recipeId, { sha256 })
                : null;
              requireSession(saveRequest, saved);
              if (!same(saved, before.saved)) reject('session_changed');
              const recordedAt = options.now();
              stored(isUtcInstant(recordedAt));
              let closedSession: ContentCookingSession | null = null;
              if (saved && request.session) {
                stored(
                  saved.session.readerVersion === 2 &&
                    saved.session.revision <= current.sessionRevision,
                );
                closedSession = {
                  ...saved.session,
                  state: 'completed',
                  revision: next(current.sessionRevision),
                  updatedAt: recordedAt,
                  lastOperationId: request.eventId,
                };
                stored(validateContentCookingSession(closedSession));
              }
              value = {
                kind: 'saved',
                event: {
                  readerVersion: 2,
                  recipeId: request.contentRef.recipeId,
                  contentRef: { ...request.contentRef },
                  eventId: request.eventId,
                  recipeTitle: verified.document.recipe.title,
                  photoAssetId:
                    verified.document.media.find(
                      (media) =>
                        media.recipeId === request.contentRef.recipeId &&
                        media.photoKey === verified.document.recipe.photoKey,
                    )?.assetId ?? null,
                  cookedOn: saveRequest.cookedOn,
                  timeZone: saveRequest.timeZone,
                  recordedAt,
                  note: saveRequest.note ?? null,
                  historyEpoch: current.historyEpoch,
                  revision: next(current.historyRevision),
                },
                closedSession,
              };
              stored(
                validateContentCookedReceipt(value) &&
                  matchesContentCookingHistoryRevision(value.event, verified),
              );
              const receiptJson = canonicalContentJson(value, LIMITS.receiptBytes);
              await retainCookingRevisionInSnapshot(session, verified, sha256);
              if (closedSession) {
                await runBound(
                  session,
                  'UPDATE cooking_session SET revision=?,state=?,updated_at=?,operation_id=?,request_fingerprint=?,session_json=? WHERE recipe_id=?',
                  [
                    closedSession.revision,
                    closedSession.state,
                    recordedAt,
                    request.eventId,
                    requestFingerprint,
                    canonicalContentJson(closedSession, 8192),
                    closedSession.recipeId,
                  ],
                );
                await runBound(
                  session,
                  'UPDATE cooking_state SET session_revision=? WHERE singleton=1',
                  [closedSession.revision],
                );
              }
              await runBound(session, "INSERT INTO cooking_event VALUES (?,?,'saved',?,?,?,?)", [
                request.eventId,
                current.historyEpoch,
                saveRequest.cookedOn,
                recordedAt,
                requestFingerprint,
                receiptJson,
              ]);
              await runBound(
                session,
                'INSERT INTO local_history_content_pin VALUES (?,?,?,?,NULL)',
                [
                  request.eventId,
                  request.contentRef.recipeId,
                  request.contentRef.revisionId,
                  request.contentRef.contentFingerprint,
                ],
              );
              await runBound(
                session,
                'UPDATE cooking_state SET history_revision=? WHERE singleton=1',
                [value.event.revision],
              );
              await admitCookingSessionRows(session);
            }
            await runBound(session, 'INSERT INTO content_cooking_event_authority VALUES (?,?,?)', [
              request.eventId,
              requestFingerprint,
              authorityJson,
            ]);
            const revision = next(await readRevision(session, 'store'));
            await runBound(
              session,
              "UPDATE state_revision SET revision=? WHERE collection='store'",
              [revision],
            );
            // Reuse the bounded shared parent/pin admission before a new row commits.
            await admitLocalCookingEvents(session);
            stored(await readStoredLocalCookingEvent(session, request.eventId, { sha256 }));
            guard();
            if (saveRequest) requireDate(saveRequest);
            completed = true;
            return { value: freezeResult(value), revision, changed: true };
          },
          { kind: 'none' },
          () => {
            guard();
            if (saveRequest) requireDate(saveRequest);
            return undefined;
          },
        );
        guard();
        if (result.changed) notify(result.value, result.revision);
        guard();
        return { kind: 'ready' as const, value: result.value, revision: result.revision };
      };
      // Resolution only fences this exact request; it never reads or resurrects a body.
      return saveRequest
        ? await reserve(before.workspace, saveRequest, write)
        : await write(null, check);
    } catch (error) {
      if (dispatched && owned && fingerprint) {
        const recovered = await recoverOwned(owned, fingerprint);
        if (recovered.kind === 'ready' && recovered.value) {
          if (completed) notify(recovered.value, recovered.revision);
          try {
            check();
          } catch (accessError) {
            return {
              kind: 'uncertain',
              operationId: owned.eventId,
              error: errorDetail(accessError),
            };
          }
          return { ...recovered, value: recovered.value };
        }
        if (recovered.kind === 'failed' || options.writer.requiresRecovery())
          return { kind: 'uncertain', operationId: owned.eventId, error: errorDetail(error) };
      }
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  return Object.freeze({
    saveCooked: (input: Immutable<SaveContentCookedInput>) => mutate(input, false),
    prepareCookedRecovery,
    readCookedRecovery,
    resolveCookedRecovery: (input: Immutable<ContentCookedRecoveryReference>) =>
      mutate(input, true, true),
    recover,
    resolveCookedOperation: (input: Immutable<SaveContentCookedInput>) => mutate(input, true),
    close() {
      closed = true;
    },
  });
}
