import type {
  AssistantContext,
  AssistantTurnRequest,
  AssistantTurnResponse,
  CatalogueIdentity,
  CommandResult,
  CommandPayload,
  ConversationOrigin,
  ContractError,
  DateContext,
  LocalCommand,
  MemoryItem,
  OperationReceipt,
  PendingIntent,
  PlanOccurrence,
  PreferenceSnapshot,
  ReferenceSet,
  RelativeDateGuard,
  SavePreferenceCommand,
  ShoppingScope,
} from '@cookmate/contracts';
import type { Immutable } from './search';
import type { RepositoryResult } from './services';

export interface ConversationHeader {
  conversationId: string;
  generation: number;
  revision: number;
  composerDraft: string;
  nextSequence: number;
}

export interface StoredConversationMessage {
  messageId: string;
  conversationId: string;
  generation: number;
  sequence: number;
  role: 'user' | 'assistant';
  text: string;
  status: 'sending' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  createdAt: string;
  referenceSets: readonly Immutable<ReferenceSet>[];
}

export interface ConversationPage {
  header: Immutable<ConversationHeader>;
  /** Ascending display sequence; the preceding page is requested with beforeSequence. */
  messages: readonly Immutable<StoredConversationMessage>[];
  beforeSequence: number | null;
  hasEarlier: boolean;
}

/** Discovery only. Restore/reconcile through the current record; a summary grants no action authority. */
export interface AssistantIntentSummary {
  userIntentId: string;
  revision: number;
  phase: PendingIntent['phase'];
  userMessageId: string;
  assistantMessageId: string | null;
  sourceSequence: number;
  hasActionPlan: boolean;
}
export interface AssistantIntentPage {
  header: Immutable<ConversationHeader>;
  items: readonly Immutable<AssistantIntentSummary>[];
  beforeSequence: number | null;
  hasEarlier: boolean;
}

/** Read-only historical proof; it never authorizes a new dispatch. */
export interface AssistantActionRecovery {
  conversationId: string;
  conversationGeneration: number;
  userIntentId: string;
  intentRevision: number;
  phase: PendingIntent['phase'];
  slots: {
    slotId: string;
    operationId: string;
    outcome: 'receipt' | 'not_executed' | 'unresolved';
    receipt: OperationReceipt | null;
  }[];
}

/** Opaque freshness only, scoped to one open store; never execution authority. */
export type RecoveryToken = string;
/** Ready is the complete unresolved candidate snapshot, never a history/outcome inventory. */
export type RecoveryGate = {
  token: RecoveryToken;
  conversationId: string;
  conversationGeneration: number;
} & (
  | { kind: 'checking'; continuation: string }
  | { kind: 'ready'; candidates: readonly Immutable<AssistantActionRecovery>[] }
);

export interface ConversationWriteGuard {
  conversationId: string;
  generation: number;
  expectedConversationRevision: number;
}

export interface AssistantContextSelection {
  selectedRecipeId?: string;
  selectedPlacement?: AssistantContext['selectedPlacement'];
  reference?: { ordinal: number; referenceSetId?: string };
}

export interface ConversationContextSnapshot {
  conversationId: string;
  conversationGeneration: number;
  contextRevision: number;
  currentMessage: AssistantTurnRequest['message'];
  date: DateContext;
  history: AssistantContext['history'];
  /** Derived, source-message-linked context; never an independently authoritative fact store. */
  memory: AssistantContext['memory'];
  referenceSets: AssistantContext['referenceSets'];
  preferences: PreferenceSnapshot;
  planOccurrences: PlanOccurrence[];
}

/** Local recovery result. It must never be sent as a partial assistant request. */
export interface ContextNarrowing {
  kind: 'narrowing';
  /** Semantic conversation revision used by setWorkingContext CAS. */
  revision: number;
  reason: 'entry_limit' | 'byte_limit' | 'token_limit' | 'pending_evidence';
  coverage: Immutable<AssistantContext['memory']['coverage']>;
  workingContext: Immutable<AssistantContext['memory']['workingContext']>;
}
export interface ConversationMemoryPage {
  header: Immutable<ConversationHeader>;
  items: readonly Immutable<MemoryItem>[];
  workingContext: Immutable<AssistantContext['memory']['workingContext']>;
  beforeSequence: number | null;
  hasEarlier: boolean;
}

