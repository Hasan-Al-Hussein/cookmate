import type { PreferenceSnapshot } from '@cookmate/contracts';
import { rejectCommand } from './commandExecutor';
import type { CommandHandlers, MutationOutcome } from './commandExecutor';
import { readPreferencesInSnapshot } from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SqlSession } from './sql';
import { recordPreferenceSourceLink, withdrawPreferenceVersions } from './preferenceProvenance';
import { encodeStoredText } from './storedText';

async function currentPreferences(
  session: SqlSession,
  expectedRevision: number,
): Promise<PreferenceSnapshot> {
  const snapshot = await readPreferencesInSnapshot(session);
  if (snapshot.revision !== expectedRevision) rejectCommand('stale_context', 'preferences.changed');
  return snapshot;
}
function outcome(entityId: string, revision: number, changed: boolean): MutationOutcome {
  return {
    outcome: changed ? 'committed' : 'no_op',
    collections: changed ? ['preferences'] : [],
    shoppingProjection: 'unchanged',
    effects: [{ kind: 'preference', entityId, revision }],
  };
}
function nextRevision(current: number): number {
  if (!Number.isSafeInteger(current + 1))
    throw new StorageFault('storage_failure', 'Preference revision exhausted');
  return current + 1;
}

/** Explicit app-authorized preference commands; passing chat mentions never call these handlers. */
export const preferenceCommandHandlers: Pick<
  CommandHandlers,
  'savePreference' | 'removePreference' | 'clearPreferences'
> = {
  savePreference: async (session, command, _timestamp, context) => {
    const snapshot = await currentPreferences(session, command.expectedPreferenceRevision);
    const existing = snapshot.items.find((item) => item.preferenceId === command.preferenceId);
    const duplicate = snapshot.items.find(
      (item) => item.type === command.type && item.value === command.explicitValue,
    );
    if (duplicate) {
      if (existing && existing.preferenceId !== duplicate.preferenceId)
        rejectCommand('invalid_input', 'preferences.duplicate_value');
      return {
        ...outcome(duplicate.preferenceId, snapshot.revision, false),
        conversationChanged: await recordPreferenceSourceLink(session, context, duplicate),
      };
    }
    if (!existing && snapshot.items.length >= 100) rejectCommand('too_large', 'preferences.limit');
    const revision = nextRevision(snapshot.revision);
    const withdrawn = existing
      ? await withdrawPreferenceVersions(session, [existing], revision)
      : false;
    await runBound(
      session,
      'INSERT INTO saved_preference VALUES (?, ?, ?, ?) ON CONFLICT(preference_id) DO UPDATE SET type = excluded.type, value = excluded.value, revision = excluded.revision',
      [command.preferenceId, command.type, encodeStoredText(command.explicitValue), revision],
    );
    const linked = await recordPreferenceSourceLink(session, context, {
      preferenceId: command.preferenceId,
      type: command.type,
      value: command.explicitValue,
      revision,
    });
    return {
      ...outcome(command.preferenceId, revision, true),
      conversationChanged: linked || withdrawn,
    };
  },
  removePreference: async (session, command) => {
    const snapshot = await currentPreferences(session, command.expectedPreferenceRevision);
    const existing = snapshot.items.find((item) => item.preferenceId === command.preferenceId);
    if (!existing) return outcome(command.preferenceId, snapshot.revision, false);
    const revision = nextRevision(snapshot.revision);
    const withdrawn = await withdrawPreferenceVersions(session, [existing], revision);
    await runBound(session, 'DELETE FROM saved_preference WHERE preference_id = ?', [
      command.preferenceId,
    ]);
    return { ...outcome(command.preferenceId, revision, true), conversationChanged: withdrawn };
  },
  clearPreferences: async (session, command) => {
    const snapshot = await currentPreferences(session, command.expectedPreferenceRevision);
    if (snapshot.items.length === 0) return outcome('preferences', snapshot.revision, false);
    const revision = nextRevision(snapshot.revision);
    const withdrawn = await withdrawPreferenceVersions(session, snapshot.items, revision);
    await runBound(session, 'DELETE FROM saved_preference', []);
    return { ...outcome('preferences', revision, true), conversationChanged: withdrawn };
  },
};
