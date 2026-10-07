import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LATENCY_CASE_IDS, summarizeFullLatency } from './full-metrics';
import type { FullLatencyRow } from './full-metrics';

const model = 'gemini-3.5-flash-lite' as const;

test('the fixed 30-case cohort uses nearest rank and keeps the other model unrun', () => {
  const rows: FullLatencyRow[] = LATENCY_CASE_IDS.map((caseId, index) => ({
    caseId,
    model,
    status: 'REVIEW_PENDING',
    elapsedMs: (index + 1) * 1_000,
    queueWaitMs: 65_000,
  })).reverse();
  rows.push({ caseId: 'L25', model, status: 'REVIEW_PENDING', elapsedMs: 1 });
  const [actual, absent] = summarizeFullLatency(rows);
  assert.ok(actual && absent);
  assert.deepEqual(actual.completionLatencyMs, {
    basis: 'COMPLETED_LOGICAL_TURNS_ONLY',
    method: 'nearest_rank',
    sampleCount: 30,
    excludedCount: 0,
    allPlannedCompleted: true,
    min: 1_000,
    p50: 15_000,
    p95: 29_000,
    max: 30_000,
  });
  assert.deepEqual(
    actual.observations.map((row) => row.caseId),
    LATENCY_CASE_IDS,
  );
  assert.equal(
    actual.observations.some((row) => row.caseId === 'L25'),
    false,
  );
  assert.deepEqual(
    actual.strata.map((row) => [row.stratum, row.planned, row.completed]),
    [
      ['A', 6, 6],
      ['B', 6, 6],
      ['C', 6, 6],
      ['D', 6, 6],
      ['F', 6, 6],
    ],
  );
  assert.equal(absent.notRunOrBlockedCount, 30);
  assert.equal(absent.completionLatencyMs.p95, null);
  assert.equal(absent.completionLatencyMs.sampleCount, 0);
});

test('failed and blocked cases stay visible without becoming fast successes or zero timings', () => {
  const [actual] = summarizeFullLatency([
    { caseId: 'L01', model, status: 'REVIEW_PENDING', elapsedMs: 300, queueWaitMs: 65_000 },
    { caseId: 'L02', model, status: 'REVIEW_PENDING', elapsedMs: 100 },
    { caseId: 'L03', model, status: 'REVIEW_PENDING', elapsedMs: 200 },
    { caseId: 'L04', model, status: 'FAILED_GENERATION', elapsedMs: 45_000 },
    { caseId: 'L05', model, status: 'BLOCKED_SETUP' },
  ]);
  assert.ok(actual);
  assert.equal(actual.completedLogicalTurnCount, 3);
  assert.equal(actual.failedOrIncompleteCount, 1);
  assert.equal(actual.notRunOrBlockedCount, 26);
  assert.equal(actual.completionLatencyMs.excludedCount, 27);
  assert.equal(actual.completionLatencyMs.allPlannedCompleted, false);
  assert.equal(actual.completionLatencyMs.p50, 200);
  assert.equal(actual.completionLatencyMs.p95, 300);
  assert.equal(actual.observations[3]?.elapsedMs, 45_000);
  assert.equal(actual.observations[4]?.elapsedMs, null);
  assert.equal(actual.usefulAnswerLatency, 'NOT_ESTABLISHED_REQUIRES_SEMANTIC_REVIEW');
  assert.equal(actual.semanticQualityVerified, false);
  assert.equal(actual.nativeResponsiveness, 'NOT_MEASURED');
});

test('conflicting observations and invalid or missing completion timings fail closed', () => {
  const row: FullLatencyRow = { caseId: 'L01', model, status: 'REVIEW_PENDING', elapsedMs: 10 };
  assert.throws(
    () => summarizeFullLatency([row, { ...row, elapsedMs: 20 }]),
    /duplicate_latency_case/,
  );
  assert.throws(
    () => summarizeFullLatency([{ caseId: 'L01', model, status: 'REVIEW_PENDING' }]),
    /completed_latency_missing/,
  );
  for (const value of [NaN, Infinity, -1]) {
    assert.throws(
      () => summarizeFullLatency([{ ...row, elapsedMs: value }]),
      /invalid_latency_duration/,
    );
    assert.throws(
      () => summarizeFullLatency([{ ...row, queueWaitMs: value }]),
      /invalid_latency_duration/,
    );
  }
  assert.throws(() => summarizeFullLatency([{ ...row, caseId: 'L99' }]), /unknown_latency_case/);
});
