import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantTurnRequest } from '@cookmate/contracts';
import { GEMINI_MODELS } from '../src/gemini';
import type { GeminiModel } from '../src/gemini';
import { readEvaluationAllowance, systemClock } from './control';
import type { EvaluationAllowance, EvaluationClock } from './control';
import { FULL_CASE_IDS, FULL_SUITE, caseTurns, loadFullPlan } from './full-plan';
import type { FullTurn } from './full-plan';
import { declaredAdapter } from './full-adapters';
import { materialize, SetupCleanupFailure } from './materialize';
import { judgeCase } from './judge';
import { inputManifest, writeExclusive } from './prepare';
import { sha256 } from './plan';
import type { CaseId, EvaluationCase } from './plan';
import { claimActivation } from './runner';
import { summarizeFullLatency } from './full-metrics';
import type { FullLatencyRow } from './full-metrics';
import { openControlledJournal, publishTurnEvidence, releaseOwned } from './full-output';
import type { TurnSummary } from './full-output';

const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export async function fullInputManifest(
  docsRoot: string,
  profileId: string,
  suite: unknown,
  batch: unknown,
) {
  const plan = await loadFullPlan(codeRoot, docsRoot, profileId, suite, batch);
  return {
    ...(await inputManifest(codeRoot, docsRoot, profileId)),
    kind: 'cookmate-full-evaluation-input-manifest',
    suite: plan.suite,
    selectedCaseIds: plan.selectedCaseIds,
    order: plan.order,
    budget: plan.budget,
    fullBudget: plan.fullBudget,
    campaignPolicy: 'INDEPENDENT_FINITE_BATCH_NO_AUTOMATIC_RESUME' as const,
  };
}
export type FullManifest = Awaited<ReturnType<typeof fullInputManifest>>;
export interface FullActivation {
  suite: typeof FULL_SUITE;
  profileId: string;
  runId: string;
  manifest: FullManifest;
  manifestSha256: string;
  allowance: EvaluationAllowance;
}
export function fullAllowance(value: unknown, order: FullTurn[], now: number): EvaluationAllowance {
  const allowance = readEvaluationAllowance(value, now, order);
  // Select fewer case pairs to reduce logical work. HTTP caps may be smaller, but never split the declared batch denominator.
  assert.equal(
    allowance.maxJudgedCases,
    order.length,
    'full_logical_turn_allowance_must_match_selected_pairs',
  );
  return allowance;
}
export async function verifyFullActivation(
  path: string,
  docsRoot: string,
): Promise<FullActivation> {
  const input = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(input.status, 'APPROVED_BY_BRAIN');
  assert.equal(input.suite, FULL_SUITE);
  assert.equal(input.syntheticFixturesOnly, true);
  assert.equal(input.campaignPolicy, 'INDEPENDENT_FINITE_BATCH_NO_AUTOMATIC_RESUME');
  assert.match(input.runId, /^cookmate-full-[a-z0-9-]{8,80}$/);
  const bytes = await readFile(input.inputManifestPath);
  assert.equal(sha256(bytes), input.inputManifestSha256);
  const manifest: FullManifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(sha256(JSON.stringify(manifest, null, 2) + '\n'), input.inputManifestSha256);
  assert.equal(manifest.suite, FULL_SUITE);
  assert.deepEqual(input.selectedCaseIds, manifest.selectedCaseIds);
  assert.deepEqual(input.order, manifest.order);
  assert.deepEqual(
    await fullInputManifest(docsRoot, input.profileId, input.suite, input.selectedCaseIds),
    manifest,
    'frozen_source_changed',
  );
  // The external schema names turns correctly; the shared legacy control retains its old field name.
  assert.equal(input.maxLogicalTurns, manifest.order.length);
  const allowance = fullAllowance(
    { ...input, maxJudgedCases: input.maxLogicalTurns },
    manifest.order,
    Date.now(),
  );
  return {
    suite: FULL_SUITE,
    profileId: input.profileId,
    runId: input.runId,
    manifest,
    manifestSha256: input.inputManifestSha256,
    allowance,
  };
}
interface CaseSummary {
  caseId: CaseId;
  model: GeminiModel;
  stratum: string;
  expectedTurns: number;
  status: string;
  liveCaseStatus: string;
  semanticReview: string;
  liveCredit: false;
  turns: TurnSummary[];
}

