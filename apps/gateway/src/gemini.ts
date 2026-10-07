import { GoogleGenAI } from '@google/genai';
import type { HttpOptions } from '@google/genai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_ASSISTANT_BODY_BYTES } from '@cookmate/contracts';
import type { ModelProvider, ProviderExecution } from './provider-contract';
import { SYSTEM_INSTRUCTION } from './provider-contract';
import { isProviderEnvelope } from './provider-schema';
import { inspectStructuredOutputText } from './provider-text';
import type { StructuredOutputTextInspection } from './provider-text';
import { contextBudgetError, gatewayError, GatewayError } from './errors';
import { LIMITS } from './limits';
import { abortable } from './admission';
import type { ProviderPhysicalAdmission } from './provider-physical-admission';
import {
  classifyProviderError,
  createProviderErrorMetadata,
  classifyProviderErrorMetadata,
  describeProviderInput,
  describeSerializedBody,
  describeSdkRequestBody,
} from './provider-diagnostics';
import type {
  ProviderErrorSummary,
  ProviderErrorMetadata,
  ProviderInputShape,
} from './provider-diagnostics';

export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'] as const;
export type GeminiModel = (typeof GEMINI_MODELS)[number];
type SdkFetch = NonNullable<HttpOptions['fetch']>;

// ContractError allows at most one day. This is a user retry hint, never a scheduled retry.
const MAX_RETRY_AFTER_SECONDS = 86_400;
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function retryAfterSeconds(value: string | null, receivedAt: number): number | undefined {
  if (value === null || value.length > 64) return undefined;
  if (/^[0-9]+$/.test(value)) return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS);
  if (!HTTP_DATE.test(value) || !Number.isFinite(receivedAt)) return undefined;
  const timestamp = Date.parse(value);
  // Reject normalized invalid dates and mismatched weekdays, not just parseable prose.
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) return undefined;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, Math.ceil((timestamp - receivedAt) / 1000)));
}

function throwRetryHint(status: number, seconds: number | undefined, body: Buffer | null): void {
  if (seconds === undefined) return;
  if (body) {
    try {
      // A documented refusal remains terminal even when sent with a transient HTTP status.
      if (providerRefused({ error: JSON.parse(body.toString('utf8')) as unknown })) return;
    } catch {
      // A malformed error body cannot supply a refusal; the bounded HTTP hint remains usable.
    }
  }
  const error = gatewayError(
    status === 429 ? 'quota' : 'provider_unavailable',
    status,
    'after_delay',
  );
  throw new GatewayError({ ...error.detail, retryAfterSeconds: seconds }, error.status);
}

// Exact Interactions generation-block codes; never infer refusal from HTTP status or prose.
// https://ai.google.dev/gemini-api/docs/api-errors
const PROVIDER_BLOCK_CODES = new Set([
  'safety',
  'recitation',
  'language',
  'prohibited_content',
  'spii',
  'blocklist',
  'image_safety',
  'image_prohibited_content',
  'image_recitation',
  'image_other',
  'content_blocked',
]);

export type ProviderDiagnostic =
  | {
      stage: 'http_request';
      /** Observation before local admission; this event alone is not proof of dispatch. */
      operation: 'preflight' | 'generation';
      model: GeminiModel;
      route: 'count_tokens' | 'interactions';
      serializedBody: ReturnType<typeof describeSerializedBody>;
      input: ProviderInputShape | null;
    }
  | { stage: 'http_response'; operation: 'preflight' | 'generation'; httpStatus: number }
  | ({ stage: 'http_error_summary' } & ProviderErrorSummary)
  | ({ stage: 'http_error_metadata' } & ProviderErrorMetadata)
  | { stage: 'preflight_result'; countValid: boolean; countedInputTokens: number | null }
  | {
      stage: 'completion_result';
      completionStatus:
        | 'completed'
        | 'in_progress'
        | 'requires_action'
        | 'cancelled'
        | 'failed'
        | 'incomplete'
        | 'unknown';
      modelMatches: boolean;
      usagePresent: boolean;
      inputUsagePresent: boolean;
      outputUsagePresent: boolean;
      thoughtUsagePresent: boolean;
    }
  | { stage: 'usage_check'; valid: boolean }
  | ({ stage: 'text_fidelity_check' } & StructuredOutputTextInspection)
  | { stage: 'output_check'; textPresent: boolean; bytesValid: boolean }
  | { stage: 'json_check'; valid: boolean }
  | { stage: 'envelope_check'; valid: boolean };

