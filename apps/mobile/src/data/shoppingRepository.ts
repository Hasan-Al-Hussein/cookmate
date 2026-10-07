import { isUtcInstant, validatePlanOccurrence } from '@cookmate/contracts';
import type { PlanOccurrence, ShoppingScope } from '@cookmate/contracts';
import { validateRecipeContentRef, type RecipeContentRef } from '@cookmate/catalogue/content';
import {
  buildShoppingProjection,
  isSupportedPlanDate,
  reconcilePurchaseState,
} from '@cookmate/domain';
import type {
  ShoppingContribution,
  ShoppingGroup,
  ShoppingProjectionOptions,
  ShoppingProjectionRecipe,
  ShoppingSnapshot,
} from '@cookmate/domain';
import { readSnapshot } from './query';
import { readShoppingScopeInSnapshot } from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SerializedReader, SqlSession } from './sql';
import { requireCookingContentReadVersion } from './cookingContentRepository';
import { REVISION_SHOPPING_LIMITS } from './revisionShoppingProjection';

/** Exact revision mode is opt-in and requires the inactive schema-7/8 integration. */
export interface StoredShoppingProjectionOptions extends ShoppingProjectionOptions<ShoppingProjectionRecipe> {
  contentRefForOccurrence?(occurrenceId: string): RecipeContentRef;
}

function contributionRef(
  options: StoredShoppingProjectionOptions,
  contribution: ShoppingContribution,
) {
  if (!options.contentRefForOccurrence) return null;
  const ref = options.contentRefForOccurrence(contribution.occurrenceId);
  stored(validateRecipeContentRef(ref) && ref.recipeId === contribution.recipeId);
  return ref;
}

interface StoredGroup {
  groupKey: string;
  groupingVersion: string;
  demandFingerprint: string;
  projectionRevision: number;
  displayName: string;
  quantityLabel: string;
  purchaseFingerprint: string | null;
  purchased: number | null;
  changed: number | null;
  revision: number | null;
}
export interface ShoppingLedger {
  snapshot: ShoppingSnapshot;
  groups: readonly StoredGroup[];
}

function stored(condition: boolean): asserts condition {
  if (!condition)
    throw new StorageFault('storage_failure', 'Stored shopping projection is invalid');
}
export function nextStoredRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + 1))
    throw new StorageFault('storage_failure', 'Stored revision exhausted');
  return value + 1;
}

export async function readSelectedShoppingOccurrencesInSnapshot(
  session: SqlSession,
  scope: ShoppingScope,
): Promise<PlanOccurrence[]> {
  const rows = await session.all<Omit<PlanOccurrence, 'placement'> & PlanOccurrence['placement']>(
    `SELECT p.occurrence_id AS occurrenceId, p.recipe_id AS recipeId, p.local_date AS actualDate,
       p.meal_key AS mealKey, p.revision, p.created_at AS createdAt, p.updated_at AS updatedAt
     FROM shopping_selection s JOIN plan_occurrence p ON p.occurrence_id = s.occurrence_id
     WHERE s.scope_id = ? ORDER BY p.occurrence_id`,
    [scope.scopeId],
  );
  const occurrences = rows.map(({ actualDate, mealKey, ...row }) => ({
    ...row,
    placement: { actualDate, mealKey },
  }));
  stored(
    occurrences.length === scope.occurrenceIds.length &&
      occurrences.every(
        (item) =>
          validatePlanOccurrence(item) &&
          isSupportedPlanDate(item.placement.actualDate) &&
          isUtcInstant(item.createdAt) &&
          isUtcInstant(item.updatedAt),
      ),
  );
  return occurrences;
}

