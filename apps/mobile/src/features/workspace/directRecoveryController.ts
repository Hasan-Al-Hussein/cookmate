import type { CookMateCommands, CookMateQueries, DirectRecoveryPage } from '@cookmate/domain';
import type { DirectActionController } from './directActionController';

export type RecoveryState =
  | { kind: 'loading'; previous?: DirectRecoveryPage }
  | { kind: 'failed' }
  | { kind: 'ready'; page: DirectRecoveryPage };

export interface DirectRecoveryPorts {
  queries: Pick<CookMateQueries, 'readDirectRecovery'>;
  commands: Pick<CookMateCommands, 'acknowledgeDirectRecovery'>;
}

/** Restores bounded notices from Data; it never reconstructs or executes a command. */
export class DirectRecoveryController {
  state: RecoveryState = { kind: 'loading' };
  private working = false;
  private afterSequence: number | undefined;
  private listeners = new Set<() => void>();
  constructor(
    private services: DirectRecoveryPorts,
    private actions: DirectActionController,
  ) {
    actions.holdForRecovery(true);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(state: RecoveryState) {
    this.state = state;
    this.actions.holdForRecovery(
      state.kind !== 'ready' ||
        state.page.entries.length > 0 ||
        state.page.nextAfterSequence !== null,
    );
    this.listeners.forEach((listener) => listener());
  }
  private async read() {
    try {
      const result = await this.services.queries.readDirectRecovery({
        limit: 5,
        ...(this.afterSequence === undefined ? {} : { afterSequence: this.afterSequence }),
      });
      if (result.kind === 'failed') {
        this.update({ kind: 'failed' });
        return;
      }
      // An in-session action keeps its own exact-command/result UI. Restored records have no such owner.
      this.update({
        kind: 'ready',
        page: {
          ...result.value,
          entries: result.value.entries
            .filter((entry) => !this.actions.ownsOperation(entry.operationId))
            .map((entry) =>
              entry.outcome === 'receipt' &&
              (!entry.receipt ||
                entry.receipt.operationId !== entry.operationId ||
                entry.receipt.userIntentId !== entry.userIntentId)
                ? { ...entry, outcome: 'unresolved' as const }
                : entry,
            ),
        },
      });
    } catch {
      this.update({ kind: 'failed' });
    }
  }
  async check() {
    if (this.working) return;
    this.working = true;
    const previous = this.state.kind === 'ready' ? { previous: this.state.page } : {};
    this.update({ kind: 'loading', ...previous });
    try {
      await this.read();
    } finally {
      this.working = false;
    }
  }
  async dismiss(operationId: string) {
    if (this.working || this.state.kind !== 'ready') return;
    const entry = this.state.page.entries.find((entry) => entry.operationId === operationId);
    if (!entry || entry.outcome === 'unresolved') return;
    this.working = true;
    this.update({ kind: 'loading' });
    try {
      const result = await this.services.commands.acknowledgeDirectRecovery(operationId);
      if (result.kind === 'failed') this.update({ kind: 'failed' });
      else await this.read();
    } catch {
      this.update({ kind: 'failed' });
    } finally {
      this.working = false;
    }
  }
  async next() {
    if (
      this.working ||
      this.state.kind !== 'ready' ||
      this.state.page.entries.length ||
      this.state.page.nextAfterSequence === null
    )
      return;
    this.afterSequence = this.state.page.nextAfterSequence;
    await this.check();
  }
}
