import { isUtcInstant, validatePlanOccurrence } from '@cookmate/contracts';
import type { PlanEffect, PlanOccurrence, Placement } from '@cookmate/contracts';
import { isSupportedPlanDate } from '@cookmate/domain';
import type { ShoppingProjectionOptions } from '@cookmate/domain';
import { rejectCommand } from './commandExecutor';
import type { CommandHandlers, MutationOutcome } from './commandExecutor';
import {
  nextStoredRevision,
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from './shoppingRepository';
import type { ShoppingLedger } from './shoppingRepository';
import { runBound, StorageFault } from './sql';
import type { SqlSession } from './sql';

async function readOccurrence(
  session: SqlSession,
  id: string,
  options: ShoppingProjectionOptions,
): Promise<PlanOccurrence | null> {
  const row = (
    await session.all<Omit<PlanOccurrence, 'placement'> & Placement>(
      `SELECT occurrence_id AS occurrenceId, recipe_id AS recipeId, local_date AS actualDate, meal_key AS mealKey,
      revision, created_at AS createdAt, updated_at AS updatedAt FROM plan_occurrence WHERE occurrence_id=?`,
      [id],
    )
  )[0];
  if (!row) return null;
  const { actualDate, mealKey, ...values } = row;
  const occurrence = { ...values, placement: { actualDate, mealKey } };
  if (
    !validatePlanOccurrence(occurrence) ||
    !isSupportedPlanDate(actualDate) ||
    !isUtcInstant(row.createdAt) ||
    !isUtcInstant(row.updatedAt) ||
    !options.readRecipe(row.recipeId)
  )
    throw new StorageFault('storage_failure', 'Stored plan occurrence is invalid');
  return occurrence;
}
async function currentOccurrence(
  session: SqlSession,
  id: string,
  revision: number,
  options: ShoppingProjectionOptions,
): Promise<PlanOccurrence> {
  const occurrence = await readOccurrence(session, id, options);
  if (!occurrence || occurrence.revision !== revision)
    rejectCommand('stale_context', 'plan.occurrence_changed');
  return occurrence;
}
function samePlacement(left: Placement, right: Placement): boolean {
  return left.actualDate === right.actualDate && left.mealKey === right.mealKey;
}
function requirePlacement(placement: Placement): void {
  if (!isSupportedPlanDate(placement.actualDate))
    rejectCommand('invalid_input', 'plan.invalid_date');
}
async function requireEmptyTarget(
  session: SqlSession,
  placement: Placement,
  selfId?: string,
): Promise<void> {
  requirePlacement(placement);
  const target = (
    await session.all<{ occurrenceId: string }>(
      'SELECT occurrence_id AS occurrenceId FROM plan_occurrence WHERE local_date=? AND meal_key=?',
      [placement.actualDate, placement.mealKey],
    )
  )[0];
  if (target && target.occurrenceId !== selfId)
    rejectCommand('stale_context', 'plan.target_occupied');
}
function requireScope(before: ShoppingLedger, revision: number): void {
  if (before.snapshot.scope.revision !== revision)
    rejectCommand('stale_context', 'shopping.selection_changed');
}
function effect(
  occurrence: PlanOccurrence,
  change: PlanEffect['change'],
  revision = occurrence.revision,
): PlanEffect {
  return {
    kind: 'plan',
    entityId: occurrence.occurrenceId,
    revision,
    change,
    recipeId: occurrence.recipeId,
    placement: occurrence.placement,
  };
}
function result(effects: PlanEffect[], changed: boolean, shopping: boolean): MutationOutcome {
  return {
    outcome: changed ? 'committed' : 'no_op',
    effects,
    collections: changed ? (shopping ? ['plan', 'shopping'] : ['plan']) : [],
    shoppingProjection: shopping ? 'current' : 'unchanged',
  };
}
async function updateOccurrence(session: SqlSession, occurrence: PlanOccurrence): Promise<void> {
  // FK source/recipe pairs cannot point at the former recipe while an occurrence changes recipe.
  await runBound(session, 'DELETE FROM shopping_contribution WHERE occurrence_id=?', [
    occurrence.occurrenceId,
  ]);
  await runBound(
    session,
    'UPDATE plan_occurrence SET recipe_id=?, local_date=?, meal_key=?, revision=?, updated_at=? WHERE occurrence_id=?',
    [
      occurrence.recipeId,
      occurrence.placement.actualDate,
      occurrence.placement.mealKey,
      occurrence.revision,
      occurrence.updatedAt,
      occurrence.occurrenceId,
    ],
  );
}

export function createPlanCommandHandlers(
  options: ShoppingProjectionOptions,
): Pick<
  CommandHandlers,
  'addPlan' | 'editPlan' | 'replacePlanRecipe' | 'movePlanReplacing' | 'removePlan'
> {
  return {
    addPlan: async (session, command, timestamp) => {
      if (await readOccurrence(session, command.occurrenceId, options))
        rejectCommand('operation_conflict', 'plan.occurrence_id_reused');
      await requireEmptyTarget(session, command.placement);
      const occurrence: PlanOccurrence = {
        occurrenceId: command.occurrenceId,
        recipeId: command.recipeId,
        placement: command.placement,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await runBound(session, 'INSERT INTO plan_occurrence VALUES (?, ?, ?, ?, ?, ?, ?)', [
        occurrence.occurrenceId,
        occurrence.recipeId,
        occurrence.placement.actualDate,
        occurrence.placement.mealKey,
        occurrence.revision,
        timestamp,
        timestamp,
      ]);
      // Newly added occurrences are deliberately unselected.
      return result([effect(occurrence, 'added')], true, false);
    },
    editPlan: async (session, command, timestamp) => {
      const current = await currentOccurrence(
        session,
        command.occurrenceId,
        command.expectedRevision,
        options,
      );
      await requireEmptyTarget(session, command.placement, current.occurrenceId);
      const before = await readShoppingLedgerInSnapshot(session, options);
      requireScope(before, command.expectedShoppingScopeRevision);
      if (
        samePlacement(current.placement, command.placement) &&
        command.recipeId === current.recipeId
      )
        return result([effect(current, 'unchanged')], false, false);
      const next = {
        ...current,
        recipeId: command.recipeId,
        placement: command.placement,
        revision: nextStoredRevision(current.revision),
        updatedAt: timestamp,
      };
      const selected = before.snapshot.scope.occurrenceIds.includes(current.occurrenceId);
      if (current.recipeId !== next.recipeId) {
        await updateOccurrence(session, next);
        if (selected) await rebuildShoppingInSnapshot(session, before, options);
      } else {
        // Placement-only movement cannot change ingredient demand or purchase state.
        await runBound(
          session,
          'UPDATE plan_occurrence SET local_date=?, meal_key=?, revision=?, updated_at=? WHERE occurrence_id=?',
          [
            next.placement.actualDate,
            next.placement.mealKey,
            next.revision,
            timestamp,
            next.occurrenceId,
          ],
        );
      }
      return result([effect(next, 'updated')], true, selected);
    },
    replacePlanRecipe: async (session, command, timestamp) => {
      const current = await currentOccurrence(
        session,
        command.occurrenceId,
        command.expectedRevision,
        options,
      );
      requirePlacement(command.placement);
      if (!samePlacement(current.placement, command.placement))
        rejectCommand('stale_context', 'plan.replacement_placement_changed');
      const before = await readShoppingLedgerInSnapshot(session, options);
      requireScope(before, command.expectedShoppingScopeRevision);
      if (current.recipeId === command.recipeId)
        return result([effect(current, 'unchanged')], false, false);
      const next = {
        ...current,
        recipeId: command.recipeId,
        revision: nextStoredRevision(current.revision),
        updatedAt: timestamp,
      };
      await updateOccurrence(session, next);
      const selected = before.snapshot.scope.occurrenceIds.includes(current.occurrenceId);
      if (selected) await rebuildShoppingInSnapshot(session, before, options);
      return result([effect(next, 'updated')], true, selected);
    },
    movePlanReplacing: async (session, command, timestamp) => {
      const current = await currentOccurrence(
        session,
        command.occurrenceId,
        command.expectedRevision,
        options,
      );
      const destination = await currentOccurrence(
        session,
        command.destinationOccurrenceId,
        command.expectedDestinationRevision,
        options,
      );
      requirePlacement(command.placement);
      if (
        current.occurrenceId === destination.occurrenceId ||
        !samePlacement(destination.placement, command.placement)
      )
        rejectCommand('stale_context', 'plan.destination_changed');
      const before = await readShoppingLedgerInSnapshot(session, options);
      requireScope(before, command.expectedShoppingScopeRevision);
      const selected = before.snapshot.scope.occurrenceIds.includes(current.occurrenceId);
      const destinationSelected = before.snapshot.scope.occurrenceIds.includes(
        destination.occurrenceId,
      );
      await runBound(session, 'DELETE FROM shopping_selection WHERE occurrence_id=?', [
        destination.occurrenceId,
      ]);
      await runBound(session, 'DELETE FROM plan_occurrence WHERE occurrence_id=?', [
        destination.occurrenceId,
      ]);
      if (destinationSelected)
        await runBound(session, 'UPDATE shopping_scope SET revision=? WHERE scope_id=?', [
          nextStoredRevision(before.snapshot.scope.revision),
          before.snapshot.scope.scopeId,
        ]);
      const next = {
        ...current,
        recipeId: command.recipeId,
        placement: command.placement,
        revision: nextStoredRevision(current.revision),
        updatedAt: timestamp,
      };
      await updateOccurrence(session, next);
      if (selected || destinationSelected)
        await rebuildShoppingInSnapshot(session, before, options);
      return result(
        [
          effect(destination, 'removed', nextStoredRevision(destination.revision)),
          effect(next, 'updated'),
        ],
        true,
        selected || destinationSelected,
      );
    },
    removePlan: async (session, command) => {
      const current = await currentOccurrence(
        session,
        command.occurrenceId,
        command.expectedRevision,
        options,
      );
      const before = await readShoppingLedgerInSnapshot(session, options);
      requireScope(before, command.expectedShoppingScopeRevision);
      const selected = before.snapshot.scope.occurrenceIds.includes(current.occurrenceId);
      await runBound(session, 'DELETE FROM shopping_selection WHERE occurrence_id=?', [
        current.occurrenceId,
      ]);
      await runBound(session, 'DELETE FROM plan_occurrence WHERE occurrence_id=?', [
        current.occurrenceId,
      ]);
      if (selected) {
        await runBound(session, 'UPDATE shopping_scope SET revision=? WHERE scope_id=?', [
          nextStoredRevision(before.snapshot.scope.revision),
          before.snapshot.scope.scopeId,
        ]);
        await rebuildShoppingInSnapshot(session, before, options);
      }
      return result(
        [effect(current, 'removed', nextStoredRevision(current.revision))],
        true,
        selected,
      );
    },
  };
}
