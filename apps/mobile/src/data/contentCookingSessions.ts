import {
  canonicalContentJson,
  createBundledContentReader,
  createBundledRecipeRevision,
  createContentReader,
  validateOverlayHead,
  validateRecipeContentRef,
  type OverlayHead,
  type ReadingRecipe,
  type RecipeContentRef,
  type RecipeContentRevision,
} from '@cookmate/catalogue/content';
import { isUtcInstant, type ContractError } from '@cookmate/contracts';
import type {
  CookingChange,
  CookingMutationResult,
  CookingSession,
  Immutable,
  RepositoryResult,
} from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import type { ContentReadingView, openContentReleaseStore } from './contentReleaseStore';
import {
  matchesContentCookingRevision,
  validateContentCookingSession,
  validateDismissContentCookingSessionInput,
  validateSaveContentCookingSessionInput,
  type ContentCookingSession,
  type DismissContentCookingSessionInput,
  type SaveContentCookingSessionInput,
} from './contentCookingRecords';
import { isAppId, isRevision } from './conversationRecords';
import {
  admitCookingClocks,
  admitCookingSessionRows,
  admitCookingWorkspaceClocks,
  readAdoptionInSnapshot,
  readStoredCookingSession,
  retainCookingRevisionInSnapshot,
  type CookingContentPin,
} from './cookingContentRepository';
import { freezeResult, readRevision } from './query';
import { readRestoreEpoch } from './restoreEpoch';
import { runBound, type SerializedReader, type SerializedWriter, type SqlSession } from './sql';

export interface ContentCookingSessionView {
  session: Immutable<CookingSession | ContentCookingSession> | null;
  pin: Immutable<CookingContentPin> | null;
  /** Only a freshly verified reading projection; never the local archive's stored body. */
  recipe: Immutable<ReadingRecipe> | null;
  resume: 'none' | 'exact' | 'legacy_requires_restart' | 'unavailable';
}
export interface ContentCookingSessionReceipt {
  formatVersion: 1;
  kind: 'saved' | 'dismissed';
  operationId: string;
  requestFingerprint: string;
  session: ContentCookingSession;
  storeRevision: number;
}
export type ContentCookingSessionRequest =
  | { kind: 'save'; input: SaveContentCookingSessionInput }
  | { kind: 'dismiss'; input: DismissContentCookingSessionInput };
interface Options {
  /** Explicit private schema 8 opt-in; existing callers remain schema 7 only. */
  cookingSchemaVersion?: 7 | 8;
  reader: SerializedReader;
  writer: SerializedWriter;
  contentStore: Pick<Awaited<ReturnType<typeof openContentReleaseStore>>, 'withVerifiedReading'>;
  installationId: string;
  sha256(text: string): Promise<string>;
  now(): string;
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
  request: ContentCookingSessionRequest;
  contentRef: RecipeContentRef;
}
type Stored = Awaited<ReturnType<typeof readStoredCookingSession>>;
const LIMITS = Object.freeze({
  authorityBytes: 4096,
  receiptBytes: 8192,
  operations: 20_000,
  journalBytes: 64 * 1024 * 1024,
});
const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left, 16384) === canonicalContentJson(right, 16384);
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const recipeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
class SessionFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function reject(message: string, code: ContractError['code'] = 'stale_context'): never {
  throw new SessionFault({
    code,
    messageKey: `content.cooking_${message}`,
    retry: 'after_correction',
  });
}
function stored(condition: unknown): asserts condition {
  if (!condition) reject('stored_evidence_invalid', 'storage_failure');
}
const errorDetail = (error: unknown): ContractError =>
  error instanceof SessionFault
    ? error.detail
    : {
        code: 'storage_failure',
        messageKey: 'content.cooking_storage_failed',
        retry: 'after_correction',
      };
