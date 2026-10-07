import { Asset } from 'expo-asset';
import { catalogueProvenance } from '@cookmate/catalogue';
import { createContentTrustVerifier } from '@cookmate/catalogue/content-trust';
import { CONTENT_LIMITS, TRANSLATED_PUBLICATION_READER_VERSION } from '@cookmate/catalogue/content';
import {
  createContentVerificationPorts,
  CONTENT_BROWSER_IO_TIMEOUT_MS,
  CONTENT_BROWSER_MAX_IMAGE_PIXELS,
} from './contentVerification.web';
import { createContentVerificationPorts as nativePorts } from './contentVerification';
import { readContentImageHeader } from './contentImageHeader';

// Node fixture mechanics stay local to this Jest test; the app's type environment remains native/browser.
const { readFileSync } = require('node:fs') as { readFileSync(path: string): Uint8Array };
const { join } = require('node:path') as { join(...paths: string[]): string };
interface FixtureHash {
  update(value: string | Uint8Array): FixtureHash;
  digest(encoding: 'hex'): string;
}
const { createHash } = require('node:crypto') as { createHash(algorithm: string): FixtureHash };
const { Buffer } = require('node:buffer') as {
  Buffer: { from(value: string, encoding: 'base64'): Uint8Array };
};

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  randomUUID: () => jest.requireActual('node:crypto').randomUUID(),
  digestStringAsync: async (_algorithm: string, text: string) =>
    jest.requireActual('node:crypto').createHash('sha256').update(text).digest('hex'),
  digest: async (_algorithm: string, bytes: Uint8Array) => {
    const result: Uint8Array = jest
      .requireActual('node:crypto')
      .createHash('sha256')
      .update(bytes)
      .digest();
    return new Uint8Array(result).buffer;
  },
}));
jest.mock('expo-asset', () => ({ Asset: { fromModule: jest.fn() } }));
jest.mock('@cookmate/catalogue/photos', () => ({ recipePhotoAssets: { '53262': 1 } }));
// Adapter tests own browser/platform ports. Real Ed25519 verification is exercised in content-trust tests and signed-store integration.
jest.mock('@cookmate/catalogue/content-trust', () => ({
  createContentTrustVerifier: jest.fn((keys: unknown) =>
    Object.freeze({ configuredKeys: keys, verify: jest.fn() }),
  ),
}));

const page = 'http://localhost:8081/iphone-preview.html',
  assetUrl = 'http://localhost:8081/assets/bundled-photo.jpg';
const keys = () => [{ keyId: 'configured-host-key', publicKeyHex: 'a'.repeat(64) }];
const asset = () =>
  new Uint8Array(
    readFileSync(join(process.cwd(), '../../packages/catalogue/assets/photos/53262.jpg')),
  );
const config = () => ({ trustKeys: keys(), readerVersion: 1 });
const globals = ['Image', 'Blob', 'URL', 'fetch', 'location'] as const;
const old = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let width = 1,
  height = 1;
let decode: jest.Mock<Promise<void>, []>,
  createUrl: jest.Mock,
  revoke: jest.Mock,
  remove: jest.Mock;
let fetchAsset: jest.Mock;
let latestBlob: Blob | null;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  width = 1;
  height = 1;
  latestBlob = null;
  decode = jest.fn(async () => undefined);
  remove = jest.fn();
  class ImageFixture {
    src = '';
    get naturalWidth() {
      return width;
    }
    get naturalHeight() {
      return height;
    }
    decode() {
      return decode();
    }
    removeAttribute(key: string) {
      remove(key);
      this.src = '';
    }
  }
  const URLConstructor = jest.requireActual('node:url').URL;
  createUrl = jest.fn((blob: Blob) => {
    latestBlob = blob;
    return 'blob:owned-verification';
  });
  revoke = jest.fn();
  Object.defineProperties(URLConstructor, {
    createObjectURL: { configurable: true, value: createUrl },
    revokeObjectURL: { configurable: true, value: revoke },
  });
  fetchAsset = jest.fn();
  Object.defineProperties(globalThis, {
    Image: { configurable: true, value: ImageFixture },
    Blob: { configurable: true, value: jest.requireActual('node:buffer').Blob },
    URL: { configurable: true, value: URLConstructor },
    fetch: { configurable: true, value: fetchAsset },
    location: { configurable: true, value: { href: page } },
  });
  jest.mocked(Asset.fromModule).mockReturnValue({ uri: assetUrl } as Asset);
});
afterEach(() => {
  jest.useRealTimers();
  for (const key of globals) {
    const descriptor = old.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function response(
  chunks: Uint8Array[],
  options: { length?: string | null; url?: string; redirected?: boolean; pending?: boolean } = {},
) {
  let index = 0;
  const read = jest.fn(() =>
    options.pending
      ? new Promise<never>(() => undefined)
      : Promise.resolve(
          index < chunks.length
            ? { done: false, value: chunks[index++]! }
            : { done: true, value: undefined },
        ),
  );
  const cancel = jest.fn(async () => undefined),
    releaseLock = jest.fn();
  const body = {
    getReader: jest.fn(() => ({ read, cancel, releaseLock })),
    cancel: jest.fn(async () => undefined),
  };
  return {
    ok: true,
    url: options.url ?? assetUrl,
    redirected: options.redirected ?? false,
    headers: { get: () => options.length ?? null },
    body,
    read,
    cancel,
    releaseLock,
  };
}
function png(w = 1, h = 1) {
  const bytes = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6x1UAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  new DataView(bytes.buffer).setUint32(16, w);
  new DataView(bytes.buffer).setUint32(20, h);
  return bytes;
}
function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X', w = 3, h = 2) {
  const size = kind === 'VP8L' ? 5 : 10;
  const bytes = new Uint8Array(20 + size + (size % 2)),
    view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WEBP'],
    [12, kind],
  ] as const)
    [...text].forEach((c, i) => (bytes[offset + i] = c.charCodeAt(0)));
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, size, true);
  if (kind === 'VP8 ') {
    bytes.set([0x9d, 1, 0x2a], 23);
    view.setUint16(26, w, true);
    view.setUint16(28, h, true);
  } else if (kind === 'VP8L') {
    bytes[20] = 0x2f;
    view.setUint32(21, (w - 1) | ((h - 1) << 14), true);
  } else {
    bytes[20] = 2;
    bytes[24] = w - 1;
    bytes[27] = h - 1;
  }
  return bytes;
}

