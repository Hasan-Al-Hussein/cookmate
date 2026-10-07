import { createHash } from 'node:crypto';
import { LIMITS } from '../src/limits';

const CAPTURE_BYTES = 32 * 1024;
const MAX_COPY_DEPTH = 24;
const MAX_COPY_NODES = 4096;

export type CaptureOmissionReason =
  | 'not_successful'
  | 'no_body'
  | 'malformed_envelope'
  | 'ambiguous_model_text'
  | 'no_model_text'
  | 'unsafe_credential'
  | 'unsafe_encoding'
  | 'capture_limit'
  | 'malformed_structured_copy';

export interface SyntheticTextPart {
  stepIndex: number;
  contentIndex: number;
  text: string;
  utf8Bytes: number;
}

export interface SyntheticReportedUsage {
  status: 'KNOWN' | 'UNKNOWN';
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtTokens: number | null;
}

export interface SyntheticResponseCapture {
  fixture: 'SYNTHETIC';
  status: 'captured' | 'omitted';
  reason: CaptureOmissionReason | null;
  selected_text: 'NOT_OBSERVED';
  parts: SyntheticTextPart[];
  modelOutputSteps: number;
  modelTextParts: number;
  usage: SyntheticReportedUsage;
  responseBytes: number | null;
  serializedBytes: number;
  sha256: string | null;
}

export interface SyntheticStructuredCapture {
  status: 'captured' | 'omitted';
  reason: CaptureOmissionReason | null;
  value: unknown | null;
  serializedBytes: number;
  sha256: string | null;
}

export class CaptureObservationError extends Error {
  constructor(readonly reason: 'response_limit' | 'read_failure') {
    super(`Synthetic response observation failed: ${reason}`);
    this.name = 'CaptureObservationError';
  }
}

type SafetyOptions = { apiKey: string; onUnsafe: (reason: string) => void };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Report only explicit counts; provider admission and validity remain caller concerns. */
function reportedUsage(value: unknown): SyntheticReportedUsage {
  const usage = record(value) ? value : undefined;
  const count = (input: unknown): number | null =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : null;
  const inputTokens = count(usage?.total_input_tokens);
  const outputTokens = count(usage?.total_output_tokens);
  const thoughtTokens = count(usage?.total_thought_tokens);
  return {
    status:
      inputTokens !== null && outputTokens !== null && thoughtTokens !== null ? 'KNOWN' : 'UNKNOWN',
    inputTokens,
    outputTokens,
    thoughtTokens,
  };
}

function emptyCapture(
  reason: CaptureOmissionReason,
  responseBytes: number | null,
): SyntheticResponseCapture {
  return {
    fixture: 'SYNTHETIC',
    status: 'omitted',
    reason,
    selected_text: 'NOT_OBSERVED',
    parts: [],
    modelOutputSteps: 0,
    modelTextParts: 0,
    usage: reportedUsage(undefined),
    responseBytes,
    serializedBytes: 0,
    sha256: null,
  };
}

