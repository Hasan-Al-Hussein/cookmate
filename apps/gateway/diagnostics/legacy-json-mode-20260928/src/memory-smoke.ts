import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogue } from '@cookmate/catalogue';
import { Ajv } from 'ajv';
import {
  API_VERSION,
  assistantJsonByteLength,
  checkMemoryResponseForRequest,
} from '@cookmate/contracts';
import type { AssistantTurnRequest } from '@cookmate/contracts';
import { createGeminiProvider, GEMINI_MODELS } from './gemini';
import type { GeminiModel, ProviderDiagnostic } from './gemini';
import { GatewayError, gatewayError } from './errors';
import { createOrchestrator } from './orchestrator';
import type { ProviderBudget, ProviderUsage } from './provider-contract';
import { LIMITS } from './limits';
import { PROVIDER_GRAMMAR_SCHEMA } from './provider-schema';

// Preparation-only harness check of our static schema; production acceptance remains unchanged.
const validateProviderShape = new Ajv({ strict: false }).compile(PROVIDER_GRAMMAR_SCHEMA);

export const SMOKE_TEXT =
  'For this fictional dinner only, avoid peanuts. This is temporary conversation context, not a saved preference. Please acknowledge this one constraint without proposing an action.';
export const SMOKE_BOUNDS = Object.freeze({
  logicalTurns: 2,
  preflightsPerTurn: 1,
  generationsPerTurn: 1,
  retries: 0,
  networkRequests: 4,
  deadlineMsPerTurn: LIMITS.deadlineMs,
  inputAdmissionPerGeneration: LIMITS.inputTokens,
  outputAndThoughtPerGeneration: LIMITS.outputTokens,
});

export function smokeRequest(): AssistantTurnRequest {
  const messageId = randomUUID();
  const date = { localDate: '2026-09-28', timeZone: 'Asia/Dubai', utcOffsetMinutes: 240 };
  return {
    apiVersion: API_VERSION,
    catalogue: { ...catalogue.identity },
    requestId: randomUUID(),
    userIntentId: randomUUID(),
    intentRevision: 0,
    conversationId: randomUUID(),
    conversationGeneration: 0,
    connectionGeneration: 0,
    message: {
      messageId,
      text: SMOKE_TEXT,
      sourceSequence: 1,
      sourceDateContext: date,
      preferenceRevisionAtSource: 0,
      preferenceLinks: [],
    },
    context: {
      history: [],
      referenceSets: [],
      preferences: { revision: 0, lastRemovalRevision: null, items: [] },
      planOccurrences: [],
      date,
      memory: {
        projectionRevision: 0,
        baseContextRevision: 0,
        items: [],
        pendingSources: [],
        reviewTargetMessageIds: [messageId],
        workingContext: { afterSequence: null, carryMemoryIds: [] },
        coverage: {
          retainedEntryCount: 0,
          suppliedEntryCount: 0,
          omittedEntryCount: 0,
          pendingUserSourceCount: 1,
          pendingWorkingSourceCount: 1,
          suppliedReviewTargetCount: 1,
          selectionStatus: 'within_budget',
        },
      },
    },
    capabilities: [],
  };
}

function smokeBudget(): ProviderBudget {
  let generations = 0,
    preflights = 0;
  return {
    spendGeneration() {
      if (generations >= 1) throw gatewayError('too_large', 422, 'never');
      generations++;
    },
    spendPreflight() {
      if (preflights >= 1) throw gatewayError('too_large', 422, 'never');
      preflights++;
    },
    spendRetry() {
      throw gatewayError('provider_unavailable', 503, 'never');
    },
    get generations() {
      return generations;
    },
    get preflights() {
      return preflights;
    },
    get retries() {
      return 0;
    },
  };
}

interface SmokeCase {
  model: GeminiModel;
  disposition: 'PASS' | 'FAIL' | 'NOT_RUN';
  code: string;
  requestId: string;
  sourceMessageId: string;
  elapsedMs: number;
  networkRequests: number;
  generations: number;
  preflights: number;
  usage: ProviderUsage | null;
  responseKind: string | null;
  responseBytes: number | null;
  exactQuote: boolean;
  exactReview: boolean;
  diagnostics: ProviderDiagnostic[];
  providerSchemaValid: boolean | null;
  normalizationValid: boolean | null;
}

