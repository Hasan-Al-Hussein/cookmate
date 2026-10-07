import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { RecentlyViewedProvider, useRecentlyViewed } from './RecentlyViewedProvider';
import { createRecentlyViewedController, encodeRecentlyViewed } from './recentlyViewed';

const ref = { recipeId: '1', revisionId: 'revision-1', contentFingerprint: 'a'.repeat(64) };
const instant = Date.UTC(2026, 9, 2);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let observed: ReturnType<typeof useRecentlyViewed>;
function Probe() {
  observed = useRecentlyViewed();
  return null;
}
afterEach(cleanup);

test('isolated leaves are disabled and cannot imply that history was saved', async () => {
  render(<Probe />);
  expect(observed.enabled).toBe(false);
  expect(observed.entries).toEqual([]);
  expect(await observed.recordOpen(ref)).toBe(false);
  expect(await observed.setEnabled(true)).toBe(false);
});

test('hydration and provider mounting never record an impression', async () => {
  const loading = deferred<string | null>();
  const write = jest.fn(async () => {});
  const controller = createRecentlyViewedController(
    { read: () => loading.promise, write },
    { now: () => instant },
  );
  render(
    <RecentlyViewedProvider controller={controller}>
      <Probe />
    </RecentlyViewedProvider>,
  );
  expect(observed.hydrated).toBe(false);
  await act(async () => {
    loading.resolve(encodeRecentlyViewed({ enabled: true, entries: [] }));
    await controller.drain();
  });
  expect(observed.hydrated).toBe(true);
  expect(observed.enabled).toBe(true);
  expect(observed.entries).toEqual([]);
  expect(write).not.toHaveBeenCalled();
});

test('provider remount uses the root-owned controller and lets its genuine pending write settle', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const read = jest.fn(async () => encodeRecentlyViewed({ enabled: true, entries: [] }));
  const write = jest.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const controller = createRecentlyViewedController({ read, write }, { now: () => instant });
  const tree = () => (
    <RecentlyViewedProvider controller={controller}>
      <Probe />
    </RecentlyViewedProvider>
  );
  const first = render(tree());
  await waitFor(() => expect(observed.hydrated).toBe(true));
  let recording!: Promise<boolean>;
  await act(async () => {
    recording = observed.recordOpen(ref);
    await entered.promise;
  });
  first.unmount();
  render(tree());
  expect(observed.entries).toEqual([]);
  await act(async () => {
    release.resolve();
    expect(await recording).toBe(true);
    await controller.drain();
  });
  expect(observed.entries).toHaveLength(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
});

test("a retired owner's late hydration cannot enter the next provider snapshot", async () => {
  const loading = deferred<string | null>();
  const old = createRecentlyViewedController(
    { read: () => loading.promise, write: async () => {} },
    { now: () => instant },
  );
  const next = createRecentlyViewedController(
    { read: async () => null, write: async () => {} },
    { now: () => instant },
  );
  const view = render(
    <RecentlyViewedProvider controller={old}>
      <Probe />
    </RecentlyViewedProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  old.dispose();
  view.rerender(
    <RecentlyViewedProvider controller={next}>
      <Probe />
    </RecentlyViewedProvider>,
  );
  await act(async () => {
    await next.drain();
  });
  await act(async () => {
    loading.resolve(encodeRecentlyViewed({ enabled: true, entries: [{ ref, openedAt: instant }] }));
    await old.drain();
  });
  expect(observed.enabled).toBe(false);
  expect(observed.entries).toEqual([]);
});

test('unconfirmed privacy changes remain visibly unconfirmed through the hook', async () => {
  const controller = createRecentlyViewedController(
    {
      read: async () =>
        encodeRecentlyViewed({ enabled: true, entries: [{ ref, openedAt: instant }] }),
      write: async () => {
        throw new Error('unavailable');
      },
    },
    { now: () => instant },
  );
  render(
    <RecentlyViewedProvider controller={controller}>
      <Probe />
    </RecentlyViewedProvider>,
  );
  await waitFor(() => expect(observed.hydrated).toBe(true));
  await act(async () => {
    expect(await observed.setEnabled(false)).toBe(false);
  });
  expect(observed.enabled).toBe(true);
  expect(observed.error).toContain('could not be confirmed');
  expect(await observed.recordOpen({ ...ref, recipeId: '2' })).toBe(false);
});