/** Ephemeral joined view is for cross-boundary detection only, never answer selection. */
function unsafeReason(
  strings: readonly string[],
  options: SafetyOptions,
): CaptureOmissionReason | null {
  const views = [...strings, strings.join('')];
  const supplied = new Set([options.apiKey, JSON.stringify(options.apiKey).slice(1, -1)]);
  let reason: CaptureOmissionReason | null = null;
  if ([...supplied].some((value) => value.length > 0 && views.some((view) => view.includes(value))))
    reason = 'unsafe_credential';
  else if (
    views.some(
      (view) =>
        /AIza[A-Za-z0-9_-]{35}|\bsk-[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(view) ||
        /authorization|authentication|api[\s_-]*key|token|password|passwd|secret|credential|private[\s_-]*key|passphrase|cookie|connection[\s_-]*string|bearer|\b(?:auth|pwd|key)\b/i.test(
          view,
        ),
    )
  )
    reason = 'unsafe_credential';
  else if (views.some((view) => /\\(?:u|x|[0-7]|\/)/i.test(view))) reason = 'unsafe_encoding';
  if (reason) options.onUnsafe(reason);
  return reason;
}

function hashSafe(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function extractCapture(body: Uint8Array, options: SafetyOptions): SyntheticResponseCapture {
  const capture = emptyCapture('malformed_envelope', body.byteLength);
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return capture;
  }
  if (!record(envelope)) return capture;
  capture.usage = reportedUsage(envelope.usage);
  if (!Array.isArray(envelope.steps)) return capture;
  const parts: SyntheticTextPart[] = [];
  let extractionFailure: 'malformed_envelope' | 'ambiguous_model_text' | null = null;
  for (const [stepIndex, step] of envelope.steps.entries()) {
    if (!record(step) || typeof step.type !== 'string' || !step.type) {
      extractionFailure ??= 'malformed_envelope';
      continue;
    }
    // Do not inspect non-model content, thoughts or arbitrary envelope fields.
    if (step.type !== 'model_output') continue;
    capture.modelOutputSteps++;
    if (!Array.isArray(step.content)) {
      extractionFailure ??= 'ambiguous_model_text';
      continue;
    }
    for (const [contentIndex, content] of step.content.entries()) {
      if (!record(content) || typeof content.type !== 'string' || !content.type) {
        extractionFailure ??= 'ambiguous_model_text';
        continue;
      }
      if (content.type !== 'text') continue;
      if (typeof content.text !== 'string') {
        extractionFailure ??= 'ambiguous_model_text';
        continue;
      }
      parts.push({
        stepIndex,
        contentIndex,
        text: content.text,
        utf8Bytes: Buffer.byteLength(content.text),
      });
      capture.modelTextParts++;
    }
  }
  const unsafe = unsafeReason(
    parts.map((part) => part.text),
    options,
  );
  if (unsafe) {
    capture.reason = unsafe;
    return capture;
  }
  if (extractionFailure || !parts.length) {
    capture.reason = extractionFailure ?? 'no_model_text';
    return capture;
  }
  const serialized = JSON.stringify(parts);
  const bytes = Buffer.byteLength(serialized);
  if (bytes > CAPTURE_BYTES) {
    capture.reason = 'capture_limit';
    return capture;
  }
  return {
    ...capture,
    status: 'captured',
    reason: null,
    parts,
    serializedBytes: bytes,
    sha256: hashSafe(serialized),
  };
}

/** For a controlling runner's registered SYNTHETIC generation attempt only.
 * Never call this observer for real user traffic, count requests or arbitrary endpoints.
 * The caller owns endpoint/model/status validation and the synchronous global-stop latch.
 * No SDK-selected text is exposed here, and no captured copy is used as provider input. */
export async function observeSyntheticResponse(
  response: Response,
  options: SafetyOptions & { signal: AbortSignal },
): Promise<{ response: Response; capture: SyntheticResponseCapture }> {
  options.signal.throwIfAborted();
  if (!response.ok) return { response, capture: emptyCapture('not_successful', null) };
  if (!response.body) return { response, capture: emptyCapture('no_body', 0) };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let finished = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    // Cancel pending reads, but never await a custom underlying cancellation promise.
    void reader.cancel().catch(() => {});
  };
  options.signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      options.signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > LIMITS.providerResponseBytes) throw new CaptureObservationError('response_limit');
      chunks.push(next.value.slice());
    }
    options.signal.throwIfAborted();
    finished = true;
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof CaptureObservationError) throw error;
    throw new CaptureObservationError('read_failure');
  } finally {
    options.signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  const capture = extractCapture(body, options);
  return {
    // Headers are forwarded opaquely for SDK compatibility; none are inspected or retained.
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    capture,
  };
}

class InvalidCopy extends Error {
  constructor(readonly reason: 'malformed_structured_copy' | 'capture_limit') {
    super('Synthetic structured copy omitted');
  }
}

