import {
  createPlanningPreferencesController,
  decodePlanningPreferences,
  defaultPlanningPreferences,
  encodePlanningPreferences,
  planningPreferencesMaximumLength,
  type PlanningPreferences,
  type PlanningPreferencesStore,
} from './planningPreferences';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function memoryStore(initial: string | null = null) {
  let stored = initial;
  return {
    read: jest.fn(async () => stored),
    write: jest.fn(async (text: string) => {
      stored = text;
    }),
    stored: () => stored,
  };
}

const saved: PlanningPreferences = { weekStart: 'sunday', defaultMealSlot: 'breakfast' };

test('missing settings hydrate frozen Monday/Dinner defaults without creating a record', async () => {
  const store = memoryStore();
  const controller = createPlanningPreferencesController(store);
  expect(controller.getSnapshot().hydrated).toBe(false);
  await controller.hydrate();
  expect(controller.getSnapshot()).toEqual({
    preferences: defaultPlanningPreferences,
    hydrated: true,
    saving: false,
    error: null,
  });
  expect(Object.isFrozen(controller.getSnapshot())).toBe(true);
  expect(Object.isFrozen(controller.getSnapshot().preferences)).toBe(true);
  expect(store.write).not.toHaveBeenCalled();
});

test('encoding owns the exact record and decoding returns detached immutable settings', () => {
  const source = { ...saved };
  const text = encodePlanningPreferences(source);
  source.weekStart = 'monday';
  expect(decodePlanningPreferences(text)).toEqual({ ok: true, preferences: saved });
  const decoded = decodePlanningPreferences(text);
  expect(decoded.ok && Object.isFrozen(decoded.preferences)).toBe(true);
  expect(() => encodePlanningPreferences({ ...saved, weekStart: 'friday' as 'sunday' })).toThrow();
});

test.each([
  ['malformed JSON', '{'],
  ['oversized record', ' '.repeat(planningPreferencesMaximumLength + 1)],
  ['array record', '[]'],
  ['null record', 'null'],
  ['wrong version type', JSON.stringify({ schemaVersion: '1', preferences: saved })],
  ['missing field', JSON.stringify({ schemaVersion: 1, preferences: { weekStart: 'sunday' } })],
  ['unknown field', JSON.stringify({ schemaVersion: 1, preferences: { ...saved, theme: 'dark' } })],
  [
    'unknown envelope field',
    JSON.stringify({ schemaVersion: 1, preferences: saved, owner: 'other' }),
  ],
  [
    'invalid weekday',
    JSON.stringify({ schemaVersion: 1, preferences: { ...saved, weekStart: 0 } }),
  ],
  [
    'invalid meal',
    JSON.stringify({ schemaVersion: 1, preferences: { ...saved, defaultMealSlot: 'snack' } }),
  ],
])('preserves %s and forbids overwriting it with defaults', async (_label, raw) => {
  const store = memoryStore(raw);
  const controller = createPlanningPreferencesController(store);
  await controller.hydrate();
  expect(controller.getSnapshot().error).toContain('kept unchanged');
  expect(await controller.setPreference('weekStart', 'sunday')).toBe(false);
  expect(store.write).not.toHaveBeenCalled();
  expect(store.stored()).toBe(raw);
});

test('future settings remain intact and cannot be overwritten', async () => {
  const raw = JSON.stringify({ schemaVersion: 2, preferences: saved, future: true });
  const store = memoryStore(raw);
  const controller = createPlanningPreferencesController(store);
  await controller.hydrate();
  expect(controller.getSnapshot().error).toContain('newer CookMate version');
  expect(await controller.setPreference('defaultMealSlot', 'lunch')).toBe(false);
  expect(store.stored()).toBe(raw);
  expect(store.write).not.toHaveBeenCalled();
});

