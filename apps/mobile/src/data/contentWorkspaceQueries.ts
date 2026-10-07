import { catalogueBoundary, readonlyIds } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  createBundledContentReader,
  createContentReader,
  validateRecipeContentRef,
  type OverlayHead,
  type ReadingLookup,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import {
  isUtcInstant,
  type ContractError,
  type PlanOccurrence,
  type ShoppingScope,
} from '@cookmate/contracts';
import {
  isSupportedPlanDate,
  type Immutable,
  type RepositoryResult,
  type ShoppingGroup,
  type ShoppingSnapshot,
  type Favourite,
} from '@cookmate/domain';
import { readBinding } from './accountReplicationRecords';
import type { ContentAdoptionAccess } from './contentAdoption';
import type { ContentReadingView, openContentReleaseStore } from './contentReleaseStore';
import { readAdoptionInSnapshot } from './cookingContentRepository';
import { isAppId, isRevision } from './conversationRecords';
import { readPinnedShoppingContextInSnapshot } from './pinnedShoppingRepository';
import { freezeResult } from './query';
import { buildContentShoppingShare, type ContentShoppingShare } from './contentShoppingShare';
import { readRestoreEpoch } from './restoreEpoch';
import {
  buildRevisionShoppingProjection,
  type PinnedShoppingOccurrence,
  type RevisionShoppingContribution,
  type ShoppingRevisionNotice,
} from './revisionShoppingProjection';
import {
  admitPinnedShoppingRows,
  readSelectedShoppingOccurrencesInSnapshot,
  readShoppingLedgerInSnapshot,
} from './shoppingRepository';
import { readPlanInSnapshot, readShoppingScopeInSnapshot } from './stateRepositories';
import type { SerializedReader, SqlSession, SqlValue } from './sql';

export interface ContentPlanOccurrence {
  occurrence: Immutable<PlanOccurrence>;
  contentRef: RecipeContentRef;
  content:
    | {
        kind: 'readable';
        state: 'current' | 'archived' | 'historical';
        title: string;
        photoAssetId: string | null;
      }
    | { kind: 'unavailable'; reason: 'withdrawn' | 'exact_unavailable' | 'delivery_unavailable' };
}
export interface ContentPlanSnapshot {
  startDate: string;
  endDate: string;
  occurrences: readonly ContentPlanOccurrence[];
  shoppingScope: Immutable<ShoppingScope>;
}
export interface ContentFavouriteEntry {
  favourite: Immutable<Favourite>;
  content:
    | {
        kind: 'readable';
        state: 'current' | 'archived';
        contentRef: RecipeContentRef;
        title: string;
        cuisine: string;
        category: string;
        ingredientNames: readonly string[];
        photoNeedsReview: boolean;
      }
    | { kind: 'unavailable'; reason: 'withdrawn' | 'exact_unavailable' | 'delivery_unavailable' };
}
export type ContentShoppingSnapshot =
  | {
      kind: 'current';
      snapshot: Omit<ShoppingSnapshot, 'groups'> & {
        groups: readonly (Omit<ShoppingGroup, 'contributions'> & {
          contributions: readonly RevisionShoppingContribution[];
        })[];
      };
      selected: readonly ContentPlanOccurrence[];
      notices: readonly Immutable<ShoppingRevisionNotice>[];
      share: Immutable<ContentShoppingShare>;
    }
  | {
      kind: 'unavailable';
      scope: Immutable<ShoppingScope>;
      selected: readonly ContentPlanOccurrence[];
      reason: 'content_unavailable';
    };
interface Options {
  reader: SerializedReader;
  contentStore: Pick<Awaited<ReturnType<typeof openContentReleaseStore>>, 'withVerifiedReading'>;
  installationId: string;
  sha256(text: string): Promise<string>;
  getAccess(): ContentAdoptionAccess | null;
  assertAccess(scope: Readonly<ContentAdoptionAccess>): undefined;
}
type Selection =
  | { kind: 'plan'; startDate: string; endDate: string }
  | { kind: 'shopping' }
  | { kind: 'favourites' };
