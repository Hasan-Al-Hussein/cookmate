import type { ContractError } from '@cookmate/contracts';
import type {
  AssistantActionRecovery,
  AssistantPersistencePort,
  Immutable,
  RecoveryGate,
  RecoveryToken,
} from '@cookmate/domain';

export type AssistantRecoveryState =
  | { kind: 'loading' }
  | { kind: 'failed'; error: ContractError }
  | {
      kind: 'ready';
      /** Complete unfiltered unresolved candidates, never all historical outcomes. */
      proofs: Readonly<Record<string, Immutable<AssistantActionRecovery>>>;
      unresolvedIds: readonly string[];
    };
const drift: ContractError = {
  code: 'stale_context',
  messageKey: 'ui.recovery_snapshot_changed',
  retry: 'after_correction',
};
const unreadable: ContractError = {
  code: 'storage_failure',
  messageKey: 'ui.assistant_recovery',
  retry: 'reconcile',
};

/** Drives bounded owner audit progress; only Data establishes completeness and freshness. */
export class AssistantRecoveryController {
  state: AssistantRecoveryState = { kind: 'loading' };
  private listeners = new Set<() => void>();
  private running: Promise<void> | null = null;
  private epoch = 0;
  private token: RecoveryToken | undefined;
  private continuation: string | undefined;
  private disposed = false;
  constructor(
    private persistence: AssistantPersistencePort,
    private activeOwnedIntent: () => string | undefined,
    private yieldBatch: () => Promise<void> = () =>
      new Promise((resolve) => setTimeout(resolve, 0)),
  ) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(state: AssistantRecoveryState) {
    if (this.disposed) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  hold() {
    this.update({ kind: 'loading' });
  }
  /** Pre-mutation, unknown, clear or foreground invalidation is synchronous. */
  invalidate() {
    this.epoch++;
    this.token = undefined;
    this.continuation = undefined;
    this.hold();
  }
  certifiesUnchanged(token: RecoveryToken) {
    return this.state.kind !== 'failed' && this.token === token;
  }
  /** Admission checks the unfiltered snapshot; reservation itself cannot hide a candidate. */
  get admitsNewMutation() {
    return this.state.kind === 'ready' && Object.keys(this.state.proofs).length === 0;
  }
  ownershipChanged() {
    if (this.state.kind !== 'ready') return;
    this.update({
      ...this.state,
      unresolvedIds: Object.keys(this.state.proofs).filter((id) => id !== this.activeOwnedIntent()),
    });
  }
  check = (): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    this.hold();
    if (this.running) return this.running;
    // Defer entry so synchronous owner invalidation cannot create a second driver.
    this.running = Promise.resolve()
      .then(() => this.drive())
      .finally(() => {
        this.running = null;
        // An invalidation delivered as the previous read settled must not strand a loading hold.
        if (!this.disposed && this.state.kind === 'loading') return this.check();
      });
    return this.running;
  };
  private fail(error: ContractError) {
    this.token = undefined;
    this.continuation = undefined;
    this.update({ kind: 'failed', error });
  }
  private ready(snapshot: Immutable<Extract<RecoveryGate, { kind: 'ready' }>>) {
    const proofs: Record<string, Immutable<AssistantActionRecovery>> = {};
    for (const proof of snapshot.candidates) {
      if (
        proofs[proof.userIntentId] ||
        proof.conversationId !== snapshot.conversationId ||
        proof.conversationGeneration !== snapshot.conversationGeneration ||
        !proof.slots.some((slot) => slot.outcome === 'unresolved')
      )
        throw new Error('Invalid recovery candidate');
      proofs[proof.userIntentId] = proof;
    }
    this.token = snapshot.token;
    this.continuation = undefined;
    this.update({
      kind: 'ready',
      proofs,
      unresolvedIds: Object.keys(proofs).filter((id) => id !== this.activeOwnedIntent()),
    });
  }
  private async drive() {
    let restarts = 0;
    const progress = new Set<string>();
    while (!this.disposed) {
      const epoch = this.epoch;
      try {
        const result = await this.persistence.refreshRecoveryGate(
          this.continuation ? { continuation: this.continuation } : undefined,
        );
        if (this.disposed) return;
        if (epoch !== this.epoch) {
          if (restarts++ >= 1) {
            this.fail(drift);
            return;
          }
          this.continuation = undefined;
          progress.clear();
          continue;
        }
        if (result.kind === 'failed') {
          this.fail(result.error);
          return;
        }
        const snapshot = result.value;
        if (snapshot.kind === 'ready') {
          this.ready(snapshot);
          return;
        }
        if (!snapshot.continuation || progress.has(snapshot.continuation)) {
          this.fail(unreadable);
          return;
        }
        progress.add(snapshot.continuation);
        this.token = snapshot.token;
        this.continuation = snapshot.continuation;
        await this.yieldBatch();
        if (epoch !== this.epoch) {
          if (restarts++ >= 1) {
            this.fail(drift);
            return;
          }
          this.continuation = undefined;
          progress.clear();
        }
      } catch {
        if (!this.disposed) this.fail(unreadable);
        return;
      }
    }
  }
  async dispose() {
    this.disposed = true;
    this.listeners.clear();
    await this.running;
  }
}
