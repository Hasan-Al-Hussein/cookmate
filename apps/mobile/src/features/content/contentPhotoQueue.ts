import {
  CONTENT_PHOTO_BATCH_LIMIT,
  AdoptedContentReadError,
  type ContentPhotoRequest,
  type createAdoptedContentReader,
} from '../../data/adoptedContentReader';

type Reader = ReturnType<typeof createAdoptedContentReader>;
type PhotoResult = Awaited<ReturnType<Reader['readPhoto']>>;
type Request = {
  input: ContentPhotoRequest;
  check(): void;
  settled: boolean;
  finish(value: PhotoResult): void;
  fail(error: unknown): void;
};

/** Coalesces mounted photo reads only; never retains verified bytes or trust between batches. */
export function createContentPhotoQueue(readPhotos: Reader['readPhotos']) {
  const pending: Request[] = [];
  const active = new Set<Request>();
  let running = false;
  let scheduled = false;
  let closed = false;
  let batchLimit = CONTENT_PHOTO_BATCH_LIMIT;
  function schedule() {
    if (closed || running || scheduled || !pending.length) return;
    scheduled = true;
    void Promise.resolve().then(run);
  }
  async function run() {
    scheduled = false;
    if (closed || running) return;
    const batch: Request[] = [];
    while (pending.length && batch.length < batchLimit) {
      const request = pending.shift()!;
      if (request.settled) continue;
      try {
        request.check();
        batch.push(request);
      } catch (error) {
        request.fail(error);
      }
    }
    if (!batch.length) return;
    running = true;
    try {
      const { value, ...identity } = await readPhotos(batch.map((request) => request.input));
      if (!Array.isArray(value) || value.length !== batch.length)
        throw new Error('Photo batch result does not match its request');
      for (const [index, request] of batch.entries()) {
        if (request.settled) continue;
        try {
          request.check();
          const item = value[index]!;
          if (item.kind !== 'ready') throw new Error('Exact photo unavailable');
          request.finish(Object.freeze({ ...identity, value: item.photo }));
        } catch (error) {
          request.fail(error);
        }
      }
    } catch (error) {
      if (
        error instanceof AdoptedContentReadError &&
        error.code === 'photo_batch_too_large' &&
        batch.length > 1 &&
        !closed
      ) {
        // A finite split handles legitimate large photographs without holding their bytes
        // together. Each smaller group obtains a fresh reservation; no trust is cached.
        batchLimit = Math.max(1, Math.floor(batch.length / 2));
        pending.unshift(...batch.filter((request) => !request.settled));
      } else {
        for (const request of batch) request.fail(error);
      }
    } finally {
      running = false;
      if (!pending.length) batchLimit = CONTENT_PHOTO_BATCH_LIMIT;
      schedule();
    }
  }
  return Object.freeze({
    read(
      input: ContentPhotoRequest,
      check: () => void,
      signal?: AbortSignal,
    ): Promise<PhotoResult> {
      if (closed || signal?.aborted) return Promise.reject(new Error('Photo request retired'));
      // Bounded metadata only. The UI has at most a small window of mounted recipe cards.
      if (active.size >= 128) return Promise.reject(new Error('Photo request queue is full'));
      return new Promise((resolve, reject) => {
        function release() {
          request.settled = true;
          active.delete(request);
          const index = pending.indexOf(request);
          if (index >= 0) pending.splice(index, 1);
          signal?.removeEventListener('abort', abort);
        }
        const request: Request = {
          input,
          check,
          settled: false,
          finish(value) {
            if (request.settled) return;
            release();
            resolve(value);
          },
          fail(error) {
            if (request.settled) return;
            release();
            reject(error);
          },
        };
        function abort() {
          request.fail(new Error('Photo request retired'));
        }
        active.add(request);
        pending.push(request);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        schedule();
      });
    },
    close() {
      closed = true;
      for (const request of active) request.fail(new Error('Photo queue closed'));
    },
    cancel(error: unknown) {
      for (const request of active) request.fail(error);
    },
  });
}