/** Same provider/orchestrator/control as screen-8. Transport is explicitly injected; no key/file is read here. */
export async function runFullSuite(options: {
  docsRoot: string;
  outputDirectory: string;
  activation: FullActivation;
  apiKey: string;
  transport: typeof fetch;
  transportKind: 'injected_synthetic' | 'live_provider';
  clock?: EvaluationClock;
  injectedFixture?: 'generic_non_memory' | 'controlled_source_correction';
}) {
  const { activation } = options;
  assert.equal(activation.suite, FULL_SUITE, 'explicit_full_suite_required');
  const plan = await loadFullPlan(
    codeRoot,
    options.docsRoot,
    activation.profileId,
    activation.suite,
    activation.manifest.selectedCaseIds,
  );
  assert.deepEqual(
    await fullInputManifest(
      options.docsRoot,
      activation.profileId,
      activation.suite,
      plan.selectedCaseIds,
    ),
    activation.manifest,
    'frozen_source_changed',
  );
  assert.equal(
    sha256(JSON.stringify(activation.manifest, null, 2) + '\n'),
    activation.manifestSha256,
  );
  assert.ok(
    !options.clock || options.transportKind === 'injected_synthetic',
    'live_clock_override',
  );
  assert.ok(
    !options.injectedFixture || options.transportKind === 'injected_synthetic',
    'live_fixture_override',
  );
  const clock = options.clock ?? systemClock;
  const allowance = fullAllowance(activation.allowance, plan.order, clock.now());
  await mkdir(options.outputDirectory, { recursive: false });
  await writeExclusive(join(options.outputDirectory, 'inputs.json'), activation.manifest);
  const { journal, control } = await openControlledJournal(
    join(options.outputDirectory, 'dispatch.jsonl'),
    allowance,
    clock,
    plan.order,
  );
  const owned = new Map<string, { close(): Promise<void> }>([['journal', journal]]);
  const cleanupFailures: Awaited<ReturnType<typeof releaseOwned>> = [];
  let primaryFailure = false;
  async function release(keys: string[]) {
    const resources = keys.flatMap((key) => {
      const resource = owned.get(key);
      owned.delete(key);
      return resource ? [{ key, close: () => resource.close() }] : [];
    });
    const failures = await releaseOwned(resources);
    if (failures.length) control.stop('owned_resource_close_failed');
    cleanupFailures.push(...failures);
    return failures.length === 0;
  }
  const fixtures = new Map<string, Awaited<ReturnType<typeof materialize>>>();
  const selected = new Set(plan.selectedCaseIds);
  const timings = new Map<string, FullLatencyRow>();
  const live = options.transportKind === 'live_provider';
  const results: CaseSummary[] = FULL_CASE_IDS.flatMap((caseId) =>
    GEMINI_MODELS.map((model) => ({
      caseId,
      model,
      stratum: plan.cases.find((item) => item.id === caseId)!.stratum,
      expectedTurns: caseTurns(caseId),
      status: selected.has(caseId) ? 'NOT_RUN' : 'NOT_RUN_NOT_SELECTED',
      liveCaseStatus: 'NOT_RUN',
      semanticReview: live ? 'PENDING_INDEPENDENT_REVIEW' : 'NOT_SCORED_OFFLINE',
      liveCredit: false as const,
      turns: Array.from({ length: caseTurns(caseId) }, (_, index) => ({
        turnId: `${caseId}-T${String(index + 1).padStart(2, '0')}`,
        status: selected.has(caseId) ? 'NOT_RUN' : 'NOT_RUN_NOT_SELECTED',
      })),
    })),
  );
  const pairOrder = plan.order.filter((turn) => turn.turnNumber === 1);
  const lookup = (caseId: CaseId, model: GeminiModel) =>
    results.find((row) => row.caseId === caseId && row.model === model)!;
  const turnItem = (item: EvaluationCase, index: number): EvaluationCase =>
    item.id !== 'L25'
      ? item
      : {
          ...item,
          input: {
            ...item.input,
            prompt: plan.trajectory[index]!.prompt!,
            selectedRecipeExpectation: null,
          },
        };
  try {
    await control.record({
      event: 'full_campaign_context',
      suite: plan.suite,
      profile: plan.profile,
      runId: activation.runId,
      transportKind: options.transportKind,
      selectedCaseIds: plan.selectedCaseIds,
      order: plan.order,
      budget: plan.budget,
      fullBudget: plan.fullBudget,
      logicalTurnAllowance: allowance.maxJudgedCases,
      allowance,
      policy: activation.manifest.campaignPolicy,
    });
    // Every selected setup is admitted before transport. Each real file is closed immediately.
    for (const [index, pair] of pairOrder.entries()) {
      const row = lookup(pair.caseId, pair.model);
      const key = `${pair.caseId}:${pair.model}`;
      let fixture: Awaited<ReturnType<typeof materialize>> | undefined;
      let persistingEvidence = false;
      try {
        fixture = await materialize(
          join(options.outputDirectory, `state-${index + 1}-${pair.caseId}`),
          turnItem(plan.cases.find((item) => item.id === pair.caseId)!, 0),
          { fullSuite: true },
        );
        owned.set(key, fixture);
        const adapted = declaredAdapter(fixture, pair.caseId);
        persistingEvidence = true;
        await writeExclusive(join(options.outputDirectory, `setup-${index + 1}.json`), {
          ...pair,
          ...adapted.artifact,
        });
        await control.record({
          event: 'full_setup_verified',
          ...pair,
          artifact: `setup-${index + 1}.json`,
        });
        fixtures.set(key, fixture);
      } catch (error) {
        if (error instanceof SetupCleanupFailure) {
          control.stop('owned_resource_close_failed');
          cleanupFailures.push({ key, reason: 'owned_resource_close_failed' });
        }
        if (persistingEvidence) control.stop('evidence_write_failed');
        row.status = 'BLOCKED_SETUP';
        row.turns.forEach((turn) => {
          turn.status = 'BLOCKED_SETUP';
        });
        await control.record({
          event: 'full_setup_blocked',
          ...pair,
          reason: error instanceof Error ? error.message.slice(0, 240) : 'setup_failure',
        });
      } finally {
        if (!(await release([key]))) {
          row.status = 'BLOCKED_CLEANUP';
          row.turns.forEach((turn) => {
            turn.status = 'BLOCKED_CLEANUP';
          });
        }
      }
      if (control.globalStop) break;
    }
    for (const [pairIndex, pair] of pairOrder.entries()) {
      const row = lookup(pair.caseId, pair.model);
      const fixture = fixtures.get(`${pair.caseId}:${pair.model}`);
      if (control.globalStop || control.stoppedCandidates.has(pair.model)) {
        if (row.status.startsWith('BLOCKED')) continue;
        row.status = 'NOT_RUN_STOPPED';
        row.turns.forEach((turn) => {
          turn.status = 'NOT_RUN_STOPPED';
          turn.reason = control.globalStop ?? 'candidate_stopped';
        });
        continue;
      }
      if (!fixture) continue;
      // A trajectory never starts unless its complete finite worst-case HTTP reservation fits.
      if (
        pair.caseId === 'L25' &&
        (control.attempts.length + 28 * 5 > allowance.maxHttpRequests ||
          control.attempts.filter((attempt) => attempt.model === pair.model).length + 28 * 5 >
            allowance.maxHttpRequestsPerModel[pair.model])
      ) {
        row.status = 'BLOCKED_TRAJECTORY_BUDGET';
        row.turns.forEach((turn) => {
          turn.status = 'BLOCKED_TRAJECTORY_BUDGET';
        });
        continue;
      }
      const requests: AssistantTurnRequest[] = [];
      try {
        await fixture.resume();
        owned.set(`${pair.caseId}:${pair.model}`, fixture);
        for (let index = 0; index < row.expectedTurns; index++) {
          const summary = row.turns[index]!;
          if (control.globalStop || control.stoppedCandidates.has(pair.model)) {
            summary.status = 'NOT_RUN_STOPPED';
            continue;
          }
          if (pair.caseId === 'L25' && index === 27) {
            const reopen = await fixture.reopen('2026-09-29');
            await writeExclusive(
              join(options.outputDirectory, `reopen-${pair.model}.json`),
              reopen,
            );
          }
          const item = turnItem(
            plan.cases.find((candidate) => candidate.id === pair.caseId)!,
            index,
          );
          await fixture.prepareTurn(item);
          const result = await judgeCase({
            item,
            model: pair.model,
            fixture: declaredAdapter(fixture, pair.caseId),
            control,
            apiKey: options.apiKey,
            transport: options.transport,
            turnId: summary.turnId,
          });
          if (row.expectedTurns === 1)
            timings.set(`${pair.caseId}:${pair.model}`, {
              caseId: pair.caseId,
              model: pair.model,
              status: result.status,
              elapsedMs: result.elapsedMs,
              queueWaitMs: result.queueWaitMs,
            });
          const sent = result.rounds[0]?.input.request;
          if (sent) requests.push(sent);
          row.liveCaseStatus = live ? 'ATTEMPTED_UNVERIFIED' : 'NOT_RUN';
          const artifact = `${String(pairIndex + 1).padStart(2, '0')}-${summary.turnId}-${pair.model}.json`;
          await publishTurnEvidence(options.outputDirectory, artifact, summary, result, {
            ...result,
            transportKind: options.transportKind,
            liveCaseStatus: live ? result.status : 'NOT_RUN',
            semanticReview: live ? 'PENDING_INDEPENDENT_REVIEW' : 'NOT_SCORED_OFFLINE',
            liveCredit: false,
          });
          if (result.status !== 'REVIEW_PENDING') {
            row.turns.slice(index + 1).forEach((turn) => {
              turn.status = 'BLOCKED_PREVIOUS_TRAJECTORY_TURN';
            });
            break;
          }
        }
        if (pair.caseId === 'L25') {
          const final = requests.length === 28 ? requests[27]! : null;
          const originalIds = requests.slice(0, 2).map((request) => request.message.messageId);
          const recentRestatementCandidates =
            final?.context.history.filter((message) =>
              /peanut|2026-10-0[56]|5 October|6 October|Tuesday|Monday|dinner/i.test(message.text),
            ) ?? [];
          await writeExclusive(join(options.outputDirectory, `trajectory-${pair.model}.json`), {
            transportKind: options.transportKind,
            actualOutboundTurns: requests.length,
            originalIds,
            originalMessagesOutsideRecentHistory: final
              ? originalIds.every(
                  (id) => !final.context.history.some((message) => message.messageId === id),
                )
              : null,
            finalOutboundContext: final?.context ?? null,
            recentRestatementCandidates,
            oldMemoryAttribution: !live
              ? 'NOT_ESTABLISHED_OFFLINE'
              : recentRestatementCandidates.length
                ? 'INCONCLUSIVE_RECENT_RESTATEMENT_REQUIRES_REVIEW'
                : 'PENDING_SOURCE_AND_RELATION_REVIEW',
            reviewNote:
              'The candidate scan is not a semantic detector. Review every recent user and assistant message for paraphrased restriction/date/meal restatements. Missing retained memory is preserved, never injected.',
            appState: await fixture.snapshot(),
            nativeStatus: 'NOT_RUN',
            liveCredit: false,
          });
        }
        row.status = row.turns.every((turn) => turn.status === 'REVIEW_PENDING')
          ? 'REVIEW_PENDING'
          : 'BLOCKED_INCOMPLETE_CASE';
        row.liveCaseStatus = live ? row.status : 'NOT_RUN';
      } catch {
        const evidenceFailed = row.turns.some(
          (turn) => turn.status === 'ATTEMPTED_EVIDENCE_FAILURE',
        );
        control.stop(evidenceFailed ? 'evidence_write_failed' : 'full_case_or_evidence_failure');
        const forwarded = control.attempts.some(
          (attempt) =>
            attempt.caseId === pair.caseId &&
            attempt.model === pair.model &&
            attempt.state !== 'reserved',
        );
        row.status = evidenceFailed
          ? 'ATTEMPTED_EVIDENCE_FAILURE'
          : forwarded
            ? 'ATTEMPTED_EXECUTION_FAILURE'
            : 'BLOCKED_EXECUTION';
        row.liveCaseStatus = live && forwarded ? 'ATTEMPTED_INCOMPLETE' : 'NOT_RUN';
        const timing = timings.get(`${pair.caseId}:${pair.model}`);
        if (timing) timing.status = row.status;
        for (const turn of row.turns)
          if (turn.status === 'NOT_RUN') {
            const attempted = control.attempts.some(
              (attempt) =>
                attempt.turnId === turn.turnId &&
                attempt.model === pair.model &&
                attempt.state !== 'reserved',
            );
            turn.status = attempted ? 'ATTEMPTED_EXECUTION_FAILURE' : 'NOT_RUN_STOPPED';
            turn.reason = control.globalStop ?? 'execution_failure';
          }
      } finally {
        if (!(await release([`${pair.caseId}:${pair.model}`]))) {
          row.status = 'BLOCKED_CLEANUP';
          if (live && row.liveCaseStatus !== 'NOT_RUN') row.liveCaseStatus = 'ATTEMPTED_INCOMPLETE';
          const timing = timings.get(`${pair.caseId}:${pair.model}`);
          if (timing) timing.status = row.status;
        }
      }
    }
    // Close all owners, including the journal, before publishing the terminal report.
    await release([...owned.keys()]);
    assert.deepEqual(
      await fullInputManifest(
        options.docsRoot,
        activation.profileId,
        activation.suite,
        plan.selectedCaseIds,
      ),
      activation.manifest,
      'run_inputs_changed',
    );
    const generations = control.attempts.filter((attempt) => attempt.operation === 'generation');
    const usage = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, unknownAttempts: 0 };
    for (const attempt of generations) {
      usage.inputTokens += attempt.reportedUsage?.inputTokens ?? 0;
      usage.outputTokens += attempt.reportedUsage?.outputTokens ?? 0;
      usage.thoughtTokens += attempt.reportedUsage?.thoughtTokens ?? 0;
      if (attempt.reportedUsage?.status !== 'KNOWN') usage.unknownAttempts++;
    }
    const report = {
      kind: 'cookmate-full-suite-campaign',
      suite: FULL_SUITE,
      runId: activation.runId,
      profile: plan.profile,
      transportKind: options.transportKind,
      campaignPolicy: activation.manifest.campaignPolicy,
      selectedCaseIds: plan.selectedCaseIds,
      injectedFixture: options.injectedFixture ?? null,
      inputManifestSha256: activation.manifestSha256,
      fullBudget: plan.fullBudget,
      selectedBudget: plan.budget,
      logicalTurnAllowance: allowance.maxJudgedCases,
      allowance,
      admittedLogicalTurns: control.admittedCases,
      denominators: {
        casesPerModel: 48,
        logicalTurnsPerModel: 75,
        casesBothModels: 96,
        logicalTurnsBothModels: 150,
        casesPerStratumPerModel: 6,
      },
      results,
      attempts: control.attempts,
      admission: control.admission,
      reportedUsage: usage,
      latency: {
        measurementScope: live
          ? 'DESKTOP_GATEWAY_LOGICAL_COMPLETION'
          : 'INJECTED_CLOCK_PLUMBING_ONLY',
        candidates: summarizeFullLatency(
          results.map((row) => timings.get(`${row.caseId}:${row.model}`) ?? row),
        ),
      },
      accountingNote:
        'Reservations are planning arithmetic, not incurred usage, spend or billing bounds. Unknown usage remains unknown. A selected segment is an independent partial campaign; results are never automatically resumed or pooled.',
      globalStop: control.globalStop,
      cleanupFailures,
      terminalStatus: cleanupFailures.length
        ? 'BLOCKED_CLEANUP'
        : control.globalStop
          ? 'STOPPED'
          : 'COMPLETE_UNSCORED',
      stoppedCandidates: [...control.stoppedCandidates],
      chargedHttpAttempts: control.attempts.length,
      sdkHttpAttempts: control.attempts.filter((attempt) => attempt.state !== 'reserved').length,
      liveProviderRequests: live
        ? control.attempts.filter((attempt) => attempt.state !== 'reserved').length
        : 0,
      semanticReview: live ? 'PENDING_INDEPENDENT_REVIEW' : 'NOT_SCORED_OFFLINE',
      liveCredit: false,
      nativeStatus: 'NOT_RUN',
    };
    await writeExclusive(join(options.outputDirectory, 'report.json'), report);
    return report;
  } catch (error) {
    primaryFailure = true;
    control.stop('full_campaign_terminal_failure');
    throw error;
  } finally {
    await release([...owned.keys()]);
    if (primaryFailure) {
      // Best effort only: preserve the primary failure even if the filesystem is unavailable.
      try {
        await writeExclusive(join(options.outputDirectory, 'terminal-failure.json'), {
          status: 'BLOCKED_TERMINAL_FAILURE',
          reason: control.globalStop,
          cleanupFailures,
          results,
          attempts: control.attempts,
          liveCredit: false,
          semanticReview: live ? 'PENDING_INDEPENDENT_REVIEW' : 'NOT_SCORED_OFFLINE',
        });
      } catch {
        /* The existing journal/partial artifacts remain the only available evidence. */
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, activationPath, docsRoot, output] = process.argv.slice(2);
  if (
    mode !== '--execute-full-suite' ||
    !activationPath ||
    !docsRoot ||
    !output ||
    process.argv.length !== 6
  )
    throw new Error('explicit_full_suite_activation_required_LIVE_HOLD');
  const activation = await verifyFullActivation(resolve(activationPath), resolve(docsRoot));
  await claimActivation(resolve(activationPath), activation.runId, resolve(output));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('explicit_GEMINI_API_KEY_required');
  const report = await runFullSuite({
    docsRoot: resolve(docsRoot),
    outputDirectory: resolve(output),
    activation,
    apiKey,
    transport: fetch,
    transportKind: 'live_provider',
  });
  process.stdout.write(
    JSON.stringify({
      cases: report.results.length,
      turns: report.admittedLogicalTurns,
      liveProviderRequests: report.liveProviderRequests,
      stop: report.globalStop,
    }) + '\n',
  );
}