test('a save waits for one shared hydration and merges with the actual stored settings', async () => {
  const loading = deferred<string | null>();
  const store = {
    read: jest.fn(() => loading.promise),
    write: jest.fn(async (_text: string) => {}),
  };
  const controller = createPlanningPreferencesController(store);
  const first = controller.hydrate(),
    second = controller.hydrate();
  const saving = controller.setPreference('defaultMealSlot', 'lunch');
  await Promise.resolve();
  expect(store.read).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().hydrated).toBe(false);
  expect(controller.getSnapshot().saving).toBe(true);
  expect(store.write).not.toHaveBeenCalled();
  loading.resolve(encodePlanningPreferences(saved));
  await Promise.all([first, second]);
  expect(await saving).toBe(true);
  expect(controller.getSnapshot().preferences).toEqual({ ...saved, defaultMealSlot: 'lunch' });
  expect(controller.getSnapshot().saving).toBe(false);
});

test('failed hydration is safe and an explicit retry loads the retained record before writing', async () => {
  const store = memoryStore(encodePlanningPreferences(saved));
  store.read.mockRejectedValueOnce(new Error('secret platform path'));
  const controller = createPlanningPreferencesController(store);
  expect(await controller.setPreference('weekStart', 'monday')).toBe(false);
  expect(controller.getSnapshot().error).toContain('storage is unavailable');
  expect(controller.getSnapshot().error).not.toContain('secret');
  expect(store.write).not.toHaveBeenCalled();
  await controller.hydrate();
  expect(controller.getSnapshot().preferences).toEqual(saved);
  expect(controller.getSnapshot().error).toBeNull();
  expect(await controller.setPreference('weekStart', 'monday')).toBe(true);
  expect(decodePlanningPreferences(store.stored())).toEqual({
    ok: true,
    preferences: { ...saved, weekStart: 'monday' },
  });
});

test('concurrent changes serialize confirmed records and never publish an optimistic value', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const store = memoryStore();
  const write = store.write;
  write.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  const controller = createPlanningPreferencesController(store);
  await controller.hydrate();
  const first = controller.setPreference('weekStart', 'sunday');
  const second = controller.setPreference('defaultMealSlot', 'lunch');
  await entered.promise;
  expect(write).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().preferences).toEqual(defaultPlanningPreferences);
  expect(controller.getSnapshot().saving).toBe(true);
  release.resolve();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(decodePlanningPreferences(write.mock.calls[1]![0])).toEqual({
    ok: true,
    preferences: { weekStart: 'sunday', defaultMealSlot: 'lunch' },
  });
  expect(controller.getSnapshot().saving).toBe(false);
});

test('a failed write keeps confirmed presentation and a deliberate retry succeeds', async () => {
  const store = memoryStore(encodePlanningPreferences(saved));
  store.write.mockRejectedValueOnce(new Error('secret disk detail'));
  const controller = createPlanningPreferencesController(store);
  await controller.hydrate();
  expect(await controller.setPreference('defaultMealSlot', 'lunch')).toBe(false);
  expect(controller.getSnapshot().preferences).toEqual(saved);
  expect(controller.getSnapshot().error).toContain('could not be confirmed');
  expect(controller.getSnapshot().error).not.toContain('secret');
  expect(controller.getSnapshot().saving).toBe(false);
  expect(await controller.setPreference('defaultMealSlot', 'lunch')).toBe(true);
  expect(controller.getSnapshot().preferences).toEqual({ ...saved, defaultMealSlot: 'lunch' });
  expect(store.read).toHaveBeenCalledTimes(2);
});

test('lost write acknowledgement is reread before another setting, preserving the committed field', async () => {
  let stored: string | null = null;
  let calls = 0;
  const controller = createPlanningPreferencesController({
    read: async () => stored,
    async write(text) {
      stored = text;
      if (++calls === 1) throw new Error('lost acknowledgement');
    },
  });
  expect(await controller.setPreference('weekStart', 'sunday')).toBe(false);
  expect(controller.getSnapshot().preferences).toEqual(defaultPlanningPreferences);
  expect(await controller.setPreference('defaultMealSlot', 'breakfast')).toBe(true);
  expect(decodePlanningPreferences(stored)).toEqual({ ok: true, preferences: saved });
});

