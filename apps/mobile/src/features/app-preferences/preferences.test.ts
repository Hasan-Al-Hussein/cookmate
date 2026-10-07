import {
  createAppPreferencesController,
  decodeAppPreferences,
  defaultAppPreferences,
  encodeAppPreferences,
  type AppPreferencesStore,
} from './preferences';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function memoryStore(initial: string | null = null) {
  let stored = initial;
  return {
    read: jest.fn(async () => stored),
    write: jest.fn(async (value: string) => {
      stored = value;
    }),
    stored: () => stored,
  };
}

const savedPreferences = { theme: 'dark', motion: 'reduced', locale: 'ar' } as const;

test('hydrates missing preferences without creating a record or touching domain storage', async () => {
  const store = memoryStore();
  const controller = createAppPreferencesController(store);
  expect(controller.getSnapshot().hydrated).toBe(false);
  await controller.hydrate();
  expect(controller.getSnapshot()).toEqual({
    hydrated: true,
    error: null,
    preferences: defaultAppPreferences,
  });
  expect(store.write).not.toHaveBeenCalled();
});

test('hydrates all saved controls together and performs one read for concurrent hydration', async () => {
  const store = memoryStore(encodeAppPreferences(savedPreferences));
  const controller = createAppPreferencesController(store);
  await Promise.all([controller.hydrate(), controller.hydrate()]);
  expect(controller.getSnapshot().preferences).toEqual(savedPreferences);
  expect(store.read).toHaveBeenCalledTimes(1);
  expect(store.write).not.toHaveBeenCalled();
});

test.each([
  ['malformed JSON', '{not-json'],
  ['oversized payload', ' '.repeat(2049)],
  ['missing control', JSON.stringify({ schemaVersion: 1, preferences: { theme: 'dark' } })],
  [
    'unknown preference',
    JSON.stringify({ schemaVersion: 1, preferences: { ...savedPreferences, futureOption: true } }),
  ],
  [
    'invalid value',
    JSON.stringify({ schemaVersion: 1, preferences: { ...savedPreferences, motion: 'forced' } }),
  ],
  ['invalid version type', JSON.stringify({ schemaVersion: '1', preferences: savedPreferences })],
  ['array payload', '[]'],
])('preserves %s and blocks replacement writes', async (_name, payload) => {
  const store = memoryStore(payload);
  const controller = createAppPreferencesController(store);
  await controller.hydrate();
  expect(controller.getSnapshot().hydrated).toBe(true);
  expect(controller.getSnapshot().error).toContain('kept unchanged');
  expect(await controller.setPreference('theme', 'light')).toBe(false);
  expect(store.stored()).toBe(payload);
  expect(store.write).not.toHaveBeenCalled();
});

test('an unsupported future schema stays intact even when it contains valid current fields', async () => {
  const payload = JSON.stringify({ schemaVersion: 2, preferences: savedPreferences, future: true });
  const store = memoryStore(payload);
  const controller = createAppPreferencesController(store);
  await controller.hydrate();
  expect(controller.getSnapshot().error).toContain('newer CookMate version');
  expect(await controller.setPreference('locale', 'en')).toBe(false);
  expect(store.stored()).toBe(payload);
  expect(store.write).not.toHaveBeenCalled();
});

test('storage read failure is not treated as a new installation or permission to overwrite', async () => {
  const store: AppPreferencesStore = {
    read: jest.fn(async () => {
      throw new Error('Private platform detail must not enter UI errors');
    }),
    write: jest.fn(),
  };
  const controller = createAppPreferencesController(store);
  expect(await controller.setPreference('theme', 'dark')).toBe(false);
  expect(controller.getSnapshot().hydrated).toBe(true);
  expect(controller.getSnapshot().error).toContain('storage is unavailable');
  expect(controller.getSnapshot().error).not.toContain('Private platform');
  expect(store.write).not.toHaveBeenCalled();
});

test('a save requested during hydration merges into the stored controls, not the defaults', async () => {
  const read = deferred<string | null>();
  const store: AppPreferencesStore = { read: () => read.promise, write: jest.fn(async () => {}) };
  const controller = createAppPreferencesController(store);
  const save = controller.setPreference('locale', 'en');
  read.resolve(encodeAppPreferences(savedPreferences));
  expect(await save).toBe(true);
  expect(controller.getSnapshot().preferences).toEqual({ ...savedPreferences, locale: 'en' });
  expect(store.write).toHaveBeenCalledWith(
    encodeAppPreferences({ ...savedPreferences, locale: 'en' }),
  );
});

