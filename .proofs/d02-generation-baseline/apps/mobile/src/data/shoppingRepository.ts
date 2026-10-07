import { isUtcInstant, validatePlanOccurrence } from '@cookmate/contracts';
import type { PlanOccurrence, ShoppingScope } from '@cookmate/contracts';
import {
  buildShoppingProjection,
  isSupportedPlanDate,
  reconcilePurchaseState,
} from '@cookmate/domain';
import type {
  ShoppingContribution,
  ShoppingGroup,
  ShoppingProjectionOptions,
  ShoppingSnapshot,
} from '@cookmate/domain';
import { readSnapshot } from './query';
import { readShoppingScopeInSnapshot } from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SerializedReader, SqlSession } from './sql';

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

async function selectedOccurrences(
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
  options: ShoppingProjectionOptions,
): Promise<ShoppingLedger> {
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
  const selected = await selectedOccurrences(session, scope);
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
  }>(
    `SELECT occurrence_id AS occurrenceId, recipe_id AS recipeId, source_kind AS sourceKind, source_key AS sourceKey,
      ingredient_position AS ingredientPosition, annotation_id AS annotationId, group_key AS groupKey,
      raw_name AS rawName, raw_measure AS rawMeasure, quantity_json AS quantityJson
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
): Promise<void> {
  const source = contribution.source;
  await runBound(
    session,
    'INSERT INTO shopping_contribution VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
    ],
  );
}

/** Runs inside the same write transaction as plan/scope mutation and its receipt. */
export async function rebuildShoppingInSnapshot(
  session: SqlSession,
  before: ShoppingLedger,
  options: ShoppingProjectionOptions,
): Promise<void> {
  const scope = await readShoppingScopeInSnapshot(session);
  const next = await buildShoppingProjection(await selectedOccurrences(session, scope), options);
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
      await storeContribution(session, scope.scopeId, group.groupKey, contribution);
  }
  await runBound(
    session,
    "UPDATE shopping_scope SET projection_revision=?, projection_status='current' WHERE scope_id=?",
    [projectionRevision, scope.scopeId],
  );
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
