import type { ContractError } from '@cookmate/contracts';
import type {
  AssistantPersistencePort,
  AssistantActionRecovery,
  AssistantActionContinuationReview,
  ConversationHeader,
  ConversationPage,
  CookMateServices,
  Immutable,
  RepositoryResult,
  StoredAssistantIntent,
  StoredConversationMessage,
  StoreChange,
} from '@cookmate/domain';
import {
  AssistantCoreError,
  createAssistantCoordinator,
  type TurnOutcome,
  type ActionOutcome,
  type ActionContinuationOutcome,
} from '../../assistant-core';
import { ConnectionError, type ConnectionState, type GatewayConnection } from '../../connection';
import { AssistantRecoveryController, type AssistantRecoveryState } from './assistantRecovery';
import type { AiConsentController, AiConsentState } from './aiConsent';

export type AssistantCoordinator = ReturnType<typeof createAssistantCoordinator>;
export type IntentRecord = Immutable<StoredAssistantIntent>;
export type ContinuationReviewState = {
  requestId: number;
  userIntentId: string;
} & (
  | { kind: 'loading' | 'unavailable' }
  | { kind: 'ready'; review: Immutable<AssistantActionContinuationReview> }
  | { kind: 'failed'; error: ContractError }
);
export interface ConversationView {
  header: Immutable<ConversationHeader>;
  messages: readonly Immutable<StoredConversationMessage>[];
  hasEarlier: boolean;
  hasHistoryGap?: boolean;
  beforeSequence: number | null;
  intents: Readonly<Record<string, IntentRecord>>;
}
export interface AssistantView {
  aiConsent?: AiConsentState;
  connection: Readonly<ConnectionState>;
  connectionReady: boolean;
  connectionBusy: boolean;
  connectionError?: ContractError | undefined;
  connectionNotice?: string | undefined;
  conversation: ConversationView | null;
  loading: boolean;
  readError?: ContractError | undefined;
  draft: string;
  draftError?: ContractError | undefined;
  busy: boolean;
  mutating: boolean;
  composerPaused: boolean;
  activeIntentId?: string | undefined;
  outcome?: TurnOutcome | undefined;
  notice?: string | undefined;
  actionError?: { userIntentId: string; error: ContractError } | undefined;
  actionOutcomes: Readonly<Record<string, ActionOutcome>>;
  continuationReview?: ContinuationReviewState | undefined;
  continuationOutcomes?: Readonly<Record<string, ActionContinuationOutcome>> | undefined;
  recovery: AssistantRecoveryState;
  historyProofs?: Readonly<Record<string, Immutable<AssistantActionRecovery>>>;
  historyProofErrors?: Readonly<Record<string, ContractError>>;
}
const storageError: ContractError = {
  code: 'storage_failure',
  messageKey: 'ui.assistant_storage',
  retry: 'after_correction',
};
const changedSnapshot: ContractError = {
  code: 'stale_context',
  messageKey: 'ui.recovery_snapshot_changed',
  retry: 'after_correction',
};
export function assistantError(error: unknown): ContractError {
  return error instanceof AssistantCoreError || error instanceof ConnectionError
    ? error.detail
    : storageError;
}
export function repositoryValue<T>(result: RepositoryResult<T>): T {
  if (result.kind === 'failed') throw new AssistantCoreError(result.error);
  return result.value;
}

