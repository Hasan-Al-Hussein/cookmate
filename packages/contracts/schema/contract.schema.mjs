// Application-owned schema. The model and callers can supply data, never schemas.
const ref = (name) => ({ $ref: `#/definitions/${name}` });
const text = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
const literal = (value) => ({ const: value, type: typeof value });
const values = (...items) => ({ type: 'string', enum: items });
const list = (items, maxItems, extra = {}) => ({ type: 'array', items, maxItems, ...extra });
const object = (properties, optional = []) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const union = (...names) => ({ oneOf: names.map(ref) });
const nonnegative = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive = { ...nonnegative, minimum: 1 };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const sourceProvenance = {
  sourceSequence: ref('Sequence'),
  sourceDateContext: ref('DateContext'),
  preferenceRevisionAtSource: ref('Revision'),
  // Never truncate provenance markers. The enclosing UTF-8 body limit applies.
  preferenceLinks: { type: 'array', items: ref('SourcePreferenceLink') },
};
const memoryDescription = {
  kind: values('constraint', 'correction', 'unresolved_intent', 'context'),
  scope: ref('MemoryScope'),
};

const definitions = {
  AppId: {
    ...text(36),
    pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  },
  RecipeId: { ...text(20), pattern: '^[0-9]+$' },
  Revision: nonnegative,
  Sequence: nonnegative,
  Fingerprint: { ...text(64), pattern: '^[0-9a-f]{64}$' },
  LocalDate: { ...text(10), pattern: '^(19[0-9]{2}|20[0-9]{2}|2100)-[0-9]{2}-[0-9]{2}$' },
  UtcInstant: {
    ...text(24),
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
  },
  MealKey: values('breakfast', 'lunch', 'dinner'),
  PreferenceType: values('cuisine', 'ingredient_like', 'ingredient_avoid', 'dietary_style'),
  CatalogueIdentity: object({ version: text(80), fingerprint: ref('Fingerprint') }),
  SourceLocator: object(
    { sheet: values('Recipes', 'Ingredients', 'Instructions'), row: positive, column: text(3) },
    ['column'],
  ),
  IngredientEntry: object({
    recipeId: ref('RecipeId'),
    position: positive,
    rawName: text(512),
    rawMeasure: nullable(text(512, 0)),
    source: ref('SourceLocator'),
  }),
  InstructionPassage: object({
    recipeId: ref('RecipeId'),
    sequence: positive,
    rawText: text(12000),
    presentation: values('heading', 'passage'),
    source: ref('SourceLocator'),
  }),
  QualityAnnotation: object({
    annotationId: text(120),
    recipeId: ref('RecipeId'),
    kind: values(
      'limited_instructions',
      'instruction_only_ingredient',
      'missing_measure',
      'source_gap',
    ),
    note: text(2000),
    evidence: list(ref('SourceLocator'), 20, { minItems: 1 }),
    ruleVersion: text(80),
  }),
  Recipe: object({
    recipeId: ref('RecipeId'),
    title: text(512),
    category: text(128),
    cuisine: text(128),
    rawTags: nullable(text(2048, 0)),
    photoKey: text(256),
    recipePage: text(2048),
    originalSourceUrl: nullable(text(2048)),
    videoUrl: nullable(text(2048)),
    ingredients: list(ref('IngredientEntry'), 100, { minItems: 1 }),
    instructions: list(ref('InstructionPassage'), 200, { minItems: 1 }),
    annotations: list(ref('QualityAnnotation'), 40),
  }),
  Placement: object({ actualDate: ref('LocalDate'), mealKey: ref('MealKey') }),
  PlanOccurrence: object({
    occurrenceId: ref('AppId'),
    recipeId: ref('RecipeId'),
    placement: ref('Placement'),
    revision: ref('Revision'),
    createdAt: ref('UtcInstant'),
    updatedAt: ref('UtcInstant'),
  }),
  ShoppingScope: object({
    scopeId: ref('AppId'),
    revision: ref('Revision'),
    occurrenceIds: list(ref('AppId'), 1000, { uniqueItems: true }),
  }),
  SavedPreference: object({
    preferenceId: ref('AppId'),
    type: ref('PreferenceType'),
    value: text(256),
    revision: ref('Revision'),
  }),
  PreferenceSnapshot: object({
    revision: ref('Revision'),
    lastRemovalRevision: nullable(ref('Revision')),
    items: list(ref('SavedPreference'), 100),
  }),
  DateContext: object({
    localDate: ref('LocalDate'),
    timeZone: text(100),
    utcOffsetMinutes: { type: 'integer', minimum: -840, maximum: 840 },
  }),
  RelativeDateGuard: object({
    interpretedAt: ref('DateContext'),
    resolvedDate: ref('LocalDate'),
    sourceMessageId: ref('AppId'),
  }),
  ConversationOrigin: object({
    conversationId: ref('AppId'),
    generation: ref('Revision'),
    messageId: ref('AppId'),
  }),
  ReferenceSet: object({
    referenceSetId: ref('AppId'),
    messageId: ref('AppId'),
    recipeIds: list(ref('RecipeId'), 100, { minItems: 1, uniqueItems: true }),
  }),
  CurrentUserMessage: object({
    messageId: ref('AppId'),
    text: text(4000),
    ...sourceProvenance,
  }),
  HistoricalUserTurn: object({
    messageId: ref('AppId'),
    role: literal('user'),
    text: text(4000),
    ...sourceProvenance,
  }),
  HistoricalAssistantTurn: object({
    messageId: ref('AppId'),
    role: literal('assistant'),
    text: text(8000),
    sourceSequence: ref('Sequence'),
  }),
  HistoricalTurn: union('HistoricalUserTurn', 'HistoricalAssistantTurn'),
  SourcePreferenceLink: object({
    sourceMessageId: ref('AppId'),
    preferenceId: ref('AppId'),
    type: ref('PreferenceType'),
    value: text(256),
    savedRevision: ref('Revision'),
    removedRevision: nullable(ref('Revision')),
  }),
  UserMemorySource: object({
    sourceMessageId: ref('AppId'),
    ...sourceProvenance,
    quote: text(4000),
  }),
  ConversationMemoryScope: object({ kind: literal('conversation') }),
  RecipesMemoryScope: object({
    kind: literal('recipes'),
    recipeIds: list(ref('RecipeId'), 6, { minItems: 1, uniqueItems: true }),
  }),
  PlacementMemoryScope: object({ kind: literal('placement'), placement: ref('Placement') }),
  MemoryScope: union('ConversationMemoryScope', 'RecipesMemoryScope', 'PlacementMemoryScope'),
  MemoryTarget: object({
    kind: literal('memory'),
    memoryId: ref('AppId'),
    expectedRevision: ref('Revision'),
  }),
  SourceTarget: object({ kind: literal('source'), sourceMessageId: ref('AppId') }),
  RelationTarget: union('MemoryTarget', 'SourceTarget'),
  MemoryRelation: object({
    kind: values('supersedes', 'conflicts_with'),
    target: ref('RelationTarget'),
  }),
  ResolvedMemoryRelation: object({
    kind: values('supersedes', 'conflicts_with'),
    target: ref('MemoryTarget'),
  }),
  MemoryItem: object({
    memoryId: ref('AppId'),
    revision: ref('Revision'),
    sourceMessageId: ref('AppId'),
    ...sourceProvenance,
    quote: text(4000),
    ...memoryDescription,
    relations: list(ref('ResolvedMemoryRelation'), 8),
  }),
  WorkingContextSelection: object({
    afterSequence: nullable(ref('Sequence')),
    carryMemoryIds: list(ref('AppId'), 32, { uniqueItems: true }),
  }),
  MemoryCoverage: object({
    retainedEntryCount: nonnegative,
    suppliedEntryCount: nonnegative,
    omittedEntryCount: nonnegative,
    pendingUserSourceCount: nonnegative,
    pendingWorkingSourceCount: nonnegative,
    suppliedReviewTargetCount: nonnegative,
    selectionStatus: values('within_budget', 'narrowing_required'),
  }),
  MemoryContext: object({
    projectionRevision: ref('Revision'),
    baseContextRevision: ref('Revision'),
    workingContext: ref('WorkingContextSelection'),
    items: list(ref('MemoryItem'), 32),
    reviewTargetMessageIds: list(ref('AppId'), 8, { minItems: 1, uniqueItems: true }),
    pendingSources: list(ref('UserMemorySource'), 7),
    coverage: ref('MemoryCoverage'),
  }),
  ReviewDisposition: object({
    sourceMessageId: ref('AppId'),
    disposition: values('retain', 'non_memory', 'unresolved'),
  }),
  MemoryEntryProposal: object({
    sourceMessageId: ref('AppId'),
    quote: text(4000),
    ...memoryDescription,
    relations: list(ref('MemoryRelation'), 8),
  }),
  ModelMemoryEntryProposal: object({
    sourceMessageId: ref('AppId'),
    ...memoryDescription,
    relations: list(ref('MemoryRelation'), 8),
  }),
  MemoryUpdate: object({
    baseRevision: ref('Revision'),
    baseContextRevision: ref('Revision'),
    reviews: list(ref('ReviewDisposition'), 8, { minItems: 1 }),
    entries: list(ref('MemoryEntryProposal'), 8),
  }),
  ModelMemoryUpdate: object({
    baseRevision: ref('Revision'),
    baseContextRevision: ref('Revision'),
    reviews: list(ref('ReviewDisposition'), 8, { minItems: 1 }),
    entries: list(ref('ModelMemoryEntryProposal'), 8),
  }),
  RecipeSourceReference: object({ recipeId: ref('RecipeId'), section: literal('recipe') }),
  IngredientSourceReference: object({
    recipeId: ref('RecipeId'),
    section: literal('ingredient'),
    position: positive,
  }),
  InstructionSourceReference: object({
    recipeId: ref('RecipeId'),
    section: literal('instruction'),
    position: positive,
  }),
  AnnotationSourceReference: object({
    recipeId: ref('RecipeId'),
    section: literal('annotation'),
    annotationId: text(120),
  }),
  SourceReference: union(
    'RecipeSourceReference',
    'IngredientSourceReference',
    'InstructionSourceReference',
    'AnnotationSourceReference',
  ),
  EmptyTarget: object({ kind: literal('empty') }),
  OccupiedTarget: object({
    kind: literal('occupied'),
    occurrenceId: ref('AppId'),
    expectedRevision: ref('Revision'),
  }),
  PlanTarget: union('EmptyTarget', 'OccupiedTarget'),
  SaveRecipeProposal: object({ kind: literal('saveRecipe'), recipeId: ref('RecipeId') }),
  AddPlanProposal: object({
    kind: literal('addPlan'),
    recipeId: ref('RecipeId'),
    placement: ref('Placement'),
    expectedTarget: ref('PlanTarget'),
  }),
  SavePreferenceProposal: object({
    kind: literal('savePreference'),
    type: ref('PreferenceType'),
    explicitValue: text(256),
  }),
  AiProposal: union('SaveRecipeProposal', 'AddPlanProposal', 'SavePreferenceProposal'),
  AssistantContext: object(
    {
      history: list(ref('HistoricalTurn'), 20),
      memory: ref('MemoryContext'),
      referenceSets: list(ref('ReferenceSet'), 10),
      preferences: ref('PreferenceSnapshot'),
      planOccurrences: list(ref('PlanOccurrence'), 42),
      date: ref('DateContext'),
      selectedRecipeId: ref('RecipeId'),
      selectedPlacement: ref('Placement'),
    },
    ['selectedRecipeId', 'selectedPlacement'],
  ),
  ContractError: object(
    {
      code: values(
        'invalid_input',
        'unauthenticated',
        'pairing_expired',
        'pairing_revoked',
        'incompatible_version',
        'unknown_recipe',
        'stale_target',
        'stale_context',
        'operation_conflict',
        'already_pending',
        'too_large',
        'busy',
        'quota',
        'network_unavailable',
        'untrusted_endpoint',
        'provider_unavailable',
        'provider_refused',
        'deadline',
        'invalid_model_result',
        'unsupported_request',
        'storage_failure',
        'migration_failure',
        'cancelled',
      ),
      messageKey: text(120),
      retry: values('never', 'after_correction', 'after_reconnect', 'after_delay', 'reconcile'),
      field: text(120),
      operationId: ref('AppId'),
      retryAfterSeconds: { type: 'integer', minimum: 0, maximum: 86400 },
    },
    ['field', 'operationId', 'retryAfterSeconds'],
  ),
};

