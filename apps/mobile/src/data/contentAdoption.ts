import type { Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledContentSnapshot,
  createContentReader,
  validateOverlayHead,
  validateRecipeContentRef,
  type OverlayHead,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import {
  MEAL_KEYS,
  isUtcInstant,
  validatePlanOccurrence,
  type PlanOccurrence,
} from '@cookmate/contracts';
import { reconcilePurchaseState } from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import { isAppId } from './conversationRecords';
import {
  admitCookingScalarColumns,
  readAdoptionInSnapshot,
  requireCookingContentReadVersion,
  retainVerifiedRevisionsForSchemaInSnapshot,
  verifyCookingPinBindings,
} from './cookingContentRepository';
import type { openContentReleaseStore } from './contentReleaseStore';
import { readPinnedShoppingContextInSnapshot } from './pinnedShoppingRepository';
import {
  buildRevisionShoppingProjection,
  type PinnedShoppingOccurrence,
  type ShoppingRevisionNotice,
} from './revisionShoppingProjection';
import {
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
  nextStoredRevision,
  type ShoppingLedger,
} from './shoppingRepository';
import { freezeResult } from './query';
import { readRestoreEpoch } from './restoreEpoch';
import {
  runBound,
  type SerializedReader,
  type SerializedWriter,
  type SqlSession,
  type SqlValue,
} from './sql';

const LIMITS = Object.freeze({
  plans: 20_000,
  changes: 1000,
  refs: 1000,
  bytes: 8 * 1024 * 1024,
  receipt: 16384,
});
export interface ContentAdoptionAccess {
  ownerId: string | null;
  authGeneration: number;
}
export interface ContentAdoptionOwner {
  installationId: string;
  ownerId: string | null;
}
/** Read-only local release context; retained references do not confer publication authority. */
export interface ContentReleaseContext extends ContentAdoptionOwner {
  adoptedHead: OverlayHead | null;
  adoptionRevision: number;
  storeRevision: number;
  restoreEpoch: number;
  retainedRefs: readonly RecipeContentRef[];
  unresolvedHistoryOrSessionCount: number;
  contextFingerprint: string;
}
export interface ContentAdoptionChange {
  occurrenceId: string;
  expectedRef: RecipeContentRef;
  targetRef: RecipeContentRef;
}
export interface ContentAdoptionRequest {
  candidateHead: OverlayHead;
  changes?: readonly ContentAdoptionChange[];
}
export const CONTENT_ADOPTION_CHOICE_PAGE_SIZE = 20;
export const CONTENT_ADOPTION_CHANGE_LIMIT = LIMITS.changes;
export interface ContentAdoptionMealChoice {
  occurrence: PlanOccurrence;
  current: {
    contentRef: RecipeContentRef;
    title: string | null;
    state: 'readable' | 'unavailable';
  };
  target: { contentRef: RecipeContentRef; title: string } | null;
}
export interface ContentAdoptionMealChoices {
  candidateHead: OverlayHead;
  contextFingerprint: string;
  total: number;
  offset: number;
  items: ContentAdoptionMealChoice[];
  nextOffset: number | null;
}
export interface ContentAdoptionMealChoicesRequest {
  candidateHead: OverlayHead;
  offset?: number;
  expectedContextFingerprint?: string;
}
export interface ContentAdoptionReceipt extends ContentAdoptionOwner {
  formatVersion: 1;
  status: 'adopted_in_cooking_store';
  operationId: string;
  requestFingerprint: string;
  previousHead: OverlayHead | null;
  head: OverlayHead;
  adoptionRevision: number;
  storeRevision: number;
  planRevision: number;
  shoppingRevision: number;
  changedOccurrences: number;
  shoppingRebuilt: boolean;
  committedAt: string;
}
export interface ContentAdoptionReview extends ContentAdoptionOwner {
  operationId: string;
  requestFingerprint: string;
  previousHead: OverlayHead | null;
  candidateHead: OverlayHead;
  expectedStoreRevision: number;
  expectedAdoptionRevision: number;
  changes: readonly ContentAdoptionChange[];
  preservedPlanCount: number;
  unresolvedHistoryOrSessionCount: number;
  withdrawnRefs: readonly RecipeContentRef[];
  shopping: {
    selectedOccurrences: number;
    rebuilt: boolean;
    groups: readonly {
      groupKey: string;
      displayName: string;
      previousQuantity: string | null;
      quantity: string | null;
      previousPurchased: boolean;
      purchased: boolean;
      changed: boolean;
    }[];
    notices: readonly ShoppingRevisionNotice[];
  };
}
export class ContentAdoptionError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'access_changed'
      | 'review_changed'
      | 'operation_conflict'
      | 'stored_data_invalid'
      | 'too_large'
      | 'content_unavailable',
  ) {
    super(`Content adoption: ${code}`);
    this.name = 'ContentAdoptionError';
  }
}
function requireValue(
  value: unknown,
  code: ContentAdoptionError['code'] = 'stored_data_invalid',
): asserts value {
  if (!value) throw new ContentAdoptionError(code);
}
const same = (left: unknown, right: unknown) =>
  canonicalContentJson(left, LIMITS.bytes) === canonicalContentJson(right, LIMITS.bytes);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