export interface CurrentActionState {
  guards: IntentGuardSnapshot;
  planOccurrences: PlanOccurrence[];
  shoppingScope: ShoppingScope;
}

/** One current-store review of the next original operation; reading it grants no execution authority. */
export interface AssistantActionContinuationReview {
  reviewToken: string;
  cursor: number;
  slot: { slotId: string; command: LocalCommand; commandState: 'frozen' | 'prospective' };
  prefixReceipts: { slotId: string; receipt: OperationReceipt }[];
  state: CurrentActionState;
  catalogue: CatalogueIdentity;
}

/** Expected values captured by the app; Data compares them with actual store/runtime authority. */
export interface IntentGuardSnapshot {
  conversationId: string;
  conversationGeneration: number;
  contextRevision: number;
  connectionGeneration: number;
  preferenceRevision: number;
  /** Capture these only where the proposal's consequences depend on the wider collection. */
  planRevision?: number;
  shoppingScopeRevision?: number;
  /** Actual runtime day/timezone at the snapshot, not the request's old interpretation. */
  relativeDateContext: DateContext;
}

export interface StoredAssistantIntent {
  actionPlan: Immutable<AuthorizedActionPlan> | null;
  /** Allocated once by Data at begin, retained through acknowledgement loss and reopen. */
  acceptanceEnvelope: {
    readonly assistantMessageId: string;
    readonly expectedIntentRevision: number;
  };
  intent: Immutable<PendingIntent>;
  request: Immutable<AssistantTurnRequest>;
  response: Immutable<AssistantTurnResponse> | null;
  /** Null before a normal response is accepted and for failed/error turns. */
  guards: Immutable<IntentGuardSnapshot> | null;
  slotResults: readonly { slotId: string; result: Immutable<CommandResult> }[];
}

export type PlannedCommandPayload =
  | Omit<SavePreferenceCommand, 'expectedPreferenceRevision'>
  | Exclude<CommandPayload, SavePreferenceCommand>;
export interface AuthorizedSlotPlan {
  slotId: string;
  operationId: string;
  proposalIndex: number;
  payload: PlannedCommandPayload;
}
export interface AuthorizedActionPlan {
  userIntentId: string;
  revision: number;
  origin: ConversationOrigin;
  relativeDateGuard?: RelativeDateGuard;
  slots: AuthorizedSlotPlan[];
}
export interface FinalizedIntentSlot {
  intent: Immutable<StoredAssistantIntent>;
  slot: Immutable<PendingIntent['slots'][number]>;
}

export interface AssistantAcceptanceResult {
  acknowledgement: Immutable<StoredAssistantIntent>;
  /** Historical acknowledgement never renews action authority; use readIntent/current guards. */
  replay: boolean;
}