/** No live calls on import. Tests inject fetch; CLI execution requires a separate explicit flag. */
export async function runMemorySmoke(options: {
  apiKey: string;
  models: readonly GeminiModel[];
  fetch?: typeof fetch;
  /** Synthetic preparation harness only; receives a detached bounded model JSON value.
   * Normal smoke reports never retain it. The caller owns safe diagnostic serialization. */
  observeModelOutput?(value: unknown): void;
}) {
  if (
    !options.apiKey ||
    options.models.length < 1 ||
    options.models.length > 2 ||
    new Set(options.models).size !== options.models.length ||
    options.models.some((model) => !GEMINI_MODELS.includes(model))
  )
    throw gatewayError('invalid_input', 400, 'never');
  const cases: SmokeCase[] = [];
  let networkRequests = 0;
  let stopped = false;
  for (const model of options.models) {
    const request = smokeRequest();
    const started = Date.now();
    const budget = smokeBudget();
    const result: SmokeCase = {
      model,
      disposition: 'NOT_RUN',
      code: 'stopped_after_failure',
      requestId: request.requestId,
      sourceMessageId: request.message.messageId,
      elapsedMs: 0,
      networkRequests: 0,
      generations: 0,
      preflights: 0,
      usage: null,
      responseKind: null,
      responseBytes: null,
      exactQuote: false,
      exactReview: false,
      diagnostics: [],
      providerSchemaValid: null,
      normalizationValid: null,
    };
    cases.push(result);
    if (stopped) continue;
    const provider = createGeminiProvider({
      apiKey: options.apiKey,
      model,
      onDiagnostic: (event) => {
        if (result.diagnostics.length < 16) result.diagnostics.push({ ...event });
      },
      fetch: async (input, init) => {
        if (networkRequests >= SMOKE_BOUNDS.networkRequests || result.networkRequests >= 2)
          throw gatewayError('too_large', 422, 'never');
        networkRequests++;
        result.networkRequests++;
        return (options.fetch ?? fetch)(input, init);
      },
    });
    let finalModelStep = false;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(gatewayError('deadline', 504, 'never')),
      LIMITS.deadlineMs,
    );
    try {
      const run = createOrchestrator({
        async complete(input, execution) {
          const output = await provider.complete(input, { ...execution, budget });
          try {
            options.observeModelOutput?.(structuredClone(output.value));
          } catch {
            // Optional diagnostic observation cannot change validation or leak its exception.
          }
          result.usage = output.usage;
          result.providerSchemaValid = validateProviderShape(output.value);
          finalModelStep =
            output.value !== null &&
            typeof output.value === 'object' &&
            (output.value as { kind?: unknown }).kind === 'respond';
          return output;
        },
      });
      const response = await run(request, {
        signal: controller.signal,
        deadline: started + LIMITS.deadlineMs,
      });
      result.normalizationValid = finalModelStep ? true : null;
      result.responseKind = response.kind;
      result.responseBytes = assistantJsonByteLength(response);
      if (response.kind !== 'error') {
        result.exactQuote =
          response.memoryUpdate.entries.length === 1 &&
          response.memoryUpdate.entries[0]!.sourceMessageId === request.message.messageId &&
          response.memoryUpdate.entries[0]!.quote === SMOKE_TEXT;
        result.exactReview =
          response.memoryUpdate.reviews.length === 1 &&
          response.memoryUpdate.reviews[0]!.sourceMessageId === request.message.messageId &&
          response.memoryUpdate.reviews[0]!.disposition === 'retain';
      }
      const passed =
        finalModelStep &&
        budget.generations === 1 &&
        result.networkRequests === 2 &&
        response.kind === 'answer' &&
        result.exactQuote &&
        result.exactReview &&
        checkMemoryResponseForRequest(response, request).ok;
      result.disposition = passed ? 'PASS' : 'FAIL';
      result.code = passed ? 'structured_memory_compatible' : 'unexpected_structured_result';
    } catch (error) {
      if (finalModelStep) result.normalizationValid = false;
      result.disposition = 'FAIL';
      result.code = error instanceof GatewayError ? error.detail.code : 'unclassified_failure';
    } finally {
      clearTimeout(timeout);
      result.elapsedMs = Date.now() - started;
      result.generations = budget.generations;
      result.preflights = budget.preflights;
    }
    if (result.disposition !== 'PASS') stopped = true;
  }
  return {
    kind: 'cookmate-memory-v2-smoke',
    apiVersion: API_VERSION,
    createdAt: new Date().toISOString(),
    syntheticText: SMOKE_TEXT,
    catalogue: { ...catalogue.identity },
    bounds: SMOKE_BOUNDS,
    estimateCaveat:
      'Admission and reported-usage checks are not a proven incurred-token or billing upper bound. Missing usage is unknown, never zero.',
    networkRequests,
    cases,
  };
}

async function main() {
  const args = process.argv.slice(2);
  // Deliberately no default execution or provider selection.
  if (
    args.length !== 5 ||
    args[0] !== '--execute' ||
    args[1] !== '--models' ||
    args[3] !== '--output'
  )
    throw gatewayError('invalid_input', 400, 'never');
  const models = args[2]!.split(',');
  if (models.some((model) => !GEMINI_MODELS.includes(model as GeminiModel)))
    throw gatewayError('invalid_input', 400, 'never');
  // Reserve the output before any provider call so invalid paths cannot lose paid evidence.
  const evidence = await open(resolve(args[4]!), 'wx');
  let report;
  try {
    report = await runMemorySmoke({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      models: models as GeminiModel[],
    });
    await evidence.writeFile(JSON.stringify(report, null, 2) + '\n', 'utf8');
  } finally {
    await evidence.close();
  }
  process.stdout.write(
    JSON.stringify({
      networkRequests: report.networkRequests,
      cases: report.cases.map(({ model, disposition, code }) => ({ model, disposition, code })),
    }) + '\n',
  );
  if (report.cases.some((item) => item.disposition !== 'PASS')) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.stderr.write(
      'Smoke preparation/execution failed; inspect the sanitized evidence if written. No diagnostic body was logged.\n',
    );
    process.exitCode = 1;
  });
}
