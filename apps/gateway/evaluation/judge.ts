import assert from 'node:assert/strict';
import type { AssistantTurnRequest, AssistantTurnResponse } from '@cookmate/contracts';
import { createGeminiProvider } from '../src/gemini';
import type { GeminiModel, ProviderDiagnostic } from '../src/gemini';
import { createOrchestrator } from '../src/orchestrator';
import { GatewayError, gatewayError } from '../src/errors';
import type { ModelProvider, ProviderInput, ProviderUsage } from '../src/provider-contract';
import { SYSTEM_INSTRUCTION } from '../src/provider-contract';
import { LIMITS } from '../src/limits';
import { isModelStep } from '../src/model-validation';
import {
  observeSyntheticResponse,
  sanitizeSyntheticStructuredCopy,
  CaptureObservationError,
} from './capture';
import type { SyntheticResponseCapture, SyntheticStructuredCapture } from './capture';
import { EvaluationStop } from './control';
import type { Attempt, RunControl } from './control';
import type { createEvidenceBuilder } from '../src/evidence';
import type { TurnOutcome } from '../../mobile/src/assistant-core/coordinator';
import type { EvaluationCase } from './plan';
import { observeEvaluationError } from './error-observer';
import type { EvaluationErrorMetadata } from './error-observer';

