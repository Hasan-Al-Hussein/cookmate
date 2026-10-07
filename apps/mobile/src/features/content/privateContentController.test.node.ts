import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPrivateContentController,
  type PrivateContentOpeningLease,
} from './privateContentController';
import { PrivateContentCleanupError, type PrivateContentRuntime } from './privateContentRuntime';

function pending<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
const prepared = { kind: 'prepared' as const, resumed: false };
function runtime(close: () => Promise<void> = async () => {}) {
  return {
    storageScope: { installationId: '10000000-0000-4000-8000-000000000001', ownerId: null },
    host: {} as PrivateContentRuntime['host'],
    fetchRelease: async () => {
      throw new Error('unused');
    },
    close,
  };
}

test('preparation and open cannot acquire the same workspace; later clean open works', async () => {
  const work = pending<typeof prepared>();
  let starts = 0;
  const controller = createPrivateContentController({
    prepare: () => work.promise,
    async open() {
      starts++;
      return runtime();
    },
  });
  const first = controller.prepare();
  await assert.rejects(controller.prepare(), /already in use/);
  await assert.rejects(controller.open(), /already in use/);
  assert.equal(starts, 0);
  work.resolve(prepared);
  assert.deepEqual(await first, prepared);
  const opened = await controller.open();
  await assert.rejects(controller.prepare(), /already in use/);
  await opened.close();
  assert.deepEqual(await controller.prepare(), prepared);
});

test('runtime close revokes synchronously and holds preparation until cleanup settles', async () => {
  const retired = pending<void>();
  let revoked = false;
  const controller = createPrivateContentController({
    prepare: async () => prepared,
    open: async () =>
      runtime(() => {
        revoked = true;
        return retired.promise;
      }),
  });
  const opened = await controller.open();
  const close = opened.close();
  assert.equal(revoked, true);
  assert.equal(opened.close(), close);
  await assert.rejects(controller.prepare(), /already in use/);
  retired.resolve();
  await close;
  assert.deepEqual(await controller.prepare(), prepared);
});

test('failed preparation cleanup blocks both preparation and reader entry', async () => {
  const failure = new PrivateContentCleanupError([new Error('close')]);
  const controller = createPrivateContentController({
    prepare: async () => {
      throw failure;
    },
    open: async () => runtime(),
  });
  await assert.rejects(controller.prepare(), (error) => error === failure);
  await assert.rejects(controller.prepare(), (error) => error === failure);
  await assert.rejects(controller.open(), (error) => error === failure);
});

test('failed runtime cleanup remains a typed barrier even after another open is requested', async () => {
  const controller = createPrivateContentController({
    prepare: async () => prepared,
    open: async () =>
      runtime(async () => {
        throw new Error('close failed');
      }),
  });
  const opened = await controller.open();
  await assert.rejects(opened.close(), PrivateContentCleanupError);
  await assert.rejects(controller.open(), PrivateContentCleanupError);
  await assert.rejects(controller.prepare(), PrivateContentCleanupError);
});

test('clean preparation and reader failures release their admission without changing ports', async () => {
  let prepareCalls = 0,
    openCalls = 0;
  const ports = {
    async prepare() {
      if (!prepareCalls++) throw new Error('admission refused');
      return prepared;
    },
    async open() {
      if (!openCalls++) throw new Error('read refused');
      return runtime();
    },
  };
  const controller = createPrivateContentController(ports);
  ports.prepare = async () => {
    throw new Error('caller replaced');
  };
  await assert.rejects(controller.prepare(), /admission refused/);
  assert.deepEqual(await controller.prepare(), prepared);
  await assert.rejects(controller.open(), /read refused/);
  const opened = await controller.open();
  await opened.close();
});

test('selection holds the same closed lease as preparation and runtime ownership', async () => {
  const work = pending<void>();
  const controller = createPrivateContentController({
    prepare: async () => prepared,
    open: async () => runtime(),
  });
  let retainedCheck!: () => void;
  const selection = controller.whileClosed(async (assertClosed) => {
    retainedCheck = assertClosed;
    assertClosed();
    await work.promise;
    assertClosed();
  });
  await assert.rejects(controller.prepare(), /already in use/);
  await assert.rejects(controller.open(), /already in use/);
  await assert.rejects(
    controller.whileClosed(async () => {}),
    /already in use/,
  );
  work.resolve();
  await selection;
  assert.throws(retainedCheck, /lease has ended/);
  const opened = await controller.open();
  assert.deepEqual(opened.storageScope, {
    installationId: '10000000-0000-4000-8000-000000000001',
    ownerId: null,
  });
  await assert.rejects(
    controller.whileClosed(async () => {}),
    /already in use/,
  );
  await opened.close();
  await controller.whileClosed(async (check) => check());
});

test('failed selection cleanup is sticky across every entry point', async () => {
  const failure = new PrivateContentCleanupError([new Error('copy handle close')]);
  const controller = createPrivateContentController({
    prepare: async () => prepared,
    open: async () => runtime(),
  });
  await assert.rejects(
    controller.whileClosed(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  await assert.rejects(controller.prepare(), (error) => error === failure);
  await assert.rejects(controller.open(), (error) => error === failure);
  await assert.rejects(
    controller.whileClosed(async () => {}),
    (error) => error === failure,
  );
});

test('opening verification joins only the issuing controller and expires with that opening', async () => {
  let lease!: PrivateContentOpeningLease;
  let captured!: () => void;
  const other = createPrivateContentController({
    prepare: async () => prepared,
    open: async () => runtime(),
  });
  const controller = createPrivateContentController({
    prepare: async () => prepared,
    open: async (issued) => {
      lease = issued;
      await assert.rejects(
        other.duringOpening(issued, async () => {}),
        /lease has ended/,
      );
      await controller.duringOpening(issued, async (check) => {
        captured = check;
        check();
        await assert.rejects(
          controller.whileClosed(async () => {}),
          /already in use/,
        );
        await assert.rejects(
          controller.duringOpening(issued, async () => {}),
          /already in use/,
        );
        check();
      });
      return runtime();
    },
  });
  const opened = await controller.open();
  assert.throws(captured, /lease has ended/);
  await assert.rejects(
    controller.duringOpening(lease, async () => {}),
    /lease has ended/,
  );
  await opened.close();
  await assert.rejects(
    controller.duringOpening(lease, async () => {}),
    /lease has ended/,
  );
});
