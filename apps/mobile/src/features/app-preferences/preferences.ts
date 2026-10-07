export interface AppPreferences {
  readonly theme: 'system' | 'light' | 'dark';
  readonly motion: 'system' | 'reduced';
  readonly locale: 'system' | 'en' | 'ar';
}

export const defaultAppPreferences: AppPreferences = Object.freeze({
  theme: 'system',
  motion: 'system',
  locale: 'system',
});

// UI preferences have a separate namespace; this never opens or migrates the cooking workspace.
export const appPreferencesKey = 'cookmate.presentation-preferences';
export const appPreferencesSchemaVersion = 1;
const maximumStoredLength = 2048;
const hydrationDeadlineMs = 4000;

export interface AppPreferencesStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface AppPreferencesSnapshot {
  readonly preferences: AppPreferences;
  readonly hydrated: boolean;
  readonly error: string | null;
}

export type SetAppPreference = <K extends keyof AppPreferences>(
  key: K,
  value: AppPreferences[K],
) => Promise<boolean>;

export interface AppPreferencesController {
  getSnapshot(): AppPreferencesSnapshot;
  subscribe(listener: () => void): () => void;
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
  setPreference: SetAppPreference;
  /** One saved record, guarded against display edits made after a sync review. */
  replacePreferences(
    preferences: AppPreferences,
    expected: AppPreferences,
    isCurrent?: () => boolean,
  ): Promise<boolean>;
}

type DecodeResult =
  | { ok: true; preferences: AppPreferences }
  | { ok: false; reason: 'unsupported-version' | 'invalid-record' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function validPreference(key: string, value: unknown): boolean {
  switch (key) {
    case 'theme':
      return value === 'system' || value === 'light' || value === 'dark';
    case 'motion':
      return value === 'system' || value === 'reduced';
    case 'locale':
      return value === 'system' || value === 'en' || value === 'ar';
    default:
      return false;
  }
}

export function decodeAppPreferences(value: string | null): DecodeResult {
  if (value === null) return { ok: true, preferences: defaultAppPreferences };
  if (value.length > maximumStoredLength) return { ok: false, reason: 'invalid-record' };
  let record: unknown;
  try {
    record = JSON.parse(value);
  } catch {
    return { ok: false, reason: 'invalid-record' };
  }
  if (!isRecord(record)) return { ok: false, reason: 'invalid-record' };
  if (
    typeof record.schemaVersion === 'number' &&
    Number.isInteger(record.schemaVersion) &&
    record.schemaVersion > appPreferencesSchemaVersion
  ) {
    return { ok: false, reason: 'unsupported-version' };
  }
  const preferences = record.preferences;
  if (
    record.schemaVersion !== appPreferencesSchemaVersion ||
    !hasOnlyKeys(record, ['schemaVersion', 'preferences']) ||
    !isRecord(preferences) ||
    !hasOnlyKeys(preferences, ['theme', 'motion', 'locale']) ||
    !validPreference('theme', preferences.theme) ||
    !validPreference('motion', preferences.motion) ||
    !validPreference('locale', preferences.locale)
  ) {
    return { ok: false, reason: 'invalid-record' };
  }
  return {
    ok: true,
    preferences: Object.freeze({
      theme: preferences.theme,
      motion: preferences.motion,
      locale: preferences.locale,
    }) as AppPreferences,
  };
}

export function encodeAppPreferences(preferences: AppPreferences): string {
  return JSON.stringify({ schemaVersion: appPreferencesSchemaVersion, preferences });
}

export function createAppPreferencesController(
  store: AppPreferencesStore,
): AppPreferencesController {
  let snapshot: AppPreferencesSnapshot = {
    preferences: defaultAppPreferences,
    hydrated: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  let hydration: Promise<void> | undefined;
  let writeQueue = Promise.resolve();
  let writable = false;

  function publish(next: AppPreferencesSnapshot) {
    snapshot = Object.freeze(next);
    listeners.forEach((listener) => listener());
  }

  async function readStoredPreferences() {
    try {
      const result = decodeAppPreferences(await store.read());
      writable = result.ok;
      publish({
        preferences: result.ok ? result.preferences : defaultAppPreferences,
        hydrated: true,
        error: result.ok
          ? null
          : result.reason === 'unsupported-version'
            ? 'These display settings were saved by a newer CookMate version. They have been kept unchanged. Update the app to edit them.'
            : 'Saved display settings could not be read safely. They have been kept unchanged; your cooking data has not been reset.',
      });
    } catch {
      writable = false;
      publish({
        ...snapshot,
        hydrated: true,
        error:
          'Display settings storage is unavailable. Restart CookMate after restoring storage access. Your saved settings have not been replaced.',
      });
    }
  }

  const hydrate = () =>
    (hydration ??= new Promise<void>((resolve) => {
      // Unavailable display storage must not prevent access to the cooking workspace.
      // Keep writes disabled until the original read succeeds; late results remain valid.
      const deadline = setTimeout(() => {
        publish({
          ...snapshot,
          hydrated: true,
          error:
            'Display settings are taking longer to load. CookMate is using system appearance while it waits. Your saved settings have not been replaced.',
        });
        resolve();
      }, hydrationDeadlineMs);
      void readStoredPreferences().finally(() => {
        clearTimeout(deadline);
        resolve();
      });
    }));

  const setPreference: SetAppPreference = (key, value) => {
    // Merge each request into the last *saved* state, even when the user changes several controls.
    const result = writeQueue.then(async () => {
      await hydrate();
      if (!writable) return false;
      if (!validPreference(key, value)) {
        publish({ ...snapshot, error: 'That display setting is not supported.' });
        return false;
      }
      if (snapshot.preferences[key] === value) {
        if (snapshot.error) publish({ ...snapshot, error: null });
        return true;
      }
      const preferences: AppPreferences = Object.freeze({ ...snapshot.preferences, [key]: value });
      try {
        await store.write(encodeAppPreferences(preferences));
      } catch {
        publish({
          ...snapshot,
          error:
            'Your display setting could not be saved. The previous setting is still active. Try again.',
        });
        return false;
      }
      publish({ preferences, hydrated: true, error: null });
      return true;
    });
    writeQueue = result.then(() => undefined);
    return result;
  };

  const replacePreferences = (
    preferences: AppPreferences,
    expected: AppPreferences,
    isCurrent = () => true,
  ) => {
    const requested = decodeAppPreferences(encodeAppPreferences(preferences));
    const before = decodeAppPreferences(encodeAppPreferences(expected));
    const result = writeQueue.then(async () => {
      await hydrate();
      if (!isCurrent() || !writable || !requested.ok || !before.ok) return false;
      const matches = (value: AppPreferences) =>
        (Object.keys(defaultAppPreferences) as (keyof AppPreferences)[]).every(
          (key) => snapshot.preferences[key] === value[key],
        );
      if (matches(requested.preferences)) return true;
      if (!matches(before.preferences)) return false;
      try {
        await store.write(encodeAppPreferences(requested.preferences));
      } catch {
        publish({
          ...snapshot,
          error:
            'Synced display settings could not be saved on this device. Your previous settings remain active.',
        });
        return false;
      }
      // Owner-specific storage and transition draining protect an already-started physical write.
      if (!isCurrent()) return false;
      publish({ preferences: requested.preferences, hydrated: true, error: null });
      return true;
    });
    writeQueue = result.then(() => undefined);
    return result;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hydrate,
    refresh() {
      const result = writeQueue.then(async () => {
        await hydrate();
        await readStoredPreferences();
      });
      writeQueue = result;
      return result;
    },
    setPreference,
    replacePreferences,
  };
}