interface RoundEvidence {
  input: ProviderInput;
  attemptId: number | null;
  structured: SyntheticStructuredCapture | null;
  usage: ProviderUsage | null;
  fullModel: 'NOT_REACHED' | 'PASS' | 'FAIL';
  requestAware: 'NOT_REACHED' | 'PASS' | 'FAIL';
}
function reason(error: unknown) {
  return error instanceof EvaluationStop
    ? error.reason
    : error instanceof CaptureObservationError
      ? error.reason
      : error instanceof GatewayError
        ? error.detail.code
        : 'unclassified_failure';
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Explicit injected transport, key and control; import never reads credentials or makes calls. */
export interface JudgedFixture {
  artifact: { request: AssistantTurnRequest; state: unknown; [key: string]: unknown };
  judge(turn: (request: AssistantTurnRequest) => Promise<AssistantTurnResponse>): Promise<
    | TurnOutcome
    | {
        kind: 'gateway_component_result';
        appStatus: 'NOT_ATTEMPTED_SYNTHETIC_BOUNDARY';
        response: AssistantTurnResponse;
      }
  >;
  snapshot(): Promise<unknown>;
  evaluationEvidence?: ReturnType<typeof createEvidenceBuilder>;
  acceptanceEvidence?(): unknown;
}
export async function judgeCase(options: {
  item: EvaluationCase;
  model: GeminiModel;
  fixture: JudgedFixture;
  turnId?: string;
  control: RunControl;
  apiKey: string;
  transport: typeof fetch;
}) {
  const { item, model, fixture, control } = options;
  const turn = await control.start(item.id, model, options.turnId);
  const started = turn.startedAt;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    control.stop('deadline');
    controller.abort(gatewayError('deadline', 504, 'never'));
  }, LIMITS.deadlineMs);
  const diagnostics: ProviderDiagnostic[] = [];
  const errorDiagnostics: {
    attemptId: number;
    model: GeminiModel;
    operation: Attempt['operation'];
    httpStatus: number;
    metadata: EvaluationErrorMetadata;
  }[] = [];
  const errorObservations: Promise<unknown>[] = [];
  let acceptingResponses = true;
  const captures = new Map<number, SyntheticResponseCapture>();
  const rounds: RoundEvidence[] = [];
  let pending: { attempt: Attempt; round: RoundEvidence; value: unknown } | undefined;
  let normalized: AssistantTurnResponse | null = null;
  const checkStop = () => {
    if (control.globalStop) throw new EvaluationStop(control.globalStop);
    controller.signal.throwIfAborted();
  };
  function failPending(errorReason: string) {
    if (pending) {
      pending.round.requestAware = pending.round.fullModel === 'PASS' ? 'FAIL' : 'NOT_REACHED';
      turn.finish(pending.attempt, false, errorReason);
      pending = undefined;
    }
  }
  const onUnsafe = (unsafe: string) => {
    control.stop(unsafe);
    controller.abort(new EvaluationStop(unsafe));
  };
  const transport: typeof fetch = async (input, init) => {
    checkStop();
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const operation = url.pathname.endsWith(':countTokens') ? 'preflight' : 'generation';
    try {
      assert.equal(url.origin, 'https://generativelanguage.googleapis.com');
      assert.equal(url.search, '');
      assert.equal(
        url.pathname,
        operation === 'preflight' ? `/v1beta/models/${model}:countTokens` : '/v1beta/interactions',
      );
      assert.equal(
        (init?.method ?? (input instanceof Request ? input.method : '')).toUpperCase(),
        'POST',
      );
      const body = JSON.parse(
        String(init?.body ?? (input instanceof Request ? await input.clone().text() : '')),
      );
      const currentInput = rounds.at(-1)?.input;
      assert.ok(currentInput);
      if (operation === 'generation') {
        assert.equal(body.model, model);
        assert.equal(body.system_instruction, SYSTEM_INSTRUCTION);
        assert.equal(body.store, false);
        assert.equal(body.stream, false);
        assert.deepEqual(body.response_format, { type: 'text', mime_type: 'application/json' });
        assert.deepEqual(body.generation_config, { max_output_tokens: LIMITS.outputTokens });
        assert.equal(body.input, JSON.stringify(currentInput));
        for (const key of [
          'previous_interaction_id',
          'tools',
          'background',
          'agent',
          'environment',
        ])
          assert.equal(Object.hasOwn(body, key), false);
      } else {
        assert.deepEqual(body.contents, [
          {
            role: 'user',
            parts: [{ text: SYSTEM_INSTRUCTION }, { text: JSON.stringify(currentInput) }],
          },
        ]);
      }
    } catch {
      control.stop('request_invariant_failed');
      throw new EvaluationStop('request_invariant_failed');
    }
    return turn.forward(operation, async (attempt) => {
      try {
        let response = await options.transport(input, init);
        if (!acceptingResponses) {
          void response.body?.cancel().catch(() => {});
          throw new EvaluationStop(control.globalStop ?? 'case_closed');
        }
        attempt.httpStatus = response.status;
        attempt.httpResponseAt = control.now();
        if ([401, 403, 429].includes(response.status))
          control.stop(response.status === 429 ? 'quota' : 'authentication');
        if (response.status >= 400) {
          turn.finish(attempt, false, `http_${response.status}`);
          const observation = observeEvaluationError(response, {
            signal: controller.signal,
            deadline: turn.deadline,
            now: control.now,
          }).then(async (observed) => {
            const diagnostic = {
              attemptId: attempt.id,
              model,
              operation: attempt.operation,
              httpStatus: attempt.httpStatus!,
              metadata: observed.metadata,
            };
            errorDiagnostics.push(diagnostic);
            await control.record({ event: 'provider_error_metadata', ...diagnostic });
            return observed;
          });
          errorObservations.push(observation);
          const observed = await observation;
          if (!acceptingResponses || controller.signal.aborted) {
            void observed.response?.body?.cancel().catch(() => {});
            throw new EvaluationStop(control.globalStop ?? 'case_closed');
          }
          if (!observed.response) {
            control.stop(observed.metadata.bodyState);
            throw new EvaluationStop(control.globalStop!);
          }
          response = observed.response;
        }
        if (operation === 'preflight') {
          if (response.ok) turn.finish(attempt, true, 'preflight_http_completed');
          await control.record({ event: 'http_result', attempt: { ...attempt } });
          return response;
        }
        const observed = await observeSyntheticResponse(response, {
          signal: controller.signal,
          apiKey: options.apiKey,
          onUnsafe,
        });
        captures.set(attempt.id, observed.capture);
        attempt.reportedUsage = observed.capture.usage;
        if (response.ok && observed.capture.usage.status === 'UNKNOWN')
          control.stop('successful_generation_usage_unknown');
        if (
          observed.capture.usage.status === 'KNOWN' &&
          ((observed.capture.usage.inputTokens ?? 0) > LIMITS.inputTokens ||
            (observed.capture.usage.outputTokens ?? 0) +
              (observed.capture.usage.thoughtTokens ?? 0) >
              LIMITS.outputTokens)
        )
          control.stop('reported_usage_exceeds_admission');
        if (observed.capture.reason === 'capture_limit') control.stop('capture_limit');
        await control.record({
          event: 'model_text',
          attempt: { ...attempt },
          capture: observed.capture,
        });
        checkStop();
        return observed.response;
      } catch (error) {
        turn.finish(attempt, false, reason(error));
        if (error instanceof CaptureObservationError) control.stop(error.reason);
        throw error;
      }
    });
  };
  const provider = createGeminiProvider({
    apiKey: options.apiKey,
    model,
    fetch: transport,
    now: control.now,
    onDiagnostic(event) {
      if (!acceptingResponses) return;
      if (diagnostics.length >= 64) {
        control.stop('diagnostic_limit');
        return;
      }
      diagnostics.push(structuredClone(event));
    },
  });
  const wrapped: ModelProvider = {
    async complete(input, execution) {
      checkStop();
      if (pending) {
        pending.round.fullModel = 'PASS';
        pending.round.requestAware = 'PASS';
        turn.finish(pending.attempt, true, 'validated_retrieve');
        pending = undefined;
      }
      const round: RoundEvidence = {
        input: structuredClone(input),
        attemptId: null,
        structured: null,
        usage: null,
        fullModel: 'NOT_REACHED',
        requestAware: 'NOT_REACHED',
      };
      rounds.push(round);
      await control.record({ event: 'provider_round', round: rounds.length, input: round.input });
      try {
        const result = await provider.complete(input, execution);
        const attempt = [...turn.attempts]
          .reverse()
          .find((entry) => entry.operation === 'generation' && entry.state === 'forwarded');
        if (!attempt) {
          control.stop('missing_generation_ledger');
          throw new EvaluationStop('missing_generation_ledger');
        }
        round.attemptId = attempt.id;
        round.usage = result.usage;
        round.fullModel = isModelStep(result.value) ? 'PASS' : 'FAIL';
        round.structured = sanitizeSyntheticStructuredCopy(result.value, {
          apiKey: options.apiKey,
          onUnsafe,
          remainingBytes: 32 * 1024 - (captures.get(attempt.id)?.serializedBytes ?? 0),
        });
        if (round.structured.reason === 'capture_limit') control.stop('capture_limit');
        await control.record({
          event: 'model_structured',
          attemptId: attempt.id,
          structured: round.structured,
          usage: round.usage,
        });
        checkStop();
        pending = { attempt, round, value: result.value };
        return result;
      } catch (error) {
        const attempt = [...turn.attempts]
          .reverse()
          .find((entry) => entry.operation === 'generation' && entry.state === 'forwarded');
        if (attempt) {
          round.attemptId = attempt.id;
          turn.finish(attempt, false, reason(error));
        }
        throw error;
      }
    },
  };
  try {
    const orchestrate = createOrchestrator(wrapped, fixture.evaluationEvidence);
    const outcome = await fixture.judge(async (request) => {
      checkStop();
      assert.equal(request.message.text, item.input.prompt);
      assert.deepEqual(request.catalogue, fixture.artifact.request.catalogue);
      assert.deepEqual(request.capabilities, fixture.artifact.request.capabilities);
      assert.deepEqual(request.context.preferences, fixture.artifact.request.context.preferences);
      assert.deepEqual(
        request.context.planOccurrences,
        fixture.artifact.request.context.planOccurrences,
      );
      assert.deepEqual(
        request.context.referenceSets,
        fixture.artifact.request.context.referenceSets,
      );
      try {
        normalized = await orchestrate(request, {
          signal: controller.signal,
          deadline: turn.deadline,
        });
        checkStop();
        if (pending) {
          pending.round.fullModel = 'PASS';
          if (record(pending.value) && pending.value.kind === 'retrieve') {
            pending.round.requestAware = 'NOT_REACHED';
            turn.finish(pending.attempt, false, 'unusable_retrieve_after_budget');
          } else {
            pending.round.requestAware = 'PASS';
            turn.finish(pending.attempt, true, 'validated_response');
          }
          pending = undefined;
        }
        await control.record({ event: 'normalized_gateway_response', response: normalized });
        return normalized;
      } catch (error) {
        failPending(reason(error));
        throw error;
      }
    });
    acceptingResponses = false;
    // Provider cancellation can finish caller waiting before its body observer settles.
    // Drain only these bounded observations before writing terminal evidence/closing journals.
    await Promise.all(errorObservations);
    const after = await fixture.snapshot();
    assert.deepEqual(after, fixture.artifact.state, 'judged_turn_mutated_domain_state');
    const generations = turn.attempts.filter(
      (attempt) => attempt.operation === 'generation' && attempt.state !== 'reserved',
    );
    const finalGenerationFailed = generations.at(-1)?.result === 'failed';
    const result = {
      kind: 'cookmate-screen-case',
      caseId: item.id,
      ...(options.turnId ? { turnId: options.turnId } : {}),
      model,
      status: !['reply', 'gateway_component_result'].includes(outcome.kind)
        ? finalGenerationFailed
          ? 'FAILED_GENERATION'
          : 'FAILED_INFRA'
        : finalGenerationFailed
          ? 'FAILED_GENERATION'
          : generations.length
            ? 'REVIEW_PENDING'
            : 'FAILED_ZERO_GENERATION',
      semanticReview: 'PENDING_INDEPENDENT_REVIEW',
      liveCredit: false,
      setup: fixture.artifact,
      rounds,
      textCaptures: [...captures].map(([attemptId, capture]) => ({ attemptId, capture })),
      diagnostics,
      errorDiagnostics,
      selected_text: 'NOT_OBSERVED',
      normalized: normalized as AssistantTurnResponse | null,
      outcome,
      ...(fixture.acceptanceEvidence ? { appAcceptance: fixture.acceptanceEvidence() } : {}),
      after,
      attempts: turn.attempts,
      elapsedMs: control.now() - started,
      queueWaitMs: turn.queueWaitMs,
      admission: { ...control.admission },
      stop:
        control.globalStop ?? (control.stoppedCandidates.has(model) ? 'candidate_stopped' : null),
    };
    await control.record({ event: 'case_complete', result });
    return result;
  } catch (error) {
    acceptingResponses = false;
    await Promise.allSettled(errorObservations);
    failPending(reason(error));
    control.stop(reason(error));
    await control.record({
      event: 'case_exception',
      caseId: item.id,
      model,
      reason: reason(error),
      attempts: turn.attempts,
      rounds,
      diagnostics,
      errorDiagnostics,
    });
    throw new EvaluationStop(reason(error));
  } finally {
    acceptingResponses = false;
    clearTimeout(timeout);
    turn.close();
  }
}
