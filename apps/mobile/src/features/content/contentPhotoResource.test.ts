import type { VerifiedContentPhoto } from '../../data/contentReadingMedia';
import { createContentPhotoResource } from './contentPhotoResource';
import { createContentPhotoResource as createWebResource } from './contentPhotoResource.web';
import { ContentPhotoCleanupError } from './contentPhotoResourceTypes';

const mockFiles = new Map<string, { bytes: Uint8Array; deleted: boolean }>();
let mockWriteFailure = false;
let mockDeleteFailure = false;
let mockPathChange = false;
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));
jest.mock('expo-file-system', () => ({
  Paths: { cache: { uri: 'file:///content-cache/' } },
  File: class {
    uri: string;
    constructor(_base: unknown, name: string) {
      this.uri = `${mockPathChange ? 'file:///user-originals/' : 'file:///content-cache/'}${name}`;
    }
    get exists() {
      return mockFiles.has(this.uri) && !mockFiles.get(this.uri)!.deleted;
    }
    create({ overwrite }: { overwrite: boolean }) {
      if (this.exists && !overwrite) throw new Error('File already exists');
      mockFiles.set(this.uri, { bytes: new Uint8Array(), deleted: false });
    }
    write(bytes: Uint8Array) {
      if (mockWriteFailure) throw new Error('Disk full');
      mockFiles.get(this.uri)!.bytes = bytes;
    }
    delete() {
      if (mockDeleteFailure) throw new Error('File busy');
      mockFiles.get(this.uri)!.deleted = true;
    }
  },
}));
function photo(): VerifiedContentPhoto {
  return {
    contentRef: {
      recipeId: '52819',
      revisionId: 'fixture-photo',
      contentFingerprint: 'a'.repeat(64),
    },
    assetId: `sha256:${'b'.repeat(64)}`,
    sha256: 'b'.repeat(64),
    mimeType: 'image/jpeg',
    width: 8,
    height: 8,
    bytes: new Uint8Array([1, 2, 3]),
  };
}
beforeEach(() => {
  mockFiles.clear();
  mockWriteFailure = false;
  mockDeleteFailure = false;
  mockPathChange = false;
});

test('native display owns a cache copy and idempotently releases only that copy', () => {
  const input = photo(),
    resource = createContentPhotoResource(input);
  input.bytes[0] = 99;
  expect(mockFiles.get(resource.uri)!.bytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(resource.uri).toMatch(/^file:\/\/\/content-cache\/cookmate-content-photo-.*\.jpg$/);
  expect(resource.release()).toBe(true);
  expect(resource.release()).toBe(true);
  expect(mockFiles.get(resource.uri)!.deleted).toBe(true);
});
test('a cache collision does not overwrite or delete a file owned by another lease', () => {
  const first = createContentPhotoResource(photo());
  expect(() => createContentPhotoResource(photo())).toThrow('File already exists');
  expect(mockFiles.get(first.uri)!.deleted).toBe(false);
  expect(mockFiles.get(first.uri)!.bytes).toEqual(new Uint8Array([1, 2, 3]));
});
test('failed writes clean up their own file; cleanup failure remains visible and retryable', () => {
  mockWriteFailure = true;
  expect(() => createContentPhotoResource(photo())).toThrow('Disk full');
  expect([...mockFiles.values()][0]!.deleted).toBe(true);
  mockFiles.clear();
  mockWriteFailure = false;
  const resource = createContentPhotoResource(photo());
  mockDeleteFailure = true;
  expect(resource.release()).toBe(false);
  mockDeleteFailure = false;
  expect(resource.release()).toBe(true);
});
test('a path outside the owned cache and invalid byte metadata create no files', () => {
  mockPathChange = true;
  expect(() => createContentPhotoResource(photo())).toThrow('cache path differs');
  mockPathChange = false;
  expect(() =>
    createContentPhotoResource({ ...photo(), assetId: 'https://example.test/photo' }),
  ).toThrow();
  expect(() => createContentPhotoResource({ ...photo(), bytes: new Uint8Array() })).toThrow();
  expect(mockFiles.size).toBe(0);
});
test('combined write and deletion failure preserves a retryable owned cleanup capability', () => {
  mockWriteFailure = true;
  mockDeleteFailure = true;
  let failure: ContentPhotoCleanupError | undefined;
  try {
    createContentPhotoResource(photo());
  } catch (error) {
    if (!(error instanceof ContentPhotoCleanupError)) throw error;
    failure = error;
  }
  expect(failure).toBeInstanceOf(ContentPhotoCleanupError);
  expect(failure!.resource.release()).toBe(false);
  mockDeleteFailure = false;
  expect(failure!.resource.release()).toBe(true);
  expect(mockFiles.get(failure!.resource.uri)!.deleted).toBe(true);
});
test('browser Blob snapshots exact bytes and revokes its object URL once, without a remote URL', async () => {
  const descriptors = new Map(
    ['Blob', 'URL'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const createObjectURL = jest.fn((_blob: Blob) => 'blob:owned-photo'),
    revokeObjectURL = jest.fn();
  Object.defineProperty(globalThis, 'Blob', {
    configurable: true,
    value: require('node:buffer').Blob,
  });
  Object.defineProperty(globalThis, 'URL', {
    configurable: true,
    value: { createObjectURL, revokeObjectURL },
  });
  try {
    const input = photo(),
      resource = createWebResource(input);
    input.bytes[0] = 99;
    const blob = createObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('image/jpeg');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(resource.release()).toBe(true);
    expect(resource.release()).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:owned-photo');
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