interface Capture {
  fence: {
    head: OverlayHead | null;
    adoptionRevision: number;
    restoreEpoch: number;
    storeRevision: number;
  };
  selected:
    | { kind: 'meals'; scope: ShoppingScope; pinned: PinnedShoppingOccurrence[] }
    | { kind: 'favourites'; favourites: Favourite[] };
}
type Reading = ReturnType<typeof createContentReader>;
class QueryFault extends Error {
  constructor(readonly detail: ContractError) {
    super(detail.messageKey);
  }
}
function reject(reason: string, code: ContractError['code'] = 'storage_failure'): never {
  throw new QueryFault({
    code,
    messageKey: `content.workspace_${reason}`,
    retry: 'after_correction',
  });
}
function stored(value: unknown): asserts value {
  if (!value) reject('stored_invalid');
}
const same = (a: unknown, b: unknown) =>
  canonicalContentJson(a, 2 * 1024 * 1024) === canonicalContentJson(b, 2 * 1024 * 1024);

/** Admit all saved and removed rows before shared readers/handlers materialize any scalar. */
export async function admitContentFavouriteRows(session: SqlSession) {
  const [usage] = await session.all<{
    count: number;
    bytes: number;
    invalid: number;
  }>(`SELECT COUNT(*) count,
    COALESCE(SUM(length(CAST(recipe_id AS BLOB))+length(CAST(saved_at AS BLOB))+length(CAST(updated_at AS BLOB))),0) bytes,
    COALESCE(SUM(CASE WHEN typeof(recipe_id)<>'text' OR length(CAST(recipe_id AS BLOB)) NOT BETWEEN 1 AND 20 OR instr(recipe_id,char(0))>0 OR recipe_id GLOB '*[^0-9]*'
      OR typeof(saved)<>'integer' OR saved NOT IN(0,1) OR typeof(revision)<>'integer' OR revision<0 OR revision>9007199254740991
      OR typeof(saved_at)<>'text' OR length(CAST(saved_at AS BLOB))>40 OR typeof(updated_at)<>'text' OR length(CAST(updated_at AS BLOB))>40 THEN 1 ELSE 0 END),0) invalid FROM favourite`);
  stored(
    usage &&
      isRevision(usage.count) &&
      usage.count <= 10_000 &&
      isRevision(usage.bytes) &&
      usage.bytes <= 2 * 1024 * 1024 &&
      usage.invalid === 0,
  );
  stored(
    (
      await session.all(
        'SELECT 1 FROM favourite f LEFT JOIN recipe_identity r ON r.recipe_id=f.recipe_id WHERE r.recipe_id IS NULL LIMIT 1',
      )
    ).length === 0,
  );
  const rows = await session.all<Favourite & { saved: number; updatedAt: string }>(
    'SELECT recipe_id recipeId,revision,saved_at savedAt,saved,updated_at updatedAt FROM favourite ORDER BY saved_at DESC,recipe_id',
  );
  stored(
    rows.every(
      (row) =>
        /^[0-9]{1,20}$/.test(row.recipeId) &&
        isUtcInstant(row.savedAt) &&
        isUtcInstant(row.updatedAt),
    ),
  );
  return rows;
}

async function favouriteRows(session: SqlSession): Promise<Favourite[]> {
  const rows = await admitContentFavouriteRows(session);
  return rows
    .filter((row) => row.saved === 1)
    .map(({ recipeId, revision, savedAt }) => ({ recipeId, revision, savedAt }));
}

