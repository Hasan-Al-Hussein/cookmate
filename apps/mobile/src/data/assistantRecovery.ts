import { phaseAfterCancel, phaseAfterStartupSuspension } from '@cookmate/contracts';
import type { CatalogueBoundary } from '@cookmate/contracts';
import { readAssistantIntentInSnapshot } from './assistantIntentRecords';
import { parseStoredIntent } from './conversationRecords';
import { readRevision } from './query';
import { runBound, StorageFault } from './sql';
import type { SerializedWriter } from './sql';

/** Run before exposing any services on process start. Restoring state never dispatches effects. */
export async function recoverInterruptedAssistantWork(
  writer: SerializedWriter,
  catalogue: CatalogueBoundary,
): Promise<void> {
  await writer.transaction(async (session) => {
    const rows = await session.all<{
      userIntentId: string;
      revision: number;
      phase: string;
      intentJson: string;
    }>(
      `SELECT user_intent_id AS userIntentId, revision, phase, intent_json AS intentJson FROM pending_intent
       WHERE phase NOT IN ('settled', 'cancelled') AND (phase != 'reconciling' OR EXISTS (
         SELECT 1 FROM assistant_intent_context a WHERE a.user_intent_id = pending_intent.user_intent_id AND a.lifecycle != 'cancelled'))`,
    );
    let changed = false;
    let semanticChange = false;
    const retiredIds: string[] = [];
    for (const row of rows) {
      const intent = parseStoredIntent(row.intentJson, row);
      const saved = await readAssistantIntentInSnapshot(session, catalogue, intent.userIntentId);
      const suspendedPhase =
        saved?.lifecycle === 'accepted' &&
        saved.response?.kind === 'proposal' &&
        saved.actionPlan !== null
          ? phaseAfterStartupSuspension(intent.phase)
          : null;
      const phase = suspendedPhase ?? phaseAfterCancel(intent.phase);
      if (phase !== intent.phase) {
        await runBound(
          session,
          'UPDATE pending_intent SET phase = ?, intent_json = ? WHERE user_intent_id = ?',
          [phase, JSON.stringify({ ...intent, phase }), intent.userIntentId],
        );
        changed = true;
        if (suspendedPhase === null) semanticChange = true;
      }
      if (suspendedPhase !== null || !saved || saved.lifecycle === 'cancelled') continue;
      await runBound(
        session,
        "UPDATE assistant_intent_context SET lifecycle = 'cancelled' WHERE user_intent_id = ?",
        [intent.userIntentId],
      );
      retiredIds.push(intent.userIntentId);
      changed = true;
      semanticChange = true;
    }
    const unfinished = await session.all<{ messageId: string }>(
      "SELECT message_id AS messageId FROM message WHERE status = 'sending'",
    );
    if (unfinished.length > 0) {
      await runBound(
        session,
        "UPDATE message SET status = 'interrupted' WHERE status = 'sending'",
        [],
      );
      changed = true;
      semanticChange = true;
    }
    if (!changed) return;
    // Suspending frozen execution authority alone does not change the interpreted conversation.
    for (const collection of semanticChange ? ['store', 'conversation'] : ['store']) {
      const revision = await readRevision(session, collection);
      if (!Number.isSafeInteger(revision + 1))
        throw new StorageFault('storage_failure', 'Revision exhausted');
      await runBound(session, 'UPDATE state_revision SET revision = ? WHERE collection = ?', [
        revision + 1,
        collection,
      ]);
    }
    const contextRevision = await readRevision(session, 'conversation');
    for (const userIntentId of retiredIds)
      await runBound(
        session,
        "UPDATE assistant_intent_context SET context_revision=? WHERE user_intent_id=? AND lifecycle='cancelled' AND guards_json IS NULL",
        [contextRevision, userIntentId],
      );
  });
}
