import type { ContractError, LocalCommand, OperationReceipt } from '@cookmate/contracts';
import type {
  CookMateCommands,
  CookMateQueries,
  DirectActionInput,
  DirectActionReview,
  Immutable,
} from '@cookmate/domain';

type Review = Immutable<DirectActionReview>;
type Command = Immutable<LocalCommand>;
/** The reviewed-action flow needs these real ports, not a substitute full app facade. */
export interface DirectActionPorts {
  commands: CookMateCommands;
  queries: Pick<CookMateQueries, 'readReceipt'>;
}
export type ActionState =
  | { kind: 'idle' }
  | { kind: 'reviewing'; input: Immutable<DirectActionInput> }
  | { kind: 'confirmation'; review: Review; refreshed: boolean }
  | { kind: 'preparing'; review: Review }
  | { kind: 'applying'; review: Review; command: Command }
  | { kind: 'receipt'; review: Review; command: Command; receipt: Immutable<OperationReceipt> }
  | {
      kind: 'failed';
      input: Immutable<DirectActionInput>;
      error: ContractError;
      review?: Review;
      command?: Command;
    }
  | {
      kind: 'uncertain';
      review: Review;
      command: Command;
      checking: boolean;
      retryAllowed?: boolean;
      detail: string;
    };

export interface ActionOptions {
  confirm?: boolean;
  observedDemandFingerprint?: string;
  observedSelectionRevision?: number;
  observedPreferenceRevision?: number;
  restoreFocus?: (onlyIfMissing?: boolean) => boolean | void;
  restoreAfterCommitRemoval?: boolean;
}
const storageError: ContractError = {
  code: 'storage_failure',
  messageKey: 'ui.local_action_failed',
  retry: 'after_correction',
};

