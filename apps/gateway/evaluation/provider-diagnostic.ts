import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import type { HttpOptions } from '@google/genai';
import { CaptureObservationError, observeSyntheticResponse } from './capture';
import type { SyntheticReportedUsage, SyntheticResponseCapture } from './capture';
import { observeEvaluationError } from './error-observer';
import type { EvaluationErrorMetadata } from './error-observer';
import { LIMITS } from '../src/limits';

// Importing this module reads no environment, credential, approval or source file.
export const DIAGNOSTIC_MODEL = 'gemini-3.8-flash';
export const DIAGNOSTIC_PROMPT = 'Return only the JSON object {"ok":true}.';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const REQUEST = Object.freeze({
  model: DIAGNOSTIC_MODEL,
  input: DIAGNOSTIC_PROMPT,
  store: false,
  stream: false as const,
  generation_config: Object.freeze({ max_output_tokens: 256 }),
  response_format: Object.freeze({ type: 'text' as const, mime_type: 'application/json' }),
});
export const DIAGNOSTIC_REQUEST_JSON = JSON.stringify(REQUEST);
export const DIAGNOSTIC_BOUNDS = Object.freeze({
  maxHttpRequests: 1,
  maxGenerations: 1,
  maxPreflights: 0,
  maxRetries: 0,
  quietPeriodMs: 65_000,
  deadlineMs: 45_000,
  responseBytes: 131_072,
  outputTokens: 256,
});
const SOURCE_PATHS = [
  'apps/gateway/evaluation/provider-diagnostic.ts',
  'apps/gateway/evaluation/capture.ts',
  'apps/gateway/evaluation/error-observer.ts',
  'apps/gateway/src/provider-diagnostics.ts',
  'apps/gateway/src/limits.ts',
  // error-observer imports this module for the fixed model allowlist.
  'apps/gateway/src/gemini.ts',
] as const;
const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export interface DiagnosticApprovalInputs {
  model: typeof DIAGNOSTIC_MODEL;
  promptSha256: string;
  requestSha256: string;
  bounds: typeof DIAGNOSTIC_BOUNDS;
  runtime: { nodeVersion: string; sdkVersion: string; sdkEntrySha256: string };
  sourceDigests: Record<string, string>;
}
export interface DiagnosticApproval extends DiagnosticApprovalInputs {
  version: 1;
  authorization: 'ROOT_APPROVED_ONE_DIAGNOSTIC';
  runId: string;
  expiresAt: string;
  paths: { approval: string; result: string };
}

/** Local preparation only. This is a small reviewed-source selection, not a dependency closure. */
export async function inspectDiagnosticApprovalInputs(): Promise<DiagnosticApprovalInputs> {
  const sourceDigests: Record<string, string> = {};
  for (const path of SOURCE_PATHS)
    sourceDigests[path] = hash(await readFile(resolve(projectRoot, path)));
  const sdkRoot = resolve(projectRoot, 'node_modules/@google/genai');
  const sdk: unknown = JSON.parse(await readFile(resolve(sdkRoot, 'package.json'), 'utf8'));
  if (!record(sdk) || sdk.name !== '@google/genai' || typeof sdk.version !== 'string')
    throw new DiagnosticStopped('approval_invalid');
  return {
    model: DIAGNOSTIC_MODEL,
    promptSha256: hash(DIAGNOSTIC_PROMPT),
    requestSha256: hash(DIAGNOSTIC_REQUEST_JSON),
    bounds: DIAGNOSTIC_BOUNDS,
    runtime: {
      nodeVersion: process.version,
      sdkVersion: sdk.version,
      sdkEntrySha256: hash(await readFile(resolve(sdkRoot, 'dist/node/index.mjs'))),
    },
    sourceDigests,
  };
}

type StopReason =
  | 'approval_invalid'
  | 'approval_expired'
  | 'source_changed'
  | 'missing_key'
  | 'request_mismatch'
  | 'dispatch_limit'
  | 'http_error'
  | 'transport_failure'
  | 'observer_failure'
  | 'response_limit'
  | 'unsafe_output'
  | 'output_mismatch'
  | 'unknown_usage'
  | 'usage_limit'
  | 'deadline'
  | 'evidence_failure';
