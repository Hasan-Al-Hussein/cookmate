import assert from 'node:assert/strict';
import { GEMINI_MODELS } from '../src/gemini';
import type { GeminiModel } from '../src/gemini';
import { LIMITS } from '../src/limits';
import { loadEvaluationPlan, readPinnedDocument } from './plan';
import type { CaseId, EvaluationCase } from './plan';

export const FULL_SUITE = 'full-48' as const;
export const FULL_CASE_IDS: CaseId[] = Array.from(
  { length: 48 },
  (_, i) => `L${String(i + 1).padStart(2, '0')}` as CaseId,
);
export interface FullTurn {
  caseId: CaseId;
  model: GeminiModel;
  turnId: string;
  turnNumber: number;
}
export interface TrajectoryStep {
  kind: string;
  turn?: number;
  prompt?: string;
  [key: string]: unknown;
}
/** Explicit case pairs selected before execution. A segment is an independent partial campaign. */
export function selectFullBatch(value: unknown): CaseId[] {
  assert.ok(Array.isArray(value) && value.length > 0, 'explicit_case_pair_batch_required');
  assert.deepEqual(
    value,
    FULL_CASE_IDS.filter((id) => value.includes(id)),
    'batch_must_be_unique_canonical_order',
  );
  return [...value] as CaseId[];
}
export const caseTurns = (id: CaseId) => (id === 'L25' ? 28 : 1);
export function fullOrder(batch: readonly CaseId[]): FullTurn[] {
  return batch.flatMap((caseId) => {
    const models =
      FULL_CASE_IDS.indexOf(caseId) % 2 ? [...GEMINI_MODELS].reverse() : [...GEMINI_MODELS];
    return models.flatMap((model) =>
      Array.from({ length: caseTurns(caseId) }, (_, index) => ({
        caseId,
        model,
        turnId: `${caseId}-T${String(index + 1).padStart(2, '0')}`,
        turnNumber: index + 1,
      })),
    );
  });
}
export const FULL_ORDER = fullOrder(FULL_CASE_IDS);
export function budgetFor(order: readonly FullTurn[]) {
  const perModel = Object.fromEntries(
    GEMINI_MODELS.map((model) => [model, order.filter((turn) => turn.model === model).length]),
  ) as Record<GeminiModel, number>;
  return {
    logicalTurns: order.length,
    perModel,
    generationAttempts: order.length * LIMITS.providerCalls,
    countPreflights: order.length * LIMITS.tokenPreflights,
    httpRequests: order.length * LIMITS.providerNetworkRequests,
    inputReservation: order.length * LIMITS.providerCalls * LIMITS.inputTokens,
    outputAndThoughtReservation: order.length * LIMITS.providerCalls * LIMITS.outputTokens,
  };
}
export async function loadFullPlan(
  codeRoot: string,
  docsRoot: string,
  profileId: unknown,
  suite: unknown,
  batch: unknown,
) {
  assert.equal(suite, FULL_SUITE, 'explicit_full_suite_required');
  const selectedCaseIds = selectFullBatch(batch);
  const { profile } = await loadEvaluationPlan(codeRoot, docsRoot, profileId);
  assert.equal(profile.id, 'source-amendment-v2', 'full_suite_requires_v2');
  // Parse the pinned canonical bytes; no copied prompts, trajectories or expected answers.
  const bundle = JSON.parse((await readPinnedDocument(docsRoot, profile.fixture)).toString('utf8'));
  assert.deepEqual(
    bundle.liveCases.map((item: EvaluationCase) => item.id),
    FULL_CASE_IDS,
  );
  const cases = bundle.liveCases as EvaluationCase[];
  for (const [index, item] of cases.entries())
    assert.equal(item.stratum, 'ABCDEFGH'[Math.floor(index / 6)]);
  const steps = bundle.trajectory.steps as TrajectoryStep[];
  const trajectory = steps.filter((step) => step.kind === 'user_turn');
  assert.equal(trajectory.length, 28, 'trajectory_turn_count');
  assert.equal(steps.filter((step) => step.kind === 'reopen').length, 1, 'trajectory_reopen_count');
  const order = fullOrder(selectedCaseIds);
  return {
    suite: FULL_SUITE,
    profile,
    cases,
    trajectory,
    steps,
    selectedCaseIds,
    order,
    budget: budgetFor(order),
    fullBudget: budgetFor(FULL_ORDER),
  };
}