test('an unconfirmed write followed by unreadable storage cannot silently overwrite the record', async () => {
  const store = memoryStore();
  store.write.mockRejectedValueOnce(new Error('unknown result'));
  const controller = createPlanningPreferencesController(store);
  expect(await controller.setPreference('weekStart', 'sunday')).toBe(false);
  store.read.mockRejectedValueOnce(new Error('unavailable'));
  expect(await controller.setPreference('defaultMealSlot', 'lunch')).toBe(false);
  expect(store.write).toHaveBeenCalledTimes(1);
});

test('no-op settings avoid writes and unsupported runtime input never reaches storage', async () => {
  const store = memoryStore();
  const controller = createPlanningPreferencesController(store);
  expect(await controller.setPreference('weekStart', 'monday')).toBe(true);
  expect(await controller.setPreference('weekStart', 'friday' as 'monday')).toBe(false);
  expect(await controller.setPreference('unknown' as 'weekStart', 'sunday')).toBe(false);
  expect(store.write).not.toHaveBeenCalled();
});

test('retirement before queued work starts prevents any storage access', async () => {
  const store = memoryStore();
  const controller = createPlanningPreferencesController(store);
  const saving = controller.setPreference('weekStart', 'sunday');
  controller.dispose();
  expect(await saving).toBe(false);
  await controller.hydrate();
  await controller.drain();
  expect(store.read).not.toHaveBeenCalled();
  expect(store.write).not.toHaveBeenCalled();
});

test('retirement suppresses late hydration and drain waits for the started read', async () => {
  const loading = deferred<string | null>(),
    entered = deferred<void>();
  const store: PlanningPreferencesStore = {
    read: () => {
      entered.resolve();
      return loading.promise;
    },
    write: jest.fn(async () => {}),
  };
  const controller = createPlanningPreferencesController(store);
  const listener = jest.fn();
  controller.subscribe(listener);
  const initial = controller.getSnapshot();
  const hydration = controller.hydrate();
  await entered.promise;
  controller.dispose();
  let drained = false;
  const draining = controller.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  loading.resolve(encodePlanningPreferences(saved));
  await Promise.all([hydration, draining]);
  expect(controller.getSnapshot()).toBe(initial);
  expect(listener).not.toHaveBeenCalled();
  expect(await controller.setPreference('weekStart', 'sunday')).toBe(false);
  expect(store.write).not.toHaveBeenCalled();
});

test('retirement drains the started physical write but skips queued saves and late publication', async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const store = memoryStore();
  store.write.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
  });
  const controller = createPlanningPreferencesController(store);
  await controller.hydrate();
  const first = controller.setPreference('weekStart', 'sunday');
  const second = controller.setPreference('defaultMealSlot', 'breakfast');
  await entered.promise;
  const retiredSnapshot = controller.getSnapshot();
  const listener = jest.fn();
  controller.subscribe(listener);
  controller.dispose();
  let drained = false;
  const draining = controller.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release.resolve();
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  await draining;
  expect(store.write).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toBe(retiredSnapshot);
  expect(listener).not.toHaveBeenCalled();
});

test('a subscriber requesting another save stays behind the already registered writer', async () => {
  const store = memoryStore();
  const controller = createPlanningPreferencesController(store);
  await controller.hydrate();
  let second: Promise<boolean> | undefined;
  let requested = false;
  const unsubscribe = controller.subscribe(() => {
    if (!requested && controller.getSnapshot().saving) {
      requested = true;
      second = controller.setPreference('defaultMealSlot', 'breakfast');
    }
  });
  expect(await controller.setPreference('weekStart', 'sunday')).toBe(true);
  expect(await second).toBe(true);
  unsubscribe();
  expect(decodePlanningPreferences(store.stored())).toEqual({ ok: true, preferences: saved });
});
