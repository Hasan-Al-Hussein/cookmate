const rpcStatuses = [
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
] as const;

// Standard request-level Interactions codes from the documented error.code envelope.
// Unknown/dynamic values are never returned or inferred from HTTP status or prose.
const interactionCodes = [
  'invalid_request',
  'failed_precondition',
  'out_of_range',
  'parameter_unknown',
  'authentication',
  'payment_required',
  'permission_denied',
  'not_found',
  'model_not_found',
  'already_exists',
  'aborted',
  'rate_limit_exceeded',
  'quota_exceeded',
  'too_many_requests',
  'cancelled',
  'api_error',
  'unimplemented',
  'service_unavailable',
  'deadline_exceeded',
] as const;

export type ProviderInteractionErrorCode = (typeof interactionCodes)[number];
export type ProviderErrorFieldType = 'absent' | 'null' | 'nonstring' | 'string';

export interface ProviderErrorSummary {
  rpcStatus: (typeof rpcStatuses)[number] | 'unknown';
  interactionCode: ProviderInteractionErrorCode | 'unknown';
  jsonBody: boolean;
  errorObject: boolean;
  fieldTypes: {
    error: ProviderErrorFieldType;
    code: ProviderErrorFieldType;
    message: ProviderErrorFieldType;
    status: ProviderErrorFieldType;
  };
  /** True for a string of positive length, including whitespace-only strings. */
  messageNonempty: boolean;
  keywords: {
    response_format: boolean;
    schema: boolean;
    anyOf: boolean;
    additionalProperties: boolean;
    minLength: boolean;
    maxLength: boolean;
    pattern: boolean;
    uniqueItems: boolean;
    max_output_tokens: boolean;
    api_version: boolean;
  };
  phrases: {
    complexity: boolean;
    unsupportedField: boolean;
    invalidSchema: boolean;
    genericInvalidRequest: boolean;
    genericInvalidArgument: boolean;
    genericInvalidJsonPayload: boolean;
  };
  category: 'schema_complexity' | 'unsupported_field' | 'invalid_schema' | 'unknown';
  /** Phrase/keyword presence is a tentative signal, never proof of a root cause. */
  tentative: true;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fieldType(record: Record<string, unknown> | null, key: string): ProviderErrorFieldType {
  if (!record || !Object.hasOwn(record, key)) return 'absent';
  if (record[key] === null) return 'null';
  return typeof record[key] === 'string' ? 'string' : 'nonstring';
}

/** Caller supplies an already bounded body. Read only standard error.code/status/message;
 * never retain provider prose, arbitrary status values, details, headers or nested data. */
export function classifyProviderError(body: string): ProviderErrorSummary {
  let parsed: unknown;
  let jsonBody = false;
  try {
    parsed = JSON.parse(body);
    jsonBody = true;
  } catch {
    // Parse diagnostics can contain the original body; do not inspect or return them.
  }
  const error =
    object(parsed) && Object.hasOwn(parsed, 'error') && object(parsed.error) ? parsed.error : null;
  const code =
    error && Object.hasOwn(error, 'code') && typeof error.code === 'string' ? error.code : '';
  const status =
    error && Object.hasOwn(error, 'status') && typeof error.status === 'string'
      ? error.status.toUpperCase()
      : '';
  const message =
    error && Object.hasOwn(error, 'message') && typeof error.message === 'string'
      ? error.message
      : '';
  const keywords: ProviderErrorSummary['keywords'] = {
    response_format: /\bresponse_format\b/i.test(message),
    schema: /\bschema\b/i.test(message),
    anyOf: /\banyOf\b/i.test(message),
    additionalProperties: /\badditionalProperties\b/i.test(message),
    minLength: /\bminLength\b/i.test(message),
    maxLength: /\bmaxLength\b/i.test(message),
    pattern: /\bpattern\b/i.test(message),
    uniqueItems: /\buniqueItems\b/i.test(message),
    max_output_tokens: /\bmax_output_tokens\b/i.test(message),
    api_version: /\bapi_version\b/i.test(message),
  };
  const phrases: ProviderErrorSummary['phrases'] = {
    complexity:
      /\b(?:schema (?:is )?too complex|input schema contains too many states for serving|schema exceeds (?:the )?(?:maximum allowed )?complexity)\b/i.test(
        message,
      ),
    unsupportedField:
      /\b(?:unknown name|unknown field|unsupported field|unrecognized field|field is not supported)\b/i.test(
        message,
      ),
    invalidSchema:
      /\b(?:invalid (?:json )?schema|schema is invalid|schema validation failed)\b/i.test(message),
    // Generic messages identify no rejected field or cause. Keep their category unknown.
    genericInvalidRequest: /^invalid request\.?$/i.test(message.trim()),
    genericInvalidArgument: /^(?:invalid argument|request contains an invalid argument)\.?$/i.test(
      message.trim(),
    ),
    genericInvalidJsonPayload: /^invalid json payload received\.?$/i.test(message.trim()),
  };
  const categories: ProviderErrorSummary['category'][] = [];
  if (phrases.complexity) categories.push('schema_complexity');
  if (phrases.unsupportedField) categories.push('unsupported_field');
  if (phrases.invalidSchema) categories.push('invalid_schema');
  return {
    rpcStatus: rpcStatuses.find((candidate) => candidate === status) ?? 'unknown',
    interactionCode: interactionCodes.find((candidate) => candidate === code) ?? 'unknown',
    jsonBody,
    errorObject: error !== null,
    fieldTypes: {
      error: fieldType(object(parsed) ? parsed : null, 'error'),
      code: fieldType(error, 'code'),
      message: fieldType(error, 'message'),
      status: fieldType(error, 'status'),
    },
    messageNonempty: message.length > 0,
    keywords,
    phrases,
    // Competing known phrases do not establish which category caused the rejection.
    category: categories.length === 1 ? categories[0]! : 'unknown',
    tentative: true,
  };
}
