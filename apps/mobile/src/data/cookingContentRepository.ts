import { catalogue, type Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledRecipeRevision,
  readRecipeContentRevision,
  validateRecipeContentRef,
  validateOverlayHead,
  OVERLAY_LIMITS,
  bundledImportedSourceVerifier,
  type EffectiveContentSnapshot,
  type RecipeContentRef,
  type RecipeContentRevision,
  type OverlayHead,
} from '@cookmate/catalogue/content';
import { isUtcInstant } from '@cookmate/contracts';
import {
  cookingContentIdentity,
  validatePortableHistoryEntry,
  type CookingContentIdentity,
  type CookingSession,
  type CookedReceipt,
} from '@cookmate/domain';
import { validateAccountCookingHistoryEntry } from '@cookmate/account-sync';
import {
  COOKING_CONTENT_LIMITS,
  CONTENT_PIN_REASONS,
  type ContentPinReason,
} from './cookingContentSchema';
import { isAppId, isRevision } from './conversationRecords';
import { readBinding } from './accountReplicationRecords';
import {
  admitAccountContentHistoryProjection,
  hasUniqueHistoryJsonKeys,
  parseAccountContentHistoryEntry,
} from './accountContentHistoryProjection';
import { freezeResult } from './query';
import { validateContentCookingSession, type ContentCookingSession } from './contentCookingRecords';
import {
  validateContentCookedReceipt,
  validateImportedContentCookingHistoryEntry,
  type ContentCookedReceipt,
} from './contentCookingHistoryRecords';
import { runBound, StorageFault, type SqlSession, type SqlValue } from './sql';

export type CookingContentPin =
  | { kind: 'exact'; ref: RecipeContentRef }
  | { kind: 'unresolved'; reason: ContentPinReason };