export class DiagnosticStopped extends Error {
  constructor(readonly reason: StopReason) {
    super(`One-call diagnostic stopped: ${reason}`);
    this.name = 'DiagnosticStopped';
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function checkExpiry(approval: DiagnosticApproval, now: number) {
  if (now >= Date.parse(approval.expiresAt)) throw new DiagnosticStopped('approval_expired');
}
async function readApproval(
  path: string,
  resultPath: string,
  now: number,
): Promise<DiagnosticApproval> {
  const handle = await open(path, 'r');
  let value: unknown;
  try {
    if ((await handle.stat()).size > 16_384) throw new DiagnosticStopped('approval_invalid');
    value = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  if (
    !record(value) ||
    typeof value.runId !== 'string' ||
    !/^one-call-[0-9]{8}-[0-9]{2}$/.test(value.runId) ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt
  )
    throw new DiagnosticStopped('approval_invalid');
  const expected: DiagnosticApproval = {
    ...(await inspectDiagnosticApprovalInputs()),
    version: 1,
    authorization: 'ROOT_APPROVED_ONE_DIAGNOSTIC',
    runId: value.runId,
    expiresAt: value.expiresAt,
    paths: { approval: resolve(path), result: resolve(resultPath) },
  };
  if (canonical(value) !== canonical(expected)) throw new DiagnosticStopped('approval_invalid');
  if (
    LIMITS.providerResponseBytes !== DIAGNOSTIC_BOUNDS.responseBytes ||
    Buffer.byteLength(DIAGNOSTIC_PROMPT) > 128 ||
    Buffer.byteLength(DIAGNOSTIC_REQUEST_JSON) > 512
  )
    throw new DiagnosticStopped('approval_invalid');
  checkExpiry(expected, now);
  return expected;
}

type SdkFetch = NonNullable<HttpOptions['fetch']>;
/** Independent physical-dispatch guard. A failed or concurrent first attempt also consumes it. */
export function createDiagnosticDispatchGuard() {
  let used = false;
  return async (input: Parameters<SdkFetch>[0], init?: Parameters<SdkFetch>[1]) => {
    if (used) throw new DiagnosticStopped('dispatch_limit');
    used = true;
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    if (request.url !== ENDPOINT || request.method !== 'POST')
      throw new DiagnosticStopped('request_mismatch');
    const body = await request.text();
    if (Buffer.byteLength(body) > 512 || body !== DIAGNOSTIC_REQUEST_JSON)
      throw new DiagnosticStopped('request_mismatch');
  };
}

export interface OfflineDiagnosticClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
const realClock: OfflineDiagnosticClock = {
  now: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    await delay(milliseconds, undefined, { signal });
  },
};
type DiagnosticOptions = { approvalPath: string; resultPath: string } & (
  | { mode: 'LIVE_DIAGNOSTIC'; environment: NodeJS.ProcessEnv }
  | { mode: 'OFFLINE_INJECTED'; clock: OfflineDiagnosticClock; fetch: SdkFetch; readKey(): string }
);
const unknownUsage = (): SyntheticReportedUsage => ({
  status: 'UNKNOWN',
  inputTokens: null,
  outputTokens: null,
  thoughtTokens: null,
});
type CompletionStatus =
  | 'completed'
  | 'in_progress'
  | 'requires_action'
  | 'cancelled'
  | 'failed'
  | 'incomplete'
  | 'unknown';
export interface DiagnosticResult {
  version: 1;
  runId: string;
  mode: DiagnosticOptions['mode'];
  returnTo: 'HOLD';
  outcome: 'OBSERVED' | 'FAILED';
  stopReason: StopReason | null;
  dispatchReserved: boolean;
  physicalRequests: number;
  httpStatus: number | null;
  completionStatus: CompletionStatus;
  modelMatches: boolean | null;
  expectedJsonMatches: boolean | null;
  usage: SyntheticReportedUsage;
  errorMetadata: EvaluationErrorMetadata | null;
}
function drop(response: Response) {
  void response.body?.cancel().catch(() => {});
}

/** Always requires a fresh approval and exclusive consumed marker, including offline fixtures. */
export async function runProviderDiagnostic(options: DiagnosticOptions): Promise<DiagnosticResult> {
  if (
    !isAbsolute(options.approvalPath) ||
    !isAbsolute(options.resultPath) ||
    dirname(resolve(options.approvalPath)) !== dirname(resolve(options.resultPath)) ||
    resolve(options.approvalPath) === resolve(options.resultPath)
  )
    throw new DiagnosticStopped('approval_invalid');
  const clock = options.mode === 'OFFLINE_INJECTED' ? options.clock : realClock;
  const approval = await readApproval(options.approvalPath, options.resultPath, clock.now());
  const claimPath = resolve(dirname(approval.paths.approval), `${approval.runId}.consumed.jsonl`);
  if (claimPath === approval.paths.approval || claimPath === approval.paths.result)
    throw new DiagnosticStopped('approval_invalid');
  // Claim first: even an output-creation/storage failure conservatively consumes this approval.
  const claim = await open(claimPath, 'wx');
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let reservationWrite: Promise<void> | undefined;
  let errorObservation: ReturnType<typeof observeEvaluationError> | undefined;
  const controller = new AbortController();
  const timerController = new AbortController();
  let active = true;
  let failure: StopReason | null = null;
  const result: DiagnosticResult = {
    version: 1,
    runId: approval.runId,
    mode: options.mode,
    returnTo: 'HOLD',
    outcome: 'FAILED',
    stopReason: null,
    dispatchReserved: false,
    physicalRequests: 0,
    httpStatus: null,
    completionStatus: 'unknown',
    modelMatches: null,
    expectedJsonMatches: null,
    usage: unknownUsage(),
    errorMetadata: null,
  };
  function stop(reason: StopReason): never {
    failure ??= reason;
    throw new DiagnosticStopped(reason);
  }
  let deadline = Infinity;
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
    if (
      canonical(await inspectDiagnosticApprovalInputs()) !==
      canonical({
        model: approval.model,
        promptSha256: approval.promptSha256,
        requestSha256: approval.requestSha256,
        bounds: approval.bounds,
        runtime: approval.runtime,
        sourceDigests: approval.sourceDigests,
      })
    )
      stop('source_changed');
    check();
    // The only credential read occurs after validation, claim, fresh output and quiet wait.
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
    const guard = createDiagnosticDispatchGuard();
    const observed: { capture: SyntheticResponseCapture | null } = { capture: null };
    const sdkFetch: SdkFetch = async (input, init) => {
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
        if (failure || result.physicalRequests >= 1) stop(failure ?? 'dispatch_limit');
        result.physicalRequests++;
        const transport = options.mode === 'OFFLINE_INJECTED' ? options.fetch : globalThis.fetch;
        response = await transport(input, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        });
        if (!active || controller.signal.aborted) {
          drop(response);
          stop('deadline');
        }
        check();
        result.httpStatus = response.status;
        if (response.status >= 400) {
          // Stop further dispatch immediately, while allowing bounded metadata observation.
          failure = 'http_error';
          errorObservation = observeEvaluationError(response, {
            signal: controller.signal,
            deadline,
            now: () => clock.now(),
          });
          const error = await errorObservation;
          if (error.response) drop(error.response);
          check();
          stop('http_error');
        }
        if (response.status !== 200) {
          drop(response);
          stop('http_error');
        }
        const success = await observeSyntheticResponse(response, {
          apiKey,
          signal: controller.signal,
          onUnsafe: () => {
            if (active) failure = 'unsafe_output';
          },
        });
        if (!active || controller.signal.aborted || clock.now() >= deadline) {
          drop(success.response);
          stop('deadline');
        }
        check();
        if (success.capture.status !== 'captured' || failure) {
          drop(success.response);
          stop(failure ?? 'output_mismatch');
        }
        observed.capture = success.capture;
        return success.response;
      } catch (error) {
        if (response && !response.bodyUsed) drop(response);
        if (active && failure === null)
          failure =
            error instanceof DiagnosticStopped
              ? error.reason
              : error instanceof CaptureObservationError
                ? error.reason === 'response_limit'
                  ? 'response_limit'
                  : 'observer_failure'
                : 'transport_failure';
        throw new DiagnosticStopped(failure ?? 'deadline');
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
    const interaction = await Promise.race([
      client.interactions.create(
        { ...REQUEST, api_version: 'v1beta' },
        {
          signal: controller.signal,
          timeout_ms: DIAGNOSTIC_BOUNDS.deadlineMs,
          retries: { strategy: 'none' },
          maxRetries: 0,
        },
      ),
      aborted,
    ]);
    check();
    const statuses: readonly string[] = [
      'completed',
      'in_progress',
      'requires_action',
      'cancelled',
      'failed',
      'incomplete',
    ];
    result.completionStatus = statuses.includes(interaction.status)
      ? (interaction.status as CompletionStatus)
      : 'unknown';
    result.modelMatches = interaction.model === DIAGNOSTIC_MODEL;
    const capture = observed.capture;
    const selected = interaction.output_text;
    let parsed: unknown;
    try {
      parsed = typeof selected === 'string' ? JSON.parse(selected) : null;
    } catch {
      parsed = null;
    }
    // Compare every captured model-text part: the SDK may select only its final contiguous text.
    result.expectedJsonMatches =
      !!capture &&
      typeof selected === 'string' &&
      capture.parts
        .map((part) => part.text)
        .join('')
        .trim() === selected.trim() &&
      record(parsed) &&
      Object.keys(parsed).length === 1 &&
      parsed.ok === true;
    result.usage = capture?.usage ?? unknownUsage();
    if (
      result.completionStatus !== 'completed' ||
      !result.modelMatches ||
      !result.expectedJsonMatches
    )
      stop('output_mismatch');
    if (result.usage.status !== 'KNOWN') stop('unknown_usage');
    if (
      (result.usage.outputTokens ?? Infinity) + (result.usage.thoughtTokens ?? Infinity) >
      DIAGNOSTIC_BOUNDS.outputTokens
    )
      stop('usage_limit');
    result.outcome = 'OBSERVED';
  } catch (error) {
    result.stopReason =
      failure ?? (error instanceof DiagnosticStopped ? error.reason : 'transport_failure');
  } finally {
    // Freeze producers; only this finalizer can retain an already-started bounded observation.
    active = false;
    controller.abort();
    timerController.abort();
    try {
      await reservationWrite;
      if (errorObservation) {
        try {
          const error = await errorObservation;
          if (error.response) drop(error.response);
          result.errorMetadata = error.metadata;
        } catch {
          result.stopReason = 'observer_failure';
          result.outcome = 'FAILED';
        }
      }
      if (output) {
        await output.writeFile(`${JSON.stringify(result)}\n`);
        await output.sync();
      } else {
        throw new DiagnosticStopped('evidence_failure');
      }
    } finally {
      await output?.close();
      await claim.close();
    }
  }
  return result;
}

async function main() {
  if (process.argv.length !== 5 || process.argv[2] !== '--execute-one-diagnostic')
    throw new DiagnosticStopped('approval_invalid');
  const approvalPath = process.argv[3];
  const resultPath = process.argv[4];
  if (!approvalPath || !resultPath) throw new DiagnosticStopped('approval_invalid');
  const result = await runProviderDiagnostic({
    mode: 'LIVE_DIAGNOSTIC',
    approvalPath,
    resultPath,
    environment: process.env,
  });
  process.exitCode = result.outcome === 'OBSERVED' ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    // Never print SDK exceptions, OS errors/paths, environment values, headers or response text.
    process.stderr.write(
      'One-call diagnostic stopped; HOLD. Approval remains non-reusable if claimed.\n',
    );
    process.exitCode = 1;
  });
}