/** Private schema8 read composition. It owns no handles and never repairs a projection or adopts content. */
export function createContentWorkspaceQueries(options: Options) {
  const {
    reader,
    contentStore,
    installationId,
    sha256: hashPort,
    getAccess,
    assertAccess,
  } = options;
  const transaction = reader.transaction.bind(reader);
  const withVerifiedReading = contentStore.withVerifiedReading.bind(contentStore);
  const access = getAccess();
  if (
    !isAppId(installationId) ||
    !access ||
    (access.ownerId !== null && !isAppId(access.ownerId)) ||
    !isRevision(access.authGeneration)
  )
    reject('access_changed', 'stale_context');
  const scope = Object.freeze({ ownerId: access.ownerId, authGeneration: access.authGeneration });
  let closed = false;
  function check(): undefined {
    const live = getAccess();
    if (
      closed ||
      !live ||
      live.ownerId !== scope.ownerId ||
      live.authGeneration !== scope.authGeneration ||
      assertAccess(scope) !== undefined
    )
      reject('access_changed', 'stale_context');
    return undefined;
  }
  function guarded(raw: SqlSession, guard = check): SqlSession {
    return {
      async all<Row extends object>(sql: string, values?: readonly SqlValue[]) {
        guard();
        const rows = await raw.all<Row>(sql, values);
        guard();
        return rows;
      },
      async exec() {
        reject('read_only');
      },
      async prepare() {
        reject('read_only');
      },
    };
  }
  const sha256 = async (text: string, guard = check) => {
    guard();
    const digest = await hashPort(text);
    guard();
    stored(/^[0-9a-f]{64}$/.test(digest));
    return digest;
  };
  async function fence(session: SqlSession): Promise<Capture['fence']> {
    stored(
      (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]?.user_version === 8,
    );
    const [id] = await session.all<{ value: string | null }>(
      "SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))=36 THEN value END value FROM app_metadata WHERE key='installation_id'",
    );
    if (id?.value !== installationId || (await readBinding(session)) !== scope.ownerId)
      reject('access_changed', 'stale_context');
    const adoption = await readAdoptionInSnapshot(session);
    const [clock] = await session.all<{ revision: number | null }>(
      "SELECT CASE WHEN typeof(revision)='integer' THEN revision END revision FROM state_revision WHERE collection='store'",
    );
    stored(clock && isRevision(clock.revision));
    return {
      head: adoption.head,
      adoptionRevision: adoption.revision,
      restoreEpoch: await readRestoreEpoch(session),
      storeRevision: clock.revision,
    };
  }
  async function admitPlan(session: SqlSession) {
    for (const [table, text, integers] of [
      [
        'plan_occurrence',
        [
          ['occurrence_id', 36],
          ['recipe_id', 20],
          ['local_date', 10],
          ['meal_key', 16],
          ['created_at', 40],
          ['updated_at', 40],
        ],
        ['revision'],
      ],
      [
        'plan_content_pin',
        [
          ['occurrence_id', 36],
          ['recipe_id', 20],
          ['revision_id', 120],
          ['content_fingerprint', 64],
        ],
        [],
      ],
    ] as const) {
      const invalid = [
        ...text.map(
          ([key, max]) => `typeof(${key})<>'text' OR length(CAST(${key} AS BLOB))>${max}`,
        ),
        ...integers.map(
          (key) => `typeof(${key})<>'integer' OR ${key}<0 OR ${key}>9007199254740991`,
        ),
      ].join(' OR ');
      const [usage] = await session.all<{ count: number; bytes: number; invalid: number }>(
        `SELECT COUNT(*) count,COALESCE(SUM(${text.map(([key]) => `length(CAST(${key} AS BLOB))`).join('+')}),0) bytes,COALESCE(SUM(CASE WHEN ${invalid} THEN 1 ELSE 0 END),0) invalid FROM ${table}`,
      );
      stored(
        usage &&
          isRevision(usage.count) &&
          usage.count <= 20_000 &&
          isRevision(usage.bytes) &&
          usage.bytes <= 8 * 1024 * 1024 &&
          usage.invalid === 0,
      );
    }
    stored(
      (
        await session.all(`SELECT 1 FROM plan_occurrence p LEFT JOIN plan_content_pin s ON s.occurrence_id=p.occurrence_id AND s.recipe_id=p.recipe_id WHERE s.occurrence_id IS NULL
      UNION ALL SELECT 1 FROM plan_content_pin s WHERE NOT EXISTS(SELECT 1 FROM plan_occurrence p WHERE p.occurrence_id=s.occurrence_id AND p.recipe_id=s.recipe_id)
      OR NOT EXISTS(SELECT 1 FROM recipe_content_revision r WHERE r.recipe_id=s.recipe_id AND r.revision_id=s.revision_id AND r.content_fingerprint=s.content_fingerprint) LIMIT 1`)
      ).length === 0,
    );
  }
  async function metadata(session: SqlSession, selection: Selection): Promise<Capture> {
    const current = await fence(session);
    if (selection.kind === 'favourites')
      return freezeResult({
        fence: current,
        selected: { kind: 'favourites', favourites: await favouriteRows(session) },
      });
    await admitPlan(session);
    await admitPinnedShoppingRows(session);
    const shoppingScope = await readShoppingScopeInSnapshot(session);
    const where =
      selection.kind === 'plan'
        ? 'p.local_date BETWEEN ? AND ?'
        : 'p.occurrence_id IN (SELECT occurrence_id FROM shopping_selection)';
    const values = selection.kind === 'plan' ? [selection.startDate, selection.endDate] : [];
    const [usage] = await session.all<{ count: number }>(
      `SELECT COUNT(*) count FROM plan_occurrence p WHERE ${where}`,
      values,
    );
    if (!usage || !isRevision(usage.count) || usage.count > 1000)
      reject('range_too_large', 'unsupported_request');
    const pins = await session.all<{
      occurrenceId: string;
      recipeId: string;
      revisionId: string;
      contentFingerprint: string;
    }>(
      `SELECT s.occurrence_id occurrenceId,s.recipe_id recipeId,s.revision_id revisionId,s.content_fingerprint contentFingerprint FROM plan_content_pin s JOIN plan_occurrence p ON p.occurrence_id=s.occurrence_id WHERE ${where} ORDER BY s.occurrence_id`,
      values,
    );
    const byId = new Map<string, RecipeContentRef>();
    for (const { occurrenceId, ...ref } of pins) {
      stored(isAppId(occurrenceId) && validateRecipeContentRef(ref));
      byId.set(occurrenceId, ref);
    }
    // This boundary validates row identities only. Recipe bodies always come from the reserved exact lookup.
    const occurrences =
      selection.kind === 'plan'
        ? (
            await readPlanInSnapshot(
              session,
              {
                ...catalogueBoundary,
                recipeIds: readonlyIds(new Set(pins.map((pin) => pin.recipeId))),
              },
              selection.startDate,
              selection.endDate,
            )
          ).occurrences
        : await readSelectedShoppingOccurrencesInSnapshot(session, shoppingScope);
    stored(occurrences.length === pins.length);
    const pinned = occurrences.map((occurrence) => {
      const contentRef = byId.get(occurrence.occurrenceId);
      stored(contentRef && contentRef.recipeId === occurrence.recipeId);
      return { occurrence: { ...occurrence, placement: { ...occurrence.placement } }, contentRef };
    });
    return freezeResult({
      fence: current,
      selected: { kind: 'meals', scope: shoppingScope, pinned },
    });
  }
  async function capture(selection: Selection, guard = check) {
    const value = await transaction((raw) => metadata(guarded(raw, guard), selection), {
      kind: 'read_only',
    });
    guard();
    return value;
  }
  function row(item: PinnedShoppingOccurrence, reading?: Reading): ContentPlanOccurrence {
    const found: ReadingLookup | undefined = reading?.lookupExact(item.contentRef);
    if (found?.kind === 'readable') {
      stored(same(found.recipe.contentRef, item.contentRef));
      return {
        ...item,
        content: {
          kind: 'readable',
          state: found.state,
          title: found.recipe.title,
          photoAssetId:
            found.recipe.media.find(
              (media) =>
                media.recipeId === item.contentRef.recipeId &&
                media.photoKey === found.recipe.photoKey,
            )?.assetId ?? null,
        },
      };
    }
    return {
      ...item,
      content: {
        kind: 'unavailable',
        reason: !reading
          ? 'delivery_unavailable'
          : found?.kind === 'withdrawn'
            ? 'withdrawn'
            : 'exact_unavailable',
      },
    };
  }
  function favouriteRow(favourite: Favourite, reading?: Reading): ContentFavouriteEntry {
    const found = reading?.lookupCurrent(favourite.recipeId);
    if (found?.kind === 'readable') {
      stored(
        found.recipe.recipeId === favourite.recipeId &&
          (found.state === 'current' || found.state === 'archived'),
      );
      const recipe = found.recipe,
        photo = recipe.media.find((item) => item.photoKey === recipe.photoKey);
      const photoNeedsReview =
        (recipe.provenance.kind === 'imported' &&
          !!recipe.provenance.photoTreatment.warningAnnotationId) ||
        recipe.retainedSources.some(
          (source) =>
            source.document.media.some(
              (item) => item.assetId === photo?.assetId && item.sha256 === photo?.sha256,
            ) && !!source.document.provenance.photoTreatment.warningAnnotationId,
        );
      return {
        favourite,
        content: {
          kind: 'readable',
          state: found.state,
          contentRef: recipe.contentRef,
          title: recipe.title,
          cuisine: recipe.cuisine,
          category: recipe.category,
          ingredientNames: recipe.ingredients.map((item) => item.rawName),
          photoNeedsReview,
        },
      };
    }
    return {
      favourite,
      content: {
        kind: 'unavailable',
        reason: !reading
          ? 'delivery_unavailable'
          : found?.kind === 'withdrawn'
            ? 'withdrawn'
            : 'exact_unavailable',
      },
    };
  }
  async function select(
    selection: Selection,
    before: Capture,
    reading: Reading | undefined,
    guard: () => undefined,
  ) {
    const value = await transaction(
      async (raw) => {
        const session = guarded(raw, guard),
          actual = await metadata(session, selection);
        if (!same(actual, before)) reject('changed', 'stale_context');
        if (selection.kind === 'favourites') {
          stored(actual.selected.kind === 'favourites');
          return actual.selected.favourites.map((item) => favouriteRow(item, reading));
        }
        stored(actual.selected.kind === 'meals');
        const selected = actual.selected.pinned.map((item) => row(item, reading));
        if (selection.kind === 'plan')
          return {
            startDate: selection.startDate,
            endDate: selection.endDate,
            occurrences: selected,
            shoppingScope: actual.selected.scope,
          } satisfies ContentPlanSnapshot;
        if (!reading || selected.some((item) => item.content.kind !== 'readable'))
          return {
            kind: 'unavailable',
            scope: actual.selected.scope,
            selected,
            reason: 'content_unavailable',
          } satisfies ContentShoppingSnapshot;
        const ports = {
          lookupExact: reading.lookupExact,
          sha256: (text: string) => sha256(text, guard),
        };
        const context = await readPinnedShoppingContextInSnapshot(session, ports);
        const ledger = await readShoppingLedgerInSnapshot(session, context.options);
        const projection = await buildRevisionShoppingProjection(context.pinnedOccurrences, ports);
        const projected = new Map(projection.groups.map((group) => [group.groupKey, group]));
        const groups = ledger.snapshot.groups.map((group) => {
          const exact = projected.get(group.groupKey);
          stored(exact && same(exact.demandFingerprint, group.demandFingerprint));
          return { ...group, contributions: exact.contributions };
        });
        guard();
        return {
          kind: 'current',
          snapshot: { ...ledger.snapshot, groups },
          selected,
          notices: projection.notices,
          share: buildContentShoppingShare(
            actual.selected.pinned.map((item) => item.contentRef),
            reading.lookupExact,
          ),
        } satisfies ContentShoppingSnapshot;
      },
      { kind: 'read_only' },
    );
    guard();
    return freezeResult(value);
  }
  async function run(
    selection: Extract<Selection, { kind: 'favourites' }>,
  ): Promise<RepositoryResult<Immutable<readonly ContentFavouriteEntry[]>>>;
  async function run(
    selection: Extract<Selection, { kind: 'plan' }>,
  ): Promise<RepositoryResult<Immutable<ContentPlanSnapshot>>>;
  async function run(
    selection: Extract<Selection, { kind: 'shopping' }>,
  ): Promise<RepositoryResult<Immutable<ContentShoppingSnapshot>>>;
  async function run(
    selection: Selection,
  ): Promise<
    RepositoryResult<
      Immutable<ContentPlanSnapshot | ContentShoppingSnapshot | readonly ContentFavouriteEntry[]>
    >
  > {
    try {
      check();
      const before = await capture(selection);
      const refs =
        before.selected.kind === 'favourites'
          ? []
          : [
              ...new Map(
                before.selected.pinned.map((item) => [
                  canonicalContentJson(item.contentRef),
                  item.contentRef,
                ]),
              ).values(),
            ];
      async function reserved(requested: readonly RecipeContentRef[]) {
        let entered = false;
        try {
          const value = await withVerifiedReading(
            before.fence.head,
            requested,
            async (view: ContentReadingView) => {
              entered = true;
              const guard = () => {
                check();
                stored(view.assertActive() === undefined);
                return undefined;
              };
              guard();
              stored(same(view.head, before.fence.head));
              let reading: Reading;
              if (before.fence.head) {
                stored(
                  view.snapshot &&
                    same(before.fence.head, {
                      releaseId: view.snapshot.envelope.manifest.releaseId,
                      sequence: view.snapshot.envelope.manifest.sequence,
                      fingerprint: view.snapshot.envelope.fingerprint,
                    }),
                );
                reading = createContentReader(view.snapshot);
              } else {
                stored(view.snapshot === null && !view.hasWithdrawal);
                reading = await createBundledContentReader((text) => sha256(text, guard));
              }
              const value = await select(selection, before, reading, guard);
              // Revalidate after asynchronous projection work while withdrawal is still excluded.
              if (!same(await capture(selection, guard), before))
                reject('changed', 'stale_context');
              guard();
              return value;
            },
          );
          check();
          return { available: true as const, value };
        } catch (error) {
          check();
          // SQL corruption, stale scope or failures after entering the callback are never downgraded to empty/unavailable success.
          if (entered) throw error;
          return { available: false as const };
        }
      }
      let content = await reserved(refs);
      if (!content.available && refs.length) content = await reserved([]);
      const value = content.available
        ? content.value
        : await select(selection, before, undefined, check);
      check();
      return { kind: 'ready', value, revision: before.fence.storeRevision };
    } catch (error) {
      return {
        kind: 'failed',
        error:
          error instanceof QueryFault
            ? error.detail
            : {
                code: 'storage_failure',
                messageKey: 'content.workspace_read_failed',
                retry: 'after_correction',
              },
      };
    }
  }
  return Object.freeze({
    async readPlan(
      startDate: string,
      endDate: string,
    ): Promise<RepositoryResult<Immutable<ContentPlanSnapshot>>> {
      if (!isSupportedPlanDate(startDate) || !isSupportedPlanDate(endDate) || startDate > endDate)
        return {
          kind: 'failed',
          error: {
            code: 'invalid_input',
            messageKey: 'plan.invalid_range',
            retry: 'after_correction',
          },
        };
      return run({ kind: 'plan', startDate, endDate });
    },
    readShopping: () => run({ kind: 'shopping' }),
    readFavourites: () => run({ kind: 'favourites' }),
    close() {
      closed = true;
    },
  });
}
