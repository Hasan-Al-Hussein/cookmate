/* Generated from contract.schema.mjs. Do not edit. */

export type CookMateContract =
  | AssistantTurnRequest
  | AssistantTurnResponse
  | MemoryUpdate
  | ModelMemoryUpdate
  | WorkingContextSelection
  | AssistantAcceptanceInput
  | AiProposal
  | LocalCommand
  | OperationReceipt
  | CommandResult
  | MultiActionResult
  | PendingIntent
  | Recipe
  | PlanOccurrence
  | ShoppingScope
  | PreferenceSnapshot
  | PairRequest
  | PairResponse
  | HealthResponse;
export type Fingerprint = string;
export type AppId = string;
export type Sequence = number;
export type LocalDate = string;
export type PreferenceType = "cuisine" | "ingredient_like" | "ingredient_avoid" | "dietary_style";
export type HistoricalTurn = HistoricalUserTurn | HistoricalAssistantTurn;
export type MemoryScope = ConversationMemoryScope | RecipesMemoryScope | PlacementMemoryScope;
export type RecipeId = string;
export type MealKey = "breakfast" | "lunch" | "dinner";
export type UtcInstant = string;
export type AssistantTurnResponse = AnswerResponse | ClarificationResponse | ProposalResponse | ErrorResponse;
export type SourceReference =
  RecipeSourceReference | IngredientSourceReference | InstructionSourceReference | AnnotationSourceReference;
export type RelationTarget = MemoryTarget | SourceTarget;
export type AiProposal = SaveRecipeProposal | AddPlanProposal | SavePreferenceProposal;
export type PlanTarget = EmptyTarget | OccupiedTarget;
export type NormalAssistantTurnResponse = AnswerResponse | ClarificationResponse | ProposalResponse;
export type CommandPayload =
  | SetFavouriteCommand
  | AddPlanCommand
  | ReplacePlanRecipeCommand
  | EditPlanCommand
  | MovePlanReplacingCommand
  | RemovePlanCommand
  | SetShoppingSelectionCommand
  | SetPurchasedCommand
  | SavePreferenceCommand
  | RemovePreferenceCommand
  | ClearPreferencesCommand
  | ClearConversationCommand;
export type EffectSummary = FavouriteEffect | PlanEffect | OtherEffect;
export type CommandResult = ReceiptResult | FailedCommandResult | UncertainCommandResult;