const correlation = {
  apiVersion: literal('2'),
  catalogue: ref('CatalogueIdentity'),
  requestId: ref('AppId'),
  userIntentId: ref('AppId'),
  intentRevision: ref('Revision'),
  conversationId: ref('AppId'),
  conversationGeneration: ref('Revision'),
  connectionGeneration: ref('Revision'),
};

definitions.AssistantTurnRequest = object({
  ...correlation,
  message: ref('CurrentUserMessage'),
  context: ref('AssistantContext'),
  capabilities: list(values('saveRecipe', 'addPlan', 'savePreference'), 3, { uniqueItems: true }),
});

const response = { ...correlation, preferenceRevision: ref('Revision') };
const answer = {
  text: text(8000),
  sources: list(ref('SourceReference'), 100),
  referenceSets: list(ref('ReferenceSet'), 10),
  memoryUpdate: ref('MemoryUpdate'),
};
definitions.AnswerResponse = object({ ...response, kind: literal('answer'), ...answer });
definitions.ClarificationResponse = object({
  ...response,
  kind: literal('clarification'),
  ...answer,
  missing: list(values('recipe', 'date', 'meal', 'preference', 'reference', 'intent'), 6, {
    minItems: 1,
    uniqueItems: true,
  }),
});
definitions.ProposalResponse = object({
  ...response,
  kind: literal('proposal'),
  ...answer,
  proposals: list(ref('AiProposal'), 8, { minItems: 1 }),
});
definitions.ErrorResponse = object({
  ...response,
  kind: literal('error'),
  error: ref('ContractError'),
});
definitions.AssistantTurnResponse = union(
  'AnswerResponse',
  'ClarificationResponse',
  'ProposalResponse',
  'ErrorResponse',
);
definitions.NormalAssistantTurnResponse = union(
  'AnswerResponse',
  'ClarificationResponse',
  'ProposalResponse',
);
definitions.AcceptanceEnvelope = object({
  assistantMessageId: ref('AppId'),
  expectedIntentRevision: ref('Revision'),
});
definitions.AssistantAcceptanceInput = object({
  normalizationVersion: literal(1),
  frozenRequest: ref('AssistantTurnRequest'),
  normalizedResponse: ref('NormalAssistantTurnResponse'),
  envelope: ref('AcceptanceEnvelope'),
});

