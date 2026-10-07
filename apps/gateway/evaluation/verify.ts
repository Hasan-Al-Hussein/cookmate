import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderInput } from '../src/provider-contract';
import { inputManifest } from './prepare';
import { runScreen } from './runner';
import type { EvaluationAllowance } from './control';

/** Plumbing verification only: deliberately generic replies are never semantic case answers. */
export async function verifyOfflineRunner(
  docsRoot: string,
  outputDirectory: string,
  profileId: string,
  allocation?: EvaluationAllowance,
) {
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const manifest = await inputManifest(codeRoot, docsRoot, profileId);
  let now = Date.now();
  const allowance = allocation ?? {
    maxHttpRequests: 80,
    maxJudgedCases: 16,
    maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 40, 'gemini-3.8-flash': 40 },
    quietPeriodMs: 65_000,
    expiresAt: now + 3_600_000,
  };
  let fakeHttpCalls = 0;
  let fakeGenerations = 0;
  const transport: typeof fetch = async (url, init) => {
    fakeHttpCalls++;
    const address = url instanceof Request ? url.url : String(url);
    if (address.endsWith(':countTokens')) return Response.json({ totalTokens: 200 });
    fakeGenerations++;
    const body = JSON.parse(
      String(init?.body ?? (url instanceof Request ? await url.clone().text() : '')),
    );
    const input = JSON.parse(body.input) as ProviderInput;
    const step = {
      kind: 'respond',
      sufficiency: 'irrelevant',
      missingFacts: [],
      response: {
        kind: 'answer',
        text: 'Offline harness plumbing response. Semantic expectations are not scored.',
        sources: [],
        recipeIds: [],
      },
      memoryUpdate: {
        baseRevision: input.request.context.memory.projectionRevision,
        baseContextRevision: input.request.context.memory.baseContextRevision,
        reviews: input.request.context.memory.reviewTargetMessageIds.map((sourceMessageId) => ({
          sourceMessageId,
          disposition: 'non_memory',
        })),
        entries: [],
      },
    };
    return Response.json({
      id: 'offline-fixture-interaction',
      model: body.model,
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ step }) }] },
      ],
      usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 0 },
    });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline_network_denied');
  };
  try {
    const report = await runScreen({
      profileId,
      docsRoot,
      outputDirectory,
      apiKey: 'FICTIONAL_EVALUATION_MARKER',
      transport,
      transportKind: 'injected_synthetic',
      clock: {
        now: () => now,
        sleep: async (milliseconds, signal) => {
          signal.throwIfAborted();
          now += milliseconds;
        },
      },
      activation: {
        allowance,
        profileId: manifest.profile.id,
        runId: 'cookmate-screen-offline-plumbing',
        manifest,
        manifestSha256: createHash('sha256')
          .update(JSON.stringify(manifest, null, 2) + '\n')
          .digest('hex'),
      },
    });
    assert.ok(report.globalStop === null || report.globalStop === 'evaluation_allowance_exhausted');
    if (!allocation) {
      assert.equal(report.globalStop, null);
      assert.equal(fakeHttpCalls, 32);
    }
    assert.equal(report.results.length, 16);
    assert.equal(report.sdkHttpAttempts, fakeHttpCalls);
    assert.equal(fakeHttpCalls, fakeGenerations * 2);
    assert.equal(report.admittedCases, fakeGenerations);
    assert.equal(report.liveProviderRequests, 0);
    assert.equal(report.reportedUsage.unknownAttempts, 0);
    assert.equal(report.admission.reservedInputTokens, fakeGenerations * 12_000);
    assert.equal(report.admission.reservedOutputAndThoughtTokens, fakeGenerations * 2_000);
    return report;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, profileId, docsRoot, outputDirectory] = process.argv.slice(2);
  if (
    mode !== '--offline' ||
    !profileId ||
    !docsRoot ||
    !outputDirectory ||
    process.argv.length !== 6
  )
    throw new Error('usage: verify.ts --offline <profile-id> <docs-root> <new-output-directory>');
  const report = await verifyOfflineRunner(resolve(docsRoot), resolve(outputDirectory), profileId);
  process.stdout.write(
    JSON.stringify({
      cases: report.results.length,
      injectedSdkHttpAttempts: report.sdkHttpAttempts,
      liveProviderRequests: report.liveProviderRequests,
      semanticCredit: 0,
    }) + '\n',
  );
}
