import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayError } from './errors';
import { GEMINI_MODELS } from './gemini';
import type { GeminiModel } from './gemini';
import { runJsonModeProof } from './json-mode-proof';
import { LIMITS } from './limits';
import { serializeSyntheticShapeDiagnostic } from './synthetic-shape-diagnostic';

const CAPTURE_BYTES = 32 * 1024;
type TextStatus =
  | 'included'
  | 'not_observed'
  | 'omitted_ambiguous_output'
  | 'omitted_unverified_output'
  | 'omitted_sensitive_marker'
  | 'omitted_ambiguous_encoding'
  | 'omitted_too_large'
  | 'omitted_shared_capture_limit';
interface TextCapture {
  status: TextStatus;
  generatedText: string | null;
  originalTextBytes: number | null;
  sanitizedTextBytes: number | null;
  serializedTextBytes: number | null;
  redactionCount: number;
}
const omitted = (status: TextStatus): TextCapture => ({
  status,
  generatedText: null,
  originalTextBytes: null,
  sanitizedTextBytes: null,
  serializedTextBytes: null,
  redactionCount: 0,
});

/** Only an extracted fixed-fictional model text part may enter this sanitizer.
 * It never parses, trims, repairs or feeds the text back to the provider path. */
export function sanitizeFictionalGeneratedText(text: string, apiKey: string): TextCapture {
  const result = omitted('omitted_too_large');
  result.originalTextBytes = Buffer.byteLength(text, 'utf8');
  if (result.originalTextBytes > LIMITS.providerResponseBytes) return result;
  let sanitized = text;
  for (const credential of new Set([apiKey, JSON.stringify(apiKey).slice(1, -1)])) {
    if (!credential) continue;
    const parts = sanitized.split(credential);
    result.redactionCount += parts.length - 1;
    sanitized = parts.join('[REDACTED]');
  }
  for (const pattern of [
    /AIza[A-Za-z0-9_-]{35}/g,
    /\bsk-[A-Za-z0-9_-]+/g,
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  ])
    sanitized = sanitized.replace(pattern, () => {
      result.redactionCount++;
      return '[REDACTED]';
    });
  // Malformed JSON is not parsed to discover secret fields. Omit conservatively
  // when labels or encoded characters could hide credentials from literal matching.
  if (/\\(?:[ux]|[0-7])/i.test(sanitized)) {
    result.status = 'omitted_ambiguous_encoding';
    return result;
  }
  if (
    /authorization|authentication|bearer|api[\s_-]*key|token|password|passwd|secret|credential|private[\s_-]*key|passphrase|cookie|connection[\s_-]*string|\b(?:auth|pwd|key)\b/i.test(
      sanitized,
    )
  ) {
    result.status = 'omitted_sensitive_marker';
    return result;
  }
  result.sanitizedTextBytes = Buffer.byteLength(sanitized, 'utf8');
  result.serializedTextBytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
  if (result.serializedTextBytes <= CAPTURE_BYTES) {
    result.status = 'included';
    result.generatedText = sanitized;
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A single step/part is intentionally narrower than the SDK's general selector.
 * For this shape the SDK output_text is exactly this string, without trimming. */
function extractText(value: unknown, model: GeminiModel, apiKey: string): TextCapture {
  if (!record(value) || value.model !== model || value.status !== 'completed')
    return omitted('omitted_unverified_output');
  if (!Array.isArray(value.steps) || value.steps.length !== 1)
    return omitted('omitted_ambiguous_output');
  const step: unknown = value.steps[0];
  if (
    !record(step) ||
    step.type !== 'model_output' ||
    !Array.isArray(step.content) ||
    step.content.length !== 1
  )
    return omitted('omitted_ambiguous_output');
  const part: unknown = step.content[0];
  return record(part) && part.type === 'text' && typeof part.text === 'string'
    ? sanitizeFictionalGeneratedText(part.text, apiKey)
    : omitted('omitted_ambiguous_output');
}

/** No production edits or calls on import. The frozen JSON-mode proof owns the
 * fixed fixture, request transformation, two-call budget and all validation. */
export async function runJsonModeTextDiagnostic(options: {
  apiKey: string;
  model: GeminiModel;
  fetch?: typeof fetch;
}) {
  const capture = { text: omitted('not_observed') };
  const report = await runJsonModeProof({
    ...options,
    fetch: async (input, init) => {
      const response = await (options.fetch ?? fetch)(input, init);
      const url = input instanceof Request ? input.url : String(input);
      if (
        url !== 'https://generativelanguage.googleapis.com/v1beta/interactions' ||
        response.status !== 200 ||
        !response.body
      )
        return response;
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      let finished = false;
      let cancelled = false;
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        // Cancellation closes pending reads immediately. A custom underlying cancel
        // callback may never settle, so it must not hold the diagnostic open.
        void reader.cancel().catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          signal?.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > LIMITS.providerResponseBytes) {
            capture.text = omitted('omitted_too_large');
            throw gatewayError('invalid_model_result', 502, 'never');
          }
          chunks.push(next.value);
        }
        signal?.throwIfAborted();
        finished = true;
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (!finished) cancel();
        reader.releaseLock();
      }
      const body = Buffer.concat(chunks);
      try {
        // Only the HTTP envelope is decoded transiently. Generated text is never parsed here.
        capture.text = extractText(
          JSON.parse(body.toString('utf8')),
          options.model,
          options.apiKey,
        );
      } catch {
        capture.text = omitted('omitted_unverified_output');
      }
      // The normal SDK receives the original bytes; no generated-text repair is possible.
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
  const events = report.cases[0]?.diagnostics ?? [];
  const fidelity = events.find((event) => event.stage === 'text_fidelity_check');
  const verified =
    events.some((event) => event.stage === 'usage_check' && event.valid) &&
    events.some((event) => event.stage === 'json_check') &&
    fidelity?.stage === 'text_fidelity_check' &&
    fidelity.valid &&
    fidelity.modelOutputSteps === 1 &&
    fidelity.modelTextParts === 1 &&
    fidelity.selectedTextBytes === capture.text.originalTextBytes &&
    fidelity.allModelTextBytes === capture.text.originalTextBytes;
  if (capture.text.generatedText !== null && !verified)
    capture.text = { ...capture.text, status: 'omitted_unverified_output', generatedText: null };
  const parsedCaptureBytes =
    report.modelOutput?.generatedJson == null
      ? 0
      : Buffer.byteLength(JSON.stringify(report.modelOutput.generatedJson));
  if (
    capture.text.generatedText !== null &&
    parsedCaptureBytes + (capture.text.serializedTextBytes ?? CAPTURE_BYTES + 1) > CAPTURE_BYTES
  )
    capture.text = { ...capture.text, status: 'omitted_shared_capture_limit', generatedText: null };
  return {
    ...report,
    kind: 'cookmate-fixed-fictional-json-mode-text-diagnostic',
    generatedTextIsUntrustedData: true,
    textCapturePolicy: 'single_confirmed_model_text_part_fixed_fictional_only',
    combinedGeneratedCaptureByteLimit: CAPTURE_BYTES,
    modelText: capture.text,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== '--execute' ||
    args[1] !== '--capture-fictional-model-text' ||
    args[2] !== '--model' ||
    args[4] !== '--output' ||
    !GEMINI_MODELS.includes(args[3] as GeminiModel)
  )
    throw gatewayError('invalid_input', 400, 'never');
  const evidence = await open(resolve(args[5]!), 'wx');
  let report;
  try {
    report = await runJsonModeTextDiagnostic({
      apiKey: process.env.GEMINI_API_KEY ?? '',
      model: args[3] as GeminiModel,
    });
    await evidence.writeFile(serializeSyntheticShapeDiagnostic(report), 'utf8');
  } finally {
    await evidence.close();
  }
  process.stdout.write(
    JSON.stringify({
      physicalRequests: report.physicalRequests,
      textStatus: report.modelText.status,
      cases: report.cases.map(({ disposition, code }) => ({ disposition, code })),
    }) + '\n',
  );
  if (report.invariantFailed || report.cases.some((item) => item.disposition !== 'PASS'))
    process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.stderr.write(
      'Fictional text diagnostic failed; inspect sanitized evidence if written. No raw diagnostic was logged.\n',
    );
    process.exitCode = 1;
  });
}
