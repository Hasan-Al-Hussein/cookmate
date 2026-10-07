import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openControlledJournal, publishTurnEvidence, releaseOwned } from './full-output';
import type { TurnSummary } from './full-output';
import { summarizeFullLatency } from './full-metrics';
import { removeFixtureDirectory } from '../../../packages/domain/test/helpers/sqlite';
import { fullInputManifest, runFullSuite } from './full-runner';
import { offlineFullTransport } from './full-verify';
import { sha256 } from './plan';
import { cleanupFailedMaterialization, SetupCleanupFailure } from './materialize';
import { openJournal } from './control';
import { fullOrder } from './full-plan';

test('expiry during journal acquisition closes the real new handle before propagating admission failure', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-startup-expiry-'));
  t.after(() => removeFixtureDirectory(directory));
  let owned: Awaited<ReturnType<typeof openJournal>> | undefined;
  let now = 0;
  await assert.rejects(
    openControlledJournal(
      join(directory, 'dispatch.jsonl'),
      {
        maxJudgedCases: 2,
        maxHttpRequests: 10,
        maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 5, 'gemini-3.8-flash': 5 },
        quietPeriodMs: 65_000,
        expiresAt: 1,
      },
      { now: () => now, sleep: async () => {} },
      fullOrder(['L01']),
      async (path) => {
        owned = await openJournal(path);
        now = 2;
        return owned;
      },
    ),
    /invalid_campaign_expiry/,
  );
  assert.ok(owned);
  await assert.rejects(owned.append({ shouldNotWrite: true }));
  assert.equal(await readFile(join(directory, 'dispatch.jsonl'), 'utf8'), '');
});

test('real filesystem write failure cannot publish an artifact or a completed latency sample', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-evidence-failure-'));
  t.after(() => removeFixtureDirectory(directory));
  await writeFile(join(directory, 'turn.json'), 'existing evidence');
  const summary: TurnSummary = { turnId: 'L01-T01', status: 'NOT_RUN' };
  await assert.rejects(
    publishTurnEvidence(
      directory,
      'turn.json',
      summary,
      { status: 'REVIEW_PENDING' },
      { providerAttempted: true },
    ),
    { code: 'EEXIST' },
  );
  assert.equal(summary.status, 'ATTEMPTED_EVIDENCE_FAILURE');
  assert.equal(summary.artifact, undefined);
  assert.equal(await readFile(join(directory, 'turn.json'), 'utf8'), 'existing evidence');
  const latency = summarizeFullLatency([
    { caseId: 'L01', model: 'gemini-3.5-flash-lite', status: summary.status, elapsedMs: 40 },
  ]);
  assert.equal(latency[0]!.completedLogicalTurnCount, 0);
  assert.equal(latency[0]!.failedOrIncompleteCount, 1);
});
test('turn artifact publishes only after the exclusive durable write completes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-evidence-success-'));
  t.after(() => removeFixtureDirectory(directory));
  const summary: TurnSummary = { turnId: 'L01-T01', status: 'NOT_RUN' };
  await publishTurnEvidence(
    directory,
    'turn.json',
    summary,
    { status: 'REVIEW_PENDING' },
    { actual: true },
  );
  assert.deepEqual(JSON.parse(await readFile(join(directory, summary.artifact!), 'utf8')), {
    actual: true,
  });
  assert.equal(summary.status, 'REVIEW_PENDING');
});
test('owned fixture close failures do not skip another fixture or journal and do not mask the primary error', async () => {
  const calls: string[] = [];
  const primary = new Error('primary_execution_failure');
  let failures: Awaited<ReturnType<typeof releaseOwned>> = [];
  await assert.rejects(
    async () => {
      try {
        throw primary;
      } finally {
        failures = await releaseOwned([
          {
            key: 'first',
            close: async () => {
              calls.push('first');
              throw new Error('first_close');
            },
          },
          {
            key: 'second',
            close: async () => {
              calls.push('second');
            },
          },
          {
            key: 'journal',
            close: async () => {
              calls.push('journal');
              throw new Error('journal_close');
            },
          },
        ]);
      }
    },
    (error) => error === primary,
  );
  assert.deepEqual(calls, ['first', 'second', 'journal']);
  assert.deepEqual(
    failures.map((failure) => failure.key),
    ['first', 'journal'],
  );
});