test('concurrent changes are serialized without lost controls or optimistic success', async () => {
  const firstWrite = deferred<void>();
  const firstWriteStarted = deferred<void>();
  const writes: string[] = [];
  const store: AppPreferencesStore = {
    read: async () => null,
    async write(value) {
      writes.push(value);
      if (writes.length === 1) {
        firstWriteStarted.resolve();
        await firstWrite.promise;
      }
    },
  };
  const controller = createAppPreferencesController(store);
  await controller.hydrate();
  const saveTheme = controller.setPreference('theme', 'dark');
  const saveMotion = controller.setPreference('motion', 'reduced');
  await firstWriteStarted.promise;
  expect(writes).toHaveLength(1);
  expect(controller.getSnapshot().preferences).toEqual(defaultAppPreferences);
  firstWrite.resolve();
  expect(await saveTheme).toBe(true);
  expect(await saveMotion).toBe(true);
  expect(decodeAppPreferences(writes[1]!)).toEqual({
    ok: true,
    preferences: { theme: 'dark', motion: 'reduced', locale: 'system' },
  });
  expect(controller.getSnapshot().preferences).toEqual({
    theme: 'dark',
    motion: 'reduced',
    locale: 'system',
  });
});

test('a failed save preserves active values and does not contaminate the next queued change', async () => {
  const store = memoryStore();
  store.write.mockRejectedValueOnce(new Error('Storage full'));
  const controller = createAppPreferencesController(store);
  await controller.hydrate();
  const failed = controller.setPreference('theme', 'dark');
  const next = controller.setPreference('motion', 'reduced');
  expect(await failed).toBe(false);
  expect(await next).toBe(true);
  expect(controller.getSnapshot()).toEqual({
    hydrated: true,
    error: null,
    preferences: { theme: 'system', motion: 'reduced', locale: 'system' },
  });
  expect(await controller.setPreference('theme', 'dark')).toBe(true);
  expect(controller.getSnapshot().preferences.theme).toBe('dark');
});

test('failure stays visible while the previous stored value remains active', async () => {
  const store = memoryStore(encodeAppPreferences(savedPreferences));
  store.write.mockRejectedValueOnce(new Error('Denied'));
  const controller = createAppPreferencesController(store);
  await controller.hydrate();
  expect(await controller.setPreference('theme', 'light')).toBe(false);
  expect(controller.getSnapshot().error).toContain('previous setting is still active');
  expect(controller.getSnapshot().preferences).toEqual(savedPreferences);
  expect(store.stored()).toBe(encodeAppPreferences(savedPreferences));
});

test('no-op changes avoid writes and runtime-invalid values cannot be stored', async () => {
  const store = memoryStore();
  const controller = createAppPreferencesController(store);
  expect(await controller.setPreference('theme', 'system')).toBe(true);
  // JS callers and old app code cannot bypass the durable schema through a TypeScript cast.
  expect(await controller.setPreference('theme', 'invalid' as 'dark')).toBe(false);
  expect(store.write).not.toHaveBeenCalled();
});

test('unsubscribing removes updates without cancelling a genuine pending save', async () => {
  const store = memoryStore();
  const controller = createAppPreferencesController(store);
  await controller.hydrate();
  const listener = jest.fn();
  const unsubscribe = controller.subscribe(listener);
  await controller.setPreference('theme', 'dark');
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  await controller.setPreference('locale', 'ar');
  expect(listener).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().preferences.locale).toBe('ar');
});

test('a stalled read releases startup without permitting writes, then applies its genuine late result', async () => {
  jest.useFakeTimers();
  try {
    const read = deferred<string | null>();
    const store = { read: jest.fn(() => read.promise), write: jest.fn(async () => {}) };
    const controller = createAppPreferencesController(store);
    const hydration = controller.hydrate();
    await jest.advanceTimersByTimeAsync(4000);
    await hydration;
    expect(controller.getSnapshot().hydrated).toBe(true);
    expect(controller.getSnapshot().error).toContain('taking longer');
    expect(await controller.setPreference('theme', 'light')).toBe(false);
    expect(store.write).not.toHaveBeenCalled();
    read.resolve(encodeAppPreferences(savedPreferences));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().preferences).toEqual(savedPreferences);
    expect(controller.getSnapshot().error).toBeNull();
    expect(await controller.setPreference('theme', 'light')).toBe(true);
    expect(store.read).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().preferences.motion).toBe('reduced');
  } finally {
    jest.useRealTimers();
  }
});
