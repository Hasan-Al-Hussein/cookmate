import assert from 'node:assert/strict';
import { GEMINI_MODELS } from '../src/gemini';
import type { GeminiModel } from '../src/gemini';
import type { CaseId } from './plan';

/** Frozen plan section 8: these 30 single-turn cases form the latency cohort. */
export const LATENCY_CASE_IDS: readonly CaseId[] = [
  ...Array.from({ length: 24 }, (_, index) => index + 1),
  ...Array.from({ length: 6 }, (_, index) => index + 31),
].map((number) => `L${String(number).padStart(2, '0')}` as CaseId);

export interface FullLatencyRow {
  caseId: CaseId;
  model: GeminiModel;
  status: string;
  elapsedMs?: number;
  queueWaitMs?: number;
}

function checkedDuration(value: number | undefined): number | null {
  if (value === undefined) return null;
  assert.ok(Number.isFinite(value) && value >= 0, 'invalid_latency_duration');
  return value;
}

function completionStats(values: readonly number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const nearestRank = (percentile: number) =>
    ordered.length ? ordered[Math.ceil(percentile * ordered.length) - 1]! : null;
  return {
    basis: 'COMPLETED_LOGICAL_TURNS_ONLY',
    method: 'nearest_rank',
    sampleCount: ordered.length,
    excludedCount: LATENCY_CASE_IDS.length - ordered.length,
    allPlannedCompleted: ordered.length === LATENCY_CASE_IDS.length,
    min: ordered[0] ?? null,
    p50: nearestRank(0.5),
    p95: nearestRank(0.95),
    max: ordered.at(-1) ?? null,
  };
}

/** Timing is not an oracle for usefulness, semantic correctness or native responsiveness. */
export function summarizeFullLatency(rows: readonly FullLatencyRow[]) {
  const cohort = new Set(LATENCY_CASE_IDS);
  const indexed = new Map<string, FullLatencyRow>();
  for (const row of rows) {
    assert.ok(/^L(?:0[1-9]|[1-3][0-9]|4[0-8])$/.test(row.caseId), 'unknown_latency_case');
    assert.ok(GEMINI_MODELS.includes(row.model), 'unknown_latency_model');
    if (!cohort.has(row.caseId)) continue;
    const key = `${row.caseId}:${row.model}`;
    assert.ok(!indexed.has(key), 'duplicate_latency_case');
    assert.ok(typeof row.status === 'string' && row.status.length > 0, 'missing_latency_status');
    indexed.set(key, row);
  }
  return GEMINI_MODELS.map((model) => {
    const observations = LATENCY_CASE_IDS.map((caseId) => {
      const row = indexed.get(`${caseId}:${model}`);
      const status = row?.status ?? 'NOT_RUN';
      const elapsedMs = checkedDuration(row?.elapsedMs);
      const queueWaitMs = checkedDuration(row?.queueWaitMs);
      const completed = status === 'REVIEW_PENDING';
      assert.ok(!completed || elapsedMs !== null, 'completed_latency_missing');
      const notRun =
        status.startsWith('NOT_RUN') || (status.startsWith('BLOCKED') && elapsedMs === null);
      return {
        caseId,
        stratum: 'ABCDEFGH'[Math.floor((Number(caseId.slice(1)) - 1) / 6)]!,
        status,
        elapsedMs,
        queueWaitMs,
        completed,
        disposition: completed
          ? 'COMPLETED_UNSCORED'
          : notRun
            ? 'NOT_RUN_OR_BLOCKED'
            : 'FAILED_OR_INCOMPLETE',
      };
    });
    const completed = observations.filter((row) => row.completed);
    return {
      model,
      plannedCaseCount: LATENCY_CASE_IDS.length,
      completedLogicalTurnCount: completed.length,
      notRunOrBlockedCount: observations.filter((row) => row.disposition === 'NOT_RUN_OR_BLOCKED')
        .length,
      failedOrIncompleteCount: observations.filter(
        (row) => row.disposition === 'FAILED_OR_INCOMPLETE',
      ).length,
      completionLatencyMs: completionStats(completed.map((row) => row.elapsedMs!)),
      strata: ['A', 'B', 'C', 'D', 'F'].map((stratum) => ({
        stratum,
        planned: observations.filter((row) => row.stratum === stratum).length,
        completed: completed.filter((row) => row.stratum === stratum).length,
      })),
      observations,
      usefulAnswerLatency: 'NOT_ESTABLISHED_REQUIRES_SEMANTIC_REVIEW',
      semanticQualityVerified: false,
      nativeResponsiveness: 'NOT_MEASURED',
      interpretation:
        'Completed-only timings exclude censored failures and unrun cases; all 30 planned observations remain listed. Queue waits are reported separately. Validation completion does not establish useful-answer readiness or the 15-second useful-answer p95 target.',
    };
  });
}
