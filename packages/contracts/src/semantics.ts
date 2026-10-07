import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  CatalogueIdentity,
  ContractError,
  LocalCommand,
  SourceReference,
} from './generated/types.js';
import {
  validateAssistantTurnRequest,
  validateAssistantTurnResponse,
  validateLocalCommand,
} from './generated/validators.js';
import { assistantJsonByteLength, checkMemoryRequest } from './memory';
import { MAX_ASSISTANT_BODY_BYTES } from './constants';

export interface CatalogueBoundary {
  identity: CatalogueIdentity;
  recipeIds: ReadonlySet<string>;
  hasSource(reference: SourceReference): boolean;
}

export type ContractCheck<T> = { ok: true; value: T } | { ok: false; error: ContractError };

function failure<T>(code: ContractError['code'], field: string): ContractCheck<T> {
  return {
    ok: false,
    error: { code, field, messageKey: `contract.${code}`, retry: 'after_correction' },
  };
}

export function isActualLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (monthLengths[month - 1] ?? 0);
}

export function isUtcInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  if (!isActualLocalDate(value.slice(0, 10))) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

export function catalogueMatches(left: CatalogueIdentity, right: CatalogueIdentity): boolean {
  return left.version === right.version && left.fingerprint === right.fingerprint;
}

// Call only after bounded shape validation. This checks intrinsic facts, not
// current DB revisions, source-grounded prose or the user's authority to mutate.
function checkReferences(
  value: unknown,
  catalogue: CatalogueBoundary,
  path = '',
): ContractError | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const error = checkReferences(item, catalogue, `${path}/${index}`);
      if (error) return error;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    const field = `${path}/${key}`;
    let code: ContractError['code'] | undefined;
    if (
      (key === 'recipeId' || key === 'selectedRecipeId') &&
      typeof item === 'string' &&
      !catalogue.recipeIds.has(item)
    )
      code = 'unknown_recipe';
    if (
      key === 'recipeIds' &&
      Array.isArray(item) &&
      item.some((id) => !catalogue.recipeIds.has(id as string))
    )
      code = 'unknown_recipe';
    if (
      ['actualDate', 'localDate', 'resolvedDate'].includes(key) &&
      typeof item === 'string' &&
      !isActualLocalDate(item)
    )
      code = 'invalid_input';
    if (
      ['createdAt', 'updatedAt', 'committedAt', 'expiresAt'].includes(key) &&
      typeof item === 'string' &&
      !isUtcInstant(item)
    )
      code = 'invalid_input';
    if (code) return { code, field, messageKey: `contract.${code}`, retry: 'after_correction' };
    const error = checkReferences(item, catalogue, field);
    if (error) return error;
  }
  return null;
}

function finishCheck<T>(value: T, catalogue: CatalogueBoundary): ContractCheck<T> {
  const error = checkReferences(value, catalogue);
  return error ? { ok: false, error } : { ok: true, value };
}

export function checkAssistantRequest(
  value: unknown,
  catalogue: CatalogueBoundary,
): ContractCheck<AssistantTurnRequest> {
  if (!validateAssistantTurnRequest(value)) return failure('invalid_input', 'request');
  if (!catalogueMatches(value.catalogue, catalogue.identity))
    return failure('incompatible_version', 'catalogue');
  const memoryCheck = checkMemoryRequest(value);
  if (!memoryCheck.ok) return memoryCheck;
  return finishCheck(value, catalogue);
}

export function checkAssistantResponse(
  value: unknown,
  catalogue: CatalogueBoundary,
): ContractCheck<AssistantTurnResponse> {
  if (!validateAssistantTurnResponse(value)) return failure('invalid_model_result', 'response');
  if (assistantJsonByteLength(value) > MAX_ASSISTANT_BODY_BYTES)
    return failure('too_large', 'response');
  if (!catalogueMatches(value.catalogue, catalogue.identity))
    return failure('incompatible_version', 'catalogue');
  if (value.kind !== 'error' && value.sources.some((source) => !catalogue.hasSource(source)))
    return failure('invalid_model_result', 'sources');
  return finishCheck(value, catalogue);
}

export function checkLocalCommand(
  value: unknown,
  catalogue: CatalogueBoundary,
): ContractCheck<LocalCommand> {
  if (!validateLocalCommand(value)) return failure('invalid_input', 'command');
  if (
    value.command.kind === 'movePlanReplacing' &&
    value.command.occurrenceId === value.command.destinationOccurrenceId
  )
    return failure('invalid_input', 'destinationOccurrenceId');
  if (
    value.relativeDateGuard &&
    (!('placement' in value.command) ||
      value.command.placement.actualDate !== value.relativeDateGuard.resolvedDate)
  )
    return failure('invalid_input', 'relativeDateGuard');
  return finishCheck(value, catalogue);
}

export interface ActiveResponseContext {
  requestId: string;
  userIntentId: string;
  intentRevision: number;
  conversationId: string;
  conversationGeneration: number;
  connectionGeneration: number;
  preferenceRevision: number;
  catalogue: CatalogueIdentity;
}

export function isResponseCurrent(
  response: AssistantTurnResponse,
  active: ActiveResponseContext,
): boolean {
  return (
    response.requestId === active.requestId &&
    response.userIntentId === active.userIntentId &&
    response.intentRevision === active.intentRevision &&
    response.conversationId === active.conversationId &&
    response.conversationGeneration === active.conversationGeneration &&
    response.connectionGeneration === active.connectionGeneration &&
    response.preferenceRevision === active.preferenceRevision &&
    catalogueMatches(response.catalogue, active.catalogue)
  );
}

export function isRelativeDateContextCurrent(
  interpreted: { localDate: string; timeZone: string; utcOffsetMinutes: number },
  current: { localDate: string; timeZone: string; utcOffsetMinutes: number },
): boolean {
  return (
    interpreted.localDate === current.localDate &&
    interpreted.timeZone === current.timeZone &&
    interpreted.utcOffsetMinutes === current.utcOffsetMinutes
  );
}
