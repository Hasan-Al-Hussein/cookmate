import {
  canonicalContentJson,
  CONTENT_LIMITS,
  OVERLAY_LIMITS,
  contentOverlaySignaturePayload,
  fingerprintContentOverlay,
  validateContentOverlayManifest,
  type SignedContentOverlay,
} from '@cookmate/catalogue/content';
import {
  CONTENT_STORE_LIMITS,
  type ContentReleaseStageInput,
  type ContentVerificationPorts,
} from '../../data/contentReleaseStore';
import { CONTENT_BROWSER_IO_TIMEOUT_MS } from './contentVerificationTypes';
import {
  ownPrivateContentConfiguration,
  type PrivateContentConfiguration,
} from './privateContentConfig';

// Matches the existing private issued-export wire shape; it grants no admin authentication.
export const PRIVATE_CONTENT_PACKAGE_BYTES = 18 * 1024 * 1024;
type Fetch = (url: string, options: RequestInit) => Promise<Response>;
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.sort().join(',');

/** Explicit same-origin consumer endpoint. No bearer tokens, admin cookies, redirects or retries. */
export function createPrivateContentTransport(options: {
  config: Readonly<PrivateContentConfiguration>;
  fetch: Fetch;
  newId(): string;
  verification: Pick<
    ContentVerificationPorts,
    'sha256' | 'sha256Bytes' | 'trustVerifier' | 'readerVersion'
  >;
}) {
  const config = ownPrivateContentConfiguration(options.config);
  const fetch = options.fetch,
    newId = options.newId;
  const { sha256, sha256Bytes, readerVersion } = options.verification;
  const verify = options.verification.trustVerifier.verify.bind(options.verification.trustVerifier);
  const root = `${config.origin}/cookmate-content/releases/${encodeURIComponent(config.releaseId)}`;
  let closed = false,
    busy = false;
  const controllers = new Set<AbortController>();
  const check = () => {
    if (closed) throw new Error('Private content delivery is closed.');
  };
  async function bytes(url: string, maximum: number, mime: string, expected?: number) {
    check();
    const controller = new AbortController();
    controllers.add(controller);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('Content delivery interrupted.')),
        { once: true },
      );
      timer = setTimeout(() => controller.abort(), CONTENT_BROWSER_IO_TIMEOUT_MS);
    });
    try {
      const pending = fetch(url, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        mode: 'same-origin',
        signal: controller.signal,
        cache: 'no-store',
      });
      void pending.then(
        (response) => {
          if (controller.signal.aborted || closed)
            void response.body?.cancel().catch(() => undefined);
        },
        () => undefined,
      );
      const response = await Promise.race([pending, stopped]);
      check();
      const length = response.headers.get('content-length');
      if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== url) ||
        !response.body ||
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== mime ||
        (length !== null &&
          (!/^\d+$/.test(length) ||
            Number(length) > maximum ||
            (expected !== undefined && Number(length) !== expected)))
      )
        throw new Error('Private content delivery could not be verified.');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const part = await Promise.race([reader.read(), stopped]);
        check();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || part.value.byteLength > maximum - size)
          throw new Error('Private content delivery exceeds its limit.');
        size += part.value.byteLength;
        if (part.value.byteLength) chunks.push(part.value.slice());
      }
      if (
        (expected !== undefined && size !== expected) ||
        (length !== null && size !== Number(length))
      )
        throw new Error('Private content delivery is incomplete.');
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return output;
    } finally {
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
      if (reader) {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }
  return Object.freeze({
    close() {
      closed = true;
      for (const controller of controllers) controller.abort();
    },
    async fetchRelease(): Promise<ContentReleaseStageInput> {
      check();
      if (busy) throw new Error('A recipe release is already being read.');
      busy = true;
      try {
        const input: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await bytes(`${root}/package`, PRIVATE_CONTENT_PACKAGE_BYTES, 'application/json'),
          ),
        );
        if (
          !exact(input, ['formatVersion', 'status', 'envelope', 'publications', 'media']) ||
          input.formatVersion !== 1 ||
          input.status !== 'issued_export_not_adopted' ||
          !Array.isArray(input.publications) ||
          input.publications.length > OVERLAY_LIMITS.publications ||
          !Array.isArray(input.media) ||
          input.media.length > CONTENT_STORE_LIMITS.mediaCount ||
          !exact(input.envelope, ['manifest', 'fingerprint', 'signature'])
        )
          throw new Error('Invalid recipe package.');
        const envelope = input.envelope as unknown as SignedContentOverlay;
        canonicalContentJson(envelope, CONTENT_LIMITS.releaseBytes);
        canonicalContentJson(input.publications, OVERLAY_LIMITS.aggregateContentBytes);
        if (
          !validateContentOverlayManifest(envelope.manifest) ||
          envelope.manifest.releaseId !== config.releaseId ||
          envelope.manifest.minimumReaderVersion > readerVersion ||
          !exact(envelope.signature, ['keyId', 'scheme', 'value']) ||
          typeof envelope.fingerprint !== 'string' ||
          (await fingerprintContentOverlay(envelope.manifest, sha256)) !== envelope.fingerprint ||
          !(await verify({
            keyId: envelope.signature.keyId,
            scheme: envelope.signature.scheme,
            signature: envelope.signature.value,
            canonicalPayload: contentOverlaySignaturePayload(
              envelope.manifest,
              envelope.fingerprint,
            ),
          }))
        )
          throw new Error('Recipe release signature is not trusted.');
        check();
        const descriptors: { sha256: string; bytes: number; mimeType: string }[] = [];
        const hashes = new Set<string>();
        let total = 0;
        for (const entry of input.media) {
          if (
            !exact(entry, ['sha256', 'bytes', 'mimeType']) ||
            typeof entry.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.sha256) ||
            hashes.has(entry.sha256) ||
            typeof entry.bytes !== 'number' ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 1 ||
            entry.bytes > CONTENT_LIMITS.mediaBytes ||
            typeof entry.mimeType !== 'string' ||
            !['image/jpeg', 'image/png', 'image/webp'].includes(entry.mimeType)
          )
            throw new Error('Invalid recipe media inventory.');
          total += entry.bytes;
          if (total > CONTENT_STORE_LIMITS.stageMediaBytes)
            throw new Error('Recipe media exceeds the cache limit.');
          hashes.add(entry.sha256);
          descriptors.push({ sha256: entry.sha256, bytes: entry.bytes, mimeType: entry.mimeType });
        }
        const media: ContentReleaseStageInput['media'][number][] = [];
        for (const descriptor of descriptors) {
          const body = await bytes(
            `${root}/media/${descriptor.sha256}`,
            descriptor.bytes,
            descriptor.mimeType,
            descriptor.bytes,
          );
          if ((await sha256Bytes(body)) !== descriptor.sha256)
            throw new Error('Recipe image hash differs.');
          check();
          media.push({ sha256: descriptor.sha256, bytes: body });
        }
        check();
        return { stageId: newId(), envelope, publications: input.publications, media };
      } finally {
        busy = false;
      }
    },
  });
}