test('uses independently built packaged baseline and owns configured keys before its first await', async () => {
  const options = config(),
    original = JSON.parse(JSON.stringify(options.trustKeys));
  const pending = createContentVerificationPorts(options);
  options.trustKeys[0]!.keyId = 'caller-mutated';
  options.readerVersion = 99;
  const ports = await pending;
  expect(createContentTrustVerifier).toHaveBeenCalledWith(original);
  expect(ports.readerVersion).toBe(1);
  expect(ports.baseline.revisions).toHaveLength(100);
  expect(Object.isFrozen(ports.baseline.revisions[0]!.ref)).toBe(true);
  expect(await ports.sha256('test')).toBe(createHash('sha256').update('test').digest('hex'));
  expect(await ports.sha256Bytes(new Uint8Array([1, 2]))).toBe(
    createHash('sha256')
      .update(new Uint8Array([1, 2]))
      .digest('hex'),
  );
});

test('defaults to the implemented translation reader capability while preserving explicit reader version one', async () => {
  const supported = await createContentVerificationPorts({ trustKeys: keys() });
  const prior = await createContentVerificationPorts({ trustKeys: keys(), readerVersion: 1 });
  expect(supported.readerVersion).toBe(TRANSLATED_PUBLICATION_READER_VERSION);
  expect(supported.readerVersion).toBe(2);
  expect(prior.readerVersion).toBe(1);
  expect(prior.baseline).toEqual(supported.baseline);
  expect(fetchAsset).not.toHaveBeenCalled();
  expect(decode).not.toHaveBeenCalled();
});