export interface AssistantTurnRequest {
  apiVersion: "2";
  catalogue: CatalogueIdentity;
  requestId: AppId;
  userIntentId: AppId;
  intentRevision: Sequence;
  conversationId: AppId;
  conversationGeneration: Sequence;
  connectionGeneration: Sequence;
  message: CurrentUserMessage;
  context: AssistantContext;
  /**
   * @maxItems 3
   */
  capabilities: ("saveRecipe" | "addPlan" | "savePreference")[];
}
export interface CatalogueIdentity {
  version: string;
  fingerprint: Fingerprint;
}
export interface CurrentUserMessage {
  messageId: AppId;
  text: string;
  sourceSequence: Sequence;
  sourceDateContext: DateContext;
  preferenceRevisionAtSource: Sequence;
  preferenceLinks: SourcePreferenceLink[];
}
export interface DateContext {
  localDate: LocalDate;
  timeZone: string;
  utcOffsetMinutes: number;
}
export interface SourcePreferenceLink {
  sourceMessageId: AppId;
  preferenceId: AppId;
  type: PreferenceType;
  value: string;
  savedRevision: Sequence;
  removedRevision: Sequence | null;
}
export interface AssistantContext {
  /**
   * @maxItems 20
   */
  history: HistoricalTurn[];
  memory: MemoryContext;
  /**
   * @maxItems 10
   */
  referenceSets: ReferenceSet[];
  preferences: PreferenceSnapshot;
  /**
   * @maxItems 42
   */
  planOccurrences: PlanOccurrence[];
  date: DateContext;
  selectedRecipeId?: RecipeId;
  selectedPlacement?: Placement;
}
export interface HistoricalUserTurn {
  messageId: AppId;
  role: "user";
  text: string;
  sourceSequence: Sequence;
  sourceDateContext: DateContext;
  preferenceRevisionAtSource: Sequence;
  preferenceLinks: SourcePreferenceLink[];
}
export interface HistoricalAssistantTurn {
  messageId: AppId;
  role: "assistant";
  text: string;
  sourceSequence: Sequence;
}
export interface MemoryContext {
  projectionRevision: Sequence;
  baseContextRevision: Sequence;
  workingContext: WorkingContextSelection;
  /**
   * @maxItems 32
   */
  items: MemoryItem[];
  /**
   * @minItems 1
   * @maxItems 8
   */
  reviewTargetMessageIds: [AppId, ...AppId[]];
  /**
   * @maxItems 7
   */
  pendingSources: UserMemorySource[];
  coverage: MemoryCoverage;
}
export interface WorkingContextSelection {
  afterSequence: Sequence | null;
  /**
   * @maxItems 32
   */
  carryMemoryIds: AppId[];
}
export interface MemoryItem {
  memoryId: AppId;
  revision: Sequence;
  sourceMessageId: AppId;
  sourceSequence: Sequence;
  sourceDateContext: DateContext;
  preferenceRevisionAtSource: Sequence;
  preferenceLinks: SourcePreferenceLink[];
  quote: string;
  kind: "constraint" | "correction" | "unresolved_intent" | "context";
  scope: MemoryScope;
  /**
   * @maxItems 8
   */
  relations: ResolvedMemoryRelation[];
}
export interface ConversationMemoryScope {
  kind: "conversation";
}
export interface RecipesMemoryScope {
  kind: "recipes";
  /**
   * @minItems 1
   * @maxItems 6
   */
  recipeIds: [RecipeId, ...RecipeId[]];
}
export interface PlacementMemoryScope {
  kind: "placement";
  placement: Placement;
}
export interface Placement {
  actualDate: LocalDate;
  mealKey: MealKey;
}
export interface ResolvedMemoryRelation {
  kind: "supersedes" | "conflicts_with";
  target: MemoryTarget;
}
export interface MemoryTarget {
  kind: "memory";
  memoryId: AppId;
  expectedRevision: Sequence;
}
export interface UserMemorySource {
  sourceMessageId: AppId;
  sourceSequence: Sequence;
  sourceDateContext: DateContext;
  preferenceRevisionAtSource: Sequence;
  preferenceLinks: SourcePreferenceLink[];
  quote: string;
}
export interface MemoryCoverage {
  retainedEntryCount: Sequence;
  suppliedEntryCount: Sequence;
  omittedEntryCount: Sequence;
  pendingUserSourceCount: Sequence;
  pendingWorkingSourceCount: Sequence;
  suppliedReviewTargetCount: Sequence;
  selectionStatus: "within_budget" | "narrowing_required";
}
export interface ReferenceSet {
  referenceSetId: AppId;
  messageId: AppId;
  /**
   * @minItems 1
   * @maxItems 100
   */
  recipeIds: [RecipeId, ...RecipeId[]];
}
export interface PreferenceSnapshot {
  revision: Sequence;
  lastRemovalRevision: Sequence | null;
  /**
   * @maxItems 100
   */
  items: SavedPreference[];
}
export interface SavedPreference {
  preferenceId: AppId;
  type: PreferenceType;
  value: string;
  revision: Sequence;
}
export interface PlanOccurrence {
  occurrenceId: AppId;
  recipeId: RecipeId;
  placement: Placement;
  revision: Sequence;
  createdAt: UtcInstant;
  updatedAt: UtcInstant;
}
export interface AnswerResponse {
  apiVersion: "2";
  catalogue: CatalogueIdentity;
  requestId: AppId;
  userIntentId: AppId;
  intentRevision: Sequence;
  conversationId: AppId;
  conversationGeneration: Sequence;
  connectionGeneration: Sequence;
  preferenceRevision: Sequence;
  kind: "answer";
  text: string;
  /**
   * @maxItems 100
   */
  sources: SourceReference[];
  /**
   * @maxItems 10
   */
  referenceSets: ReferenceSet[];
  memoryUpdate: MemoryUpdate;
}
export interface RecipeSourceReference {
  recipeId: RecipeId;
  section: "recipe";
}
export interface IngredientSourceReference {
  recipeId: RecipeId;
  section: "ingredient";
  position: number;
}
export interface InstructionSourceReference {
  recipeId: RecipeId;
  section: "instruction";
  position: number;
}
export interface AnnotationSourceReference {
  recipeId: RecipeId;
  section: "annotation";
  annotationId: string;
}
export interface MemoryUpdate {
  baseRevision: Sequence;
  baseContextRevision: Sequence;
  /**
   * @minItems 1
   * @maxItems 8
   */
  reviews: [ReviewDisposition, ...ReviewDisposition[]];
  /**
   * @maxItems 8
   */
  entries: MemoryEntryProposal[];
}
export interface ReviewDisposition {
  sourceMessageId: AppId;
  disposition: "retain" | "non_memory" | "unresolved";
}
export interface MemoryEntryProposal {
  sourceMessageId: AppId;
  quote: string;
  kind: "constraint" | "correction" | "unresolved_intent" | "context";
  scope: MemoryScope;
  /**
   * @maxItems 8
   */
  relations: MemoryRelation[];
}
export interface MemoryRelation {
  kind: "supersedes" | "conflicts_with";
  target: RelationTarget;
}
export interface SourceTarget {
  kind: "source";
  sourceMessageId: AppId;
}
export interface ClarificationResponse {
  apiVersion: "2";
  catalogue: CatalogueIdentity;
  requestId: AppId;
  userIntentId: AppId;
  intentRevision: Sequence;
  conversationId: AppId;
  conversationGeneration: Sequence;
  connectionGeneration: Sequence;
  preferenceRevision: Sequence;
  kind: "clarification";
  text: string;
  /**
   * @maxItems 100
   */
  sources: SourceReference[];
  /**
   * @maxItems 10
   */
  referenceSets: ReferenceSet[];
  memoryUpdate: MemoryUpdate;
  /**
   * @minItems 1
   * @maxItems 6
   */
  missing: [
    "recipe" | "date" | "meal" | "preference" | "reference" | "intent",
    ...("recipe" | "date" | "meal" | "preference" | "reference" | "intent")[]
  ];
}
export interface ProposalResponse {
  apiVersion: "2";
  catalogue: CatalogueIdentity;
  requestId: AppId;
  userIntentId: AppId;
  intentRevision: Sequence;
  conversationId: AppId;
  conversationGeneration: Sequence;
  connectionGeneration: Sequence;
  preferenceRevision: Sequence;
  kind: "proposal";
  text: string;
  /**
   * @maxItems 100
   */
  sources: SourceReference[];
  /**
   * @maxItems 10
   */
  referenceSets: ReferenceSet[];
  memoryUpdate: MemoryUpdate;
  /**
   * @minItems 1
   * @maxItems 8
   */
  proposals: [AiProposal, ...AiProposal[]];
}
export interface SaveRecipeProposal {
  kind: "saveRecipe";
  recipeId: RecipeId;
}
export interface AddPlanProposal {
  kind: "addPlan";
  recipeId: RecipeId;
  placement: Placement;
  expectedTarget: PlanTarget;
}
export interface EmptyTarget {
  kind: "empty";
}
export interface OccupiedTarget {
  kind: "occupied";
  occurrenceId: AppId;
  expectedRevision: Sequence;
}
export interface SavePreferenceProposal {
  kind: "savePreference";
  type: PreferenceType;
  explicitValue: string;
}
export interface ErrorResponse {
  apiVersion: "2";
  catalogue: CatalogueIdentity;
  requestId: AppId;
  userIntentId: AppId;
  intentRevision: Sequence;
  conversationId: AppId;
  conversationGeneration: Sequence;
  connectionGeneration: Sequence;
  preferenceRevision: Sequence;
  kind: "error";
  error: ContractError;
}
export interface ContractError {
  code:
    | "invalid_input"
    | "unauthenticated"
    | "pairing_expired"
    | "pairing_revoked"
    | "incompatible_version"
    | "unknown_recipe"
    | "stale_target"
    | "stale_context"
    | "operation_conflict"
    | "already_pending"
    | "too_large"
    | "busy"
    | "quota"
    | "network_unavailable"
    | "untrusted_endpoint"
    | "provider_unavailable"
    | "provider_refused"
    | "deadline"
    | "invalid_model_result"
    | "unsupported_request"
    | "storage_failure"
    | "migration_failure"
    | "cancelled";
  messageKey: string;
  retry: "never" | "after_correction" | "after_reconnect" | "after_delay" | "reconcile";
  field?: string;
  operationId?: AppId;
  retryAfterSeconds?: number;
}
export interface ModelMemoryUpdate {
  baseRevision: Sequence;
  baseContextRevision: Sequence;
  /**
   * @minItems 1
   * @maxItems 8
   */
  reviews: [ReviewDisposition, ...ReviewDisposition[]];
  /**
   * @maxItems 8
   */
  entries: ModelMemoryEntryProposal[];
}
export interface ModelMemoryEntryProposal {
  sourceMessageId: AppId;
  kind: "constraint" | "correction" | "unresolved_intent" | "context";
  scope: MemoryScope;
  /**
   * @maxItems 8
   */
  relations: MemoryRelation[];
}
export interface AssistantAcceptanceInput {
  normalizationVersion: 1;
  frozenRequest: AssistantTurnRequest;
  normalizedResponse: NormalAssistantTurnResponse;
  envelope: AcceptanceEnvelope;
}
export interface AcceptanceEnvelope {
  assistantMessageId: AppId;
  expectedIntentRevision: Sequence;
}
export interface LocalCommand {
  schemaVersion: 2;
  operationId: AppId;
  userIntentId: AppId;
  intentRevision: Sequence;
  payloadFingerprint: Fingerprint;
  origin?: ConversationOrigin;
  relativeDateGuard?: RelativeDateGuard;
  command: CommandPayload;
}
export interface ConversationOrigin {
  conversationId: AppId;
  generation: Sequence;
  messageId: AppId;
}
export interface RelativeDateGuard {
  interpretedAt: DateContext;
  resolvedDate: LocalDate;
  sourceMessageId: AppId;
}
export interface SetFavouriteCommand {
  kind: "setFavourite";
  recipeId: RecipeId;
  saved: boolean;
}
export interface AddPlanCommand {
  kind: "addPlan";
  occurrenceId: AppId;
  recipeId: RecipeId;
  placement: Placement;
  expectedTarget: EmptyTarget;
}
export interface ReplacePlanRecipeCommand {
  kind: "replacePlanRecipe";
  occurrenceId: AppId;
  expectedRevision: Sequence;
  expectedShoppingScopeRevision: Sequence;
  recipeId: RecipeId;
  placement: Placement;
}
export interface EditPlanCommand {
  kind: "editPlan";
  occurrenceId: AppId;
  expectedRevision: Sequence;
  expectedShoppingScopeRevision: Sequence;
  recipeId: RecipeId;
  placement: Placement;
}
export interface MovePlanReplacingCommand {
  kind: "movePlanReplacing";
  occurrenceId: AppId;
  expectedRevision: Sequence;
  expectedShoppingScopeRevision: Sequence;
  destinationOccurrenceId: AppId;
  expectedDestinationRevision: Sequence;
  recipeId: RecipeId;
  placement: Placement;
}
export interface RemovePlanCommand {
  kind: "removePlan";
  occurrenceId: AppId;
  expectedRevision: Sequence;
  expectedShoppingScopeRevision: Sequence;
}
export interface SetShoppingSelectionCommand {
  kind: "setShoppingSelection";
  expectedShoppingScopeRevision: Sequence;
  expectedShoppingRevision?: Sequence;
  /**
   * @maxItems 1000
   */
  occurrenceIds: AppId[];
}
export interface SetPurchasedCommand {
  kind: "setPurchased";
  scopeId: AppId;
  groupKey: string;
  expectedDemandFingerprint: Fingerprint;
  expectedRevision: Sequence;
  purchased: boolean;
}
export interface SavePreferenceCommand {
  kind: "savePreference";
  preferenceId: AppId;
  type: PreferenceType;
  explicitValue: string;
  expectedPreferenceRevision: Sequence;
}
export interface RemovePreferenceCommand {
  kind: "removePreference";
  preferenceId: AppId;
  expectedPreferenceRevision: Sequence;
}
export interface ClearPreferencesCommand {
  kind: "clearPreferences";
  expectedPreferenceRevision: Sequence;
}
export interface ClearConversationCommand {
  kind: "clearConversation";
  conversationId: AppId;
  expectedGeneration: Sequence;
  expectedScopeFingerprint?: Fingerprint;
}
export interface OperationReceipt {
  schemaVersion: 1;
  operationId: AppId;
  userIntentId: AppId;
  payloadFingerprint: Fingerprint;
  outcome: "committed" | "no_op";
  committedAt: UtcInstant;
  /**
   * @maxItems 20
   */
  effects: EffectSummary[];
  shoppingProjection: "unchanged" | "current" | "pending";
}
export interface FavouriteEffect {
  kind: "favourite";
  entityId: RecipeId;
  revision: Sequence;
  saved: boolean;
}
export interface PlanEffect {
  kind: "plan";
  entityId: AppId;
  revision: Sequence;
  change: "added" | "updated" | "removed" | "unchanged";
  recipeId: RecipeId;
  placement: Placement;
}
export interface OtherEffect {
  kind: "shopping_selection" | "purchase" | "preference" | "conversation";
  entityId: string;
  revision: Sequence;
}
export interface ReceiptResult {
  kind: "receipt";
  receipt: OperationReceipt;
}
export interface FailedCommandResult {
  kind: "failed";
  operationId: AppId;
  error: ContractError;
}
export interface UncertainCommandResult {
  kind: "uncertain";
  operationId: AppId;
}
export interface MultiActionResult {
  userIntentId: AppId;
  /**
   * @minItems 1
   * @maxItems 8
   */
  slots: [
    {
      slotId: AppId;
      result: CommandResult;
    },
    ...{
      slotId: AppId;
      result: CommandResult;
    }[]
  ];
}
export interface PendingIntent {
  userIntentId: AppId;
  revision: Sequence;
  origin?: ConversationOrigin;
  phase:
    | "draft"
    | "awaiting_response"
    | "clarification"
    | "confirmation"
    | "ready"
    | "dispatched"
    | "reconciling"
    | "settled"
    | "cancelled";
  /**
   * @maxItems 8
   */
  slots: ActionSlot[];
  relativeDateGuard?: RelativeDateGuard;
}
export interface ActionSlot {
  slotId: AppId;
  command: LocalCommand;
}
export interface Recipe {
  recipeId: RecipeId;
  title: string;
  category: string;
  cuisine: string;
  rawTags: string | null;
  photoKey: string;
  recipePage: string;
  originalSourceUrl: string | null;
  videoUrl: string | null;
  /**
   * @minItems 1
   * @maxItems 100
   */
  ingredients: [IngredientEntry, ...IngredientEntry[]];
  /**
   * @minItems 1
   * @maxItems 200
   */
  instructions: [InstructionPassage, ...InstructionPassage[]];
  /**
   * @maxItems 40
   */
  annotations: QualityAnnotation[];
}
export interface IngredientEntry {
  recipeId: RecipeId;
  position: number;
  rawName: string;
  rawMeasure: string | null;
  source: SourceLocator;
}
export interface SourceLocator {
  sheet: "Recipes" | "Ingredients" | "Instructions";
  row: number;
  column?: string;
}
export interface InstructionPassage {
  recipeId: RecipeId;
  sequence: number;
  rawText: string;
  presentation: "heading" | "passage";
  source: SourceLocator;
}
export interface QualityAnnotation {
  annotationId: string;
  recipeId: RecipeId;
  kind: "limited_instructions" | "instruction_only_ingredient" | "missing_measure" | "source_gap";
  note: string;
  /**
   * @minItems 1
   * @maxItems 20
   */
  evidence: [SourceLocator, ...SourceLocator[]];
  ruleVersion: string;
}
export interface ShoppingScope {
  scopeId: AppId;
  revision: Sequence;
  /**
   * @maxItems 1000
   */
  occurrenceIds: AppId[];
}
export interface PairRequest {
  apiVersion: "2";
  code: string;
}
export interface PairResponse {
  apiVersion: "2";
  clientId: AppId;
  token: string;
  expiresAt: UtcInstant;
  catalogue: CatalogueIdentity;
}
export interface HealthResponse {
  status: "ready";
  apiVersion: "2";
}
