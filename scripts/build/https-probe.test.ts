import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoundedJson } from '../../apps/mobile/src/foundation/readBoundedJson.js';

test('health probe decodes bounded split UTF-8 data', async () => {
  const bytes = new TextEncoder().encode('{"label":"🍎"}');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 12));
      controller.enqueue(bytes.slice(12));
      controller.close();
    },
  });
  assert.deepEqual(await readBoundedJson(body, 100), { label: '🍎' });
});

test('health probe cancels oversized stream before reading the remaining body', async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(readBoundedJson(body, 2048), /byte limit/);
  assert.equal(reads, 3);
  assert.equal(cancelled, true);
});

test('health probe rejects malformed JSON and invalid UTF-8', async () => {
  for (const bytes of [new TextEncoder().encode('{"broken":'), new Uint8Array([0xff])]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    await assert.rejects(readBoundedJson(body, 2048));
  }
});
