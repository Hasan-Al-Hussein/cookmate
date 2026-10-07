import { isUtcInstant } from '@cookmate/contracts';
import { runBound, StorageFault } from './sql';
import type { CommandHandlers } from './commandExecutor';

export const favouriteCommandHandlers: Pick<CommandHandlers, 'setFavourite'> = {
  setFavourite: async (session, command, timestamp) => {
    const existing = (
      await session.all<{ saved: number; revision: number; savedAt: string }>(
        'SELECT saved, revision, saved_at AS savedAt FROM favourite WHERE recipe_id = ?',
        [command.recipeId],
      )
    )[0];
    if (
      existing &&
      (!Number.isSafeInteger(existing.revision) ||
        existing.revision < 0 ||
        !isUtcInstant(existing.savedAt) ||
        ![0, 1].includes(existing.saved))
    )
      throw new StorageFault('storage_failure', 'Stored favourite is invalid');
    if ((existing?.saved === 1) === command.saved)
      return {
        outcome: 'no_op',
        collections: [],
        shoppingProjection: 'unchanged',
        effects: [
          {
            kind: 'favourite',
            entityId: command.recipeId,
            revision: existing?.revision ?? 0,
            saved: command.saved,
          },
        ],
      };
    const revision = (existing?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision))
      throw new StorageFault('storage_failure', 'Favourite revision exhausted');
    await runBound(
      session,
      'INSERT INTO favourite VALUES (?, ?, ?, ?, ?) ON CONFLICT(recipe_id) DO UPDATE SET saved=excluded.saved, revision=excluded.revision, saved_at=excluded.saved_at, updated_at=excluded.updated_at',
      [
        command.recipeId,
        command.saved ? 1 : 0,
        revision,
        command.saved ? timestamp : existing!.savedAt,
        timestamp,
      ],
    );
    return {
      outcome: 'committed',
      collections: ['favourites'],
      shoppingProjection: 'unchanged',
      effects: [{ kind: 'favourite', entityId: command.recipeId, revision, saved: command.saved }],
    };
  },
};
