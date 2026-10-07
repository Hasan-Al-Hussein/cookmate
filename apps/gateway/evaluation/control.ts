import { open } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GEMINI_MODELS } from '../src/gemini';
import type { GeminiModel } from '../src/gemini';
import { LIMITS } from '../src/limits';
import type { CaseId } from './plan';
import { ORDER } from './plan';
import type { SyntheticReportedUsage } from './capture';

export class EvaluationStop extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export const QUIET_PERIOD_MS = 65_000;
export interface EvaluationAllowance {
  maxHttpRequests: number;
  maxJudgedCases: number;
  maxHttpRequestsPerModel: Record<GeminiModel, number>;
  quietPeriodMs: number;
  expiresAt: number;
}
export interface EvaluationClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export const systemClock: EvaluationClock = {
  now: Date.now,
  sleep: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};
/** An allocation is supplied explicitly; dashboard peaks never become inferred headroom. */
export interface ControlTurn {
  caseId: CaseId;
  model: GeminiModel;
  turnId?: string;
}
export function readEvaluationAllowance(
  value: unknown,
  now: number,
  order: readonly ControlTurn[] = ORDER,
): EvaluationAllowance {
  assert.ok(value && typeof value === 'object', 'evaluation_allowance_required');
  const input = value as EvaluationAllowance;
  assert.ok(
    Number.isSafeInteger(input.maxJudgedCases) &&
      input.maxJudgedCases >= 2 &&
      input.maxJudgedCases <= order.length &&
      input.maxJudgedCases % 2 === 0,
    'invalid_case_allowance',
  );
  assert.ok(
    Number.isSafeInteger(input.maxHttpRequests) &&
      input.maxHttpRequests >= 10 &&
      input.maxHttpRequests <= input.maxJudgedCases * LIMITS.providerNetworkRequests,
    'invalid_http_allowance',
  );
  assert.ok(
    input.maxHttpRequestsPerModel && typeof input.maxHttpRequestsPerModel === 'object',
    'model_allowance_required',
  );
  assert.deepEqual(
    Object.keys(input.maxHttpRequestsPerModel).sort(),
    [...GEMINI_MODELS].sort(),
    'invalid_model_allowance',
  );
  for (const model of GEMINI_MODELS)
    assert.ok(
      Number.isSafeInteger(input.maxHttpRequestsPerModel[model]) &&
        input.maxHttpRequestsPerModel[model] >=
          (order.slice(0, input.maxJudgedCases).some((turn) => turn.model === model)
            ? LIMITS.providerNetworkRequests
            : 0) &&
        input.maxHttpRequestsPerModel[model] <=
          order.slice(0, input.maxJudgedCases).filter((turn) => turn.model === model).length *
            LIMITS.providerNetworkRequests,
      'invalid_model_allowance',
    );
  assert.equal(input.quietPeriodMs, QUIET_PERIOD_MS, 'invalid_quiet_period');
  assert.ok(
    Number.isSafeInteger(input.expiresAt) &&
      input.expiresAt > now &&
      input.expiresAt <= 8_640_000_000_000_000,
    'invalid_campaign_expiry',
  );
  return Object.freeze({
    maxHttpRequests: input.maxHttpRequests,
    maxJudgedCases: input.maxJudgedCases,
    maxHttpRequestsPerModel: Object.freeze({ ...input.maxHttpRequestsPerModel }),
    quietPeriodMs: input.quietPeriodMs,
    expiresAt: input.expiresAt,
  });
}
export interface Attempt {
  id: number;
  caseId: CaseId;
  turnId?: string;
  model: GeminiModel;
  operation: 'preflight' | 'generation';
  state: 'reserved' | 'forwarded' | 'settled';
  result: 'pending' | 'valid' | 'failed';
  reason?: string;
  httpStatus?: number;
  admission: { inputTokens: number; outputAndThoughtTokens: number } | null;
  reportedUsage: SyntheticReportedUsage | null;
  reservedAt: number;
  forwardedAt?: number;
  httpResponseAt?: number;
  finalizedAt?: number;
}
export async function openJournal(path: string) {
  const file = await open(path, 'wx');
  return {
    async append(value: unknown) {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
    },
    close: () => file.close(),
  };
}
export type Journal = Pick<Awaited<ReturnType<typeof openJournal>>, 'append'>;
export class RunControl {
  readonly attempts: Attempt[] = [];
  readonly streak = new Map<GeminiModel, number>();
  readonly stoppedCandidates = new Set<GeminiModel>();
  globalStop: string | null = null;
  readonly admission = {
    reservedInputTokens: 0,
    reservedOutputAndThoughtTokens: 0,
    inputCeiling: 576_000,
    outputAndThoughtCeiling: 96_000,
  };
  private readonly begun = new Set<string>();
  get admittedCases() {
    return this.begun.size;
  }
  private active = false;
  private readonly stopped = new AbortController();
  private readonly quietUntil: number;
  private readonly lastForwarded = new Map<GeminiModel, number>();
  readonly allowance: EvaluationAllowance;
  readonly now: () => number;
  constructor(
    readonly journal: Journal,
    allowance: EvaluationAllowance,
    private readonly clock: EvaluationClock = systemClock,
    readonly order: readonly ControlTurn[] = ORDER,
  ) {
    this.now = () => clock.now();
    this.allowance = readEvaluationAllowance(allowance, this.now(), order);
    this.admission.inputCeiling = order.length * LIMITS.providerCalls * LIMITS.inputTokens;
    this.admission.outputAndThoughtCeiling =
      order.length * LIMITS.providerCalls * LIMITS.outputTokens;
    this.quietUntil = this.now() + this.allowance.quietPeriodMs;
  }
  stop(reason: string) {
    this.globalStop ??= reason;
    this.stopped.abort(new EvaluationStop(this.globalStop));
  }
  async record(value: unknown) {
    try {
      await this.journal.append(value);
    } catch {
      this.stop('evidence_write_failed');
      throw new EvaluationStop('evidence_write_failed');
    }
  }
  checkRun(model: GeminiModel) {
    if (this.now() >= this.allowance.expiresAt) this.stop('campaign_expired');
    if (this.globalStop || this.stoppedCandidates.has(model))
      throw new EvaluationStop(this.globalStop ?? 'candidate_stopped');
  }
  noteForwarded(model: GeminiModel, at: number) {
    this.lastForwarded.set(model, at);
  }
  async start(caseId: CaseId, model: GeminiModel, turnId?: string) {
    if (this.active) {
      this.stop('concurrent_case');
      throw new EvaluationStop('concurrent_case');
    }
    const key = `${turnId ?? caseId}:${model}`;
    if (
      !this.order
        .slice(0, this.allowance.maxJudgedCases)
        .some(
          (entry) => entry.caseId === caseId && entry.model === model && entry.turnId === turnId,
        ) ||
      this.begun.has(key)
    ) {
      this.stop('unregistered_or_repeated_case');
      throw new EvaluationStop('unregistered_or_repeated_case');
    }
    this.active = true;
    const queuedAt = this.now();
    const checkAdmission = () => {
      this.checkRun(model);
      // Reserve room for a whole turn before judging; all reserved attempts stay charged.
      if (
        this.attempts.length + LIMITS.providerNetworkRequests > this.allowance.maxHttpRequests ||
        this.attempts.filter((attempt) => attempt.model === model).length +
          LIMITS.providerNetworkRequests >
          this.allowance.maxHttpRequestsPerModel[model]
      ) {
        this.stop('evaluation_allowance_exhausted');
        throw new EvaluationStop('evaluation_allowance_exhausted');
      }
    };
    try {
      while (true) {
        checkAdmission();
        const readyAt = Math.max(
          this.quietUntil,
          (this.lastForwarded.get(model) ?? -Infinity) + this.allowance.quietPeriodMs,
        );
        const waitMs = readyAt - this.now();
        if (waitMs <= 0) break;
        if (readyAt >= this.allowance.expiresAt) {
          this.stop('campaign_expired');
          throw new EvaluationStop('campaign_expired');
        }
        await this.clock.sleep(waitMs, this.stopped.signal);
      }
      await this.record({
        event: 'case_admitted',
        caseId,
        ...(turnId ? { turnId } : {}),
        model,
        queueWaitMs: this.now() - queuedAt,
      });
      checkAdmission();
      const startedAt = this.now();
      this.begun.add(key);
      return new CaseControl(
        this,
        caseId,
        model,
        startedAt,
        startedAt + LIMITS.deadlineMs,
        startedAt - queuedAt,
        () => {
          this.active = false;
        },
        turnId,
      );
    } catch (error) {
      this.active = false;
      if (error instanceof EvaluationStop) throw error;
      this.stop('admission_wait_failed');
      throw new EvaluationStop(this.globalStop!);
    }
  }
  finish(attempt: Attempt, valid: boolean, reason: string) {
    if (attempt.result !== 'pending' || attempt.state !== 'forwarded') return;
    attempt.result = valid ? 'valid' : 'failed';
    attempt.reason = reason;
    attempt.state = 'settled';
    attempt.finalizedAt = this.now();
    if (attempt.operation === 'generation') {
      const streak = valid ? 0 : (this.streak.get(attempt.model) ?? 0) + 1;
      this.streak.set(attempt.model, streak);
      if (streak >= 2) this.stoppedCandidates.add(attempt.model);
    }
  }
}
export class CaseControl {
  private forwarding = false;
  private closed = false;
  constructor(
    readonly run: RunControl,
    readonly caseId: CaseId,
    readonly model: GeminiModel,
    readonly startedAt: number,
    readonly deadline: number,
    readonly queueWaitMs: number,
    private readonly release: () => void,
    readonly turnId?: string,
  ) {}
  get attempts() {
    return this.run.attempts.filter(
      (entry) =>
        entry.caseId === this.caseId && entry.model === this.model && entry.turnId === this.turnId,
    );
  }
  private check(operation: Attempt['operation'], reserved?: Attempt) {
    this.run.checkRun(this.model);
    if (this.closed) throw new EvaluationStop(this.run.globalStop ?? 'candidate_stopped');
    if (this.run.now() >= this.deadline) {
      this.run.stop('deadline');
      throw new EvaluationStop('deadline');
    }
    const dispatched = this.run.attempts.filter((entry) => entry !== reserved);
    const local = dispatched.filter(
      (entry) =>
        entry.caseId === this.caseId && entry.model === this.model && entry.turnId === this.turnId,
    );
    const candidate = dispatched.filter((entry) => entry.model === this.model);
    if (
      dispatched.length >= this.run.allowance.maxHttpRequests ||
      candidate.length >= this.run.allowance.maxHttpRequestsPerModel[this.model] ||
      local.length >= 5 ||
      local.filter((entry) => entry.operation === operation).length >=
        (operation === 'generation' ? 3 : 2) ||
      candidate.filter((entry) => entry.operation === operation).length >=
        this.run.order.filter((entry) => entry.model === this.model).length *
          (operation === 'generation' ? LIMITS.providerCalls : LIMITS.tokenPreflights)
    ) {
      this.run.stop('dispatch_ceiling');
      throw new EvaluationStop('dispatch_ceiling');
    }
  }
  async forward<T>(
    operation: Attempt['operation'],
    transport: (attempt: Attempt) => Promise<T>,
  ): Promise<T> {
    if (this.forwarding) {
      this.run.stop('concurrent_dispatch');
      throw new EvaluationStop('concurrent_dispatch');
    }
    this.check(operation);
    this.forwarding = true;
    if (
      operation === 'generation' &&
      (this.run.admission.reservedInputTokens + 12_000 > this.run.admission.inputCeiling ||
        this.run.admission.reservedOutputAndThoughtTokens + 2_000 >
          this.run.admission.outputAndThoughtCeiling)
    ) {
      this.forwarding = false;
      this.run.stop('aggregate_admission_ceiling');
      throw new EvaluationStop('aggregate_admission_ceiling');
    }
    const attempt: Attempt = {
      id: this.run.attempts.length + 1,
      caseId: this.caseId,
      ...(this.turnId ? { turnId: this.turnId } : {}),
      model: this.model,
      operation,
      state: 'reserved',
      result: 'pending',
      reservedAt: this.run.now(),
      admission:
        operation === 'generation' ? { inputTokens: 12_000, outputAndThoughtTokens: 2_000 } : null,
      reportedUsage:
        operation === 'generation'
          ? { status: 'UNKNOWN', inputTokens: null, outputTokens: null, thoughtTokens: null }
          : null,
    };
    if (attempt.admission) {
      this.run.admission.reservedInputTokens += attempt.admission.inputTokens;
      this.run.admission.reservedOutputAndThoughtTokens += attempt.admission.outputAndThoughtTokens;
    }
    this.run.attempts.push(attempt);
    try {
      await this.run.record({ event: 'dispatch_reserved', attempt: { ...attempt } });
      this.check(operation, attempt);
      attempt.state = 'forwarded';
      attempt.forwardedAt = this.run.now();
      this.run.noteForwarded(this.model, attempt.forwardedAt);
      return await transport(attempt);
    } finally {
      this.forwarding = false;
    }
  }
  finish(attempt: Attempt, valid: boolean, reason: string) {
    this.run.finish(attempt, valid, reason);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.release();
    }
  }
}