export interface GeminiOptions {
  apiKey: string;
  model: GeminiModel;
  fetch?: typeof fetch;
  now?: () => number;
  /** Production launcher injects the process-owned guard. Omission explicitly leaves
   * an isolated diagnostic/test factory unpaced; it does not select a global budget. */
  physicalAdmission?: ProviderPhysicalAdmission;
  /** Optional local observer. Fixed enums/booleans and bounded numeric metadata, never wire text. */
  onDiagnostic?(event: ProviderDiagnostic): void;
}

async function boundedResponse(
  response: Response,
  signal: AbortSignal | null | undefined,
  onCancellation: (settlement: Promise<void>) => void,
  onErrorSummary?: (summary: ProviderErrorSummary) => void,
  onErrorMetadata?: (metadata: ProviderErrorMetadata) => void,
  retryHint?: number,
): Promise<Response> {
  const metadata =
    response.status >= 400 && onErrorMetadata
      ? createProviderErrorMetadata(response.headers.get('retry-after'), retryHint)
      : null;
  if (!response.body) {
    signal?.throwIfAborted();
    if (metadata) onErrorMetadata?.(metadata);
    throwRetryHint(response.status, retryHint, null);
    return response;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let finished = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    // Stop reader waiting promptly; the caller keeps the physical lease until cleanup settles.
    onCancellation(reader.cancel());
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) {
        finished = true;
        break;
      }
      bytes += item.value.byteLength;
      if (bytes > LIMITS.providerResponseBytes)
        throw gatewayError('invalid_model_result', 502, 'never');
      chunks.push(item.value.slice());
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
    if (!finished && metadata) {
      metadata.bodyState = signal?.aborted
        ? 'aborted'
        : bytes > LIMITS.providerResponseBytes
          ? 'response_limit'
          : 'read_failure';
      onErrorMetadata?.(metadata);
    }
  }
  const body = Buffer.concat(chunks);
  // Observe the buffer already read under the cap; do not consume/clone the stream again.
  if (metadata) {
    classifyProviderErrorMetadata(body, metadata, GEMINI_MODELS);
    onErrorMetadata?.(metadata);
  }
  if (response.status >= 400 && onErrorSummary)
    onErrorSummary(classifyProviderError(body.toString('utf8')));
  signal?.throwIfAborted();
  // SDK error types do not consistently retain headers. Preserve only the safe normalized hint.
  // This also prevents the fallback 250ms retry from ignoring an explicit upstream cooldown.
  throwRetryHint(response.status, retryHint, body);
  return new Response(body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
  });
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return typeof candidate.status === 'number'
    ? candidate.status
    : typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : undefined;
}

function boundaryError(error: unknown): GatewayError | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    if (current instanceof GatewayError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function providerRefused(error: unknown): boolean {
  function own(value: unknown, key: string): unknown {
    return value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, key)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  }
  // SDK 2.24.0's Interactions APIError stores the complete wire envelope in .error.
  // Its exported ApiError is a different class; neither its message nor body is an oracle.
  const code = own(own(own(error, 'error'), 'error'), 'code');
  return typeof code === 'string' && PROVIDER_BLOCK_CODES.has(code);
}

export function mapProviderError(error: unknown, signal: AbortSignal): GatewayError {
  if (signal.aborted)
    return signal.reason instanceof GatewayError
      ? signal.reason
      : gatewayError('cancelled', 499, 'never');
  const boundary = boundaryError(error);
  if (boundary) return boundary;
  if (providerRefused(error)) return gatewayError('provider_refused', 422, 'after_correction');
  const status = statusOf(error);
  if (status === 429) return gatewayError('quota', 429, 'after_delay');
  if (status === 400 || status === 404) return gatewayError('invalid_model_result', 502, 'never');
  if (status === 401 || status === 403)
    return gatewayError('provider_unavailable', 503, 'after_correction');
  return gatewayError('provider_unavailable', 503, 'after_delay');
}