export class DirectActionController {
  state: ActionState = { kind: 'idle' };
  private listeners = new Set<() => void>();
  private generation = 0;
  private reviewFocus: ActionOptions['restoreFocus'];
  private originFocusScope: (() => void) | null = null;
  private restoredRemoval: string | null = null;
  private options: ActionOptions = {};
  private recoveryHeld = false;
  private assistantHeld = false;
  holdForAssistant(held: boolean) {
    if (held === this.assistantHeld) return;
    this.assistantHeld = held;
    this.update({ ...this.state });
  }
  private ownedOperations = new Set<string>();
  holdForRecovery(held: boolean) {
    this.recoveryHeld = held;
  }
  ownsOperation(id: string) {
    return this.ownedOperations.has(id);
  }
  restoreReviewFocus = () => this.reviewFocus?.();
  constructor(
    private services: DirectActionPorts,
    private refresh: () => void,
    private getFocusScope: () => (() => void) | null = () => null,
    private beforeExecute: (command: Command) => void = () => undefined,
    private beforeMutation: () => Promise<ContractError | undefined> = async () => undefined,
    private afterMutation: () => void = () => undefined,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(state: ActionState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  get externallyHeld() {
    return this.recoveryHeld || this.assistantHeld;
  }
  get blocked() {
    return (
      this.recoveryHeld ||
      this.assistantHeld ||
      !['idle', 'receipt', 'failed'].includes(this.state.kind)
    );
  }

  async begin(input: Immutable<DirectActionInput>, options: ActionOptions = {}) {
    if (this.blocked) return;
    this.reviewFocus = options.restoreFocus;
    this.options = options;
    this.originFocusScope = this.getFocusScope();
    const generation = ++this.generation;
    this.update({ kind: 'reviewing', input });
    try {
      const reviewed = await this.services.commands.reviewDirect(input);
      if (generation !== this.generation) return;
      if (reviewed.kind === 'failed') {
        this.update({ kind: 'failed', input, error: reviewed.error });
        return;
      }
      const review = reviewed.value;
      if (
        review.consequences.kind === 'preference' &&
        options.observedPreferenceRevision !== undefined &&
        review.consequences.before.revision !== options.observedPreferenceRevision
      ) {
        this.refresh();
        this.update({
          kind: 'failed',
          input,
          error: {
            code: 'stale_target',
            messageKey: 'ui.preference_draft_changed',
            retry: 'never',
          },
        });
        return;
      }
      if (
        review.consequences.kind === 'shopping_selection' &&
        review.consequences.before.revision !== options.observedSelectionRevision
      ) {
        // This compares the displayed draft baseline; Data alone constructs and enforces guards.
        this.refresh();
        this.update({
          kind: 'failed',
          input,
          error: { code: 'stale_target', messageKey: 'ui.selection_draft_changed', retry: 'never' },
        });
        return;
      }
      // A changed rendered purchase quantity must be reviewed again, never silently checked.
      const changedDemand =
        review.payload.kind === 'setPurchased' &&
        review.payload.expectedDemandFingerprint !== options.observedDemandFingerprint;
      if (options.confirm || changedDemand) {
        this.update({ kind: 'confirmation', review, refreshed: changedDemand });
      } else await this.prepare(review);
    } catch {
      if (generation === this.generation)
        this.update({ kind: 'failed', input, error: storageError });
    }
  }

  cancelReview() {
    if (this.state.kind !== 'confirmation' && this.state.kind !== 'reviewing') return;
    this.generation++;
    this.update({ kind: 'idle' });
  }
  async confirm() {
    if (this.assistantHeld || this.recoveryHeld) return;
    if (this.state.kind === 'confirmation') await this.prepare(this.state.review);
  }
  private async prepare(review: Review) {
    const generation = this.generation;
    this.update({ kind: 'preparing', review });
    try {
      const error = await this.beforeMutation();
      if (generation !== this.generation) return;
      if (error) {
        this.update({ kind: 'failed', input: review.input, review, error });
        return;
      }
      const prepared = await this.services.commands.prepareDirect(review);
      if (prepared.kind === 'failed') {
        this.update({ kind: 'failed', input: review.input, review, error: prepared.error });
        return;
      }
      await this.execute(review, prepared.value);
    } catch {
      this.update({ kind: 'failed', input: review.input, review, error: storageError });
    } finally {
      this.afterMutation();
    }
  }
  private async execute(review: Review, command: Command) {
    this.ownedOperations.add(command.operationId);
    this.update({ kind: 'applying', review, command });
    try {
      this.beforeExecute(command);
      const result = await this.services.commands.execute(command);
      if (result.kind === 'receipt') {
        this.acceptReceipt(review, command, result.receipt);
        return;
      }
      if (result.kind === 'failed' && result.error.retry !== 'reconcile') {
        this.update({ kind: 'failed', input: review.input, review, command, error: result.error });
        return;
      }
    } catch {
      /* Dispatch may have committed; only its real receipt can settle the result. */
    }
    this.update({
      kind: 'uncertain',
      review,
      command,
      checking: false,
      detail:
        'The result has not been confirmed. Check the saved result before trying another change.',
    });
  }
  private acceptReceipt(review: Review, command: Command, receipt: Immutable<OperationReceipt>) {
    // Correlate UI feedback with this frozen operation; the service owns validation/commit authority.
    if (
      receipt.operationId !== command.operationId ||
      receipt.userIntentId !== command.userIntentId ||
      receipt.payloadFingerprint !== command.payloadFingerprint
    ) {
      this.update({
        kind: 'uncertain',
        review,
        command,
        checking: false,
        detail: 'The saved result does not match this change. It remains unconfirmed.',
      });
      return;
    }
    this.refresh();
    this.update({ kind: 'receipt', review, command, receipt });
  }
  async reconcile() {
    if (this.state.kind !== 'uncertain' || this.state.checking) return;
    const { review, command } = this.state;
    this.update({ ...this.state, checking: true });
    try {
      const result = await this.services.queries.readReceipt(command.operationId);
      if (result.kind === 'ready' && result.value) {
        this.acceptReceipt(review, command, result.value);
        return;
      }
      this.update({
        kind: 'uncertain',
        review,
        command,
        checking: false,
        retryAllowed: result.kind === 'ready',
        detail:
          result.kind === 'failed'
            ? 'Couldn’t check the saved result. Keep this change pending and check again.'
            : 'No confirmed result is available yet. You can check again or retry this same change.',
      });
    } catch {
      this.update({
        kind: 'uncertain',
        review,
        command,
        checking: false,
        detail: 'Couldn’t check the saved result. Check again when device storage is available.',
      });
    }
  }
  async retryUncertain() {
    if (this.assistantHeld || this.recoveryHeld) return;
    if (this.state.kind !== 'uncertain' || this.state.checking || !this.state.retryAllowed) return;
    await this.retryCommand(this.state);
  }
  async retry(restoreFocus?: () => void) {
    if (this.assistantHeld || this.recoveryHeld) return;
    if (this.state.kind !== 'failed' || this.state.error.retry === 'never') return;
    const previous = this.state;
    if (
      previous.command &&
      previous.review &&
      !['stale_target', 'stale_context'].includes(previous.error.code)
    ) {
      await this.retryCommand(previous);
    } else
      await this.begin(previous.input, {
        ...this.options,
        confirm: true,
        ...(restoreFocus ? { restoreFocus } : {}),
      });
  }
  private async retryCommand(previous: Extract<ActionState, { kind: 'failed' | 'uncertain' }>) {
    if (!previous.review || !previous.command) return;
    const generation = ++this.generation;
    // Reserve before awaiting; its own uncertainty must not reject this exact eligible retry.
    this.update(
      previous.kind === 'uncertain'
        ? { ...previous, checking: true }
        : { kind: 'preparing', review: previous.review },
    );
    try {
      const error = await this.beforeMutation();
      if (generation !== this.generation) return;
      if (error) {
        this.update(
          previous.kind === 'uncertain'
            ? {
                ...previous,
                checking: false,
                detail:
                  'The earlier result remains unconfirmed. Check the other saved results before retrying this change.',
              }
            : { ...previous, error },
        );
        return;
      }
      await this.execute(previous.review, previous.command);
    } catch {
      this.update(
        previous.kind === 'uncertain'
          ? {
              ...previous,
              checking: false,
              detail:
                'Couldn’t check whether another change is pending. This earlier result remains unconfirmed.',
            }
          : { ...previous, error: storageError },
      );
    } finally {
      this.afterMutation();
    }
  }
  dismiss() {
    this.acknowledgeDisplayedReceipt();
    if (this.state.kind === 'receipt' || this.state.kind === 'failed')
      this.update({ kind: 'idle' });
  }
  acknowledgeDisplayedReceipt() {
    if (this.state.kind === 'receipt')
      void this.services.commands
        .acknowledgeDirectRecovery(this.state.command.operationId)
        .catch(() => undefined);
  }
  restoreAfterRemoval(invoker?: ActionOptions['restoreFocus']) {
    if (
      !this.options.restoreAfterCommitRemoval ||
      this.state.kind !== 'receipt' ||
      this.restoredRemoval === this.state.receipt.operationId ||
      this.originFocusScope !== this.getFocusScope() ||
      (invoker && invoker !== this.reviewFocus)
    )
      return;
    if (this.reviewFocus?.(true)) this.restoredRemoval = this.state.receipt.operationId;
  }
}
