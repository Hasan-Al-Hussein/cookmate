import { checkLocalCommand, matchOperationReceipt } from '@cookmate/contracts';
import type { CatalogueBoundary } from '@cookmate/contracts';
import type { CookMateCommands, CookMateQueries, DirectRecoveryEntry } from '@cookmate/domain';
import { verifyCommandFingerprint } from '@cookmate/domain';
import type { CommandPlatform } from '@cookmate/domain';
import { CommandFault, rejectCommand } from './commandExecutor';
import { equivalentJson, parseBoundedJson } from './assistantIntentRecords';
import { isAppId, isRevision, parseStoredIntent } from './conversationRecords';
import { freezeResult, readRevision } from './query';
import { readReceiptInSnapshot } from './stateRepositories';
import { runBound, StorageFault } from './sql';
import type { SerializedWriter, SqlSession } from './sql';

interface RecoveryRow {
  sequence: number;
  operationId: string;
  userIntentId: string;
  revision: number;
  phase: string;
  intentJson: string;
  commandJson: string;
  slotId: string;
}
const query = `SELECT r.sequence,r.operation_id AS operationId,s.user_intent_id AS userIntentId,
 p.revision,p.phase,p.intent_json AS intentJson,s.command_json AS commandJson,s.slot_id AS slotId
 FROM direct_command_recovery r LEFT JOIN command_slot s ON s.operation_id=r.operation_id LEFT JOIN pending_intent p ON p.user_intent_id=s.user_intent_id`;
async function entry(
  session: SqlSession,
  row: RecoveryRow,
  catalogue: CatalogueBoundary,
  platform: Pick<CommandPlatform, 'sha256'>,
): Promise<DirectRecoveryEntry> {
  const intent = parseStoredIntent(row.intentJson, row);
  const command = checkLocalCommand(parseBoundedJson(row.commandJson), catalogue);
  if (
    !isRevision(row.sequence) ||
    intent.origin ||
    !command.ok ||
    command.value.origin ||
    command.value.userIntentId !== intent.userIntentId ||
    command.value.operationId !== row.operationId ||
    !intent.slots.some(
      (slot) => slot.slotId === row.slotId && equivalentJson(slot.command, command.value),
    )
  )
    throw new StorageFault('storage_failure', 'Invalid direct recovery record');
  if (!(await verifyCommandFingerprint(command.value, platform)))
    throw new StorageFault('storage_failure', 'Invalid direct recovery fingerprint');
  const receipt = await readReceiptInSnapshot(session, row.operationId, catalogue);
  if (receipt && matchOperationReceipt(command.value, receipt) !== 'existing')
    throw new StorageFault('storage_failure', 'Conflicting direct recovery receipt');
  if (!receipt && intent.phase === 'settled')
    throw new StorageFault('storage_failure', 'Missing settled direct receipt');
  return {
    sequence: row.sequence,
    operationId: row.operationId,
    userIntentId: row.userIntentId,
    commandKind: command.value.command.kind,
    phase: intent.phase,
    outcome: receipt
      ? 'receipt'
      : ['cancelled', 'reconciling'].includes(intent.phase)
        ? 'not_executed'
        : 'unresolved',
    receipt,
  };
}
const failed = (error: unknown) => ({
  kind: 'failed' as const,
  error:
    error instanceof CommandFault
      ? error.detail
      : {
          code: 'storage_failure' as const,
          messageKey: 'command.recovery_unavailable',
          retry: 'reconcile' as const,
        },
});

/** Queued on the writer: receipt absence is never sampled ahead of a live write's settlement. */
export function createDirectRecoveryRepository(
  writer: SerializedWriter,
  catalogue: CatalogueBoundary,
  platform: Pick<CommandPlatform, 'sha256'>,
): Pick<CookMateQueries, 'readDirectRecovery'> &
  Pick<CookMateCommands, 'acknowledgeDirectRecovery'> {
  return {
    readDirectRecovery: async (input = {}) => {
      const after = input.afterSequence ?? 0;
      const limit = input.limit ?? 30;
      if (!isRevision(after) || !Number.isInteger(limit) || limit < 1 || limit > 100)
        return failed(
          new CommandFault({
            code: 'invalid_input',
            messageKey: 'command.invalid_recovery_page',
            retry: 'after_correction',
          }),
        );
      try {
        return await writer.transaction(
          async (session) => {
            const rows = await session.all<RecoveryRow>(
              `${query} WHERE r.sequence>? ORDER BY r.sequence LIMIT ?`,
              [after, limit + 1],
            );
            const entries: DirectRecoveryEntry[] = [];
            for (const row of rows.slice(0, limit))
              entries.push(await entry(session, row, catalogue, platform));
            return {
              kind: 'ready' as const,
              revision: await readRevision(session, 'store'),
              value: freezeResult({
                entries,
                nextAfterSequence: rows.length > limit ? entries.at(-1)!.sequence : null,
              }),
            };
          },
          { kind: 'read_only' },
        );
      } catch (error) {
        return failed(error);
      }
    },
    acknowledgeDirectRecovery: async (operationId) => {
      if (!isAppId(operationId))
        return failed(
          new CommandFault({
            code: 'invalid_input',
            messageKey: 'command.invalid_operation',
            retry: 'after_correction',
          }),
        );
      try {
        return await writer.transaction(
          async (session) => {
            const row = (
              await session.all<RecoveryRow>(`${query} WHERE r.operation_id=?`, [operationId])
            )[0];
            if (row) {
              const actual = await entry(session, row, catalogue, platform);
              if (actual.outcome === 'unresolved')
                rejectCommand('already_pending', 'command.outcome_unresolved');
              await runBound(session, 'DELETE FROM direct_command_recovery WHERE operation_id=?', [
                operationId,
              ]);
            }
            return {
              kind: 'ready' as const,
              revision: await readRevision(session, 'store'),
              value: null,
            };
          },
          { kind: 'none' },
        );
      } catch (error) {
        return failed(error);
      }
    },
  };
}