export function createGeminiProvider(options: GeminiOptions): ModelProvider {
  if (!options.apiKey || !GEMINI_MODELS.includes(options.model))
    throw gatewayError('provider_unavailable', 503, 'after_correction');
  const now = options.now ?? Date.now;
  const transport = options.fetch ?? fetch;
  // Numeric snapshots follow each SDK call even when two turns interleave.
  const requestContext = options.onDiagnostic
    ? new AsyncLocalStorage<ProviderInputShape | null>()
    : null;
  const diagnose = (event: ProviderDiagnostic) => {
    try {
      options.onDiagnostic?.(event);
    } catch {
      // Diagnostic consumers cannot change provider execution or expose their own exceptions.
    }
  };
  let outstandingRequests = 0;
  const sdkFetch: SdkFetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (
      url.origin !== 'https://generativelanguage.googleapis.com' ||
      url.search ||
      !/^\/v1beta\/(?:interactions|models\/gemini-(?:3\.5-flash-lite|3\.8-flash):countTokens)$/.test(
        url.pathname,
      )
    )
      throw gatewayError('untrusted_endpoint', 503, 'never');
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    if (outstandingRequests >= LIMITS.concurrentTurns)
      throw gatewayError('busy', 503, 'after_delay');
    outstandingRequests++;
    let cancellation: Promise<void> | undefined;
    let dispatched = false;
    try {
      if (options.onDiagnostic) {
        const serializedBody = await describeSdkRequestBody(input, init?.body, signal);
        signal?.throwIfAborted();
        const inputShape = requestContext?.getStore();
        const preflight = url.pathname.endsWith(':countTokens');
        diagnose({
          stage: 'http_request',
          operation: preflight ? 'preflight' : 'generation',
          model: options.model,
          route: preflight ? 'count_tokens' : 'interactions',
          serializedBody,
          input: inputShape ? { ...inputShape, counts: { ...inputShape.counts } } : null,
        });
      }
      const transportInit: RequestInit = { ...init, redirect: 'error' };
      signal?.throwIfAborted();
      options.physicalAdmission?.admit(signal);
      dispatched = true;
      // The physical request keeps its lease even after caller waiting is cancelled.
      const response = await transport(input as string | URL | Request, transportInit);
      const retryHint = [429, 503].includes(response.status)
        ? retryAfterSeconds(response.headers.get('retry-after'), now())
        : undefined;
      if (response.status === 429) options.physicalAdmission?.recordQuota(retryHint);
      diagnose({
        stage: 'http_response',
        operation: url.pathname.endsWith(':countTokens') ? 'preflight' : 'generation',
        httpStatus: response.status,
      });
      return await boundedResponse(
        response,
        signal,
        (settlement) => {
          cancellation = settlement.catch(() => {});
        },
        options.onDiagnostic
          ? (summary) => diagnose({ stage: 'http_error_summary', ...summary })
          : undefined,
        options.onDiagnostic
          ? (metadata) => diagnose({ stage: 'http_error_metadata', ...metadata })
          : undefined,
        retryHint,
      );
    } finally {
      // No transport was dispatched. Do not retain a physical lease while cancellation
      // waits for the SDK's separate, inaccessible retained-request tee branch.
      if (!dispatched && input instanceof Request && input.body && !input.bodyUsed)
        void input.body.cancel().catch(() => {});
      // A reader error may return before an abort-ignoring underlying cancel finishes.
      if (cancellation)
        void cancellation.then(() => {
          outstandingRequests--;
        });
      else outstandingRequests--;
    }
  };
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    vertexai: false,
    apiVersion: 'v1beta',
    httpOptions: { fetch: sdkFetch, retryOptions: { attempts: 1 }, timeout: LIMITS.deadlineMs },
  });
  function remaining(execution: ProviderExecution) {
    execution.signal.throwIfAborted();
    const milliseconds = execution.deadline - now();
    if (milliseconds <= 0) throw gatewayError('deadline', 504, 'after_delay');
    return milliseconds;
  }
  return {
    async complete(input, execution) {
      const prompt = JSON.stringify(input);
      const promptBytes = Buffer.byteLength(prompt, 'utf8');
      if (promptBytes > MAX_ASSISTANT_BODY_BYTES) throw contextBudgetError('byte_limit');
      const inputShape = requestContext ? describeProviderInput(input, promptBytes) : null;
      const observedRequest = <Value>(request: () => Promise<Value>) =>
        requestContext ? requestContext.run(inputShape, request) : request();
      // Developer API countTokens does not support systemInstruction or generationConfig.
      // Count the exact schema-bearing system instruction once and the exact input once.
      // There is no separate API schema or third schema-text part in this candidate.
      // Text framing differs from Interactions: this remains an estimate, not an upper bound.
      const framingReserve = 256;
      execution.budget.spendPreflight();
      try {
        const counted = await abortable(
          observedRequest(() =>
            client.models.countTokens({
              model: options.model,
              contents: [
                {
                  role: 'user',
                  parts: [{ text: SYSTEM_INSTRUCTION }, { text: prompt }],
                },
              ],
              config: {
                abortSignal: execution.signal,
                httpOptions: { timeout: remaining(execution), retryOptions: { attempts: 1 } },
              },
            }),
          ),
          execution.signal,
        );
        const countValid =
          Number.isSafeInteger(counted.totalTokens) && (counted.totalTokens ?? -1) >= 0;
        diagnose({
          stage: 'preflight_result',
          countValid,
          countedInputTokens: countValid ? counted.totalTokens! : null,
        });
        if (!countValid) throw gatewayError('invalid_model_result', 502, 'never');
        if ((counted.totalTokens ?? 0) + framingReserve > LIMITS.inputTokens)
          throw contextBudgetError('token_limit');
      } catch (error) {
        throw mapProviderError(error, execution.signal);
      }

      while (true) {
        execution.budget.spendGeneration();
        try {
          const result = await abortable(
            observedRequest(() =>
              client.interactions.create(
                {
                  model: options.model,
                  api_version: 'v1beta',
                  input: prompt,
                  system_instruction: SYSTEM_INSTRUCTION,
                  store: false,
                  stream: false,
                  generation_config: { max_output_tokens: LIMITS.outputTokens },
                  response_format: {
                    type: 'text',
                    mime_type: 'application/json',
                  },
                },
                {
                  signal: execution.signal,
                  timeout_ms: remaining(execution),
                  retries: { strategy: 'none' },
                  maxRetries: 0,
                },
              ),
            ),
            execution.signal,
          );
          const completionStatus = [
            'completed',
            'in_progress',
            'requires_action',
            'cancelled',
            'failed',
            'incomplete',
          ].includes(result.status)
            ? (result.status as Extract<
                ProviderDiagnostic,
                { stage: 'completion_result' }
              >['completionStatus'])
            : 'unknown';
          diagnose({
            stage: 'completion_result',
            completionStatus,
            modelMatches: result.model === options.model,
            usagePresent: result.usage !== undefined && result.usage !== null,
            inputUsagePresent: result.usage?.total_input_tokens !== undefined,
            outputUsagePresent: result.usage?.total_output_tokens !== undefined,
            thoughtUsagePresent: result.usage?.total_thought_tokens !== undefined,
          });
          if (result.model !== options.model || result.status !== 'completed')
            throw gatewayError('invalid_model_result', 502, 'never');
          const inputTokens = result.usage?.total_input_tokens;
          const outputTokens = result.usage?.total_output_tokens;
          // Omission is unknown usage, not evidence that thinking consumed zero tokens.
          const thoughtTokens = result.usage?.total_thought_tokens;
          const usageValid =
            [inputTokens, outputTokens, thoughtTokens].every(
              (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
            ) &&
            (inputTokens ?? Infinity) <= LIMITS.inputTokens &&
            (outputTokens ?? Infinity) + (thoughtTokens ?? Infinity) <= LIMITS.outputTokens;
          diagnose({ stage: 'usage_check', valid: usageValid });
          if (!usageValid) throw gatewayError('invalid_model_result', 502, 'never');
          const textInspection = inspectStructuredOutputText(result);
          diagnose({ stage: 'text_fidelity_check', ...textInspection });
          if (!textInspection.valid) throw gatewayError('invalid_model_result', 502, 'never');
          const output = result.output_text;
          diagnose({
            stage: 'output_check',
            textPresent: typeof output === 'string',
            bytesValid:
              typeof output === 'string' &&
              Buffer.byteLength(output, 'utf8') <= LIMITS.providerResponseBytes,
          });
          if (
            typeof output !== 'string' ||
            Buffer.byteLength(output, 'utf8') > LIMITS.providerResponseBytes
          )
            throw gatewayError('invalid_model_result', 502, 'never');
          let value: unknown;
          try {
            value = JSON.parse(output);
            diagnose({ stage: 'json_check', valid: true });
          } catch {
            diagnose({ stage: 'json_check', valid: false });
            throw gatewayError('invalid_model_result', 502, 'never');
          }
          const envelopeValid = isProviderEnvelope(value);
          diagnose({ stage: 'envelope_check', valid: envelopeValid });
          if (!isProviderEnvelope(value)) throw gatewayError('invalid_model_result', 502, 'never');
          return {
            // All full step/response/memory/provenance validators still run downstream.
            value: value.step,
            usage: {
              inputTokens: inputTokens as number,
              outputTokens: outputTokens as number,
              thoughtTokens: thoughtTokens as number,
            },
          };
        } catch (error) {
          const mapped = mapProviderError(error, execution.signal);
          // A documented block is terminal even if its envelope arrives with a transient status.
          if (mapped.detail.code === 'provider_refused') throw mapped;
          const status = statusOf(error);
          // Retry only explicit transient upstream HTTP errors; never quota/auth/invalid output.
          if (
            !boundaryError(error) &&
            !execution.signal.aborted &&
            execution.budget.retries === 0 &&
            status !== undefined &&
            [500, 502, 503, 504].includes(status)
          ) {
            execution.budget.spendRetry();
            if (remaining(execution) <= 250) throw gatewayError('deadline', 504, 'after_delay');
            await delay(250, undefined, { signal: execution.signal }).catch(() => {
              throw mapProviderError(error, execution.signal);
            });
            continue;
          }
          throw mapped;
        }
      }
    },
  };
}
