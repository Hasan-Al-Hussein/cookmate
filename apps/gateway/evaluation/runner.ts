import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvaluationStop,
  RunControl,
  openJournal,
  readEvaluationAllowance,
  systemClock,
} from './control';
import type { EvaluationClock } from './control';
import { judgeCase } from './judge';
import { materialize } from './materialize';
import { CASE_IDS, loadEvaluationPlan, ORDER, sha256 } from './plan';
import { inputManifest, writeExclusive } from './prepare';

export async function verifyActivation(activationPath: string, docsRoot: string, codeRoot: string) {
  const activation = JSON.parse(await readFile(activationPath, 'utf8'));
  const { profile } = await loadEvaluationPlan(codeRoot, docsRoot, activation.profileId);
  assert.equal(activation.status, 'APPROVED_BY_BRAIN');
  assert.equal(activation.syntheticFixturesOnly, true);
  const allowance = readEvaluationAllowance(activation, Date.now());
  assert.deepEqual(activation.caseIds, CASE_IDS);
  assert.deepEqual(activation.order, ORDER);
  assert.equal(typeof activation.runId, 'string');
  assert.match(activation.runId, /^cookmate-screen-[a-z0-9-]{8,80}$/);
  assert.equal(typeof activation.inputManifestPath, 'string');
  const frozenBytes = await readFile(activation.inputManifestPath);
  assert.equal(
    createHash('sha256').update(frozenBytes).digest('hex'),
    activation.inputManifestSha256,
  );
  const frozen = JSON.parse(frozenBytes.toString('utf8'));
  assert.equal(
    sha256(JSON.stringify(frozen, null, 2) + '\n'),
    activation.inputManifestSha256,
    'manifest_encoding_mismatch',
  );
  assert.deepEqual(frozen.profile, profile, 'activation_profile_mismatch');
  assert.deepEqual(
    await inputManifest(codeRoot, docsRoot, profile.id),
    frozen,
    'frozen_source_changed',
  );
  return {
    profileId: profile.id,
    allowance,
    runId: activation.runId as string,
    manifest: frozen,
    manifestSha256: activation.inputManifestSha256 as string,
  };
}

export async function claimActivation(
  activationPath: string,
  runId: string,
  outputDirectory: string,
) {
  await writeExclusive(`${activationPath}.${runId}.used`, {
    runId,
    outputDirectory,
    status: 'CONSUMED_NO_AUTOMATIC_RESUME',
    claimedAt: new Date().toISOString(),
  });
}

