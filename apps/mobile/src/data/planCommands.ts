import { isUtcInstant, validatePlanOccurrence } from '@cookmate/contracts';
import type { PlanEffect, PlanOccurrence, Placement } from '@cookmate/contracts';
import { isSupportedPlanDate } from '@cookmate/domain';
import type { ShoppingProjectionOptions } from '@cookmate/domain';
import type { RecipeContentRef } from '@cookmate/catalogue/content';
import { contentCommandSession, type ContentCommandContext } from './contentCommandContext';
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
  content?: ContentCommandContext,
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
    (!content && !options.readRecipe(row.recipeId))
  )
    throw new StorageFault('storage_failure', 'Stored plan occurrence is invalid');
  if (content) await content.readPin(session, id, row.recipeId);
  return occurrence;
}
async function currentOccurrence(
  session: SqlSession,
  id: string,
  revision: number,
  options: ShoppingProjectionOptions,
  content?: ContentCommandContext,
): Promise<PlanOccurrence> {
  const occurrence = await readOccurrence(session, id, options, content);
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
async function updateOccurrence(
  session: SqlSession,
  occurrence: PlanOccurrence,
  content?: ContentCommandContext,
  replacementPin?: RecipeContentRef,
): Promise<void> {
  // FK source/recipe pairs cannot point at the former recipe while an occurrence changes recipe.
  await runBound(session, 'DELETE FROM shopping_contribution WHERE occurrence_id=?', [
    occurrence.occurrenceId,
  ]);
  if (replacementPin)
    await runBound(session, 'DELETE FROM plan_content_pin WHERE occurrence_id=?', [
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
  if (replacementPin) await content!.insertPin(session, occurrence.occurrenceId, replacementPin);
}

export function createPlanCommandHandlers(
  options: ShoppingProjectionOptions,
  content?: ContentCommandContext,
): Pick<
  CommandHandlers,
  'addPlan' | 'editPlan' | 'replacePlanRecipe' | 'movePlanReplacing' | 'removePlan'
> {
  const projection = (session: SqlSession) =>
    content ? content.projection(session) : Promise.resolve(options);
  return {
    addPlan: async (session, command, timestamp) => {
      session = await contentCommandSession(session, content);
      if (await readOccurrence(session, command.occurrenceId, options, content))
        rejectCommand('operation_conflict', 'plan.occurrence_id_reused');
      await requireEmptyTarget(session, command.placement);
      await content?.requirePlanCapacity(session);
      const pin = await content?.retainCurrent(session, command.recipeId);
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
      if (pin) await content!.insertPin(session, occurrence.occurrenceId, pin);
      // Newly added occurrences are deliberately unselected.
      return result([effect(occurrence, 'added')], true, false);
    },
    editPlan: async (session, command, timestamp) => {
      session = await contentCommandSession(session, content);
      const current = await currentOccurrence(
        session,
        command.occurrenceId,
        command.expectedRevision,
        options,
        content,
      );
      await requireEmptyTarget(session, command.placement, current.occurrenceId);
      const before = await readShoppingLedgerInSnapshot(session, await projection(session));
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
        const pin = await content?.retainCurrent(session, next.recipeId);
        await updateOccurrence(session, next, content, pin);
        if (selected) await rebuildShoppingInSnapshot(session, before, await projection(session));
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
      session = await contentCommandSession(session, content);
      const current = await currentOccurrence(
        session,
        command.occurrenceId,
        command.expectedRevision,
        options,
        content,
      );
      requirePlacement(command.placement);
      if (!samePlacement(current.placement, command.placement))
        rejectCommand('stale_context', 'plan.replacement_placement_changed');
      const before = await readShoppingLedgerInSnapshot(session, await projection(session));
      requireScope(before, command.expectedShoppingScopeRevision);
      if (current.recipeId === command.recipeId)
        return result([effect(current, 'unchanged')], false, false);
      const next = {
        ...current,
        recipeId: command.recipeId,
        revision: nextStoredRevision(current.revision),
        updatedAt: timestamp,
      };
      const pin = await content?.retainCurrent(session, next.recipeId);
      await updateOccurrence(session, next, content, pin);
      const selected = before.snapshot.scope.occurrenceIds.includes(current.occurrenceId);
      if (selected) await rebuildShoppingInSnapshot(session, before, await projection(session));
      return result([effect(next, 'updated')], true, selected);
    },
    movePlanReplacing: async (session, command, timestamp) => {
      session = await contentCommandSession(session, content);
      const current = await currentOccurrence(
        session,
        command.occurrenceId,
        command.expectedRevision,
        options,
        content,
      );
      const destination = await currentOccurrence(
        session,
        command.destinationOccurrenceId,
        command.expectedDestinationRevision,
        options,
        content,
      );
      requirePlacement(command.placement);
      if (
        current.occurrenceId === destination.occurrenceId ||
        !samePlacement(destination.placement, command.placement)
      )
        rejectCommand('stale_context', 'plan.destination_changed');
      const before = await readShoppingLedgerInSnapshot(session, await projection(session));
      requireScope(before, command.expectedShoppingScopeRevision);
      const selected = before.snapshot.scope.occurrenceIds.includes(current.occurrenceId);
      const destinationSelected = before.snapshot.scope.occurrenceIds.includes(
        destination.occurrenceId,
      );
      const pin =
        content && current.recipeId !== command.recipeId
          ? await content.retainCurrent(session, command.recipeId)
          : undefined;
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
      await updateOccurrence(session, next, content, pin);
      if (selected || destinationSelected)
        await rebuildShoppingInSnapshot(session, before, await projection(session));
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
      session = await contentCommandSession(session, content);
      const current = await currentOccurrence(
        session,
        command.occurrenceId,
        command.expectedRevision,
        options,
        content,
      );
      const before = await readShoppingLedgerInSnapshot(session, await projection(session));
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
        await rebuildShoppingInSnapshot(session, before, await projection(session));
      }
      return result(
        [effect(current, 'removed', nextStoredRevision(current.revision))],
        true,
        selected,
      );
    },
  };
}
