import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Ajv } from 'ajv';
import { API_VERSION } from '@cookmate/contracts';
import { createGeminiProvider, GEMINI_MODELS } from './gemini';
import type { GeminiModel, ProviderDiagnostic } from './gemini';
import { GatewayError, gatewayError } from './errors';
import { LIMITS } from './limits';
import { smokeRequest, SMOKE_TEXT } from './memory-smoke';
import { createOrchestrator } from './orchestrator';
import type { ProviderBudget, ProviderUsage } from './provider-contract';
import { PROVIDER_RESPONSE_SCHEMA, PROVIDER_ENVELOPE_SCHEMA } from './provider-schema';

// This counterfactual is confined to this harness's serialized generation transport.
// Production requests, preflight schema text and all app validators stay unchanged.
export const T03_CONTROL_SCHEMA = {
  type: 'object',
  properties: { recipe_id: { type: 'string' }, servings_known: { type: 'boolean' } },
  required: ['recipe_id', 'servings_known'],
  additionalProperties: false,
} as const;
const validator = new Ajv({ strict: false });
const fullShape = validator.compile(PROVIDER_RESPONSE_SCHEMA);
const tinyShape = validator.compile(T03_CONTROL_SCHEMA);
export const SCHEMA_CONTROL_BOUNDS = Object.freeze({
  arms: 2,
  preflightsPerArm: 1,
  generationsPerArm: 1,
  networkRequests: 4,
  retries: 0,
  deadlineMsPerArm: LIMITS.deadlineMs,
  inputAdmissionPerGeneration: LIMITS.inputTokens,
  outputAndThoughtPerGeneration: LIMITS.outputTokens,
});