/** Detached plain-JSON copy: no getters, toJSON, defaults, field removal or coercion. */
function copyJson(value: unknown): { value: Json; strings: string[] } {
  let nodes = 0;
  let bytes = 0;
  const active = new WeakSet<object>();
  const strings: string[] = [];
  const add = (count: number) => {
    bytes += count;
    if (bytes > LIMITS.providerResponseBytes) throw new InvalidCopy('capture_limit');
  };
  const stringBytes = (text: string) => {
    if (text.length > LIMITS.providerResponseBytes) throw new InvalidCopy('capture_limit');
    return Buffer.byteLength(JSON.stringify(text));
  };
  function visit(input: unknown, depth: number): Json {
    if (depth > MAX_COPY_DEPTH || ++nodes > MAX_COPY_NODES) throw new InvalidCopy('capture_limit');
    if (input === null || typeof input === 'boolean') {
      add(input === false ? 5 : 4);
      return input;
    }
    if (typeof input === 'number' && Number.isFinite(input)) {
      add(String(input).length);
      return input;
    }
    if (typeof input === 'string') {
      add(stringBytes(input));
      strings.push(input);
      return input;
    }
    if (!input || typeof input !== 'object' || active.has(input))
      throw new InvalidCopy('malformed_structured_copy');
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null)
      throw new InvalidCopy('malformed_structured_copy');
    active.add(input);
    try {
      const keys = Reflect.ownKeys(input);
      if (keys.length > MAX_COPY_NODES + (array ? 1 : 0)) throw new InvalidCopy('capture_limit');
      if (keys.some((key) => typeof key !== 'string'))
        throw new InvalidCopy('malformed_structured_copy');
      if (array) {
        const length: unknown = Object.getOwnPropertyDescriptor(input, 'length')?.value;
        if (
          typeof length !== 'number' ||
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_COPY_NODES
        )
          throw new InvalidCopy('capture_limit');
        if (keys.length !== length + 1) throw new InvalidCopy('malformed_structured_copy');
        add(2 + Math.max(0, length - 1));
        const output: Json[] = [];
        for (let index = 0; index < length; index++) {
          const property = Object.getOwnPropertyDescriptor(input, String(index));
          if (!property?.enumerable || !('value' in property))
            throw new InvalidCopy('malformed_structured_copy');
          output.push(visit(property.value, depth + 1));
        }
        return output;
      }
      add(2 + Math.max(0, keys.length - 1));
      const entries: [string, Json][] = [];
      for (const key of keys) {
        if (typeof key !== 'string') throw new InvalidCopy('malformed_structured_copy');
        const property = Object.getOwnPropertyDescriptor(input, key);
        if (!property?.enumerable || !('value' in property))
          throw new InvalidCopy('malformed_structured_copy');
        add(stringBytes(key) + 1);
        strings.push(key);
        entries.push([key, visit(property.value, depth + 1)]);
      }
      return Object.fromEntries(entries);
    } finally {
      active.delete(input);
    }
  }
  return { value: visit(value, 0), strings };
}

/** Safe evidence copy only; callers must validate the unchanged original value separately.
 * remainingBytes is the shared 32-KiB allowance after giving emitted text priority. */
export function sanitizeSyntheticStructuredCopy(
  value: unknown,
  options: SafetyOptions & { remainingBytes: number },
): SyntheticStructuredCapture {
  const omitted = (reason: CaptureOmissionReason): SyntheticStructuredCapture => ({
    status: 'omitted',
    reason,
    value: null,
    serializedBytes: 0,
    sha256: null,
  });
  let copied: ReturnType<typeof copyJson>;
  try {
    copied = copyJson(value);
  } catch (error) {
    return omitted(error instanceof InvalidCopy ? error.reason : 'malformed_structured_copy');
  }
  const unsafe = unsafeReason(copied.strings, options);
  if (unsafe) return omitted(unsafe);
  const serialized = JSON.stringify(copied.value);
  const bytes = Buffer.byteLength(serialized);
  if (
    !Number.isSafeInteger(options.remainingBytes) ||
    options.remainingBytes < 0 ||
    bytes > Math.min(CAPTURE_BYTES, options.remainingBytes)
  )
    return omitted('capture_limit');
  return {
    status: 'captured',
    reason: null,
    value: copied.value,
    serializedBytes: bytes,
    sha256: hashSafe(serialized),
  };
}
