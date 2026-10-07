import { GoogleGenAI } from '@google/genai';
import type { HttpOptions } from '@google/genai';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_ASSISTANT_BODY_BYTES } from '@cookmate/contracts';
import type { ModelProvider, ProviderExecution } from './provider-contract';
import { SYSTEM_INSTRUCTION } from './provider-contract';
import { PROVIDER_ENVELOPE_SCHEMA, isProviderEnvelope } from './provider-schema';
import { inspectStructuredOutputText } from './provider-text';
import type { StructuredOutputTextInspection } from './provider-text';
import { contextBudgetError, gatewayError, GatewayError } from './errors';
import { LIMITS } from './limits';
import { abortable } from './admission';
import { classifyProviderError } from './provider-diagnostics';
import type { ProviderErrorSummary } from './provider-diagnostics';

export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'] as const;
export type GeminiModel = (typeof GEMINI_MODELS)[number];
type SdkFetch = NonNullable<HttpOptions['fetch']>;

export type ProviderDiagnostic =
  | { stage: 'http_response'; operation: 'preflight' | 'generation'; httpStatus: number }
  | ({ stage: 'http_error_summary' } & ProviderErrorSummary)
  | { stage: 'preflight_result'; countValid: boolean }
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
  /** Optional local harness observer. Only fixed enums/booleans/status codes; never wire content. */
  onDiagnostic?(event: ProviderDiagnostic): void;
}

async function boundedResponse(
  response: Response,
  onErrorSummary?: (summary: ProviderErrorSummary) => void,
): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > LIMITS.providerResponseBytes) {
        await reader.cancel();
        throw gatewayError('invalid_model_result', 502, 'never');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  // Observe the buffer already read under the cap; do not consume/clone the stream again.
  if (response.status >= 400 && onErrorSummary)
    onErrorSummary(classifyProviderError(body.toString('utf8')));
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

export function mapProviderError(error: unknown, signal: AbortSignal): GatewayError {
  if (signal.aborted)
    return signal.reason instanceof GatewayError
      ? signal.reason
      : gatewayError('cancelled', 499, 'never');
  const boundary = boundaryError(error);
  if (boundary) return boundary;
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
    init?.signal?.throwIfAborted();
    if (outstandingRequests >= LIMITS.concurrentTurns)
      throw gatewayError('busy', 503, 'after_delay');
    outstandingRequests++;
    try {
      // The physical request keeps its lease even after caller waiting is cancelled.
      const response = await transport(input as string | URL | Request, {
        ...init,
        redirect: 'error',
      });
      diagnose({
        stage: 'http_response',
        operation: url.pathname.endsWith(':countTokens') ? 'preflight' : 'generation',
        httpStatus: response.status,
      });
      return await boundedResponse(
        response,
        options.onDiagnostic
          ? (summary) => diagnose({ stage: 'http_error_summary', ...summary })
          : undefined,
      );
    } finally {
      outstandingRequests--;
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
      if (Buffer.byteLength(prompt, 'utf8') > MAX_ASSISTANT_BODY_BYTES)
        throw contextBudgetError('byte_limit');
      // Developer API countTokens does not support systemInstruction or generationConfig.
      // Count system, input and output-schema text in the same preflight. Treating every
      // schema byte as a token would consume most of admission after the memory amendment.
      // Text framing differs from Interactions: this remains an estimate, not an upper bound.
      const schemaText = JSON.stringify(PROVIDER_ENVELOPE_SCHEMA);
      const framingReserve = 256;
      execution.budget.spendPreflight();
      try {
        const counted = await abortable(
          client.models.countTokens({
            model: options.model,
            contents: [
              {
                role: 'user',
                parts: [{ text: SYSTEM_INSTRUCTION }, { text: prompt }, { text: schemaText }],
              },
            ],
            config: {
              abortSignal: execution.signal,
              httpOptions: { timeout: remaining(execution), retryOptions: { attempts: 1 } },
            },
          }),
          execution.signal,
        );
        const countValid =
          Number.isSafeInteger(counted.totalTokens) && (counted.totalTokens ?? -1) >= 0;
        diagnose({ stage: 'preflight_result', countValid });
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
                  schema: PROVIDER_ENVELOPE_SCHEMA,
                },
              },
              {
                signal: execution.signal,
                timeout_ms: remaining(execution),
                retries: { strategy: 'none' },
                maxRetries: 0,
              },
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
          const thoughtTokens = result.usage?.total_thought_tokens ?? 0;
          const usageValid =
            [inputTokens, outputTokens, thoughtTokens].every(
              (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
            ) &&
            (inputTokens ?? Infinity) <= LIMITS.inputTokens &&
            (outputTokens ?? Infinity) + thoughtTokens <= LIMITS.outputTokens;
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
              thoughtTokens,
            },
          };
        } catch (error) {
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
          throw mapProviderError(error, execution.signal);
        }
      }
    },
  };
}