export function contentStored(condition: unknown): asserts condition {
  if (!condition) throw new StorageFault('storage_failure', 'Cooking content evidence is invalid');
}
export const contentBytes = (value: string) => new TextEncoder().encode(value).byteLength;
export type CookingPinHash = (text: string) => Promise<string>;
export type HistoryPinSource = 'local' | 'backup' | 'account';
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const uuidGlob = `${'[0-9a-f]'.repeat(8)}-${'[0-9a-f]'.repeat(4)}-4${'[0-9a-f]'.repeat(3)}-[89ab]${'[0-9a-f]'.repeat(3)}-${'[0-9a-f]'.repeat(12)}`;
export function validLegacyCookingSession(value: unknown): value is CookingSession {
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
    typeof value.recipeId === 'string' &&
    /^[0-9]{1,20}$/.test(value.recipeId) &&
    hash(value.contentFingerprint) &&
    value.readerVersion === 1 &&
    record(value.catalogue) &&
    exact(value.catalogue, ['version', 'fingerprint']) &&
    typeof value.catalogue.version === 'string' &&
    value.catalogue.version.length > 0 &&
    value.catalogue.version.length <= 200 &&
    hash(value.catalogue.fingerprint) &&
    isAppId(value.sessionId) &&
    isRevision(value.revision) &&
    value.revision > 0 &&
    isRevision(value.passageSequence) &&
    value.passageSequence > 0 &&
    ['active', 'dismissed', 'completed'].includes(value.state as string) &&
    typeof value.updatedAt === 'string' &&
    isUtcInstant(value.updatedAt) &&
    isAppId(value.lastOperationId)
  );
}
type LegacyPinIdentity = CookingContentIdentity & {
  recipeTitle?: string;
  photoKey?: string;
  passageSequence?: number;
};
/** Legacy parents never recorded a publisher revision. Only independently proven packaged refs are exact. */
export function createLegacyCookingPinProof(sha256: CookingPinHash) {
  const known = new Map<string, { ref: RecipeContentRef; legacy: CookingContentIdentity }>();
  return async (value: LegacyPinIdentity): Promise<CookingContentPin> => {
    const recipe = catalogue.getRecipe(value.recipeId);
    if (!recipe) return { kind: 'unresolved', reason: 'recipe_unavailable' };
    if (
      value.catalogue.version !== catalogue.identity.version ||
      value.catalogue.fingerprint !== catalogue.identity.fingerprint
    )
      return { kind: 'unresolved', reason: 'catalogue_mismatch' };
    let evidence = known.get(value.recipeId);
    if (!evidence) {
      evidence = {
        ref: { ...(await createBundledRecipeRevision(value.recipeId, sha256)).ref },
        legacy: await cookingContentIdentity(recipe, catalogue.identity, sha256),
      };
      known.set(value.recipeId, evidence);
    }
    if (
      value.contentFingerprint !== evidence.legacy.contentFingerprint ||
      value.readerVersion !== 1 ||
      (value.recipeTitle !== undefined && value.recipeTitle !== recipe.title) ||
      (value.photoKey !== undefined && value.photoKey !== recipe.photoKey)
    )
      return { kind: 'unresolved', reason: 'content_mismatch' };
    contentStored(
      value.passageSequence === undefined ||
        recipe.instructions.some((entry) => entry.sequence === value.passageSequence),
    );
    return { kind: 'exact', ref: { ...evidence.ref } };
  };
}
/** Fixed internal identifiers only. This query returns a sentinel, never unbounded stored values. */
export async function admitCookingScalarColumns(
  session: SqlSession,
  table: string,
  columns: readonly (readonly [string, number, boolean?])[],
  predicate = '1',
) {
  const invalid = columns
    .map(
      ([column, maximum, nullable]) =>
        `${nullable ? `(${column} IS NOT NULL AND (` : '('}typeof(${column})<>'text' OR length(CAST(${column} AS BLOB))>${maximum}${nullable ? '))' : ')'}`,
    )
    .join(' OR ');
  contentStored(
    (await session.all(`SELECT 1 FROM ${table} WHERE (${predicate}) AND (${invalid}) LIMIT 1`))
      .length === 0,
  );
}
async function admitIntegerColumns(
  session: SqlSession,
  table: string,
  columns: readonly string[],
  predicate = '1',
) {
  contentStored(
    (
      await session.all(
        `SELECT 1 FROM ${table} WHERE (${predicate}) AND (${columns.map((column) => `typeof(${column})<>'integer' OR ${column}<0 OR ${column}>9007199254740991`).join(' OR ')}) LIMIT 1`,
      )
    ).length === 0,
  );
}

/** Private cooking hosts admit clocks in their transaction before shared raw scalar readers. */
export async function admitCookingClocks(session: SqlSession) {
  await admitIntegerColumns(session, 'cooking_state', [
    'session_revision',
    'history_revision',
    'history_epoch',
  ]);
  await admitIntegerColumns(session, 'state_revision', ['revision'], "collection='store'");
  contentStored(
    (await session.all('SELECT 1 FROM cooking_state WHERE singleton=1')).length === 1 &&
      (await session.all("SELECT 1 FROM state_revision WHERE collection='store'")).length === 1,
  );
}
/** Workspace fences are admitted separately so historical receipt-only reads stay body-free. */
export async function admitCookingWorkspaceClocks(session: SqlSession) {
  await admitIntegerColumns(session, 'app_content_adoption', ['revision']);
  await admitIntegerColumns(session, 'portable_restore_operation', ['committed_revision']);
  contentStored(
    (await session.all('SELECT 1 FROM app_content_adoption WHERE singleton=1')).length === 1,
  );
}
const historyTables = {
  local: 'cooking_event',
  backup: 'imported_cooking_history',
  account: 'account_cooking_history',
} as const;
const historyPins = {
  local: 'local_history_content_pin',
  backup: 'imported_history_content_pin',
  account: 'account_history_content_pin',
} as const;
const pinBounds = [
  ['recipe_id', 20],
  ['revision_id', 120, true],
  ['content_fingerprint', 64, true],
  ['unresolved_reason', 32, true],
] as const;
async function admitPayloads(
  session: SqlSession,
  table: string,
  column: string,
  maximum: number,
  predicate = '1',
) {
  const row = (
    await session.all<{ count: number; bytes: number; invalid: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(${column} AS BLOB))),0) bytes,COALESCE(SUM(CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=? THEN 0 ELSE 1 END),0) invalid FROM ${table} WHERE ${predicate}`,
      [maximum],
    )
  )[0];
  contentStored(
    row &&
      row.count <= 10_000 &&
      row.bytes <= COOKING_CONTENT_LIMITS.historyBytes &&
      row.invalid === 0,
  );
}
export async function admitLegacyHistoryRows(session: SqlSession, source: HistoryPinSource) {
  const table = historyTables[source],
    predicate = source === 'local' ? "state='saved'" : '1';
  await admitPayloads(
    session,
    table,
    source === 'local' ? 'receipt_json' : 'entry_json',
    32768,
    predicate,
  );
  const columns: (readonly [string, number])[] = [['event_id', 36]];
  if (source === 'account') columns.push(['owner_id', 36]);
  else columns.push(['cooked_on', 10], ['recorded_at', 40]);
  if (source === 'local') columns.push(['request_fingerprint', 64]);
  if (source === 'backup') columns.push(['source_event_id', 36], ['restore_operation_id', 36]);
  await admitCookingScalarColumns(session, table, columns, predicate);
  contentStored(
    (
      await session.all(
        `SELECT 1 FROM ${table} WHERE (${predicate}) AND (length(CAST(event_id AS BLOB))<>36 OR event_id NOT GLOB ?) LIMIT 1`,
        [uuidGlob],
      )
    ).length === 0,
  );
  if (source !== 'account') await admitIntegerColumns(session, table, ['history_epoch'], predicate);
}
/** Admission covers tombstones too; a cleared row must not hide unbounded old payloads. */
export async function admitLocalCookingEvents(session: SqlSession) {
  const [usage] = await session.all<{ count: number }>('SELECT COUNT(*) count FROM cooking_event');
  contentStored(
    usage &&
      Number.isSafeInteger(usage.count) &&
      usage.count <= COOKING_CONTENT_LIMITS.historyOperations,
  );
  await admitLegacyHistoryRows(session, 'local');
  await admitCookingScalarColumns(session, 'cooking_event', [
    ['event_id', 36],
    ['state', 9],
    ['cooked_on', 10, true],
    ['recorded_at', 40, true],
    ['request_fingerprint', 64, true],
  ]);
  await admitIntegerColumns(session, 'cooking_event', ['history_epoch']);
  contentStored(
    (
      await session.all(`SELECT 1 FROM cooking_event WHERE state NOT IN ('saved','cleared','cancelled') OR
    (state<>'saved' AND (cooked_on IS NOT NULL OR recorded_at IS NOT NULL OR request_fingerprint IS NOT NULL OR receipt_json IS NOT NULL)) LIMIT 1`)
    ).length === 0,
  );
}
export async function admitCookingSessionRows(session: SqlSession) {
  await admitPayloads(session, 'cooking_session', 'session_json', 8192);
  await admitCookingScalarColumns(session, 'cooking_session', [
    ['recipe_id', 20],
    ['session_id', 36],
    ['state', 9],
    ['updated_at', 40],
    ['operation_id', 36],
    ['request_fingerprint', 64],
  ]);
  await admitIntegerColumns(session, 'cooking_session', ['revision']);
}
export function parseLegacySessionRow(row: Record<string, SqlValue>): CookingSession {
  contentStored(typeof row.session_json === 'string');
  const value: unknown = JSON.parse(row.session_json);
  contentStored(
    validLegacyCookingSession(value) &&
      value.recipeId === row.recipe_id &&
      value.sessionId === row.session_id &&
      value.revision === row.revision &&
      value.state === row.state &&
      value.updatedAt === row.updated_at &&
      value.lastOperationId === row.operation_id &&
      hash(row.request_fingerprint),
  );
  return value;
}
function parseCookingSessionRow(
  row: Record<string, SqlValue>,
): CookingSession | ContentCookingSession {
  contentStored(typeof row.session_json === 'string' && contentBytes(row.session_json) <= 8192);
  const value: unknown = JSON.parse(row.session_json);
  if (!validateContentCookingSession(value)) return parseLegacySessionRow(row);
  contentStored(
    value.recipeId === row.recipe_id &&
      value.sessionId === row.session_id &&
      value.revision === row.revision &&
      value.state === row.state &&
      value.updatedAt === row.updated_at &&
      value.lastOperationId === row.operation_id &&
      hash(row.request_fingerprint),
  );
  return value;
}
export function parseLegacyHistoryRow(
  source: HistoryPinSource,
  row: Record<string, SqlValue>,
  ownerId: string | null,
) {
  const column = source === 'local' ? 'receipt_json' : 'entry_json';
  contentStored(isAppId(row.event_id) && typeof row[column] === 'string');
  const stored: unknown = JSON.parse(row[column]);
  if (source === 'account') {
    contentStored(
      ownerId !== null &&
        row.owner_id === ownerId &&
        validateAccountCookingHistoryEntry(stored) &&
        stored.eventId === row.event_id,
    );
    return stored;
  }
  let entry: unknown = stored;
  if (source === 'local') {
    contentStored(
      row.state === 'saved' &&
        record(stored) &&
        exact(stored, ['kind', 'event', 'closedSession']) &&
        stored.kind === 'saved' &&
        hash(row.request_fingerprint),
    );
    entry = stored.event;
    contentStored(validatePortableHistoryEntry(entry) && entry.origin === undefined);
    contentStored(
      stored.closedSession === null ||
        (validLegacyCookingSession(stored.closedSession) &&
          stored.closedSession.recipeId === entry.recipeId &&
          stored.closedSession.state === 'completed' &&
          stored.closedSession.lastOperationId === row.event_id),
    );
  }
  contentStored(
    validatePortableHistoryEntry(entry) &&
      entry.eventId === row.event_id &&
      entry.historyEpoch === row.history_epoch &&
      entry.cookedOn === row.cooked_on &&
      entry.recordedAt === row.recorded_at,
  );
  if (source === 'backup')
    contentStored(
      entry.origin === 'backup' &&
        isAppId(row.source_event_id) &&
        isAppId(row.restore_operation_id),
    );
  return entry;
}
export async function requireCookingContentVersion(session: SqlSession) {
  contentStored(
    (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version === 7,
  );
}
/** Private read compatibility; existing mutation admission remains explicitly schema7. */
export async function requireCookingContentReadVersion(session: SqlSession): Promise<7 | 8> {
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  contentStored(version === 7 || version === 8);
  return version;
}
async function admitRetainedCookingRevisions(session: SqlSession) {
  const [usage] = await session.all<{ count: number; bytes: number; invalid: number }>(
    `SELECT COUNT(*) count,COALESCE(SUM(length(CAST(revision_json AS BLOB))),0) bytes,
      COALESCE(SUM(CASE WHEN typeof(revision_json)='text' AND length(CAST(revision_json AS BLOB))<=? THEN 0 ELSE 1 END),0) invalid
      FROM recipe_content_revision`,
    [COOKING_CONTENT_LIMITS.revisionBytes],
  );
  contentStored(
    usage &&
      Number.isSafeInteger(usage.count) &&
      usage.count <= COOKING_CONTENT_LIMITS.revisions &&
      Number.isSafeInteger(usage.bytes) &&
      usage.bytes <= COOKING_CONTENT_LIMITS.archiveBytes &&
      usage.invalid === 0,
  );
}
function sourceRows(revision: Immutable<RecipeContentRevision>) {
  const { document } = revision;
  return [
    ...document.recipe.ingredients.map((entry) => ({
      kind: 'ingredient',
      key: String(entry.position),
    })),
    ...document.recipe.instructions.map((entry) => ({
      kind: 'instruction',
      key: String(entry.sequence),
    })),
    ...(document.kind === 'imported'
      ? document.recipe.annotations.map((entry) => ({
          kind: 'annotation',
          key: entry.annotationId,
        }))
      : []),
  ].sort((a, b) =>
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}
/** Internal transaction helper. Call only with independently verified baseline or host-verified content. */
export async function retainCookingRevisionInSnapshot(
  session: SqlSession,
  input: Immutable<RecipeContentRevision>,
  sha256: (text: string) => Promise<string>,
): Promise<void> {
  const revision = await readRecipeContentRevision(input, sha256);
  if (revision.document.kind === 'imported')
    contentStored(await bundledImportedSourceVerifier.verify(revision.document));
  const json = canonicalContentJson(revision, COOKING_CONTENT_LIMITS.revisionBytes),
    ref = revision.ref;
  const [existing] = await session.all<{ document: string | null; fingerprint: string | null }>(
    `SELECT CASE WHEN typeof(content_fingerprint)='text' AND length(CAST(content_fingerprint AS BLOB))=64 THEN content_fingerprint ELSE NULL END fingerprint,CASE WHEN typeof(revision_json)='text' AND length(CAST(revision_json AS BLOB))<=? THEN revision_json ELSE NULL END document
      FROM recipe_content_revision WHERE recipe_id=? AND revision_id=?`,
    [COOKING_CONTENT_LIMITS.revisionBytes, ref.recipeId, ref.revisionId],
  );
  const sources = sourceRows(revision);
  if (existing) {
    contentStored(existing.fingerprint === ref.contentFingerprint && existing.document === json);
    const sourceCount = (
      await session.all<{ count: number }>(
        'SELECT COUNT(*) count FROM recipe_content_source WHERE recipe_id=? AND revision_id=? AND content_fingerprint=?',
        [ref.recipeId, ref.revisionId, ref.contentFingerprint],
      )
    )[0]?.count;
    contentStored(sourceCount === sources.length);
    await admitCookingScalarColumns(session, 'recipe_content_source', [
      ['source_kind', 11],
      ['source_key', 200],
    ]);
    const retained = await session.all<{ kind: string; key: string }>(
      'SELECT source_kind kind,source_key key FROM recipe_content_source WHERE recipe_id=? AND revision_id=? AND content_fingerprint=? ORDER BY source_kind,source_key',
      [ref.recipeId, ref.revisionId, ref.contentFingerprint],
    );
    contentStored(canonicalContentJson(retained) === canonicalContentJson(sources));
    return;
  }
  const [usage] = await session.all<{ count: number; bytes: number }>(
    'SELECT COUNT(*) count,COALESCE(SUM(length(CAST(revision_json AS BLOB))),0) bytes FROM recipe_content_revision',
  );
  contentStored(
    usage &&
      usage.count < COOKING_CONTENT_LIMITS.revisions &&
      usage.bytes + contentBytes(json) <= COOKING_CONTENT_LIMITS.archiveBytes,
  );
  await runBound(
    session,
    'INSERT INTO recipe_identity VALUES (?) ON CONFLICT(recipe_id) DO NOTHING',
    [ref.recipeId],
  );
  await runBound(session, 'INSERT INTO recipe_content_revision VALUES (?,?,?,?,?)', [
    ref.recipeId,
    ref.revisionId,
    ref.contentFingerprint,
    revision.document.kind,
    json,
  ]);
  for (const source of sources)
    await runBound(session, 'INSERT INTO recipe_content_source VALUES (?,?,?,?,?)', [
      ref.recipeId,
      ref.revisionId,
      ref.contentFingerprint,
      source.kind,
      source.key,
    ]);
}
/** The snapshot must come from host verification/hydration. Stored hashes or JSON flags never establish release trust. */
export async function retainVerifiedRevisionsInSnapshot(
  session: SqlSession,
  snapshot: EffectiveContentSnapshot,
  refs: readonly RecipeContentRef[],
  sha256: (text: string) => Promise<string>,
): Promise<void> {
  await requireCookingContentVersion(session);
  await retainVerifiedRevisions(session, snapshot, refs, sha256);
}

/** Explicit host admission; the default verified-retention entrypoint remains schema 7 only. */
export async function retainVerifiedRevisionsForSchemaInSnapshot(
  session: SqlSession,
  snapshot: EffectiveContentSnapshot,
  refs: readonly RecipeContentRef[],
  sha256: (text: string) => Promise<string>,
  schemaVersion: 7 | 8,
): Promise<void> {
  contentStored(
    (schemaVersion === 7 || schemaVersion === 8) &&
      (await requireCookingContentReadVersion(session)) === schemaVersion,
  );
  await retainVerifiedRevisions(session, snapshot, refs, sha256);
}

async function retainVerifiedRevisions(
  session: SqlSession,
  snapshot: EffectiveContentSnapshot,
  refs: readonly RecipeContentRef[],
  sha256: (text: string) => Promise<string>,
): Promise<void> {
  contentStored(
    snapshot?.trust === 'signature_verified' &&
      snapshot.mediaBytes === 'verified_by_host' &&
      snapshot.ancestry === 'resolved_by_host' &&
      Array.isArray(refs) &&
      refs.length <= OVERLAY_LIMITS.retainedRefs,
  );
  const owned = JSON.parse(canonicalContentJson(refs, 512 * 1024)) as RecipeContentRef[];
  contentStored(
    owned.every(validateRecipeContentRef) &&
      new Set(owned.map((ref) => canonicalContentJson(ref))).size === owned.length,
  );
  const revisions = owned.map((ref) => {
    const result = snapshot.lookupExact(ref);
    contentStored(
      result.kind === 'readable' &&
        canonicalContentJson(result.value.revision.ref) === canonicalContentJson(ref),
    );
    return result.value.revision;
  });
  for (const revision of revisions)
    await retainCookingRevisionInSnapshot(session, revision, sha256);
}
export async function readAdoptionInSnapshot(
  session: SqlSession,
): Promise<Immutable<{ revision: number; head: OverlayHead | null }>> {
  await requireCookingContentReadVersion(session);
  const rows = await session.all<{
    revision: number;
    head: string | null;
    invalid: number;
  }>(`SELECT revision,CASE WHEN head_json IS NULL OR (typeof(head_json)='text' AND length(CAST(head_json AS BLOB))<=1024) THEN head_json ELSE NULL END head,
    CASE WHEN head_json IS NULL OR (typeof(head_json)='text' AND length(CAST(head_json AS BLOB))<=1024) THEN 0 ELSE 1 END invalid FROM app_content_adoption WHERE singleton=1`);
  const row = rows[0];
  contentStored(
    rows.length === 1 &&
      row &&
      row.invalid === 0 &&
      Number.isSafeInteger(row.revision) &&
      row.revision >= 0,
  );
  const head: unknown = row.head === null ? null : JSON.parse(row.head);
  contentStored(head === null || validateOverlayHead(head));
  return freezeResult({ revision: row.revision, head });
}
interface PinRow {
  recipeId: string;
  revisionId: string | null;
  contentFingerprint: string | null;
  reason: ContentPinReason | null;
}
function pin(row: PinRow): CookingContentPin {
  if (row.reason !== null) {
    contentStored(
      CONTENT_PIN_REASONS.includes(row.reason) &&
        row.revisionId === null &&
        row.contentFingerprint === null,
    );
    return { kind: 'unresolved', reason: row.reason };
  }
  const ref = {
    recipeId: row.recipeId,
    revisionId: row.revisionId,
    contentFingerprint: row.contentFingerprint,
  };
  contentStored(validateRecipeContentRef(ref));
  return { kind: 'exact', ref };
}
function page(input: { after?: string; limit?: number }) {
  const limit = input.limit ?? COOKING_CONTENT_LIMITS.page;
  contentStored(
    Number.isSafeInteger(limit) &&
      limit > 0 &&
      limit <= COOKING_CONTENT_LIMITS.page &&
      (input.after === undefined || isAppId(input.after)),
  );
  return { after: input.after ?? '', limit };
}
export async function readPlanContentPins(
  session: SqlSession,
  input: { after?: string; limit?: number } = {},
) {
  await requireCookingContentReadVersion(session);
  const { after, limit } = page(input);
  await admitCookingScalarColumns(session, 'plan_content_pin', [
    ['occurrence_id', 36],
    ...pinBounds.slice(0, 3),
  ]);
  const rows = await session.all<{
    occurrenceId: string;
    recipeId: string;
    revisionId: string;
    contentFingerprint: string;
  }>(
    'SELECT occurrence_id occurrenceId,recipe_id recipeId,revision_id revisionId,content_fingerprint contentFingerprint FROM plan_content_pin WHERE occurrence_id>? ORDER BY occurrence_id LIMIT ?',
    [after, limit + 1],
  );
  const items = rows.slice(0, limit).map(({ occurrenceId, ...ref }) => {
    contentStored(isAppId(occurrenceId) && validateRecipeContentRef(ref));
    return { occurrenceId, ref };
  });
  return freezeResult({
    items,
    nextAfter: rows.length > limit ? items.at(-1)!.occurrenceId : null,
  });
}
const joinedPinColumns =
  's.recipe_id pin_recipe_id,s.revision_id pin_revision_id,s.content_fingerprint pin_content_fingerprint,s.unresolved_reason pin_reason';
function joinedPin(row: Record<string, SqlValue>) {
  contentStored(typeof row.pin_recipe_id === 'string');
  return pin({
    recipeId: row.pin_recipe_id,
    revisionId: row.pin_revision_id as string | null,
    contentFingerprint: row.pin_content_fingerprint as string | null,
    reason: row.pin_reason as ContentPinReason | null,
  });
}
/** A hash match is local integrity only, never publication trust or permission to expose a body. */
async function readRetainedCookingRevision(
  session: SqlSession,
  ref: RecipeContentRef,
  sha256: CookingPinHash,
) {
  const rows = await session.all<{ document: string | null; kind: string | null }>(
    `SELECT CASE WHEN kind IN ('imported','authored') THEN kind ELSE NULL END kind,
      CASE WHEN typeof(revision_json)='text' AND length(CAST(revision_json AS BLOB))<=? THEN revision_json ELSE NULL END document FROM recipe_content_revision WHERE recipe_id=? AND revision_id=? AND content_fingerprint=?`,
    [COOKING_CONTENT_LIMITS.revisionBytes, ref.recipeId, ref.revisionId, ref.contentFingerprint],
  );
  contentStored(rows.length === 1 && typeof rows[0]!.document === 'string');
  const revision = await readRecipeContentRevision(JSON.parse(rows[0]!.document), sha256);
  contentStored(
    rows[0]!.kind === revision.document.kind &&
      canonicalContentJson(ref) === canonicalContentJson(revision.ref),
  );
  if (revision.document.kind === 'imported')
    contentStored(await bundledImportedSourceVerifier.verify(revision.document));
  return revision;
}
/** Cache only small proof fields, never complete recipe bodies, within one SQL snapshot. */
function retainedCookingEvidence(session: SqlSession, sha256: CookingPinHash) {
  const cache = new Map<
    string,
    Promise<{ title: string; passages: ReadonlySet<number>; media: ReadonlySet<string> }>
  >();
  return (ref: RecipeContentRef) => {
    const key = canonicalContentJson(ref);
    let evidence = cache.get(key);
    if (!evidence) {
      evidence = readRetainedCookingRevision(session, ref, sha256).then((revision) => ({
        title: revision.document.recipe.title,
        passages: new Set(revision.document.recipe.instructions.map((passage) => passage.sequence)),
        media: new Set(
          revision.document.media
            .filter((media) => media.recipeId === ref.recipeId)
            .map((media) => media.assetId),
        ),
      }));
      cache.set(key, evidence);
    }
    return evidence;
  };
}
type RetainedCookingEvidence = ReturnType<typeof retainedCookingEvidence>;
async function checkSessionRow(
  row: Record<string, SqlValue>,
  prove: ReturnType<typeof createLegacyCookingPinProof>,
  readEvidence: RetainedCookingEvidence,
) {
  const value = parseCookingSessionRow(row),
    actual = joinedPin(row);
  contentStored(row.pin_recipe_id === value.recipeId);
  if (value.readerVersion === 1) {
    contentStored(canonicalContentJson(actual) === canonicalContentJson(await prove(value)));
  } else {
    contentStored(
      actual.kind === 'exact' &&
        canonicalContentJson(actual.ref) === canonicalContentJson(value.contentRef),
    );
    const evidence = await readEvidence(value.contentRef);
    contentStored(evidence.passages.has(value.passageSequence));
  }
  return { session: value, pin: actual };
}
/** Local integrity only. Body visibility and publication trust remain with the verified-content host. */
export async function readStoredCookingSession(
  session: SqlSession,
  recipeId: string,
  options: { sha256: CookingPinHash },
) {
  await requireCookingContentReadVersion(session);
  contentStored(typeof recipeId === 'string' && /^[0-9]{1,20}$/.test(recipeId));
  await admitRetainedCookingRevisions(session);
  await admitCookingSessionRows(session);
  await admitCookingScalarColumns(session, 'cooking_session_content_pin', [
    ['session_id', 36],
    ...pinBounds,
  ]);
  const [row] = await session.all<Record<string, SqlValue>>(
    `SELECT p.*,${joinedPinColumns} FROM cooking_session p LEFT JOIN cooking_session_content_pin s ON s.recipe_id=p.recipe_id AND s.session_id=p.session_id WHERE p.recipe_id=?`,
    [recipeId],
  );
  if (!row) return null;
  return freezeResult(
    await checkSessionRow(
      row,
      createLegacyCookingPinProof(options.sha256),
      retainedCookingEvidence(session, options.sha256),
    ),
  );
}
export async function readSessionContentPin(
  session: SqlSession,
  recipeId: string,
  options: { sha256: CookingPinHash },
) {
  const result = await readStoredCookingSession(session, recipeId, options);
  return result
    ? freezeResult({
        recipeId: result.session.recipeId,
        sessionId: result.session.sessionId,
        pin: result.pin,
      })
    : null;
}
async function admitHistoryPins(
  session: SqlSession,
  source: HistoryPinSource,
  ownerId: string | null,
) {
  if (source === 'account') {
    contentStored(ownerId === null || isAppId(ownerId));
    for (const table of [
      'account_cooking_history',
      'account_cooking_history_removed',
      'account_history_content_pin',
    ])
      contentStored(
        (
          await session.all(
            `SELECT 1 FROM ${table} ${ownerId === null ? '' : 'WHERE owner_id IS NOT ?'} LIMIT 1`,
            ownerId === null ? [] : [ownerId],
          )
        ).length === 0,
      );
    const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
      ?.user_version;
    if (version === 8 && ownerId !== null)
      await admitAccountContentHistoryProjection(session, ownerId);
  }
  if (source === 'local') {
    await admitLocalCookingEvents(session);
    contentStored(
      (
        await session.all(
          `SELECT 1 FROM local_history_content_pin s JOIN cooking_event p ON p.event_id=s.event_id WHERE p.state<>'saved' LIMIT 1`,
        )
      ).length === 0,
    );
  } else await admitLegacyHistoryRows(session, source);
  if (source === 'backup')
    contentStored(
      (
        await session.all(
          `SELECT 1 FROM imported_cooking_history p LEFT JOIN portable_restore_operation r ON r.operation_id=p.restore_operation_id WHERE r.operation_id IS NULL LIMIT 1`,
        )
      ).length === 0,
    );
  await admitCookingScalarColumns(session, historyPins[source], [
    ['event_id', 36],
    ...(source === 'account' ? [['owner_id', 36] as const] : []),
    ...pinBounds,
  ]);
  contentStored(
    (
      await session.all(
        `SELECT 1 FROM ${historyPins[source]} s LEFT JOIN ${historyTables[source]} p ON p.event_id=s.event_id ${source === 'account' ? 'AND p.owner_id=s.owner_id' : ''} WHERE p.event_id IS NULL LIMIT 1`,
      )
    ).length === 0,
  );
  // Exact mirrors may be deduplicated before selected entries receive retained-body proof.
  // Check every exact parent's pin in SQL so a hidden duplicate cannot conceal a bad ref.
  const payload = source === 'local' ? 'p.receipt_json' : 'p.entry_json';
  const entryPath = source === 'local' ? '$.event' : '$';
  contentStored(
    (
      await session.all(
        `SELECT 1 FROM ${historyTables[source]} p LEFT JOIN ${historyPins[source]} s
      ON s.event_id=p.event_id ${source === 'account' ? 'AND s.owner_id=p.owner_id' : ''}
      WHERE ${source === 'local' ? "p.state='saved' AND" : ''}
      json_extract(${payload},'${entryPath}.readerVersion')=2 AND
      (s.event_id IS NULL OR s.unresolved_reason IS NOT NULL OR
        s.recipe_id IS NOT json_extract(${payload},'${entryPath}.recipeId') OR
        s.recipe_id IS NOT json_extract(${payload},'${entryPath}.contentRef.recipeId') OR
        s.revision_id IS NOT json_extract(${payload},'${entryPath}.contentRef.revisionId') OR
        s.content_fingerprint IS NOT json_extract(${payload},'${entryPath}.contentRef.contentFingerprint')) LIMIT 1`,
      )
    ).length === 0,
  );
}
function parseCookingHistoryRow(
  source: HistoryPinSource,
  row: Record<string, SqlValue>,
  ownerId: string | null,
  accountExact = false,
) {
  const serialized = source === 'local' ? row.receipt_json : row.entry_json;
  contentStored(typeof serialized === 'string' && hasUniqueHistoryJsonKeys(serialized));
  if (source === 'local') {
    contentStored(typeof row.receipt_json === 'string');
    const receipt: unknown = JSON.parse(row.receipt_json);
    if (validateContentCookedReceipt(receipt) && receipt.kind === 'saved') {
      const value = receipt.event;
      contentStored(
        row.state === 'saved' &&
          value.eventId === row.event_id &&
          value.historyEpoch === row.history_epoch &&
          value.cookedOn === row.cooked_on &&
          value.recordedAt === row.recorded_at &&
          hash(row.request_fingerprint),
      );
      return value;
    }
  } else if (source === 'backup') {
    contentStored(typeof row.entry_json === 'string');
    const entry: unknown = JSON.parse(row.entry_json);
    if (validateImportedContentCookingHistoryEntry(entry)) {
      contentStored(
        entry.eventId === row.event_id &&
          entry.historyEpoch === row.history_epoch &&
          entry.cookedOn === row.cooked_on &&
          entry.recordedAt === row.recorded_at &&
          isAppId(row.source_event_id) &&
          isAppId(row.restore_operation_id),
      );
      return entry;
    }
  } else if (source === 'account' && accountExact) {
    contentStored(
      ownerId !== null &&
        row.owner_id === ownerId &&
        typeof row.event_id === 'string' &&
        typeof row.entry_json === 'string',
    );
    return parseAccountContentHistoryEntry(row.event_id, row.entry_json);
  }
  return parseLegacyHistoryRow(source, row, ownerId);
}
async function checkHistoryRow(
  source: HistoryPinSource,
  row: Record<string, SqlValue>,
  ownerId: string | null,
  prove: ReturnType<typeof createLegacyCookingPinProof>,
  readEvidence: RetainedCookingEvidence,
  accountExact = false,
) {
  const value = parseCookingHistoryRow(source, row, ownerId, accountExact),
    actual = joinedPin(row);
  contentStored(row.pin_recipe_id === value.recipeId);
  if (value.readerVersion === 2) {
    contentStored(
      actual.kind === 'exact' &&
        canonicalContentJson(actual.ref) === canonicalContentJson(value.contentRef),
    );
    const evidence = await readEvidence(value.contentRef);
    contentStored(
      evidence.title === value.recipeTitle &&
        (value.photoAssetId === null || evidence.media.has(value.photoAssetId)),
    );
    if (source === 'local') {
      const receipt: unknown = JSON.parse(row.receipt_json as string);
      contentStored(validateContentCookedReceipt(receipt) && receipt.kind === 'saved');
      contentStored(
        receipt.closedSession === null ||
          evidence.passages.has(receipt.closedSession.passageSequence),
      );
    } else contentStored(source === 'backup' || (source === 'account' && accountExact));
  } else contentStored(canonicalContentJson(actual) === canonicalContentJson(await prove(value)));
  return { value, pin: actual };
}
/** Validated local history, not proof that a caller owns its operation. Hosts must bind authority separately. */
export async function readStoredLocalCookingEvent(
  session: SqlSession,
  eventId: string,
  options: { sha256: CookingPinHash },
) {
  await requireCookingContentReadVersion(session);
  contentStored(isAppId(eventId));
  await admitRetainedCookingRevisions(session);
  await admitHistoryPins(session, 'local', null);
  const rows = await session.all<Record<string, SqlValue>>(
    `SELECT p.*,${joinedPinColumns} FROM cooking_event p LEFT JOIN local_history_content_pin s ON s.event_id=p.event_id WHERE p.event_id=?`,
    [eventId],
  );
  contentStored(rows.length <= 1);
  const row = rows[0];
  if (!row) return null;
  if (row.state !== 'saved') {
    contentStored(
      (row.state === 'cleared' || row.state === 'cancelled') &&
        isRevision(row.history_epoch) &&
        row.pin_recipe_id === null,
    );
    return freezeResult({
      receipt: {
        kind: row.state,
        eventId,
        historyEpoch: row.history_epoch,
      } as ContentCookedReceipt,
      pin: null,
      requestFingerprint: null,
    });
  }
  const checked = await checkHistoryRow(
    'local',
    row,
    null,
    createLegacyCookingPinProof(options.sha256),
    retainedCookingEvidence(session, options.sha256),
  );
  const receipt = JSON.parse(row.receipt_json as string) as CookedReceipt | ContentCookedReceipt;
  return freezeResult({
    receipt,
    pin: checked.pin,
    requestFingerprint: row.request_fingerprint as string,
  });
}
async function historyPinPage(
  session: SqlSession,
  input: { source: HistoryPinSource; ownerId: string | null; after: string; limit: number },
  prove: ReturnType<typeof createLegacyCookingPinProof>,
  readEvidence: RetainedCookingEvidence,
  accountExact = false,
) {
  const { source, ownerId, after, limit } = input;
  const rows = await session.all<Record<string, SqlValue>>(
    `SELECT p.*,${joinedPinColumns} FROM ${historyTables[source]} p LEFT JOIN ${historyPins[source]} s ON s.event_id=p.event_id ${source === 'account' ? 'AND s.owner_id=p.owner_id' : ''} WHERE p.event_id>? ${source === 'local' ? "AND p.state='saved'" : ''} ${source === 'account' ? 'AND p.owner_id=?' : ''} ORDER BY p.event_id LIMIT ?`,
    [after, ...(source === 'account' ? [ownerId] : []), limit + 1],
  );
  const items = [];
  for (const row of rows.slice(0, limit)) {
    const { value, pin: actual } = await checkHistoryRow(
      source,
      row,
      ownerId,
      prove,
      readEvidence,
      accountExact,
    );
    items.push({
      source,
      ...(ownerId ? { ownerId } : {}),
      eventId: value.eventId,
      recipeId: value.recipeId,
      pin: actual,
    });
  }
  return { items, nextAfter: rows.length > limit ? items.at(-1)!.eventId : null };
}
export async function readHistoryContentPins(
  session: SqlSession,
  input: {
    source: 'local' | 'backup' | 'account';
    ownerId?: string;
    after?: string;
    limit?: number;
    sha256: CookingPinHash;
  },
) {
  const version = await requireCookingContentReadVersion(session);
  await admitRetainedCookingRevisions(session);
  const { after, limit } = page(input);
  contentStored(Object.hasOwn(historyTables, input.source));
  if (input.source === 'account') {
    contentStored(isAppId(input.ownerId) && (await readBinding(session)) === input.ownerId);
  } else contentStored(input.ownerId === undefined);
  await admitHistoryPins(session, input.source, input.ownerId ?? null);
  return freezeResult(
    await historyPinPage(
      session,
      { source: input.source, ownerId: input.ownerId ?? null, after, limit },
      createLegacyCookingPinProof(input.sha256),
      retainedCookingEvidence(session, input.sha256),
      version === 8,
    ),
  );
}

/** Bounded selected history data and pins; the result never grants action or body authority. */
export async function readStoredCookingHistoryEntries(
  session: SqlSession,
  input: { keys: readonly { source: HistoryPinSource; eventId: string }[]; sha256: CookingPinHash },
) {
  return withStoredCookingHistoryEntries(session, input.sha256, (read) => read(input.keys));
}

type HistoryEntryKey = { source: HistoryPinSource; eventId: string };
type StoredHistoryEntry = { source: HistoryPinSource } & Awaited<
  ReturnType<typeof checkHistoryRow>
>;
/** Reuse finite proof fields across export pages in one caller-owned SQL snapshot. */
export async function withStoredCookingHistoryEntries<Value>(
  session: SqlSession,
  sha256: CookingPinHash,
  work: (
    read: (keys: readonly HistoryEntryKey[]) => Promise<Immutable<StoredHistoryEntry[]>>,
  ) => Promise<Value>,
): Promise<Value> {
  const version = await requireCookingContentReadVersion(session);
  await admitRetainedCookingRevisions(session);
  const ownerId = await readBinding(session),
    prove = createLegacyCookingPinProof(sha256),
    readEvidence = retainedCookingEvidence(session, sha256);
  for (const source of ['local', 'backup', 'account'] as const) {
    await admitHistoryPins(session, source, source === 'account' ? ownerId : null);
  }
  let active = true;
  const read = async (
    keys: readonly HistoryEntryKey[],
  ): Promise<Immutable<StoredHistoryEntry[]>> => {
    contentStored(active);
    contentStored(
      Array.isArray(keys) &&
        keys.length <= COOKING_CONTENT_LIMITS.page &&
        keys.every((key) => Object.hasOwn(historyTables, key.source) && isAppId(key.eventId)) &&
        new Set(keys.map((key) => `${key.source}:${key.eventId}`)).size === keys.length,
    );
    const ownedKeys = keys.map((key) => ({ source: key.source, eventId: key.eventId }));
    const result: StoredHistoryEntry[] = [];
    for (const source of ['local', 'backup', 'account'] as const) {
      const ids = ownedKeys.filter((key) => key.source === source).map((key) => key.eventId);
      if (!ids.length) continue;
      const rows = await session.all<Record<string, SqlValue>>(
        `SELECT p.*,${joinedPinColumns} FROM ${historyTables[source]} p LEFT JOIN ${historyPins[source]} s ON s.event_id=p.event_id ${source === 'account' ? 'AND s.owner_id=p.owner_id' : ''} WHERE p.event_id IN (${ids.map(() => '?').join(',')}) ${source === 'local' ? "AND p.state='saved'" : ''} ${source === 'account' ? 'AND p.owner_id=?' : ''}`,
        [...ids, ...(source === 'account' ? [ownerId] : [])],
      );
      contentStored(active && rows.length === ids.length);
      for (const row of rows) {
        const checked = await checkHistoryRow(
          source,
          row,
          source === 'account' ? ownerId : null,
          prove,
          readEvidence,
          version === 8,
        );
        contentStored(active);
        result.push({ source, ...checked });
      }
    }
    contentStored(active);
    return freezeResult(result);
  };
  try {
    return await work(read);
  } finally {
    active = false;
  }
}

/** Exact local integrity for every plan pin; no archive/body-access authority is inferred. */
export async function verifyPlanContentBindings(session: SqlSession, sha256: CookingPinHash) {
  await requireCookingContentReadVersion(session);
  await admitRetainedCookingRevisions(session);
  await admitCookingScalarColumns(session, 'plan_occurrence', [
    ['occurrence_id', 36],
    ['recipe_id', 20],
  ]);
  await admitCookingScalarColumns(session, 'plan_content_pin', [
    ['occurrence_id', 36],
    ...pinBounds.slice(0, 3),
  ]);
  const [usage] = await session.all<{ count: number }>(
    'SELECT COUNT(*) count FROM plan_occurrence',
  );
  contentStored(usage && isRevision(usage.count) && usage.count <= 20_000);
  contentStored(
    (
      await session.all(
        'SELECT 1 FROM plan_occurrence WHERE length(CAST(occurrence_id AS BLOB))<>36 OR occurrence_id NOT GLOB ? LIMIT 1',
        [uuidGlob],
      )
    ).length === 0,
  );
  contentStored(
    (
      await session.all(
        `SELECT 1 FROM plan_occurrence p LEFT JOIN plan_content_pin s ON s.occurrence_id=p.occurrence_id AND s.recipe_id=p.recipe_id WHERE s.occurrence_id IS NULL LIMIT 1`,
      )
    ).length === 0,
  );
  contentStored(
    (
      await session.all(
        `SELECT 1 FROM plan_content_pin s LEFT JOIN plan_occurrence p ON p.occurrence_id=s.occurrence_id AND p.recipe_id=s.recipe_id WHERE p.occurrence_id IS NULL LIMIT 1`,
      )
    ).length === 0,
  );
  const readEvidence = retainedCookingEvidence(session, sha256);
  let after = '';
  for (;;) {
    const rows = await session.all<{
      occurrenceId: string;
      recipeId: string;
      revisionId: string;
      contentFingerprint: string;
    }>(
      'SELECT occurrence_id occurrenceId,recipe_id recipeId,revision_id revisionId,content_fingerprint contentFingerprint FROM plan_content_pin WHERE occurrence_id>? ORDER BY occurrence_id LIMIT ?',
      [after, COOKING_CONTENT_LIMITS.page],
    );
    if (!rows.length) break;
    for (const { occurrenceId, ...ref } of rows) {
      contentStored(isAppId(occurrenceId) && validateRecipeContentRef(ref));
      await readEvidence(ref);
    }
    after = rows.at(-1)!.occurrenceId;
  }
}

async function verifyHistoryBindings(
  session: SqlSession,
  prove: ReturnType<typeof createLegacyCookingPinProof>,
  readEvidence: RetainedCookingEvidence,
) {
  const version = await requireCookingContentReadVersion(session);
  const ownerId = await readBinding(session);
  for (const source of ['local', 'backup', 'account'] as const) {
    await admitHistoryPins(session, source, source === 'account' ? ownerId : null);
    let cursor = '';
    for (;;) {
      const result = await historyPinPage(
        session,
        {
          source,
          ownerId: source === 'account' ? ownerId : null,
          after: cursor,
          limit: COOKING_CONTENT_LIMITS.page,
        },
        prove,
        readEvidence,
        version === 8,
      );
      if (result.nextAfter === null) break;
      cursor = result.nextAfter;
    }
  }
}

/** Review of history only. This preserves closed/withdrawn metadata without authorizing body access. */
export async function verifyHistoryContentBindings(session: SqlSession, sha256: CookingPinHash) {
  await requireCookingContentReadVersion(session);
  await admitRetainedCookingRevisions(session);
  await verifyHistoryBindings(
    session,
    createLegacyCookingPinProof(sha256),
    retainedCookingEvidence(session, sha256),
  );
}

/** Reopen checks preserved parents and exact refs; it never repairs, upgrades, or authorizes body access. */
export async function verifyCookingPinBindings(session: SqlSession, sha256: CookingPinHash) {
  const prove = createLegacyCookingPinProof(sha256);
  const readEvidence = retainedCookingEvidence(session, sha256);
  await admitRetainedCookingRevisions(session);
  await admitCookingSessionRows(session);
  await admitCookingScalarColumns(session, 'cooking_session_content_pin', [
    ['session_id', 36],
    ...pinBounds,
  ]);
  let after = '';
  for (;;) {
    const rows = await session.all<Record<string, SqlValue>>(
      `SELECT p.*,${joinedPinColumns} FROM cooking_session p LEFT JOIN cooking_session_content_pin s ON s.recipe_id=p.recipe_id AND s.session_id=p.session_id WHERE p.recipe_id>? ORDER BY p.recipe_id LIMIT ?`,
      [after, COOKING_CONTENT_LIMITS.page],
    );
    if (!rows.length) break;
    for (const row of rows) await checkSessionRow(row, prove, readEvidence);
    after = rows.at(-1)!.recipe_id as string;
  }
  await verifyHistoryBindings(session, prove, readEvidence);
}
