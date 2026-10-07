import { Asset } from 'expo-asset';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { recipePhotoAssets } from '@cookmate/catalogue/photos';
import type { Immutable } from '@cookmate/catalogue';
import {
  canonicalContentJson,
  CONTENT_LIMITS,
  createBundledContentSnapshot,
  TRANSLATED_PUBLICATION_READER_VERSION,
  validateMediaReference,
  type MediaReference,
} from '@cookmate/catalogue/content';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import type { ContentVerificationPorts } from '../../data/contentReleaseStore';
import { nativeCommandPlatform } from '../../domain/commandPlatform';
import { readContentImageHeader } from './contentImageHeader';
import {
  CONTENT_BROWSER_IO_TIMEOUT_MS,
  ContentVerificationCapabilityError,
  type ContentVerificationOptions,
} from './contentVerificationTypes';
export * from './contentVerificationTypes';

/** Only installed baseline assets and independently supplied host keys enter these verification ports. */
export async function createContentVerificationPorts(
  options: ContentVerificationOptions,
): Promise<ContentVerificationPorts> {
  const owned: ContentVerificationOptions = JSON.parse(canonicalContentJson(options, 8192));
  if (
    Object.keys(owned).some((key) => key !== 'trustKeys' && key !== 'readerVersion') ||
    (owned.readerVersion !== undefined &&
      (!Number.isSafeInteger(owned.readerVersion) || owned.readerVersion < 1))
  )
    throw new Error('Invalid content verifier configuration.');
  const trustVerifier = createContentTrustVerifier(owned.trustKeys);
  const hashText = nativeCommandPlatform.sha256,
    hashBytes = digest;
  const fromModule = Asset.fromModule.bind(Asset);
  const ImageConstructor = globalThis.Image,
    BlobConstructor = globalThis.Blob,
    AbortConstructor = globalThis.AbortController;
  if (
    typeof globalThis.fetch !== 'function' ||
    typeof ImageConstructor !== 'function' ||
    typeof ImageConstructor.prototype.decode !== 'function' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof URL.revokeObjectURL !== 'function' ||
    typeof globalThis.location?.href !== 'string'
  )
    throw new ContentVerificationCapabilityError('browser_unavailable');
  const fetchAsset = globalThis.fetch.bind(globalThis),
    createUrl = URL.createObjectURL.bind(URL),
    revokeUrl = URL.revokeObjectURL.bind(URL);
  const page = new URL(globalThis.location.href);
  if (!['http:', 'https:'].includes(page.protocol))
    throw new ContentVerificationCapabilityError('browser_unavailable');
  const sha256: ContentVerificationPorts['sha256'] = async (text) => {
    const value = await hashText(text);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid SHA256 result.');
    return value;
  };
  const sha256Bytes: ContentVerificationPorts['sha256Bytes'] = async (input) => {
    if (!(input instanceof Uint8Array) || input.byteLength > CONTENT_LIMITS.mediaBytes)
      throw new Error('Invalid media bytes.');
    const bytes = new Uint8Array(input);
    const value = new Uint8Array(await hashBytes(CryptoDigestAlgorithm.SHA256, bytes));
    if (value.byteLength !== 32) throw new Error('Invalid SHA256 result.');
    return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const assets = new Map(Object.entries(recipePhotoAssets));
  const packaged = await createBundledContentSnapshot(sha256);
  const media = new Map(
    packaged.revisions.flatMap((revision) =>
      revision.document.media.map(
        (reference) => [canonicalContentJson(reference), reference] as const,
      ),
    ),
  );
  return Object.freeze({
    baseline: Object.freeze({ identity: packaged.catalogue, revisions: packaged.revisions }),
    readerVersion: owned.readerVersion ?? TRANSLATED_PUBLICATION_READER_VERSION,
    trustVerifier,
    sha256,
    sha256Bytes,
    async inspectImage(input: Uint8Array) {
      if (!(input instanceof Uint8Array) || input.byteLength > CONTENT_LIMITS.mediaBytes)
        return null;
      const bytes = new Uint8Array(input),
        header = readContentImageHeader(bytes);
      if (!header) return null;
      const image = new ImageConstructor();
      const uri = createUrl(new BlobConstructor([bytes], { type: header.mimeType }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        image.src = uri;
        await Promise.race([
          image.decode(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Image decoding timed out.')),
              CONTENT_BROWSER_IO_TIMEOUT_MS,
            );
          }),
        ]);
        // A decoder disagreement (including orientation-dependent dimension changes) is not verified.
        return image.naturalWidth === header.width && image.naturalHeight === header.height
          ? Object.freeze(header)
          : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        try {
          image.removeAttribute('src');
        } finally {
          revokeUrl(uri);
        }
      }
    },
    async readBundledMedia(input: Immutable<MediaReference>) {
      const reference: unknown = JSON.parse(canonicalContentJson(input, 16 * 1024));
      if (!validateMediaReference(reference)) return null;
      const retained = media.get(canonicalContentJson(reference));
      if (!retained) return null;
      const module = assets.get(retained.recipeId);
      if (module === undefined) return null;
      const uri = new URL(fromModule(module).uri, page);
      // Published/native CDN assets need a separate explicit host policy; this browser adapter is same-origin only.
      if (
        uri.origin !== page.origin ||
        !['http:', 'https:'].includes(uri.protocol) ||
        uri.username ||
        uri.password ||
        uri.hash
      )
        return null;
      const controller = new AbortConstructor();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('Bundled asset read timed out.'));
        }, CONTENT_BROWSER_IO_TIMEOUT_MS);
      });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const request = fetchAsset(uri.href, {
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          mode: 'same-origin',
        });
        void request.then(
          (response) => {
            if (controller.signal.aborted) void response.body?.cancel().catch(() => undefined);
          },
          () => undefined,
        );
        const response = await Promise.race([request, deadline]);
        if (
          !response.ok ||
          response.redirected ||
          (response.url && response.url !== uri.href) ||
          !response.body
        )
          return null;
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== retained.bytes))
          return null;
        reader = response.body.getReader();
        const bytes = new Uint8Array(retained.bytes);
        let offset = 0;
        for (;;) {
          const result = await Promise.race([reader.read(), deadline]);
          if (result.done) break;
          if (
            !(result.value instanceof Uint8Array) ||
            result.value.byteLength > bytes.length - offset
          )
            return null;
          bytes.set(result.value, offset);
          offset += result.value.byteLength;
        }
        if (offset !== retained.bytes || (await sha256Bytes(bytes)) !== retained.sha256)
          return null;
        return bytes;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
        controller.abort();
        if (reader) {
          const closing = reader;
          void closing
            .cancel()
            .catch(() => undefined)
            .finally(() => {
              closing.releaseLock();
            });
        }
      }
    },
  });
}
