import type { SavedPreference } from '@cookmate/contracts';
import type { CommandExecutionContext } from './commandExecutor';
import { runBound, StorageFault } from './sql';
import type { SqlSession } from './sql';
import { decodeStoredText, encodeStoredText } from './storedText';

/** App-owned receipt/source linkage. Never infer a source from text or from an assistant message. */
export async function recordPreferenceSourceLink(
  session: SqlSession,
  context: CommandExecutionContext,
  preference: SavedPreference,
): Promise<boolean> {
  const origin = context.origin;
  if (!origin) return false;
  const user = (
    await session.all<{ role: string }>(
      `SELECT m.role FROM message m JOIN conversation c
    ON c.conversation_id=m.conversation_id AND c.generation=m.generation
    WHERE m.message_id=? AND m.conversation_id=? AND m.generation=?`,
      [origin.messageId, origin.conversationId, origin.generation],
    )
  )[0];
  if (!user || user.role !== 'user') return false;
  const existing = (
    await session.all<{ type: string; value: string; removedRevision: number | null }>(
      `SELECT type, value, removed_revision AS removedRevision FROM source_preference_link
    WHERE source_message_id=? AND preference_id=? AND saved_revision=?`,
      [origin.messageId, preference.preferenceId, preference.revision],
    )
  )[0];
  if (existing) {
    if (
      existing.type !== preference.type ||
      decodeStoredText(existing.value) !== preference.value ||
      existing.removedRevision !== null
    )
      throw new StorageFault(
        'storage_failure',
        'Stored preference provenance conflicts with live version',
      );
    return false;
  }
  await runBound(session, 'INSERT INTO source_preference_link VALUES (?, ?, ?, ?, ?, NULL, ?)', [
    origin.messageId,
    preference.preferenceId,
    preference.type,
    encodeStoredText(preference.value),
    preference.revision,
    context.operationId,
  ]);
  return true;
}

/** Only actual version withdrawal advances the global marker; empty clear/removal does not. */
export async function withdrawPreferenceVersions(
  session: SqlSession,
  preferences: readonly SavedPreference[],
  removalRevision: number,
): Promise<boolean> {
  if (!preferences.length) return false;
  let linked = false;
  for (const preference of preferences) {
    const existing = await session.all(
      'SELECT 1 FROM source_preference_link WHERE preference_id=? AND saved_revision=? AND removed_revision IS NULL',
      [preference.preferenceId, preference.revision],
    );
    if (existing.length) {
      linked = true;
      await runBound(
        session,
        'UPDATE source_preference_link SET removed_revision=? WHERE preference_id=? AND saved_revision=? AND removed_revision IS NULL',
        [removalRevision, preference.preferenceId, preference.revision],
      );
    }
  }
  await runBound(session, 'UPDATE preference_state SET last_removal_revision=? WHERE singleton=1', [
    removalRevision,
  ]);
  return linked;
}
