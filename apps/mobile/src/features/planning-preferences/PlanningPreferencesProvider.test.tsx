import { act, cleanup, render, waitFor } from '@testing-library/react-native';
import { PlanningPreferencesProvider, usePlanningPreferences } from './PlanningPreferencesProvider';
import {
  createPlanningPreferencesController,
  defaultPlanningPreferences,
  encodePlanningPreferences,
} from './planningPreferences';

let observed: ReturnType<typeof usePlanningPreferences>;
function Probe() {
  observed = usePlanningPreferences();
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

afterEach(cleanup);

test('isolated legacy leaves retain Monday/Dinner without claiming that a change was saved', async () => {
  render(<Probe />);
  expect(observed.preferences).toEqual(defaultPlanningPreferences);
  expect(observed.hydrated).toBe(true);
  expect(observed.saving).toBe(false);
  expect(await observed.setPreference('weekStart', 'sunday')).toBe(false);
});

test('the provider exposes unresolved hydration before the actual saved defaults arrive', async () => {
  const loading = deferred<string | null>();
  const controller = createPlanningPreferencesController({
    read: () => loading.promise,
    write: async () => {},
  });
  render(
    <PlanningPreferencesProvider controller={controller}>
      <Probe />
    </PlanningPreferencesProvider>,
  );
  expect(observed.hydrated).toBe(false);
  await act(async () => {
    loading.resolve(encodePlanningPreferences({ weekStart: 'sunday', defaultMealSlot: 'lunch' }));
    await controller.hydrate();
  });
  expect(observed.hydrated).toBe(true);
  expect(observed.preferences).toEqual({ weekStart: 'sunday', defaultMealSlot: 'lunch' });
});

test('remounting reuses the root-owned writer and does not dispose a pending save', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const store = {
    read: jest.fn(async () => null),
    write: jest.fn(async () => {
      entered.resolve();
      await release.promise;
    }),
  };
  const controller = createPlanningPreferencesController(store);
  const tree = () => (
    <PlanningPreferencesProvider controller={controller}>
      <Probe />
    </PlanningPreferencesProvider>
  );
  const first = render(tree());
  await waitFor(() => expect(observed.hydrated).toBe(true));
  let saving!: Promise<boolean>;
  await act(async () => {
    saving = observed.setPreference('weekStart', 'sunday');
    await entered.promise;
  });
  expect(observed.saving).toBe(true);
  first.unmount();
  render(tree());
  expect(observed.preferences.weekStart).toBe('monday');
  await act(async () => {
    release.resolve();
    expect(await saving).toBe(true);
  });
  expect(observed.preferences.weekStart).toBe('sunday');
  expect(observed.saving).toBe(false);
  expect(store.read).toHaveBeenCalledTimes(1);
});

test("switching controllers cannot expose a retired owner's late hydration", async () => {
  const oldRead = deferred<string | null>();
  const old = createPlanningPreferencesController({
    read: () => oldRead.promise,
    write: async () => {},
  });
  const next = createPlanningPreferencesController({
    read: async () => encodePlanningPreferences({ weekStart: 'monday', defaultMealSlot: 'lunch' }),
    write: async () => {},
  });
  const view = render(
    <PlanningPreferencesProvider controller={old}>
      <Probe />
    </PlanningPreferencesProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  old.dispose();
  view.rerender(
    <PlanningPreferencesProvider controller={next}>
      <Probe />
    </PlanningPreferencesProvider>,
  );
  await act(async () => {
    await next.hydrate();
  });
  expect(observed.preferences.defaultMealSlot).toBe('lunch');
  await act(async () => {
    oldRead.resolve(
      encodePlanningPreferences({ weekStart: 'sunday', defaultMealSlot: 'breakfast' }),
    );
    await old.drain();
  });
  expect(observed.preferences).toEqual({ weekStart: 'monday', defaultMealSlot: 'lunch' });
});

test('storage failure is visible through the hook and does not imply persisted defaults', async () => {
  const write = jest.fn(async () => {});
  const controller = createPlanningPreferencesController({
    read: async () => {
      throw new Error('unavailable');
    },
    write,
  });
  render(
    <PlanningPreferencesProvider controller={controller}>
      <Probe />
    </PlanningPreferencesProvider>,
  );
  await waitFor(() => expect(observed.hydrated).toBe(true));
  expect(observed.error).toContain('storage is unavailable');
  await act(async () => {
    expect(await observed.setPreference('weekStart', 'sunday')).toBe(false);
  });
  expect(write).not.toHaveBeenCalled();
});
