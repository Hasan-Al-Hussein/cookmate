import type { AssistantTurnRequest, CommandResult, LocalCommand } from '@cookmate/contracts';
import type { AuthorizedActionPlan } from '@cookmate/domain';
import { rejectCommand } from './commandExecutor';

/** Private identity captured only after an ordinary attempt proves its original reservation. */
export interface AssistantActionAttempt {
  plan: AuthorizedActionPlan;
  request: AssistantTurnRequest;
  cursor: number;
  kind: 'execution' | 'finalization';
  command?: LocalCommand;
  result?: CommandResult;
}

/** One open store's denials; neither these identities nor their settlement are command authority. */
export function createAssistantAttemptRecovery() {
  const pending = new Set<AssistantActionAttempt>();
  let settle: ((attempt: AssistantActionAttempt) => Promise<CommandResult | undefined>) | undefined;
  return {
    bind(handler: NonNullable<typeof settle>) {
      if (settle) throw new Error('Assistant attempt recovery is already bound');
      settle = handler;
    },
    pending(id: string) {
      return [...pending].filter((attempt) => attempt.plan.userIntentId === id);
    },
    assertClear(id: string, cursor: number): undefined {
      if (
        [...pending].some(
          (attempt) => attempt.plan.userIntentId === id && attempt.cursor === cursor,
        )
      )
        rejectCommand('stale_context', 'assistant.reconciliation_required');
      return undefined;
    },
    resolve(attempt: AssistantActionAttempt) {
      pending.delete(attempt);
    },
    async failed(attempt: AssistantActionAttempt, result?: CommandResult) {
      if (result) attempt.result = JSON.parse(JSON.stringify(result)) as CommandResult;
      pending.add(attempt);
      // Settlement errors retain this exact denial for explicit same-lifetime reconciliation.
      try {
        return (await settle?.(attempt)) ?? result;
      } catch {
        return result;
      }
    },
  };
}

export type AssistantAttemptRecovery = ReturnType<typeof createAssistantAttemptRecovery>;
