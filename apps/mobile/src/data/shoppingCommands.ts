import type { ShoppingProjectionOptions } from '@cookmate/domain';
import { rejectCommand } from './commandExecutor';
import type { CommandHandlers } from './commandExecutor';
import {
  nextStoredRevision,
  readShoppingLedgerInSnapshot,
  rebuildShoppingInSnapshot,
} from './shoppingRepository';
import { runBound } from './sql';
import { readRevision } from './query';
import { contentCommandSession, type ContentCommandContext } from './contentCommandContext';
import type { SqlSession } from './sql';

export function createShoppingCommandHandlers(
  options: ShoppingProjectionOptions,
  content?: ContentCommandContext,
): Pick<CommandHandlers, 'setShoppingSelection' | 'setPurchased'> {
  const projection = (session: SqlSession) =>
    content ? content.projection(session) : Promise.resolve(options);
  return {
    setShoppingSelection: async (session, command) => {
      session = await contentCommandSession(session, content);
      if (
        command.expectedShoppingRevision !== undefined &&
        command.expectedShoppingRevision !== (await readRevision(session, 'shopping'))
      )
        rejectCommand('stale_context', 'shopping.reviewed_purchases_changed');
      const before = await readShoppingLedgerInSnapshot(session, await projection(session));
      const scope = before.snapshot.scope;
      if (scope.revision !== command.expectedShoppingScopeRevision)
        rejectCommand('stale_context', 'shopping.selection_changed');
      const selected = [...new Set(command.occurrenceIds)].sort();
      if (selected.length !== command.occurrenceIds.length)
        rejectCommand('invalid_input', 'shopping.duplicate_selection');
      const same =
        selected.length === scope.occurrenceIds.length &&
        selected.every((id, index) => id === scope.occurrenceIds[index]);
      if (same)
        return {
          outcome: 'no_op',
          collections: [],
          shoppingProjection: 'unchanged',
          effects: [
            { kind: 'shopping_selection', entityId: scope.scopeId, revision: scope.revision },
          ],
        };
      // Check every ID before changing the selection; no missing occurrence is silently dropped.
      for (const id of selected) {
        if (
          !(
            await session.all('SELECT occurrence_id FROM plan_occurrence WHERE occurrence_id=?', [
              id,
            ])
          ).length
        )
          rejectCommand('stale_context', 'shopping.occurrence_missing');
      }
      await runBound(session, 'DELETE FROM shopping_selection WHERE scope_id=?', [scope.scopeId]);
      for (const id of selected)
        await runBound(session, 'INSERT INTO shopping_selection VALUES (?, ?)', [
          scope.scopeId,
          id,
        ]);
      const revision = nextStoredRevision(scope.revision);
      await runBound(session, 'UPDATE shopping_scope SET revision=? WHERE scope_id=?', [
        revision,
        scope.scopeId,
      ]);
      await rebuildShoppingInSnapshot(session, before, await projection(session));
      return {
        outcome: 'committed',
        collections: ['shopping'],
        shoppingProjection: 'current',
        effects: [{ kind: 'shopping_selection', entityId: scope.scopeId, revision }],
      };
    },
    setPurchased: async (session, command) => {
      session = await contentCommandSession(session, content);
      const { snapshot } = await readShoppingLedgerInSnapshot(session, await projection(session));
      const group = snapshot.groups.find((item) => item.groupKey === command.groupKey);
      if (
        snapshot.scope.scopeId !== command.scopeId ||
        !group ||
        group.demandFingerprint !== command.expectedDemandFingerprint ||
        group.revision !== command.expectedRevision
      )
        rejectCommand('stale_context', 'shopping.demand_changed');
      const changed = group.purchased !== command.purchased || group.changed;
      const revision = changed ? nextStoredRevision(group.revision) : group.revision;
      if (changed)
        await runBound(
          session,
          'UPDATE purchase_state SET purchased=?, changed=0, revision=? WHERE scope_id=? AND group_key=?',
          [command.purchased ? 1 : 0, revision, command.scopeId, command.groupKey],
        );
      return {
        outcome: changed ? 'committed' : 'no_op',
        collections: changed ? ['shopping'] : [],
        shoppingProjection: changed ? 'current' : 'unchanged',
        effects: [{ kind: 'purchase', entityId: group.groupKey, revision }],
      };
    },
  };
}
