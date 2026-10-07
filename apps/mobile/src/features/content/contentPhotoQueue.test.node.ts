import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdoptedContentReadError,
  type ContentPhotoRequest,
  type createAdoptedContentReader,
} from '../../data/adoptedContentReader';
import { createContentPhotoQueue } from './contentPhotoQueue';

type Reader = ReturnType<typeof createAdoptedContentReader>;
type Result = Awaited<ReturnType<Reader['readPhotos']>>;
const ref = { recipeId: '1', revisionId: 'test', contentFingerprint: 'a'.repeat(64) };
const input = (id: number): ContentPhotoRequest => ({ ref, assetId: `asset-${id}` });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function result(requests: readonly ContentPhotoRequest[]): Result {
  return {
    installationId: 'fixture',
    ownerId: null,
    head: null,
    adoptionRevision: 0,
    identity: { version: 'fixture', fingerprint: 'a'.repeat(64) },
    value: requests.map((request) => ({
      kind: 'ready',
      photo: {
        contentRef: request.ref,
        assetId: request.assetId,
        sha256: 'b'.repeat(64),
        mimeType: 'image/png',
        width: 1,
        height: 1,
        bytes: new Uint8Array([1]),
      },
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('mounted reads coalesce in order with only one submitted batch at a time', async () => {
  const gates: ReturnType<typeof deferred<Result>>[] = [];
  const seen: ContentPhotoRequest[][] = [];
  const queue = createContentPhotoQueue((requests) => {
    seen.push([...requests]);
    const gate = deferred<Result>();
    gates.push(gate);
    return gate.promise;
  });
  const reads = Array.from({ length: 14 }, (_, id) => queue.read(input(id), () => {}));
  await flush();
  assert.deepEqual(
    seen.map((x) => x.length),
    [6],
  );
  gates[0]!.resolve(result(seen[0]!));
  await flush();
  assert.deepEqual(
    seen.map((x) => x.length),
    [6, 6],
  );
  gates[1]!.resolve(result(seen[1]!));
  await flush();
  assert.deepEqual(
    seen.map((x) => x.length),
    [6, 6, 2],
  );
  gates[2]!.resolve(result(seen[2]!));
  assert.deepEqual(
    (await Promise.all(reads)).map((x) => x.value.assetId),
    Array.from({ length: 14 }, (_, i) => input(i).assetId),
  );
  queue.close();
});
test('abort before dispatch removes a request without cancelling its neighbour', async () => {
  const calls: ContentPhotoRequest[][] = [];
  const queue = createContentPhotoQueue(async (requests) => {
    calls.push([...requests]);
    return result(requests);
  });
  const abort = new AbortController();
  const retired = assert.rejects(
    queue.read(input(0), () => {}, abort.signal),
    /retired/,
  );
  const kept = queue.read(input(1), () => {});
  abort.abort();
  await retired;
  assert.equal((await kept).value.assetId, input(1).assetId);
  assert.deepEqual(
    calls.map((x) => x.map((y) => y.assetId)),
    [['asset-1']],
  );
  queue.close();
});
test('in-flight abort settles immediately and suppresses its late bytes', async () => {
  const gate = deferred<Result>();
  let requests: readonly ContentPhotoRequest[] = [];
  const queue = createContentPhotoQueue((values) => {
    requests = values;
    return gate.promise;
  });
  const abort = new AbortController();
  const retired = assert.rejects(
    queue.read(input(0), () => {}, abort.signal),
    /retired/,
  );
  const kept = queue.read(input(1), () => {});
  await flush();
  abort.abort();
  await retired;
  gate.resolve(result(requests));
  assert.equal((await kept).value.assetId, 'asset-1');
  queue.close();
});
test('scope invalidation settles and removes pending requests before host dispatch', async () => {
  let calls = 0;
  const queue = createContentPhotoQueue(async (requests) => {
    calls++;
    return result(requests);
  });
  const read = assert.rejects(
    queue.read(input(0), () => {}),
    /changed/,
  );
  queue.cancel(new Error('scope changed'));
  await read;
  await flush();
  assert.equal(calls, 0);
  queue.close();
});
test('closed queue cannot accept new work or expose in-flight results', async () => {
  const gate = deferred<Result>();
  const queue = createContentPhotoQueue(() => gate.promise);
  const pending = assert.rejects(
    queue.read(input(0), () => {}),
    /closed/,
  );
  await flush();
  queue.close();
  await pending;
  gate.resolve(result([input(0)]));
  await flush();
  await assert.rejects(
    queue.read(input(1), () => {}),
    /retired/,
  );
});
test('only aggregate-byte rejection produces finite sequential splits', async () => {
  const sizes: number[] = [];
  const queue = createContentPhotoQueue(async (requests) => {
    sizes.push(requests.length);
    if (requests.length > 1) throw new AdoptedContentReadError('photo_batch_too_large');
    return result(requests);
  });
  const values = await Promise.all(
    Array.from({ length: 6 }, (_, i) => queue.read(input(i), () => {})),
  );
  assert.deepEqual(sizes, [6, 3, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(
    values.map((x) => x.value.assetId),
    Array.from({ length: 6 }, (_, i) => input(i).assetId),
  );
  queue.close();
});
test('authority failure is not retried or converted into partial success', async () => {
  let calls = 0;
  const queue = createContentPhotoQueue(async () => {
    calls++;
    throw new AdoptedContentReadError('policy_changed');
  });
  await Promise.all(
    [0, 1].map((i) =>
      assert.rejects(
        queue.read(input(i), () => {}),
        (error) => error instanceof AdoptedContentReadError && error.code === 'policy_changed',
      ),
    ),
  );
  assert.equal(calls, 1);
  queue.close();
});
test('one unavailable asset does not hide a different successful photo', async () => {
  const queue = createContentPhotoQueue(async (requests) => {
    const value = result(requests);
    return { ...value, value: [{ kind: 'unavailable' }, value.value[1]!] };
  });
  const missing = assert.rejects(
    queue.read(input(0), () => {}),
    /unavailable/,
  );
  const available = queue.read(input(1), () => {});
  await missing;
  assert.equal((await available).value.assetId, 'asset-1');
  queue.close();
});
test('pending metadata is bounded and cancellation releases admission', async () => {
  const gate = deferred<Result>();
  const queue = createContentPhotoQueue(() => gate.promise);
  const reads = Array.from({ length: 128 }, (_, i) =>
    assert.rejects(
      queue.read(input(i), () => {}),
      /changed/,
    ),
  );
  await assert.rejects(
    queue.read(input(129), () => {}),
    /full/,
  );
  queue.cancel(new Error('scope changed'));
  await Promise.all(reads);
  queue.close();
});
