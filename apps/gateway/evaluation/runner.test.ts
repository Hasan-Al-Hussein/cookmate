import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeFixtureDirectory } from '../../../packages/domain/test/helpers/sqlite';
import { claimActivation, verifyActivation } from './runner';
import { CASE_IDS, ORDER } from './plan';
import { verifyOfflineRunner } from './verify';
import type { EvaluationAllowance } from './control';

function smallAllowance(): EvaluationAllowance {
  return {
    maxHttpRequests: 20,
    maxJudgedCases: 4,
    maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 10, 'gemini-3.8-flash': 10 },
    quietPeriodMs: 65_000,
    expiresAt: Date.now() + 3_600_000,
  };
}

test('activation rejects missing, oversized, unpaired, unpaced or expired allocations before reading its manifest', async (t) => {
  const docsRoot = process.env.COOKMATE_EVALUATION_DOCS_ROOT;
  assert.ok(docsRoot);
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-activation-'));
  t.after(() => removeFixtureDirectory(directory));
  const path = join(directory, 'activation.json');
  for (const [change, reason] of [
    [{ maxHttpRequestsPerModel: undefined }, 'model_allowance_required'],
    [
      { maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 11, 'gemini-3.8-flash': 10 } },
      'invalid_model_allowance',
    ],
    [{ maxHttpRequests: 21 }, 'invalid_http_allowance'],
    [{ maxJudgedCases: 3 }, 'invalid_case_allowance'],
    [{ maxJudgedCases: 18 }, 'invalid_case_allowance'],
    [{ quietPeriodMs: 0 }, 'invalid_quiet_period'],
    [{ expiresAt: 0 }, 'invalid_campaign_expiry'],
    [{ expiresAt: undefined }, 'invalid_campaign_expiry'],
  ] as const) {
    await writeFile(
      path,
      JSON.stringify({
        status: 'APPROVED_BY_BRAIN',
        profileId: 'source-amendment-v2',
        syntheticFixturesOnly: true,
        ...smallAllowance(),
        ...change,
        caseIds: CASE_IDS,
        order: ORDER,
        runId: 'cookmate-screen-invalid-policy',
        inputManifestPath: join(directory, 'must-not-read.json'),
        inputManifestSha256: '0'.repeat(64),
      }),
    );
    await assert.rejects(verifyActivation(path, docsRoot, process.cwd()), new RegExp(reason));
  }
});

test('a four-entry ORDER prefix runs only those cases and preserves NOT_RUN and zero semantic credit elsewhere', async (t) => {
  const docsRoot = process.env.COOKMATE_EVALUATION_DOCS_ROOT;
  assert.ok(docsRoot);
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-prefix-'));
  t.after(() => removeFixtureDirectory(directory));
  const output = join(directory, 'run');
  const report = await verifyOfflineRunner(
    docsRoot,
    output,
    'source-amendment-v2',
    smallAllowance(),
  );
  const results = report.results as {
    caseId: string;
    model: string;
    status: string;
    liveCredit: boolean;
  }[];
  assert.deepEqual(
    results.slice(0, 4).map(({ caseId, model }) => ({ caseId, model })),
    ORDER.slice(0, 4),
  );
  assert.ok(results.slice(0, 4).every((result) => result.status === 'REVIEW_PENDING'));
  assert.ok(results.slice(4).every((result) => result.status === 'NOT_RUN_ALLOWANCE'));
  assert.ok(results.every((result) => result.liveCredit === false));
  assert.equal(report.partialScreen, true);
  assert.equal(report.liveCasesRun, 0);
  assert.equal(report.liveProviderRequests, 0);
  assert.equal(report.chargedHttpAttempts, 8);
  assert.equal(report.semanticReview, 'NOT_SCORED_OFFLINE');
  const events = (await readFile(join(output, 'dispatch.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.event === 'setup_verified').length, 16);
  assert.equal(events.filter((event) => event.event === 'case_admitted').length, 4);
  assert.equal(events.find((event) => event.event === 'case_admitted').queueWaitMs, 65_000);
});

test('the same activation cannot start a second run or be automatically resumed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-activation-'));
  t.after(() => removeFixtureDirectory(directory));
  const path = join(directory, 'activation.json');
  const runId = 'cookmate-screen-fictional-check';
  await claimActivation(path, runId, join(directory, 'first-run'));
  const original = await readFile(`${path}.${runId}.used`, 'utf8');
  await assert.rejects(claimActivation(path, runId, join(directory, 'second-run')), {
    code: 'EEXIST',
  });
  assert.equal(await readFile(`${path}.${runId}.used`, 'utf8'), original);
});

test('a full matrix allocation stopped by a smaller HTTP allowance is still a partial screen', async (t) => {
  const docsRoot = process.env.COOKMATE_EVALUATION_DOCS_ROOT;
  assert.ok(docsRoot);
  const directory = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-allowance-'));
  t.after(() => removeFixtureDirectory(directory));
  const report = await verifyOfflineRunner(
    docsRoot,
    join(directory, 'run'),
    'source-amendment-v2',
    {
      ...smallAllowance(),
      maxJudgedCases: 16,
      maxHttpRequests: 10,
      maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 5, 'gemini-3.8-flash': 5 },
    },
  );
  assert.equal(report.globalStop, 'evaluation_allowance_exhausted');
  assert.equal(report.partialScreen, true);
  assert.equal(report.admittedCases, 2);
  assert.equal(report.chargedHttpAttempts, 4);
  assert.ok(
    (report.results.slice(2) as { status: string }[]).every(
      (result) => result.status === 'NOT_RUN_ALLOWANCE',
    ),
  );
  assert.equal(report.liveProviderRequests, 0);
  assert.equal(report.semanticReview, 'NOT_SCORED_OFFLINE');
});