function next(value: number) {
  stored(isRevision(value) && Number.isSafeInteger(value + 1));
  return value + 1;
}
function ownRequest(input: Immutable<ContentCookingSessionRequest>): ContentCookingSessionRequest {
  const value: unknown = JSON.parse(canonicalContentJson(input, LIMITS.authorityBytes));
  if (
    !exact(value, ['kind', 'input']) ||
    !(value.kind === 'save'
      ? validateSaveContentCookingSessionInput(value.input)
      : value.kind === 'dismiss' && validateDismissContentCookingSessionInput(value.input))
  )
    reject('invalid_request', 'invalid_input');
  return freezeResult(value as unknown as ContentCookingSessionRequest);
}
const requestRecipe = (request: ContentCookingSessionRequest) =>
  request.kind === 'save' ? request.input.contentRef.recipeId : request.input.recipeId;

/** Private schema-7 host with explicit schema-8 opt-in. No migrations, UI or cooked-history authority. */
export function createContentCookingSessions(options: Options) {
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
  async function capture(id: string) {
    const result = await options.reader.transaction(
      async (session) => ({
        workspace: await workspace(session),
        saved: await readSaved(session, id),
      }),
      { kind: 'read_only' },
    );
    check();
    return result;
  }
  async function readSaved(session: SqlSession, id: string) {
    const saved = await readStoredCookingSession(session, id, { sha256 });
    const [state] = await session.all<{ revision: number }>(
      'SELECT session_revision revision FROM cooking_state WHERE singleton=1',
    );
    stored(
      state && isRevision(state.revision) && (!saved || saved.session.revision <= state.revision),
    );
    return saved;
  }
  async function latestRecipe(session: SqlSession): Promise<string | null> {
    await admitCookingSessionRows(session);
    const [row] = await session.all<{ recipeId: string }>(
      "SELECT recipe_id recipeId FROM cooking_session WHERE state='active' ORDER BY updated_at DESC,revision DESC,recipe_id LIMIT 1",
    );
    stored(!row || recipeId(row.recipeId));
    return row?.recipeId ?? null;
  }
  async function admitJournal(session: SqlSession) {
    const [usage] = await session.all<{ count: number; bytes: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(authority_json AS BLOB))+length(CAST(receipt_json AS BLOB))),0) bytes FROM content_cooking_session_operation`,
    );
    stored(
      usage &&
        isRevision(usage.count) &&
        isRevision(usage.bytes) &&
        usage.count <= LIMITS.operations &&
        usage.bytes <= LIMITS.journalBytes,
    );
    stored(
      (
        await session.all(`SELECT 1 FROM content_cooking_session_operation WHERE
      typeof(operation_id)<>'text' OR length(CAST(operation_id AS BLOB))<>36 OR
      typeof(request_fingerprint)<>'text' OR length(CAST(request_fingerprint AS BLOB))<>64 OR
      typeof(authority_json)<>'text' OR length(CAST(authority_json AS BLOB))>4096 OR NOT json_valid(authority_json) OR
      typeof(receipt_json)<>'text' OR length(CAST(receipt_json AS BLOB))>8192 OR NOT json_valid(receipt_json) LIMIT 1`)
      ).length === 0,
    );
    return usage;
  }
  function parseAuthority(text: string, request: ContentCookingSessionRequest): Authority {
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
        'request',
        'contentRef',
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
        value.contentRef.recipeId === requestRecipe(request) &&
        same(value.request, request) &&
        (request.kind !== 'save' || same(value.contentRef, request.input.contentRef)) &&
        canonicalContentJson(value, LIMITS.authorityBytes) === text,
    );
    if (value.installationId !== options.installationId || value.ownerId !== scope.ownerId)
      reject('access_changed');
    return value as unknown as Authority;
  }
  async function journal(
    session: SqlSession,
    request: ContentCookingSessionRequest,
    fingerprint: string,
  ): Promise<ContentCookingSessionReceipt | null> {
    await owner(session);
    await admitJournal(session);
    const [row] = await session.all<{ fingerprint: string; authority: string; receipt: string }>(
      'SELECT request_fingerprint fingerprint,authority_json authority,receipt_json receipt FROM content_cooking_session_operation WHERE operation_id=?',
      [request.input.operationId],
    );
    if (!row) return null;
    if (row.fingerprint !== fingerprint) reject('operation_conflict', 'operation_conflict');
    const authority = parseAuthority(row.authority, request),
      value: unknown = JSON.parse(row.receipt);
    stored(
      exact(value, [
        'formatVersion',
        'kind',
        'operationId',
        'requestFingerprint',
        'session',
        'storeRevision',
      ]) &&
        value.formatVersion === 1 &&
        value.kind === (request.kind === 'save' ? 'saved' : 'dismissed') &&
        value.operationId === request.input.operationId &&
        value.requestFingerprint === fingerprint &&
        isRevision(value.storeRevision) &&
        validateContentCookingSession(value.session) &&
        value.session.lastOperationId === request.input.operationId &&
        value.session.sessionId === request.input.sessionId &&
        same(value.session.contentRef, authority.contentRef) &&
        value.session.state === (request.kind === 'save' ? 'active' : 'dismissed') &&
        (request.input.expectedRevision === null ||
          value.session.revision > request.input.expectedRevision) &&
        (request.kind !== 'save' ||
          value.session.passageSequence === request.input.passageSequence) &&
        canonicalContentJson(value, LIMITS.receiptBytes) === row.receipt,
    );
    const [state] = await session.all<{ revision: number }>(
      'SELECT session_revision revision FROM cooking_state WHERE singleton=1',
    );
    stored(state && isRevision(state.revision) && value.session.revision <= state.revision);
    stored(value.storeRevision <= (await readRevision(session, 'store')));
    check();
    return freezeResult(value as unknown as ContentCookingSessionReceipt);
  }
  async function fingerprint(request: ContentCookingSessionRequest) {
    return sha256(
      canonicalContentJson(['cookmate-content-cooking-session-v1', request], LIMITS.authorityBytes),
    );
  }
  async function recoverOwned(
    request: ContentCookingSessionRequest,
    digest: string,
  ): Promise<RepositoryResult<Immutable<ContentCookingSessionReceipt> | null>> {
    try {
      const result = await options.reader.transaction(
        async (session) => ({
          kind: 'ready' as const,
          value: await journal(session, request, digest),
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
    input: Immutable<ContentCookingSessionRequest>,
  ): Promise<RepositoryResult<Immutable<ContentCookingSessionReceipt> | null>> {
    try {
      check();
      const request = ownRequest(input);
      return await recoverOwned(request, await fingerprint(request));
    } catch (error) {
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  async function reserve<Value>(
    before: Workspace,
    refs: readonly RecipeContentRef[],
    work: (view: ContentReadingView, guard: () => undefined) => Promise<Value>,
  ): Promise<Value> {
    check();
    const result = await options.contentStore.withVerifiedReading(
      before.head,
      refs,
      async (view: ContentReadingView) => {
        const guard = (): undefined => {
          check();
          stored(view.assertActive() === undefined);
          return undefined;
        };
        guard();
        stored(same(view.head, before.head));
        if (before.head === null) stored(view.snapshot === null && !view.hasWithdrawal);
        else
          stored(
            view.snapshot &&
              same(before.head, {
                releaseId: view.snapshot.envelope.manifest.releaseId,
                sequence: view.snapshot.envelope.manifest.sequence,
                fingerprint: view.snapshot.envelope.fingerprint,
              }),
          );
        const result = await work(view, guard);
        guard();
        return result;
      },
    );
    check();
    return result;
  }
  function requireTransition(request: ContentCookingSessionRequest, current: Stored) {
    if ((current?.session.revision ?? null) !== request.input.expectedRevision)
      reject('session_changed');
    if (request.kind === 'dismiss') {
      if (
        !current ||
        current.session.sessionId !== request.input.sessionId ||
        current.session.state !== 'active'
      )
        reject('session_changed');
      if (current.session.readerVersion !== 2) reject('legacy_restart_required');
    } else if (current?.session.sessionId === request.input.sessionId) {
      if (current.session.readerVersion !== 2) reject('legacy_restart_required');
      if (current.session.state !== 'active') reject('restart_required');
      if (!same(current.session.contentRef, request.input.contentRef))
        reject('session_content_changed');
    }
  }
  function publish(value: ContentCookingSessionReceipt) {
    try {
      options.onCommitted({
        recipeId: value.session.recipeId,
        historyChanged: false,
        revision: value.storeRevision,
      });
    } catch {
      /* Committed truth is independent of observers. */
    }
  }
  async function mutate(
    input: Immutable<ContentCookingSessionRequest>,
  ): Promise<CookingMutationResult<ContentCookingSessionReceipt>> {
    let request: ContentCookingSessionRequest | undefined,
      digest: string | undefined,
      dispatched = false,
      completed = false,
      notified = false;
    const notify = (receipt: ContentCookingSessionReceipt) => {
      if (!notified) {
        notified = true;
        publish(receipt);
      }
    };
    try {
      check();
      request = ownRequest(input);
      digest = await fingerprint(request);
      const owned = request,
        requestFingerprint = digest,
        id = requestRecipe(owned);
      const prior = await recoverOwned(owned, requestFingerprint);
      if (prior.kind === 'failed') throw new SessionFault(prior.error);
      if (prior.value) return { ...prior, value: prior.value };
      const before = await capture(id);
      requireTransition(owned, before.saved);
      const write = async (
        ref: RecipeContentRef,
        verified: Immutable<RecipeContentRevision> | null,
        guard: () => undefined,
      ) => {
        guard();
        dispatched = true;
        const result = await options.writer.transaction(
          async (session) => {
            guard();
            const existing = await journal(session, owned, requestFingerprint);
            if (existing) return { receipt: existing, changed: false };
            if (!same(await workspace(session), before.workspace)) reject('workspace_changed');
            const current = await readStoredCookingSession(session, id, { sha256 });
            requireTransition(owned, current);
            if (!same(current, before.saved)) reject('session_changed');
            const usage = await admitJournal(session);
            if (usage.count >= LIMITS.operations) reject('journal_limit', 'unsupported_request');
            stored(
              (
                await session.all('SELECT 1 FROM cooking_session WHERE operation_id=? LIMIT 1', [
                  owned.input.operationId,
                ])
              ).length === 0,
            );
            if (owned.kind === 'save' && current?.session.sessionId !== owned.input.sessionId) {
              const used = await session.all(
                `SELECT 1 FROM cooking_session WHERE session_id=? UNION ALL
              SELECT 1 FROM content_cooking_session_operation WHERE json_extract(receipt_json,'$.session.sessionId')=? LIMIT 1`,
                [owned.input.sessionId, owned.input.sessionId],
              );
              if (used.length) reject('session_id_reused', 'operation_conflict');
            }
            const [state] = await session.all<{ revision: number }>(
              'SELECT session_revision revision FROM cooking_state WHERE singleton=1',
            );
            stored(
              state &&
                isRevision(state.revision) &&
                (!current || current.session.revision <= state.revision),
            );
            const at = options.now();
            stored(isUtcInstant(at));
            const value: ContentCookingSession = {
              readerVersion: 2,
              recipeId: id,
              contentRef: { ...ref },
              sessionId: owned.input.sessionId,
              revision: next(state.revision),
              passageSequence:
                owned.kind === 'save'
                  ? owned.input.passageSequence
                  : current!.session.passageSequence,
              state: owned.kind === 'save' ? 'active' : 'dismissed',
              updatedAt: at,
              lastOperationId: owned.input.operationId,
            };
            stored(validateContentCookingSession(value));
            const storeRevision = next(await readRevision(session, 'store'));
            const receipt: ContentCookingSessionReceipt = {
              formatVersion: 1,
              kind: owned.kind === 'save' ? 'saved' : 'dismissed',
              operationId: owned.input.operationId,
              requestFingerprint,
              session: value,
              storeRevision,
            };
            const authority: Authority = {
              ...before.workspace,
              formatVersion: 1,
              request: owned,
              contentRef: { ...ref },
            };
            const authorityJson = canonicalContentJson(authority, LIMITS.authorityBytes),
              receiptJson = canonicalContentJson(receipt, LIMITS.receiptBytes);
            if (
              usage.bytes +
                new TextEncoder().encode(authorityJson).byteLength +
                new TextEncoder().encode(receiptJson).byteLength >
              LIMITS.journalBytes
            )
              reject('journal_limit', 'unsupported_request');
            if (verified) await retainCookingRevisionInSnapshot(session, verified, sha256);
            // Remove the old dependent pin before an explicit restart changes its sessionId.
            await runBound(session, 'DELETE FROM cooking_session_content_pin WHERE recipe_id=?', [
              id,
            ]);
            await runBound(
              session,
              `INSERT INTO cooking_session VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(recipe_id) DO UPDATE SET
            session_id=excluded.session_id,revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at,
            operation_id=excluded.operation_id,request_fingerprint=excluded.request_fingerprint,session_json=excluded.session_json`,
              [
                id,
                value.sessionId,
                value.revision,
                value.state,
                value.updatedAt,
                value.lastOperationId,
                requestFingerprint,
                canonicalContentJson(value, LIMITS.receiptBytes),
              ],
            );
            await runBound(
              session,
              'INSERT INTO cooking_session_content_pin VALUES (?,?,?,?,NULL)',
              [value.sessionId, id, ref.revisionId, ref.contentFingerprint],
            );
            await runBound(
              session,
              'UPDATE cooking_state SET session_revision=? WHERE singleton=1',
              [value.revision],
            );
            await runBound(
              session,
              "UPDATE state_revision SET revision=? WHERE collection='store'",
              [storeRevision],
            );
            await runBound(
              session,
              'INSERT INTO content_cooking_session_operation VALUES (?,?,?,?)',
              [owned.input.operationId, requestFingerprint, authorityJson, receiptJson],
            );
            // Preserve the shared reader's aggregate/cardinality bounds after a new
            // session or larger replacement, with all writes still rollbackable.
            await admitCookingSessionRows(session);
            guard();
            completed = true;
            return { receipt: freezeResult(receipt), changed: true };
          },
          { kind: 'none' },
          guard,
        );
        guard();
        if (result.changed) notify(result.receipt);
        guard();
        return {
          kind: 'ready' as const,
          value: result.receipt,
          revision: result.receipt.storeRevision,
        };
      };
      if (owned.kind === 'dismiss') {
        stored(before.saved?.pin.kind === 'exact');
        // Dismissing local progress does not disclose or authorize withdrawn content.
        return await write(before.saved.pin.ref, null, check);
      }
      return await reserve(before.workspace, [owned.input.contentRef], async (view, guard) => {
        const continuation = before.saved?.session.sessionId === owned.input.sessionId;
        let verified: Immutable<RecipeContentRevision>;
        if (view.snapshot) {
          const lookup = continuation
            ? view.snapshot.lookupExact(owned.input.contentRef)
            : view.snapshot.lookupCurrent(id);
          if (
            lookup.kind !== 'readable' ||
            (!continuation && lookup.state !== 'current') ||
            !same(lookup.value.revision.ref, owned.input.contentRef)
          )
            reject('content_unavailable');
          verified = lookup.value.revision;
        } else {
          verified = await createBundledRecipeRevision(id, sha256);
          guard();
          if (!same(verified.ref, owned.input.contentRef)) reject('content_unavailable');
        }
        if (!matchesContentCookingRevision(owned.input, verified))
          reject('invalid_passage', 'invalid_input');
        return write(owned.input.contentRef, verified, guard);
      });
    } catch (error) {
      if (dispatched && request && digest) {
        const recovered = await recoverOwned(request, digest);
        if (recovered.kind === 'ready' && recovered.value) {
          if (completed) notify(recovered.value);
          try {
            check();
          } catch (accessError) {
            return {
              kind: 'uncertain',
              operationId: request.input.operationId,
              error: errorDetail(accessError),
            };
          }
          return { ...recovered, value: recovered.value };
        }
        if (recovered.kind === 'failed' || options.writer.requiresRecovery())
          return {
            kind: 'uncertain',
            operationId: request.input.operationId,
            error: errorDetail(error),
          };
      }
      return { kind: 'failed', error: errorDetail(error) };
    }
  }
  async function readView(
    id: string,
    before: Awaited<ReturnType<typeof capture>>,
    latest = false,
  ): Promise<RepositoryResult<Immutable<ContentCookingSessionView>>> {
    const saved = before.saved;
    const metadata = { session: saved?.session ?? null, pin: saved?.pin ?? null };
    const unavailable: ContentCookingSessionView = {
      ...metadata,
      recipe: null,
      resume:
        saved?.session.readerVersion === 1 && saved.session.state === 'active'
          ? 'legacy_requires_restart'
          : 'unavailable',
    };
    const finish = async (value: ContentCookingSessionView) =>
      options.reader.transaction(
        async (session) => {
          if (
            !same(await workspace(session), before.workspace) ||
            !same(await readSaved(session, id), saved) ||
            (latest && (await latestRecipe(session)) !== id)
          )
            reject('session_changed');
          return {
            kind: 'ready' as const,
            value: freezeResult(value),
            revision: await readRevision(session, 'store'),
          };
        },
        { kind: 'read_only' },
      );
    if (!saved || saved.pin.kind === 'exact') {
      try {
        return await reserve(
          before.workspace,
          saved?.pin.kind === 'exact' ? [saved.pin.ref] : [],
          async (view, guard) => {
            const reading = view.snapshot
              ? createContentReader(view.snapshot)
              : await createBundledContentReader(sha256);
            guard();
            const found =
              saved?.pin.kind === 'exact'
                ? reading.lookupExact(saved.pin.ref)
                : reading.lookupCurrent(id);
            // The same-snapshot session/workspace proof must finish while content
            // remains reserved; a later cached withdrawal cannot race this await.
            const result = await finish({
              ...metadata,
              recipe: found.kind === 'readable' ? found.recipe : null,
              resume:
                found.kind !== 'readable'
                  ? 'unavailable'
                  : !saved || saved.session.state !== 'active'
                    ? 'none'
                    : saved.session.readerVersion === 1
                      ? 'legacy_requires_restart'
                      : 'exact',
            });
            guard();
            return result;
          },
        );
      } catch {
        check(); /* Keep metadata, never substitute a newer body on failed exact reading. */
      }
    }
    const result = await finish(unavailable);
    check();
    return result;
  }
  return Object.freeze({
    async readSession(id: string): Promise<RepositoryResult<Immutable<ContentCookingSessionView>>> {
      try {
        check();
        if (!recipeId(id)) reject('invalid_recipe', 'invalid_input');
        return await readView(id, await capture(id));
      } catch (error) {
        return { kind: 'failed', error: errorDetail(error) };
      }
    },
    async readResumeSession(): Promise<
      RepositoryResult<Immutable<ContentCookingSessionView> | null>
    > {
      try {
        check();
        const before = await options.reader.transaction(
          async (session) => {
            const currentWorkspace = await workspace(session),
              id = await latestRecipe(session);
            return {
              workspace: currentWorkspace,
              id,
              saved: id === null ? null : await readSaved(session, id),
              revision: await readRevision(session, 'store'),
            };
          },
          { kind: 'read_only' },
        );
        check();
        return before.id === null
          ? { kind: 'ready', value: null, revision: before.revision }
          : await readView(before.id, before, true);
      } catch (error) {
        return { kind: 'failed', error: errorDetail(error) };
      }
    },
    saveSession: (input: Immutable<SaveContentCookingSessionInput>) =>
      mutate({ kind: 'save', input }),
    dismissSession: (input: Immutable<DismissContentCookingSessionInput>) =>
      mutate({ kind: 'dismiss', input }),
    recover,
    close() {
      closed = true;
    },
  });
}
