import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import type { HttpOptions } from '@google/genai';
import {
  DIAGNOSTIC_BOUNDS,
  DIAGNOSTIC_MODEL,
  DIAGNOSTIC_PROMPT,
  DiagnosticStopped,
  inspectDiagnosticApprovalInputs,
} from './provider-diagnostic';
import type { DiagnosticApprovalInputs, OfflineDiagnosticClock } from './provider-diagnostic';
import type { SyntheticReportedUsage } from './capture';
import { observeEvaluationError } from './error-observer';
import type { EvaluationErrorMetadata } from './error-observer';

// Importing this file reads no environment, credentials, approvals or source files.
export const GENERATE_CONTENT_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent';
const CONTENTS = [{ parts: [{ text: DIAGNOSTIC_PROMPT }], role: 'user' }];
const CONFIG = { candidateCount: 1, maxOutputTokens: 256, responseMimeType: 'application/json' };
export const GENERATE_CONTENT_REQUEST_JSON = JSON.stringify({
  contents: CONTENTS,
  generationConfig: CONFIG,
});
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const NEW_SOURCES = [
  'apps/gateway/evaluation/generate-content-diagnostic.ts',
  'apps/gateway/evaluation/generate-content-diagnostic.test.ts',
];
type StopReason = DiagnosticStopped['reason'];
type SdkFetch = NonNullable<HttpOptions['fetch']>;
interface ApprovalInputs extends DiagnosticApprovalInputs {
  route: 'GENERATE_CONTENT';
}
export interface GenerateContentApproval extends ApprovalInputs {
  version: 1;
  authorization: 'ROOT_APPROVED_ONE_GENERATE_CONTENT_DIAGNOSTIC';
  runId: string;
  expiresAt: string;
  paths: { approval: string; result: string };
}
export async function inspectGenerateContentApprovalInputs(): Promise<ApprovalInputs> {
  const inputs = await inspectDiagnosticApprovalInputs();
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  for (const path of NEW_SOURCES)
    inputs.sourceDigests[path] = hash(await readFile(resolve(projectRoot, path)));
  return {
    ...inputs,
    route: 'GENERATE_CONTENT',
    requestSha256: hash(GENERATE_CONTENT_REQUEST_JSON),
  };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function checkExpiry(approval: GenerateContentApproval, now: number) {
  if (now >= Date.parse(approval.expiresAt)) throw new DiagnosticStopped('approval_expired');
}
async function readApproval(path: string, resultPath: string, now: number) {
  const handle = await open(path, 'r');
  let value: unknown;
  try {
    if ((await handle.stat()).size > 16_384) throw new DiagnosticStopped('approval_invalid');
    value = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  if (
    !object(value) ||
    typeof value.runId !== 'string' ||
    !/^generate-content-[0-9]{8}-[0-9]{2}$/.test(value.runId) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    throw new DiagnosticStopped('approval_invalid');
  const expected: GenerateContentApproval = {
    ...(await inspectGenerateContentApprovalInputs()),
    version: 1,
    authorization: 'ROOT_APPROVED_ONE_GENERATE_CONTENT_DIAGNOSTIC',
    runId: value.runId,
    expiresAt: value.expiresAt,
    paths: { approval: resolve(path), result: resolve(resultPath) },
  };
  if (
    canonical(value) !== canonical(expected) ||
    Buffer.byteLength(GENERATE_CONTENT_REQUEST_JSON) > 512
  )
    throw new DiagnosticStopped('approval_invalid');
  checkExpiry(expected, now);
  return expected;
}
/** Independent of SDK retry configuration; the first attempted dispatch consumes this guard. */
export function createGenerateContentDispatchGuard() {
  let used = false;
  return async (input: Parameters<SdkFetch>[0], init?: Parameters<SdkFetch>[1]) => {
    if (used) throw new DiagnosticStopped('dispatch_limit');
    used = true;
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    if (request.url !== GENERATE_CONTENT_ENDPOINT || request.method !== 'POST')
      throw new DiagnosticStopped('request_mismatch');
    const body = await request.text();
    if (Buffer.byteLength(body) > 512 || body !== GENERATE_CONTENT_REQUEST_JSON)
      throw new DiagnosticStopped('request_mismatch');
  };
}
const realClock: OfflineDiagnosticClock = {
  now: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal });
  },
};
type Options = { approvalPath: string; resultPath: string } & (
  | { mode: 'LIVE_DIAGNOSTIC'; environment: NodeJS.ProcessEnv }
  | { mode: 'OFFLINE_INJECTED'; clock: OfflineDiagnosticClock; fetch: SdkFetch; readKey(): string }
);
const FINISH_REASONS = [
  'STOP',
  'MAX_TOKENS',
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'OTHER',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MALFORMED_FUNCTION_CALL',
  'IMAGE_SAFETY',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'NO_IMAGE',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
  'IMAGE_OTHER',
] as const;
const unknownUsage = (): SyntheticReportedUsage => ({
  status: 'UNKNOWN',
  inputTokens: null,
  outputTokens: null,
  thoughtTokens: null,
});
export interface GenerateContentResult {
  version: 1;
  runId: string;
  mode: Options['mode'];
  route: 'GENERATE_CONTENT';
  returnTo: 'HOLD';
  outcome: 'VALIDATED_TINY_RESPONSE' | 'FAILED';
  stopReason: StopReason | null;
  dispatchReserved: boolean;
  physicalRequests: number;
  cleanup: 'SETTLED' | 'PENDING';
  httpStatus: number | null;
  completionReason: (typeof FINISH_REASONS)[number] | 'unknown';
  modelMatches: boolean | null;
  expectedJsonMatches: boolean | null;
  usage: SyntheticReportedUsage;
  errorMetadata: EvaluationErrorMetadata | null;
}
// This process-local lease stays held after the caller deadline until physical cleanup settles.
// It is not a cross-process lock; the exclusive consumed marker protects the individual run.
let physicalLease: object | null = null;
function acquireLease() {
  if (physicalLease) throw new DiagnosticStopped('dispatch_limit');
  const token = {};
  physicalLease = token;
  let pending = 0;
  let finished = false;
  let settled = false;
  const release = () => {
    if (finished && pending === 0) {
      settled = true;
      if (physicalLease === token) physicalLease = null;
    }
  };
  return {
    settled: () => settled,
    track(cleanup: Promise<unknown>) {
      pending++;
      void cleanup
        .catch(() => {})
        .finally(() => {
          pending--;
          release();
        });
    },
    finish() {
      finished = true;
      release();
    },
  };
}
type Lease = ReturnType<typeof acquireLease>;
function drop(response: Response, lease: Lease) {
  try {
    if (response.body) lease.track(response.body.cancel());
  } catch {
    /* Already closed. */
  }
}
async function boundedBytes(response: Response, signal: AbortSignal, lease: Lease) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let complete = false;
  let cancellationStarted = false;
  const cancel = () => {
    if (!cancellationStarted) {
      cancellationStarted = true;
      lease.track(reader.cancel());
    }
  };
  let rejectAbort!: (error: DiagnosticStopped) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const aborted = () => {
    cancel();
    rejectAbort(new DiagnosticStopped('deadline'));
  };
  signal.addEventListener('abort', aborted, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) throw new DiagnosticStopped('deadline');
    while (true) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (signal.aborted) throw new DiagnosticStopped('deadline');
      if (chunk.done) {
        complete = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > DIAGNOSTIC_BOUNDS.responseBytes) throw new DiagnosticStopped('response_limit');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener('abort', aborted);
    if (!complete) cancel();
    reader.releaseLock();
  }
}
function summarize(value: unknown, result: GenerateContentResult) {
  if (!object(value)) return;
  result.modelMatches = value.modelVersion === DIAGNOSTIC_MODEL;
  const candidates = value.candidates;
  const candidate =
    Array.isArray(candidates) && candidates.length === 1 && object(candidates[0])
      ? candidates[0]
      : null;
  const reason = candidate?.finishReason;
  result.completionReason = FINISH_REASONS.find((known) => known === reason) ?? 'unknown';
  const content = candidate?.content;
  const parts = object(content) && content.role === 'model' ? content.parts : null;
  const texts =
    Array.isArray(parts) &&
    parts.length > 0 &&
    parts.every(
      (part) =>
        object(part) &&
        typeof part.text === 'string' &&
        Object.keys(part).every((key) => key === 'text'),
    )
      ? parts.map((part: { text: string }) => part.text).join('')
      : null;
  let parsed: unknown;
  try {
    parsed = texts === null ? null : JSON.parse(texts);
  } catch {
    parsed = null;
  }
  result.expectedJsonMatches =
    object(parsed) && Object.keys(parsed).length === 1 && parsed.ok === true;
  const usage = value.usageMetadata;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (object(usage)) {
    const inputTokens = count(usage.promptTokenCount);
    const outputTokens = count(usage.candidatesTokenCount);
    const thoughtTokens = count(usage.thoughtsTokenCount);
    result.usage = {
      inputTokens,
      outputTokens,
      thoughtTokens,
      status:
        inputTokens !== null && outputTokens !== null && thoughtTokens !== null
          ? 'KNOWN'
          : 'UNKNOWN',
    };
  }
}

