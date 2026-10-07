import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { gatewayError } from './errors';
import { GEMINI_MODELS } from './gemini';
import type { GeminiModel } from './gemini';
import { LIMITS } from './limits';
import { SYSTEM_INSTRUCTION } from './provider-contract';
import { MODEL_RESPONSE_SCHEMA, PROVIDER_ENVELOPE_SCHEMA } from './provider-schema';
import {
  runSyntheticShapeDiagnostic,
  serializeSyntheticShapeDiagnostic,
} from './synthetic-shape-diagnostic';

// Application-owned instructions only. The complete local contract is supplied verbatim;
// no reduced provider grammar or model-controlled schema is substituted here.
export const JSON_MODE_ENVELOPE_SCHEMA_TEXT = JSON.stringify({
  type: 'object',
  properties: { step: MODEL_RESPONSE_SCHEMA },
  required: ['step'],
  additionalProperties: false,
});
export const JSON_MODE_SYSTEM_INSTRUCTION = `${SYSTEM_INSTRUCTION}
Transport output contract: return exactly one JSON object with exactly one property, "step". Its value is the retrieve or respond step described above. The complete application-owned JSON Schema below defines this envelope and all allowed step fields. Follow the matching union branch exactly; do not merge branches, omit required fields, add fields, or use markdown fences. The application will validate the unchanged result against this full contract and the supplied request.
${JSON_MODE_ENVELOPE_SCHEMA_TEXT}`;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Isolated fixed-fictional proof. No calls on import, production option, automatic fallback,
 * custom prompt/context, endpoint override or runtime schema conversion is introduced. */
export async function runJsonModeProof(options: {
  apiKey: string;
  model: GeminiModel;
  fetch?: typeof fetch;
}) {
  let countedInput: string | null = null;
  let physicalRequests = 0;
  let invariantFailed = false;
  const invariants = {
    preflightCountedPromptOnce: false,
    generationMatchedCountedPrompt: false,
    schemaFieldOmitted: false,
    onlyIntendedFieldsChanged: false,
  };
  function invariant(condition: unknown): asserts condition {
    if (!condition) {
      invariantFailed = true;
      throw gatewayError('invalid_model_result', 502, 'never');
    }
  }
  const report = await runSyntheticShapeDiagnostic({
    apiKey: options.apiKey,
    model: options.model,
    fetch: async (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      const url = input instanceof Request ? input.url : String(input);
      const preflight =
        url ===
        `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:countTokens`;
      invariant(
        preflight || url === 'https://generativelanguage.googleapis.com/v1beta/interactions',
      );
      invariant((init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'POST');
      invariant(init?.redirect === 'error');
      invariant(physicalRequests === (preflight ? 0 : 1));
      const body =
        typeof init?.body === 'string'
          ? init.body
          : input instanceof Request && init?.body == null
            ? await input.clone().text()
            : null;
      invariant(body !== null);
      const parsed = JSON.parse(body);
      invariant(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
      invariant(JSON.stringify(parsed) === body);
      let outgoing: string;
      if (preflight) {
        const prompt = parsed.contents?.[0]?.parts?.[1]?.text;
        invariant(typeof prompt === 'string');
        const originalParts = [
          { text: SYSTEM_INSTRUCTION },
          { text: prompt },
          { text: JSON.stringify(PROVIDER_ENVELOPE_SCHEMA) },
        ];
        invariant(
          isDeepStrictEqual(parsed, { contents: [{ role: 'user', parts: originalParts }] }),
        );
        // The actual generation instruction (including full schema) is counted once.
        // There is no separate schema text part; the existing 256 framing reserve remains.
        parsed.contents[0].parts = [{ text: JSON_MODE_SYSTEM_INSTRUCTION }, { text: prompt }];
        outgoing = JSON.stringify(parsed);
        const restored = JSON.parse(outgoing);
        restored.contents[0].parts = originalParts;
        invariant(JSON.stringify(restored) === body);
        countedInput = prompt;
        invariants.preflightCountedPromptOnce = true;
      } else {
        invariant(countedInput !== null);
        invariant(
          isDeepStrictEqual(parsed, {
            model: options.model,
            input: countedInput,
            system_instruction: SYSTEM_INSTRUCTION,
            store: false,
            stream: false,
            generation_config: { max_output_tokens: LIMITS.outputTokens },
            response_format: {
              type: 'text',
              mime_type: 'application/json',
              schema: PROVIDER_ENVELOPE_SCHEMA,
            },
          }),
        );
        parsed.system_instruction = JSON_MODE_SYSTEM_INSTRUCTION;
        delete parsed.response_format.schema;
        outgoing = JSON.stringify(parsed);
        const restored = JSON.parse(outgoing);
        restored.system_instruction = SYSTEM_INSTRUCTION;
        restored.response_format.schema = PROVIDER_ENVELOPE_SCHEMA;
        invariant(JSON.stringify(restored) === body);
        invariants.generationMatchedCountedPrompt = true;
        invariants.schemaFieldOmitted = true;
        invariants.onlyIntendedFieldsChanged = true;
      }
      signal?.throwIfAborted();
      physicalRequests++;
      return (options.fetch ?? fetch)(input, { ...init, body: outgoing });
    },
  });
  return {
    ...report,
    kind: 'cookmate-fixed-fictional-json-mode-proof',
    transportMode: 'mime_only_json',
    physicalRequests,
    invariantFailed,
    invariants,
    fullEnvelopeSchemaSha256: digest(JSON_MODE_ENVELOPE_SCHEMA_TEXT),
    systemInstructionSha256: digest(JSON_MODE_SYSTEM_INSTRUCTION),
    systemInstructionBytes: Buffer.byteLength(JSON_MODE_SYSTEM_INSTRUCTION, 'utf8'),
    caveat:
      'Isolated JSON-mode proof only. MIME requests JSON, not schema conformance. Full local validation, request-aware normalization and exact source quote/review remain required. Success does not establish general model quality or authorize production activation.',
  };
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
  const evidence = await open(resolve(args[5]!), 'wx');
  let report;
  try {
    report = await runJsonModeProof({
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
      invariantFailed: report.invariantFailed,
      capturedOutputs: report.capturedOutputs,
      cases: report.cases.map(({ disposition, code }) => ({ disposition, code })),
    }) + '\n',
  );
  if (report.invariantFailed || report.cases.some((item) => item.disposition !== 'PASS'))
    process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.stderr.write(
      'JSON-mode proof failed; inspect redacted evidence if written. No raw diagnostic was logged.\n',
    );
    process.exitCode = 1;
  });
}
