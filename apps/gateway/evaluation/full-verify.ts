import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderInput } from '../src/provider-contract';
import { fullInputManifest, runFullSuite } from './full-runner';
import { FULL_CASE_IDS, FULL_SUITE, fullOrder, budgetFor } from './full-plan';
import type { CaseId } from './plan';
import { sha256 } from './plan';
import type { EvaluationAllowance } from './control';

export function offlineFullTransport(
  fault?: { generation: number; status: number },
  memoryMode: 'generic_non_memory' | 'controlled_source_correction' = 'generic_non_memory',
) {
  const calls: { model: string; operation: string; requestId?: string }[] = [];
  const conversations = new Map<string, string[]>();
  const transport: typeof fetch = async (url, init) => {
    const address = url instanceof Request ? url.url : String(url);
    if (address.endsWith(':countTokens')) {
      calls.push({ model: address.match(/models\/([^:]+)/)![1]!, operation: 'preflight' });
      return Response.json({ totalTokens: 200 });
    }
    const body = JSON.parse(
      String(init?.body ?? (url instanceof Request ? await url.clone().text() : '')),
    );
    const input: ProviderInput = JSON.parse(body.input);
    const requests = conversations.get(input.request.conversationId) ?? [];
    if (!requests.includes(input.request.requestId)) requests.push(input.request.requestId);
    conversations.set(input.request.conversationId, requests);
    const logicalTurn = requests.indexOf(input.request.requestId) + 1;
    const retain = memoryMode === 'controlled_source_correction' && logicalTurn <= 2;
    const previous = input.request.context.memory.items[0];
    if (retain && logicalTurn === 2) assert.ok(previous, 'controlled_correction_source_missing');
    calls.push({ model: body.model, operation: 'generation', requestId: input.request.requestId });
    if (
      fault &&
      calls.filter((call) => call.operation === 'generation').length === fault.generation
    )
      return Response.json(
        { error: { code: 'too_many_requests', message: 'Offline injected failure' } },
        { status: fault.status },
      );
    // Exercise L48's actual second retrieval through the unchanged production orchestrator.
    const isIncompleteChicken =
      input.remainingRetrievalRounds > 0 &&
      input.retrieval.some(
        (selection) =>
          selection.kind === 'search' &&
          selection.criteria.category === 'Chicken' &&
          !selection.resultSetFullyReturned,
      );
    const step = isIncompleteChicken
      ? {
          kind: 'retrieve',
          criteria: { query: 'Padron peppers' },
          recipeIds: [],
          requiredFacts: ['ingredient rows'],
        }
      : {
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
              disposition: retain ? 'retain' : 'non_memory',
            })),
            entries: retain
              ? [
                  {
                    sourceMessageId: input.request.message.messageId,
                    kind: logicalTurn === 1 ? 'constraint' : 'correction',
                    scope: { kind: 'conversation' },
                    relations:
                      previous && logicalTurn === 2
                        ? [
                            {
                              kind: 'supersedes',
                              target: {
                                kind: 'memory',
                                memoryId: previous.memoryId,
                                expectedRevision: previous.revision,
                              },
                            },
                          ]
                        : [],
                  },
                ]
              : [],
          },
        };
    return Response.json({
      id: 'offline-full-fixture',
      model: body.model,
      status: 'completed',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ step }) }] },
      ],
      usage: { total_input_tokens: 100, total_output_tokens: 20, total_thought_tokens: 0 },
    });
  };
  return { transport, calls };
}
export async function verifyFullOffline(
  docsRoot: string,
  outputDirectory: string,
  profileId: string,
  batch: CaseId[],
  allocation?: EvaluationAllowance,
  fault?: { generation: number; status: number },
  memoryMode: 'generic_non_memory' | 'controlled_source_correction' = 'generic_non_memory',
) {
  if (memoryMode === 'controlled_source_correction')
    assert.deepEqual(batch, ['L25'], 'controlled_memory_sidecar_requires_L25_only');
  const manifest = await fullInputManifest(docsRoot, profileId, FULL_SUITE, batch);
  const budget = budgetFor(fullOrder(batch));
  let now = Date.now();
  const allowance = allocation ?? {
    maxJudgedCases: budget.logicalTurns,
    maxHttpRequests: budget.httpRequests,
    maxHttpRequestsPerModel: {
      'gemini-3.5-flash-lite': budget.perModel['gemini-3.5-flash-lite'] * 5,
      'gemini-3.8-flash': budget.perModel['gemini-3.8-flash'] * 5,
    },
    quietPeriodMs: 65_000,
    expiresAt: now + 8 * 3_600_000,
  };
  const fake = offlineFullTransport(fault, memoryMode);
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline_network_denied');
  };
  try {
    const report = await runFullSuite({
      docsRoot,
      outputDirectory,
      apiKey: 'FICTIONAL_EVALUATION_MARKER',
      transport: fake.transport,
      transportKind: 'injected_synthetic',
      injectedFixture: memoryMode,
      clock: {
        now: () => now,
        sleep: async (milliseconds, signal) => {
          signal.throwIfAborted();
          now += milliseconds;
        },
      },
      activation: {
        suite: FULL_SUITE,
        profileId,
        runId: 'cookmate-full-offline-plumbing',
        manifest,
        manifestSha256: sha256(JSON.stringify(manifest, null, 2) + '\n'),
        allowance,
      },
    });
    assert.equal(report.results.length, 96);
    assert.equal(report.sdkHttpAttempts, fake.calls.length);
    assert.equal(report.liveProviderRequests, 0);
    assert.equal(report.semanticReview, 'NOT_SCORED_OFFLINE');
    assert.ok(
      report.results.every((row) => row.liveCaseStatus === 'NOT_RUN' && row.liveCredit === false),
    );
    return report;
  } finally {
    globalThis.fetch = original;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, profileId, docsRoot, output, selection] = process.argv.slice(2);
  if (
    mode !== '--offline-full' ||
    !profileId ||
    !docsRoot ||
    !output ||
    !selection ||
    process.argv.length !== 7
  )
    throw new Error(
      'usage: full-verify.ts --offline-full <profile> <docs-root> <new-output> <all|L01,L02,...>',
    );
  const report = await verifyFullOffline(
    resolve(docsRoot),
    resolve(output),
    profileId,
    selection === 'all' ? FULL_CASE_IDS : (selection.split(',') as CaseId[]),
  );
  process.stdout.write(
    JSON.stringify({
      cases: report.results.length,
      turns: report.admittedLogicalTurns,
      injectedSdkHttpAttempts: report.sdkHttpAttempts,
      liveProviderRequests: 0,
      statuses: report.results.reduce<Record<string, number>>((counts, row) => {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
        return counts;
      }, {}),
      stop: report.globalStop,
    }) + '\n',
  );
  if (
    report.globalStop ||
    report.results.some((row) => !['REVIEW_PENDING', 'NOT_RUN_NOT_SELECTED'].includes(row.status))
  )
    process.exitCode = 1;
}