test('rejects configuration accessors without executing them and leaves native explicitly unavailable', async () => {
  const getter = jest.fn(() => keys()),
    options = Object.defineProperty({}, 'trustKeys', { enumerable: true, get: getter });
  await expect(
    createContentVerificationPorts(options as ReturnType<typeof config>),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  await expect(nativePorts(config())).rejects.toMatchObject({ reason: 'native_unavailable' });
});

test('all100 real packaged JPEG headers are bounded and readable before actual browser decode', () => {
  for (const entry of catalogueProvenance.assets) {
    const bytes = new Uint8Array(
      readFileSync(join(process.cwd(), '../../packages/catalogue', entry.packagedPath)),
    );
    const header = readContentImageHeader(bytes);
    expect(header?.mimeType).toBe('image/jpeg');
    expect(header!.width * header!.height).toBeLessThanOrEqual(CONTENT_BROWSER_MAX_IMAGE_PIXELS);
  }
});

test('PNG and both simple WebP headers are admitted; animation and truncated structures are not', () => {
  expect(readContentImageHeader(png())).toEqual({ mimeType: 'image/png', width: 1, height: 1 });
  for (const kind of ['VP8 ', 'VP8L'] as const)
    expect(readContentImageHeader(webp(kind))).toEqual({
      mimeType: 'image/webp',
      width: 3,
      height: 2,
    });
  expect(readContentImageHeader(webp('VP8X'))).toBeNull();
  const animated = png();
  animated.set([97, 99, 84, 76], 37);
  expect(readContentImageHeader(animated)).toBeNull();
  expect(readContentImageHeader(png().subarray(0, 24))).toBeNull();
  expect(readContentImageHeader(new Uint8Array([60, 115, 118, 103, 62]))).toBeNull();
});

test('image results require real decoder completion and agree with bytes, with URL cleanup on success', async () => {
  const ports = await createContentVerificationPorts(config());
  let finish!: () => void;
  decode.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const bytes = png(),
    pending = ports.inspectImage(bytes);
  bytes[0] = 0;
  expect(revoke).not.toHaveBeenCalled();
  finish();
  expect(await pending).toEqual({ mimeType: 'image/png', width: 1, height: 1 });
  expect(new Uint8Array(await latestBlob!.arrayBuffer())[0]).toBe(137);
  expect(remove).toHaveBeenCalledWith('src');
  expect(revoke).toHaveBeenCalledWith('blob:owned-verification');
});

test('decode errors, dimension mismatch and timeout cannot claim verification and release every URL', async () => {
  const ports = await createContentVerificationPorts(config());
  decode.mockRejectedValueOnce(new Error('Invalid compressed image'));
  expect(await ports.inspectImage(png())).toBeNull();
  width = 3;
  expect(await ports.inspectImage(png())).toBeNull();
  decode.mockImplementationOnce(() => new Promise(() => undefined));
  const pending = ports.inspectImage(png());
  await jest.advanceTimersByTimeAsync(CONTENT_BROWSER_IO_TIMEOUT_MS);
  expect(await pending).toBeNull();
  expect(revoke).toHaveBeenCalledTimes(3);
});

test('pixel/byte caps reject before image allocation and unsupported payload never reaches decoder', async () => {
  const ports = await createContentVerificationPorts(config());
  await expect(ports.inspectImage(png(4001, 4000))).rejects.toMatchObject({
    reason: 'image_limit',
  });
  expect(await ports.inspectImage(new Uint8Array(CONTENT_LIMITS.mediaBytes + 1))).toBeNull();
  expect(await ports.inspectImage(webp('VP8X'))).toBeNull();
  expect(decode).not.toHaveBeenCalled();
  expect(createUrl).not.toHaveBeenCalled();
});

test('bundled reads use exact installed asset membership, stream to the expected length and independently hash bytes', async () => {
  const ports = await createContentVerificationPorts(config()),
    reference = ports.baseline.revisions[0]!.document.media[0]!;
  const bytes = asset(),
    stream = response([bytes.subarray(0, 100), bytes.subarray(100)], {
      length: String(bytes.length),
    });
  fetchAsset.mockResolvedValue(stream);
  expect(await ports.readBundledMedia(reference)).toEqual(bytes);
  expect(Asset.fromModule).toHaveBeenCalledWith(1);
  expect(fetchAsset).toHaveBeenCalledWith(
    assetUrl,
    expect.objectContaining({ redirect: 'error', credentials: 'omit', mode: 'same-origin' }),
  );
  expect(fetchAsset.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(stream.cancel).toHaveBeenCalled();
  const forged = {
    ...reference,
    attribution: { ...reference.attribution, url: 'https://arbitrary.test/image' },
  };
  fetchAsset.mockClear();
  expect(await ports.readBundledMedia(forged)).toBeNull();
  expect(fetchAsset).not.toHaveBeenCalled();
});

test('cross-origin packaged locations and any response redirect are refused without reading media bodies', async () => {
  const ports = await createContentVerificationPorts(config()),
    reference = ports.baseline.revisions[0]!.document.media[0]!;
  jest
    .mocked(Asset.fromModule)
    .mockReturnValueOnce({ uri: 'https://different.test/photo.jpg' } as Asset);
  expect(await ports.readBundledMedia(reference)).toBeNull();
  expect(fetchAsset).not.toHaveBeenCalled();
  const stream = response([asset()], { redirected: true });
  fetchAsset.mockResolvedValue(stream);
  expect(await ports.readBundledMedia(reference)).toBeNull();
  expect(stream.body.getReader).not.toHaveBeenCalled();
});

test('oversized/truncated/wrong-digest or dishonest length streams never return bundled media', async () => {
  const ports = await createContentVerificationPorts(config()),
    reference = ports.baseline.revisions[0]!.document.media[0]!;
  const bytes = asset(),
    wrong = bytes.slice();
  wrong[30] = wrong[30]! ^ 1;
  for (const stream of [
    response([bytes, new Uint8Array([1])]),
    response([bytes.subarray(1)]),
    response([wrong]),
    response([bytes], { length: String(bytes.length + 1) }),
  ]) {
    fetchAsset.mockResolvedValueOnce(stream);
    expect(await ports.readBundledMedia(reference)).toBeNull();
  }
});

test('bounded fetch deadlines abort and cancel late or stalled streams', async () => {
  const ports = await createContentVerificationPorts(config()),
    reference = ports.baseline.revisions[0]!.document.media[0]!;
  let finish!: (value: ReturnType<typeof response>) => void;
  fetchAsset.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = ports.readBundledMedia(reference);
  await jest.advanceTimersByTimeAsync(CONTENT_BROWSER_IO_TIMEOUT_MS);
  expect(await pending).toBeNull();
  const late = response([asset()]);
  finish(late);
  await Promise.resolve();
  expect(late.body.cancel).toHaveBeenCalled();
  const stalled = response([], { pending: true });
  fetchAsset.mockResolvedValueOnce(stalled);
  const waiting = ports.readBundledMedia(reference);
  await jest.advanceTimersByTimeAsync(CONTENT_BROWSER_IO_TIMEOUT_MS);
  expect(await waiting).toBeNull();
  expect(stalled.cancel).toHaveBeenCalled();
});
