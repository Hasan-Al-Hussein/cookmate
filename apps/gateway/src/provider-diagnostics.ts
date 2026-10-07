import type { GeminiModel } from './gemini';
import type { ProviderInput } from './provider-contract';
import { SYSTEM_INSTRUCTION } from './provider-contract';
import { MODEL_ENVELOPE_SCHEMA_TEXT } from './provider-schema';

const MAX_DIAGNOSTIC_INTEGER = 2 ** 31 - 1;
function boundedCount(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DIAGNOSTIC_INTEGER
    ? value
    : null;
}

export interface ProviderInputShape {
  promptBytes: number | null;
  /** UTF-8 source text lengths, not serialized JSON field lengths. Schema is included in system. */
  systemInstructionBytes: number | null;
  schemaTextBytes: number | null;
  counts: {
    historyMessages: number | null;
    memoryItems: number | null;
    pendingMemorySources: number | null;
    reviewTargets: number | null;
    savedPreferences: number | null;
    planOccurrences: number | null;
    referenceSets: number | null;
    evidenceRecipes: number | null;
    evidenceIngredients: number | null;
    evidenceInstructions: number | null;
    evidenceAnnotations: number | null;
    retrievalRecords: number | null;
  };
}

/** Observe already-built input only; never parse, retain or emit its text/IDs. */
export function describeProviderInput(
  input: ProviderInput,
  promptBytes: number,
): ProviderInputShape | null {
  try {
    const context = input.request.context;
    return {
      promptBytes: boundedCount(promptBytes),
      systemInstructionBytes: boundedCount(Buffer.byteLength(SYSTEM_INSTRUCTION, 'utf8')),
      schemaTextBytes: boundedCount(Buffer.byteLength(MODEL_ENVELOPE_SCHEMA_TEXT, 'utf8')),
      counts: {
        historyMessages: boundedCount(context.history.length),
        memoryItems: boundedCount(context.memory.items.length),
        pendingMemorySources: boundedCount(context.memory.pendingSources.length),
        reviewTargets: boundedCount(context.memory.reviewTargetMessageIds.length),
        savedPreferences: boundedCount(context.preferences.items.length),
        planOccurrences: boundedCount(context.planOccurrences.length),
        referenceSets: boundedCount(context.referenceSets.length),
        evidenceRecipes: boundedCount(input.evidence.length),
        evidenceIngredients: boundedCount(
          input.evidence.reduce((sum, recipe) => sum + recipe.ingredients.length, 0),
        ),
        evidenceInstructions: boundedCount(
          input.evidence.reduce((sum, recipe) => sum + recipe.instructions.length, 0),
        ),
        evidenceAnnotations: boundedCount(
          input.evidence.reduce((sum, recipe) => sum + recipe.annotations.length, 0),
        ),
        retrievalRecords: boundedCount(input.retrieval.length),
      },
    };
  } catch {
    // Observation cannot add an input rejection or expose an accessor exception.
    return null;
  }
}

/** Only inspect a materialized fetch body. Do not consume, clone or serialize a stream/object. */
export function describeSerializedBody(body: unknown): {
  encoding: 'utf8_string' | 'bytes' | 'unavailable';
  bytes: number | null;
} {
  if (typeof body === 'string')
    return { encoding: 'utf8_string', bytes: boundedCount(Buffer.byteLength(body, 'utf8')) };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
    return { encoding: 'bytes', bytes: boundedCount(body.byteLength) };
  return { encoding: 'unavailable', bytes: null };
}

// Observational limits only: unknown size never rejects or modifies a provider request.
const MAX_OBSERVED_REQUEST_BYTES = 1024 * 1024;
const REQUEST_OBSERVATION_MS = 25;
const MAX_OBSERVED_REQUEST_READS = 1024;

/** Interactions supplies a Request, countTokens supplies init.body. Count an isolated
 * clone only when needed; never decode, parse, retain chunks or consume the original. */