/** Root may execute later with a fresh route-specific approval. All tests inject fictional IO. */
export async function runGenerateContentDiagnostic(
  options: Options,
): Promise<GenerateContentResult> {
  if (
    !isAbsolute(options.approvalPath) ||
    !isAbsolute(options.resultPath) ||
    dirname(resolve(options.approvalPath)) !== dirname(resolve(options.resultPath)) ||
    resolve(options.approvalPath) === resolve(options.resultPath)
  )
    throw new DiagnosticStopped('approval_invalid');
  if (physicalLease) throw new DiagnosticStopped('dispatch_limit');
  const clock = options.mode === 'OFFLINE_INJECTED' ? options.clock : realClock;
  const approval = await readApproval(options.approvalPath, options.resultPath, clock.now());
  const claimPath = resolve(dirname(approval.paths.approval), `${approval.runId}.consumed.jsonl`);
  if (claimPath === approval.paths.approval || claimPath === approval.paths.result)
    throw new DiagnosticStopped('approval_invalid');
  const claim = await open(claimPath, 'wx');
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let reservationWrite: Promise<void> | undefined;
  let errorObservation: ReturnType<typeof observeEvaluationError> | undefined;
  let lease: Lease | undefined;
  const controller = new AbortController();
  const timerController = new AbortController();
  let active = true;
  let failure: StopReason | null = null;
  let deadline = Infinity;
  const result: GenerateContentResult = {
    version: 1,
    runId: approval.runId,
    mode: options.mode,
    route: 'GENERATE_CONTENT',
    returnTo: 'HOLD',
    outcome: 'FAILED',
    stopReason: null,
    dispatchReserved: false,
    physicalRequests: 0,
    cleanup: 'SETTLED',
    httpStatus: null,
    completionReason: 'unknown',
    modelMatches: null,
    expectedJsonMatches: null,
    usage: unknownUsage(),
    errorMetadata: null,
  };
  function stop(reason: StopReason): never {
    failure ??= reason;
    throw new DiagnosticStopped(reason);
  }
  function check() {
    if (!active || controller.signal.aborted || clock.now() >= deadline) stop('deadline');
    checkExpiry(approval, clock.now());
  }
  try {
    try {
      output = await open(options.resultPath, 'wx');
      await claim.writeFile(
        `${JSON.stringify({ version: 1, runId: approval.runId, state: 'CONSUMED_NO_RESUME' })}\n`,
      );
      await claim.sync();
    } catch {
      stop('evidence_failure');
    }
    await clock.sleep(DIAGNOSTIC_BOUNDS.quietPeriodMs, controller.signal);
    check();
    const {
      version: _version,
      authorization: _authorization,
      runId: _runId,
      expiresAt: _expiresAt,
      paths: _paths,
      ...approvedInputs
    } = approval;
    if (canonical(await inspectGenerateContentApprovalInputs()) !== canonical(approvedInputs))
      stop('source_changed');
    check();
    const apiKey =
      options.mode === 'OFFLINE_INJECTED' ? options.readKey() : options.environment.GEMINI_API_KEY;
    if (!apiKey || apiKey.length < 16 || apiKey.length > 512 || /\s/.test(apiKey))
      stop('missing_key');
    deadline = clock.now() + DIAGNOSTIC_BOUNDS.deadlineMs;
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DiagnosticStopped('deadline')), {
        once: true,
      });
    });
    void clock.sleep(DIAGNOSTIC_BOUNDS.deadlineMs, timerController.signal).then(
      () => {
        if (active) {
          failure ??= 'deadline';
          controller.abort();
        }
      },
      () => {},
    );
    const guard = createGenerateContentDispatchGuard();
    const sdkFetch: SdkFetch = async (input, init) => {
      let ownedLease: Lease | undefined;
      let response: Response | undefined;
      try {
        check();
        if (failure) stop(failure);
        await guard(input, init);
        check();
        result.dispatchReserved = true;
        reservationWrite = (async () => {
          await claim.writeFile(`${JSON.stringify({ state: 'DISPATCH_RESERVED', attempts: 1 })}\n`);
          await claim.sync();
        })();
        try {
          await reservationWrite;
        } catch {
          stop('evidence_failure');
        }
        check();
        ownedLease = acquireLease();
        lease = ownedLease;
        result.physicalRequests++;
        const transport = options.mode === 'OFFLINE_INJECTED' ? options.fetch : globalThis.fetch;
        response = await transport(input, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        });
        if (!active || controller.signal.aborted) throw new DiagnosticStopped('deadline');
        check();
        result.httpStatus = response.status;
        if (response.status !== 200) failure = 'http_error';
        const bytes = await boundedBytes(response, controller.signal, lease);
        check();
        const bounded = new Response(bytes, { status: response.status, headers: response.headers });
        if (response.status >= 400) {
          errorObservation = observeEvaluationError(bounded, {
            signal: controller.signal,
            deadline,
            now: () => clock.now(),
          });
          await errorObservation;
          check();
          stop('http_error');
        }
        if (response.status !== 200) stop('http_error');
        return bounded;
      } catch (error) {
        if (active && failure === null)
          failure = error instanceof DiagnosticStopped ? error.reason : 'transport_failure';
        throw new DiagnosticStopped(failure ?? 'deadline');
      } finally {
        if (response && !response.bodyUsed && ownedLease) drop(response, ownedLease);
        ownedLease?.finish();
      }
    };
    const client = new GoogleGenAI({
      apiKey,
      vertexai: false,
      apiVersion: 'v1beta',
      httpOptions: {
        fetch: sdkFetch,
        retryOptions: { attempts: 1 },
        timeout: DIAGNOSTIC_BOUNDS.deadlineMs,
      },
    });
    const response = await Promise.race([
      client.models.generateContent({
        model: DIAGNOSTIC_MODEL,
        contents: CONTENTS,
        config: {
          ...CONFIG,
          abortSignal: controller.signal,
          automaticFunctionCalling: { disable: true },
        },
      }),
      aborted,
    ]);
    check();
    // Never use the SDK text getter (it can log provider-controlled part names).
    summarize(response, result);
    if (result.completionReason !== 'STOP' || !result.modelMatches || !result.expectedJsonMatches)
      stop('output_mismatch');
    if (result.usage.status !== 'KNOWN') stop('unknown_usage');
    if (
      (result.usage.outputTokens ?? Infinity) + (result.usage.thoughtTokens ?? Infinity) >
      DIAGNOSTIC_BOUNDS.outputTokens
    )
      stop('usage_limit');
    result.outcome = 'VALIDATED_TINY_RESPONSE';
  } catch (error) {
    result.stopReason =
      failure ?? (error instanceof DiagnosticStopped ? error.reason : 'transport_failure');
  } finally {
    active = false;
    controller.abort();
    timerController.abort();
    try {
      await reservationWrite;
      if (errorObservation) {
        try {
          const observed = await errorObservation;
          if (observed.response) void observed.response.body?.cancel().catch(() => {});
          result.errorMetadata = observed.metadata;
        } catch {
          result.stopReason = 'observer_failure';
          result.outcome = 'FAILED';
        }
      }
      result.cleanup = lease && !lease.settled() ? 'PENDING' : 'SETTLED';
      if (!output) throw new DiagnosticStopped('evidence_failure');
      await output.writeFile(`${JSON.stringify(result)}\n`);
      await output.sync();
    } finally {
      await output?.close();
      await claim.close();
    }
  }
  return result;
}
async function main() {
  if (process.argv.length !== 5 || process.argv[2] !== '--execute-one-generate-content-diagnostic')
    throw new DiagnosticStopped('approval_invalid');
  const approvalPath = process.argv[3];
  const resultPath = process.argv[4];
  if (!approvalPath || !resultPath) throw new DiagnosticStopped('approval_invalid');
  const result = await runGenerateContentDiagnostic({
    mode: 'LIVE_DIAGNOSTIC',
    approvalPath,
    resultPath,
    environment: process.env,
  });
  process.exitCode = result.outcome === 'VALIDATED_TINY_RESPONSE' ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    process.stderr.write(
      'GenerateContent diagnostic stopped; HOLD. A claimed approval remains consumed.\n',
    );
    process.exitCode = 1;
  });
}