/** Checks persisted output against the authoritative selected occurrences and immutable source. */
export async function readShoppingLedgerInSnapshot(
  session: SqlSession,
  options: StoredShoppingProjectionOptions,
): Promise<ShoppingLedger> {
  await admitShoppingMode(session, options);
  const scope = await readShoppingScopeInSnapshot(session);
  const header = (
    await session.all<{ projectionRevision: number; status: string }>(
      'SELECT projection_revision AS projectionRevision, projection_status AS status FROM shopping_scope WHERE scope_id = ?',
      [scope.scopeId],
    )
  )[0];
  stored(
    header !== undefined &&
      Number.isSafeInteger(header.projectionRevision) &&
      header.projectionRevision >= 0 &&
      header.status === 'current',
  );
  const selected = await readSelectedShoppingOccurrencesInSnapshot(session, scope);
  const expected = await buildShoppingProjection(selected, options);
  const groups = await session.all<StoredGroup>(
    `SELECT g.group_key AS groupKey, g.grouping_version AS groupingVersion, g.demand_fingerprint AS demandFingerprint,
       g.projection_revision AS projectionRevision, g.display_name AS displayName, g.quantity_label AS quantityLabel,
       p.demand_fingerprint AS purchaseFingerprint, p.purchased, p.changed, p.revision
     FROM shopping_group g LEFT JOIN purchase_state p ON p.scope_id=g.scope_id AND p.group_key=g.group_key
     WHERE g.scope_id = ? ORDER BY g.group_key`,
    [scope.scopeId],
  );
  stored(
    groups.every(
      (group) =>
        /^[0-9a-f]{64}$/.test(group.groupKey) &&
        /^[0-9a-f]{64}$/.test(group.demandFingerprint) &&
        group.purchaseFingerprint === group.demandFingerprint &&
        Number.isSafeInteger(group.projectionRevision) &&
        group.projectionRevision >= 0 &&
        group.projectionRevision <= header.projectionRevision &&
        Number.isSafeInteger(group.revision) &&
        group.revision! >= 0 &&
        [0, 1].includes(group.purchased!) &&
        [0, 1].includes(group.changed!) &&
        (group.projectionRevision === header.projectionRevision ||
          (group.purchased === 0 && group.changed === 1)),
    ),
  );
  const active = new Map(
    groups
      .filter((group) => group.projectionRevision === header.projectionRevision)
      .map((group) => [group.groupKey, group]),
  );
  stored(active.size === expected.length);
  const contributionRows = await session.all<{
    occurrenceId: string;
    recipeId: string;
    sourceKind: string;
    sourceKey: string;
    ingredientPosition: number | null;
    annotationId: string | null;
    groupKey: string;
    rawName: string;
    rawMeasure: string | null;
    quantityJson: string;
    revisionId?: string;
    contentFingerprint?: string;
  }>(
    `SELECT occurrence_id AS occurrenceId, recipe_id AS recipeId, source_kind AS sourceKind, source_key AS sourceKey,
      ingredient_position AS ingredientPosition, annotation_id AS annotationId, group_key AS groupKey,
      raw_name AS rawName, raw_measure AS rawMeasure, quantity_json AS quantityJson
      ${options.contentRefForOccurrence ? ',revision_id AS revisionId,content_fingerprint AS contentFingerprint' : ''}
    FROM shopping_contribution WHERE scope_id = ?`,
    [scope.scopeId],
  );
  const expectedContributions = new Map(
    expected.flatMap((group) =>
      group.contributions.map(
        (contribution) =>
          [contribution.contributionId, { groupKey: group.groupKey, contribution }] as const,
      ),
    ),
  );
  stored(contributionRows.length === expectedContributions.size);
  for (const row of contributionRows) {
    const id = `${row.occurrenceId}:${row.sourceKind}:${row.sourceKey}`;
    const match = expectedContributions.get(id);
    stored(match !== undefined);
    const source = match.contribution.source;
    const ref = contributionRef(options, match.contribution);
    stored(
      !ref ||
        (row.revisionId === ref.revisionId && row.contentFingerprint === ref.contentFingerprint),
    );
    stored(
      row.groupKey === match.groupKey &&
        row.recipeId === match.contribution.recipeId &&
        row.rawName === match.contribution.rawName &&
        row.rawMeasure === match.contribution.rawMeasure &&
        (source.section === 'ingredient'
          ? row.ingredientPosition === source.position && row.annotationId === null
          : row.annotationId === source.annotationId && row.ingredientPosition === null) &&
        JSON.stringify(JSON.parse(row.quantityJson)) ===
          JSON.stringify(match.contribution.quantity),
    );
    expectedContributions.delete(id);
  }
  stored(expectedContributions.size === 0);
  const hydrated: ShoppingGroup[] = expected.map((group) => {
    const row = active.get(group.groupKey);
    stored(
      row !== undefined &&
        row.groupingVersion === group.groupingVersion &&
        row.demandFingerprint === group.demandFingerprint &&
        row.displayName === group.displayName &&
        row.quantityLabel === group.quantityLabel,
    );
    return {
      groupKey: group.groupKey,
      displayName: group.displayName,
      quantityLabel: group.quantityLabel,
      demandFingerprint: group.demandFingerprint,
      contributions: group.contributions,
      purchased: row.purchased === 1,
      changed: row.changed === 1,
      revision: row.revision!,
    };
  });
  return {
    groups,
    snapshot: {
      scope,
      selectedOccurrences: selected,
      projectionRevision: header.projectionRevision,
      status: 'current',
      groups: hydrated,
    },
  };
}