/** App-lifetime view/draft orchestration only. Authority and durable identity stay in owner ports. */
export class AssistantRuntime {
  state: AssistantView;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private unsubscribeInvalidation?: () => void;
  private unsubscribeRecovery: () => void;
  private unsubscribeConsent: (() => void) | undefined;
  readonly recovery: AssistantRecoveryController;
  private disposed = false;
  private providerTurnActive = false;
  private providerAdmissionEpoch = 0;
  private reads = Promise.resolve();
  private drafts = Promise.resolve();
  private draftVersion = 0;
  private savedDraftVersion = 0;
  private conversationReadRevision = -1;
  private conversationChangeRevision = -1;
  private viewEpoch = 0;
  private continuationReviewEpoch = 0;
  private sendStartingSequence: number | undefined;
  private executingIntentId: string | undefined;
  private historyRequests = new Map<string, { signature: string }>();
  private historyCoverage: { start: number; end: number }[] = [];
  private mutationAllowed = () => true;
  setMutationGate(allowed: () => boolean) {
    this.mutationAllowed = allowed;
  }
  constructor(
    readonly persistence: AssistantPersistencePort,
    readonly core: AssistantCoordinator,
    readonly connection: GatewayConnection,
    private services: CookMateServices,
    readonly aiConsent?: AiConsentController,
  ) {
    this.state = {
      connection: connection.getState(),
      connectionReady: false,
      connectionBusy: false,
      conversation: null,
      loading: true,
      draft: '',
      busy: false,
      mutating: false,
      composerPaused: false,
      actionOutcomes: {},
      recovery: { kind: 'loading' },
      ...(aiConsent ? { aiConsent: aiConsent.getSnapshot() } : {}),
    };
    this.recovery = new AssistantRecoveryController(persistence, () => this.executingIntentId);
    this.unsubscribeRecovery = this.recovery.subscribe(() =>
      this.patch({ recovery: this.recovery.state }),
    );
    this.unsubscribeConsent = aiConsent?.subscribe(() => {
      const next = aiConsent.getSnapshot();
      if (this.state.aiConsent?.status === 'allowed' && next.status !== 'allowed') {
        this.providerAdmissionEpoch++;
        // End only external waiting. A received answer awaiting a local save remains recoverable.
        if (this.providerTurnActive) this.core.invalidate();
      }
      this.patch({ aiConsent: next, connection: this.connection.getState() });
    });
  }
  get mutationsHeld() {
    return (
      this.state.mutating ||
      this.state.recovery.kind !== 'ready' ||
      this.state.recovery.unresolvedIds.length > 0
    );
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private patch(changes: Partial<AssistantView>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...changes };
    this.listeners.forEach((listener) => listener());
  }
  start() {
    this.unsubscribeInvalidation = this.services.queries.subscribeRecoveryInvalidation(() => {
      this.recovery.invalidate();
      if (!this.state.mutating) void this.recovery.check();
    });
    this.unsubscribe = this.services.queries.subscribe((change) => {
      if (change.collections.includes('conversation')) {
        const recoveryUnchanged =
          change.recovery?.kind === 'unchanged' &&
          this.recovery.certifiesUnchanged(change.recovery.token);
        const newerChange = change.revision > this.conversationChangeRevision;
        this.conversationChangeRevision = Math.max(
          this.conversationChangeRevision,
          change.revision,
        );
        if (!recoveryUnchanged) {
          this.recovery.invalidate();
          if (!this.state.mutating) void this.recovery.check();
        }
        if (recoveryUnchanged && newerChange && this.applyDraftChange(change)) return;
        void this.reload();
      }
    });
    void this.restoreConnection();
    void this.reload();
    void this.recovery.check();
  }
  private applyDraftChange(change: StoreChange): boolean {
    const current = this.state.conversation;
    const detail = change.conversationChange;
    if (
      this.disposed ||
      detail?.kind !== 'draft_only' ||
      !current ||
      change.revision <= this.conversationReadRevision
    )
      return false;
    const header = detail.header;
    if (
      header.conversationId !== current.header.conversationId ||
      header.generation !== current.header.generation ||
      header.revision !== current.header.revision ||
      header.nextSequence !== current.header.nextSequence
    )
      return false;
    this.conversationReadRevision = change.revision;
    const changes: Partial<AssistantView> = { conversation: { ...current, header } };
    if (this.draftVersion === this.savedDraftVersion && !this.state.composerPaused) {
      // A persisted remote/acknowledged draft also supersedes any older in-flight read.
      this.savedDraftVersion = ++this.draftVersion;
      changes.draft = header.composerDraft;
    }
    // An event can precede saveDraft's resolution. Only that resolution marks a local edit saved.
    this.patch(changes);
    return true;
  }
  async refreshForForeground() {
    this.dismissContinuationReview();
    this.recovery.invalidate();
    await this.recovery.check();
    await this.reload();
  }
  /** Called under the caller's synchronous UI reservation, before any new mutation. */
  async checkMutationFreshness(): Promise<ContractError | undefined> {
    const epoch = this.viewEpoch;
    await this.recovery.check();
    if (this.disposed || epoch !== this.viewEpoch)
      return {
        code: 'stale_context',
        messageKey: 'ui.recovery_snapshot_changed',
        retry: 'after_correction',
      };
    if (this.recovery.state.kind === 'failed') return this.recovery.state.error;
    if (!this.recovery.admitsNewMutation)
      return {
        code: 'already_pending',
        messageKey: 'ui.resolve_earlier_change',
        retry: 'reconcile',
      };
    return undefined;
  }
  async restoreConnection() {
    if (this.state.connectionBusy) return;
    this.patch({ connectionBusy: true, connectionError: undefined });
    try {
      const installationId = repositoryValue(await this.services.queries.readInstallationId());
      if (this.disposed) return;
      await this.aiConsent?.bind(installationId);
      if (this.disposed) return;
      await this.connection.restore(installationId);
      this.patch({ connectionReady: true });
    } catch (error) {
      this.patch({ connectionError: assistantError(error) });
    } finally {
      this.patch({ connection: this.connection.getState(), connectionBusy: false });
    }
  }
  async connectionAction(
    action: 'pair' | 'health' | 'forget' | 'revoke',
    endpoint = '',
    code = '',
  ) {
    if (!this.state.connectionReady || this.state.connectionBusy || this.state.busy) return;
    const revocationClientId =
      action === 'revoke' ? this.connection.getState().clientId : undefined;
    this.patch({ connectionBusy: true, connectionError: undefined, connectionNotice: undefined });
    try {
      if (action === 'health') {
        await this.connection.health(endpoint);
        this.patch({
          connectionNotice:
            'The laptop is reachable and compatible. An AI answer has not been tested.',
        });
      } else {
        this.invalidate();
        if (action === 'pair') await this.connection.pair(endpoint, code);
        if (action === 'forget') {
          await this.connection.forget();
          this.patch({
            connectionNotice:
              'Disconnected on this iPhone. Gateway revocation has not been confirmed.',
          });
        }
        if (action === 'revoke') {
          const result = await this.connection.revokeAndForget();
          this.patch({
            connectionNotice: result.serverRevoked
              ? 'Disconnected on this iPhone and access revoked by the laptop.'
              : 'Disconnected on this iPhone. The laptop has not confirmed revocation; access may already have been revoked.' +
                (revocationClientId
                  ? ` Give the laptop operator this client ID to check or revoke: ${revocationClientId}.`
                  : ' Ask the laptop operator to check the connection.'),
          });
        }
      }
    } catch (error) {
      this.patch({ connectionError: assistantError(error) });
    } finally {
      this.patch({ connection: this.connection.getState(), connectionBusy: false });
      if (action !== 'health') await this.recovery.check();
    }
  }
  reload = (earlier = false): Promise<void> => this.queueReload(earlier, () => void this.reload());
  private queueReload(earlier: boolean, onDrift: () => void): Promise<void> {
    this.reads = this.reads
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed) return;
        const previous = this.state.conversation;
        const draftVersionAtRead = this.draftVersion;
        const draftWasCleanAtRead = this.draftVersion === this.savedDraftVersion;
        if (earlier && (!previous?.hasEarlier || previous.beforeSequence === null)) return;
        const beforeSequence = earlier ? previous!.beforeSequence! : undefined;
        this.patch({ loading: true });
        try {
          const page = repositoryValue(
            await this.persistence.readConversation(
              beforeSequence === undefined ? { limit: 30 } : { beforeSequence, limit: 30 },
            ),
          );
          if (this.disposed) return;
          const same =
            previous?.header.conversationId === page.header.conversationId &&
            previous.header.generation === page.header.generation;
          const intentPage = repositoryValue(
            await this.persistence.readIntentPage({
              ...(beforeSequence === undefined ? {} : { beforeSequence }),
              limit: 30,
            }),
          );
          if (
            intentPage.header.generation !== page.header.generation ||
            intentPage.header.revision !== page.header.revision
          ) {
            // A commit raced these separate public reads. Request one fresh snapshot, never mix generations.
            onDrift();
            return;
          }
          const ids = new Set([
            ...(same ? Object.keys(previous.intents) : []),
            ...intentPage.items.map((item) => item.userIntentId),
          ]);
          const intents: Record<string, IntentRecord> = {};
          for (const id of ids) {
            const record = repositoryValue(await this.persistence.readIntent(id));
            if (
              record &&
              record.request.conversationGeneration === page.header.generation &&
              record.request.conversationId === page.header.conversationId
            )
              intents[id] = record;
          }
          const messages = new Map<string, Immutable<StoredConversationMessage>>(
            same ? previous.messages.map((message) => [message.messageId, message]) : [],
          );
          page.messages.forEach((message) => messages.set(message.messageId, message));
          // Message text is immutable, but an earlier retried request's status can change off-page.
          // Refresh only changed retained intents through Data's bounded page API.
          for (const [id, record] of Object.entries(intents)) {
            const messageId = record.request.message.messageId;
            if (
              !same ||
              !messages.has(messageId) ||
              page.messages.some((message) => message.messageId === messageId) ||
              previous.intents[id]?.intent.revision === record.intent.revision
            )
              continue;
            const refreshed = repositoryValue(
              await this.persistence.readConversation({
                beforeSequence: record.request.message.sourceSequence + 1,
                limit: 1,
              }),
            );
            if (
              refreshed.header.generation !== page.header.generation ||
              refreshed.header.revision !== page.header.revision
            ) {
              onDrift();
              return;
            }
            const message = refreshed.messages.find((message) => message.messageId === messageId);
            if (message) messages.set(messageId, message);
          }
          const latestResult = await this.persistence.readConversation({ limit: 1 });
          const latest = repositoryValue(latestResult);
          if (
            latest.header.generation !== page.header.generation ||
            latest.header.revision !== page.header.revision ||
            latest.header.nextSequence !== page.header.nextSequence ||
            (latestResult.kind === 'ready' && latestResult.revision < this.conversationReadRevision)
          ) {
            onDrift();
            return;
          }
          if (latestResult.kind === 'ready') this.conversationReadRevision = latestResult.revision;
          const startingSequence = this.sendStartingSequence;
          if (
            startingSequence !== undefined &&
            page.messages.some(
              (message) => message.role === 'user' && message.sequence >= startingSequence,
            )
          ) {
            this.sendStartingSequence = undefined;
            this.patch({ composerPaused: false });
          }
          if (!same) {
            if (this.state.continuationReview) this.dismissContinuationReview();
            this.historyRequests.clear();
            this.viewEpoch++;
            this.draftVersion++;
            this.savedDraftVersion = this.draftVersion;
            this.patch({
              draft: latest.header.composerDraft,
              outcome: undefined,
              actionError: undefined,
              draftError: undefined,
              actionOutcomes: {},
              continuationOutcomes: {},
              historyProofs: {},
              historyProofErrors: {},
              notice: undefined,
            });
          } else if (
            draftWasCleanAtRead &&
            this.draftVersion === this.savedDraftVersion &&
            this.draftVersion === draftVersionAtRead
          )
            this.patch({ draft: latest.header.composerDraft });
          const changedHistory = same
            ? Object.keys(intents).filter((id) => {
                const saved = this.historyRequests.get(id);
                return saved && saved.signature !== this.historySignature(intents[id]!);
              })
            : [];
          const historyProofs = { ...this.state.historyProofs };
          const historyProofErrors = { ...this.state.historyProofErrors };
          const actionOutcomes = { ...this.state.actionOutcomes };
          for (const id of changedHistory) {
            this.historyRequests.delete(id);
            delete historyProofs[id];
            delete historyProofErrors[id];
            delete actionOutcomes[id];
          }
          const paging = this.includeHistoryPage(page, beforeSequence, same);
          const hasHistoryGap =
            paging.beforeSequence !== null &&
            [...messages.values()].some((message) => message.sequence < paging.beforeSequence!);
          this.patch({
            historyProofs,
            historyProofErrors,
            actionOutcomes,
            conversation: {
              header: latest.header,
              messages: [...messages.values()].sort((a, b) => a.sequence - b.sequence),
              intents,
              ...paging,
              hasHistoryGap,
            },
            readError: undefined,
          });
          // Bounded to this newly read page. The global gate no longer carries settled history.
          await this.readHistoryProofs([
            ...changedHistory,
            ...intentPage.items.map((item) => item.userIntentId),
          ]);
        } catch (error) {
          this.patch({ readError: assistantError(error) });
        } finally {
          this.patch({ loading: false });
        }
      });
    return this.reads;
  }
  private async reloadAfterAction(): Promise<boolean> {
    // Own one replacement so a drift retry cannot outlive the action's UI reservation.
    for (let attempt = 0; attempt < 2; attempt++) {
      let drifted = false;
      await this.queueReload(false, () => {
        drifted = true;
      });
      if (this.disposed) return false;
      if (!drifted) return !this.state.readError;
    }
    this.patch({ readError: changedSnapshot });
    return false;
  }
  private includeHistoryPage(
    page: ConversationPage,
    beforeSequence: number | undefined,
    same: boolean,
  ) {
    // A page proves coverage of its query range, including empty/sparse sequence positions.
    // Intent pages and one-row status/guard reads do not prove transcript coverage.
    const start = page.hasEarlier ? page.beforeSequence : 0;
    const end = Math.min(beforeSequence ?? page.header.nextSequence, page.header.nextSequence);
    if (start === null || start > end || (page.hasEarlier && start === end))
      throw new Error('Invalid transcript page cursor');
    const ranges = [...(same ? this.historyCoverage : []), { start, end }].sort(
      (a, b) => b.end - a.end,
    );
    const merged: typeof this.historyCoverage = [];
    for (const range of ranges) {
      const latest = merged[merged.length - 1];
      if (latest && range.end >= latest.start) latest.start = Math.min(latest.start, range.start);
      else merged.push({ ...range });
    }
    this.historyCoverage = merged;
    // A backwards read can discover a newer header without covering the newly appended tail.
    const cursor =
      merged[0]?.end === page.header.nextSequence ? merged[0].start : page.header.nextSequence;
    return { hasEarlier: cursor > 0, beforeSequence: cursor > 0 ? cursor : null };
  }
  private historySignature(record: IntentRecord) {
    return JSON.stringify([record.intent.revision, record.intent.phase, record.slotResults]);
  }
  private async readHistoryProofs(ids: readonly string[], force = false) {
    const epoch = this.viewEpoch;
    const conversation = this.state.conversation;
    if (!conversation) return;
    for (const id of [...new Set(ids)].slice(0, 30)) {
      const record = conversation.intents[id];
      if (!record?.actionPlan) continue;
      // This is only a loaded-row display cache, never global freshness or action authority.
      const signature = this.historySignature(record);
      if (!force && this.historyRequests.get(id)?.signature === signature) continue;
      const request = { signature };
      this.historyRequests.set(id, request);
      try {
        const proof = repositoryValue(await this.persistence.readActionRecovery(id));
        if (this.disposed || epoch !== this.viewEpoch) return;
        if (this.historyRequests.get(id) !== request) continue;
        if (
          !proof ||
          proof.userIntentId !== id ||
          proof.conversationId !== conversation.header.conversationId ||
          proof.conversationGeneration !== conversation.header.generation ||
          proof.intentRevision !== record.intent.revision
        )
          throw new Error('History proof changed');
        const errors = { ...this.state.historyProofErrors };
        delete errors[id];
        this.patch({
          historyProofs: { ...this.state.historyProofs, [id]: proof },
          historyProofErrors: errors,
        });
      } catch (error) {
        if (this.disposed || epoch !== this.viewEpoch) return;
        if (this.historyRequests.get(id) !== request) continue;
        const proofs = { ...this.state.historyProofs };
        delete proofs[id];
        this.patch({
          historyProofs: proofs,
          historyProofErrors: { ...this.state.historyProofErrors, [id]: assistantError(error) },
        });
      }
    }
  }
  setDraft(text: string) {
    if (!this.state.conversation || this.state.composerPaused) return;
    const generation = this.state.conversation.header.generation;
    const version = ++this.draftVersion;
    this.patch({ draft: text, draftError: undefined });
    if ([...text].length > 4000) {
      this.patch({
        draftError: { code: 'too_large', messageKey: 'ui.draft_limit', retry: 'after_correction' },
      });
      return;
    }
    this.drafts = this.drafts
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed || version !== this.draftVersion) return;
        try {
          const { header } = repositoryValue(await this.persistence.readConversation({ limit: 1 }));
          if (header.generation !== generation) return;
          repositoryValue(
            await this.persistence.saveDraft(
              {
                conversationId: header.conversationId,
                generation,
                expectedConversationRevision: header.revision,
              },
              text,
            ),
          );
          if (version === this.draftVersion) this.savedDraftVersion = version;
        } catch (error) {
          if (version === this.draftVersion) this.patch({ draftError: assistantError(error) });
        }
      });
  }
  retryDraft() {
    this.setDraft(this.state.draft);
  }
  async runTurn(operation: () => Promise<TurnOutcome>, usesProvider = false) {
    if (this.disposed || this.state.busy || this.state.connectionBusy) return;
    if (this.state.continuationReview) this.dismissContinuationReview();
    const epoch = this.viewEpoch;
    const providerEpoch = this.providerAdmissionEpoch;
    this.patch({ busy: true, outcome: undefined, actionError: undefined });
    try {
      await this.drafts;
      if (this.state.draftError || epoch !== this.viewEpoch || this.disposed) return;
      if (usesProvider && providerEpoch !== this.providerAdmissionEpoch) {
        this.patch({
          notice:
            'AI sharing changed while this request was waiting. Your draft is kept; choose Send again when ready.',
        });
        return;
      }
      if (usesProvider && !this.canSendToProvider()) return;
      this.providerTurnActive = usesProvider;
      const result = await operation();
      if (epoch === this.viewEpoch) this.patch({ outcome: result });
    } catch (error) {
      if (epoch === this.viewEpoch)
        this.patch({ outcome: { kind: 'failed', error: assistantError(error) } });
    } finally {
      this.providerTurnActive = false;
      try {
        await this.reload();
        // Turn notifications can exhaust an in-flight audit; check again after the turn settles.
        if (!this.disposed) await this.recovery.check();
      } finally {
        this.sendStartingSequence = undefined;
        this.patch({ busy: false, composerPaused: false, connection: this.connection.getState() });
      }
    }
  }
  send(selection: Parameters<AssistantCoordinator['send']>[1]) {
    if (this.state.busy || this.state.connectionBusy || !this.state.conversation) return;
    if (!this.canSendToProvider()) return;
    const text = this.state.draft;
    this.sendStartingSequence = this.state.conversation.header.nextSequence;
    this.patch({ composerPaused: true });
    return this.runTurn(() => this.core.send(text, selection), true);
  }
  retryTurn(id: string) {
    if (!this.canSendToProvider()) return;
    return this.runTurn(() => this.core.retryTurn(id), true);
  }
  private canSendToProvider() {
    if (!this.aiConsent || this.aiConsent.getSnapshot().status === 'allowed') return true;
    this.patch({
      notice: 'Review AI data sharing before sending. Your draft and local cooking work are kept.',
    });
    return false;
  }
  retryAcceptance() {
    const outcome = this.state.outcome;
    if (outcome?.kind !== 'failed' || !outcome.acceptanceRetry) return;
    const exact = outcome.acceptanceRetry;
    return this.runTurn(() => this.core.retryAcceptance(exact.userIntentId, exact.response));
  }
  async reviewContinuation(userIntentId: string, expectedIntentRevision: number) {
    if (this.disposed || this.state.busy || this.state.connectionBusy || this.state.readError)
      return;
    const epoch = this.viewEpoch;
    const requestId = ++this.continuationReviewEpoch;
    this.patch({
      busy: true,
      continuationReview: { kind: 'loading', requestId, userIntentId },
    });
    try {
      const review = await this.core.readActionContinuationReview({
        userIntentId,
        expectedIntentRevision,
      });
      if (epoch !== this.viewEpoch || requestId !== this.continuationReviewEpoch) return;
      this.patch({
        continuationReview: review
          ? { kind: 'ready', requestId, userIntentId, review }
          : { kind: 'unavailable', requestId, userIntentId },
      });
    } catch (error) {
      if (epoch === this.viewEpoch && requestId === this.continuationReviewEpoch)
        this.patch({
          continuationReview: {
            kind: 'failed',
            requestId,
            userIntentId,
            error: assistantError(error),
          },
        });
    } finally {
      this.patch({ busy: false });
    }
  }
  /** A row may dismiss only its own displayed ticket, never another row or a confirm handoff. */
  dismissContinuationReview(requestId?: number) {
    if (requestId !== undefined && this.state.continuationReview?.requestId !== requestId) return;
    this.continuationReviewEpoch++;
    this.core.invalidateActionContinuationReview();
    this.patch({ continuationReview: undefined });
  }
  async confirmContinuation(review: Immutable<AssistantActionContinuationReview>) {
    const displayed = this.state.continuationReview;
    if (
      this.disposed ||
      this.state.busy ||
      displayed?.kind !== 'ready' ||
      displayed.review !== review
    )
      return;
    const epoch = this.viewEpoch;
    const requestId = displayed.requestId;
    const id = displayed.userIntentId;
    // Claim this exact review synchronously. Closing for confirmation must not revoke its token.
    this.patch({ continuationReview: undefined });
    let attempted = false;
    try {
      await this.runAction(
        id,
        async () => {
          if (this.disposed || requestId !== this.continuationReviewEpoch) return null;
          attempted = true;
          const result = await this.core.confirmActionContinuation({
            source: 'explicit_user',
            review,
          });
          if (epoch !== this.viewEpoch || requestId !== this.continuationReviewEpoch) return null;
          const actionOutcomes = { ...this.state.actionOutcomes };
          const historyProofs = { ...this.state.historyProofs };
          delete actionOutcomes[id];
          delete historyProofs[id];
          this.patch({
            actionOutcomes,
            historyProofs,
            continuationOutcomes: { ...this.state.continuationOutcomes, [id]: result },
          });
          return result.actionOutcome;
        },
        true,
      );
    } finally {
      if (!attempted && requestId === this.continuationReviewEpoch)
        this.dismissContinuationReview();
    }
  }
  async runAction(id: string, operation: () => Promise<ActionOutcome | null>, mutating = false) {
    if (this.disposed || this.state.busy) return;
    if (this.state.continuationReview) this.dismissContinuationReview();
    if (mutating && (this.state.readError || !this.mutationAllowed() || this.mutationsHeld)) {
      this.patch({
        actionError: {
          userIntentId: id,
          error: this.state.readError ?? {
            code: 'already_pending',
            messageKey: 'ui.resolve_earlier_change',
            retry: 'reconcile',
          },
        },
      });
      return;
    }
    const epoch = this.viewEpoch;
    this.patch({ busy: true, mutating, activeIntentId: id, actionError: undefined });
    try {
      if (mutating) {
        const error = await this.checkMutationFreshness();
        if (error || epoch !== this.viewEpoch || this.disposed) {
          if (error && epoch === this.viewEpoch)
            this.patch({ actionError: { userIntentId: id, error } });
          return;
        }
        // Reservation becomes execution ownership only after the unfiltered gate admits it.
        this.executingIntentId = id;
        this.recovery.ownershipChanged();
      }
      const result = await operation();
      if (result && epoch === this.viewEpoch)
        this.patch({ actionOutcomes: { ...this.state.actionOutcomes, [id]: result } });
    } catch (error) {
      if (epoch === this.viewEpoch)
        this.patch({ actionError: { userIntentId: id, error: assistantError(error) } });
    } finally {
      this.recovery.hold();
      this.executingIntentId = undefined;
      this.recovery.ownershipChanged();
      this.patch({ mutating: false });
      try {
        // A next review must see the slots and saved-result proofs refreshed after this action.
        if (!this.disposed) await this.recovery.check();
        if (!this.disposed && (await this.reloadAfterAction()))
          await this.readHistoryProofs([id], true);
      } finally {
        this.patch({ busy: false, activeIntentId: undefined });
      }
    }
  }
  async cancel(id?: string) {
    // Invalidate queued UI admission synchronously, even if durable cancellation later fails.
    const epoch = ++this.viewEpoch;
    this.continuationReviewEpoch++;
    this.patch({ continuationReview: undefined });
    this.recovery.invalidate();
    try {
      await this.core.cancel(id);
    } catch (error) {
      if (epoch === this.viewEpoch)
        this.patch({ outcome: { kind: 'failed', error: assistantError(error) } });
    }
    await this.reload();
    await this.recovery.check();
    if (id) await this.readHistoryProofs([id], true);
  }
  invalidate() {
    this.core.invalidate();
    this.viewEpoch++;
    this.continuationReviewEpoch++;
    this.recovery.invalidate();
    this.patch({
      outcome: undefined,
      actionError: undefined,
      continuationReview: undefined,
      connection: this.connection.getState(),
    });
  }
  workingContextChanged() {
    // The coordinator has already cancelled the previous wait after Data's successful scope write.
    this.viewEpoch++;
    this.continuationReviewEpoch++;
    this.patch({
      outcome: undefined,
      actionError: undefined,
      continuationReview: undefined,
      connection: this.connection.getState(),
      notice:
        'Working context updated. Your full conversation is still saved. Write a fresh brief and send it when you are ready.',
    });
  }
  dismissNotice() {
    this.patch({ notice: undefined });
  }
  returnToDraft() {
    if (this.state.outcome?.kind === 'narrowing') this.patch({ outcome: undefined });
  }
  async dispose() {
    this.unsubscribe?.();
    this.unsubscribeInvalidation?.();
    this.unsubscribeRecovery();
    this.unsubscribeConsent?.();
    this.core.invalidate();
    this.viewEpoch++;
    this.continuationReviewEpoch++;
    this.listeners.clear();
    await this.drafts.catch(() => undefined);
    this.disposed = true;
    await this.reads.catch(() => undefined);
    await this.recovery.dispose();
  }
}
