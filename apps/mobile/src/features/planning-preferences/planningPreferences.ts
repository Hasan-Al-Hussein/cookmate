import type { MealKey } from '@cookmate/contracts';

export interface PlanningPreferences {
  readonly weekStart: 'monday' | 'sunday';
  readonly defaultMealSlot: MealKey;
}

export const defaultPlanningPreferences: PlanningPreferences = Object.freeze({
  weekStart: 'monday',
  defaultMealSlot: 'dinner',
});

export const planningPreferencesSchemaVersion = 1;
// A valid record is less than 128 characters. Bound input before parsing arbitrary storage.
export const planningPreferencesMaximumLength = 512;

export interface PlanningPreferencesStore {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export interface PlanningPreferencesSnapshot {
  readonly preferences: PlanningPreferences;
  readonly hydrated: boolean;
  readonly saving: boolean;
  readonly error: string | null;
}

export type SetPlanningPreference = <K extends keyof PlanningPreferences>(
  key: K,
  value: PlanningPreferences[K],
) => Promise<boolean>;

export interface PlanningPreferencesController {
  getSnapshot(): PlanningPreferencesSnapshot;
  subscribe(listener: () => void): () => void;
  /** Concurrent calls share a read; a failed read can be retried without replacing its record. */
  hydrate(): Promise<void>;
  setPreference: SetPlanningPreference;
  /** After dispose, wait for started storage calls before removing this owner's keys. */
  drain(): Promise<void>;
  /** Retire immediately. An already-started physical write must still be drained. */
  dispose(): void;
}

type DecodeResult =
  | { readonly ok: true; readonly preferences: PlanningPreferences }
  | { readonly ok: false; readonly reason: 'unsupported-version' | 'invalid-record' };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function validPreference(key: string, value: unknown): boolean {
  return key === 'weekStart'
    ? value === 'monday' || value === 'sunday'
    : key === 'defaultMealSlot' &&
        (value === 'breakfast' || value === 'lunch' || value === 'dinner');
}

function copyPreferences(value: unknown): PlanningPreferences | null {
  if (
    !record(value) ||
    !exactKeys(value, ['weekStart', 'defaultMealSlot']) ||
    (value.weekStart !== 'monday' && value.weekStart !== 'sunday') ||
    (value.defaultMealSlot !== 'breakfast' &&
      value.defaultMealSlot !== 'lunch' &&
      value.defaultMealSlot !== 'dinner')
  )
    return null;
  return Object.freeze({ weekStart: value.weekStart, defaultMealSlot: value.defaultMealSlot });
}

export function decodePlanningPreferences(text: string | null): DecodeResult {
  if (text === null) return { ok: true, preferences: defaultPlanningPreferences };
  if (typeof text !== 'string' || text.length > planningPreferencesMaximumLength)
    return { ok: false, reason: 'invalid-record' };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-record' };
  }
  if (!record(value)) return { ok: false, reason: 'invalid-record' };
  if (
    typeof value.schemaVersion === 'number' &&
    Number.isSafeInteger(value.schemaVersion) &&
    value.schemaVersion > planningPreferencesSchemaVersion
  )
    return { ok: false, reason: 'unsupported-version' };
  const preferences = copyPreferences(value.preferences);
  return value.schemaVersion === planningPreferencesSchemaVersion &&
    exactKeys(value, ['schemaVersion', 'preferences']) &&
    preferences
    ? { ok: true, preferences }
    : { ok: false, reason: 'invalid-record' };
}

export function encodePlanningPreferences(preferences: PlanningPreferences): string {
  const copied = copyPreferences(preferences);
  if (!copied) throw new Error('Invalid planning preferences');
  return JSON.stringify({ schemaVersion: planningPreferencesSchemaVersion, preferences: copied });
}

/** One controller per stable owner-bound store. The composition owns retirement and draining. */
export function createPlanningPreferencesController(
  store: PlanningPreferencesStore,
): PlanningPreferencesController {
  const read = store.read.bind(store),
    write = store.write.bind(store);
  let snapshot: PlanningPreferencesSnapshot = Object.freeze({
    preferences: defaultPlanningPreferences,
    hydrated: false,
    saving: false,
    error: null,
  });
  const listeners = new Set<() => void>();
  let disposed = false;
  let writable = false;
  let hydrationComplete = false;
  let hydration: Promise<void> | null = null;
  let writeQueue = Promise.resolve();
  let pendingSaves = 0;

  function publish(next: PlanningPreferencesSnapshot) {
    if (disposed) return;
    snapshot = Object.freeze(next);
    listeners.forEach((listener) => listener());
  }

  function hydrate(): Promise<void> {
    if (disposed || hydrationComplete) return Promise.resolve();
    if (hydration) return hydration;
    hydration = Promise.resolve()
      .then(async () => {
        if (disposed) return;
        let text: string | null;
        try {
          text = await read();
        } catch {
          publish({
            ...snapshot,
            hydrated: true,
            error:
              'Planning settings storage is unavailable. Your saved settings have not been replaced. Try again.',
          });
          return;
        }
        if (disposed) return;
        const decoded = decodePlanningPreferences(text);
        hydrationComplete = true;
        writable = decoded.ok;
        publish({
          ...snapshot,
          preferences: decoded.ok ? decoded.preferences : snapshot.preferences,
          hydrated: true,
          error: decoded.ok
            ? null
            : decoded.reason === 'unsupported-version'
              ? 'These planning settings were saved by a newer CookMate version and have been kept unchanged. Update the app to edit them.'
              : 'Saved planning settings could not be read safely and have been kept unchanged. Your meals have not been changed.',
        });
      })
      .finally(() => {
        hydration = null;
      });
    return hydration;
  }

  const setPreference: SetPlanningPreference = (key, value) => {
    if (disposed) return Promise.resolve(false);
    if (!validPreference(key, value)) {
      publish({ ...snapshot, error: 'That planning setting is not supported.' });
      return Promise.resolve(false);
    }
    pendingSaves++;
    const result = writeQueue
      .then(async () => {
        await hydrate();
        if (disposed || !writable) return false;
        if (snapshot.preferences[key] === value) {
          if (snapshot.error) publish({ ...snapshot, error: null });
          return true;
        }
        const preferences = Object.freeze({ ...snapshot.preferences, [key]: value });
        try {
          await write(encodePlanningPreferences(preferences));
        } catch {
          // A rejected acknowledgement does not prove absence. Re-read before another save.
          writable = false;
          hydrationComplete = false;
          publish({
            ...snapshot,
            error:
              'The planning setting could not be confirmed. The last confirmed settings are still shown. Try again.',
          });
          return false;
        }
        if (disposed) return false;
        publish({ ...snapshot, preferences, error: null });
        return true;
      })
      .finally(() => {
        pendingSaves--;
        if (pendingSaves === 0) publish({ ...snapshot, saving: false });
      });
    // Register the queue before notifying subscribers, which may themselves request a save.
    writeQueue = result.then(() => undefined);
    if (!snapshot.saving) publish({ ...snapshot, saving: true });
    return result;
  };

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (!disposed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hydrate,
    setPreference,
    async drain() {
      let pending: Promise<void>;
      do {
        pending = writeQueue;
        await pending;
        await hydration;
      } while (pending !== writeQueue || hydration !== null);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  });
}