async function requireAdoptionSchema(session: SqlSession, expected: 7 | 8) {
  requireValue((await requireCookingContentReadVersion(session)) === expected);
}
type Store = Pick<Awaited<ReturnType<typeof openContentReleaseStore>>, 'withVerifiedAdoption'>;
interface Options {
  /** Explicit host admission. Existing callers remain schema7; this never migrates a store. */
  cookingSchemaVersion?: 7 | 8;
  reader: SerializedReader;
  writer: SerializedWriter;
  contentStore: Store;
  sha256(text: string): Promise<string>;
  now(): string;
  newId(): string;
  /** null is unavailable, not a guest. An active guest requires an explicit ownerId:null scope. */
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
}
interface Capture extends ContentAdoptionOwner {
  storeRevision: number;
  planRevision: number;
  shoppingRevision: number;
  restoreEpoch: number;
  adoption: { revision: number; head: OverlayHead | null };
  plans: PinnedShoppingOccurrence[];
  sidecars: Record<string, SqlValue>[][];
  refs: RecipeContentRef[];
  cooking: Record<string, SqlValue>;
  scope: Record<string, SqlValue>;
  selection: string[];
}
interface Capability {
  scope: ContentAdoptionAccess;
  capture: Capture;
  captureFingerprint: string;
  retainedRefs: RecipeContentRef[];
  preserveWithdrawnRefs: RecipeContentRef[];
  review: Immutable<ContentAdoptionReview>;
  previewFingerprint: string;
}

function unresolvedCount(value: Capture): number {
  return value.sidecars.reduce(
    (count, rows) => count + rows.filter((row) => row.unresolved_reason !== null).length,
    0,
  );
}

