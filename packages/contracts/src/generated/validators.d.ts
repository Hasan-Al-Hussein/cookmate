// Generated. No Ajv runtime dependency.
import type * as Types from './types.js';
export interface ValidationIssue { instancePath: string; schemaPath: string; keyword: string; params: Record<string, unknown>; message?: string }
export interface Validator<T> { (value: unknown): value is T; errors?: ValidationIssue[] | null }
export const validateAssistantTurnRequest: Validator<Types.AssistantTurnRequest>;
export const validateAssistantTurnResponse: Validator<Types.AssistantTurnResponse>;
export const validateMemoryUpdate: Validator<Types.MemoryUpdate>;
export const validateModelMemoryUpdate: Validator<Types.ModelMemoryUpdate>;
export const validateWorkingContextSelection: Validator<Types.WorkingContextSelection>;
export const validateAssistantAcceptanceInput: Validator<Types.AssistantAcceptanceInput>;
export const validateAiProposal: Validator<Types.AiProposal>;
export const validateLocalCommand: Validator<Types.LocalCommand>;
export const validateOperationReceipt: Validator<Types.OperationReceipt>;
export const validateCommandResult: Validator<Types.CommandResult>;
export const validateMultiActionResult: Validator<Types.MultiActionResult>;
export const validatePendingIntent: Validator<Types.PendingIntent>;
export const validateRecipe: Validator<Types.Recipe>;
export const validatePlanOccurrence: Validator<Types.PlanOccurrence>;
export const validateShoppingScope: Validator<Types.ShoppingScope>;
export const validatePreferenceSnapshot: Validator<Types.PreferenceSnapshot>;
export const validatePairRequest: Validator<Types.PairRequest>;
export const validatePairResponse: Validator<Types.PairResponse>;
export const validateHealthResponse: Validator<Types.HealthResponse>;