const occurrenceGuard = { occurrenceId: ref('AppId'), expectedRevision: ref('Revision') };
const scopeGuard = { expectedShoppingScopeRevision: ref('Revision') };
definitions.SetFavouriteCommand = object({
  kind: literal('setFavourite'),
  recipeId: ref('RecipeId'),
  saved: { type: 'boolean' },
});
definitions.AddPlanCommand = object({
  kind: literal('addPlan'),
  occurrenceId: ref('AppId'),
  recipeId: ref('RecipeId'),
  placement: ref('Placement'),
  expectedTarget: ref('EmptyTarget'),
});
definitions.ReplacePlanRecipeCommand = object({
  kind: literal('replacePlanRecipe'),
  ...occurrenceGuard,
  ...scopeGuard,
  recipeId: ref('RecipeId'),
  placement: ref('Placement'),
});
definitions.EditPlanCommand = object({
  kind: literal('editPlan'),
  ...occurrenceGuard,
  ...scopeGuard,
  recipeId: ref('RecipeId'),
  placement: ref('Placement'),
});
definitions.MovePlanReplacingCommand = object({
  kind: literal('movePlanReplacing'),
  ...occurrenceGuard,
  ...scopeGuard,
  destinationOccurrenceId: ref('AppId'),
  expectedDestinationRevision: ref('Revision'),
  recipeId: ref('RecipeId'),
  placement: ref('Placement'),
});
definitions.RemovePlanCommand = object({
  kind: literal('removePlan'),
  ...occurrenceGuard,
  ...scopeGuard,
});
definitions.SetShoppingSelectionCommand = object(
  {
    kind: literal('setShoppingSelection'),
    ...scopeGuard,
    // New reviews bind purchase-mark consequences; legacy durable commands retain their prior scope.
    expectedShoppingRevision: ref('Sequence'),
    occurrenceIds: list(ref('AppId'), 1000, { uniqueItems: true }),
  },
  ['expectedShoppingRevision'],
);
definitions.SetPurchasedCommand = object({
  kind: literal('setPurchased'),
  scopeId: ref('AppId'),
  groupKey: text(256),
  expectedDemandFingerprint: ref('Fingerprint'),
  expectedRevision: ref('Revision'),
  purchased: { type: 'boolean' },
});
definitions.SavePreferenceCommand = object({
  kind: literal('savePreference'),
  preferenceId: ref('AppId'),
  type: ref('PreferenceType'),
  explicitValue: text(256),
  expectedPreferenceRevision: ref('Revision'),
});
definitions.RemovePreferenceCommand = object({
  kind: literal('removePreference'),
  preferenceId: ref('AppId'),
  expectedPreferenceRevision: ref('Revision'),
});
definitions.ClearPreferencesCommand = object({
  kind: literal('clearPreferences'),
  expectedPreferenceRevision: ref('Revision'),
});
definitions.ClearConversationCommand = object(
  {
    kind: literal('clearConversation'),
    conversationId: ref('AppId'),
    expectedGeneration: ref('Revision'),
    // Optional only so old durable commands can resolve an existing receipt. New execution
    // requires the exact reviewed scope; missing fingerprints require a fresh review.
    expectedScopeFingerprint: ref('Fingerprint'),
  },
  ['expectedScopeFingerprint'],
);
definitions.CommandPayload = union(
  'SetFavouriteCommand',
  'AddPlanCommand',
  'ReplacePlanRecipeCommand',
  'EditPlanCommand',
  'MovePlanReplacingCommand',
  'RemovePlanCommand',
  'SetShoppingSelectionCommand',
  'SetPurchasedCommand',
  'SavePreferenceCommand',
  'RemovePreferenceCommand',
  'ClearPreferencesCommand',
  'ClearConversationCommand',
);
definitions.LocalCommand = object(
  {
    schemaVersion: literal(2),
    operationId: ref('AppId'),
    userIntentId: ref('AppId'),
    intentRevision: ref('Revision'),
    payloadFingerprint: ref('Fingerprint'),
    origin: ref('ConversationOrigin'),
    relativeDateGuard: ref('RelativeDateGuard'),
    command: ref('CommandPayload'),
  },
  ['origin', 'relativeDateGuard'],
);
definitions.FavouriteEffect = object({
  kind: literal('favourite'),
  entityId: ref('RecipeId'),
  revision: ref('Revision'),
  saved: { type: 'boolean' },
});
definitions.PlanEffect = object({
  kind: literal('plan'),
  entityId: ref('AppId'),
  revision: ref('Revision'),
  change: values('added', 'updated', 'removed', 'unchanged'),
  recipeId: ref('RecipeId'),
  placement: ref('Placement'),
});
definitions.OtherEffect = object({
  kind: values('shopping_selection', 'purchase', 'preference', 'conversation'),
  entityId: text(256),
  revision: ref('Revision'),
});
definitions.EffectSummary = union('FavouriteEffect', 'PlanEffect', 'OtherEffect');
definitions.OperationReceipt = object({
  schemaVersion: literal(1),
  operationId: ref('AppId'),
  userIntentId: ref('AppId'),
  payloadFingerprint: ref('Fingerprint'),
  outcome: values('committed', 'no_op'),
  committedAt: ref('UtcInstant'),
  effects: list(ref('EffectSummary'), 20),
  shoppingProjection: values('unchanged', 'current', 'pending'),
});
definitions.ReceiptResult = object({ kind: literal('receipt'), receipt: ref('OperationReceipt') });
definitions.FailedCommandResult = object({
  kind: literal('failed'),
  operationId: ref('AppId'),
  error: ref('ContractError'),
});
definitions.UncertainCommandResult = object({
  kind: literal('uncertain'),
  operationId: ref('AppId'),
});
definitions.CommandResult = union('ReceiptResult', 'FailedCommandResult', 'UncertainCommandResult');
definitions.ActionSlot = object({ slotId: ref('AppId'), command: ref('LocalCommand') });
definitions.MultiActionResult = object({
  userIntentId: ref('AppId'),
  slots: list(object({ slotId: ref('AppId'), result: ref('CommandResult') }), 8, { minItems: 1 }),
});
definitions.PendingIntent = object(
  {
    userIntentId: ref('AppId'),
    revision: ref('Revision'),
    origin: ref('ConversationOrigin'),
    phase: values(
      'draft',
      'awaiting_response',
      'clarification',
      'confirmation',
      'ready',
      'dispatched',
      'reconciling',
      'settled',
      'cancelled',
    ),
    slots: list(ref('ActionSlot'), 8),
    relativeDateGuard: ref('RelativeDateGuard'),
  },
  ['origin', 'relativeDateGuard'],
);
definitions.PairRequest = object({
  apiVersion: literal('2'),
  code: { ...text(12), pattern: '^[A-HJ-NP-Z2-9]{12}$' },
});
definitions.PairResponse = object({
  apiVersion: literal('2'),
  clientId: ref('AppId'),
  token: { ...text(43), pattern: '^[A-Za-z0-9_-]{43}$' },
  expiresAt: ref('UtcInstant'),
  catalogue: ref('CatalogueIdentity'),
});
definitions.HealthResponse = object({ status: literal('ready'), apiVersion: literal('2') });

for (const [name, definition] of Object.entries(definitions)) definition.title = name;

export const validationRoots = [
  'AssistantTurnRequest',
  'AssistantTurnResponse',
  'MemoryUpdate',
  'ModelMemoryUpdate',
  'WorkingContextSelection',
  'AssistantAcceptanceInput',
  'AiProposal',
  'LocalCommand',
  'OperationReceipt',
  'CommandResult',
  'MultiActionResult',
  'PendingIntent',
  'Recipe',
  'PlanOccurrence',
  'ShoppingScope',
  'PreferenceSnapshot',
  'PairRequest',
  'PairResponse',
  'HealthResponse',
];
export const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://cookmate.invalid/contracts/v2',
  title: 'CookMateContract',
  anyOf: validationRoots.map(ref),
  definitions,
};

// These must be reused by Fastify. Defaults silently change consequential inputs.
export const strictAjvOptions = {
  strict: true,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
};