/** Canonical injected port. It never exposes SQL or a second authority store. */
export interface AssistantPersistencePort {
  /** Bounded full coverage/incremental proof. Ready candidates are complete and never owner-filtered.
   * Each checking result advances its continuation. An expired continuation fails closed.
   * A missing candidate is not a receipt or proof that historical work had no effect.
   */
  refreshRecoveryGate(input?: {
    continuation?: string;
  }): Promise<RepositoryResult<Immutable<RecoveryGate>>>;
  /** Current retained conversation, ascending USER-source order, including interrupted/settled intents. */
  readIntentPage(input?: {
    beforeSequence?: number;
    limit?: number;
  }): Promise<RepositoryResult<AssistantIntentPage>>;
  /** Serialized writer snapshot. Result.revision is store metadata revision, including journal changes.
   * Null means a retained intent has no plan; unknown/deleted/corrupt records fail.
   * Receipt absence proves not_executed only after durable cancelled/reconciling authority.
   */
  readActionRecovery(
    userIntentId: string,
  ): Promise<RepositoryResult<Immutable<AssistantActionRecovery> | null>>;
  /** Settles only this open store's retained failed attempts, then returns current recovery proof.
   * May suspend/journal authority metadata; never executes effects or retires unrelated active work.
   * With no retained attempt this is read-only. Existing recovery/review reads remain pure.
   */
  reconcileActionRecovery(
    userIntentId: string,
  ): Promise<RepositoryResult<Immutable<AssistantActionRecovery> | null>>;
  /** Related context/revisions are read together; failure is never disguised as empty context. */
  readContext(input: {
    text: string;
    selection: AssistantContextSelection;
    messageId: string;
  }): Promise<RepositoryResult<Immutable<ConversationContextSnapshot>> | ContextNarrowing>;
  /** Local pages expose established IDs/source evidence for deliberate carry selection, beyond wire limits. */
  readMemoryPage(input?: {
    beforeSequence?: number;
    limit?: number;
  }): Promise<RepositoryResult<ConversationMemoryPage>>;
  /** Explicit user scope change; retains transcript, projection, preferences and receipts. */
  setWorkingContext(input: {
    expectedContextRevision: number;
    afterSequence: number | null;
    carryMemoryIds: readonly string[];
  }): Promise<RepositoryResult<Immutable<ConversationHeader>>>;
  readCurrentActionState(
    userIntentId: string,
  ): Promise<RepositoryResult<Immutable<CurrentActionState>>>;
  readConversation(input?: {
    beforeSequence?: number;
    limit?: number;
  }): Promise<RepositoryResult<ConversationPage>>;
  /** Old visible references remain addressable outside the outbound context/page budget. */
  readReferenceSets(
    referenceSetIds: readonly string[],
  ): Promise<RepositoryResult<readonly Immutable<ReferenceSet>[]>>;
  readIntent(
    userIntentId: string,
  ): Promise<RepositoryResult<Immutable<StoredAssistantIntent> | null>>;
  readAcceptance(
    userIntentId: string,
  ): Promise<RepositoryResult<Immutable<StoredAssistantIntent> | null>>;
  saveDraft(
    guard: ConversationWriteGuard,
    text: string,
  ): Promise<RepositoryResult<Immutable<ConversationHeader>>>;
  /** CAS-save user message, request and awaiting_response intent together before sending the request. */
  beginTurn(input: {
    request: AssistantTurnRequest;
    expectedConversationRevision: number;
  }): Promise<RepositoryResult<Immutable<StoredAssistantIntent>>>;
  /** Checks current/request authority; atomically saves reply/references/phase and post-response guards. */
  acceptResponse(input: {
    response: AssistantTurnResponse;
    assistantMessageId: string;
    expectedIntentRevision: number;
  }): Promise<RepositoryResult<AssistantAcceptanceResult>>;
  recordTurnFailure(input: {
    userIntentId: string;
    expectedIntentRevision: number;
    error: ContractError;
  }): Promise<RepositoryResult<Immutable<StoredAssistantIntent>>>;
  rearmTurn(input: {
    userIntentId: string;
    expectedIntentRevision: number;
  }): Promise<RepositoryResult<Immutable<StoredAssistantIntent>>>;
  freezeActionPlan(input: {
    plan: AuthorizedActionPlan;
    expectedIntentRevision: number;
    guards: IntentGuardSnapshot;
  }): Promise<RepositoryResult<Immutable<StoredAssistantIntent>>>;
  finalizeNextIntentSlot(input: {
    userIntentId: string;
    expectedIntentRevision: number;
    slotId: string;
  }): Promise<RepositoryResult<FinalizedIntentSlot>>;
  /** CAS compares supplied, persisted accepted-response, and current guards before freezing authorized slots. */
  freezeIntent(input: {
    intent: PendingIntent;
    expectedIntentRevision: number;
    guards: IntentGuardSnapshot;
  }): Promise<RepositoryResult<Immutable<StoredAssistantIntent>>>;
  /** Loads the frozen slot itself and rechecks current authority; executor consumes ready/dispatched. */
  executeIntentSlot(input: {
    userIntentId: string;
    expectedIntentRevision: number;
    slotId: string;
  }): Promise<CommandResult>;
  /** Atomic read-only snapshot. Null means no reviewable next reservation, never batch completion. */
  readActionContinuationReview(input: {
    userIntentId: string;
    expectedIntentRevision: number;
  }): Promise<RepositoryResult<Immutable<AssistantActionContinuationReview> | null>>;
  /** Returns a matching actual historical receipt, or admits only this exact live review's operation. */
  confirmActionContinuation(input: {
    review: Immutable<AssistantActionContinuationReview>;
  }): Promise<CommandResult>;
  /** Synchronous memory-only revocation, including delayed reads and pending mutation admission. */
  invalidateActionContinuationReview(): void;
  /** Stops undispatched slots; committed effects/receipts remain and dispatched work reconciles. */
  cancelIntent(input: {
    userIntentId: string;
    expectedIntentRevision: number;
  }): Promise<RepositoryResult<Immutable<StoredAssistantIntent>>>;
}