async function storeContribution(
  session: SqlSession,
  scopeId: string,
  groupKey: string,
  contribution: ShoppingContribution,
  options: StoredShoppingProjectionOptions,
): Promise<void> {
  const source = contribution.source;
  const ref = contributionRef(options, contribution);
  await runBound(
    session,
    `INSERT INTO shopping_contribution (scope_id,occurrence_id,recipe_id,source_kind,source_key,ingredient_position,annotation_id,group_key,raw_name,raw_measure,quantity_json${ref ? ',revision_id,content_fingerprint' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${ref ? ',?,?' : ''})`,
    [
      scopeId,
      contribution.occurrenceId,
      contribution.recipeId,
      source.section,
      source.section === 'ingredient' ? String(source.position) : source.annotationId,
      source.section === 'ingredient' ? source.position : null,
      source.section === 'annotation' ? source.annotationId : null,
      groupKey,
      contribution.rawName,
      contribution.rawMeasure,
      JSON.stringify(contribution.quantity),
      ...(ref ? [ref.revisionId, ref.contentFingerprint] : []),
    ],
  );
}

/** Runs inside the same write transaction as plan/scope mutation and its receipt. */
export async function rebuildShoppingInSnapshot(
  session: SqlSession,
  before: ShoppingLedger,
  options: StoredShoppingProjectionOptions,
): Promise<void> {
  await admitShoppingMode(session, options);
  const scope = await readShoppingScopeInSnapshot(session);
  const next = await buildShoppingProjection(
    await readSelectedShoppingOccurrencesInSnapshot(session, scope),
    options,
  );
  const projectionRevision = nextStoredRevision(before.snapshot.projectionRevision);
  const previous = new Map(before.groups.map((group) => [group.groupKey, group]));
  const oldContributionIds = new Set(
    before.snapshot.groups.flatMap((group) =>
      group.contributions.map((item) => item.contributionId),
    ),
  );
  const newKeys = new Set(next.map((group) => group.groupKey));
  await runBound(session, 'DELETE FROM shopping_contribution WHERE scope_id = ?', [scope.scopeId]);
  // Keep dormant group/purchase identities so removal/re-add cannot inherit old purchase credit.
  for (const old of before.groups) {
    if (old.projectionRevision === before.snapshot.projectionRevision && !newKeys.has(old.groupKey))
      await runBound(
        session,
        'UPDATE purchase_state SET purchased=0, changed=1, revision=? WHERE scope_id=? AND group_key=?',
        [nextStoredRevision(old.revision!), scope.scopeId, old.groupKey],
      );
  }
  for (const group of next) {
    const old = previous.get(group.groupKey);
    const state = reconcilePurchaseState(
      group,
      old
        ? {
            demandFingerprint: old.demandFingerprint,
            purchased: old.purchased === 1,
            changed: old.changed === 1,
            revision: old.revision!,
            active: old.projectionRevision === before.snapshot.projectionRevision,
          }
        : undefined,
      group.contributions.some((item) => oldContributionIds.has(item.contributionId)),
    );
    await runBound(
      session,
      `INSERT INTO shopping_group VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, group_key) DO UPDATE SET grouping_version=excluded.grouping_version, demand_fingerprint=excluded.demand_fingerprint,
      projection_revision=excluded.projection_revision, display_name=excluded.display_name, quantity_label=excluded.quantity_label`,
      [
        scope.scopeId,
        group.groupKey,
        group.groupingVersion,
        group.demandFingerprint,
        projectionRevision,
        group.displayName,
        group.quantityLabel,
      ],
    );
    await runBound(
      session,
      `INSERT INTO purchase_state VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, group_key) DO UPDATE SET demand_fingerprint=excluded.demand_fingerprint,
      purchased=excluded.purchased, changed=excluded.changed, revision=excluded.revision`,
      [
        scope.scopeId,
        group.groupKey,
        group.demandFingerprint,
        state.purchased ? 1 : 0,
        state.changed ? 1 : 0,
        state.revision,
      ],
    );
    for (const contribution of group.contributions)
      await storeContribution(session, scope.scopeId, group.groupKey, contribution, options);
  }
  await runBound(
    session,
    "UPDATE shopping_scope SET projection_revision=?, projection_status='current' WHERE scope_id=?",
    [projectionRevision, scope.scopeId],
  );
  // Dormant identities remain for safe purchase reconciliation. New keys must not
  // commit a ledger that would fail its next bounded read; the caller owns rollback.
  if (options.contentRefForOccurrence) await admitPinnedShoppingRows(session);
}