type Operation = 'preflight' | 'generation';
type ArmName = 'original_schema' | 'tiny_schema_control';
interface ArmResult {
  arm: ArmName;
  execution: 'NOT_RUN' | 'FINISHED';
  code: string;
  elapsedMs: number;
  networkRequests: number;
  preflights: number;
  generations: number;
  diagnostics: ProviderDiagnostic[];
  usage: ProviderUsage | null;
  providerSchemaValid: boolean | null;
  tinySchemaValid: boolean | null;
  normalizationValid: boolean | null;
  responseKind: string | null;
}
interface CapturedRequest {
  url: string;
  method: string;
  body: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function singleArmBudget(): ProviderBudget {
  let generations = 0;
  let preflights = 0;
  return {
    spendPreflight() {
      if (preflights >= 1) throw gatewayError('too_large', 422, 'never');
      preflights++;
    },
    spendGeneration() {
      if (generations >= 1) throw gatewayError('too_large', 422, 'never');
      generations++;
    },
    spendRetry() {
      throw gatewayError('provider_unavailable', 503, 'never');
    },
    get preflights() {
      return preflights;
    },
    get generations() {
      return generations;
    },
    get retries() {
      return 0;
    },
  };
}

function eligibleForControl(arm: ArmResult): boolean {
  const http = arm.diagnostics.filter((event) => event.stage === 'http_response');
  const summary = arm.diagnostics.find((event) => event.stage === 'http_error_summary');
  return (
    arm.code === 'invalid_model_result' &&
    arm.networkRequests === 2 &&
    arm.preflights === 1 &&
    arm.generations === 1 &&
    http.length === 2 &&
    http[0]?.operation === 'preflight' &&
    http[0].httpStatus === 200 &&
    http[1]?.operation === 'generation' &&
    http[1].httpStatus === 400 &&
    arm.diagnostics.some((event) => event.stage === 'preflight_result' && event.countValid) &&
    summary?.stage === 'http_error_summary' &&
    ['invalid_request', 'unknown'].includes(summary.interactionCode) &&
    ['INVALID_ARGUMENT', 'UNKNOWN', 'unknown'].includes(summary.rpcStatus) &&
    !arm.diagnostics.some((event) => event.stage === 'completion_result')
  );
}

/** No calls on import. One frozen fictional request, at most two explicit diagnostic arms. */
export async function runSchemaControl(options: {
  apiKey: string;
  model: GeminiModel;
  fetch?: typeof fetch;
}) {
  if (!options.apiKey || !GEMINI_MODELS.includes(options.model))
    throw gatewayError('invalid_input', 400, 'never');
  const request = smokeRequest();
  const frozenRequest = JSON.stringify(request);
  const captured: Partial<Record<Operation, CapturedRequest>> = {};
  const requestHashes: Partial<Record<ArmName, Partial<Record<Operation, string>>>> = {};
  const comparison = {
    preflightBodyIdentical: null as boolean | null,
    generationBodyIdenticalBeforeMutation: null as boolean | null,
    onlySchemaChanged: null as boolean | null,
    sameEndpointAndMethod: null as boolean | null,
  };
  let networkRequests = 0;
  const arms: ArmResult[] = [];
  for (const arm of ['original_schema', 'tiny_schema_control'] as const) {
    const result: ArmResult = {
      arm,
      execution: 'NOT_RUN',
      code: 'original_not_eligible_for_control',
      elapsedMs: 0,
      networkRequests: 0,
      preflights: 0,
      generations: 0,
      diagnostics: [],
      usage: null,
      providerSchemaValid: null,
      tinySchemaValid: null,
      normalizationValid: null,
      responseKind: null,
    };
    arms.push(result);
    if (arm === 'tiny_schema_control' && !eligibleForControl(arms[0]!)) continue;
    const started = Date.now();
    const budget = singleArmBudget();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(gatewayError('deadline', 504, 'never')),
      LIMITS.deadlineMs,
    );
    let finalModelStep = false;
    let invariantFailed = false;
    requestHashes[arm] = {};
    const provider = createGeminiProvider({
      apiKey: options.apiKey,
      model: options.model,
      onDiagnostic(event) {
        if (result.diagnostics.length < 16) result.diagnostics.push({ ...event });
      },
      fetch: async (input, init) => {
        controller.signal.throwIfAborted();
        const url = input instanceof Request ? input.url : String(input);
        const operation: Operation = url.endsWith(':countTokens') ? 'preflight' : 'generation';
        const body =
          typeof init?.body === 'string'
            ? init.body
            : input instanceof Request && init?.body == null
              ? await input.clone().text()
              : null;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const invariant = (valid: boolean) => {
          if (!valid) {
            invariantFailed = true;
            throw gatewayError('invalid_model_result', 502, 'never');
          }
        };
        invariant(body !== null);
        let outgoing = body!;
        if (arm === 'original_schema') {
          invariant(captured[operation] === undefined);
          captured[operation] = { url, method, body: outgoing };
        } else {
          const original = captured[operation];
          const sameEndpoint = original?.url === url && original.method === method;
          comparison.sameEndpointAndMethod =
            comparison.sameEndpointAndMethod === false ? false : sameEndpoint;
          invariant(sameEndpoint);
          const sameBody = original?.body === outgoing;
          if (operation === 'preflight') comparison.preflightBodyIdentical = sameBody;
          else comparison.generationBodyIdenticalBeforeMutation = sameBody;
          invariant(sameBody);
          if (operation === 'generation') {
            const parsed = JSON.parse(outgoing);
            invariant(isDeepStrictEqual(parsed.response_format?.schema, PROVIDER_ENVELOPE_SCHEMA));
            // Require exact serialization before mutation; restore-and-compare proves that
            // replacing this one subtree did not alter any other serialized field or byte.
            invariant(JSON.stringify(parsed) === outgoing);
            const originalSchema = parsed.response_format.schema;
            parsed.response_format.schema = T03_CONTROL_SCHEMA;
            const controlBody = JSON.stringify(parsed);
            const restored = JSON.parse(controlBody);
            restored.response_format.schema = originalSchema;
            comparison.onlySchemaChanged =
              JSON.stringify(restored) === outgoing && controlBody !== outgoing;
            invariant(comparison.onlySchemaChanged);
            outgoing = controlBody;
          }
        }
        if (networkRequests >= 4 || result.networkRequests >= 2)
          throw gatewayError('too_large', 422, 'never');
        controller.signal.throwIfAborted();
        requestHashes[arm]![operation] = digest(outgoing);
        networkRequests++;
        result.networkRequests++;
        return (options.fetch ?? fetch)(input, { ...init, body: outgoing });
      },
    });
    try {
      const run = createOrchestrator({
        async complete(input, execution) {
          const output = await provider.complete(input, { ...execution, budget });
          result.usage = output.usage;
          result.providerSchemaValid = fullShape(output.value);
          result.tinySchemaValid = tinyShape(output.value);
          finalModelStep =
            output.value !== null &&
            typeof output.value === 'object' &&
            (output.value as { kind?: unknown }).kind === 'respond';
          return output;
        },
      });
      const response = await run(JSON.parse(frozenRequest), {
        signal: controller.signal,
        deadline: started + LIMITS.deadlineMs,
      });
      result.normalizationValid = finalModelStep ? true : null;
      result.responseKind = response.kind;
      result.code = 'application_response_returned';
    } catch (error) {
      if (finalModelStep) result.normalizationValid = false;
      result.code = invariantFailed
        ? 'comparison_invariant_failed'
        : error instanceof GatewayError
          ? error.detail.code
          : 'unclassified_failure';
    } finally {
      clearTimeout(timeout);
      result.execution = 'FINISHED';
      result.elapsedMs = Date.now() - started;
      result.preflights = budget.preflights;
      result.generations = budget.generations;
    }
  }
  const control = arms[1]!;
  const controlCompleted = control.diagnostics.some(
    (event) =>
      event.stage === 'completion_result' &&
      event.completionStatus === 'completed' &&
      event.modelMatches,
  );
  const controlHttp = control.diagnostics.find(
    (event) => event.stage === 'http_response' && event.operation === 'generation',
  );
  return {
    kind: 'cookmate-memory-v2-schema-control',
    apiVersion: API_VERSION,
    createdAt: new Date().toISOString(),
    model: options.model,
    syntheticText: SMOKE_TEXT,
    requestId: request.requestId,
    sourceMessageId: request.message.messageId,
    requestSha256: digest(frozenRequest),
    bounds: SCHEMA_CONTROL_BOUNDS,
    networkRequests,
    requestHashes,
    comparison,
    arms,
    conclusion:
      control.execution === 'NOT_RUN'
        ? 'control_not_run'
        : controlHttp?.stage === 'http_response' &&
            controlHttp.httpStatus === 200 &&
            controlCompleted &&
            comparison.onlySchemaChanged === true
          ? 'original_schema_implicated'
          : eligibleForControl(control) &&
              Object.values(comparison).every((value) => value === true)
            ? 'schema_only_hypothesis_weakened'
            : 'inconclusive',
    productSuccess: false,
    caveat:
      'Diagnostic counterfactual only. An accepted tiny schema is not a valid CookMate result or model quality proof. Admission and reported usage do not establish incurred-token or billing upper bounds; null usage is unknown.',
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 5 ||
    args[0] !== '--execute' ||
    args[1] !== '--model' ||
    args[3] !== '--output' ||
    !GEMINI_MODELS.includes(args[2] as GeminiModel)
  )
    throw gatewayError('invalid_input', 400, 'never');
  const evidence = await open(resolve(args[4]!), 'wx');
  let report;
  try {
    report = await runSchemaControl({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: args[2] as GeminiModel,
    });
    await evidence.writeFile(JSON.stringify(report, null, 2) + '\n', 'utf8');
  } finally {
    await evidence.close();
  }
  process.stdout.write(
    JSON.stringify({
      networkRequests: report.networkRequests,
      conclusion: report.conclusion,
      productSuccess: false,
    }) + '\n',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.stderr.write(
      'Schema control failed; inspect sanitized evidence if written. No provider prose was logged.\n',
    );
    process.exitCode = 1;
  });
}
