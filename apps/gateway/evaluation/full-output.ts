import { join } from 'node:path';
import { writeExclusive } from './prepare';
import { openJournal, RunControl } from './control';
import type { ControlTurn, EvaluationAllowance, EvaluationClock } from './control';

/** Expiry is checked again after journal acquisition; failure still releases that new owner. */
export async function openControlledJournal(
  path: string,
  allowance: EvaluationAllowance,
  clock: EvaluationClock,
  order: readonly ControlTurn[],
  acquire: typeof openJournal = openJournal,
) {
  const journal = await acquire(path);
  try {
    return { journal, control: new RunControl(journal, allowance, clock, order) };
  } catch (primary) {
    const failures = await releaseOwned([{ key: 'journal', close: () => journal.close() }]);
    if (failures.length)
      throw new Error('control_startup_failed_with_cleanup_failure', { cause: primary });
    throw primary;
  }
}

export interface TurnSummary {
  turnId: string;
  status: string;
  artifact?: string;
  reason?: string;
}
/** A published artifact name means its exclusive write and sync completed. */
export async function publishTurnEvidence(
  directory: string,
  artifact: string,
  summary: TurnSummary,
  result: { status: string },
  data: unknown,
) {
  try {
    await writeExclusive(join(directory, artifact), data);
  } catch (error) {
    summary.status = 'ATTEMPTED_EVIDENCE_FAILURE';
    summary.reason = 'evidence_write_failed';
    delete summary.artifact;
    throw error;
  }
  summary.status = result.status;
  summary.artifact = artifact;
}
/** One failed owner must not prevent later owners (including the journal) from releasing. */
export async function releaseOwned(resources: readonly { key: string; close(): Promise<void> }[]) {
  const failures: { key: string; reason: 'owned_resource_close_failed' }[] = [];
  for (const resource of resources) {
    try {
      await resource.close();
    } catch {
      failures.push({ key: resource.key, reason: 'owned_resource_close_failed' });
    }
  }
  return failures;
}