/** Fixed table/column policy for exact-pin reads, before any legacy broad projection SELECT. */
export async function admitPinnedShoppingRows(session: SqlSession): Promise<void> {
  await requireCookingContentReadVersion(session);
  type TextColumn = readonly [name: string, bytes: number, nullable?: boolean];
  type Table = {
    name: string;
    limit: number;
    text: readonly TextColumn[];
    integers: readonly string[];
    nullableIntegers?: readonly string[];
    where?: string;
  };
  const identity: readonly TextColumn[] = [
    ['scope_id', 36],
    ['group_key', 64],
  ];
  const tables: Table[] = [
    {
      name: 'shopping_scope',
      limit: 1,
      text: [
        ['scope_id', 36],
        ['projection_status', 7],
      ],
      integers: ['revision', 'projection_revision', 'singleton'],
    },
    {
      name: 'shopping_selection',
      limit: REVISION_SHOPPING_LIMITS.occurrences,
      text: [
        ['scope_id', 36],
        ['occurrence_id', 36],
      ],
      integers: [],
    },
    {
      name: 'plan_occurrence',
      limit: REVISION_SHOPPING_LIMITS.occurrences,
      text: [
        ['occurrence_id', 36],
        ['recipe_id', 20],
        ['local_date', 10],
        ['meal_key', 16],
        ['created_at', 40],
        ['updated_at', 40],
      ],
      integers: ['revision'],
      where: 'occurrence_id IN (SELECT occurrence_id FROM shopping_selection)',
    },
    {
      name: 'plan_content_pin',
      limit: REVISION_SHOPPING_LIMITS.occurrences,
      text: [
        ['occurrence_id', 36],
        ['recipe_id', 20],
        ['revision_id', 120],
        ['content_fingerprint', 64],
      ],
      integers: [],
      where: 'occurrence_id IN (SELECT occurrence_id FROM shopping_selection)',
    },
    {
      name: 'shopping_group',
      limit: REVISION_SHOPPING_LIMITS.contributions,
      text: [
        ...identity,
        ['grouping_version', 200],
        ['demand_fingerprint', 64],
        ['display_name', 2048],
        ['quantity_label', 4096],
      ],
      integers: ['projection_revision'],
    },
    {
      name: 'shopping_contribution',
      limit: REVISION_SHOPPING_LIMITS.contributions,
      text: [
        ...identity,
        ['occurrence_id', 36],
        ['recipe_id', 20],
        ['revision_id', 120],
        ['content_fingerprint', 64],
        ['source_kind', 10],
        ['source_key', 200],
        ['annotation_id', 200, true],
        ['raw_name', 2048],
        ['raw_measure', 2048, true],
        ['quantity_json', 4096],
      ],
      integers: [],
      nullableIntegers: ['ingredient_position'],
    },
    {
      name: 'purchase_state',
      limit: REVISION_SHOPPING_LIMITS.contributions,
      text: [...identity, ['demand_fingerprint', 64]],
      integers: ['purchased', 'changed', 'revision'],
    },
  ];
  let bytes = 0;
  for (const table of tables) {
    const textInvalid = table.text.map(
      ([column, maximum, nullable]) =>
        `${nullable ? `${column} IS NOT NULL AND ` : ''}(typeof(${column})<>'text' OR length(CAST(${column} AS BLOB))>${maximum})`,
    );
    const integerInvalid = (column: string) =>
      `(typeof(${column})<>'integer' OR ${column}<0 OR ${column}>9007199254740991)`;
    const invalid = [
      ...textInvalid,
      ...table.integers.map(integerInvalid),
      ...(table.nullableIntegers ?? []).map(
        (column) => `${column} IS NOT NULL AND ${integerInvalid(column)}`,
      ),
    ]
      .map((condition) => `(${condition})`)
      .join(' OR ');
    const [budget] = await session.all<{ count: number; bytes: number; invalid: number }>(
      `SELECT COUNT(*) count,COALESCE(SUM(${table.text.map(([column]) => `COALESCE(length(CAST(${column} AS BLOB)),0)`).join('+')}),0) bytes,COALESCE(SUM(CASE WHEN ${invalid} THEN 1 ELSE 0 END),0) invalid FROM ${table.name} WHERE ${table.where ?? '1'}`,
    );
    stored(
      !!budget &&
        [budget.count, budget.bytes, budget.invalid].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) &&
        budget.count <= table.limit &&
        budget.invalid === 0,
    );
    bytes += budget.bytes;
    // Includes source text, persisted quantity JSON, identities and dormant reconciliation rows.
    stored(bytes <= REVISION_SHOPPING_LIMITS.sourceBytes * 4);
  }
}

async function admitShoppingMode(session: SqlSession, options: StoredShoppingProjectionOptions) {
  if (options.contentRefForOccurrence) return admitPinnedShoppingRows(session);
  const version = (await session.all<{ user_version: number }>('PRAGMA user_version'))[0]
    ?.user_version;
  stored(version !== undefined && version >= 2 && version < 7);
}

export function createShoppingRepository(
  reader: SerializedReader,
  options: ShoppingProjectionOptions,
) {
  return Object.freeze({
    readShopping: () =>
      readSnapshot(
        reader,
        async (session) => (await readShoppingLedgerInSnapshot(session, options)).snapshot,
      ),
  });
}