export async function describeSdkRequestBody(
  input: unknown,
  initBody: unknown,
  signal?: AbortSignal | null,
): Promise<ReturnType<typeof describeSerializedBody>> {
  if (initBody !== undefined) return describeSerializedBody(initBody);
  if (!(input instanceof Request) || signal?.aborted) return describeSerializedBody(undefined);
  if (!input.body) return { encoding: 'bytes', bytes: 0 };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = input.clone().body!.getReader();
  } catch {
    return describeSerializedBody(undefined);
  }
  let stop!: () => void;
  const stopped = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined);
  });
  const timeout = setTimeout(stop, REQUEST_OBSERVATION_MS);
  signal?.addEventListener('abort', stop, { once: true });
  let finished = false;
  let bytes = 0;
  try {
    if (signal?.aborted) return describeSerializedBody(undefined);
    // Empty, immediately-ready chunks must not starve the timer indefinitely.
    for (let reads = 0; reads < MAX_OBSERVED_REQUEST_READS; reads++) {
      const item = await Promise.race([reader.read(), stopped]);
      if (!item) return describeSerializedBody(undefined);
      if (item.done) {
        finished = true;
        return { encoding: 'bytes', bytes };
      }
      bytes += item.value.byteLength;
      if (bytes > MAX_OBSERVED_REQUEST_BYTES) return describeSerializedBody(undefined);
    }
    return describeSerializedBody(undefined);
  } catch {
    return describeSerializedBody(undefined);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', stop);
    // A tee's cancellation may wait for the original transport; never await it here.
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

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

const MAX_DETAILS = 8;
const MAX_VIOLATIONS = 8;
const MAX_RETRY_SECONDS = 86_400;
// Exact Google-owned fixtures, not an exhaustive Interactions quota dictionary or
// a claim that these identifiers are emitted by the currently configured models:
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/googleQuotaErrors.test.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/googleErrors.test.ts
const QUOTA_RULES = [
  {
    metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
    ruleId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
    category: 'requests_per_minute',
  },
  {
    metric: 'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count',
    ruleId: 'GenerateContentPaidTierInputTokensPerModelPerMinute',
    category: 'input_tokens_per_minute',
  },
] as const;
// Schemas: https://github.com/googleapis/googleapis/blob/master/google/rpc/error_details.proto
// JSON encoding: https://protobuf.dev/programming-guides/json/
const QUOTA_TYPE = 'type.googleapis.com/google.rpc.QuotaFailure';
const RETRY_TYPE = 'type.googleapis.com/google.rpc.RetryInfo';
const REASON_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

interface NumericMetadata {
  // 'invalid' means not accepted by this narrow numeric parser, not invalid HTTP/ProtoJSON.
  // HTTP dates and noncanonical integer encodings remain unrecognized, never inferred.
  state: 'absent' | 'valid' | 'invalid' | 'out_of_range';
  value: number | null;
}
interface QuotaMetadata {
  category: (typeof QUOTA_RULES)[number]['category'] | 'unknown';
  metric: (typeof QUOTA_RULES)[number]['metric'] | 'unknown';
  ruleId: (typeof QUOTA_RULES)[number]['ruleId'] | 'unknown';
  model: GeminiModel | 'unknown';
  limit: NumericMetadata;
}
export interface ProviderErrorMetadata {
  bodyState:
    | 'parsed'
    | 'no_body'
    | 'malformed_json'
    | 'nonstandard_error'
    | 'response_limit'
    | 'read_failure'
    | 'deadline'
    | 'aborted';
  code: ProviderErrorSummary['interactionCode'];
  status: ProviderErrorSummary['rpcStatus'];
  detailsState: 'absent' | 'array' | 'malformed' | 'truncated';
  recognizedDetails: { quotaFailure: boolean; retryInfo: boolean; errorInfo: boolean };
  unknownDetails: boolean;
  malformedDetails: boolean;
  violationsTruncated: boolean;
  quotaReasons: ('rate_limit' | 'resource_quota')[];
  quotas: QuotaMetadata[];
  retryInfoDelayMs: NumericMetadata[];
  retryAfterDelayMs: NumericMetadata;
  /** The runtime's already-normalized HTTP cooldown, when supplied; never schedules a retry. */
  runtimeRetryAfterDelayMs: number | null;
}
function field(value: unknown, key: string): unknown {
  return object(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}
function numeric(state: NumericMetadata['state'], value: number | null = null): NumericMetadata {
  return { state, value };
}
function quotaLimit(value: unknown): NumericMetadata {
  if (value === undefined) return numeric('absent');
  // Only finite nonnegative integers; no inferred zero for an omitted protobuf field.
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    if (value.length > 16) return numeric('out_of_range');
    value = Number(value);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return numeric('invalid');
  return Number.isSafeInteger(value) ? numeric('valid', value) : numeric('out_of_range');
}
function retryDelay(value: unknown, source: 'detail' | 'header'): NumericMetadata {
  if (value === undefined || value === null) return numeric('absent');
  // Intentionally narrow: HTTP-date Retry-After is unrecognized, never copied or guessed.
  const pattern = source === 'detail' ? /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?s$/ : /^[0-9]+$/;
  if (typeof value !== 'string' || value.length > 64 || !pattern.test(value))
    return numeric('invalid');
  const seconds = Number(source === 'detail' ? value.slice(0, -1) : value);
  if (!Number.isFinite(seconds) || seconds > MAX_RETRY_SECONDS) return numeric('out_of_range');
  // Round up sub-millisecond recommendations. Metadata never schedules a retry.
  return numeric('valid', Math.ceil(seconds * 1000));
}
export function createProviderErrorMetadata(
  retryAfter: string | null,
  runtimeRetryAfterSeconds?: number,
): ProviderErrorMetadata {
  return {
    bodyState: 'no_body',
    code: 'unknown',
    status: 'unknown',
    detailsState: 'absent',
    recognizedDetails: { quotaFailure: false, retryInfo: false, errorInfo: false },
    unknownDetails: false,
    malformedDetails: false,
    violationsTruncated: false,
    quotaReasons: [],
    quotas: [],
    retryInfoDelayMs: [],
    retryAfterDelayMs: retryDelay(retryAfter, 'header'),
    runtimeRetryAfterDelayMs:
      typeof runtimeRetryAfterSeconds === 'number' &&
      Number.isInteger(runtimeRetryAfterSeconds) &&
      runtimeRetryAfterSeconds >= 0 &&
      runtimeRetryAfterSeconds <= MAX_RETRY_SECONDS
        ? runtimeRetryAfterSeconds * 1000
        : null,
  };
}
/** Caller supplies only a body already read under the response cap; no I/O or retry scheduling. */
export function classifyProviderErrorMetadata(
  bytes: Uint8Array,
  metadata: ProviderErrorMetadata,
  models: readonly GeminiModel[],
) {
  const body = Buffer.from(bytes).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    metadata.bodyState = 'malformed_json';
    return;
  }
  const error = field(parsed, 'error');
  if (!object(error)) {
    metadata.bodyState = 'nonstandard_error';
    return;
  }
  metadata.bodyState = 'parsed';
  const fixed = classifyProviderError(body);
  metadata.code = fixed.interactionCode;
  metadata.status = fixed.rpcStatus;
  const details = field(error, 'details');
  if (details === undefined) return;
  if (!Array.isArray(details)) {
    metadata.detailsState = 'malformed';
    return;
  }
  metadata.detailsState = details.length > MAX_DETAILS ? 'truncated' : 'array';
  for (const detail of details.slice(0, MAX_DETAILS)) {
    if (!object(detail)) {
      metadata.malformedDetails = true;
      continue;
    }
    switch (field(detail, '@type')) {
      case QUOTA_TYPE: {
        metadata.recognizedDetails.quotaFailure = true;
        const violations = field(detail, 'violations');
        if (!Array.isArray(violations)) {
          metadata.malformedDetails = true;
          break;
        }
        if (violations.length > MAX_VIOLATIONS) metadata.violationsTruncated = true;
        for (const violation of violations.slice(0, MAX_VIOLATIONS)) {
          if (metadata.quotas.length >= MAX_VIOLATIONS) {
            metadata.violationsTruncated = true;
            break;
          }
          if (!object(violation)) {
            metadata.malformedDetails = true;
            continue;
          }
          const metric =
            QUOTA_RULES.find((rule) => rule.metric === field(violation, 'quotaMetric'))?.metric ??
            'unknown';
          const ruleId =
            QUOTA_RULES.find((rule) => rule.ruleId === field(violation, 'quotaId'))?.ruleId ??
            'unknown';
          const reportedModel = field(field(violation, 'quotaDimensions'), 'model');
          metadata.quotas.push({
            category:
              QUOTA_RULES.find((rule) => rule.metric === metric && rule.ruleId === ruleId)
                ?.category ?? 'unknown',
            metric,
            ruleId,
            model: models.find((model) => model === reportedModel) ?? 'unknown',
            limit: quotaLimit(field(violation, 'quotaValue')),
          });
        }
        break;
      }
      case RETRY_TYPE:
        metadata.recognizedDetails.retryInfo = true;
        metadata.retryInfoDelayMs.push(retryDelay(field(detail, 'retryDelay'), 'detail'));
        break;
      case REASON_TYPE: {
        metadata.recognizedDetails.errorInfo = true;
        // Reasons are domain-scoped, not arbitrary uppercase strings.
        // https://github.com/googleapis/googleapis/blob/master/google/api/error_reason.proto
        const reason =
          field(detail, 'domain') === 'googleapis.com' ? field(detail, 'reason') : undefined;
        const category =
          reason === 'RATE_LIMIT_EXCEEDED'
            ? 'rate_limit'
            : reason === 'RESOURCE_QUOTA_EXCEEDED'
              ? 'resource_quota'
              : undefined;
        if (category && !metadata.quotaReasons.includes(category))
          metadata.quotaReasons.push(category);
        break;
      }
      default:
        metadata.unknownDetails = true;
    }
  }
}