/** Every SQL/hash boundary checks the captured live access; cleanup always remains permitted. */
function guarded(session: SqlSession, check: () => undefined): SqlSession {
  return {
    async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
      check();
      const result = await session.all<Row>(sql, values);
      check();
      return result;
    },
    async exec(sql) {
      check();
      await session.exec(sql);
      check();
    },
    async prepare(sql) {
      check();
      const statement = await session.prepare(sql);
      check();
      return {
        async run(values) {
          check();
          await statement.run(values);
          check();
        },
        finalize: () => statement.finalize(),
      };
    },
  };
}
async function admit(
  session: SqlSession,
  table: string,
  count: number,
  columns: readonly (readonly [string, number, boolean?])[],
  integers: readonly string[] = [],
) {
  const value = (
    await session.all<{ count: number; bytes: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(${[...columns.map(([column]) => `COALESCE(length(CAST(${column} AS BLOB)),0)`), ...integers.map((column) => `COALESCE(length(CAST(${column} AS BLOB)),0)`)].join('+')}),0) bytes FROM ${table}`,
    )
  )[0];
  requireValue(value && value.count <= count && value.bytes <= LIMITS.bytes, 'too_large');
  if (columns.length) await admitCookingScalarColumns(session, table, columns);
  if (integers.length)
    requireValue(
      (
        await session.all(
          `SELECT 1 FROM ${table} WHERE ${integers.map((column) => `typeof(${column})<>'integer' OR ${column}<0 OR ${column}>9007199254740991`).join(' OR ')} LIMIT 1`,
        )
      ).length === 0,
    );
  return value.bytes;
}
function uniqueRefs(refs: readonly RecipeContentRef[]) {
  const values = [...new Map(refs.map((ref) => [canonicalContentJson(ref), ref])).values()];
  requireValue(values.length <= LIMITS.refs && values.every(validateRecipeContentRef), 'too_large');
  return values.sort((a, b) => {
    const x = canonicalContentJson(a),
      y = canonicalContentJson(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}
async function binding(
  session: SqlSession,
  scope: ContentAdoptionAccess,
): Promise<ContentAdoptionOwner> {
  const row = (
    await session.all<{ value: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value ELSE NULL END value FROM app_metadata WHERE key='installation_id'",
    )
  )[0];
  const ownerId = await readBinding(session);
  requireValue(row && isAppId(row.value));
  requireValue(ownerId === scope.ownerId, 'access_changed');
  return { installationId: row.value, ownerId };
}
async function capture(
  session: SqlSession,
  scope: ContentAdoptionAccess,
  sha256: Options['sha256'],
  schemaVersion: 7 | 8,
): Promise<Capture> {
  await requireAdoptionSchema(session, schemaVersion);
  const owner = await binding(session, scope);
  await admit(session, 'state_revision', 6, [['collection', 20]], ['revision']);
  const revisions = await session.all<{ collection: string; revision: number }>(
    'SELECT collection,revision FROM state_revision',
  );
  const get = (key: string) => {
    const value = revisions.find((row) => row.collection === key)?.revision;
    requireValue(revision(value));
    return value;
  };
  let admittedBytes = await admit(
    session,
    'plan_occurrence',
    LIMITS.plans,
    [
      ['occurrence_id', 36],
      ['recipe_id', 20],
      ['local_date', 10],
      ['meal_key', 12],
      ['created_at', 40],
      ['updated_at', 40],
    ],
    ['revision'],
  );
  admittedBytes += await admit(session, 'plan_content_pin', LIMITS.plans, [
    ['occurrence_id', 36],
    ['recipe_id', 20],
    ['revision_id', 120],
    ['content_fingerprint', 64],
  ]);
  requireValue(admittedBytes <= LIMITS.bytes, 'too_large');
  const rows = await session.all<Record<string, SqlValue>>(
    'SELECT p.*,s.revision_id,s.content_fingerprint,s.recipe_id pin_recipe_id FROM plan_occurrence p LEFT JOIN plan_content_pin s ON s.occurrence_id=p.occurrence_id ORDER BY p.occurrence_id',
  );
  const plans = rows.map((row) => {
    const occurrence = {
      occurrenceId: row.occurrence_id,
      recipeId: row.recipe_id,
      placement: { actualDate: row.local_date, mealKey: row.meal_key },
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const contentRef = {
      recipeId: row.pin_recipe_id,
      revisionId: row.revision_id,
      contentFingerprint: row.content_fingerprint,
    };
    requireValue(
      validatePlanOccurrence(occurrence) &&
        validateRecipeContentRef(contentRef) &&
        occurrence.recipeId === contentRef.recipeId &&
        isUtcInstant(occurrence.createdAt) &&
        isUtcInstant(occurrence.updatedAt),
    );
    return { occurrence, contentRef };
  });
  requireValue(
    (await session.all<{ count: number }>('SELECT COUNT(*) count FROM plan_content_pin'))[0]
      ?.count === plans.length,
  );
  await verifyCookingPinBindings(session, sha256);
  const sidecars: Record<string, SqlValue>[][] = [];
  for (const [table, parent, parentMatch] of [
    [
      'cooking_session_content_pin',
      'cooking_session',
      'p.recipe_id=s.recipe_id AND p.session_id=s.session_id',
    ],
    ['local_history_content_pin', 'cooking_event', "p.event_id=s.event_id AND p.state='saved'"],
    ['imported_history_content_pin', 'imported_cooking_history', 'p.event_id=s.event_id'],
    [
      'account_history_content_pin',
      'account_cooking_history',
      'p.owner_id=s.owner_id AND p.event_id=s.event_id',
    ],
  ] as const) {
    const key = table === 'cooking_session_content_pin' ? 'session_id' : 'event_id';
    admittedBytes += await admit(session, table, 10_000, [
      [key, 36],
      ...(table === 'account_history_content_pin' ? [['owner_id', 36] as const] : []),
      ['recipe_id', 20],
      ['revision_id', 120, true],
      ['content_fingerprint', 64, true],
      ['unresolved_reason', 32, true],
    ]);
    requireValue(admittedBytes <= LIMITS.bytes, 'too_large');
    // The parent-to-pin proof above cannot see orphan sidecars from a damaged database.
    // Reject them before their refs can enter the retained/withdrawn adoption policy.
    requireValue(
      (
        await session.all(
          `SELECT 1 FROM ${table} s WHERE NOT EXISTS (SELECT 1 FROM ${parent} p WHERE ${parentMatch}) LIMIT 1`,
        )
      ).length === 0,
    );
    sidecars.push(
      await session.all<Record<string, SqlValue>>(`SELECT * FROM ${table} ORDER BY ${key}`),
    );
  }
  const refs = uniqueRefs([
    ...plans.map((item) => item.contentRef),
    ...sidecars.flatMap((values) =>
      values.flatMap((row) =>
        row.unresolved_reason === null
          ? [
              {
                recipeId: row.recipe_id,
                revisionId: row.revision_id,
                contentFingerprint: row.content_fingerprint,
              } as RecipeContentRef,
            ]
          : [],
      ),
    ),
  ]);
  await admit(
    session,
    'cooking_state',
    1,
    [],
    ['singleton', 'session_revision', 'history_revision', 'history_epoch'],
  );
  const cooking = (
    await session.all<Record<string, SqlValue>>('SELECT * FROM cooking_state WHERE singleton=1')
  )[0];
  requireValue(cooking);
  await admit(
    session,
    'shopping_scope',
    1,
    [
      ['scope_id', 36],
      ['projection_status', 10],
    ],
    ['singleton', 'revision', 'projection_revision'],
  );
  await admit(session, 'shopping_selection', 1000, [
    ['scope_id', 36],
    ['occurrence_id', 36],
  ]);
  const selectedScope = (
    await session.all<Record<string, SqlValue>>('SELECT * FROM shopping_scope WHERE singleton=1')
  )[0];
  requireValue(
    selectedScope &&
      isAppId(selectedScope.scope_id) &&
      selectedScope.projection_status === 'current',
  );
  const selected = await session.all<{ scopeId: string; occurrenceId: string }>(
    'SELECT scope_id scopeId,occurrence_id occurrenceId FROM shopping_selection ORDER BY occurrence_id',
  );
  requireValue(
    selected.every(
      (item) =>
        item.scopeId === selectedScope.scope_id &&
        isAppId(item.occurrenceId) &&
        plans.some((plan) => plan.occurrence.occurrenceId === item.occurrenceId),
    ),
  );
  await admit(
    session,
    'app_content_adoption',
    1,
    [['head_json', 1024, true]],
    ['singleton', 'revision'],
  );
  requireValue(
    (
      await session.all(
        "SELECT 1 FROM portable_restore_operation WHERE typeof(committed_revision)<>'integer' OR committed_revision<0 OR committed_revision>9007199254740991 LIMIT 1",
      )
    ).length === 0,
  );
  const result = {
    ...owner,
    storeRevision: get('store'),
    planRevision: get('plan'),
    shoppingRevision: get('shopping'),
    restoreEpoch: await readRestoreEpoch(session),
    adoption: await readAdoptionInSnapshot(session),
    plans,
    sidecars,
    refs,
    cooking,
    scope: selectedScope,
    selection: selected.map((item) => item.occurrenceId),
  };
  canonicalContentJson(result, LIMITS.bytes);
  return freezeResult(result);
}
function request(input: ContentAdoptionRequest) {
  const value: unknown = JSON.parse(canonicalContentJson(input, 1024 * 1024));
  requireValue(
    exact(
      value,
      Object.hasOwn(input, 'changes') ? ['candidateHead', 'changes'] : ['candidateHead'],
    ) && validateOverlayHead(value.candidateHead),
    'invalid_input',
  );
  const changes = value.changes ?? [];
  requireValue(
    Array.isArray(changes) &&
      changes.length <= LIMITS.changes &&
      changes.every(
        (item) =>
          exact(item, ['occurrenceId', 'expectedRef', 'targetRef']) &&
          isAppId(item.occurrenceId) &&
          validateRecipeContentRef(item.expectedRef) &&
          validateRecipeContentRef(item.targetRef) &&
          item.expectedRef.recipeId === item.targetRef.recipeId &&
          !same(item.expectedRef, item.targetRef),
      ),
    'invalid_input',
  );
  requireValue(
    new Set(changes.map((item) => item.occurrenceId)).size === changes.length,
    'invalid_input',
  );
  return freezeResult({
    candidateHead: value.candidateHead,
    changes: changes as ContentAdoptionChange[],
  });
}
function changedPlans(before: Capture, changes: readonly ContentAdoptionChange[]) {
  const updates = new Map(changes.map((change) => [change.occurrenceId, change]));
  for (const change of changes) {
    const old = before.plans.find((item) => item.occurrence.occurrenceId === change.occurrenceId);
    requireValue(old && same(old.contentRef, change.expectedRef), 'review_changed');
  }
  return before.plans.map((item) => {
    const change = updates.get(item.occurrence.occurrenceId);
    return change ? { occurrence: item.occurrence, contentRef: change.targetRef } : item;
  });
}
function remainingRefs(before: Capture, plans: readonly PinnedShoppingOccurrence[]) {
  return uniqueRefs([
    ...plans.map((item) => item.contentRef),
    ...before.sidecars.flatMap((rows) =>
      rows.flatMap((row) =>
        row.unresolved_reason === null
          ? [
              {
                recipeId: row.recipe_id,
                revisionId: row.revision_id,
                contentFingerprint: row.content_fingerprint,
              } as RecipeContentRef,
            ]
          : [],
      ),
    ),
  ]);
}
function preservableWithdrawals(before: Capture, retained: readonly RecipeContentRef[]) {
  const selected = new Set(before.selection),
    active = new Set(
      before.plans
        .filter((item) => selected.has(item.occurrence.occurrenceId))
        .map((item) => canonicalContentJson(item.contentRef)),
    ),
    remaining = new Set(retained.map((ref) => canonicalContentJson(ref)));
  return before.refs.filter(
    (ref) => remaining.has(canonicalContentJson(ref)) && !active.has(canonicalContentJson(ref)),
  );
}
function shoppingPreview(
  before: ShoppingLedger,
  next: Awaited<ReturnType<typeof buildRevisionShoppingProjection>>,
  rebuilt: boolean,
): ContentAdoptionReview['shopping'] {
  const previous = new Map(before.groups.map((row) => [row.groupKey, row])),
    contributions = new Set(
      before.snapshot.groups.flatMap((group) =>
        group.contributions.map((item) => item.contributionId),
      ),
    );
  const groups: ContentAdoptionReview['shopping']['groups'][number][] = [];
  for (const group of next.groups) {
    const old = previous.get(group.groupKey),
      active = old?.projectionRevision === before.snapshot.projectionRevision;
    const state = reconcilePurchaseState(
      group,
      old
        ? {
            demandFingerprint: old.demandFingerprint,
            purchased: old.purchased === 1,
            changed: old.changed === 1,
            revision: old.revision!,
            active,
          }
        : undefined,
      group.contributions.some((item) => contributions.has(item.contributionId)),
    );
    groups.push({
      groupKey: group.groupKey,
      displayName: group.displayName,
      previousQuantity: active ? old!.quantityLabel : null,
      quantity: group.quantityLabel,
      previousPurchased: active && old!.purchased === 1,
      purchased: state.purchased,
      changed: state.changed,
    });
    previous.delete(group.groupKey);
  }
  for (const old of previous.values())
    if (old.projectionRevision === before.snapshot.projectionRevision)
      groups.push({
        groupKey: old.groupKey,
        displayName: old.displayName,
        previousQuantity: old.quantityLabel,
        quantity: null,
        previousPurchased: old.purchased === 1,
        purchased: false,
        changed: true,
      });
  return {
    selectedOccurrences: before.snapshot.scope.occurrenceIds.length,
    rebuilt,
    groups,
    notices: JSON.parse(canonicalContentJson(next.notices)),
  };
}

/** Inactive service. Lock order is content reservation → cooking transaction; callbacks never re-enter content. */
export function createContentAdoptionService(options: Options) {
  const schemaVersion = options.cookingSchemaVersion ?? 7;
  requireValue(schemaVersion === 7 || schemaVersion === 8, 'invalid_input');
  const capabilities = new WeakMap<object, Capability>();
  function access() {
    const value = options.getAccess();
    requireValue(
      value &&
        exact(value, ['ownerId', 'authGeneration']) &&
        (value.ownerId === null || isAppId(value.ownerId)) &&
        revision(value.authGeneration),
      'access_changed',
    );
    const owned = { ...value };
    options.assertAccess(owned);
    return freezeResult(owned);
  }
  function check(scope: ContentAdoptionAccess) {
    const live = options.getAccess();
    requireValue(live && same(live, scope), 'access_changed');
    return options.assertAccess(scope);
  }
  const hash = (scope: ContentAdoptionAccess) => async (text: string) => {
    check(scope);
    const value = await options.sha256(text);
    check(scope);
    requireValue(digest(value));
    return value;
  };
  async function stateFingerprint(value: Capture, scope: ContentAdoptionAccess) {
    return hash(scope)(
      canonicalContentJson(['cookmate-content-adoption-state-v1', value], LIMITS.bytes),
    );
  }
  async function choiceFingerprint(
    value: Capture,
    scope: ContentAdoptionAccess,
    candidateHead: OverlayHead,
  ) {
    return hash(scope)(
      canonicalContentJson(
        ['cookmate-content-adoption-choices-v1', scope, candidateHead, value],
        LIMITS.bytes,
      ),
    );
  }
  async function readMealChoices(
    input: ContentAdoptionMealChoicesRequest,
  ): Promise<Immutable<ContentAdoptionMealChoices>> {
    const scope = access();
    const raw: unknown = JSON.parse(canonicalContentJson(input, 2048));
    requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'invalid_input');
    const value = raw as Record<string, unknown>;
    requireValue(
      Object.keys(value).every((key) =>
        ['candidateHead', 'offset', 'expectedContextFingerprint'].includes(key),
      ) && validateOverlayHead(value.candidateHead),
      'invalid_input',
    );
    const candidateHead = value.candidateHead,
      offset = value.offset === undefined ? 0 : value.offset;
    requireValue(
      revision(offset) &&
        offset <= LIMITS.plans &&
        offset % CONTENT_ADOPTION_CHOICE_PAGE_SIZE === 0 &&
        (value.expectedContextFingerprint === undefined ||
          digest(value.expectedContextFingerprint)) &&
        (offset === 0 || digest(value.expectedContextFingerprint)),
      'invalid_input',
    );
    const expected = value.expectedContextFingerprint;
    const before = await options.reader.transaction(
      (session) =>
        capture(
          guarded(session, () => check(scope)),
          scope,
          hash(scope),
          schemaVersion,
        ),
      { kind: 'read_only' },
    );
    check(scope);
    const contextFingerprint = await choiceFingerprint(before, scope, candidateHead);
    requireValue(expected === undefined || expected === contextFingerprint, 'review_changed');
    const result = await options.contentStore.withVerifiedAdoption(
      {
        previousHead: before.adoption.head,
        candidateHead,
        previousRefs: before.refs,
        retainedRefs: [],
      },
      async (views) => {
        check(scope);
        requireValue(same(views.head, candidateHead), 'review_changed');
        return options.reader.transaction(
          async (rawSession) => {
            const current = await capture(
              guarded(rawSession, () => check(scope)),
              scope,
              hash(scope),
              schemaVersion,
            );
            requireValue(
              (await choiceFingerprint(current, scope, candidateHead)) === contextFingerprint,
              'review_changed',
            );
            const plans = [...current.plans].sort(
              (a, b) =>
                a.occurrence.placement.actualDate.localeCompare(
                  b.occurrence.placement.actualDate,
                ) ||
                MEAL_KEYS.indexOf(a.occurrence.placement.mealKey) -
                  MEAL_KEYS.indexOf(b.occurrence.placement.mealKey) ||
                a.occurrence.occurrenceId.localeCompare(b.occurrence.occurrenceId),
            );
            requireValue(offset === 0 || offset < plans.length, 'invalid_input');
            const reader = createContentReader(views.candidate);
            const exact = new Map<string, ReturnType<typeof reader.lookupExact>>();
            const targets = new Map<string, ReturnType<typeof reader.lookupCurrent>>();
            const items = plans
              .slice(offset, offset + CONTENT_ADOPTION_CHOICE_PAGE_SIZE)
              .map(({ occurrence, contentRef }): ContentAdoptionMealChoice => {
                const key = canonicalContentJson(contentRef);
                let saved = exact.get(key);
                if (!saved) {
                  saved = reader.lookupExact(contentRef);
                  exact.set(key, saved);
                }
                let target = targets.get(occurrence.recipeId);
                if (!target) {
                  target = reader.lookupCurrent(occurrence.recipeId);
                  targets.set(occurrence.recipeId, target);
                }
                return {
                  occurrence,
                  current: {
                    contentRef,
                    title: saved.kind === 'readable' ? saved.recipe.title : null,
                    state: saved.kind === 'readable' ? 'readable' : 'unavailable',
                  },
                  target:
                    saved.kind !== 'withdrawn' &&
                    target.kind === 'readable' &&
                    target.state === 'current' &&
                    !same(contentRef, target.recipe.contentRef)
                      ? { contentRef: target.recipe.contentRef, title: target.recipe.title }
                      : null,
                };
              });
            check(scope);
            return freezeResult({
              candidateHead,
              contextFingerprint,
              total: plans.length,
              offset,
              items,
              nextOffset: offset + items.length < plans.length ? offset + items.length : null,
            });
          },
          { kind: 'read_only' },
        );
      },
    );
    check(scope);
    return result;
  }
  async function readReleaseContext(): Promise<Immutable<ContentReleaseContext>> {
    const scope = access();
    const value = await options.reader.transaction(
      (raw) =>
        capture(
          guarded(raw, () => check(scope)),
          scope,
          hash(scope),
          schemaVersion,
        ),
      { kind: 'read_only' },
    );
    check(scope);
    const contextFingerprint = await stateFingerprint(value, scope);
    check(scope);
    return freezeResult({
      installationId: value.installationId,
      ownerId: value.ownerId,
      adoptedHead: value.adoption.head,
      adoptionRevision: value.adoption.revision,
      storeRevision: value.storeRevision,
      restoreEpoch: value.restoreEpoch,
      retainedRefs: value.refs,
      unresolvedHistoryOrSessionCount: unresolvedCount(value),
      contextFingerprint,
    });
  }
  async function readReceipt(
    session: SqlSession,
    identity: ContentAdoptionOwner,
    operationId: string,
    requestFingerprint: string,
  ) {
    requireValue(isAppId(operationId) && digest(requestFingerprint), 'invalid_input');
    const row = (
      await session.all<{ fingerprint: string | null; json: string | null }>(
        `SELECT CASE WHEN typeof(request_fingerprint)='text' AND length(CAST(request_fingerprint AS BLOB))=64 THEN request_fingerprint ELSE NULL END fingerprint,CASE WHEN typeof(receipt_json)='text' AND length(CAST(receipt_json AS BLOB))<=${LIMITS.receipt} THEN receipt_json ELSE NULL END json FROM content_adoption_operation WHERE operation_id=?`,
        [operationId],
      )
    )[0];
    if (!row) return null;
    requireValue(row.fingerprint === requestFingerprint, 'operation_conflict');
    requireValue(typeof row.json === 'string');
    const value: unknown = JSON.parse(row.json);
    requireValue(
      exact(value, [
        'formatVersion',
        'status',
        'operationId',
        'requestFingerprint',
        'installationId',
        'ownerId',
        'previousHead',
        'head',
        'adoptionRevision',
        'storeRevision',
        'planRevision',
        'shoppingRevision',
        'changedOccurrences',
        'shoppingRebuilt',
        'committedAt',
      ]) &&
        value.formatVersion === 1 &&
        value.status === 'adopted_in_cooking_store' &&
        value.operationId === operationId &&
        value.requestFingerprint === requestFingerprint &&
        value.installationId === identity.installationId &&
        value.ownerId === identity.ownerId &&
        (value.previousHead === null || validateOverlayHead(value.previousHead)) &&
        validateOverlayHead(value.head) &&
        revision(value.adoptionRevision) &&
        value.adoptionRevision > 0 &&
        revision(value.storeRevision) &&
        revision(value.planRevision) &&
        revision(value.shoppingRevision) &&
        revision(value.changedOccurrences) &&
        value.changedOccurrences <= LIMITS.changes &&
        typeof value.shoppingRebuilt === 'boolean' &&
        typeof value.committedAt === 'string' &&
        isUtcInstant(value.committedAt),
    );
    return freezeResult(value as unknown as ContentAdoptionReceipt);
  }
  async function recover(
    input: ContentAdoptionOwner & { operationId: string; requestFingerprint: string },
  ) {
    const scope = access();
    requireValue(
      exact(input, ['installationId', 'ownerId', 'operationId', 'requestFingerprint']) &&
        isAppId(input.installationId) &&
        (input.ownerId === null || isAppId(input.ownerId)),
      'invalid_input',
    );
    const owned = { ...input };
    const result = await options.reader.transaction(
      async (raw) => {
        const session = guarded(raw, () => check(scope));
        await requireAdoptionSchema(session, schemaVersion);
        const identity = await binding(session, scope);
        requireValue(
          same(identity, { installationId: owned.installationId, ownerId: owned.ownerId }),
          'access_changed',
        );
        return readReceipt(session, identity, owned.operationId, owned.requestFingerprint);
      },
      { kind: 'read_only' },
    );
    check(scope);
    return result;
  }
  async function prepareView(
    session: SqlSession,
    before: Capture,
    changes: readonly ContentAdoptionChange[],
    views: Parameters<Parameters<Store['withVerifiedAdoption']>[1]>[0],
    scope: ContentAdoptionAccess,
  ) {
    if (before.adoption.head === null) {
      const baseline = await createBundledContentSnapshot(hash(scope)),
        available = new Set(baseline.revisions.map((value) => canonicalContentJson(value.ref)));
      requireValue(
        before.refs.every((ref) => available.has(canonicalContentJson(ref))),
        'content_unavailable',
      );
    }
    const oldReader = createContentReader(views.previous ?? views.candidate),
      candidateReader = createContentReader(views.candidate);
    for (const change of changes) {
      const current = views.candidate.lookupCurrent(change.targetRef.recipeId);
      requireValue(
        current.kind === 'readable' &&
          current.state === 'current' &&
          same(current.value.revision.ref, change.targetRef),
        'content_unavailable',
      );
    }
    const oldContext = await readPinnedShoppingContextInSnapshot(session, {
      lookupExact: oldReader.lookupExact,
      sha256: hash(scope),
    });
    const ledger = await readShoppingLedgerInSnapshot(session, oldContext.options);
    const plans = changedPlans(before, changes),
      selected = new Set(before.selection),
      pinned = plans.filter((item) => selected.has(item.occurrence.occurrenceId));
    const projection = await buildRevisionShoppingProjection(pinned, {
      lookupExact: candidateReader.lookupExact,
      sha256: hash(scope),
    });
    const rebuilt = changes.some((change) => selected.has(change.occurrenceId));
    const shopping = shoppingPreview(ledger, projection, rebuilt);
    canonicalContentJson(shopping, LIMITS.bytes);
    const ledgerFingerprint = await hash(scope)(
      canonicalContentJson(['cookmate-content-adoption-ledger-v1', ledger], LIMITS.bytes),
    );
    return {
      ledger,
      shopping,
      candidateReader,
      ledgerFingerprint,
      withdrawnRefs: views.withdrawnRefs,
    };
  }
  async function review(
    input: ContentAdoptionRequest,
    expectedChoiceContextFingerprint?: string,
  ): Promise<Immutable<ContentAdoptionReview>> {
    const scope = access(),
      proposal = request(input),
      operationId = options.newId();
    requireValue(isAppId(operationId), 'invalid_input');
    requireValue(
      expectedChoiceContextFingerprint === undefined || digest(expectedChoiceContextFingerprint),
      'invalid_input',
    );
    const before = await options.reader.transaction(
      (raw) =>
        capture(
          guarded(raw, () => check(scope)),
          scope,
          hash(scope),
          schemaVersion,
        ),
      { kind: 'read_only' },
    );
    check(scope);
    if (expectedChoiceContextFingerprint !== undefined)
      requireValue(
        (await choiceFingerprint(before, scope, proposal.candidateHead)) ===
          expectedChoiceContextFingerprint,
        'review_changed',
      );
    const beforeFingerprint = await stateFingerprint(before, scope),
      retainedRefs = remainingRefs(before, changedPlans(before, proposal.changes));
    const preserveWithdrawnRefs = preservableWithdrawals(before, retainedRefs);
    requireValue(
      !same(before.adoption.head, proposal.candidateHead) || proposal.changes.length > 0,
      'invalid_input',
    );
    const result = await options.contentStore.withVerifiedAdoption(
      {
        previousHead: before.adoption.head,
        candidateHead: proposal.candidateHead,
        previousRefs: before.refs,
        retainedRefs,
        preserveWithdrawnRefs,
      },
      async (views) => {
        check(scope);
        requireValue(same(views.head, proposal.candidateHead), 'review_changed');
        return options.reader.transaction(
          async (raw) => {
            const session = guarded(raw, () => check(scope));
            const current = await capture(session, scope, hash(scope), schemaVersion);
            requireValue(
              (await stateFingerprint(current, scope)) === beforeFingerprint,
              'review_changed',
            );
            const prepared = await prepareView(session, current, proposal.changes, views, scope);
            const previewFingerprint = await hash(scope)(
              canonicalContentJson(
                [
                  'cookmate-content-adoption-shopping-v1',
                  prepared.ledgerFingerprint,
                  prepared.shopping,
                  prepared.withdrawnRefs,
                ],
                LIMITS.bytes,
              ),
            );
            const requestFingerprint = await hash(scope)(
              canonicalContentJson(
                [
                  'cookmate-content-adoption-request-v1',
                  operationId,
                  scope,
                  before.installationId,
                  beforeFingerprint,
                  proposal,
                  previewFingerprint,
                ],
                LIMITS.bytes,
              ),
            );
            const value = freezeResult({
              installationId: before.installationId,
              ownerId: before.ownerId,
              operationId,
              requestFingerprint,
              previousHead: before.adoption.head,
              candidateHead: proposal.candidateHead,
              expectedStoreRevision: before.storeRevision,
              expectedAdoptionRevision: before.adoption.revision,
              changes: proposal.changes,
              preservedPlanCount: before.plans.length - proposal.changes.length,
              unresolvedHistoryOrSessionCount: unresolvedCount(before),
              withdrawnRefs: prepared.withdrawnRefs,
              shopping: prepared.shopping,
            });
            canonicalContentJson(value, LIMITS.bytes);
            capabilities.set(value, {
              scope,
              capture: before,
              captureFingerprint: beforeFingerprint,
              retainedRefs,
              preserveWithdrawnRefs,
              review: value,
              previewFingerprint,
            });
            return value;
          },
          { kind: 'read_only' },
        );
      },
    );
    check(scope);
    return result;
  }
  async function adopt(
    review: Immutable<ContentAdoptionReview>,
  ): Promise<Immutable<ContentAdoptionReceipt>> {
    const capability = review && capabilities.get(review);
    requireValue(capability && capability.review === review, 'invalid_input');
    const { scope, capture: before } = capability;
    check(scope);
    const recovered = await recover({
      installationId: review.installationId,
      ownerId: review.ownerId,
      operationId: review.operationId,
      requestFingerprint: review.requestFingerprint,
    });
    check(scope);
    if (recovered) return recovered;
    const result = await options.contentStore.withVerifiedAdoption(
      {
        previousHead: before.adoption.head,
        candidateHead: review.candidateHead,
        previousRefs: before.refs,
        retainedRefs: capability.retainedRefs,
        preserveWithdrawnRefs: capability.preserveWithdrawnRefs,
      },
      async (views) => {
        check(scope);
        requireValue(same(views.head, review.candidateHead), 'review_changed');
        return options.writer.transaction(
          async (raw) => {
            const session = guarded(raw, () => check(scope));
            await requireAdoptionSchema(session, schemaVersion);
            const identity = await binding(session, scope);
            requireValue(
              same(identity, { installationId: review.installationId, ownerId: review.ownerId }),
              'access_changed',
            );
            const existing = await readReceipt(
              session,
              identity,
              review.operationId,
              review.requestFingerprint,
            );
            if (existing) return existing;
            const current = await capture(session, scope, hash(scope), schemaVersion);
            requireValue(
              (await stateFingerprint(current, scope)) === capability.captureFingerprint,
              'review_changed',
            );
            const prepared = await prepareView(session, current, review.changes, views, scope);
            requireValue(
              (await hash(scope)(
                canonicalContentJson(
                  [
                    'cookmate-content-adoption-shopping-v1',
                    prepared.ledgerFingerprint,
                    prepared.shopping,
                    prepared.withdrawnRefs,
                  ],
                  LIMITS.bytes,
                ),
              )) === capability.previewFingerprint,
              'review_changed',
            );
            const committedAt = options.now();
            requireValue(isUtcInstant(committedAt), 'invalid_input');
            await retainVerifiedRevisionsForSchemaInSnapshot(
              session,
              views.candidate,
              capability.retainedRefs.filter(
                (ref) => views.candidate.lookupExact(ref).kind === 'readable',
              ),
              hash(scope),
              schemaVersion,
            );
            for (const change of review.changes) {
              await runBound(session, 'DELETE FROM shopping_contribution WHERE occurrence_id=?', [
                change.occurrenceId,
              ]);
              await runBound(
                session,
                'UPDATE plan_content_pin SET revision_id=?,content_fingerprint=? WHERE occurrence_id=? AND recipe_id=?',
                [
                  change.targetRef.revisionId,
                  change.targetRef.contentFingerprint,
                  change.occurrenceId,
                  change.targetRef.recipeId,
                ],
              );
              const old = current.plans.find(
                (item) => item.occurrence.occurrenceId === change.occurrenceId,
              )!.occurrence;
              await runBound(
                session,
                'UPDATE plan_occurrence SET revision=?,updated_at=? WHERE occurrence_id=?',
                [nextStoredRevision(old.revision), committedAt, change.occurrenceId],
              );
            }
            if (prepared.shopping.rebuilt) {
              const context = await readPinnedShoppingContextInSnapshot(session, {
                lookupExact: prepared.candidateReader.lookupExact,
                sha256: hash(scope),
              });
              await rebuildShoppingInSnapshot(session, prepared.ledger, context.options);
            }
            const receipt: ContentAdoptionReceipt = {
              formatVersion: 1,
              status: 'adopted_in_cooking_store',
              operationId: review.operationId,
              requestFingerprint: review.requestFingerprint,
              ...identity,
              previousHead: before.adoption.head,
              head: review.candidateHead,
              adoptionRevision: nextStoredRevision(before.adoption.revision),
              storeRevision: nextStoredRevision(before.storeRevision),
              planRevision: review.changes.length
                ? nextStoredRevision(before.planRevision)
                : before.planRevision,
              shoppingRevision: prepared.shopping.rebuilt
                ? nextStoredRevision(before.shoppingRevision)
                : before.shoppingRevision,
              changedOccurrences: review.changes.length,
              shoppingRebuilt: prepared.shopping.rebuilt,
              committedAt,
            };
            await runBound(
              session,
              'UPDATE app_content_adoption SET revision=?,head_json=? WHERE singleton=1',
              [receipt.adoptionRevision, canonicalContentJson(receipt.head, 1024)],
            );
            for (const [collection, value] of [
              ['store', receipt.storeRevision],
              ['plan', receipt.planRevision],
              ['shopping', receipt.shoppingRevision],
            ] as const)
              await runBound(session, 'UPDATE state_revision SET revision=? WHERE collection=?', [
                value,
                collection,
              ]);
            await runBound(session, 'INSERT INTO content_adoption_operation VALUES (?,?,?)', [
              receipt.operationId,
              receipt.requestFingerprint,
              canonicalContentJson(receipt, LIMITS.receipt),
            ]);
            check(scope);
            return freezeResult(receipt);
          },
          { kind: 'all' },
          () => check(scope),
        );
      },
    );
    check(scope);
    return result;
  }
  return Object.freeze({ readReleaseContext, readMealChoices, review, adopt, recover });
}
