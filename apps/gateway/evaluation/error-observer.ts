import { GEMINI_MODELS } from '../src/gemini';
import { LIMITS } from '../src/limits';
import {
  createProviderErrorMetadata,
  classifyProviderErrorMetadata,
} from '../src/provider-diagnostics';
import type { ProviderErrorMetadata } from '../src/provider-diagnostics';

export type EvaluationErrorMetadata = ProviderErrorMetadata;

/** Registered synthetic evaluation errors only. Raw bytes/headers are transient SDK input,
 * never diagnostic output. The caller latches quota/auth before entering this observer. */
export async function observeEvaluationError(
  response: Response,
  options: {
    signal: AbortSignal;
    deadline: number;
    now(): number;
  },
): Promise<{ response: Response | null; metadata: EvaluationErrorMetadata }> {
  if (response.status < 400) throw new Error('error_response_required');
  const metadata = createProviderErrorMetadata(response.headers.get('retry-after'));
  const unavailable = (): EvaluationErrorMetadata['bodyState'] | null =>
    options.now() >= options.deadline ? 'deadline' : options.signal.aborted ? 'aborted' : null;
  const initialStop = unavailable();
  if (initialStop) {
    metadata.bodyState = initialStop;
    void response.body?.cancel().catch(() => {});
    return { response: null, metadata };
  }
  if (!response.body) return { response, metadata };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    metadata.bodyState = 'read_failure';
    return { response: null, metadata };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  let cancelled = false;
  let failure: EvaluationErrorMetadata['bodyState'] | null = null;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    // A hostile/stalled underlying cancel promise must not prolong the turn.
    void reader.cancel().catch(() => {});
  };
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => {
      cancel();
      reject(new Error('error_observation_interrupted'));
    };
  });
  void interrupted.catch(() => {});
  const abort = () => {
    failure = unavailable() ?? 'aborted';
    interrupt();
  };
  const timer = setTimeout(
    () => {
      failure = 'deadline';
      interrupt();
    },
    Math.max(0, options.deadline - options.now()),
  );
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      failure ??= unavailable();
      if (failure) break;
      const next = await Promise.race([reader.read(), interrupted]);
      failure ??= unavailable();
      if (failure) break;
      if (next.done) {
        finished = true;
        break;
      }
      size += next.value.byteLength;
      if (size > LIMITS.providerResponseBytes) {
        failure = 'response_limit';
        break;
      }
      chunks.push(next.value.slice());
    }
  } catch {
    failure ??= unavailable() ?? 'read_failure';
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    if (!finished) cancel();
    reader.releaseLock();
  }
  if (failure) {
    metadata.bodyState = failure;
    return { response: null, metadata };
  }
  const bytes = Buffer.concat(chunks);
  classifyProviderErrorMetadata(bytes, metadata, GEMINI_MODELS);
  return {
    response: new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    metadata,
  };
}
