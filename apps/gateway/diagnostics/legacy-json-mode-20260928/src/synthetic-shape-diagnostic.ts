import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_MODELS } from './gemini';
import type { GeminiModel } from './gemini';
import { gatewayError } from './errors';
import { runMemorySmoke } from './memory-smoke';
import { summarizeSyntheticModelOutput } from './synthetic-output';
import type { SyntheticModelOutputSummary } from './synthetic-output';

/** Deliberately has no request/context parameter: only the fixed fictional smoke can be captured.
 * Provider errors, HTTP bodies/headers and SDK exception strings never reach this observer. */
export async function runSyntheticShapeDiagnostic(options: {
  apiKey: string;
  model: GeminiModel;
  fetch?: typeof fetch;
}) {
  const capture: { value: SyntheticModelOutputSummary | null; count: number } = {
    value: null,
    count: 0,
  };
  const smoke = await runMemorySmoke({
    apiKey: options.apiKey,
    models: [options.model],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    observeModelOutput(value) {
      if (capture.count >= 1) return;
      // Redaction and bounds apply before the generated value enters any retained report.
      capture.value = summarizeSyntheticModelOutput(value, options.apiKey);
      capture.count++;
    },
  });
  return {
    ...smoke,
    kind: 'cookmate-synthetic-memory-shape-diagnostic',
    bounds: { ...smoke.bounds, logicalTurns: 1, networkRequests: 2 },
    capturePolicy: 'fixed_fictional_fixture_only',
    generatedJsonIsUntrustedData: true,
    capturedOutputs: capture.count,
    modelOutput: capture.value,
  };
}

/** Keep captured JSON in the compact representation used by its byte-limit check. */
export function serializeSyntheticShapeDiagnostic(
  report: Awaited<ReturnType<typeof runSyntheticShapeDiagnostic>>,
): string {
  return JSON.stringify(report) + '\n';
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== '--execute' ||
    args[1] !== '--capture-fictional-model-json' ||
    args[2] !== '--model' ||
    args[4] !== '--output' ||
    !GEMINI_MODELS.includes(args[3] as GeminiModel)
  )
    throw gatewayError('invalid_input', 400, 'never');
  // Reserve a fresh evidence path before any paid call. Never overwrite an earlier observation.
  const evidence = await open(resolve(args[5]!), 'wx');
  let report;
  try {
    report = await runSyntheticShapeDiagnostic({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: args[3] as GeminiModel,
    });
    await evidence.writeFile(serializeSyntheticShapeDiagnostic(report), 'utf8');
  } finally {
    await evidence.close();
  }
  process.stdout.write(
    JSON.stringify({
      networkRequests: report.networkRequests,
      capturedOutputs: report.capturedOutputs,
      cases: report.cases.map(({ disposition, code }) => ({ disposition, code })),
    }) + '\n',
  );
  if (report.cases.some((item) => item.disposition !== 'PASS')) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.stderr.write(
      'Synthetic shape diagnostic failed; inspect redacted evidence if written. No raw diagnostic was logged.\n',
    );
    process.exitCode = 1;
  });
}
