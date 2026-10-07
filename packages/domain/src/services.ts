import type {
  AnnotationSourceReference,
  CatalogueIdentity,
  CommandResult,
  CommandPayload,
  ContractError,
  IngredientSourceReference,
  LocalCommand,
  LocalDate,
  OperationReceipt,
  PlanOccurrence,
  PendingIntent,
  PreferenceSnapshot,
  Recipe,
  ShoppingScope,
} from '@cookmate/contracts';
import type { Immutable } from './search';
import type { DirectActionInput, DirectActionReview } from './directActions';
import type { PortableBackupEnvelope } from './portableBackup';
import type { ConversationExportSnapshot } from './conversationExport';
import type { PortableRestoreService } from './portableRestore';
import type { CookingService } from './cooking';
import type { PersonalService } from './personal';
import type {
  AssistantPersistencePort,
  ConversationHeader,
  RecoveryToken,
} from './conversationPorts';

/** Empty/null is an actual successful read, never a fallback after storage failure. */
export type RepositoryResult<Value> =
  | { kind: 'ready'; value: Value; revision: number }
  | { kind: 'failed'; error: ContractError };

export interface Favourite {
  recipeId: string;
  revision: number;
  savedAt: string;
}

export interface PlanSnapshot {
  startDate: LocalDate;
  endDate: LocalDate;
  occurrences: readonly Immutable<PlanOccurrence>[];
  /** Persistent scope can include occurrences outside the queried week. */
  shoppingScope: Immutable<ShoppingScope>;
}

export interface ShoppingContribution {
  contributionId: string;
  occurrenceId: string;
  recipeId: string;
  source: IngredientSourceReference | AnnotationSourceReference;
  rawName: string;
  rawMeasure: string | null;
  quantity:
    | { kind: 'exact'; numerator: string; denominator: string; unit: string }
    | { kind: 'unknown' | 'unparsed' | 'review_source' };
}

export interface ShoppingGroup {
  groupKey: string;
  displayName: string;
  quantityLabel: string;
  contributions: readonly ShoppingContribution[];
  demandFingerprint: string;
  purchased: boolean;
  changed: boolean;
  revision: number;
}

export interface ShoppingSnapshot {
  scope: Immutable<ShoppingScope>;
  selectedOccurrences: readonly Immutable<PlanOccurrence>[];
  projectionRevision: number;
  status: 'current' | 'pending';
  groups: readonly Immutable<ShoppingGroup>[];
}

export type ChangedCollection = 'favourites' | 'plan' | 'shopping' | 'preferences' | 'conversation';
export interface StoreChange {
  revision: number;
  collections: readonly ChangedCollection[];
  /** Owner-certified recovery freshness; does not establish complete cold coverage. */
  recovery?: { kind: 'unchanged'; token: RecoveryToken };
  /** Exact acknowledged saveDraft commit only; no messages or intents changed in that commit. */
  conversationChange?: { kind: 'draft_only'; header: Immutable<ConversationHeader> };
}

export interface DirectRecoveryEntry {
  sequence: number;
  operationId: string;
  userIntentId: string;
  commandKind: CommandPayload['kind'];
  phase: PendingIntent['phase'];
  outcome: 'receipt' | 'not_executed' | 'unresolved';
  receipt: Immutable<OperationReceipt> | null;
}
export interface DirectRecoveryPage {
  entries: readonly Immutable<DirectRecoveryEntry>[];
  nextAfterSequence: number | null;
}

/** Queries return immutable snapshots from the local store. */
export interface CookMateQueries {
  readonly catalogue: Readonly<CatalogueIdentity>;
  /** Ordinary database identity used to detect reinstall against secure connection credentials. */
  readInstallationId(): Promise<RepositoryResult<string>>;
  readRecipe(recipeId: string): Promise<RepositoryResult<Immutable<Recipe> | null>>;
  readFavourites(): Promise<RepositoryResult<readonly Immutable<Favourite>[]>>;
  readPlan(startDate: LocalDate, endDate: LocalDate): Promise<RepositoryResult<PlanSnapshot>>;
  readShopping(): Promise<RepositoryResult<ShoppingSnapshot>>;
  readPreferences(): Promise<RepositoryResult<Immutable<PreferenceSnapshot>>>;
  /** User-initiated plain-data backup only; excludes credentials, messages, drafts and action state. */
  readPortableBackup(options?: {
    includeCookingHistory?: boolean;
  }): Promise<RepositoryResult<Immutable<PortableBackupEnvelope>>>;
  /** Explicit read-only transcript export; no draft, request context or execution authority. */
  readConversationExport?(): Promise<RepositoryResult<Immutable<ConversationExportSnapshot>>>;
  readReceipt(operationId: string): Promise<RepositoryResult<Immutable<OperationReceipt> | null>>;
  /** Pending notices only; settled writer snapshot, never an inferred empty history. */
  readDirectRecovery(input?: {
    afterSequence?: number;
    limit?: number;
  }): Promise<RepositoryResult<DirectRecoveryPage>>;
  /** Emitted only after successful commit. A failure must not announce a fictitious revision. */
  subscribe(listener: (change: StoreChange) => void): () => void;
  /** Synchronous pre-mutation or unknown invalidation, independent of committed-change events. */
  subscribeRecoveryInvalidation(
    listener: (event: { token: RecoveryToken | null }) => void,
  ): () => void;
}

export interface CookMateCommands {
  /** Resolves current guards and consequences without changing stored state. */
  reviewDirect(
    input: Immutable<DirectActionInput>,
  ): Promise<RepositoryResult<Immutable<DirectActionReview>>>;
  /** Call only after explicit confirmation, retaining this exact command for execution/retry. */
  prepareDirect(
    review: Immutable<DirectActionReview>,
  ): Promise<RepositoryResult<Immutable<LocalCommand>>>;
  /** App-authorized commands only; current intent/revisions and fingerprint are revalidated. */
  execute(command: Immutable<LocalCommand>): Promise<CommandResult>;
  /** Dismiss only an actually proven receipt or cancelled/no-effect outcome already handled by UI. */
  acknowledgeDirectRecovery(operationId: string): Promise<RepositoryResult<null>>;
}

export interface CookMateServices {
  /** Private app-only notes/collections/manual items. Excluded from portable format-1 and AI context. */
  personal?: PersonalService;
  /** Present only after explicit schema-4 cooking rollout. Excluded from portable format-1 backups. */
  cooking?: CookingService;
  /** Present only after explicit schema-3 rollout activation. */
  portableRestore?: PortableRestoreService;
  /** Bind once per opened store; the callback reads the live connection authority. */
  assistant(runtime: { connectionGeneration(): number }): AssistantPersistencePort;
  queries: CookMateQueries;
  commands: CookMateCommands;
  close(): Promise<void>;
}

export type StoreInitializationResult =
  | { kind: 'ready'; services: CookMateServices }
  | { kind: 'failed'; error: ContractError };