/** Used with injected synthetic HTTP in tests; real transport is supplied only by the guarded CLI. */
export async function runScreen(options: {
  docsRoot: string;
  profileId: string;
  outputDirectory: string;
  apiKey: string;
  transport: typeof fetch;
  transportKind: 'injected_synthetic' | 'live_provider';
  activation: Awaited<ReturnType<typeof verifyActivation>>;
  clock?: EvaluationClock;
}) {
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  // Direct/injected calls share admission; a synthetic activation is never an identity bypass.
  const { cases, profile } = await loadEvaluationPlan(
    codeRoot,
    options.docsRoot,
    options.profileId,
  );
  assert.equal(options.activation.profileId, profile.id, 'activation_profile_mismatch');
  assert.deepEqual(options.activation.manifest.profile, profile, 'manifest_profile_mismatch');
  assert.equal(
    sha256(JSON.stringify(options.activation.manifest, null, 2) + '\n'),
    options.activation.manifestSha256,
    'manifest_digest_mismatch',
  );
  assert.deepEqual(
    await inputManifest(codeRoot, options.docsRoot, profile.id),
    options.activation.manifest,
    'frozen_source_changed',
  );
  assert.ok(
    !options.clock || options.transportKind === 'injected_synthetic',
    'live_clock_override',
  );
  const clock = options.clock ?? systemClock;
  const allowance = readEvaluationAllowance(options.activation.allowance, clock.now());
  await mkdir(options.outputDirectory, { recursive: false });
  await writeExclusive(join(options.outputDirectory, 'inputs.json'), options.activation.manifest);
  const journal = await openJournal(join(options.outputDirectory, 'dispatch.jsonl'));
  let control: RunControl | undefined;
  const fixtures = new Map<string, Awaited<ReturnType<typeof materialize>>>();
  const results: unknown[] = [];
  let blockedSetup: string | null = null;
  try {
    control = new RunControl(journal, allowance, clock);
    await control.record({
      event: 'run_context',
      profile,
      transportKind: options.transportKind,
      runId: options.activation.runId,
      allowance,
      inputManifestSha256: options.activation.manifestSha256,
    });
    // The whole exact matrix must materialize before the first paid/actual HTTP dispatch.
    for (const [index, pair] of ORDER.entries()) {
      const item = cases.find((entry) => entry.id === pair.caseId)!;
      const key = `${pair.caseId}:${pair.model}`;
      try {
        const fixture = await materialize(
          join(options.outputDirectory, `state-${index + 1}`),
          item,
        );
        fixtures.set(key, fixture);
        await control.record({ event: 'setup_verified', ...pair, setup: fixture.artifact });
      } catch {
        if (control.globalStop) throw new Error('evidence_write_failed');
        blockedSetup = key;
        control.stop('setup_verification_failed');
        await control.record({
          event: 'setup_blocked',
          ...pair,
          reason: 'setup_verification_failed',
        });
        break;
      }
    }
    for (const [index, pair] of ORDER.entries()) {
      if (index >= allowance.maxJudgedCases && !control.globalStop)
        control.stop('evaluation_allowance_exhausted');
      if (control.globalStop || control.stoppedCandidates.has(pair.model)) {
        const result = {
          ...pair,
          status:
            blockedSetup === `${pair.caseId}:${pair.model}`
              ? 'BLOCKED_SETUP'
              : control.globalStop === 'evaluation_allowance_exhausted'
                ? 'NOT_RUN_ALLOWANCE'
                : control.globalStop
                  ? 'NOT_RUN_GLOBAL_STOP'
                  : 'NOT_RUN_CANDIDATE_STOP',
          reason: control.globalStop ?? 'two_consecutive_failed_generations',
          liveCredit: false,
        };
        results.push(result);
        await control.record({ event: 'case_not_run', result });
        continue;
      }
      const fixture = fixtures.get(`${pair.caseId}:${pair.model}`)!;
      const item = cases.find((entry) => entry.id === pair.caseId)!;
      try {
        const result = await judgeCase({
          item,
          model: pair.model,
          fixture,
          control,
          apiKey: options.apiKey,
          transport: options.transport,
        });
        await writeExclusive(
          join(
            options.outputDirectory,
            `${String(index + 1).padStart(2, '0')}-${pair.caseId}-${pair.model}.json`,
          ),
          {
            ...result,
            transportKind: options.transportKind,
            liveCaseStatus: options.transportKind === 'live_provider' ? result.status : 'NOT_RUN',
            semanticReview:
              options.transportKind === 'live_provider'
                ? result.semanticReview
                : 'NOT_SCORED_OFFLINE',
          },
        );
        results.push({ ...pair, status: result.status, liveCredit: false });
      } catch (error) {
        control.stop('case_or_evidence_failure');
        results.push({
          ...pair,
          status:
            error instanceof EvaluationStop && error.reason === 'evaluation_allowance_exhausted'
              ? 'NOT_RUN_ALLOWANCE'
              : 'FAILED_INFRA',
          reason: control.globalStop,
          liveCredit: false,
        });
      }
    }
    const generations = control.attempts.filter(
      (attempt) => attempt.operation === 'generation' && attempt.state !== 'reserved',
    );
    const reported = {
      reportedAvailableInputTokens: 0,
      reportedAvailableOutputTokens: 0,
      reportedAvailableThoughtTokens: 0,
      unknownAttempts: 0,
    };
    for (const attempt of generations) {
      if (
        attempt.reportedUsage?.inputTokens !== null &&
        attempt.reportedUsage?.inputTokens !== undefined
      )
        reported.reportedAvailableInputTokens += attempt.reportedUsage.inputTokens;
      if (
        attempt.reportedUsage?.outputTokens !== null &&
        attempt.reportedUsage?.outputTokens !== undefined
      )
        reported.reportedAvailableOutputTokens += attempt.reportedUsage.outputTokens;
      if (
        attempt.reportedUsage?.thoughtTokens !== null &&
        attempt.reportedUsage?.thoughtTokens !== undefined
      )
        reported.reportedAvailableThoughtTokens += attempt.reportedUsage.thoughtTokens;
      if (attempt.reportedUsage?.status !== 'KNOWN') reported.unknownAttempts++;
    }
    assert.deepEqual(
      await inputManifest(codeRoot, options.docsRoot, profile.id),
      options.activation.manifest,
      'run_inputs_changed',
    );
    const report = {
      kind: 'cookmate-finite-synthetic-screen',
      profile,
      transportKind: options.transportKind,
      runId: options.activation.runId,
      allowance,
      admittedCases: control.admittedCases,
      partialScreen: control.admittedCases < ORDER.length,
      chargedHttpAttempts: control.attempts.length,
      inputManifestSha256: options.activation.manifestSha256,
      semanticReview:
        options.transportKind === 'live_provider'
          ? 'PENDING_INDEPENDENT_REVIEW'
          : 'NOT_SCORED_OFFLINE',
      liveCasesRun:
        options.transportKind === 'live_provider'
          ? new Set(generations.map((attempt) => `${attempt.caseId}:${attempt.model}`)).size
          : 0,
      results,
      attempts: control.attempts,
      admission: control.admission,
      reportedUsage: reported,
      accountingNote:
        'Admission reservations are not incurred usage or spend; unknown and in-flight outcomes may exceed reported totals.',
      globalStop: control.globalStop,
      stoppedCandidates: [...control.stoppedCandidates],
      sdkHttpAttempts: control.attempts.filter((attempt) => attempt.state !== 'reserved').length,
      liveProviderRequests:
        options.transportKind === 'live_provider'
          ? control.attempts.filter((attempt) => attempt.state !== 'reserved').length
          : 0,
    };
    await writeExclusive(join(options.outputDirectory, 'report.json'), report);
    return report;
  } catch {
    control?.stop('preparation_or_evidence_failure');
    // A lost journal cannot be repaired by synthesizing results or retrying dispatched work.
    throw new Error('screen_stopped_inspect_existing_evidence_no_automatic_resume');
  } finally {
    for (const fixture of fixtures.values()) await fixture.close();
    await journal.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, activationPath, docsRoot, output] = process.argv.slice(2);
  if (
    mode !== '--execute-synthetic-screen' ||
    !activationPath ||
    !docsRoot ||
    !output ||
    process.argv.length !== 6
  )
    throw new Error('explicit_reviewed_activation_required');
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const activation = await verifyActivation(resolve(activationPath), resolve(docsRoot), codeRoot);
  await claimActivation(resolve(activationPath), activation.runId, resolve(output));
  // Read only after the explicit CLI activation and all source checks. Never open an env file here.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('explicit_GEMINI_API_KEY_required');
  const report = await runScreen({
    profileId: activation.profileId,
    docsRoot: resolve(docsRoot),
    outputDirectory: resolve(output),
    apiKey,
    transport: fetch,
    transportKind: 'live_provider',
    activation,
  });
  process.stdout.write(
    JSON.stringify({
      cases: report.results.length,
      sdkHttpAttempts: report.sdkHttpAttempts,
      liveProviderRequests: report.liveProviderRequests,
      stop: report.globalStop,
    }) + '\n',
  );
}