const proofRoot = process.env.COOKMATE_FULL_FAILURE_PROOF_ROOT;
test('a dispatched turn lost before its result is a censored failure without inventing elapsed time', () => {
  const [candidate] = summarizeFullLatency([
    { caseId: 'L01', model: 'gemini-3.5-flash-lite', status: 'ATTEMPTED_EXECUTION_FAILURE' },
  ]);
  assert.equal(candidate!.failedOrIncompleteCount, 1);
  assert.equal(candidate!.notRunOrBlockedCount, 29);
  assert.equal(candidate!.observations[0]!.elapsedMs, null);
  assert.equal(candidate!.completionLatencyMs.sampleCount, 0);
});
test('pre-return setup cleanup preserves the primary cause and surfaces a campaign-stopping marker', async () => {
  const primary = new Error('original_setup_assertion');
  await assert.rejects(
    cleanupFailedMaterialization(primary, async () => {}),
    (error) => error === primary,
  );
  await assert.rejects(
    cleanupFailedMaterialization(primary, async () => {
      throw new Error('secondary_close_failure');
    }),
    (error) => {
      assert.ok(error instanceof SetupCleanupFailure);
      assert.equal(error.cause, primary);
      assert.equal(error.message, 'materialization_failed_with_cleanup_failure');
      return true;
    },
  );
});
test(
  'real artifact collision after SDK dispatch stops campaign, preserves attempted accounting and excludes latency success',
  { skip: !proofRoot },
  async () => {
    const docsRoot = process.env.COOKMATE_EVALUATION_DOCS_ROOT!;
    const manifest = await fullInputManifest(docsRoot, 'source-amendment-v2', 'full-48', ['L01']);
    const outputDirectory = join(proofRoot!, 'evidence-stop-01');
    const fake = offlineFullTransport();
    let now = Date.now();
    let collision = false;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('offline_network_denied');
    };
    try {
      const report = await runFullSuite({
        docsRoot,
        outputDirectory,
        apiKey: 'FICTIONAL_EVALUATION_MARKER',
        transportKind: 'injected_synthetic',
        transport: async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.endsWith('/interactions') && !collision) {
            collision = true;
            await writeFile(
              join(outputDirectory, '01-L01-T01-gemini-3.5-flash-lite.json'),
              'injected collision',
            );
          }
          return fake.transport(input, init);
        },
        clock: {
          now: () => now,
          sleep: async (milliseconds, signal) => {
            signal.throwIfAborted();
            now += milliseconds;
          },
        },
        activation: {
          suite: 'full-48',
          profileId: 'source-amendment-v2',
          runId: 'cookmate-full-offline-evidence-failure',
          manifest,
          manifestSha256: sha256(JSON.stringify(manifest, null, 2) + '\n'),
          allowance: {
            maxJudgedCases: 2,
            maxHttpRequests: 10,
            maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 5, 'gemini-3.8-flash': 5 },
            quietPeriodMs: 65_000,
            expiresAt: now + 3_600_000,
          },
        },
      });
      assert.equal(report.globalStop, 'evidence_write_failed');
      assert.equal(report.results.length, 96);
      assert.equal(report.sdkHttpAttempts, 2);
      assert.equal(report.liveProviderRequests, 0);
      assert.equal(report.results[0]!.status, 'ATTEMPTED_EVIDENCE_FAILURE');
      assert.equal(report.results[0]!.turns[0]!.artifact, undefined);
      assert.equal(report.results[1]!.status, 'NOT_RUN_STOPPED');
      assert.equal(report.latency.candidates[0]!.completedLogicalTurnCount, 0);
      assert.equal(report.latency.candidates[0]!.failedOrIncompleteCount, 1);
      assert.deepEqual(report.cleanupFailures, []);
      assert.equal(report.terminalStatus, 'STOPPED');
    } finally {
      globalThis.fetch = original;
    }
  },
);
